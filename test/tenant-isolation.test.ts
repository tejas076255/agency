// Proves that agency A can never read or change agency B's data through the API.
// Runs the real Hono app against a real local D1 + KV (Miniflare), no mocks for the DB.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { createSession } from '../src/lib/session';
import { createTestEnv } from './helpers';

let env: Env;
let dispose: () => Promise<void>;
const auth: Record<string, { cookie: string; csrf: string }> = {};

const A = 'agency-a';
const B = 'agency-b';

beforeAll(async () => {
  const t = await createTestEnv();
  env = t.env;
  dispose = t.dispose;
  const db = env.DB;
  const run = (sql: string, ...args: unknown[]) =>
    db
      .prepare(sql)
      .bind(...args)
      .run();

  for (const [id, name] of [
    [A, 'Agency A'],
    [B, 'Agency B'],
  ]) {
    await run(
      `INSERT INTO agencies (id,name,brand_color,plan,created_at) VALUES (?,?,'#000000','free',0)`,
      id,
      name,
    );
  }
  const users = [
    ['user-a', A, 'owner'],
    ['member-a', A, 'member'],
    ['user-b', B, 'owner'],
  ] as const;
  for (const [id, agency, role] of users) {
    await run(
      `INSERT INTO users (id,agency_id,email,name,role,google_sub,created_at) VALUES (?,?,?,?,?,?,0)`,
      id,
      agency,
      `${id}@x.com`,
      id,
      role,
      `sub-${id}`,
    );
  }
  const clients = [
    ['client-a1', A, null],
    ['client-a2', A, 'member-a'],
    ['client-b', B, null],
  ] as const;
  for (const [id, agency, assigned] of clients) {
    await run(
      `INSERT INTO clients (id,agency_id,name,website_url,contact_email,status,assigned_user_id,auto_send_report,created_at,updated_at)
       VALUES (?,?,?,?,?,'active',?,0,0,0)`,
      id,
      agency,
      `Name ${id}`,
      `https://${id}.com`,
      `${id}@c.com`,
      assigned,
    );
  }
  await run(
    `INSERT INTO health_checks (id,agency_id,client_id,run_at,score,status) VALUES ('hc-b',?,'client-b',1,77,'ok')`,
    B,
  );
  await run(
    `INSERT INTO insights (id,agency_id,health_check_id,summary,model_used,created_at) VALUES ('ins-b',?,'hc-b','secret B summary','m',1)`,
    B,
  );
  await run(
    `INSERT INTO action_items (id,agency_id,client_id,insight_id,priority,title,why,expected_impact,done) VALUES ('item-b',?,'client-b','ins-b',1,'t','w','i',0)`,
    B,
  );
  await run(
    `INSERT INTO reports (id,agency_id,client_id,month,share_token,status,pdf_kv_key,created_at) VALUES ('report-b',?,'client-b','2026-10','tok-b','ready','report-pdf:report-b',0)`,
    B,
  );
  await env.KV.put('report-pdf:report-b', 'PDF-OF-B');
  await run(
    `INSERT INTO job_runs (id,agency_id,client_id,type,trigger,status,attempt,created_at) VALUES ('job-b',?,'client-b','health_check','cron','failed',1,0)`,
    B,
  );
  await run(
    `INSERT INTO job_runs (id,agency_id,client_id,type,trigger,status,attempt,created_at) VALUES ('job-a',?,'client-a1','health_check','cron','success',1,0)`,
    A,
  );

  for (const u of ['user-a', 'member-a', 'user-b']) {
    const s = await createSession(env.KV, u);
    auth[u] = { cookie: `sid=${s.id}`, csrf: s.data.csrfToken };
  }
}, 60_000);

afterAll(async () => {
  await dispose?.();
});

function req(user: string | null, path: string, init: { method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { origin: 'http://localhost:5173' };
  if (user) {
    headers.cookie = auth[user]!.cookie;
    headers['x-csrf-token'] = auth[user]!.csrf;
  }
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return app.request(
    `http://localhost${path}`,
    {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    },
    env,
  );
}

describe('tenant isolation: agency A vs agency B', () => {
  it('client list only contains own agency clients', async () => {
    const res = await req('user-a', '/api/clients');
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { clients: { id: string }[] }).clients
      .map((c) => c.id)
      .sort();
    expect(ids).toEqual(['client-a1', 'client-a2']);
  });

  it("cannot read another agency's client, insights or action items", async () => {
    const res = await req('user-a', '/api/clients/client-b');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('secret B summary');
  });

  it("cannot edit, delete, run or connect another agency's client", async () => {
    expect(
      (await req('user-a', '/api/clients/client-b', { method: 'PUT', body: { name: 'Hacked' } }))
        .status,
    ).toBe(404);
    expect((await req('user-a', '/api/clients/client-b', { method: 'DELETE' })).status).toBe(404);
    expect(
      (await req('user-a', '/api/clients/client-b/run', { method: 'POST', body: {} })).status,
    ).toBe(404);
    expect(
      (await req('user-a', '/api/clients/client-b/google/connect', { method: 'POST' })).status,
    ).toBe(404);
    expect((await req('user-a', '/api/clients/client-b/google', { method: 'DELETE' })).status).toBe(
      404,
    );
    const row = await env.DB.prepare(`SELECT name FROM clients WHERE id='client-b'`).first<{
      name: string;
    }>();
    expect(row?.name).toBe('Name client-b');
  });

  it("cannot tick another agency's action items", async () => {
    expect(
      (await req('user-a', '/api/action-items/item-b', { method: 'PATCH', body: { done: true } }))
        .status,
    ).toBe(404);
    const row = await env.DB.prepare(`SELECT done FROM action_items WHERE id='item-b'`).first<{
      done: number;
    }>();
    expect(row?.done).toBe(0);
  });

  it("cannot download or send another agency's report", async () => {
    const pdf = await req('user-a', '/api/reports/report-b/pdf');
    expect(pdf.status).toBe(404);
    expect(await pdf.text()).not.toContain('PDF-OF-B');
    expect((await req('user-a', '/api/reports/report-b/send', { method: 'POST' })).status).toBe(
      404,
    );
  });

  it('job logs only show own agency jobs', async () => {
    const res = await req('user-a', '/api/jobs');
    const jobs = ((await res.json()) as { jobs: { id: string }[] }).jobs.map((j) => j.id);
    expect(jobs).toEqual(['job-a']);
  });

  it('agency settings are scoped to own agency', async () => {
    const res = await req('user-a', '/api/agency');
    expect(((await res.json()) as { agency: { name: string } }).agency.name).toBe('Agency A');
  });

  it('the owner of agency B can still see and update their own data', async () => {
    const res = await req('user-b', '/api/clients/client-b');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('secret B summary');
    const tick = await req('user-b', '/api/action-items/item-b', {
      method: 'PATCH',
      body: { done: true },
    });
    expect(tick.status).toBe(200);
    const row = await env.DB.prepare(`SELECT done FROM action_items WHERE id='item-b'`).first<{
      done: number;
    }>();
    expect(row?.done).toBe(1);
  });

  it('members only see clients assigned to them', async () => {
    const res = await req('member-a', '/api/clients');
    const ids = ((await res.json()) as { clients: { id: string }[] }).clients.map((c) => c.id);
    expect(ids).toEqual(['client-a2']);
    expect((await req('member-a', '/api/clients/client-a1')).status).toBe(404);
  });
});

describe('auth and CSRF guards', () => {
  it('rejects signed-out requests', async () => {
    expect((await req(null, '/api/clients')).status).toBe(401);
  });

  it('rejects state-changing requests without the CSRF token', async () => {
    const res = await app.request(
      'http://localhost/api/clients',
      {
        method: 'POST',
        headers: { cookie: auth['user-a']!.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'X', websiteUrl: 'https://x.com', contactEmail: 'x@x.com' }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it('rejects cross-origin requests even with a valid token', async () => {
    const res = await app.request(
      'http://localhost/api/clients',
      {
        method: 'POST',
        headers: {
          cookie: auth['user-a']!.cookie,
          'x-csrf-token': auth['user-a']!.csrf,
          origin: 'https://evil.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'X', websiteUrl: 'https://x.com', contactEmail: 'x@x.com' }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it('validates input with Zod', async () => {
    const res = await req('user-a', '/api/clients', {
      method: 'POST',
      body: { name: 'X', websiteUrl: 'javascript:alert(1)', contactEmail: 'nope' },
    });
    expect(res.status).toBe(400);
  });
});
