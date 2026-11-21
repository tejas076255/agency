import { comparePeriods, pctChange, round, type DateRange } from '../lib/dates';
import { googleRequest } from './http';

const BASE = 'https://www.googleapis.com/webmasters/v3';

export type GscSite = { siteUrl: string; permissionLevel: string };

export async function listGscSites(accessToken: string): Promise<GscSite[]> {
  const data = await googleRequest<{ siteEntry?: GscSite[] }>(`${BASE}/sites`, { accessToken });
  return (data.siteEntry ?? [])
    .filter((s) => s.permissionLevel !== 'siteUnverifiedUser')
    .sort((a, b) => a.siteUrl.localeCompare(b.siteUrl));
}

type Row = { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number };
export type GscTotals = { clicks: number; impressions: number; ctr: number; position: number };

export type GscSummary = {
  siteUrl: string;
  period: { current: DateRange; previous: DateRange };
  totals: { current: GscTotals; previous: GscTotals };
  clicksChangePct: number | null;
  impressionsChangePct: number | null;
  topQueries: {
    query: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }[];
  /** Keywords ranking at positions 8-20 with decent impressions: small push = page 1 / top 5. */
  topPages: { page: string; clicks: number; impressions: number; ctr: number; position: number }[];
  quickWins: { query: string; impressions: number; clicks: number; position: number }[];
  /** Pages that lost the most clicks vs the previous period. */
  droppingPages: { page: string; clicksNow: number; clicksBefore: number; change: number }[];
  dailyClicks: { date: string; clicks: number }[];
};

async function query(
  token: string,
  siteUrl: string,
  range: DateRange,
  dimensions: string[],
  rowLimit = 1000,
) {
  const data = await googleRequest<{ rows?: Row[] }>(
    `${BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      accessToken: token,
      json: {
        startDate: range.start,
        endDate: range.end,
        dimensions,
        rowLimit,
        dataState: 'final',
      },
    },
  );
  return data.rows ?? [];
}

const totalsOf = (rows: Row[]): GscTotals => {
  const r = rows[0];
  return r
    ? { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }
    : { clicks: 0, impressions: 0, ctr: 0, position: 0 };
};

export async function fetchGscSummary(
  token: string,
  siteUrl: string,
  now = Date.now(),
): Promise<GscSummary> {
  // Search Console data lags ~2-3 days, so the current period ends 3 days ago.
  const period = comparePeriods(now, 3);
  const [totCur, totPrev, queries, pagesCur, pagesPrev, daily] = await Promise.all([
    query(token, siteUrl, period.current, []),
    query(token, siteUrl, period.previous, []),
    query(token, siteUrl, period.current, ['query'], 1000),
    query(token, siteUrl, period.current, ['page'], 500),
    query(token, siteUrl, period.previous, ['page'], 500),
    query(token, siteUrl, period.current, ['date'], 100),
  ]);
  return summarizeGsc({ siteUrl, period, totCur, totPrev, queries, pagesCur, pagesPrev, daily });
}

/** Pure function (unit-tested): raw Search Console rows -> compact summary. */
export function summarizeGsc(input: {
  siteUrl: string;
  period: { current: DateRange; previous: DateRange };
  totCur: Row[];
  totPrev: Row[];
  queries: Row[];
  pagesCur: Row[];
  pagesPrev: Row[];
  daily: Row[];
}): GscSummary {
  const current = totalsOf(input.totCur);
  const previous = totalsOf(input.totPrev);
  const key = (r: Row) => r.keys?.[0] ?? '';

  const topQueries = [...input.queries]
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10)
    .map((r) => ({
      query: key(r),
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: round(r.ctr * 100, 2),
      position: round(r.position),
    }));

  const quickWins = input.queries
    .filter((r) => r.position >= 8 && r.position <= 20 && r.impressions >= 20)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 10)
    .map((r) => ({
      query: key(r),
      impressions: r.impressions,
      clicks: r.clicks,
      position: round(r.position),
    }));

  const topPages = [...input.pagesCur]
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10)
    .map((r) => ({
      page: key(r),
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: round(r.ctr * 100, 2),
      position: round(r.position),
    }));

  const before = new Map(input.pagesPrev.map((r) => [key(r), r.clicks]));
  const now = new Map(input.pagesCur.map((r) => [key(r), r.clicks]));
  const droppingPages = [...before.entries()]
    .map(([page, clicksBefore]) => {
      const clicksNow = now.get(page) ?? 0;
      return { page, clicksNow, clicksBefore, change: clicksNow - clicksBefore };
    })
    .filter((p) => p.change < 0)
    .sort((a, b) => a.change - b.change)
    .slice(0, 5);

  const dailyClicks = [...input.daily]
    .map((r) => ({ date: key(r), clicks: r.clicks }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    siteUrl: input.siteUrl,
    period: input.period,
    totals: { current, previous },
    clicksChangePct: nullableRound(pctChange(current.clicks, previous.clicks)),
    impressionsChangePct: nullableRound(pctChange(current.impressions, previous.impressions)),
    topQueries,
    topPages,
    quickWins,
    droppingPages,
    dailyClicks,
  };
}

const nullableRound = (n: number | null) => (n === null ? null : round(n));
