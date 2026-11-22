// Keyword rank tracker: weekly Search Console positions for keywords the agency picks per client.
// Runs inside the weekly health check (reusing its access token) and on "Check now".
import { and, desc, eq, inArray } from 'drizzle-orm';
import { clients, healthChecks, keywordRankings, trackedKeywords } from '../db/schema';
import type { Env } from '../env';
import {
  fetchKeywordHistory,
  normalizeKeyword,
  RANK_WEEKS,
  type GscSummary,
  type KeywordWeek,
} from '../google/gsc';
import { describeError, ReconnectNeededError } from '../google/http';
import {
  getConnection,
  hasScope,
  isUnauthenticated,
  SCOPE,
  withAccessToken,
} from '../google/tokens';
import { getDb } from '../lib/db';

type Client = typeof clients.$inferSelect;
const CONCURRENCY = 4;

export type KeywordSyncResult = {
  checked: number;
  failed: { keyword: string; error: string }[];
};

/**
 * Fetches and stores the last RANK_WEEKS weekly positions for the client's tracked keywords
 * (or only `keywordIds`). Per-keyword failures are recorded on the keyword and returned; a 401 or
 * a revoked grant aborts so the caller can refresh the token or show "Reconnect needed".
 */
export async function syncKeywordRankings(
  env: Env,
  agencyId: string,
  clientId: string,
  siteUrl: string,
  token: string,
  opts: { keywordIds?: string[]; now?: number } = {},
): Promise<KeywordSyncResult> {
  const db = getDb(env);
  const conds = [eq(trackedKeywords.agencyId, agencyId), eq(trackedKeywords.clientId, clientId)];
  if (opts.keywordIds) {
    if (opts.keywordIds.length === 0) return { checked: 0, failed: [] };
    conds.push(inArray(trackedKeywords.id, opts.keywordIds));
  }
  const list = await db
    .select()
    .from(trackedKeywords)
    .where(and(...conds));
  const result: KeywordSyncResult = { checked: 0, failed: [] };
  let abort: unknown = null;

  const queue = [...list];
  const worker = async () => {
    for (let kw = queue.shift(); kw && !abort; kw = queue.shift()) {
      try {
        const { weeks, topPage } = await fetchKeywordHistory(token, siteUrl, kw.keyword, opts.now);
        await saveWeeks(env, agencyId, kw.id, weeks, topPage);
        result.checked++;
      } catch (err) {
        if (err instanceof ReconnectNeededError || isUnauthenticated(err)) {
          abort = err;
          return;
        }
        const error = describeError(err).slice(0, 300);
        result.failed.push({ keyword: kw.keyword, error });
        await db
          .update(trackedKeywords)
          .set({ lastError: error })
          .where(and(eq(trackedKeywords.id, kw.id), eq(trackedKeywords.agencyId, agencyId)));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  if (abort) throw abort;
  return result;
}

async function saveWeeks(
  env: Env,
  agencyId: string,
  keywordId: string,
  weeks: KeywordWeek[],
  topPage: string | null,
) {
  const db = getDb(env);
  const newest = weeks[weeks.length - 1]?.periodEnd;
  const upserts = weeks.map((w) =>
    db
      .insert(keywordRankings)
      .values({
        id: crypto.randomUUID(),
        agencyId,
        keywordId,
        periodEnd: w.periodEnd,
        position: w.position,
        clicks: w.clicks,
        impressions: w.impressions,
        topPage: w.periodEnd === newest ? topPage : null,
      })
      .onConflictDoUpdate({
        target: [keywordRankings.keywordId, keywordRankings.periodEnd],
        set: {
          position: w.position,
          clicks: w.clicks,
          impressions: w.impressions,
          ...(w.periodEnd === newest ? { topPage } : {}),
        },
      }),
  );
  await db.batch([
    db
      .update(trackedKeywords)
      .set({ lastCheckedAt: Date.now(), lastError: null })
      .where(and(eq(trackedKeywords.id, keywordId), eq(trackedKeywords.agencyId, agencyId))),
    ...upserts,
  ]);
}

/** Why keywords can't be checked for this client right now (null = ready). */
export async function keywordReadiness(
  env: Env,
  agencyId: string,
  client: Client,
): Promise<string | null> {
  if (!client.gscSiteUrl) return 'Select a Search Console site for this client first.';
  const conn = await getConnection(env, agencyId, 'client_data', client.id);
  if (!conn) return 'Connect the client’s Google account (Search Console) first.';
  if (conn.status !== 'active') return 'Reconnect the client’s Google account.';
  if (!hasScope(conn, SCOPE.gsc)) return 'Search Console permission was not granted.';
  return null;
}

/** "Check now" / after adding keywords: gets its own token (refreshing once on 401). */
export async function checkClientKeywords(
  env: Env,
  agencyId: string,
  client: Client,
  opts: { keywordIds?: string[] } = {},
): Promise<KeywordSyncResult> {
  const notReady = await keywordReadiness(env, agencyId, client);
  if (notReady) throw new Error(notReady);
  const conn = (await getConnection(env, agencyId, 'client_data', client.id))!;
  return withAccessToken(env, conn, (token) =>
    syncKeywordRankings(env, agencyId, client.id, client.gscSiteUrl!, token, opts),
  );
}

export type KeywordRow = {
  id: string;
  keyword: string;
  createdAt: number;
  lastCheckedAt: number | null;
  lastError: string | null;
  latest: (KeywordWeek & { topPage: string | null }) | null;
  /** Positions gained since the previous week (positive = moved up). null if not comparable. */
  change: number | null;
  /** Positions gained over the stored history (first ranked week -> latest). */
  changeAll: number | null;
  best: number | null;
  history: KeywordWeek[];
};

/** Pure (unit-tested): stored weekly rows -> latest, change vs last week and best position. */
export function summarizeKeyword(
  rows: (KeywordWeek & { topPage: string | null })[],
): Pick<KeywordRow, 'latest' | 'change' | 'changeAll' | 'best' | 'history'> {
  const history = [...rows]
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
    .slice(-RANK_WEEKS);
  const latest = history[history.length - 1] ?? null;
  const prev = history[history.length - 2];
  const ranked = history.filter((h) => h.position !== null);
  const diff = (from?: number | null, to?: number | null) =>
    from != null && to != null ? Math.round((from - to) * 10) / 10 : null;
  return {
    latest,
    change: diff(prev?.position, latest?.position),
    changeAll: ranked.length > 1 ? diff(ranked[0]!.position, latest?.position) : null,
    best: ranked.length ? Math.min(...ranked.map((h) => h.position!)) : null,
    history: history.map(({ periodEnd, position, clicks, impressions }) => ({
      periodEnd,
      position,
      clicks,
      impressions,
    })),
  };
}

/** Everything the Keywords tab needs: tracked keywords with history, and suggestions. */
export async function keywordOverview(env: Env, agencyId: string, client: Client) {
  const db = getDb(env);
  const list = await db
    .select()
    .from(trackedKeywords)
    .where(and(eq(trackedKeywords.agencyId, agencyId), eq(trackedKeywords.clientId, client.id)))
    .orderBy(trackedKeywords.createdAt);
  const ids = list.map((k) => k.id);
  const rows = ids.length
    ? await db
        .select()
        .from(keywordRankings)
        .where(and(eq(keywordRankings.agencyId, agencyId), inArray(keywordRankings.keywordId, ids)))
    : [];
  const byKeyword = new Map<string, typeof rows>();
  for (const r of rows) byKeyword.set(r.keywordId, [...(byKeyword.get(r.keywordId) ?? []), r]);

  const keywords: KeywordRow[] = list.map((k) => ({
    id: k.id,
    keyword: k.keyword,
    createdAt: k.createdAt,
    lastCheckedAt: k.lastCheckedAt,
    lastError: k.lastError,
    ...summarizeKeyword(byKeyword.get(k.id) ?? []),
  }));

  // Suggestions: the latest health check's top and "quick win" queries not tracked yet.
  const latestCheck = await db.query.healthChecks.findFirst({
    where: and(eq(healthChecks.agencyId, agencyId), eq(healthChecks.clientId, client.id)),
    orderBy: desc(healthChecks.runAt),
    columns: { gscJson: true },
  });
  const tracked = new Set(list.map((k) => k.keyword));
  const suggestions: { keyword: string; position: number; impressions: number }[] = [];
  if (latestCheck?.gscJson) {
    try {
      const gsc = JSON.parse(latestCheck.gscJson) as GscSummary;
      for (const q of [...(gsc.topQueries ?? []), ...(gsc.quickWins ?? [])]) {
        const keyword = normalizeKeyword(q.query);
        if (!keyword || tracked.has(keyword)) continue;
        tracked.add(keyword);
        suggestions.push({ keyword, position: q.position, impressions: q.impressions });
      }
    } catch {
      // Old/invalid JSON: just no suggestions.
    }
  }

  return {
    keywords,
    suggestions: suggestions.slice(0, 15),
    notReady: await keywordReadiness(env, agencyId, client),
  };
}
