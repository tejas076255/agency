import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { and, eq, sql } from 'drizzle-orm';
import { clients, users } from '../db/schema';
import { saveConnection, SCOPE } from '../google/tokens';
import { audit, auditRequest } from '../lib/audit';
import { getDb } from '../lib/db';
import { log } from '../lib/log';
import {
  consumeOAuthState,
  exchangeCodeForTokens,
  GoogleOAuthError,
  LOGIN_SCOPES,
  OAUTH_STATE_COOKIE,
  parseIdToken,
  startGoogleOAuth,
  type OAuthState,
} from '../lib/google-oauth';
import { rateLimit } from '../lib/rate-limit';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  setSessionCookie,
} from '../lib/session';
import { verifyTurnstile } from '../lib/turnstile';
import { csrfProtect } from '../middleware/auth';
import type { AppEnv } from '../types';

export const authRoutes = new Hono<AppEnv>();

const authLimit = rateLimit({ name: 'auth', limit: 20, windowSeconds: 60 });

const loginError = (c: Context<AppEnv>, code: string) => c.redirect(`/login?error=${code}`, 302);

/**
 * Step 1 of login: the login page POSTs a form with the Turnstile token.
 * We verify it, then redirect the browser to Google's consent screen.
 */
authRoutes.post('/google/login', authLimit, async (c) => {
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.env.APP_URL).origin) return loginError(c, 'bad_origin');

  const form = await c.req.parseBody();
  const token =
    typeof form['cf-turnstile-response'] === 'string' ? form['cf-turnstile-response'] : '';
  const ok = await verifyTurnstile(
    c.env.TURNSTILE_SECRET_KEY,
    token,
    c.req.header('cf-connecting-ip'),
  );
  if (!ok) return loginError(c, 'turnstile');

  const { url, state } = await startGoogleOAuth(c.env, { purpose: 'login' }, LOGIN_SCOPES);
  setCookie(c, OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax', // Lax cookies are sent on Google's top-level redirect back to us
    path: '/auth',
    maxAge: 600,
  });
  return c.redirect(url, 302);
});

/** Step 2: Google redirects back here (for login and, from Step 3, for "Connect Google"). */
authRoutes.get('/google/callback', authLimit, async (c) => {
  const { code, state, error } = c.req.query();
  const cookieState = getCookie(c, OAUTH_STATE_COOKIE);
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/auth', secure: true });

  if (error) return loginError(c, error === 'access_denied' ? 'google_denied' : 'google_error');
  // The state must match the cookie set in THIS browser (prevents login CSRF).
  if (!code || !state || !cookieState || cookieState !== state) {
    return loginError(c, 'invalid_state');
  }
  const saved = await consumeOAuthState(c.env.KV, state);
  if (!saved) return loginError(c, 'expired');

  if (saved.purpose === 'login') {
    try {
      return await completeLogin(c, code, saved);
    } catch (err) {
      log.error('OAuth login failed', err);
      const reason = err instanceof GoogleOAuthError ? err.code : 'server_error';
      return loginError(c, reason === 'email_not_verified' ? reason : 'google_error');
    }
  }
  return completeConnect(c, code, saved);
});

/** "Connect Google" for a client (Search Console + GA4) or for the agency (Slides/Drive/Gmail). */
async function completeConnect(c: Context<AppEnv>, code: string, saved: OAuthState) {
  const back = saved.purpose === 'connect_client' ? `/clients/${saved.clientId}` : '/settings';
  const fail = (reason: string) => c.redirect(`${back}?connect_error=${reason}`, 302);

  // The same signed-in user (and agency) that started the flow must finish it.
  const user = c.get('user');
  if (!user || user.id !== saved.userId || !saved.agencyId || user.agencyId !== saved.agencyId) {
    return loginError(c, 'invalid_state');
  }
  if (saved.purpose === 'connect_agency' && user.role !== 'owner') return fail('owner_only');

  try {
    const tokens = await exchangeCodeForTokens(c.env, code, saved.verifier);
    if (!tokens.refresh_token) return fail('no_refresh_token');
    const claims = tokens.id_token
      ? parseIdToken(tokens.id_token, { clientId: c.env.GOOGLE_CLIENT_ID, nonce: saved.nonce })
      : null;
    const granted = tokens.scope.split(' ');
    const db = getDb(c.env);

    if (saved.purpose === 'connect_client') {
      const client = await db.query.clients.findFirst({
        where: and(eq(clients.id, saved.clientId ?? ''), eq(clients.agencyId, saved.agencyId)),
      });
      if (!client) return c.redirect('/dashboard', 302);
      // Google lets users untick scopes; we need at least one data source.
      if (!granted.includes(SCOPE.gsc) && !granted.includes(SCOPE.ga4))
        return fail('missing_scopes');
      await saveConnection(c.env, {
        agencyId: saved.agencyId,
        clientId: client.id,
        purpose: 'client_data',
        googleEmail: claims?.email ?? 'unknown',
        scopes: tokens.scope,
        refreshToken: tokens.refresh_token,
        userId: user.id,
      });
      await db
        .update(clients)
        .set({ status: 'active', updatedAt: Date.now() })
        .where(and(eq(clients.id, client.id), eq(clients.agencyId, saved.agencyId)));
      await auditRequest(c, 'google.client_connect', {
        targetType: 'client',
        targetId: client.id,
        metadata: { googleEmail: claims?.email, scopes: tokens.scope },
      });
      return c.redirect(`/clients/${client.id}?connected=1`, 302);
    }

    // connect_agency
    if (![SCOPE.driveFile, SCOPE.slides, SCOPE.gmailSend].every((s) => granted.includes(s))) {
      return fail('missing_scopes');
    }
    await saveConnection(c.env, {
      agencyId: saved.agencyId,
      clientId: null,
      purpose: 'agency_workspace',
      googleEmail: claims?.email ?? 'unknown',
      scopes: tokens.scope,
      refreshToken: tokens.refresh_token,
      userId: user.id,
    });
    await auditRequest(c, 'google.workspace_connect', {
      targetType: 'agency',
      targetId: saved.agencyId,
      metadata: { googleEmail: claims?.email },
    });
    return c.redirect('/settings?connected=1', 302);
  } catch (err) {
    log.error('OAuth connect failed', err);
    return fail('google_error');
  }
}

async function completeLogin(c: Context<AppEnv>, code: string, saved: OAuthState) {
  const tokens = await exchangeCodeForTokens(c.env, code, saved.verifier);
  if (!tokens.id_token)
    throw new GoogleOAuthError('no_id_token', 'Google did not return an ID token');
  const claims = parseIdToken(tokens.id_token, {
    clientId: c.env.GOOGLE_CLIENT_ID,
    nonce: saved.nonce,
  });

  const db = getDb(c.env);
  const existing = await db.query.users.findFirst({ where: eq(users.googleSub, claims.sub) });
  let user: typeof existing;
  if (existing) {
    // Keep profile fresh.
    [user] = await db
      .update(users)
      .set({
        email: claims.email,
        name: claims.name ?? existing.name,
        pictureUrl: claims.picture ?? null,
      })
      .where(eq(users.id, existing.id))
      .returning();
  } else {
    [user] = await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        agencyId: null,
        email: claims.email,
        name: claims.name ?? claims.email.split('@')[0] ?? 'User',
        pictureUrl: claims.picture ?? null,
        role: 'owner',
        googleSub: claims.sub,
        createdAt: Date.now(),
      })
      .returning();
  }
  if (!user) throw new Error('Failed to save user');

  // Always issue a fresh session on login (prevents session fixation).
  const oldSid = c.get('sessionId');
  if (oldSid) await destroySession(c.env.KV, oldSid);
  const session = await createSession(c.env.KV, user.id, user.sessionVersion);
  setSessionCookie(c, session.id, session.data);
  await audit(c.env, {
    action: 'auth.login',
    agencyId: user.agencyId,
    userId: user.id,
    ip: c.req.header('cf-connecting-ip') ?? null,
  });

  return c.redirect(user.agencyId ? '/dashboard' : '/onboarding', 302);
}

authRoutes.post('/logout', csrfProtect, async (c) => {
  const sid = c.get('sessionId');
  if (c.get('user')) await auditRequest(c, 'auth.logout');
  if (sid) await destroySession(c.env.KV, sid);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

/** "Log out of all devices": bumps the user's session version so every existing session dies. */
authRoutes.post('/logout-all', csrfProtect, async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Please sign in' }, 401);
  await getDb(c.env)
    .update(users)
    .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
    .where(eq(users.id, user.id));
  await auditRequest(c, 'auth.logout_all');
  const sid = c.get('sessionId');
  if (sid) await destroySession(c.env.KV, sid);
  clearSessionCookie(c);
  return c.json({ ok: true });
});
