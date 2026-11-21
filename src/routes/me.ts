import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { agencies, files } from '../db/schema';
import { base64ToBytes } from '../lib/crypto';
import { getDb } from '../lib/db';
import type { AppEnv } from '../types';
import { agencyDto } from './agency';

export const meRoutes = new Hono<AppEnv>();

/** Public config the frontend needs before login. */
meRoutes.get('/config', (c) => c.json({ turnstileSiteKey: c.env.TURNSTILE_SITE_KEY }));

/** Who am I? Returns user + agency + CSRF token, or { user: null } when signed out. */
meRoutes.get('/me', async (c) => {
  const user = c.get('user');
  const session = c.get('session');
  if (!user || !session) return c.json({ user: null, agency: null, csrfToken: null });

  const agency = user.agencyId
    ? await getDb(c.env).query.agencies.findFirst({ where: eq(agencies.id, user.agencyId) })
    : undefined;
  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      pictureUrl: user.pictureUrl,
      role: user.role,
    },
    agency: agency ? agencyDto(agency) : null,
    csrfToken: session.csrfToken,
  });
});

/**
 * Agency logos are public (they appear in emailed reports and Google Slides needs a public URL).
 * File IDs are random UUIDs, so they can't be guessed or listed.
 */
meRoutes.get('/public/logo/:id', async (c) => {
  const id = c.req.param('id');
  if (!/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: 'Not found' }, 404);
  const file = await getDb(c.env).query.files.findFirst({
    where: and(eq(files.id, id), eq(files.kind, 'logo')),
  });
  if (!file) return c.json({ error: 'Not found' }, 404);
  return new Response(base64ToBytes(file.dataBase64), {
    headers: {
      'Content-Type': file.contentType,
      'Cache-Control': 'public, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
