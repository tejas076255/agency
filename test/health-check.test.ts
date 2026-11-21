// Full health-check pipeline with mocked Google APIs (never hits real APIs) on a real local D1 + KV.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { retryConfig } from '../src/google/http';
import { saveConnection } from '../src/google/tokens';
import { runHealthCheck } from '../src/jobs/health-check';
import { handleCron } from '../src/jobs/queue';
import { createTestEnv, validAiOutput } from './helpers';
import type { JobMessage } from '../src/env';

let env: Env;
let sent: JobMessage[];
let dispose: () => Promise<void>;
const AG = 'agency-1';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const psiResponse = {
  lighthouseResult: {
    categories: { performance: { score: 0.8 } },
    audits: { 'largest-contentful-paint': { numericValue: 2500 } },
  },
};

/** Fake Google: token endpoint, Search Console, GA4 (configurable), PageSpeed. */
function mockGoogle(opts: { ga4Status?: number; tokenError?: boolean } = {}) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return opts.tokenError
        ? json(
            { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
            400,
          )
        : json({ access_token: 'access-123', expires_in: 3600 });
    }
    if (url.includes('searchAnalytics/query')) {
      return json({
        rows: [{ keys: ['seo pune'], clicks: 100, impressions: 2000, ctr: 0.05, position: 9.5 }],
      });
    }
    if (url.includes('analyticsdata.googleapis.com')) {
      return opts.ga4Status
        ? json({ error: { message: 'Backend error', status: 'UNAVAILABLE' } }, opts.ga4Status)
        : json({ rows: [] });
    }
    if (url.includes('pagespeedonline')) return json(psiResponse);
    return json({ error: { message: `unmocked ${url}` } }, 404);
  });
  return calls;
}

beforeAll(async () => {
  retryConfig.baseDelayMs = 1;
  const t = await createTestEnv({
    AI: { run: async () => ({ response: validAiOutput }) } as unknown as Ai,
  });
  env = t.env;
  sent = t.sent;
  dispose = t.dispose;
  const run = (sql: string, ...a: unknown[]) =>
    env.DB.prepare(sql)
      .bind(...a)
      .run();
  await run(
    `INSERT INTO agencies (id,name,brand_color,plan,created_at) VALUES (?,'Ag','#000000','free',0)`,
    AG,
  );
  await run(
    `INSERT INTO users (id,agency_id,email,name,role,google_sub,created_at) VALUES ('u1',?,'u@x.com','U','owner','s1',0)`,
    AG,
  );
  for (const id of ['c1', 'c2']) {
    await run(
      `INSERT INTO clients (id,agency_id,name,website_url,contact_email,gsc_site_url,ga4_property_id,status,auto_send_report,created_at,updated_at)
       VALUES (?,?,?,?,?,'sc-domain:x.com','123','active',0,0,0)`,
      id,
      AG,
      `Client ${id}`,
      'https://x.com',
      'c@x.com',
    );
    await saveConnection(env, {
      agencyId: AG,
      clientId: id,
      purpose: 'client_data',
      googleEmail: 'client@gmail.com',
      scopes:
        'openid email https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/analytics.readonly',
      refreshToken: `refresh-${id}`,
      userId: 'u1',
    });
  }
}, 60_000);

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await dispose?.();
});

describe('runHealthCheck', () => {
  it('stores refresh tokens encrypted, never in plain text', async () => {
    const row = await env.DB.prepare(
      `SELECT encrypted_refresh_token AS t FROM google_connections WHERE client_id='c1'`,
    ).first<{ t: string }>();
    expect(row?.t.startsWith('v1.')).toBe(true);
    expect(row?.t).not.toContain('refresh-c1');
  });

  it('produces a partial result when one source fails (GA4 down), with score and 5 AI actions', async () => {
    const calls = mockGoogle({ ga4Status: 503 });
    const r = await runHealthCheck(env, AG, 'c1');
    expect(r.status).toBe('partial');
    expect(r.errors.ga4).toMatch(/503/);
    expect(r.errors.gsc).toBeUndefined();
    expect(r.score).not.toBeNull();
    // GA4 was retried with backoff before giving up.
    expect(calls.filter((u) => u.includes('analyticsdata')).length).toBeGreaterThan(4);

    const items = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM action_items WHERE client_id='c1'`,
    ).first<{ n: number }>();
    expect(items?.n).toBe(5);
    const hc = await env.DB.prepare(
      `SELECT ga4_json, gsc_json, pagespeed_json FROM health_checks WHERE id=?`,
    )
      .bind(r.healthCheckId)
      .first<Record<string, string | null>>();
    expect(hc?.ga4_json).toBeNull();
    expect(hc?.gsc_json).toContain('seo pune');
    expect(hc?.pagespeed_json).toContain('"score":80');
  });

  it('caches the access token (no second token refresh)', async () => {
    const calls = mockGoogle();
    await runHealthCheck(env, AG, 'c1');
    expect(calls.some((u) => u.startsWith('https://oauth2.googleapis.com/token'))).toBe(false);
  });

  it('marks the client "reconnect needed" when the refresh token is revoked', async () => {
    mockGoogle({ tokenError: true });
    const r = await runHealthCheck(env, AG, 'c2');
    expect(r.errors.gsc).toMatch(/Reconnect/);
    expect(r.status).toBe('partial'); // PageSpeed still worked
    const client = await env.DB.prepare(`SELECT status FROM clients WHERE id='c2'`).first<{
      status: string;
    }>();
    expect(client?.status).toBe('reconnect_needed');
    const conn = await env.DB.prepare(
      `SELECT status FROM google_connections WHERE client_id='c2'`,
    ).first<{ status: string }>();
    expect(conn?.status).toBe('revoked');
  });
});

describe('cron fan-out', () => {
  it('weekly cron enqueues one message per healthy client', async () => {
    sent.length = 0;
    await handleCron('30 0 * * 1', env);
    // c2 is "reconnect_needed" and is skipped.
    expect(sent.map((m) => m.clientId)).toEqual(['c1']);
    expect(sent[0]?.type).toBe('health_check');
  });

  it('monthly cron enqueues reports for the previous month', async () => {
    sent.length = 0;
    await handleCron('30 0 1 * *', env, Date.UTC(2026, 11, 1, 1)); // 1 Dec 2026
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'monthly_report', month: '2026-11', send: false });
  });
});
