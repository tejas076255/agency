// Audit logs, API usage counters and secret-safe logging.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { audit } from '../src/lib/audit';
import { redact, redactString } from '../src/lib/log';
import { createSession } from '../src/lib/session';
import { apiNameFromUrl, getUsage, recordApiCall, withUsageTracking } from '../src/lib/usage';
import { createTestEnv } from './helpers';

let env: Env;
let dispose: () => Promise<void>;
const auth: Record<string, { cookie: string; csrf: string }> = {};

beforeAll(async () => {
  const t = await createTestEnv({ AUDIT_HASH_SALT: 'test-salt' });
  env = t.env;
  dispose = t.dispose;
  const run = (sql: string) => env.DB.prepare(sql).run();
  await run(
    `INSERT INTO agencies (id,name,brand_color,plan,created_at) VALUES ('A','A','#000000','free',0),('B','B','#000000','free',0)`,
  );
  await run(`INSERT INTO users (id,agency_id,email,name,role,google_sub,created_at) VALUES
    ('ownerA','A','a@x.com','Owner A','owner','sa',0),
    ('memberA','A','m@x.com','Member A','member','sm',0),
    ('ownerB','B','b@x.com','Owner B','owner','sb',0)`);
  for (const u of ['ownerA', 'memberA', 'ownerB']) {
    const s = await createSession(env.KV, u);
    auth[u] = { cookie: `sid=${s.id}`, csrf: s.data.csrfToken };
  }
}, 60_000);

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
        'cf-connecting-ip': '203.0.113.7',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );

describe('audit logs', () => {
  it('records client creation with a hashed IP (never the raw IP)', async () => {
    const res = await req('ownerA', '/api/clients', 'POST', {
      name: 'Audit Client',
      websiteUrl: 'https://audit.example',
      contactEmail: 'c@audit.example',
    });
    expect(res.status).toBe(201);
    const row = await env.DB.prepare(
      `SELECT agency_id, user_id, action, ip_hash, metadata_json FROM audit_logs WHERE action='client.create'`,
    ).first<Record<string, string>>();
    expect(row).toMatchObject({ agency_id: 'A', user_id: 'ownerA', action: 'client.create' });
    expect(row?.ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(row)).not.toContain('203.0.113.7');
  });

  it('redacts secrets inside audit metadata', async () => {
    await audit(env, {
      agencyId: 'A',
      userId: 'ownerA',
      action: 'agency.update',
      metadata: {
        refresh_token: '1//abcdefghijklmnop',
        note: 'key=AIzaSyFAKE0000000000000000000000000000',
      },
    });
    const row = await env.DB.prepare(
      `SELECT metadata_json AS m FROM audit_logs WHERE action='agency.update'`,
    ).first<{ m: string }>();
    expect(row?.m).not.toContain('1//abcdefghijklmnop');
    expect(row?.m).not.toContain('AIzaSyFAKE00');
  });

  it('only the owner can read the audit log, and only for their own agency', async () => {
    const a = await req('ownerA', '/api/agency/audit-logs');
    expect(a.status).toBe(200);
    const logs = ((await a.json()) as { logs: { action: string }[] }).logs;
    expect(logs.some((l) => l.action === 'client.create')).toBe(true);

    expect((await req('memberA', '/api/agency/audit-logs')).status).toBe(403);

    const b = await req('ownerB', '/api/agency/audit-logs');
    const bLogs = ((await b.json()) as { logs: unknown[] }).logs;
    expect(bLogs).toHaveLength(0);
  });
});

describe('API usage tracking', () => {
  it('maps URLs to API names', () => {
    expect(apiNameFromUrl('https://www.googleapis.com/webmasters/v3/sites')).toBe('gsc');
    expect(
      apiNameFromUrl('https://analyticsdata.googleapis.com/v1beta/properties/1:runReport'),
    ).toBe('ga4');
    expect(apiNameFromUrl('https://analyticsadmin.googleapis.com/v1beta/accountSummaries')).toBe(
      'ga4_admin',
    );
    expect(apiNameFromUrl('https://www.googleapis.com/pagespeedonline/v5/runPagespeed')).toBe(
      'pagespeed',
    );
    expect(
      apiNameFromUrl('https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send'),
    ).toBe('gmail');
  });

  it('accumulates counters per agency per day and keeps agencies separate', async () => {
    await withUsageTracking(env, 'A', async () => {
      recordApiCall('gsc', { ok: true, status: 200 });
      recordApiCall('gsc', { ok: false, status: 429 });
      recordApiCall('pagespeed', { ok: true, status: 200 });
    });
    await withUsageTracking(env, 'A', async () => {
      recordApiCall('gsc', { ok: true, status: 200 });
    });
    await withUsageTracking(env, 'B', async () => {
      recordApiCall('ga4', { ok: true, status: 200 });
    });
    const a = await getUsage(env, 'A');
    const gsc = a.find((u) => u.api === 'gsc');
    expect(gsc).toMatchObject({ calls: 3, errors: 1, quotaErrors: 1 });
    expect(a.some((u) => u.api === 'ga4')).toBe(false);

    const res = await req('ownerB', '/api/agency/usage');
    const usage = ((await res.json()) as { usage: { api: string }[] }).usage;
    expect(usage.map((u) => u.api)).toEqual(['ga4']);
  });

  it('does nothing outside a tracking context', () => {
    expect(() => recordApiCall('gsc', { ok: true })).not.toThrow();
  });
});

describe('secret-safe logging', () => {
  it('redacts Google tokens, API keys, client secrets and encrypted blobs in strings', () => {
    const s = redactString(
      'Bearer ya29.a0AfH6SMBx token 1//0gAbCdEfGhIjKlMn key=AIzaSyFAKE0000000000000000000000000000 secret GOCSPX-abc123 enc v2.k1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBB',
    );
    expect(s).not.toMatch(/ya29\.a0/);
    expect(s).not.toContain('0gAbCdEfGhIjKlMn');
    expect(s).not.toContain('AIzaSyFAKE00');
    expect(s).not.toContain('abc123');
    expect(s).toContain('[ENCRYPTED]');
  });

  it('redacts secret-looking keys in objects and errors', () => {
    const out = redact({
      access_token: 'abc',
      nested: { client_secret: 'x', ok: 'visible' },
      err: new Error('failed with ?key=AIzaSyFAKE0000000000000000000000000000'),
    }) as Record<string, unknown>;
    expect(out.access_token).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).client_secret).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).ok).toBe('visible');
    expect(JSON.stringify(out.err)).not.toContain('AIzaSyFAKE00');
  });
});
