// AI features: anomaly rules, audit checks, URL safety, ad limits, AI fallbacks, auto-reply,
// alerts storage, tenant isolation and the daily AI quota.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import type { Ga4Summary } from '../src/google/ga4';
import type { GscSummary } from '../src/google/gsc';
import { retryConfig } from '../src/google/http';
import { saveConnection } from '../src/google/tokens';
import { detectAnomalies, runAlerts, type AnomalyInput } from '../src/jobs/alerts';
import { autoReplyReviews } from '../src/jobs/integrations';
import {
  auditScore,
  enforceAdLimits,
  explainAnomalies,
  ruleBasedIssues,
  writeAuditReport,
  type SiteChecks,
} from '../src/lib/ai-tools';
import { createSession } from '../src/lib/session';
import { analyzeHtml, normalizeProspectUrl, runSiteChecks } from '../src/lib/site-audit';
import { createTestEnv } from './helpers';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const aiReturning = (...outputs: unknown[]) =>
  ({
    run: async () => ({ response: outputs.length > 1 ? outputs.shift() : outputs[0] }),
  }) as unknown as Ai;
const aiDown = { run: async () => Promise.reject(new Error('down')) } as unknown as Ai;

// ------------------------------------ pure rules ------------------------------------

const gsc = (cur: number, prev: number, pct: number | null) =>
  ({
    totals: {
      current: { clicks: cur, impressions: 1000, ctr: 0, position: 10 },
      previous: { clicks: prev, impressions: 1000, ctr: 0, position: 10 },
    },
    clicksChangePct: pct,
    impressionsChangePct: 0,
    droppingPages: [],
  }) as unknown as GscSummary;

const base: AnomalyInput = {
  gsc: null,
  ga4: null,
  psi: null,
  score: 70,
  prevScore: 72,
  prevMobileSpeed: null,
  keywords: [],
  negativeReviews: 0,
  ads: null,
};

describe('detectAnomalies', () => {
  it('flags a big clicks drop but ignores tiny sites and small dips', () => {
    expect(detectAnomalies({ ...base, gsc: gsc(40, 100, -60) })[0]).toMatchObject({
      kind: 'clicks_drop',
      severity: 'high',
    });
    expect(detectAnomalies({ ...base, gsc: gsc(5, 10, -50) })).toHaveLength(0); // < 20 clicks before
    expect(detectAnomalies({ ...base, gsc: gsc(80, 100, -20) })).toHaveLength(0);
  });

  it('flags score drops, keyword drops off page 1, negative reviews and lost leads', () => {
    const ga4 = {
      totals: {
        current: { sessions: 100, keyEvents: 2 },
        previous: { sessions: 110, keyEvents: 10 },
      },
      sessionsChangePct: -9,
      keyEventsChangePct: -80,
      topChannels: [],
    } as unknown as Ga4Summary;
    const kinds = detectAnomalies({
      ...base,
      ga4,
      score: 55,
      prevScore: 70,
      keywords: [
        { keyword: 'seo pune', previous: 8, position: 14 },
        { keyword: 'stable', previous: 5, position: 6 },
        { keyword: 'deep', previous: 40, position: 60 },
      ],
      negativeReviews: 3,
    });
    const byKind = Object.fromEntries(kinds.map((k) => [k.kind, k]));
    expect(Object.keys(byKind).sort()).toEqual([
      'conversions_drop',
      'keyword_drop',
      'negative_reviews',
      'score_drop',
    ]);
    expect(byKind.keyword_drop!.title).toMatch(/"seo pune" 8 → 14/);
    expect(byKind.keyword_drop!.severity).toBe('high');
    expect(byKind.negative_reviews!.severity).toBe('high');
  });
});

const checks = (over: Partial<SiteChecks> = {}): SiteChecks => ({
  url: 'https://shop.in/',
  finalUrl: 'https://shop.in/',
  fetchError: null,
  https: true,
  statusCode: 200,
  responseMs: 300,
  htmlKb: 40,
  title: 'Best Shoes in Pune | Shop',
  metaDescription: 'Buy shoes in Pune with free delivery across the city. Visit our store today.',
  h1: ['Shoes in Pune'],
  canonical: null,
  viewport: true,
  lang: 'en',
  openGraph: true,
  schemaTypes: ['LocalBusiness'],
  images: 4,
  imagesMissingAlt: 0,
  wordCount: 800,
  internalLinks: 20,
  robotsTxt: true,
  sitemap: true,
  mobileScore: 90,
  desktopScore: 95,
  mobileLcpMs: 1500,
  cwvPassed: true,
  speedFixes: [],
  ...over,
});

describe('prospect audit rules', () => {
  it('a healthy site scores high; problems become prioritised issues', () => {
    expect(auditScore(checks())).toBe(100);
    const bad = checks({
      https: false,
      mobileScore: 30,
      title: null,
      sitemap: false,
      imagesMissingAlt: 3,
    });
    const issues = ruleBasedIssues(bad);
    expect(issues[0]!.severity).toBe('high');
    expect(issues.map((i) => i.title)).toEqual(
      expect.arrayContaining([
        'Site is not on HTTPS',
        'Missing page title',
        'No sitemap.xml found',
      ]),
    );
    expect(auditScore(bad)).toBeLessThan(60);
    expect(auditScore(checks({ fetchError: 'down' }))).toBe(0);
  });

  it('parses on-page facts from HTML', () => {
    const html = `<html lang="hi"><head><title> Dental &amp; Care </title>
      <meta name="description" content="Best dentist">
      <meta name="viewport" content="width=device-width">
      <script type="application/ld+json">{"@type":"Dentist"}</script></head>
      <body><h1>Smile <b>bright</b></h1><h1>Two</h1><img src="a.png"><img src="b.png" alt="Clinic">
      <a href="/about">About</a><a href="https://other.com">x</a> word word word</body></html>`;
    const r = analyzeHtml(html, new URL('https://clinic.in/'));
    expect(r).toMatchObject({
      title: 'Dental & Care',
      metaDescription: 'Best dentist',
      viewport: true,
      lang: 'hi',
      schemaTypes: ['Dentist'],
      images: 2,
      imagesMissingAlt: 1,
      internalLinks: 1,
    });
    expect(r.h1).toEqual(['Smile bright', 'Two']);
  });

  it('only allows public website domains', () => {
    expect(normalizeProspectUrl('shop.in').toString()).toBe('https://shop.in/');
    for (const bad of [
      'http://localhost:8787',
      'http://127.0.0.1',
      'http://10.0.0.5/admin',
      'http://[::1]/',
      'https://shop.in:8080',
      'http://user:pw@shop.in',
      'ftp://shop.in',
      'http://metadata.internal',
    ]) {
      expect(() => normalizeProspectUrl(bad), bad).toThrow();
    }
  });

  it('re-checks every redirect hop (a redirect to an internal IP is blocked)', async () => {
    const fake = (async (input: RequestInfo | URL) => {
      if (String(input).startsWith('https://evil.in'))
        return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } });
      throw new Error('must not be fetched');
    }) as typeof fetch;
    const r = await runSiteChecks('evil.in', undefined, fake);
    expect(r.fetchError).toMatch(/public website domain/);
  });

  it('falls back to a rule-based write-up when the AI is down', async () => {
    const r = await writeAuditReport(
      { AI: aiDown, AI_MODEL: 'm', AI_GATEWAY_ID: '' },
      checks({ https: false }),
      { agencyName: 'Upmark', businessName: 'Shop', language: 'en' },
    );
    expect(r.source).toBe('fallback');
    expect(r.report.issues[0]!.title).toBe('Site is not on HTTPS');
    expect(r.report.pitch).toMatch(/Upmark/);
  });
});

describe('ad copy and explanations', () => {
  it('drops headlines/descriptions over Google limits and duplicates', () => {
    const r = enforceAdLimits({
      headlines: [
        'Dentist in Pune',
        'dentist in pune',
        'This headline is far too long for Google Ads',
      ],
      descriptions: ['Short description that fits well.', 'x'.repeat(91)],
      negative_keywords: [],
      tips: [],
    });
    expect(r.headlines).toEqual(['dentist in pune']);
    expect(r.descriptions).toHaveLength(1);
  });

  it('uses AI explanations when valid, rule-based text otherwise', async () => {
    const anomalies = [
      { kind: 'clicks_drop', severity: 'high' as const, title: 'Clicks fell 60%', details: {} },
      { kind: 'speed_drop', severity: 'medium' as const, title: 'Speed fell', details: {} },
    ];
    const ok = await explainAnomalies(
      {
        AI: aiReturning({
          explanations: [
            { kind: 'clicks_drop', text: 'Likely a ranking loss on the services page.' },
          ],
        }),
        AI_MODEL: 'm',
        AI_GATEWAY_ID: '',
      },
      anomalies,
      {},
    );
    expect(ok.get('clicks_drop')).toEqual({
      text: 'Likely a ranking loss on the services page.',
      source: 'ai',
    });
    expect(ok.get('speed_drop')?.source).toBe('fallback');
    const down = await explainAnomalies(
      { AI: aiDown, AI_MODEL: 'm', AI_GATEWAY_ID: '' },
      anomalies,
      {},
    );
    expect(down.get('clicks_drop')?.text).toMatch(/Search Console/);
  });
});

// --------------------------------- storage and routes ---------------------------------

let env: Env;
let dispose: () => Promise<void>;
const auth: Record<string, { cookie: string; csrf: string }> = {};
const DAY = 86_400_000;

beforeAll(async () => {
  retryConfig.baseDelayMs = 1;
  const t = await createTestEnv();
  env = t.env;
  dispose = t.dispose;
  const run = (sql: string) => env.DB.prepare(sql).run();
  await run(
    `INSERT INTO agencies (id,name,brand_color,plan,created_at) VALUES ('A','Agency A','#000000','pro',0),('B','Agency B','#000000','free',0)`,
  );
  await run(`INSERT INTO users (id,agency_id,email,name,role,google_sub,created_at) VALUES
    ('ownerA','A','a@x.com','Owner A','owner','sa',0),
    ('memberA','A','m@x.com','Member A','member','sm',0),
    ('ownerB','B','b@x.com','Owner B','owner','sb',0)`);
  await run(`INSERT INTO clients (id,agency_id,name,website_url,contact_email,status,auto_send_report,gbp_account_name,gbp_location_name,assigned_user_id,created_at,updated_at) VALUES
    ('cA','A','Client A','https://a.com','c@a.com','active',0,'accounts/1','locations/11','memberA',0,0),
    ('cA2','A','Client A2','https://a2.com','c@a2.com','active',0,NULL,NULL,NULL,0,0),
    ('cB','B','Client B','https://b.com','c@b.com','active',0,NULL,NULL,NULL,0,0)`);
  for (const u of ['ownerA', 'memberA', 'ownerB']) {
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

describe('AI auto-reply rule', () => {
  it('posts only to recent, unanswered reviews at or above the star threshold', async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO reviews (id,agency_id,client_id,google_review_name,reviewer_name,star_rating,comment,review_created_at,reply_comment,synced_at) VALUES
       ('r5','A','cA','accounts/1/locations/11/reviews/5','Ravi',5,'Great!',?1,NULL,0),
       ('r4','A','cA','accounts/1/locations/11/reviews/4','Sita',4,'Good',?1,NULL,0),
       ('r1','A','cA','accounts/1/locations/11/reviews/1','Om',1,'Bad',?1,NULL,0),
       ('rOld','A','cA','accounts/1/locations/11/reviews/old','Old',5,'Nice',?2,NULL,0),
       ('rDone','A','cA','accounts/1/locations/11/reviews/done','Done',5,'Nice',?1,'Thanks',0)`,
    )
      .bind(now - DAY, now - 60 * DAY)
      .run();
    await saveConnection(env, {
      agencyId: 'A',
      clientId: 'cA',
      purpose: 'client_business',
      googleEmail: 'biz@gmail.com',
      scopes: 'openid',
      refreshToken: 'refresh-biz',
      userId: 'ownerA',
    });
    const posted: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token'))
        return json({ access_token: 'at', expires_in: 3600 });
      if (url.endsWith('/reply') && init?.method === 'PUT') posted.push(url);
      return json({});
    });
    env.AI = aiReturning({ reply: 'Thank you so much, we are happy you liked it!' });
    const client = (await env.DB.prepare(`SELECT * FROM clients WHERE id='cA'`).first())!;
    const asClient = (min: number | null) =>
      ({
        id: 'cA',
        agencyId: 'A',
        name: 'Client A',
        autoReplyMinStars: min,
        autoReplyLanguage: 'en',
      }) as Parameters<typeof autoReplyReviews>[1];
    expect(client).toBeTruthy();
    expect(await autoReplyReviews(env, asClient(null))).toBe(0); // off
    expect(await autoReplyReviews(env, asClient(3))).toBe(0); // below 4 is never allowed
    expect(await autoReplyReviews(env, asClient(5))).toBe(1);
    expect(posted).toEqual([
      'https://mybusiness.googleapis.com/v4/accounts/1/locations/11/reviews/5/reply',
    ]);
    const row = await env.DB.prepare(
      `SELECT reply_comment, auto_replied FROM reviews WHERE id='r5'`,
    ).first<{
      reply_comment: string;
      auto_replied: number;
    }>();
    expect(row).toEqual({
      reply_comment: 'Thank you so much, we are happy you liked it!',
      auto_replied: 1,
    });
    const audit = await env.DB.prepare(
      `SELECT count(*) AS n FROM audit_logs WHERE action='review.auto_reply'`,
    ).first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it('only the owner can change the rule, and only for own clients', async () => {
    const body = { minStars: 4, language: 'hinglish' };
    expect((await req('memberA', '/api/clients/cA/auto-reply', 'PUT', body)).status).toBe(403);
    expect((await req('ownerB', '/api/clients/cA/auto-reply', 'PUT', body)).status).toBe(404);
    expect(
      (await req('ownerA', '/api/clients/cA/auto-reply', 'PUT', { minStars: 3, language: 'en' }))
        .status,
    ).toBe(400);
    expect((await req('ownerA', '/api/clients/cA/auto-reply', 'PUT', body)).status).toBe(200);
    const c = await env.DB.prepare(
      `SELECT auto_reply_min_stars, auto_reply_language FROM clients WHERE id='cA'`,
    ).first();
    expect(c).toEqual({ auto_reply_min_stars: 4, auto_reply_language: 'hinglish' });
  });
});

describe('anomaly alerts', () => {
  it('stores alerts with explanations once, and does not repeat them within 14 days', async () => {
    const now = Date.now();
    const g = (cur: number, prev: number, pct: number) =>
      JSON.stringify({ ...gsc(cur, prev, pct), topQueries: [], quickWins: [] });
    await env.DB.prepare(
      `INSERT INTO health_checks (id,agency_id,client_id,run_at,gsc_json,score,status) VALUES
       ('h1','A','cA2',?1,?3,80,'ok'), ('h2','A','cA2',?2,?4,60,'ok')`,
    )
      .bind(now - 7 * DAY, now, g(100, 100, 0), g(30, 100, -70))
      .run();
    env.AI = aiDown;
    const client = (await env.DB.prepare(`SELECT * FROM clients WHERE id='cA2'`).first())!;
    const c = {
      ...client,
      agencyId: 'A',
      id: 'cA2',
      name: 'Client A2',
      gscSiteUrl: null,
    } as unknown as Parameters<typeof runAlerts>[2];
    expect(await runAlerts(env, 'A', c, 'h2', now)).toBe(2); // clicks_drop + score_drop
    expect(await runAlerts(env, 'A', c, 'h2', now + DAY)).toBe(0); // deduped
    const rows = await env.DB.prepare(
      `SELECT kind, explanation, explanation_source FROM alerts WHERE client_id='cA2' ORDER BY kind`,
    ).all<{ kind: string; explanation: string; explanation_source: string }>();
    expect(rows.results.map((r) => r.kind)).toEqual(['clicks_drop', 'score_drop']);
    expect(rows.results[0]!.explanation_source).toBe('fallback');
    expect(rows.results[0]!.explanation).toMatch(/Google clicks fell/);
  });

  it('alerts are tenant-scoped and members only see assigned clients', async () => {
    const own = (await (await req('ownerA', '/api/alerts')).json()) as {
      alerts: unknown[];
      unread: number;
    };
    expect(own.alerts).toHaveLength(2);
    expect(own.unread).toBe(2);
    const member = (await (await req('memberA', '/api/alerts')).json()) as { alerts: unknown[] };
    expect(member.alerts).toHaveLength(0); // cA2 is not assigned to the member
    const other = (await (await req('ownerB', '/api/alerts')).json()) as { alerts: unknown[] };
    expect(other.alerts).toHaveLength(0);
    expect((await req('ownerB', '/api/clients/cA2/alerts')).status).toBe(404);
    const id = (await env.DB.prepare(`SELECT id FROM alerts LIMIT 1`).first<{ id: string }>())!.id;
    expect((await req('ownerB', `/api/alerts/${id}/read`, 'POST', {})).status).toBe(404);
    expect((await req('ownerA', `/api/alerts/${id}/read`, 'POST', {})).status).toBe(200);
    await req('ownerB', '/api/alerts/read-all', 'POST', {});
    const unread = await env.DB.prepare(
      `SELECT count(*) AS n FROM alerts WHERE read_at IS NULL`,
    ).first<{ n: number }>();
    expect(unread?.n).toBe(1); // agency B's "read all" did not touch agency A
  });
});

describe('AI routes', () => {
  it('assistant answers from client data; other agencies get 404', async () => {
    let seen = '';
    env.AI = {
      run: async (_m: string, input: { messages: { content: string }[] }) => {
        seen = JSON.stringify(input.messages);
        return { response: 'Clicks fell 70%. Check the dropping pages first.' };
      },
    } as unknown as Ai;
    const res = await req('ownerA', '/api/clients/cA2/ai/assistant', 'POST', {
      messages: [{ role: 'user', content: 'Traffic kyun gira?' }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: 'Clicks fell 70%. Check the dropping pages first.' });
    expect(seen).toContain('Client A2'); // the client context was sent
    expect(seen).toContain('Traffic kyun gira?');
    expect(
      (
        await req('ownerB', '/api/clients/cA2/ai/assistant', 'POST', {
          messages: [{ role: 'user', content: 'hi' }],
        })
      ).status,
    ).toBe(404);
    for (const path of ['ai/content', 'ai/ad-copy', 'competitors/ai-analysis']) {
      expect(
        (
          await req('ownerB', `/api/clients/cA2/${path}`, 'POST', {
            type: 'meta_tags',
            keyword: 'x y',
          })
        ).status,
      ).toBe(404);
    }
  });

  it('content writer returns validated content, and 503 (no fake output) when the AI fails', async () => {
    env.AI = aiReturning({
      titles: [
        'Dentist in Pune | Client A2',
        'Best Dental Clinic in Pune',
        'Painless Dentist Pune',
      ],
      descriptions: [
        'Looking for a dentist in Pune? Client A2 offers gentle, modern dental care. Book a visit today.',
        'Gentle dental care in Pune for the whole family. Modern clinic, friendly team. Call us today.',
        'Need a dentist in Pune? Visit Client A2 for check-ups, cleaning and more. Book online now.',
      ],
    });
    const ok = await req('ownerA', '/api/clients/cA2/ai/content', 'POST', {
      type: 'meta_tags',
      keyword: 'dentist in pune',
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { titles: string[] } }).data.titles).toHaveLength(3);
    env.AI = aiReturning({ titles: ['too short'] });
    const bad = await req('ownerA', '/api/clients/cA2/ai/content', 'POST', {
      type: 'meta_tags',
      keyword: 'dentist in pune',
    });
    expect(bad.status).toBe(503);
  });

  it('prospect audits are stored per agency', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://shop.in/')
        return new Response(
          '<html><head><title>Shop</title></head><body><h1>Shop</h1></body></html>',
          {
            status: 200,
            headers: { 'content-type': 'text/html' },
          },
        );
      if (url.includes('pagespeedonline')) return json({}, 500);
      return new Response('not found', { status: 404 });
    });
    env.AI = aiDown;
    const res = await req('ownerA', '/api/prospects', 'POST', {
      url: 'shop.in',
      businessName: 'Shop',
    });
    expect(res.status).toBe(201);
    const { audit } = (await res.json()) as {
      audit: { id: string; status: string; reportSource: string };
    };
    expect(audit).toMatchObject({ status: 'ready', reportSource: 'fallback' });
    expect((await req('ownerB', `/api/prospects/${audit.id}`)).status).toBe(404);
    expect(
      ((await (await req('ownerB', '/api/prospects')).json()) as { audits: unknown[] }).audits,
    ).toHaveLength(0);
    await req('ownerB', `/api/prospects/${audit.id}`, 'DELETE');
    expect((await req('ownerA', `/api/prospects/${audit.id}`)).status).toBe(200);
    expect(
      (await req('ownerA', '/api/prospects', 'POST', { url: 'http://localhost' })).status,
    ).toBe(400);
  });

  it('enforces the daily AI request limit of the plan', async () => {
    env.AI = aiReturning('ok');
    // Agency B is on Free (30/day): use them up.
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    await env.KV.put(`aiq:B:${today}`, '30');
    const res = await req('ownerB', '/api/clients/cB/ai/assistant', 'POST', {
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.status).toBe(402);
    expect(((await res.json()) as { error: string }).error).toMatch(/30 AI requests/);
    const usage = (await (await req('ownerB', '/api/ai/usage')).json()) as {
      used: number;
      limit: number;
    };
    expect(usage).toEqual({ used: 30, limit: 30 });
  });
});
