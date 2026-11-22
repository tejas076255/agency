// One compact, tenant-scoped JSON picture of a client for the AI tools (assistant, content writer,
// ad copy). Built only from data already stored by the health check and syncs: no extra API calls.
import { and, desc, eq } from 'drizzle-orm';
import { actionItems, alerts, clients, healthChecks, insights } from '../db/schema';
import type { Env } from '../env';
import type { AdsSummary } from '../google/ads';
import type { GbpSummary } from '../google/business';
import type { Ga4Summary } from '../google/ga4';
import type { GscSummary } from '../google/gsc';
import type { PageSpeedSummary } from '../google/pagespeed';
import type { YouTubeSummary } from '../google/youtube';
import { getDb } from '../lib/db';
import { buildCompactSummary } from '../lib/insights';
import { latestSnapshot, reviewStats } from './integrations';
import { keywordOverview } from './keywords';

type Client = typeof clients.$inferSelect;

const parse = <T>(s: string | null | undefined): T | null => {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

export async function buildClientContext(env: Env, agencyId: string, client: Client) {
  const db = getDb(env);
  const check = await db.query.healthChecks.findFirst({
    where: and(eq(healthChecks.agencyId, agencyId), eq(healthChecks.clientId, client.id)),
    orderBy: desc(healthChecks.runAt),
  });
  const [gbp, ads, youtube, reviews, kw, recentAlerts] = await Promise.all([
    latestSnapshot<GbpSummary>(env, agencyId, client.id, 'gbp'),
    latestSnapshot<AdsSummary>(env, agencyId, client.id, 'ads'),
    latestSnapshot<YouTubeSummary>(env, agencyId, client.id, 'youtube'),
    reviewStats(env, agencyId, client.id),
    keywordOverview(env, agencyId, client),
    db
      .select({ title: alerts.title, createdAt: alerts.createdAt })
      .from(alerts)
      .where(and(eq(alerts.agencyId, agencyId), eq(alerts.clientId, client.id)))
      .orderBy(desc(alerts.createdAt))
      .limit(5),
  ]);
  const summary = buildCompactSummary(
    client,
    parse<GscSummary>(check?.gscJson),
    parse<Ga4Summary>(check?.ga4Json),
    parse<PageSpeedSummary>(check?.pagespeedJson),
    check?.score ?? null,
    { gbp: gbp?.data ?? null, ads: ads?.data ?? null, youtube: youtube?.data ?? null, reviews },
  );

  const insight = check
    ? await db.query.insights.findFirst({
        where: and(eq(insights.healthCheckId, check.id), eq(insights.agencyId, agencyId)),
      })
    : undefined;
  const actions = insight
    ? await db
        .select({ title: actionItems.title, done: actionItems.done })
        .from(actionItems)
        .where(and(eq(actionItems.insightId, insight.id), eq(actionItems.agencyId, agencyId)))
        .orderBy(actionItems.priority)
    : [];

  return {
    ...summary,
    last_health_check: check ? new Date(check.runAt).toISOString().slice(0, 10) : null,
    tracked_keywords: kw.keywords.slice(0, 25).map((k) => ({
      keyword: k.keyword,
      position: k.latest?.position ?? null,
      change_vs_last_week: k.change,
      clicks_week: k.latest?.clicks ?? 0,
    })),
    current_action_items: actions.map((a) => ({ task: a.title, done: a.done })),
    recent_alerts: recentAlerts.map((a) => a.title),
  };
}

export type ClientContext = Awaited<ReturnType<typeof buildClientContext>>;
