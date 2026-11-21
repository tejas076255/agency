import { and, eq } from 'drizzle-orm';
import { actionItems, clients, healthChecks, insights } from '../db/schema';
import type { Env } from '../env';
import { fetchGa4Summary, type Ga4Summary } from '../google/ga4';
import { fetchGscSummary, type GscSummary } from '../google/gsc';
import { describeError, ReconnectNeededError } from '../google/http';
import { fetchPageSpeedSummary, type PageSpeedSummary } from '../google/pagespeed';
import { getAccessToken, getConnection, hasScope, SCOPE } from '../google/tokens';
import { generateInsights } from '../lib/ai';
import { getDb } from '../lib/db';
import { buildCompactSummary } from '../lib/insights';
import { log } from '../lib/log';
import { computeHealthScore } from '../lib/score';

export type SourceErrors = Partial<Record<'gsc' | 'ga4' | 'pagespeed' | 'ai', string>>;

export type HealthCheckResult = {
  healthCheckId: string;
  status: 'ok' | 'partial' | 'failed';
  score: number | null;
  errors: SourceErrors;
};

export async function runHealthCheck(
  env: Env,
  agencyId: string,
  clientId: string,
  now = Date.now(),
): Promise<HealthCheckResult> {
  const db = getDb(env);
  const client = await db.query.clients.findFirst({
    where: and(eq(clients.id, clientId), eq(clients.agencyId, agencyId)),
  });
  if (!client) throw new Error('Client not found');

  const errors: SourceErrors = {};
  const conn = await getConnection(env, agencyId, 'client_data', clientId);

  // Get one access token for both Google data sources.
  let token: string | null = null;
  if (conn && (client.gscSiteUrl || client.ga4PropertyId)) {
    try {
      token = await getAccessToken(env, conn);
    } catch (err) {
      const msg = err instanceof ReconnectNeededError ? 'Reconnect needed' : describeError(err);
      if (client.gscSiteUrl) errors.gsc = msg;
      if (client.ga4PropertyId) errors.ga4 = msg;
    }
  }

  const gscTask = async (): Promise<GscSummary | null> => {
    if (!conn) return ((errors.gsc = 'Google account not connected'), null);
    if (!client.gscSiteUrl) return ((errors.gsc = 'Search Console site not selected'), null);
    if (!hasScope(conn, SCOPE.gsc))
      return ((errors.gsc = 'Search Console permission not granted'), null);
    if (!token) return null;
    return fetchGscSummary(token, client.gscSiteUrl, now);
  };
  const ga4Task = async (): Promise<Ga4Summary | null> => {
    if (!conn) return ((errors.ga4 = 'Google account not connected'), null);
    if (!client.ga4PropertyId) return ((errors.ga4 = 'GA4 property not selected'), null);
    if (!hasScope(conn, SCOPE.ga4))
      return ((errors.ga4 = 'Analytics permission not granted'), null);
    if (!token) return null;
    return fetchGa4Summary(token, client.ga4PropertyId, now);
  };
  const psiTask = async (): Promise<PageSpeedSummary | null> => {
    if (!env.PAGESPEED_API_KEY) return ((errors.pagespeed = 'PAGESPEED_API_KEY is not set'), null);
    return fetchPageSpeedSummary(env.PAGESPEED_API_KEY, client.websiteUrl);
  };

  // One failing source never blocks the others (partial results).
  const [gscR, ga4R, psiR] = await Promise.allSettled([gscTask(), ga4Task(), psiTask()]);
  const value = <T>(r: PromiseSettledResult<T | null>, key: keyof SourceErrors): T | null => {
    if (r.status === 'fulfilled') return r.value;
    errors[key] = describeError(r.reason);
    return null;
  };
  const gsc = value(gscR, 'gsc');
  const ga4 = value(ga4R, 'ga4');
  const psi = value(psiR, 'pagespeed');

  const score = computeHealthScore({
    search: gsc && {
      hasData: gsc.totals.current.impressions > 0 || gsc.totals.previous.impressions > 0,
      clicksChangePct: gsc.clicksChangePct,
      impressionsChangePct: gsc.impressionsChangePct,
      avgPosition: gsc.totals.current.impressions > 0 ? gsc.totals.current.position : null,
      ctrPct: gsc.totals.current.impressions > 0 ? gsc.totals.current.ctr * 100 : null,
    },
    traffic: ga4 && {
      hasData: ga4.totals.current.sessions > 0 || ga4.totals.previous.sessions > 0,
      organicSessionsChangePct: ga4.organicSessions ? ga4.organicSessions.changePct : undefined,
      sessionsChangePct: ga4.sessionsChangePct,
      engagementRatePct: ga4.totals.current.engagementRate,
      keyEventsChangePct: ga4.keyEventsChangePct,
    },
    performance: psi && {
      mobile: psi.mobile?.score ?? null,
      desktop: psi.desktop?.score ?? null,
      cwvPassed: psi.mobile?.field?.cwvPassed ?? null,
    },
    sources: { gsc: gsc !== null, ga4: ga4 !== null, pagespeed: psi !== null },
  });

  const attempted = [gsc, ga4, psi];
  const succeeded = attempted.filter((x) => x !== null).length;
  const status: HealthCheckResult['status'] =
    succeeded === 0 ? 'failed' : Object.keys(errors).length === 0 ? 'ok' : 'partial';

  const healthCheckId = crypto.randomUUID();
  await db.insert(healthChecks).values({
    id: healthCheckId,
    agencyId,
    clientId,
    runAt: now,
    gscJson: gsc ? JSON.stringify(gsc) : null,
    ga4Json: ga4 ? JSON.stringify(ga4) : null,
    pagespeedJson: psi ? JSON.stringify(psi) : null,
    score: score.score,
    scoreBreakdownJson: JSON.stringify(score.breakdown),
    formulaVersion: score.formulaVersion,
    status,
    errorsJson: Object.keys(errors).length ? JSON.stringify(errors) : null,
  });

  // AI insights (only when there is some data to talk about). generateInsights never fails
  // because of the AI: it falls back to rule-based insights.
  if (succeeded > 0) {
    try {
      const { data, model, source, fallbackReason } = await generateInsights(
        env,
        buildCompactSummary(client, gsc, ga4, psi, score.score),
        { hinglish: true },
      );
      if (source === 'fallback') {
        errors.ai =
          `AI unavailable, used rule-based recommendations (${fallbackReason ?? 'unknown reason'})`.slice(
            0,
            300,
          );
      }
      const insightId = crypto.randomUUID();
      await db.batch([
        db.insert(insights).values({
          id: insightId,
          agencyId,
          healthCheckId,
          summary: data.summary,
          summaryHinglish: data.summary_hinglish ?? null,
          modelUsed: model,
          createdAt: Date.now(),
        }),
        db.insert(actionItems).values(
          data.action_items.map((a) => ({
            id: crypto.randomUUID(),
            agencyId,
            clientId,
            insightId,
            priority: a.priority,
            title: a.title,
            description: a.description,
            why: a.why,
            expectedImpact: a.expected_impact,
            supportingMetricsJson: JSON.stringify(a.supporting_metrics),
            done: false,
          })),
        ),
      ]);
    } catch (err) {
      // Only DB problems end up here (the AI itself has a fallback).
      log.error('Saving insights failed', err);
      errors.ai = describeError(err);
    }
    if (errors.ai) {
      await db
        .update(healthChecks)
        .set({ errorsJson: JSON.stringify(errors), status: status === 'ok' ? 'partial' : status })
        .where(and(eq(healthChecks.id, healthCheckId), eq(healthChecks.agencyId, agencyId)));
    }
  }

  return {
    healthCheckId,
    status: errors.ai && status === 'ok' ? 'partial' : status,
    score: score.score,
    errors,
  };
}
