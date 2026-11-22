// Phase 2/3 API: tenant isolation, team invites, plan limits, integrations sync (mocked Google).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { retryConfig } from '../src/google/http';
import { saveConnection } from '../src/google/tokens';
import { syncIntegrations } from '../src/jobs/integrations';
import { createSession } from '../src/lib/session';
import { acceptInvitation, createInvitation } from '../src/lib/team';
import { createTestEnv } from './helpers';

let env: Env;
let dispose: () => Promise<void>;
const auth: Record<string, { cookie: string; csrf: string }> = {};

beforeAll(async () => {
  retryConfig.baseDelayMs = 1;
  const t = await createTestEnv({
    NATURAL_LANGUAGE_API_KEY: 'nl-key',
    PLACES_API_KEY: 'places-key',
  });
  env = t.env;
  dispose = t.dispose;
  const run = (sql: string) => env.DB.prepare(sql).run();
  await run(
    `INSERT INTO agencies (id,name,brand_color,plan,created_at) VALUES ('A','A','#000000','pro',0),('B','B','#000000','free',0)`,
  );
  await run(`INSERT INTO users (id,agency_id,email,name,role,google_sub,created_at) VALUES
    ('ownerA','A','a@x.com','Owner A','owner','sa',0),
    ('memberA','A','m@x.com','Member A','member','sm',0),
    ('ownerB','B','b@x.com','Owner B','owner','sb',0),
    ('loner',NULL,'new@x.com','New','owner','sn',0)`);
  await run(`INSERT INTO clients (id,agency_id,name,website_url,contact_email,status,auto_send_report,gbp_account_name,gbp_location_name,created_at,updated_at) VALUES
    ('cA','A','Client A','https://a.com','c@a.com','active',0,'accounts/1','locations/11',0,0),
    ('cB','B','Client B','https://b.com','c@b.com','active',0,'accounts/2','locations/22',0,0)`);
  await run(`INSERT INTO reviews (id,agency_id,client_id,google_review_name,star_rating,comment,review_created_at,synced_at) VALUES
    ('rB','B','cB','accounts/2/locations/22/reviews/x',1,'Bad',0,0)`);
  await run(
    `INSERT INTO competitors (id,agency_id,client_id,place_id,label,is_client,created_at) VALUES ('compB','B','cB','ChIJbbbbbbbbbb','Rival',0,0)`,
  );
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
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );

describe('tenant isolation for Phase 2/3 routes', () => {
  it("agency A cannot read or change agency B's integrations, reviews or competitors", async () => {
    expect((await req('ownerA', '/api/clients/cB/integrations')).status).toBe(404);
    expect((await req('ownerA', '/api/clients/cB/integrations/gbp/connect', 'POST')).status).toBe(
      404,
    );
    expect((await req('ownerA', '/api/clients/cB/integrations/ads/options')).status).toBe(404);
    expect((await req('ownerA', '/api/clients/cB/integrations/youtube', 'DELETE')).status).toBe(
      404,
    );
    expect(
      (await req('ownerA', '/api/clients/cB/reviews/rB/reply', 'POST', { comment: 'hacked' }))
        .status,
    ).toBe(404);
    expect(
      (
        await req('ownerA', '/api/clients/cB/competitors', 'POST', {
          placeId: 'ChIJaaaaaaaaaa',
          label: 'x',
        })
      ).status,
    ).toBe(404);
    expect((await req('ownerA', '/api/clients/cB/competitors/compB', 'DELETE')).status).toBe(404);
    expect((await req('ownerA', '/api/clients/cB/exports/sheets', 'POST')).status).toBe(404);
    expect((await req('ownerA', '/api/clients/cB/assignee', 'PUT', { userId: null })).status).toBe(
      404,
    );
    const comp = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM competitors WHERE id='compB'`,
    ).first<{ n: number }>();
    expect(comp?.n).toBe(1);
  });

  it('agency channel overview lists only own clients', async () => {
    const res = await req('ownerA', '/api/channels/overview');
    const ids = ((await res.json()) as { clients: { id: string }[] }).clients.map((c) => c.id);
    expect(ids).toEqual(['cA']);
  });

  it("an owner cannot assign a client to another agency's user or remove another agency's member", async () => {
    expect(
      (await req('ownerA', '/api/clients/cA/assignee', 'PUT', { userId: 'ownerB' })).status,
    ).toBe(400);
    expect((await req('ownerA', '/api/team/members/ownerB', 'DELETE')).status).toBe(404);
  });

  it('members cannot invite, assign or see billing-only actions they are not allowed to do', async () => {
    expect((await req('memberA', '/api/team/invites', 'POST', { email: 'z@x.com' })).status).toBe(
      403,
    );
    expect((await req('memberA', '/api/clients/cA/assignee', 'PUT', { userId: null })).status).toBe(
      403,
    );
  });
});

describe('team invites', () => {
  it('owner invites; the invited email joins as member via the token', async () => {
    const res = await req('ownerA', '/api/team/invites', 'POST', { email: 'new@x.com' });
    expect(res.status).toBe(201);
    const { url } = (await res.json()) as { url: string };
    const token = new URL(url).searchParams.get('invite')!;
    const user = await env.DB.prepare(`SELECT * FROM users WHERE id='loner'`).first();
    const mapped = {
      id: 'loner',
      agencyId: null,
      email: 'new@x.com',
      name: 'New',
      pictureUrl: null,
      role: 'owner' as const,
      googleSub: 'sn',
      sessionVersion: 0,
      createdAt: 0,
    };
    expect(user).not.toBeNull();
    const r = await acceptInvitation(env, mapped, token);
    expect(r.ok).toBe(true);
    const row = await env.DB.prepare(`SELECT agency_id, role FROM users WHERE id='loner'`).first();
    expect(row).toEqual({ agency_id: 'A', role: 'member' });
    // Single use.
    expect((await acceptInvitation(env, { ...mapped, agencyId: null }, token)).ok).toBe(false);
  });

  it('rejects wrong email, expired invites and users already in another agency', async () => {
    const base = {
      name: 'X',
      pictureUrl: null,
      role: 'owner' as const,
      googleSub: 'g',
      sessionVersion: 0,
      createdAt: 0,
    };
    const a = await createInvitation(env, 'A', 'right@x.com', 'ownerA');
    const tokenA = new URL(a.url).searchParams.get('invite')!;
    expect(
      await acceptInvitation(
        env,
        { ...base, id: 'u1', agencyId: null, email: 'wrong@x.com' },
        tokenA,
      ),
    ).toEqual({ ok: false, reason: 'email_mismatch' });
    expect(
      await acceptInvitation(
        env,
        { ...base, id: 'u2', agencyId: 'B', email: 'right@x.com' },
        tokenA,
      ),
    ).toEqual({ ok: false, reason: 'already_in_agency' });
    expect(
      await acceptInvitation(
        env,
        { ...base, id: 'u3', agencyId: null, email: 'right@x.com' },
        tokenA,
        Date.now() + 8 * 86_400_000,
      ),
    ).toEqual({ ok: false, reason: 'expired' });
    expect(
      await acceptInvitation(
        env,
        { ...base, id: 'u4', agencyId: null, email: 'right@x.com' },
        'x'.repeat(43),
      ),
    ).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('plans and limits (Phase 4, no payments)', () => {
  it('billing shows the plan, limits and usage; payments are disabled', async () => {
    const res = await req('ownerA', '/api/billing');
    const body = (await res.json()) as {
      plan: string;
      paymentsEnabled: boolean;
      usage: { clients: number };
      limits: { maxClients: number };
    };
    expect(body).toMatchObject({ plan: 'pro', paymentsEnabled: false });
    expect(body.limits.maxClients).toBe(25);
  });

  it('the Free plan allows only the owner (invites return 402)', async () => {
    const r = await req('ownerB', '/api/team/invites', 'POST', { email: 'helper@b.com' });
    expect(r.status).toBe(402);
  });

  it('blocks adding clients beyond the plan limit with HTTP 402', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await req('ownerB', '/api/clients', 'POST', {
        name: `B${i}`,
        websiteUrl: 'https://b.com',
        contactEmail: 'c@b.com',
      });
      expect(r.status).toBe(201);
    }
    const blocked = await req('ownerB', '/api/clients', 'POST', {
      name: 'B-6',
      websiteUrl: 'https://b.com',
      contactEmail: 'c@b.com',
    });
    expect(blocked.status).toBe(402);
    expect(((await blocked.json()) as { error: string }).error).toMatch(
      /Free plan allows 5 clients/,
    );
  });
});

describe('integrations sync with mocked Google', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('records "not approved" when the Business Profile API has quota 0', async () => {
    await saveConnection(env, {
      agencyId: 'A',
      clientId: 'cA',
      purpose: 'client_business',
      googleEmail: 'a@g.com',
      scopes: 'openid email https://www.googleapis.com/auth/business.manage',
      refreshToken: 'r1',
      userId: 'ownerA',
    });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token'))
        return json({ access_token: 'at', expires_in: 3600 });
      return json(
        {
          error: {
            code: 429,
            message: "Quota exceeded for quota metric 'Requests' ... limit 0",
            status: 'RESOURCE_EXHAUSTED',
          },
        },
        429,
      );
    });
    const client = (await env.DB.prepare(`SELECT * FROM clients WHERE id='cA'`).first())!;
    const r = await syncIntegrations(env, {
      id: 'cA',
      agencyId: 'A',
      name: 'Client A',
      websiteUrl: 'https://a.com',
      contactEmail: 'c@a.com',
      gscSiteUrl: null,
      ga4PropertyId: null,
      status: 'active',
      assignedUserId: null,
      autoSendReport: false,
      gbpAccountName: 'accounts/1',
      gbpLocationName: 'locations/11',
      adsCustomerId: null,
      youtubeChannelId: null,
      autoReplyMinStars: null,
      autoReplyLanguage: 'en' as const,
      createdAt: 0,
      updatedAt: 0,
    });
    expect(client).not.toBeNull();
    expect(r.errors.gbp).toMatch(/not approved/);
    const snap = await env.DB.prepare(
      `SELECT status, error FROM integration_snapshots WHERE client_id='cA' AND source='gbp'`,
    ).first<{ status: string; error: string }>();
    expect(snap?.status).toBe('failed');
  });

  it('syncs performance + reviews and runs sentiment on new reviews', async () => {
    let nlCalls = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token'))
        return json({ access_token: 'at', expires_in: 3600 });
      if (url.includes('mybusinessbusinessinformation'))
        return json({
          name: 'locations/11',
          title: 'Client A Clinic',
          websiteUri: 'https://a.com',
        });
      if (url.includes('businessprofileperformance'))
        return json({ multiDailyMetricTimeSeries: [] });
      if (url.includes('/reviews')) {
        return json({
          averageRating: 4.5,
          totalReviewCount: 2,
          reviews: [
            {
              name: 'accounts/1/locations/11/reviews/r1',
              starRating: 'FIVE',
              comment: 'Wonderful doctor',
              createTime: '2026-11-10T10:00:00Z',
            },
            {
              name: 'accounts/1/locations/11/reviews/r2',
              starRating: 'ONE',
              comment: 'Long waiting time',
              createTime: '2026-11-12T10:00:00Z',
              reviewReply: { comment: 'Sorry!' },
            },
          ],
        });
      }
      if (url.includes('language.googleapis.com')) {
        nlCalls++;
        return json({
          documentSentiment: { score: nlCalls === 1 ? -0.8 : 0.9, magnitude: 1 },
          entities: [{ name: 'waiting time', salience: 0.7 }],
        });
      }
      return json({ error: { message: `unmocked ${url}` } }, 404);
    });
    const r = await syncIntegrations(env, {
      id: 'cA',
      agencyId: 'A',
      name: 'Client A',
      websiteUrl: 'https://a.com',
      contactEmail: 'c@a.com',
      gscSiteUrl: null,
      ga4PropertyId: null,
      status: 'active',
      assignedUserId: null,
      autoSendReport: false,
      gbpAccountName: 'accounts/1',
      gbpLocationName: 'locations/11',
      adsCustomerId: null,
      youtubeChannelId: null,
      autoReplyMinStars: null,
      autoReplyLanguage: 'en' as const,
      createdAt: 0,
      updatedAt: 0,
    });
    expect(r.errors).toEqual({});
    expect(r.gbp?.location.title).toBe('Client A Clinic');
    const rows = await env.DB.prepare(
      `SELECT r.star_rating AS stars, s.label FROM reviews r LEFT JOIN review_sentiments s ON s.review_id = r.id WHERE r.client_id='cA' ORDER BY r.review_created_at`,
    ).all();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.every((x) => (x as { label: string | null }).label !== null)).toBe(true);
    expect(nlCalls).toBe(2);

    // A second sync does not re-analyze (cost control) and does not duplicate reviews.
    await syncIntegrations(env, {
      id: 'cA',
      agencyId: 'A',
      name: 'Client A',
      websiteUrl: 'https://a.com',
      contactEmail: 'c@a.com',
      gscSiteUrl: null,
      ga4PropertyId: null,
      status: 'active',
      assignedUserId: null,
      autoSendReport: false,
      gbpAccountName: 'accounts/1',
      gbpLocationName: 'locations/11',
      adsCustomerId: null,
      youtubeChannelId: null,
      autoReplyMinStars: null,
      autoReplyLanguage: 'en' as const,
      createdAt: 0,
      updatedAt: 0,
    });
    expect(nlCalls).toBe(2);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE client_id='cA'`).first<{
      n: number;
    }>();
    expect(n?.n).toBe(2);

    const res = await req('ownerA', '/api/clients/cA/integrations');
    const body = (await res.json()) as {
      reviews: {
        sentimentCounts: Record<string, number>;
        themes: { negative: { name: string }[] };
      };
    };
    expect(body.reviews.sentimentCounts).toEqual({ positive: 1, neutral: 0, negative: 1 });
    expect(body.reviews.themes.negative[0]?.name).toBe('waiting time');
  });

  it('competitor comparison fetches live data and never stores ratings', async () => {
    await req('ownerA', '/api/clients/cA/competitors', 'POST', {
      placeId: 'ChIJcompetitor1',
      label: 'Rival 1',
    });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect((init?.headers as Record<string, string>)['X-Goog-FieldMask']).toBeTruthy();
      if (url.includes('places.googleapis.com/v1/places/'))
        return json({
          id: 'ChIJcompetitor1',
          displayName: { text: 'Rival 1' },
          rating: 4.6,
          userRatingCount: 120,
        });
      return json({}, 404);
    });
    const res = await req('ownerA', '/api/clients/cA/competitors/live');
    const body = (await res.json()) as { ranked: { rating: number }[] };
    expect(body.ranked[0]?.rating).toBe(4.6);
    const cols = await env.DB.prepare(`PRAGMA table_info(competitors)`).all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).not.toContain('rating');
  });
});
