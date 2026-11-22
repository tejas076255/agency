// Keyword rank tracker routes. Tenant-scoped via clientScope() (members only see assigned clients).
import { Hono, type Context } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { trackedKeywords } from '../db/schema';
import { normalizeKeyword } from '../google/gsc';
import { describeError } from '../google/http';
import { checkClientKeywords, keywordOverview, keywordReadiness } from '../jobs/keywords';
import { auditRequest } from '../lib/audit';
import { getDb } from '../lib/db';
import { getPlanUsage } from '../lib/plans';
import { rateLimit } from '../lib/rate-limit';
import { readJson } from '../lib/validate';
import { requireAgency } from '../middleware/auth';
import type { AppEnv } from '../types';
import { clientScope } from './clients';

export const keywordRoutes = new Hono<AppEnv>();
keywordRoutes.use('*', requireAgency);

async function loadClient(c: Context<AppEnv>) {
  return getDb(c.env).query.clients.findFirst({ where: clientScope(c, c.req.param('id')) });
}

const keywordSchema = z
  .string()
  .transform(normalizeKeyword)
  .pipe(z.string().min(2, 'Keyword is too short').max(120, 'Keyword is too long'));

keywordRoutes.get('/:id/keywords', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const { limits } = await getPlanUsage(c.env, c.get('agencyId'));
  return c.json({
    ...(await keywordOverview(c.env, c.get('agencyId'), client)),
    limit: limits.maxKeywordsPerClient,
  });
});

/** Adds keywords and immediately loads their last 13 weeks from Search Console (if connected). */
keywordRoutes.post(
  '/:id/keywords',
  rateLimit({ name: 'keywords-add', limit: 20, windowSeconds: 60 }),
  async (c) => {
    const client = await loadClient(c);
    if (!client) return c.json({ error: 'Client not found' }, 404);
    const agencyId = c.get('agencyId');
    const input = await readJson(c, z.object({ keywords: z.array(keywordSchema).min(1).max(50) }));
    const wanted = [...new Set(input.keywords)];
    const db = getDb(c.env);

    const existing = await db
      .select({ keyword: trackedKeywords.keyword })
      .from(trackedKeywords)
      .where(and(eq(trackedKeywords.agencyId, agencyId), eq(trackedKeywords.clientId, client.id)));
    const have = new Set(existing.map((e) => e.keyword));
    const fresh = wanted.filter((k) => !have.has(k));
    const { limits } = await getPlanUsage(c.env, agencyId);
    if (existing.length + fresh.length > limits.maxKeywordsPerClient) {
      return c.json(
        {
          error: `Your ${limits.name} plan allows ${limits.maxKeywordsPerClient} keywords per client (${existing.length} already tracked).`,
        },
        402,
      );
    }
    if (fresh.length === 0) return c.json({ added: 0, checked: 0, warning: null });

    const now = Date.now();
    const rows = fresh.map((keyword) => ({
      id: crypto.randomUUID(),
      agencyId,
      clientId: client.id,
      keyword,
      createdAt: now,
    }));
    await db.insert(trackedKeywords).values(rows).onConflictDoNothing();
    await auditRequest(c, 'keyword.add', {
      targetType: 'client',
      targetId: client.id,
      metadata: { count: rows.length },
    });

    // Load history right away so the agency sees the graph without waiting for Monday.
    let warning: string | null = await keywordReadiness(c.env, agencyId, client);
    let checked = 0;
    if (!warning) {
      try {
        const r = await checkClientKeywords(c.env, agencyId, client, {
          keywordIds: rows.map((r) => r.id),
        });
        checked = r.checked;
        if (r.failed.length)
          warning = `${r.failed.length} keyword(s) failed: ${r.failed[0]!.error}`;
      } catch (err) {
        warning = describeError(err);
      }
    }
    return c.json({ added: rows.length, checked, warning }, 201);
  },
);

keywordRoutes.delete('/:id/keywords/:keywordId', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  await getDb(c.env)
    .delete(trackedKeywords)
    .where(
      and(
        eq(trackedKeywords.id, c.req.param('keywordId')),
        eq(trackedKeywords.clientId, client.id),
        eq(trackedKeywords.agencyId, c.get('agencyId')),
      ),
    );
  await auditRequest(c, 'keyword.remove', { targetType: 'client', targetId: client.id });
  return c.json({ ok: true });
});

/** Re-checks every tracked keyword now (the weekly health check also does this). */
keywordRoutes.post(
  '/:id/keywords/check',
  rateLimit({ name: 'keywords-check', limit: 6, windowSeconds: 60 }),
  async (c) => {
    const client = await loadClient(c);
    if (!client) return c.json({ error: 'Client not found' }, 404);
    const agencyId = c.get('agencyId');
    const count = await getDb(c.env)
      .select({ n: sql<number>`count(*)` })
      .from(trackedKeywords)
      .where(and(eq(trackedKeywords.agencyId, agencyId), eq(trackedKeywords.clientId, client.id)));
    if ((count[0]?.n ?? 0) === 0) return c.json({ error: 'Add a keyword first' }, 400);
    try {
      const r = await checkClientKeywords(c.env, agencyId, client);
      return c.json(r);
    } catch (err) {
      return c.json({ error: describeError(err) }, 400);
    }
  },
);
