// Regression tests for the Business Profile 401 incident (22 Nov 2026):
// - disconnecting one product must not revoke the shared Google grant used by other products
// - a rejected (401) cached access token is refreshed once; a revoked grant shows "Reconnect needed"
// - failed snapshots never expose their debug details as "data" (that crashed the Local SEO page)
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { GoogleApiError, ReconnectNeededError, retryConfig } from '../src/google/http';
import {
  deleteConnection,
  getConnection,
  saveConnection,
  withAccessToken,
} from '../src/google/tokens';
import { latestSnapshot } from '../src/jobs/integrations';
import { createTestEnv } from './helpers';

let env: Env;
let dispose: () => Promise<void>;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  retryConfig.baseDelayMs = 1;
  const t = await createTestEnv();
  env = t.env;
  dispose = t.dispose;
  await env.DB.prepare(
    `INSERT INTO agencies (id,name,brand_color,plan,created_at) VALUES ('ag','Ag','#000000','free',0)`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO users (id,agency_id,email,name,role,google_sub,created_at) VALUES ('u1','ag','o@x.com','O','owner','s',0)`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO clients (id,agency_id,name,website_url,contact_email,status,auto_send_report,created_at,updated_at)
     VALUES ('c1','ag','C','https://c.com','c@c.com','active',0,0,0)`,
  ).run();
}, 60_000);

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await dispose?.();
});

async function connect(purpose: 'client_data' | 'client_business', email: string) {
  return saveConnection(env, {
    agencyId: 'ag',
    clientId: 'c1',
    purpose,
    googleEmail: email,
    scopes: 'openid email',
    refreshToken: `refresh-${purpose}`,
    userId: 'u1',
  });
}

describe('disconnect and the shared Google grant', () => {
  it('does NOT revoke at Google while another connection uses the same Google account', async () => {
    const revokes: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input).startsWith('https://oauth2.googleapis.com/revoke'))
        revokes.push(String(input));
      return json({});
    });
    const data = await connect('client_data', 'same@gmail.com');
    await connect('client_business', 'same@gmail.com');
    await deleteConnection(env, data);
    expect(revokes).toHaveLength(0);
    expect(await getConnection(env, 'ag', 'client_data', 'c1')).toBeUndefined();
    expect(await getConnection(env, 'ag', 'client_business', 'c1')).toBeDefined();
  });

  it('revokes at Google when it is the last connection for that Google account', async () => {
    const revokes: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input).startsWith('https://oauth2.googleapis.com/revoke'))
        revokes.push(String(input));
      return json({});
    });
    const business = (await getConnection(env, 'ag', 'client_business', 'c1'))!;
    await deleteConnection(env, business);
    expect(revokes).toHaveLength(1);
  });
});

describe('withAccessToken', () => {
  it('drops a rejected cached token, refreshes once and retries', async () => {
    const conn = await connect('client_business', 'retry@gmail.com');
    await env.KV.delete(`gat:${conn.id}`);
    let refreshes = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input).startsWith('https://oauth2.googleapis.com/token')) {
        refreshes++;
        return json({ access_token: `fresh-${refreshes}`, expires_in: 3600 });
      }
      return json({});
    });
    const seen: string[] = [];
    const result = await withAccessToken(env, conn, async (token) => {
      seen.push(token);
      if (seen.length === 1)
        throw new GoogleApiError(
          401,
          'UNAUTHENTICATED',
          'Request had invalid authentication credentials',
        );
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(seen).toEqual(['fresh-1', 'fresh-2']);
  });

  it('marks the connection revoked (Reconnect needed) when the grant was revoked', async () => {
    const conn = await connect('client_business', 'revoked@gmail.com');
    await env.KV.put(`gat:${conn.id}`, 'not-a-valid-ciphertext'); // forces a refresh
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input).startsWith('https://oauth2.googleapis.com/token')) {
        return json(
          { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
          400,
        );
      }
      return json({});
    });
    await expect(withAccessToken(env, conn, async () => 'never')).rejects.toBeInstanceOf(
      ReconnectNeededError,
    );
    const row = await env.DB.prepare(`SELECT status FROM google_connections WHERE id=?`)
      .bind(conn.id)
      .first<{ status: string }>();
    expect(row?.status).toBe('revoked');
    // Only the Search Console/GA4 connection may flip the client to "reconnect_needed".
    const client = await env.DB.prepare(`SELECT status FROM clients WHERE id='c1'`).first<{
      status: string;
    }>();
    expect(client?.status).toBe('active');
  });
});

describe('latestSnapshot', () => {
  it('returns failure details separately and no data for failed syncs', async () => {
    await env.DB.prepare(
      `INSERT INTO integration_snapshots (id,agency_id,client_id,source,run_at,status,data_json,error)
       VALUES ('s1','ag','c1','gbp',1,'failed',?, '401 UNAUTHENTICATED')`,
    )
      .bind(JSON.stringify({ failures: [{ call: 'reviews', status: 401 }] }))
      .run();
    const snap = await latestSnapshot(env, 'ag', 'c1', 'gbp');
    expect(snap?.data).toBeNull();
    expect(snap?.details).toEqual([{ call: 'reviews', status: 401 }]);
  });
});
