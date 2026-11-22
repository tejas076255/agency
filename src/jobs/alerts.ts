// AI anomaly alerts: after every health check, compare with the previous check and recent data,
// store alerts (with an AI explanation) and email the agency owner(s) from the agency Gmail.
import { and, desc, eq, gte, lt, ne } from 'drizzle-orm';
import { alerts, clients, healthChecks, users } from '../db/schema';
import type { Env } from '../env';
import type { AdsSummary } from '../google/ads';
import type { Ga4Summary } from '../google/ga4';
import type { GscSummary } from '../google/gsc';
import type { PageSpeedSummary } from '../google/pagespeed';
import { getAccessToken, getConnection } from '../google/tokens';
import { buildMimeMessage, sendGmail } from '../google/workspace';
import { explainAnomalies, type Anomaly } from '../lib/ai-tools';
import { getDb } from '../lib/db';
import { log } from '../lib/log';
import { buildClientContext } from './client-context';
import { latestSnapshot } from './integrations';
import { keywordOverview } from './keywords';

type Client = typeof clients.$inferSelect;

/** The same kind of alert is not repeated for a client within this window. */
export const ALERT_DEDUPE_MS = 14 * 86_400_000;

export type AnomalyInput = {
  gsc: GscSummary | null;
  ga4: Ga4Summary | null;
  psi: PageSpeedSummary | null;
  score: number | null;
  prevScore: number | null;
  prevMobileSpeed: number | null;
  keywords: { keyword: string; position: number | null; previous: number | null }[];
  negativeReviews: number;
  ads: AdsSummary | null;
};

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

const pct = (n: number) => `${n > 0 ? '+' : ''}${Math.round(n)}%`;

/** Pure (unit-tested): rules that turn the latest data into anomalies. */
export function detectAnomalies(i: AnomalyInput): Anomaly[] {
  const out: Anomaly[] = [];
  const g = i.gsc;
  if (
    g &&
    g.clicksChangePct !== null &&
    g.clicksChangePct <= -30 &&
    g.totals.previous.clicks >= 20
  ) {
    out.push({
      kind: 'clicks_drop',
      severity: g.clicksChangePct <= -50 ? 'high' : 'medium',
      title: `Google clicks fell ${pct(g.clicksChangePct)} (${g.totals.previous.clicks} → ${g.totals.current.clicks})`,
      details: {
        before: g.totals.previous.clicks,
        now: g.totals.current.clicks,
        changePct: g.clicksChangePct,
        droppingPages: g.droppingPages.slice(0, 3),
      },
    });
  }
  if (
    g &&
    g.impressionsChangePct !== null &&
    g.impressionsChangePct <= -30 &&
    g.totals.previous.impressions >= 200
  ) {
    out.push({
      kind: 'impressions_drop',
      severity: g.impressionsChangePct <= -50 ? 'high' : 'medium',
      title: `Google impressions fell ${pct(g.impressionsChangePct)}`,
      details: { before: g.totals.previous.impressions, now: g.totals.current.impressions },
    });
  }
  const a = i.ga4;
  if (
    a &&
    a.sessionsChangePct !== null &&
    a.sessionsChangePct <= -30 &&
    a.totals.previous.sessions >= 50
  ) {
    out.push({
      kind: 'sessions_drop',
      severity: a.sessionsChangePct <= -50 ? 'high' : 'medium',
      title: `Website visits fell ${pct(a.sessionsChangePct)} (${a.totals.previous.sessions} → ${a.totals.current.sessions})`,
      details: {
        before: a.totals.previous.sessions,
        now: a.totals.current.sessions,
        channels: a.topChannels.slice(0, 4),
      },
    });
  }
  if (
    a &&
    a.keyEventsChangePct !== null &&
    a.keyEventsChangePct <= -40 &&
    a.totals.previous.keyEvents >= 5
  ) {
    out.push({
      kind: 'conversions_drop',
      severity: 'high',
      title: `Leads/conversions fell ${pct(a.keyEventsChangePct)} (${a.totals.previous.keyEvents} → ${a.totals.current.keyEvents})`,
      details: { before: a.totals.previous.keyEvents, now: a.totals.current.keyEvents },
    });
  }
  if (i.score !== null && i.prevScore !== null && i.prevScore - i.score >= 10) {
    out.push({
      kind: 'score_drop',
      severity: i.prevScore - i.score >= 20 ? 'high' : 'medium',
      title: `Health score dropped from ${i.prevScore} to ${i.score}`,
      details: { before: i.prevScore, now: i.score },
    });
  }
  const mobile = i.psi?.mobile?.score ?? null;
  if (mobile !== null && i.prevMobileSpeed !== null && i.prevMobileSpeed - mobile >= 15) {
    out.push({
      kind: 'speed_drop',
      severity: 'medium',
      title: `Mobile speed score dropped from ${i.prevMobileSpeed} to ${mobile}`,
      details: {
        before: i.prevMobileSpeed,
        now: mobile,
        fixes: i.psi?.mobile?.opportunities.slice(0, 3).map((o) => o.title),
      },
    });
  }
  const fell = i.keywords.filter(
    (k) =>
      k.previous !== null &&
      k.previous <= 20 &&
      (k.position === null ||
        k.position - k.previous >= 5 ||
        (k.previous <= 10 && k.position > 10)),
  );
  if (fell.length) {
    const lostPage1 = fell.some((k) => k.previous! <= 10);
    out.push({
      kind: 'keyword_drop',
      severity: lostPage1 ? 'high' : 'medium',
      title: `${fell.length} keyword(s) dropped in Google: ${fell
        .slice(0, 3)
        .map((k) => `"${k.keyword}" ${k.previous} → ${k.position ?? 'not ranking'}`)
        .join(', ')}`,
      details: { keywords: fell.slice(0, 10) },
    });
  }
  if (i.negativeReviews > 0) {
    out.push({
      kind: 'negative_reviews',
      severity: i.negativeReviews >= 3 ? 'high' : 'medium',
      title: `${i.negativeReviews} new negative review(s) (1-2 stars) this week`,
      details: { count: i.negativeReviews },
    });
  }
  const ads = i.ads;
  if (
    ads &&
    ads.changePct.cost !== null &&
    ads.changePct.cost >= 50 &&
    ads.totals.current.cost >= 1000 &&
    (ads.changePct.conversions ?? 0) <= 0
  ) {
    out.push({
      kind: 'ads_cost_spike',
      severity: 'high',
      title: `Google Ads spend up ${pct(ads.changePct.cost)} without more conversions`,
      details: {
        cost: ads.totals.current.cost,
        currency: ads.currency,
        conversionsChangePct: ads.changePct.conversions,
      },
    });
  }
  return out;
}

const parse = <T>(s: string | null | undefined): T | null => {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

/** Runs after a health check. Never throws (alerts must not fail the health check). */
export async function runAlerts(
  env: Env,
  agencyId: string,
  client: Client,
  healthCheckId: string,
  now = Date.now(),
): Promise<number> {
  try {
    const db = getDb(env);
    const current = await db.query.healthChecks.findFirst({
      where: and(eq(healthChecks.id, healthCheckId), eq(healthChecks.agencyId, agencyId)),
    });
    if (!current) return 0;
    const previous = await db.query.healthChecks.findFirst({
      where: and(
        eq(healthChecks.agencyId, agencyId),
        eq(healthChecks.clientId, client.id),
        ne(healthChecks.id, healthCheckId),
        lt(healthChecks.runAt, current.runAt),
      ),
      orderBy: desc(healthChecks.runAt),
    });
    const kw = await keywordOverview(env, agencyId, client);
    const sinceReviews = Math.max(previous?.runAt ?? 0, now - 7 * 86_400_000);
    const neg = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM reviews WHERE agency_id = ?1 AND client_id = ?2 AND star_rating <= 2 AND review_created_at >= ?3`,
    )
      .bind(agencyId, client.id, sinceReviews)
      .first<{ n: number }>();
    const ads = await latestSnapshot<AdsSummary>(env, agencyId, client.id, 'ads');

    const found = detectAnomalies({
      gsc: parse<GscSummary>(current.gscJson),
      ga4: parse<Ga4Summary>(current.ga4Json),
      psi: parse<PageSpeedSummary>(current.pagespeedJson),
      score: current.score,
      prevScore: previous?.score ?? null,
      prevMobileSpeed: parse<PageSpeedSummary>(previous?.pagespeedJson)?.mobile?.score ?? null,
      keywords: kw.keywords.map((k) => ({
        keyword: k.keyword,
        position: k.latest?.position ?? null,
        previous: k.history.length > 1 ? (k.history[k.history.length - 2]!.position ?? null) : null,
      })),
      negativeReviews: neg?.n ?? 0,
      ads: ads?.data ?? null,
    });
    if (found.length === 0) return 0;

    // Don't repeat the same kind of alert within 14 days.
    const recent = await db
      .select({ kind: alerts.kind })
      .from(alerts)
      .where(
        and(
          eq(alerts.agencyId, agencyId),
          eq(alerts.clientId, client.id),
          gte(alerts.createdAt, now - ALERT_DEDUPE_MS),
        ),
      );
    const seen = new Set(recent.map((r) => r.kind));
    const fresh = found.filter((f) => !seen.has(f.kind));
    if (fresh.length === 0) return 0;

    const context = await buildClientContext(env, agencyId, client);
    const texts = await explainAnomalies(env, fresh, context);
    const rows = fresh.map((f) => ({
      id: crypto.randomUUID(),
      agencyId,
      clientId: client.id,
      healthCheckId,
      kind: f.kind,
      severity: f.severity,
      title: f.title.slice(0, 300),
      detailsJson: JSON.stringify(f.details),
      explanation: texts.get(f.kind)?.text ?? null,
      explanationSource: texts.get(f.kind)?.source ?? null,
      createdAt: now,
    }));
    await db.insert(alerts).values(rows);
    await emailAlerts(env, agencyId, client, rows).catch((err) =>
      log.warn('Alert email failed', err, { clientId: client.id }),
    );
    return rows.length;
  } catch (err) {
    log.error('Alerts failed', err, { clientId: client.id });
    return 0;
  }
}

async function emailAlerts(
  env: Env,
  agencyId: string,
  client: Client,
  rows: { id: string; severity: string; title: string; explanation: string | null }[],
) {
  const conn = await getConnection(env, agencyId, 'agency_workspace');
  if (!conn) return; // No agency Gmail connected: alerts are only shown in the app.
  const db = getDb(env);
  const owners = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.agencyId, agencyId), eq(users.role, 'owner')));
  const to = [...new Set(owners.map((o) => o.email))].join(', ');
  if (!to) return;
  const e = escapeHtml;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#0f172a">
    <h2 style="margin:0 0 8px">⚠ ${e(client.name)}: ${rows.length} alert(s)</h2>
    <p style="color:#475569">Found by this week's health check.</p>
    ${rows
      .map(
        (
          r,
        ) => `<div style="border-left:4px solid ${r.severity === 'high' ? '#dc2626' : '#d97706'};padding:8px 12px;margin:12px 0;background:#f8fafc">
      <b>${e(r.title)}</b>${r.explanation ? `<p style="margin:6px 0 0;color:#334155">${e(r.explanation)}</p>` : ''}</div>`,
      )
      .join('')}
    <p><a href="${e(env.APP_URL)}/clients/${e(client.id)}">Open ${e(client.name)} in Agency Autopilot</a></p>
  </body></html>`;
  const token = await getAccessToken(env, conn);
  await sendGmail(
    token,
    buildMimeMessage({ to, subject: `⚠ ${client.name}: ${rows.length} alert(s) this week`, html }),
  );
  const ids = rows.map((r) => r.id);
  for (const id of ids) {
    await db
      .update(alerts)
      .set({ emailedAt: Date.now() })
      .where(and(eq(alerts.id, id), eq(alerts.agencyId, agencyId)));
  }
}
