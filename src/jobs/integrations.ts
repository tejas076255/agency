// Phase 2/3 data sync for one client: Business Profile (+ reviews + sentiment), Google Ads, YouTube.
// Each product is independent: a failure is recorded on its own snapshot and never blocks others.
import { and, desc, eq, isNull } from 'drizzle-orm';
import { clients, integrationSnapshots, reviews, reviewSentiments } from '../db/schema';
import type { Env } from '../env';
import { fetchAdsSummary, type AdsSummary } from '../google/ads';
import {
  fetchGbpSummary,
  originalReviewText,
  STARS,
  type GbpSummary,
  type RawReview,
} from '../google/business';
import { describeError } from '../google/http';
import { analyzeReviewText } from '../google/language';
import { fetchYouTubeSummary, type YouTubeSummary } from '../google/youtube';
import { getAccessToken, getConnection } from '../google/tokens';
import { getDb } from '../lib/db';
import { log } from '../lib/log';

type Client = typeof clients.$inferSelect;
export type SnapshotSource = 'gbp' | 'ads' | 'youtube';

/** Max reviews sent to Natural Language per sync (cost control). */
export const SENTIMENT_BATCH = 25;

export type IntegrationResults = {
  gbp: GbpSummary | null;
  ads: AdsSummary | null;
  youtube: YouTubeSummary | null;
  errors: Partial<Record<SnapshotSource | 'sentiment', string>>;
};

async function saveSnapshot(
  env: Env,
  c: Client,
  source: SnapshotSource,
  result: { data: unknown } | { error: string },
) {
  await getDb(env)
    .insert(integrationSnapshots)
    .values({
      id: crypto.randomUUID(),
      agencyId: c.agencyId,
      clientId: c.id,
      source,
      runAt: Date.now(),
      status: 'data' in result ? 'ok' : 'failed',
      dataJson: 'data' in result ? JSON.stringify(result.data) : null,
      error: 'error' in result ? result.error.slice(0, 500) : null,
    });
}

/** Newest successful snapshot of a source for a client (tenant-scoped). */
export async function latestSnapshot<T>(
  env: Env,
  agencyId: string,
  clientId: string,
  source: SnapshotSource,
) {
  const row = await getDb(env).query.integrationSnapshots.findFirst({
    where: and(
      eq(integrationSnapshots.agencyId, agencyId),
      eq(integrationSnapshots.clientId, clientId),
      eq(integrationSnapshots.source, source),
    ),
    orderBy: desc(integrationSnapshots.runAt),
  });
  if (!row) return null;
  return {
    runAt: row.runAt,
    status: row.status,
    error: row.error,
    data: row.dataJson ? (JSON.parse(row.dataJson) as T) : null,
  };
}

const toMs = (iso?: string) => (iso ? Date.parse(iso) || null : null);

/** Upserts reviews (original Google data). Returns how many were new. */
export async function upsertReviews(env: Env, c: Client, raw: RawReview[]): Promise<number> {
  const db = getDb(env);
  let created = 0;
  for (const r of raw) {
    const values = {
      reviewerName: r.reviewer?.displayName ?? null,
      starRating: STARS[r.starRating ?? ''] ?? null,
      comment: originalReviewText(r.comment),
      reviewCreatedAt: toMs(r.createTime),
      replyComment: r.reviewReply?.comment ?? null,
      replyUpdatedAt: toMs(r.reviewReply?.updateTime),
      syncedAt: Date.now(),
    };
    const res = await db
      .insert(reviews)
      .values({
        id: crypto.randomUUID(),
        agencyId: c.agencyId,
        clientId: c.id,
        googleReviewName: r.name,
        ...values,
      })
      .onConflictDoUpdate({ target: reviews.googleReviewName, set: values })
      .returning({ id: reviews.id, syncedAt: reviews.syncedAt });
    if (res.length) created++;
  }
  return created;
}

/** Runs Natural Language sentiment on reviews that have text but no analysis yet. */
export async function analyzePendingReviews(env: Env, c: Client): Promise<number> {
  if (!env.NATURAL_LANGUAGE_API_KEY) return 0;
  const db = getDb(env);
  const pending = await db
    .select({ id: reviews.id, comment: reviews.comment })
    .from(reviews)
    .leftJoin(reviewSentiments, eq(reviewSentiments.reviewId, reviews.id))
    .where(
      and(
        eq(reviews.agencyId, c.agencyId),
        eq(reviews.clientId, c.id),
        isNull(reviewSentiments.reviewId),
      ),
    )
    .orderBy(desc(reviews.reviewCreatedAt))
    .limit(SENTIMENT_BATCH * 2);
  let done = 0;
  for (const r of pending) {
    if (!r.comment || done >= SENTIMENT_BATCH) continue;
    const s = await analyzeReviewText(env.NATURAL_LANGUAGE_API_KEY, r.comment);
    await db
      .insert(reviewSentiments)
      .values({
        reviewId: r.id,
        agencyId: c.agencyId,
        score: Math.round(s.score * 100),
        magnitude: Math.round(s.magnitude * 100),
        label: s.label,
        entitiesJson: JSON.stringify(s.entities),
        provider: 'google_natural_language',
        analyzedAt: Date.now(),
      })
      .onConflictDoNothing();
    done++;
  }
  return done;
}

export async function syncGbp(env: Env, c: Client): Promise<GbpSummary | null> {
  if (!c.gbpLocationName || !c.gbpAccountName) return null;
  const conn = await getConnection(env, c.agencyId, 'client_business', c.id);
  if (!conn) return null;
  const token = await getAccessToken(env, conn);
  const { summary, reviews: raw } = await fetchGbpSummary(
    token,
    c.gbpAccountName,
    c.gbpLocationName,
  );
  await upsertReviews(env, c, raw);
  return summary;
}

export async function syncAds(env: Env, c: Client): Promise<AdsSummary | null> {
  if (!c.adsCustomerId) return null;
  const conn = await getConnection(env, c.agencyId, 'client_ads', c.id);
  if (!conn) return null;
  const token = await getAccessToken(env, conn);
  return fetchAdsSummary(env, token, c.adsCustomerId);
}

export async function syncYouTube(env: Env, c: Client): Promise<YouTubeSummary | null> {
  if (!c.youtubeChannelId) return null;
  const conn = await getConnection(env, c.agencyId, 'client_youtube', c.id);
  if (!conn) return null;
  const token = await getAccessToken(env, conn);
  return fetchYouTubeSummary(token, c.youtubeChannelId);
}

/** Syncs every configured product for the client. Never throws. */
export async function syncIntegrations(env: Env, c: Client): Promise<IntegrationResults> {
  const out: IntegrationResults = { gbp: null, ads: null, youtube: null, errors: {} };
  const tasks: [SnapshotSource, () => Promise<unknown>][] = [
    ['gbp', () => syncGbp(env, c)],
    ['ads', () => syncAds(env, c)],
    ['youtube', () => syncYouTube(env, c)],
  ];
  await Promise.all(
    tasks.map(async ([source, fn]) => {
      try {
        const data = await fn();
        if (data === null) return; // not connected / not selected: nothing to record
        (out as Record<string, unknown>)[source] = data;
        await saveSnapshot(env, c, source, { data });
      } catch (err) {
        const msg = describeError(err);
        out.errors[source] = msg;
        log.warn(`Integration sync failed: ${source}`, err, { clientId: c.id });
        await saveSnapshot(env, c, source, { error: msg }).catch(() => undefined);
      }
    }),
  );
  try {
    await analyzePendingReviews(env, c);
  } catch (err) {
    out.errors.sentiment = describeError(err);
    log.warn('Review sentiment failed', err, { clientId: c.id });
  }
  return out;
}

/** Review stats for the AI summary and dashboards (last 30 days + unanswered). */
export async function reviewStats(env: Env, agencyId: string, clientId: string) {
  const since = Date.now() - 30 * 86_400_000;
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN r.review_created_at >= ?3 THEN 1 ELSE 0 END) AS recent30,
       SUM(CASE WHEN r.review_created_at >= ?3 AND (s.label = 'negative' OR r.star_rating <= 2) THEN 1 ELSE 0 END) AS negative30,
       SUM(CASE WHEN r.reply_comment IS NULL THEN 1 ELSE 0 END) AS unanswered,
       AVG(r.star_rating) AS avgRating
     FROM reviews r LEFT JOIN review_sentiments s ON s.review_id = r.id
     WHERE r.agency_id = ?1 AND r.client_id = ?2`,
  )
    .bind(agencyId, clientId, since)
    .first<{
      total: number;
      recent30: number | null;
      negative30: number | null;
      unanswered: number | null;
      avgRating: number | null;
    }>();
  if (!row || !row.total) return null;
  return {
    recent30: row.recent30 ?? 0,
    negative30: row.negative30 ?? 0,
    unanswered: row.unanswered ?? 0,
    averageRating: row.avgRating === null ? null : Math.round(row.avgRating * 10) / 10,
  };
}
