// One-click "Post" / "Post all" for the Grow screen: applies profile changes, publishes (or
// schedules) Google posts and posts review replies, one by one, then re-scores the profile.
import { and, eq, isNull } from 'drizzle-orm';
import { clients, gbpPosts, reviews } from '../db/schema';
import type { Env } from '../env';
import { replyToReview } from '../google/business';
import { getConnection, withAccessToken } from '../google/tokens';
import { audit } from '../lib/audit';
import { getDb } from '../lib/db';
import { applyChange, GbpEditError, publishPost } from './gbp-edit';
import { runProfileScan } from './profile-scan';

type Client = typeof clients.$inferSelect;
export type FixRef = { type: 'change' | 'post' | 'review'; id: string };
export type FixResult = FixRef & {
  status: 'applied' | 'pending_google' | 'published' | 'scheduled' | 'posted' | 'failed';
  error: string | null;
};

const DAY = 86_400_000;

/** 10:00 IST on the day `days` from now (posts are spread out, not all published at once). */
export function scheduleSlot(now: number, days: number): number {
  const ist = new Date(now + 5.5 * 3600_000);
  ist.setUTCHours(10, 0, 0, 0);
  return ist.getTime() - 5.5 * 3600_000 + days * DAY;
}

export async function publishFixes(
  env: Env,
  agencyId: string,
  client: Client,
  userId: string,
  items: FixRef[],
  opts: { spreadPosts: boolean; now?: number } = { spreadPosts: false },
): Promise<{ results: FixResult[]; before: number | null; after: number | null }> {
  const db = getDb(env);
  const now = opts.now ?? Date.now();
  const results: FixResult[] = [];
  let postIndex = 0;

  for (const item of items) {
    try {
      if (item.type === 'change') {
        const r = await applyChange(env, agencyId, client, item.id, userId);
        results.push({
          ...item,
          status:
            r.status === 'failed'
              ? 'failed'
              : r.status === 'pending_google'
                ? 'pending_google'
                : 'applied',
          error: r.error,
        });
      } else if (item.type === 'post') {
        const post = await db.query.gbpPosts.findFirst({
          where: and(
            eq(gbpPosts.id, item.id),
            eq(gbpPosts.agencyId, agencyId),
            eq(gbpPosts.clientId, client.id),
          ),
        });
        if (!post) throw new GbpEditError('Post not found', 404);
        if (opts.spreadPosts && postIndex > 0) {
          // "Post all": first post now, the next ones every 3 days at 10:00 IST.
          await db
            .update(gbpPosts)
            .set({
              status: 'scheduled',
              scheduledFor: scheduleSlot(now, 3 * postIndex),
              approvedByUserId: userId,
              error: null,
            })
            .where(and(eq(gbpPosts.id, post.id), eq(gbpPosts.agencyId, agencyId)));
          results.push({ ...item, status: 'scheduled', error: null });
        } else {
          const r = await publishPost(env, post, client, userId);
          results.push({
            ...item,
            status: r.status === 'published' ? 'published' : 'failed',
            error: r.error,
          });
        }
        postIndex++;
      } else {
        const review = await db.query.reviews.findFirst({
          where: and(
            eq(reviews.id, item.id),
            eq(reviews.agencyId, agencyId),
            eq(reviews.clientId, client.id),
            isNull(reviews.replyComment),
          ),
        });
        if (!review?.aiDraftReply) throw new GbpEditError('Reply draft not found', 404);
        const conn = await getConnection(env, agencyId, 'client_business', client.id);
        if (!conn) throw new GbpEditError('Business Profile is not connected');
        await withAccessToken(env, conn, (t) =>
          replyToReview(t, review.googleReviewName, review.aiDraftReply!),
        );
        await db
          .update(reviews)
          .set({
            replyComment: review.aiDraftReply,
            replyUpdatedAt: Date.now(),
            aiDraftReply: null,
          })
          .where(and(eq(reviews.id, review.id), eq(reviews.agencyId, agencyId)));
        await audit(env, {
          agencyId,
          userId,
          action: 'review.reply',
          targetType: 'review',
          targetId: review.id,
          metadata: { source: 'grow' },
        });
        results.push({ ...item, status: 'posted', error: null });
      }
    } catch (err) {
      results.push({ ...item, status: 'failed', error: (err as Error).message.slice(0, 500) });
    }
  }

  const prev = await getDb(env).query.profileScans.findFirst({
    where: (t, { and: a, eq: e }) => a(e(t.agencyId, agencyId), e(t.clientId, client.id)),
    orderBy: (t, { desc: d }) => d(t.runAt),
  });
  const before = prev?.score ?? null;
  let after: number | null = before;
  if (results.some((r) => r.status !== 'failed')) {
    const rescan = await runProfileScan(env, agencyId, client.id, {
      trigger: 'after_publish',
      generateFixes: false,
      userId,
    });
    after = rescan.score ?? before;
  }
  return { results, before, after };
}
