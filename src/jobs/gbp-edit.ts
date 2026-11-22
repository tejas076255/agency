// Business Profile editing: AI suggestions -> drafts -> human approval -> validate on Google ->
// apply -> status (live / Google reviewing) -> undo. Plus Google Posts: drafts, publish, schedule.
import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import { clients, gbpChanges, gbpPosts } from '../db/schema';
import type { Env } from '../env';
import {
  buildLocalPost,
  buildPatch,
  createLocalPost,
  DAYS,
  deleteLocalPost,
  getAttributes,
  getEditableLocation,
  listAvailableAttributes,
  patchAttributes,
  patchLocation,
  POST_ACTIONS,
  searchCategories,
  toEditableProfile,
  type ChangeKind,
  type EditableProfile,
  type PostAction,
  type RawEditableLocation,
} from '../google/business-edit';
import { describeError, GoogleApiError } from '../google/http';
import { getConnection, withAccessToken } from '../google/tokens';
import {
  descriptionProblem,
  generateContent,
  suggestGbpImprovements,
  type Language,
} from '../lib/ai-tools';
import { audit } from '../lib/audit';
import { getDb } from '../lib/db';
import { log } from '../lib/log';
import { buildClientContext } from './client-context';

type Client = typeof clients.$inferSelect;
type ChangeRow = typeof gbpChanges.$inferSelect;
type PostRow = typeof gbpPosts.$inferSelect;

export class GbpEditError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

// ---------------------------------- validation of "after" ----------------------------------

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Use HH:MM (24-hour)');
const categoryRef = z.object({
  name: z.string().regex(/^categories\/[\w:.-]+$/),
  displayName: z.string().max(120),
});

export const AFTER_SCHEMAS = {
  description: z.object({
    description: z
      .string()
      .trim()
      .superRefine((v, ctx) => {
        const p = descriptionProblem(v);
        if (p) ctx.addIssue({ code: 'custom', message: p });
      }),
  }),
  categories: z.object({ additionalCategories: z.array(categoryRef).max(9) }),
  services: z.object({
    services: z
      .array(
        z.object({
          label: z.string().trim().min(2).max(140),
          description: z.string().trim().max(300).default(''),
          category: z.string(),
          structured: z.boolean().optional(),
        }),
      )
      .max(100),
  }),
  hours: z.object({
    hours: z
      .array(z.object({ day: z.enum(DAYS), open: time, close: time }))
      .max(21)
      .refine(
        (h) => h.every((p) => p.close > p.open || p.close === '24:00'),
        'Closing time must be after opening time',
      ),
  }),
  attributes: z.object({
    attributes: z
      .array(z.object({ name: z.string().regex(/^attributes\/[\w.-]+$/), value: z.boolean() }))
      .min(1)
      .max(30),
  }),
} as const;

type After = { [K in ChangeKind]: z.infer<(typeof AFTER_SCHEMAS)[K]> };

export function parseAfter<K extends ChangeKind>(kind: K, value: unknown): After[K] {
  const r = AFTER_SCHEMAS[kind].safeParse(value);
  if (!r.success) throw new GbpEditError(r.error.issues.map((i) => i.message).join('; '));
  return r.data as After[K];
}

/** The part of the profile a change kind touches (stored as before/after). */
export function sliceOf(
  kind: ChangeKind,
  p: EditableProfile,
  attrNames?: string[],
): After[ChangeKind] {
  switch (kind) {
    case 'description':
      return { description: p.description };
    case 'categories':
      return { additionalCategories: p.additionalCategories };
    case 'services':
      return { services: p.services };
    case 'hours':
      return { hours: p.hours };
    case 'attributes':
      return {
        attributes: (attrNames ?? []).map((name) => ({
          name,
          value: p.attributes.find((a) => a.name === name)?.value ?? false,
        })),
      };
  }
}

// ---------------------------------- live profile ----------------------------------

async function businessConn(env: Env, agencyId: string, client: Client) {
  if (!client.gbpLocationName || !client.gbpAccountName) {
    throw new GbpEditError('Select the Business Profile location for this client first.');
  }
  const conn = await getConnection(env, agencyId, 'client_business', client.id);
  if (!conn) throw new GbpEditError('Connect Google Business Profile for this client first.');
  return conn;
}

export async function loadLiveProfile(env: Env, agencyId: string, client: Client) {
  const conn = await businessConn(env, agencyId, client);
  const location = client.gbpLocationName!;
  return withAccessToken(env, conn, async (token) => {
    const raw = await getEditableLocation(token, location);
    const attrs = await getAttributes(token, location).catch(() => []);
    return { raw, profile: toEditableProfile(raw, attrs) };
  });
}

export async function loadAvailableAttributes(env: Env, agencyId: string, client: Client) {
  const conn = await businessConn(env, agencyId, client);
  return withAccessToken(env, conn, (token) =>
    listAvailableAttributes(token, client.gbpLocationName!),
  );
}

// ---------------------------------- AI suggestions ----------------------------------

export async function createAiSuggestions(
  env: Env,
  agencyId: string,
  client: Client,
  userId: string,
  opts: { language: Language; notes?: string },
): Promise<{ drafts: ChangeRow[]; notes: string[] }> {
  const conn = await businessConn(env, agencyId, client);
  const { raw, profile } = await loadLiveProfile(env, agencyId, client);
  const available = await loadAvailableAttributes(env, agencyId, client).catch(() => []);
  const context = await buildClientContext(env, agencyId, client);
  const ai = await suggestGbpImprovements(env, {
    profile: {
      title: raw.title ?? null,
      description: profile.description,
      primaryCategory: profile.primaryCategory?.displayName ?? null,
      additionalCategories: profile.additionalCategories.map((c) => c.displayName),
      services: profile.services.map((s) => s.label),
      hoursSet: profile.hours.length > 0,
      attributesSet: profile.attributes.filter((a) => a.value).map((a) => a.name),
    },
    availableAttributes: available.map((a) => ({ name: a.name, displayName: a.displayName })),
    context,
    notes: opts.notes,
    language: opts.language,
  });

  const now = Date.now();
  const base = {
    agencyId,
    clientId: client.id,
    locationName: client.gbpLocationName!,
    source: 'ai' as const,
    status: 'draft' as const,
    createdByUserId: userId,
    createdAt: now,
  };
  const drafts: (typeof gbpChanges.$inferInsert)[] = [];

  if (ai.description && ai.description.text !== profile.description) {
    drafts.push({
      ...base,
      id: crypto.randomUUID(),
      kind: 'description',
      reason: ai.description.why,
      beforeJson: JSON.stringify(sliceOf('description', profile)),
      afterJson: JSON.stringify({ description: ai.description.text }),
    });
  }

  // Categories: only real Google categories (looked up), never the primary category.
  if (ai.categories.length) {
    const have = new Set([
      profile.primaryCategory?.name,
      ...profile.additionalCategories.map((c) => c.name),
    ]);
    const found: { name: string; displayName: string; why: string }[] = [];
    await withAccessToken(env, conn, async (token) => {
      for (const idea of ai.categories.slice(0, 3)) {
        const hits = await searchCategories(token, idea.name).catch(() => []);
        const hit = hits.find((h) => !have.has(h.name));
        if (hit) {
          have.add(hit.name);
          found.push({ ...hit, why: idea.why });
        }
      }
    });
    const additional = [
      ...profile.additionalCategories,
      ...found.map(({ name, displayName }) => ({ name, displayName })),
    ].slice(0, 9);
    if (found.length) {
      drafts.push({
        ...base,
        id: crypto.randomUUID(),
        kind: 'categories',
        reason: found.map((f) => `${f.displayName}: ${f.why}`).join(' · '),
        beforeJson: JSON.stringify(sliceOf('categories', profile)),
        afterJson: JSON.stringify({ additionalCategories: additional }),
      });
    }
  }

  // Services: free-form services must belong to one of the listing's categories (primary here).
  const primary = profile.primaryCategory?.name;
  const existing = new Set(profile.services.map((s) => s.label.toLowerCase()));
  const newServices = ai.services.filter((s) => !existing.has(s.label.toLowerCase()));
  if (primary && newServices.length) {
    drafts.push({
      ...base,
      id: crypto.randomUUID(),
      kind: 'services',
      reason: `Adds ${newServices.length} service(s): ${newServices.map((s) => s.label).join(', ')}`,
      beforeJson: JSON.stringify(sliceOf('services', profile)),
      afterJson: JSON.stringify({
        services: [
          ...profile.services,
          ...newServices.map((s) => ({
            label: s.label,
            description: s.description,
            category: primary,
          })),
        ],
      }),
    });
  }

  const newAttrs = ai.attributes.filter(
    (a) => !profile.attributes.some((x) => x.name === a.name && x.value),
  );
  if (newAttrs.length) {
    const names = newAttrs.map((a) => a.name);
    const label = (n: string) => available.find((a) => a.name === n)?.displayName ?? n;
    drafts.push({
      ...base,
      id: crypto.randomUUID(),
      kind: 'attributes',
      reason: `Please confirm these are true: ${names.map(label).join(', ')}`,
      beforeJson: JSON.stringify(sliceOf('attributes', profile, names)),
      afterJson: JSON.stringify({ attributes: names.map((name) => ({ name, value: true })) }),
    });
  }

  const db = getDb(env);
  // New AI suggestions replace older, still-unapproved AI drafts.
  await db
    .delete(gbpChanges)
    .where(
      and(
        eq(gbpChanges.agencyId, agencyId),
        eq(gbpChanges.clientId, client.id),
        eq(gbpChanges.source, 'ai'),
        eq(gbpChanges.status, 'draft'),
      ),
    );
  if (drafts.length) await db.insert(gbpChanges).values(drafts);
  const notes = [...ai.notes];
  if (profile.hours.length === 0)
    notes.unshift('Opening hours are missing: add them in the Hours card below.');
  if (profile.verified === false) {
    notes.unshift(
      'This location is not verified on Google: changes may not go live until it is verified.',
    );
  }
  return { drafts: drafts as ChangeRow[], notes };
}

// ---------------------------------- apply / undo ----------------------------------

async function loadChange(env: Env, agencyId: string, clientId: string, changeId: string) {
  const row = await getDb(env).query.gbpChanges.findFirst({
    where: and(
      eq(gbpChanges.id, changeId),
      eq(gbpChanges.agencyId, agencyId),
      eq(gbpChanges.clientId, clientId),
    ),
  });
  if (!row) throw new GbpEditError('Change not found', 404);
  return row;
}

function googleMessage(err: unknown): string {
  if (err instanceof GoogleApiError) {
    const detail = err.body ? ` | ${err.body.slice(0, 600)}` : '';
    return `${describeError(err)}${detail}`;
  }
  return describeError(err);
}

/** Applies a draft (or retries a failed change) on Google. Returns the updated row. */
export async function applyChange(
  env: Env,
  agencyId: string,
  client: Client,
  changeId: string,
  userId: string,
): Promise<ChangeRow> {
  const db = getDb(env);
  const change = await loadChange(env, agencyId, client.id, changeId);
  if (!['draft', 'failed'].includes(change.status)) {
    throw new GbpEditError(`This change is already ${change.status.replace('_', ' ')}`, 409);
  }
  if (change.locationName !== client.gbpLocationName) {
    throw new GbpEditError(
      'The client now uses a different Business Profile location. Create a new suggestion.',
      409,
    );
  }
  const kind = change.kind;
  const after = parseAfter(kind, JSON.parse(change.afterJson));
  const conn = await businessConn(env, agencyId, client);
  const location = change.locationName;

  let status: ChangeRow['status'];
  let before: unknown;
  let error: string | null = null;
  try {
    status = await withAccessToken(env, conn, async (token) => {
      const raw = await getEditableLocation(token, location);
      const attrNames =
        kind === 'attributes'
          ? (after as After['attributes']).attributes.map((a) => a.name)
          : undefined;
      const liveAttrs =
        kind === 'attributes' ? await getAttributes(token, location).catch(() => []) : [];
      const current = toEditableProfile(raw, liveAttrs);
      before = sliceOf(kind, current, attrNames);
      if (kind === 'attributes') {
        await patchAttributes(token, location, (after as After['attributes']).attributes);
      } else {
        const merged: EditableProfile = { ...current, ...(after as Partial<EditableProfile>) };
        const patch = buildPatch(kind, merged, raw);
        await patchLocation(token, location, patch, true); // Google validates first
        await patchLocation(token, location, patch, false);
      }
      const check: RawEditableLocation = await getEditableLocation(token, location);
      return check.metadata?.hasPendingEdits ? 'pending_google' : 'applied';
    });
  } catch (err) {
    status = 'failed';
    error = googleMessage(err).slice(0, 1500);
    log.warn('Business Profile change failed', err, { clientId: client.id, kind });
  }

  await db
    .update(gbpChanges)
    .set({
      status,
      error,
      beforeJson: before ? JSON.stringify(before) : change.beforeJson,
      appliedByUserId: userId,
      appliedAt: status === 'failed' ? null : Date.now(),
    })
    .where(and(eq(gbpChanges.id, change.id), eq(gbpChanges.agencyId, agencyId)));
  await audit(env, {
    agencyId,
    userId,
    action: 'gbp.change_apply',
    targetType: 'client',
    targetId: client.id,
    metadata: { changeId: change.id, kind, status },
  });
  return { ...change, status, error, appliedByUserId: userId };
}

/** Puts back the "before" value of an applied change (as a new, audited change). */
export async function undoChange(
  env: Env,
  agencyId: string,
  client: Client,
  changeId: string,
  userId: string,
): Promise<ChangeRow> {
  const db = getDb(env);
  const change = await loadChange(env, agencyId, client.id, changeId);
  if (!['applied', 'pending_google'].includes(change.status) || !change.beforeJson) {
    throw new GbpEditError('Only applied changes can be undone', 409);
  }
  const id = crypto.randomUUID();
  await db.insert(gbpChanges).values({
    id,
    agencyId,
    clientId: client.id,
    locationName: change.locationName,
    kind: change.kind,
    source: 'undo',
    status: 'draft',
    reason: 'Undo of an earlier change',
    afterJson: change.beforeJson,
    beforeJson: change.afterJson,
    revertsChangeId: change.id,
    createdByUserId: userId,
    createdAt: Date.now(),
  });
  const result = await applyChange(env, agencyId, client, id, userId);
  if (result.status !== 'failed') {
    await db
      .update(gbpChanges)
      .set({ status: 'reverted' })
      .where(and(eq(gbpChanges.id, change.id), eq(gbpChanges.agencyId, agencyId)));
  }
  return result;
}

/** Re-checks changes Google was still reviewing. */
export async function refreshPendingChanges(
  env: Env,
  agencyId: string,
  client: Client,
): Promise<number> {
  const db = getDb(env);
  const pending = await db
    .select({ id: gbpChanges.id })
    .from(gbpChanges)
    .where(
      and(
        eq(gbpChanges.agencyId, agencyId),
        eq(gbpChanges.clientId, client.id),
        eq(gbpChanges.status, 'pending_google'),
      ),
    );
  if (!pending.length) return 0;
  const { raw } = await loadLiveProfile(env, agencyId, client);
  if (raw.metadata?.hasPendingEdits) return 0;
  await db
    .update(gbpChanges)
    .set({ status: 'applied' })
    .where(
      and(
        eq(gbpChanges.agencyId, agencyId),
        inArray(
          gbpChanges.id,
          pending.map((p) => p.id),
        ),
      ),
    );
  return pending.length;
}

export async function listChanges(env: Env, agencyId: string, clientId: string) {
  return getDb(env)
    .select()
    .from(gbpChanges)
    .where(and(eq(gbpChanges.agencyId, agencyId), eq(gbpChanges.clientId, clientId)))
    .orderBy(desc(gbpChanges.createdAt))
    .limit(50);
}

// ---------------------------------- Google Posts ----------------------------------

const PHONE_RE = /(\+?\d[\d\s-]{7,}\d)/;

export const postInputSchema = z
  .object({
    summary: z.string().trim().min(20, 'Post is too short').max(1500, 'Max 1500 characters'),
    actionType: z.enum(POST_ACTIONS).nullable().default(null),
    actionUrl: z.string().trim().url().max(500).nullable().default(null),
  })
  .refine((p) => !PHONE_RE.test(p.summary), {
    message: 'Google rejects posts that contain phone numbers: use the "Call" button instead',
  })
  .refine((p) => !p.actionType || p.actionType === 'CALL' || p.actionUrl, {
    message: 'This button needs a link (URL)',
  })
  .refine((p) => !p.actionUrl || /^https:\/\//.test(p.actionUrl), {
    message: 'Button link must start with https://',
  });

export async function generatePostDrafts(
  env: Env,
  agencyId: string,
  client: Client,
  userId: string,
  opts: { topic: string; language: Language; notes?: string },
): Promise<PostRow[]> {
  const r = await generateContent(env, {
    type: 'gbp_post',
    keyword: opts.topic,
    language: opts.language,
    notes: opts.notes,
    business: { name: client.name, website: client.websiteUrl },
  });
  if (r.type !== 'gbp_post') throw new Error('Unexpected AI output');
  const now = Date.now();
  const site = /^https:\/\//.test(client.websiteUrl) ? client.websiteUrl : null;
  const rows = r.data.posts
    .filter((p) => !PHONE_RE.test(p.text))
    .map((p, i) => {
      const action = p.call_to_action as PostAction;
      const needsUrl = action !== 'CALL';
      return {
        id: crypto.randomUUID(),
        agencyId,
        clientId: client.id,
        summary: p.text.slice(0, 1500),
        actionType: needsUrl && !site ? null : action,
        actionUrl: needsUrl ? site : null,
        source: 'ai' as const,
        status: 'draft' as const,
        createdByUserId: userId,
        createdAt: now + i, // keep the AI's order
      };
    });
  if (rows.length) await getDb(env).insert(gbpPosts).values(rows);
  return rows as PostRow[];
}

/**
 * Publishes one post now. The status is moved to "publishing" first (atomic), so a post is never
 * sent to Google twice (cron + button at the same time).
 */
export async function publishPost(
  env: Env,
  post: PostRow,
  client: Client,
  userId: string | null,
): Promise<PostRow> {
  const db = getDb(env);
  const claimed = await db
    .update(gbpPosts)
    .set({ status: 'publishing', error: null })
    .where(
      and(
        eq(gbpPosts.id, post.id),
        eq(gbpPosts.agencyId, post.agencyId),
        inArray(gbpPosts.status, ['draft', 'scheduled', 'failed']),
      ),
    )
    .returning({ id: gbpPosts.id });
  if (claimed.length === 0)
    throw new GbpEditError('This post is already published or being published', 409);

  try {
    const input = postInputSchema.parse({
      summary: post.summary,
      actionType: post.actionType,
      actionUrl: post.actionUrl,
    });
    const conn = await businessConn(env, post.agencyId, client);
    const created = await withAccessToken(env, conn, (token) =>
      createLocalPost(
        token,
        client.gbpAccountName!,
        client.gbpLocationName!,
        buildLocalPost({
          summary: input.summary,
          action: input.actionType,
          url: input.actionUrl,
        }),
      ),
    );
    const done = {
      status: 'published' as const,
      googlePostName: created.name,
      searchUrl: created.searchUrl,
      publishedAt: Date.now(),
      approvedByUserId: userId ?? post.approvedByUserId,
      error: null,
    };
    await db
      .update(gbpPosts)
      .set(done)
      .where(and(eq(gbpPosts.id, post.id), eq(gbpPosts.agencyId, post.agencyId)));
    await audit(env, {
      agencyId: post.agencyId,
      userId,
      action: 'gbp.post_publish',
      targetType: 'client',
      targetId: client.id,
      metadata: { postId: post.id, scheduled: userId === null },
    });
    return { ...post, ...done };
  } catch (err) {
    const error = (
      err instanceof z.ZodError ? err.issues.map((i) => i.message).join('; ') : googleMessage(err)
    ).slice(0, 1500);
    await db
      .update(gbpPosts)
      .set({ status: 'failed', error })
      .where(and(eq(gbpPosts.id, post.id), eq(gbpPosts.agencyId, post.agencyId)));
    return { ...post, status: 'failed', error };
  }
}

/** Hourly cron: publish scheduled posts that are due. */
export async function publishDuePosts(env: Env, now = Date.now()): Promise<number> {
  const db = getDb(env);
  const due = await db
    .select()
    .from(gbpPosts)
    .where(and(eq(gbpPosts.status, 'scheduled'), lte(gbpPosts.scheduledFor, now)))
    .limit(25);
  let published = 0;
  for (const post of due) {
    const client = await db.query.clients.findFirst({
      where: and(eq(clients.id, post.clientId), eq(clients.agencyId, post.agencyId)),
    });
    if (!client) continue;
    try {
      const r = await publishPost(env, post, client, null);
      if (r.status === 'published') published++;
    } catch (err) {
      log.warn('Scheduled post failed', err, { postId: post.id });
    }
  }
  if (due.length) log.info(`Scheduled posts: published ${published}/${due.length}`);
  return published;
}

export async function removePost(env: Env, post: PostRow, client: Client): Promise<void> {
  const db = getDb(env);
  if (post.status === 'published' && post.googlePostName) {
    const conn = await businessConn(env, post.agencyId, client);
    await withAccessToken(env, conn, (token) => deleteLocalPost(token, post.googlePostName!));
    await db
      .update(gbpPosts)
      .set({ status: 'deleted' })
      .where(and(eq(gbpPosts.id, post.id), eq(gbpPosts.agencyId, post.agencyId)));
    return;
  }
  if (post.status === 'publishing')
    throw new GbpEditError('This post is being published right now', 409);
  await db
    .delete(gbpPosts)
    .where(and(eq(gbpPosts.id, post.id), eq(gbpPosts.agencyId, post.agencyId)));
}
