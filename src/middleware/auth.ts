import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema';
import { getDb, type User } from '../lib/db';
import { timingSafeEqual } from '../lib/crypto';
import {
  clearSessionCookie,
  getSession,
  rotateSession,
  SESSION_COOKIE,
  setSessionCookie,
  shouldRotate,
} from '../lib/session';
import { withUsageTracking } from '../lib/usage';
import type { AppEnv } from '../types';

/**
 * Loads the session (if any) and the logged-in user into c.var. Never blocks.
 * Also: rejects sessions revoked by "log out everywhere" (version mismatch) and
 * rotates the session ID once it is older than 24 hours.
 */
export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('sessionId', null);
  c.set('session', null);
  c.set('user', null);
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) {
    let session = await getSession(c.env.KV, sid);
    if (session) {
      const user = await getDb(c.env).query.users.findFirst({
        where: eq(users.id, session.userId),
      });
      if (user && user.sessionVersion === session.version) {
        let activeId = sid;
        if (shouldRotate(session)) {
          const rotated = await rotateSession(c.env.KV, sid, session);
          activeId = rotated.id;
          session = rotated.data;
          setSessionCookie(c, activeId, session);
        }
        c.set('sessionId', activeId);
        c.set('session', session);
        c.set('user', user);
      } else {
        clearSessionCookie(c);
      }
    } else {
      clearSessionCookie(c);
    }
  }
  await next();
};

/** Counts Google/AI API calls made while handling this request (per agency, per day). */
export const trackApiUsage: MiddlewareHandler<AppEnv> = async (c, next) => {
  const agencyId = c.get('user')?.agencyId;
  if (!agencyId) return next();
  await withUsageTracking(c.env, agencyId, () => next());
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'Please sign in' }, 401);
  await next();
};

/** Requires a signed-in user who belongs to an agency. Sets c.var.agencyId for scoping. */
export const requireAgency: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Please sign in' }, 401);
  if (!user.agencyId) return c.json({ error: 'onboarding_required' }, 403);
  c.set('agencyId', user.agencyId);
  await next();
};

export const requireOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('user')?.role !== 'owner') {
    return c.json({ error: 'Only the agency owner can do this' }, 403);
  }
  await next();
};

/** Returns the signed-in user. Only call after requireAuth/requireAgency. */
export function currentUser(c: Context<AppEnv>): User {
  const user = c.get('user');
  if (!user) throw new Error('currentUser() called without requireAuth');
  return user;
}

/**
 * CSRF protection for state-changing requests:
 *  1. If the browser sends an Origin header, it must be our own origin.
 *  2. The X-CSRF-Token header must match the token stored in the session (synchronizer token).
 * Combined with SameSite=Lax cookies this blocks cross-site form/fetch attacks.
 */
export const csrfProtect: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.env.APP_URL).origin) {
    return c.json({ error: 'Cross-origin request blocked' }, 403);
  }
  const session = c.get('session');
  const token = c.req.header('x-csrf-token');
  if (!session || !token || !timingSafeEqual(token, session.csrfToken)) {
    return c.json({ error: 'Invalid or missing CSRF token. Please refresh the page.' }, 403);
  }
  await next();
};
