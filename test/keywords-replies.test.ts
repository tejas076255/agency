// Keyword rank tracker + AI review reply drafts: pure logic, storage, tenant isolation, routes.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { normalizeKeyword, rankPeriodEnd, weeklyRankings } from '../src/google/gsc';
import { GoogleApiError, retryConfig } from '../src/google/http';
import { saveConnection, SCOPE } from '../src/google/tokens';
import { keywordOverview, summarizeKeyword, syncKeywordRankings } from '../src/jobs/keywords';
import { draftReviewReply, fallbackReplyDraft, parseReplyDraft } from '../src/lib/ai';
import { addDays } from '../src/lib/dates';
import { createSession } from '../src/lib/session';
import { createTestEnv } from './helpers';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ------------------------------------ pure logic ------------------------------------

describe('weekly rankings', () => {
  it('anchors windows to Saturday, at least 3 days back (IST)', () => {
    // Monday 23 Nov 2026 06:00 IST -> latest allowed day Fri 20 Nov -> Saturday 14 Nov.
    expect(rankPeriodEnd(Date.parse('2026-11-23T00:30:00Z'))).toBe('2026-11-14');
    // Tuesday 24 Nov -> Saturday 21 Nov is exactly 3 days back.
    expect(rankPeriodEnd(Date.parse('2026-11-24T00:30:00Z'))).toBe('2026-11-21');
    // Any day of one week gives the same window (no extra mid-week points).
    expect(rankPeriodEnd(Date.parse('2026-11-26T12:00:00Z'))).toBe('2026-11-21');
  });

  it('impression-weights positions per 7-day window, null without impressions', () => {
    const end = '2026-11-21';
    const weeks = weeklyRankings(
      [
        { date: end, clicks: 2, impressions: 30, position: 4 },
        { date: addDays(end, -1), clicks: 1, impressions: 10, position: 8 },
        { date: addDays(end, -14), clicks: 0, impressions: 5, position: 20 },
      ],
      end,
      3,
    );
    expect(weeks.map((w) => w.periodEnd)).toEqual(['2026-11-07', '2026-11-14', '2026-11-21']);
    expect(weeks[2]).toEqual({ periodEnd: end, position: 5, clicks: 3, impressions: 40 });
    expect(weeks[1]!.position).toBeNull();
    expect(weeks[0]!.position).toBe(20);
  });

  it('normalizes keywords', () => {
    expect(normalizeKeyword('  SEO   Agency Pune ')).toBe('seo agency pune');
  });

  it('summarizes movement: positive = moved up', () => {
    const r = summarizeKeyword([
      { periodEnd: '2026-11-21', position: 6, clicks: 4, impressions: 90, topPage: '/a' },
      { periodEnd: '2026-11-07', position: 15, clicks: 0, impressions: 40, topPage: null },
      { periodEnd: '2026-11-14', position: 9.5, clicks: 1, impressions: 60, topPage: null },
    ]);
    expect(r.latest?.position).toBe(6);
    expect(r.change).toBe(3.5);
    expect(r.changeAll).toBe(9);
    expect(r.best).toBe(6);
    expect(r.history.map((h) => h.periodEnd)).toEqual(['2026-11-07', '2026-11-14', '2026-11-21']);
  });
});

describe('review reply validation', () => {
  it('accepts a normal reply and rejects placeholders, promises and compensation', () => {
    expect(parseReplyDraft('{"reply":"Thank you Ravi, glad you liked the service!"}')).toEqual({
      ok: true,
      reply: 'Thank you Ravi, glad you liked the service!',
    });
    expect(parseReplyDraft({ reply: 'Thanks [Name], see you soon at our clinic.' }).ok).toBe(false);
    expect(parseReplyDraft({ reply: 'We guarantee this will never happen again.' }).ok).toBe(false);
    expect(parseReplyDraft({ reply: 'Sorry! We will give you a full refund next time.' }).ok).toBe(
      false,
    );
    expect(parseReplyDraft('not json').ok).toBe(false);
  });

  it('fallback template follows rating and language', () => {
    const base = { businessName: 'Upmark', reviewerName: 'Ravi Kumar', comment: null };
    const en = fallbackReplyDraft({ ...base, starRating: 5, tone: 'friendly', language: 'en' });
    expect(en).toMatch(/^Hi Ravi, thank you for the kind words/);
    const hi = fallbackReplyDraft({
      ...base,
      starRating: 1,
      tone: 'friendly',
      language: 'hinglish',
    });
    expect(hi).toMatch(/Ravi ji/);
    expect(hi).toMatch(/directly contact/);
    expect(parseReplyDraft({ reply: en }).ok).toBe(true);
  });

  it('retries once with the error, then falls back to the template', async () => {
    const outputs = [
      { reply: 'Dear [Name], thanks a lot for visiting us today.' },
      { reply: 'Thanks Ravi, we are happy you enjoyed your visit!' },
    ];
    const calls: unknown[] = [];
    const ok = await draftReviewReply(
      {
        AI: {
          run: async (_m: string, input: unknown) => (
            calls.push(input),
            { response: outputs.shift() }
          ),
        } as unknown as Ai,
        AI_MODEL: 'm',
        AI_GATEWAY_ID: '',
      },
      {
        businessName: 'Upmark',
        reviewerName: 'Ravi',
        starRating: 5,
        comment: 'Great work',
        tone: 'friendly',
        language: 'en',
      },
    );
    expect(ok).toMatchObject({
      source: 'ai',
      reply: 'Thanks Ravi, we are happy you enjoyed your visit!',
    });
    expect(JSON.stringify(calls[1])).toMatch(/placeholders/);

    const down = await draftReviewReply(
      {
        AI: {
          run: async () => {
            throw new Error('model down');
          },
        } as unknown as Ai,
        AI_MODEL: 'm',
        AI_GATEWAY_ID: '',
      },
      {
        businessName: 'Upmark',
        reviewerName: null,
        starRating: 2,
        comment: 'Slow',
        tone: 'professional',
        language: 'en',
      },
    );
    expect(down.source).toBe('fallback');
    expect(down.reply).toMatch(/contact us directly/);
  });
});

// --------------------------------- storage and routes ---------------------------------

let env: Env;
let dispose: () => Promise<void>;
const auth: Record<string, { cookie: string; csrf: string }> = {};

beforeAll(async () => {
  retryConfig.baseDelayMs = 1;
  const t = await createTestEnv();
  env = t.env;
  dispose = t.dispose;
  const run = (sql: string) => env.DB.prepare(sql).run();
  await run(
    `INSERT INTO agencies (id,name,brand_color,plan,created_at) VALUES ('A','A','#000000','free',0),('B','B','#000000','free',0)`,
  );
  await run(`INSERT INTO users (id,agency_id,email,name,role,google_sub,created_at) VALUES
    ('ownerA','A','a@x.com','Owner A','owner','sa',0),
    ('ownerB','B','b@x.com','Owner B','owner','sb',0)`);
  await run(`INSERT INTO clients (id,agency_id,name,website_url,contact_email,status,auto_send_report,gsc_site_url,created_at,updated_at) VALUES
    ('cA','A','Client A','https://a.com','c@a.com','active',0,'sc-domain:a.com',0,0),
    ('cB','B','Client B','https://b.com','c@b.com','active',0,NULL,0,0)`);
  await run(`INSERT INTO reviews (id,agency_id,client_id,google_review_name,reviewer_name,star_rating,comment,review_created_at,synced_at) VALUES
    ('rA','A','cA','accounts/1/locations/1/reviews/a','Ravi',5,'Great service',0,0),
    ('rB','B','cB','accounts/2/locations/2/reviews/b','Sita',1,'Bad',0,0)`);
  await run(`INSERT INTO health_checks (id,agency_id,client_id,run_at,gsc_json,status) VALUES
    ('hA','A','cA',1,'${JSON.stringify({
      topQueries: [{ query: 'Seo Pune', clicks: 5, impressions: 100, ctr: 5, position: 4.2 }],
      quickWins: [{ query: 'seo agency pune', impressions: 300, clicks: 1, position: 11.4 }],
    })}','ok')`);
  await saveConnection(env, {
    agencyId: 'A',
    clientId: 'cA',
    purpose: 'client_data',
    googleEmail: 'a@gmail.com',
    scopes: `openid ${SCOPE.gsc}`,
    refreshToken: 'refresh-a',
    userId: 'ownerA',
  });
  for (const u of ['ownerA', 'ownerB']) {
    const s = await createSession(env.KV, u);
    auth[u] = { cookie: `sid=${s.id}`, csrf: s.data.csrfToken };
  }
}, 60_000);

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await dispose?.();
});

const req = (user: string, path: string, method = 'GET', body?: unknown) =>
  app.request(
    `http://localhost${path}`,
    {
      method,
      headers: {
        cookie: auth[user]!.cookie,
        'x-csrf-token': auth[user]!.csrf,
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        'cf-connecting-ip': `ip-${user}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );

/** Fake Google: token refresh + Search Console daily rows for any keyword. */
function stubGoogle(gscBodies: string[] = []) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token'))
      return json({ access_token: 'at', expires_in: 3600 });
    if (url.includes('/searchAnalytics/query')) {
      const body = String(init?.body ?? '');
      gscBodies.push(body);
      const q = JSON.parse(body) as { dimensions: string[]; endDate: string };
      if (q.dimensions[0] === 'page') return json({ rows: [{ keys: ['https://a.com/seo'] }] });
      return json({
        rows: [{ keys: [q.endDate], clicks: 3, impressions: 50, ctr: 0.06, position: 7.2 }],
      });
    }
    return json({}, 404);
  });
}

describe('keyword routes', () => {
  it('adds keywords, loads history immediately and suggests untracked queries', async () => {
    const bodies: string[] = [];
    stubGoogle(bodies);
    const res = await req('ownerA', '/api/clients/cA/keywords', 'POST', {
      keywords: ['  SEO Pune ', 'seo pune', 'web design pune'],
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ added: 2, checked: 2, warning: null });
    // The keyword filter is sent to Search Console exactly (lowercase).
    expect(bodies.some((b) => b.includes('"expression":"seo pune"'))).toBe(true);

    const data = (await (await req('ownerA', '/api/clients/cA/keywords')).json()) as {
      keywords: {
        keyword: string;
        history: unknown[];
        latest: { position: number; topPage: string };
      }[];
      suggestions: { keyword: string }[];
      limit: number;
      notReady: string | null;
    };
    expect(data.notReady).toBeNull();
    expect(data.limit).toBe(10);
    expect(data.keywords.map((k) => k.keyword)).toEqual(['seo pune', 'web design pune']);
    expect(data.keywords[0]!.history).toHaveLength(13);
    expect(data.keywords[0]!.latest).toMatchObject({ position: 7.2, topPage: 'https://a.com/seo' });
    expect(data.suggestions.map((s) => s.keyword)).toEqual(['seo agency pune']);
  });

  it('re-checking upserts the same weeks (no duplicate rows)', async () => {
    stubGoogle();
    expect((await req('ownerA', '/api/clients/cA/keywords/check', 'POST', {})).status).toBe(200);
    const n = await env.DB.prepare(`SELECT count(*) AS n FROM keyword_rankings`).first<{
      n: number;
    }>();
    expect(n?.n).toBe(26);
  });

  it('enforces the per-client plan limit', async () => {
    stubGoogle();
    const many = Array.from({ length: 9 }, (_, i) => `keyword number ${i}`);
    const res = await req('ownerA', '/api/clients/cA/keywords', 'POST', { keywords: many });
    expect(res.status).toBe(402);
  });

  it('agency B cannot read, add, check or delete agency A keywords or draft its replies', async () => {
    const kw = await env.DB.prepare(`SELECT id FROM tracked_keywords LIMIT 1`).first<{
      id: string;
    }>();
    expect((await req('ownerB', '/api/clients/cA/keywords')).status).toBe(404);
    expect(
      (await req('ownerB', '/api/clients/cA/keywords', 'POST', { keywords: ['x y'] })).status,
    ).toBe(404);
    expect((await req('ownerB', '/api/clients/cA/keywords/check', 'POST', {})).status).toBe(404);
    expect((await req('ownerB', `/api/clients/cA/keywords/${kw!.id}`, 'DELETE')).status).toBe(404);
    // Own client, other agency's keyword id: nothing is deleted.
    await req('ownerB', `/api/clients/cB/keywords/${kw!.id}`, 'DELETE');
    const still = await env.DB.prepare(`SELECT count(*) AS n FROM tracked_keywords WHERE id=?`)
      .bind(kw!.id)
      .first<{ n: number }>();
    expect(still?.n).toBe(1);
    expect((await req('ownerB', '/api/clients/cA/reviews/rA/draft-reply', 'POST', {})).status).toBe(
      404,
    );
    expect((await req('ownerA', '/api/clients/cA/reviews/rB/draft-reply', 'POST', {})).status).toBe(
      404,
    );
  });

  it('a client without Search Console can track keywords but is told what is missing', async () => {
    const res = await req('ownerB', '/api/clients/cB/keywords', 'POST', {
      keywords: ['seo delhi'],
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { warning: string }).warning).toMatch(/Search Console site/);
  });

  it('a 401 from Search Console aborts the sync so the token can be refreshed', async () => {
    vi.stubGlobal('fetch', async () =>
      json({ error: { code: 401, status: 'UNAUTHENTICATED' } }, 401),
    );
    await expect(
      syncKeywordRankings(env, 'A', 'cA', 'sc-domain:a.com', 'stale-token'),
    ).rejects.toBeInstanceOf(GoogleApiError);
  });

  it('keywordOverview only returns the agency own keywords', async () => {
    const client = await env.DB.prepare(`SELECT * FROM clients WHERE id='cA'`).first();
    expect(client).toBeTruthy();
    const b = await keywordOverview(env, 'B', {
      id: 'cA',
      gscSiteUrl: 'sc-domain:a.com',
    } as Parameters<typeof keywordOverview>[2]);
    expect(b.keywords).toHaveLength(0);
  });
});

describe('draft-reply route', () => {
  it('returns an editable draft and does not post or store anything', async () => {
    const posted: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      posted.push(String(input));
      return json({});
    });
    env.AI = {
      run: async () => ({
        response: { reply: 'Thank you Ravi, we are glad you loved our service!' },
      }),
    } as unknown as Ai;
    const res = await req('ownerA', '/api/clients/cA/reviews/rA/draft-reply', 'POST', {
      language: 'en',
      tone: 'friendly',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reply: 'Thank you Ravi, we are glad you loved our service!',
      source: 'ai',
    });
    expect(posted).toHaveLength(0);
    const row = await env.DB.prepare(`SELECT reply_comment FROM reviews WHERE id='rA'`).first<{
      reply_comment: string | null;
    }>();
    expect(row?.reply_comment).toBeNull();
  });

  it('rejects an unknown language', async () => {
    const res = await req('ownerA', '/api/clients/cA/reviews/rA/draft-reply', 'POST', {
      language: 'fr',
    });
    expect(res.status).toBe(400);
  });
});
