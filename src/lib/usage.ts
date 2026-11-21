// API usage tracking for quota and cost monitoring.
// Calls are counted in memory during a request/job (AsyncLocalStorage) and written to D1 once
// at the end, so tracking costs at most one small batch of upserts per request/job.
import { AsyncLocalStorage } from 'node:async_hooks';
import { and, desc, eq, gte } from 'drizzle-orm';
import { apiUsage } from '../db/schema';
import type { Env } from '../env';
import { istDate, addDays } from './dates';
import { getDb } from './db';
import { log } from './log';

type Counter = { calls: number; errors: number; quotaErrors: number };
type UsageContext = { agencyId: string; counts: Map<string, Counter> };

const storage = new AsyncLocalStorage<UsageContext>();

export function apiNameFromUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'other';
  }
  const h = u.hostname;
  if (h === 'analyticsdata.googleapis.com') return 'ga4';
  if (h === 'analyticsadmin.googleapis.com') return 'ga4_admin';
  if (h === 'slides.googleapis.com') return 'slides';
  if (h === 'gmail.googleapis.com') return 'gmail';
  if (h === 'oauth2.googleapis.com') return 'oauth';
  if (h === 'mybusinessaccountmanagement.googleapis.com') return 'gbp_accounts';
  if (h === 'mybusinessbusinessinformation.googleapis.com') return 'gbp_info';
  if (h === 'businessprofileperformance.googleapis.com') return 'gbp_performance';
  if (h === 'mybusiness.googleapis.com') return 'gbp_reviews';
  if (h === 'places.googleapis.com') return 'places';
  if (h === 'language.googleapis.com') return 'natural_language';
  if (h === 'sheets.googleapis.com') return 'sheets';
  if (h === 'googleads.googleapis.com') return 'google_ads';
  if (h === 'youtubeanalytics.googleapis.com') return 'youtube_analytics';
  if (h === 'www.googleapis.com') {
    if (u.pathname.startsWith('/webmasters')) return 'gsc';
    if (u.pathname.startsWith('/pagespeedonline')) return 'pagespeed';
    if (u.pathname.startsWith('/drive')) return 'drive';
    if (u.pathname.startsWith('/youtube')) return 'youtube_data';
  }
  return 'other';
}

/** Records one API call in the current tracking context (no-op outside one). */
export function recordApiCall(api: string, outcome: { ok: boolean; status?: number }) {
  const ctx = storage.getStore();
  if (!ctx) return;
  const c = ctx.counts.get(api) ?? { calls: 0, errors: 0, quotaErrors: 0 };
  c.calls++;
  if (!outcome.ok) c.errors++;
  if (outcome.status === 429) c.quotaErrors++;
  ctx.counts.set(api, c);
}

async function flush(env: Pick<Env, 'DB'>, ctx: UsageContext) {
  if (ctx.counts.size === 0) return;
  const day = istDate(Date.now());
  const stmt = env.DB.prepare(
    `INSERT INTO api_usage (id, agency_id, api, day, calls, errors, quota_errors)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (agency_id, api, day) DO UPDATE SET
       calls = calls + excluded.calls,
       errors = errors + excluded.errors,
       quota_errors = quota_errors + excluded.quota_errors`,
  );
  try {
    await env.DB.batch(
      [...ctx.counts.entries()].map(([api, c]) =>
        stmt.bind(crypto.randomUUID(), ctx.agencyId, api, day, c.calls, c.errors, c.quotaErrors),
      ),
    );
  } catch (err) {
    log.warn('Could not save API usage counters', err);
  }
}

/** Runs fn with API usage tracking for the given agency and saves the counters afterwards. */
export async function withUsageTracking<T>(
  env: Pick<Env, 'DB'>,
  agencyId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx: UsageContext = { agencyId, counts: new Map() };
  try {
    return await storage.run(ctx, fn);
  } finally {
    await flush(env, ctx);
  }
}

/** Usage rows for the last `days` days (IST), newest first. */
export async function getUsage(env: Pick<Env, 'DB'>, agencyId: string, days = 7) {
  const since = addDays(istDate(Date.now()), -(days - 1));
  return getDb(env)
    .select({
      api: apiUsage.api,
      day: apiUsage.day,
      calls: apiUsage.calls,
      errors: apiUsage.errors,
      quotaErrors: apiUsage.quotaErrors,
    })
    .from(apiUsage)
    .where(and(eq(apiUsage.agencyId, agencyId), gte(apiUsage.day, since)))
    .orderBy(desc(apiUsage.day), apiUsage.api);
}
