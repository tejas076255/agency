import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types';

/**
 * Simple fixed-window rate limit per client IP, stored in KV.
 * KV is eventually consistent, so this is a soft limit (good enough to stop brute force/abuse
 * on auth routes, not an exact counter).
 */
export function rateLimit(opts: {
  name: string;
  limit: number;
  windowSeconds: number;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ip = c.req.header('cf-connecting-ip') ?? 'local';
    const window = Math.floor(Date.now() / 1000 / opts.windowSeconds);
    const key = `rl:${opts.name}:${ip}:${window}`;
    const count = Number((await c.env.KV.get(key)) ?? '0');
    if (count >= opts.limit) {
      return c.json({ error: 'Too many requests. Please wait a minute and try again.' }, 429);
    }
    await c.env.KV.put(key, String(count + 1), {
      expirationTtl: Math.max(60, opts.windowSeconds * 2),
    });
    await next();
  };
}
