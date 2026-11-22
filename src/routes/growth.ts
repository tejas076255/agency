// "Grow" routes: one-click setup (single Google sign-in + auto-detect), Business Profile score
// scan, ready-made fixes and one-click Post / Post all. Tenant-scoped via clientScope().
import { Hono, type Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { gbpChanges, gbpPosts, reviews } from '../db/schema';
import { describeError } from '../google/http';
import { getConnection, SETUP_SCOPES } from '../google/tokens';
import { enqueueJobs, hasPendingJob } from '../jobs/queue';
import {
  getScanProgress,
  latestScan,
  listReadyFixes,
  previousScore,
  SCAN_STEPS,
} from '../jobs/profile-scan';
import { publishFixes } from '../jobs/publish-fixes';
import { chooseSources, detectSources } from '../jobs/setup';
import { auditRequest } from '../lib/audit';
import { getDb } from '../lib/db';
import { OAUTH_STATE_COOKIE, startGoogleOAuth } from '../lib/google-oauth';
import { useAiQuota } from '../lib/plans';
import { rateLimit } from '../lib/rate-limit';
import { readJson } from '../lib/validate';
import { currentUser, requireAgency, requireOwner } from '../middleware/auth';
import type { AppEnv } from '../types';
import { clientScope } from './clients';
import { toChange, toPost } from './gbp-edit';

export const growthRoutes = new Hono<AppEnv>();
growthRoutes.use('*', requireAgency);

async function loadClient(c: Context<AppEnv>) {
  return getDb(c.env).query.clients.findFirst({ where: clientScope(c, c.req.param('id')) });
}

// ------------------------------------ setup ------------------------------------

/** One Google sign-in for Search Console, GA4, Business Profile and YouTube. */
growthRoutes.post('/:id/setup/connect', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const { url, state } = await startGoogleOAuth(
    c.env,
    {
      purpose: 'connect_client',
      product: 'setup',
      userId: currentUser(c).id,
      agencyId: c.get('agencyId'),
      clientId: client.id,
    },
    SETUP_SCOPES,
    { offline: true },
  );
  setCookie(c, OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/auth',
    maxAge: 600,
  });
  return c.json({ url });
});

growthRoutes.get(
  '/:id/setup/detect',
  rateLimit({ name: 'setup-detect', limit: 10, windowSeconds: 60 }),
  async (c) => {
    const client = await loadClient(c);
    if (!client) return c.json({ error: 'Client not found' }, 404);
    try {
      return c.json(await detectSources(c.env, c.get('agencyId'), client));
    } catch (err) {
      return c.json({ error: describeError(err) }, 400);
    }
  },
);

growthRoutes.post('/:id/setup/choose', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const input = await readJson(
    c,
    z.object({
      gscSiteUrl: z.string().max(500).optional(),
      ga4PropertyId: z.string().regex(/^\d+$/).optional(),
      gbp: z
        .object({ accountName: z.string().max(200), locationName: z.string().max(200) })
        .optional(),
      youtubeChannelId: z.string().max(100).optional(),
    }),
  );
  try {
    await chooseSources(c.env, c.get('agencyId'), client, input);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  await auditRequest(c, 'client.sources_update', {
    targetType: 'client',
    targetId: client.id,
    metadata: { setup: true },
  });
  return c.json({ ok: true });
});

// ------------------------------------ score + fixes ------------------------------------

growthRoutes.post(
  '/:id/profile/scan',
  rateLimit({ name: 'profile-scan', limit: 4, windowSeconds: 60 }),
  async (c) => {
    const client = await loadClient(c);
    if (!client) return c.json({ error: 'Client not found' }, 404);
    const agencyId = c.get('agencyId');
    if (!client.gbpLocationName)
      return c.json({ error: 'Pick the Business Profile location first' }, 400);
    if (await hasPendingJob(c.env, agencyId, client.id, 'profile_scan')) {
      return c.json({ ok: true, alreadyRunning: true });
    }
    await useAiQuota(c.env, agencyId);
    const { setup } = await readJson(c, z.object({ setup: z.boolean().default(false) }));
    await c.env.KV.put(
      `scan:${client.id}`,
      JSON.stringify({
        step: 0,
        total: SCAN_STEPS.length,
        label: 'Starting…',
        startedAt: Date.now(),
        done: false,
        error: null,
      }),
      { expirationTtl: 3600 },
    );
    const [jobRunId] = await enqueueJobs(c.env, [
      {
        agencyId,
        clientId: client.id,
        type: 'profile_scan',
        trigger: setup ? 'setup' : 'manual',
        userId: currentUser(c).id,
      },
    ]);
    return c.json({ ok: true, jobRunId }, 202);
  },
);

/** Everything the Grow screen needs. */
growthRoutes.get('/:id/profile', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const agencyId = c.get('agencyId');
  const [scan, prev, progress, fixes, bizConn, dataConn] = await Promise.all([
    latestScan(c.env, agencyId, client.id),
    previousScore(c.env, agencyId, client.id),
    getScanProgress(c.env, client.id),
    listReadyFixes(c.env, agencyId, client.id),
    getConnection(c.env, agencyId, 'client_business', client.id),
    getConnection(c.env, agencyId, 'client_data', client.id),
  ]);
  return c.json({
    setup: {
      googleConnected: Boolean(dataConn || bizConn),
      businessConnected: Boolean(bizConn),
      locationSelected: Boolean(client.gbpLocationName),
      searchConsoleSelected: Boolean(client.gscSiteUrl),
      analyticsSelected: Boolean(client.ga4PropertyId),
    },
    scan,
    previousScore: prev,
    scanning: Boolean(progress && !progress.done),
    progress,
    steps: SCAN_STEPS,
    fixes: {
      changes: fixes.changes.map(toChange),
      posts: fixes.posts.map(toPost),
      reviews: fixes.reviews.map((r) => ({
        id: r.id,
        reviewerName: r.reviewerName,
        starRating: r.starRating,
        comment: r.comment,
        reviewCreatedAt: r.reviewCreatedAt,
        draft: r.aiDraftReply,
      })),
    },
    canPublish: currentUser(c).role === 'owner',
  });
});

const fixRef = z.object({
  type: z.enum(['change', 'post', 'review']),
  id: z.string().min(1).max(100),
});

growthRoutes.post(
  '/:id/profile/publish',
  requireOwner,
  rateLimit({ name: 'profile-publish', limit: 10, windowSeconds: 60 }),
  async (c) => {
    const client = await loadClient(c);
    if (!client) return c.json({ error: 'Client not found' }, 404);
    const { items, all } = await readJson(
      c,
      z.object({ items: z.array(fixRef).min(1).max(40), all: z.boolean().default(false) }),
    );
    const r = await publishFixes(c.env, c.get('agencyId'), client, currentUser(c).id, items, {
      spreadPosts: all,
    });
    return c.json(r);
  },
);

/** "Not now": drop a ready fix. */
growthRoutes.post('/:id/profile/dismiss', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const agencyId = c.get('agencyId');
  const ref = await readJson(c, fixRef);
  const db = getDb(c.env);
  if (ref.type === 'change') {
    await db
      .update(gbpChanges)
      .set({ status: 'rejected' })
      .where(
        and(
          eq(gbpChanges.id, ref.id),
          eq(gbpChanges.agencyId, agencyId),
          eq(gbpChanges.clientId, client.id),
          eq(gbpChanges.status, 'draft'),
        ),
      );
  } else if (ref.type === 'post') {
    await db
      .delete(gbpPosts)
      .where(
        and(
          eq(gbpPosts.id, ref.id),
          eq(gbpPosts.agencyId, agencyId),
          eq(gbpPosts.clientId, client.id),
          eq(gbpPosts.status, 'draft'),
        ),
      );
  } else {
    await db
      .update(reviews)
      .set({ aiDraftReply: null })
      .where(
        and(
          eq(reviews.id, ref.id),
          eq(reviews.agencyId, agencyId),
          eq(reviews.clientId, client.id),
        ),
      );
  }
  return c.json({ ok: true });
});

growthRoutes.patch('/:id/profile/review-drafts/:reviewId', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const { text } = await readJson(c, z.object({ text: z.string().trim().min(2).max(4000) }));
  const done = await getDb(c.env)
    .update(reviews)
    .set({ aiDraftReply: text })
    .where(
      and(
        eq(reviews.id, c.req.param('reviewId')),
        eq(reviews.agencyId, c.get('agencyId')),
        eq(reviews.clientId, client.id),
        isNull(reviews.replyComment),
      ),
    )
    .returning({ id: reviews.id });
  if (!done.length) return c.json({ error: 'Review not found' }, 404);
  return c.json({ ok: true });
});
