import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { randomToken } from './crypto';

export const SESSION_COOKIE = 'sid';
/** Absolute lifetime: a session can never live longer than this, even with rotation. */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The session ID is replaced with a fresh one at most this often (limits stolen-cookie value). */
export const SESSION_ROTATE_AFTER_MS = 24 * 60 * 60 * 1000;
/** After rotation the old ID keeps working briefly so parallel in-flight requests don't fail. */
const OLD_SESSION_GRACE_SECONDS = 60;

const sessionSchema = z.object({
  userId: z.string(),
  csrfToken: z.string(),
  createdAt: z.number(),
  rotatedAt: z.number().optional(),
  /** Must equal users.session_version, otherwise the session was revoked by "log out everywhere". */
  version: z.number().default(0),
});
export type SessionData = z.infer<typeof sessionSchema>;

const kvKey = (id: string) => `session:${id}`;

function remainingSeconds(data: SessionData, now: number): number {
  return Math.ceil((data.createdAt + SESSION_MAX_AGE_MS - now) / 1000);
}

async function store(kv: KVNamespace, id: string, data: SessionData, now: number) {
  // KV requires a TTL of at least 60 seconds.
  await kv.put(kvKey(id), JSON.stringify(data), {
    expirationTtl: Math.max(60, remainingSeconds(data, now)),
  });
}

export async function createSession(
  kv: KVNamespace,
  userId: string,
  version = 0,
  now = Date.now(),
) {
  const id = randomToken(32);
  const data: SessionData = {
    userId,
    csrfToken: randomToken(32),
    createdAt: now,
    rotatedAt: now,
    version,
  };
  await store(kv, id, data, now);
  return { id, data };
}

export async function getSession(
  kv: KVNamespace,
  id: string,
  now = Date.now(),
): Promise<SessionData | null> {
  // Session IDs we issue are 43 chars of base64url; reject anything else early.
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  const raw = await kv.get(kvKey(id));
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = sessionSchema.safeParse(json);
  if (!parsed.success) return null;
  // Absolute expiry is enforced here too (not only by the KV TTL).
  if (now - parsed.data.createdAt > SESSION_MAX_AGE_MS) return null;
  return parsed.data;
}

export function shouldRotate(data: SessionData, now = Date.now()): boolean {
  return now - (data.rotatedAt ?? data.createdAt) > SESSION_ROTATE_AFTER_MS;
}

/**
 * Issues a new session ID with the same data (same CSRF token so open tabs keep working,
 * same createdAt so the absolute lifetime doesn't grow). The old ID expires after a short grace.
 */
export async function rotateSession(
  kv: KVNamespace,
  oldId: string,
  data: SessionData,
  now = Date.now(),
): Promise<{ id: string; data: SessionData }> {
  const id = randomToken(32);
  const next: SessionData = { ...data, rotatedAt: now };
  await store(kv, id, next, now);
  await kv.put(kvKey(oldId), JSON.stringify(data), { expirationTtl: OLD_SESSION_GRACE_SECONDS });
  return { id, data: next };
}

export async function destroySession(kv: KVNamespace, id: string) {
  await kv.delete(kvKey(id));
}

export function setSessionCookie(c: Context, id: string, data?: SessionData) {
  const maxAge = data
    ? Math.max(60, remainingSeconds(data, Date.now()))
    : SESSION_MAX_AGE_MS / 1000;
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    secure: true, // browsers allow Secure cookies on http://localhost too
    sameSite: 'Lax',
    path: '/',
    maxAge,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
}
