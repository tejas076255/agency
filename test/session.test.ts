// Sessions, rotation, logout, logout-all and OAuth state — on a real local KV + D1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { consumeOAuthState, startGoogleOAuth } from '../src/lib/google-oauth';
import {
  createSession,
  getSession,
  rotateSession,
  SESSION_MAX_AGE_MS,
  shouldRotate,
} from '../src/lib/session';
import { createTestEnv } from './helpers';

let env: Env;
let dispose: () => Promise<void>;
const HOUR = 60 * 60 * 1000;

beforeAll(async () => {
  const t = await createTestEnv();
  env = t.env;
  dispose = t.dispose;
  await env.DB.prepare(
    `INSERT INTO agencies (id,name,brand_color,plan,created_at) VALUES ('ag','Ag','#000000','free',0)`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO users (id,agency_id,email,name,role,google_sub,created_at) VALUES ('u1','ag','u@x.com','U','owner','s1',0)`,
  ).run();
}, 60_000);

afterAll(async () => {
  await dispose?.();
});

const me = async (cookie: string) => {
  const res = await app.request('http://localhost/api/me', { headers: { cookie } }, env);
  return { res, body: (await res.json()) as { user: { id: string } | null } };
};

const post = (path: string, cookie: string, csrf: string) =>
  app.request(
    `http://localhost${path}`,
    { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, origin: 'http://localhost:5173' } },
    env,
  );

describe('session store', () => {
  it('creates and reads a session', async () => {
    const s = await createSession(env.KV, 'u1');
    expect(s.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await getSession(env.KV, s.id))?.userId).toBe('u1');
  });

  it('expires after the absolute lifetime (7 days), even if KV still had it', async () => {
    const now = Date.now();
    const s = await createSession(env.KV, 'u1', 0, now);
    expect(await getSession(env.KV, s.id, now + SESSION_MAX_AGE_MS - 1000)).not.toBeNull();
    expect(await getSession(env.KV, s.id, now + SESSION_MAX_AGE_MS + 1000)).toBeNull();
  });

  it('rejects malformed IDs and corrupted data', async () => {
    expect(await getSession(env.KV, 'short')).toBeNull();
    const id = 'a'.repeat(43);
    await env.KV.put(`session:${id}`, '{not json');
    expect(await getSession(env.KV, id)).toBeNull();
  });

  it('rotates after 24h: new id, same CSRF token and creation time, old id briefly valid', async () => {
    const created = Date.now() - 25 * HOUR;
    const s = await createSession(env.KV, 'u1', 0, created);
    expect(shouldRotate(s.data, created + 23 * HOUR)).toBe(false);
    expect(shouldRotate(s.data)).toBe(true);
    const r = await rotateSession(env.KV, s.id, s.data);
    expect(r.id).not.toBe(s.id);
    expect(r.data.csrfToken).toBe(s.data.csrfToken);
    expect(r.data.createdAt).toBe(created);
    expect(await getSession(env.KV, r.id)).not.toBeNull();
    expect(await getSession(env.KV, s.id)).not.toBeNull(); // grace period
  });
});

describe('session lifecycle through the API', () => {
  it('rotates an old session on a normal request (new Set-Cookie)', async () => {
    const s = await createSession(env.KV, 'u1', 0, Date.now() - 25 * HOUR);
    const { res, body } = await me(`sid=${s.id}`);
    expect(body.user?.id).toBe('u1');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/sid=/);
    expect(setCookie).not.toContain(s.id);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Secure/i);
  });

  it('logout invalidates the session', async () => {
    const s = await createSession(env.KV, 'u1');
    expect((await me(`sid=${s.id}`)).body.user).not.toBeNull();
    const res = await post('/auth/logout', `sid=${s.id}`, s.data.csrfToken);
    expect(res.status).toBe(200);
    expect((await me(`sid=${s.id}`)).body.user).toBeNull();
  });

  it('logout requires the CSRF token', async () => {
    const s = await createSession(env.KV, 'u1');
    const res = await post('/auth/logout', `sid=${s.id}`, 'wrong');
    expect(res.status).toBe(403);
    expect((await me(`sid=${s.id}`)).body.user).not.toBeNull();
  });

  it('"log out of all devices" kills every session of the user and is audited', async () => {
    const a = await createSession(env.KV, 'u1');
    const b = await createSession(env.KV, 'u1');
    const res = await post('/auth/logout-all', `sid=${a.id}`, a.data.csrfToken);
    expect(res.status).toBe(200);
    expect((await me(`sid=${a.id}`)).body.user).toBeNull();
    expect((await me(`sid=${b.id}`)).body.user).toBeNull();
    // New sessions (after a fresh login) use the new version and work again.
    const v = await env.DB.prepare(`SELECT session_version AS v FROM users WHERE id='u1'`).first<{ v: number }>();
    const fresh = await createSession(env.KV, 'u1', v!.v);
    expect((await me(`sid=${fresh.id}`)).body.user?.id).toBe('u1');
    const log = await env.DB.prepare(`SELECT action FROM audit_logs WHERE action='auth.logout_all'`).first();
    expect(log).not.toBeNull();
  });
});

describe('OAuth state + PKCE', () => {
  it('builds a Google URL with S256 PKCE, state and nonce, and the state is single-use', async () => {
    const { url, state } = await startGoogleOAuth(env, { purpose: 'login' }, ['openid', 'email']);
    const u = new URL(url);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('state')).toBe(state);
    expect(u.searchParams.get('nonce')).toBeTruthy();
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:5173/auth/google/callback');
    const saved = await consumeOAuthState(env.KV, state);
    expect(saved?.verifier).toHaveLength(64);
    expect(await consumeOAuthState(env.KV, state)).toBeNull(); // replay blocked
  });

  it('callback rejects a state that does not match this browser’s cookie', async () => {
    const { state } = await startGoogleOAuth(env, { purpose: 'login' }, ['openid']);
    const res = await app.request(
      `http://localhost/auth/google/callback?code=abc&state=${state}`,
      { headers: { cookie: 'oauth_state=someone-elses-state' } },
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/login?error=invalid_state');
  });
});
