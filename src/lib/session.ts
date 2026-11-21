import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { randomToken } from './crypto';

export const SESSION_COOKIE = 'sid';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

const sessionSchema = z.object({
  userId: z.string(),
  csrfToken: z.string(),
  createdAt: z.number(),
});
export type SessionData = z.infer<typeof sessionSchema>;

const kvKey = (id: string) => `session:${id}`;

export async function createSession(kv: KVNamespace, userId: string) {
  const id = randomToken(32);
  const data: SessionData = { userId, csrfToken: randomToken(32), createdAt: Date.now() };
  await kv.put(kvKey(id), JSON.stringify(data), { expirationTtl: SESSION_TTL_SECONDS });
  return { id, data };
}

export async function getSession(kv: KVNamespace, id: string): Promise<SessionData | null> {
  // Session IDs we issue are 43 chars of base64url; reject anything else early.
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  const raw = await kv.get(kvKey(id));
  if (!raw) return null;
  const parsed = sessionSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export async function destroySession(kv: KVNamespace, id: string) {
  await kv.delete(kvKey(id));
}

export function setSessionCookie(c: Context, id: string) {
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    secure: true, // browsers allow Secure cookies on http://localhost too
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
}
