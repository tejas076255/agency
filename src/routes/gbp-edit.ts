// Business Profile editing + Google Posts routes. Tenant-scoped via clientScope(). Anyone with
// access to the client can create/edit drafts; only the agency OWNER can apply, undo, publish or
// schedule (those change the public Google listing).
import { Hono, type Context } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { gbpChanges, gbpPosts } from '../db/schema';
import { describeError } from '../google/http';
import {
  applyChange,
  createAiSuggestions,
  GbpEditError,
  generatePostDrafts,
  listChanges,
  loadAvailableAttributes,
  loadLiveProfile,
  parseAfter,
  postInputSchema,
  publishPost,
  refreshPendingChanges,
  removePost,
  undoChange,
} from '../jobs/gbp-edit';
import { AiUnavailableError } from '../lib/ai-tools';
import { auditRequest } from '../lib/audit';
import { getDb } from '../lib/db';
import { useAiQuota } from '../lib/plans';
import { rateLimit } from '../lib/rate-limit';
import { readJson } from '../lib/validate';
import { currentUser, requireAgency, requireOwner } from '../middleware/auth';
import type { AppEnv } from '../types';
import { clientScope } from './clients';

export const gbpEditRoutes = new Hono<AppEnv>();
gbpEditRoutes.use('*', requireAgency);

const kindSchema = z.enum([
  'description',
  'categories',
  'services',
  'hours',
  'attributes',
  'website',
]);
const languageSchema = z.enum(['en', 'hinglish', 'hi']).default('en');
const writeLimit = rateLimit({ name: 'gbp-write', limit: 10, windowSeconds: 60 });

async function loadClient(c: Context<AppEnv>) {
  return getDb(c.env).query.clients.findFirst({ where: clientScope(c, c.req.param('id')) });
}

function fail(c: Context<AppEnv>, err: unknown) {
  if (err instanceof GbpEditError) return c.json({ error: err.message }, err.status);
  if (err instanceof AiUnavailableError) return c.json({ error: err.message }, 503);
  return c.json({ error: describeError(err) }, 400);
}

export const toChange = (r: typeof gbpChanges.$inferSelect) => ({
  id: r.id,
  kind: r.kind,
  source: r.source,
  status: r.status,
  reason: r.reason,
  before: r.beforeJson ? JSON.parse(r.beforeJson) : null,
  after: JSON.parse(r.afterJson),
  error: r.error,
  appliedAt: r.appliedAt,
  revertsChangeId: r.revertsChangeId,
  createdAt: r.createdAt,
});

export const toPost = (p: typeof gbpPosts.$inferSelect) => ({
  id: p.id,
  summary: p.summary,
  actionType: p.actionType,
  actionUrl: p.actionUrl,
  source: p.source,
  status: p.status,
  scheduledFor: p.scheduledFor,
  searchUrl: p.searchUrl,
  error: p.error,
  publishedAt: p.publishedAt,
  createdAt: p.createdAt,
});

// ------------------------------------ profile ------------------------------------

/** Live profile from Google + change history + posts (one call for the editor page). */
gbpEditRoutes.get('/:id/gbp/editor', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const agencyId = c.get('agencyId');
  const db = getDb(c.env);
  const [changes, posts] = await Promise.all([
    listChanges(c.env, agencyId, client.id),
    db
      .select()
      .from(gbpPosts)
      .where(and(eq(gbpPosts.agencyId, agencyId), eq(gbpPosts.clientId, client.id)))
      .orderBy(desc(gbpPosts.createdAt))
      .limit(50),
  ]);
  let profile = null;
  let profileError: string | null = null;
  try {
    await refreshPendingChanges(c.env, agencyId, client).catch(() => 0);
    profile = (await loadLiveProfile(c.env, agencyId, client)).profile;
  } catch (err) {
    profileError = err instanceof GbpEditError ? err.message : describeError(err);
  }
  const fresh = profileError ? changes : await listChanges(c.env, agencyId, client.id);
  return c.json({
    profile,
    profileError,
    changes: fresh.map(toChange),
    posts: posts.filter((p) => p.status !== 'deleted').map(toPost),
    canApply: currentUser(c).role === 'owner',
  });
});

gbpEditRoutes.get('/:id/gbp/attributes', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  try {
    return c.json({ attributes: await loadAvailableAttributes(c.env, c.get('agencyId'), client) });
  } catch (err) {
    return fail(c, err);
  }
});

gbpEditRoutes.post(
  '/:id/gbp/suggestions',
  rateLimit({ name: 'gbp-suggest', limit: 5, windowSeconds: 60 }),
  async (c) => {
    const client = await loadClient(c);
    if (!client) return c.json({ error: 'Client not found' }, 404);
    const input = await readJson(
      c,
      z.object({ language: languageSchema, notes: z.string().trim().max(1500).optional() }),
    );
    await useAiQuota(c.env, c.get('agencyId'));
    try {
      const r = await createAiSuggestions(
        c.env,
        c.get('agencyId'),
        client,
        currentUser(c).id,
        input,
      );
      return c.json({ drafts: r.drafts.map(toChange), notes: r.notes });
    } catch (err) {
      return fail(c, err);
    }
  },
);

/** Manual draft (e.g. opening hours typed by the agency). */
gbpEditRoutes.post('/:id/gbp/changes', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  if (!client.gbpLocationName)
    return c.json({ error: 'Select the Business Profile location first' }, 400);
  const input = await readJson(c, z.object({ kind: kindSchema, after: z.unknown() }));
  try {
    const after = parseAfter(input.kind, input.after);
    const id = crypto.randomUUID();
    await getDb(c.env)
      .insert(gbpChanges)
      .values({
        id,
        agencyId: c.get('agencyId'),
        clientId: client.id,
        locationName: client.gbpLocationName,
        kind: input.kind,
        source: 'manual',
        status: 'draft',
        afterJson: JSON.stringify(after),
        createdByUserId: currentUser(c).id,
        createdAt: Date.now(),
      });
    await auditRequest(c, 'gbp.change_create', {
      targetType: 'client',
      targetId: client.id,
      metadata: { kind: input.kind },
    });
    return c.json({ id }, 201);
  } catch (err) {
    return fail(c, err);
  }
});

/** Edit a draft before approving it. */
gbpEditRoutes.patch('/:id/gbp/changes/:changeId', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const db = getDb(c.env);
  const row = await db.query.gbpChanges.findFirst({
    where: and(
      eq(gbpChanges.id, c.req.param('changeId')),
      eq(gbpChanges.agencyId, c.get('agencyId')),
      eq(gbpChanges.clientId, client.id),
    ),
  });
  if (!row) return c.json({ error: 'Change not found' }, 404);
  if (row.status !== 'draft' && row.status !== 'failed')
    return c.json({ error: 'Only drafts can be edited' }, 409);
  const { after } = await readJson(c, z.object({ after: z.unknown() }));
  try {
    const parsed = parseAfter(row.kind, after);
    await db
      .update(gbpChanges)
      .set({ afterJson: JSON.stringify(parsed), status: 'draft', error: null })
      .where(and(eq(gbpChanges.id, row.id), eq(gbpChanges.agencyId, c.get('agencyId'))));
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});

gbpEditRoutes.post('/:id/gbp/changes/:changeId/apply', requireOwner, writeLimit, async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  try {
    const r = await applyChange(
      c.env,
      c.get('agencyId'),
      client,
      c.req.param('changeId'),
      currentUser(c).id,
    );
    return c.json({ status: r.status, error: r.error });
  } catch (err) {
    return fail(c, err);
  }
});

gbpEditRoutes.post('/:id/gbp/changes/:changeId/undo', requireOwner, writeLimit, async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  try {
    const r = await undoChange(
      c.env,
      c.get('agencyId'),
      client,
      c.req.param('changeId'),
      currentUser(c).id,
    );
    return c.json({ status: r.status, error: r.error });
  } catch (err) {
    return fail(c, err);
  }
});

gbpEditRoutes.post('/:id/gbp/changes/:changeId/reject', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const db = getDb(c.env);
  const done = await db
    .update(gbpChanges)
    .set({ status: 'rejected' })
    .where(
      and(
        eq(gbpChanges.id, c.req.param('changeId')),
        eq(gbpChanges.agencyId, c.get('agencyId')),
        eq(gbpChanges.clientId, client.id),
        eq(gbpChanges.status, 'draft'),
      ),
    )
    .returning({ id: gbpChanges.id });
  if (!done.length) return c.json({ error: 'Draft not found' }, 404);
  await auditRequest(c, 'gbp.change_reject', { targetType: 'client', targetId: client.id });
  return c.json({ ok: true });
});

// ------------------------------------ posts ------------------------------------

async function loadPost(c: Context<AppEnv>, clientId: string) {
  return getDb(c.env).query.gbpPosts.findFirst({
    where: and(
      eq(gbpPosts.id, c.req.param('postId')!),
      eq(gbpPosts.agencyId, c.get('agencyId')),
      eq(gbpPosts.clientId, clientId),
    ),
  });
}

gbpEditRoutes.post(
  '/:id/gbp/posts/generate',
  rateLimit({ name: 'gbp-posts-ai', limit: 6, windowSeconds: 60 }),
  async (c) => {
    const client = await loadClient(c);
    if (!client) return c.json({ error: 'Client not found' }, 404);
    const input = await readJson(
      c,
      z.object({
        topic: z.string().trim().min(3).max(200),
        language: languageSchema,
        notes: z.string().trim().max(1500).optional(),
      }),
    );
    await useAiQuota(c.env, c.get('agencyId'));
    try {
      const rows = await generatePostDrafts(
        c.env,
        c.get('agencyId'),
        client,
        currentUser(c).id,
        input,
      );
      return c.json({ posts: rows.map(toPost) }, 201);
    } catch (err) {
      return fail(c, err);
    }
  },
);

gbpEditRoutes.post('/:id/gbp/posts', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = postInputSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
  const id = crypto.randomUUID();
  await getDb(c.env)
    .insert(gbpPosts)
    .values({
      id,
      agencyId: c.get('agencyId'),
      clientId: client.id,
      ...parsed.data,
      source: 'manual',
      status: 'draft',
      createdByUserId: currentUser(c).id,
      createdAt: Date.now(),
    });
  return c.json({ id }, 201);
});

gbpEditRoutes.patch('/:id/gbp/posts/:postId', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const post = await loadPost(c, client.id);
  if (!post) return c.json({ error: 'Post not found' }, 404);
  if (!['draft', 'failed', 'scheduled'].includes(post.status))
    return c.json({ error: 'Published posts cannot be edited' }, 409);
  const body = await c.req.json().catch(() => null);
  const parsed = postInputSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
  await getDb(c.env)
    .update(gbpPosts)
    .set({ ...parsed.data, error: null, status: post.status === 'failed' ? 'draft' : post.status })
    .where(and(eq(gbpPosts.id, post.id), eq(gbpPosts.agencyId, c.get('agencyId'))));
  return c.json({ ok: true });
});

gbpEditRoutes.post('/:id/gbp/posts/:postId/publish', requireOwner, writeLimit, async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const post = await loadPost(c, client.id);
  if (!post) return c.json({ error: 'Post not found' }, 404);
  try {
    const r = await publishPost(c.env, post, client, currentUser(c).id);
    return c.json({ status: r.status, error: r.error, searchUrl: r.searchUrl });
  } catch (err) {
    return fail(c, err);
  }
});

gbpEditRoutes.post('/:id/gbp/posts/:postId/schedule', requireOwner, async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const post = await loadPost(c, client.id);
  if (!post) return c.json({ error: 'Post not found' }, 404);
  const { scheduledFor } = await readJson(
    c,
    z.object({ scheduledFor: z.number().int().nullable() }),
  );
  if (!['draft', 'failed', 'scheduled'].includes(post.status))
    return c.json({ error: 'This post is already published' }, 409);
  if (
    scheduledFor !== null &&
    (scheduledFor < Date.now() - 60_000 || scheduledFor > Date.now() + 180 * 86_400_000)
  ) {
    return c.json({ error: 'Pick a time in the next 6 months' }, 400);
  }
  const parsed = postInputSchema.safeParse({
    summary: post.summary,
    actionType: post.actionType,
    actionUrl: post.actionUrl,
  });
  if (!parsed.success)
    return c.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, 400);
  await getDb(c.env)
    .update(gbpPosts)
    .set({
      scheduledFor,
      status: scheduledFor === null ? 'draft' : 'scheduled',
      approvedByUserId: currentUser(c).id,
      error: null,
    })
    .where(and(eq(gbpPosts.id, post.id), eq(gbpPosts.agencyId, c.get('agencyId'))));
  await auditRequest(c, 'gbp.post_schedule', {
    targetType: 'client',
    targetId: client.id,
    metadata: { postId: post.id, scheduledFor },
  });
  return c.json({ ok: true });
});

gbpEditRoutes.delete('/:id/gbp/posts/:postId', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const post = await loadPost(c, client.id);
  if (!post) return c.json({ error: 'Post not found' }, 404);
  if (post.status === 'published' && currentUser(c).role !== 'owner') {
    return c.json({ error: 'Only the owner can delete a published post from Google' }, 403);
  }
  try {
    await removePost(c.env, post, client);
    await auditRequest(c, 'gbp.post_delete', {
      targetType: 'client',
      targetId: client.id,
      metadata: { postId: post.id },
    });
    return c.json({ ok: true });
  } catch (err) {
    return fail(c, err);
  }
});
