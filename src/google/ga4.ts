import { comparePeriods, pctChange, round, type DateRange } from '../lib/dates';
import { googleRequest } from './http';

export type Ga4Property = { id: string; name: string; account: string };

/** Lists GA4 properties the connected account can read (Admin API account summaries). */
export async function listGa4Properties(accessToken: string): Promise<Ga4Property[]> {
  const out: Ga4Property[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL('https://analyticsadmin.googleapis.com/v1beta/accountSummaries');
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await googleRequest<{
      accountSummaries?: {
        displayName: string;
        propertySummaries?: { property: string; displayName: string }[];
      }[];
      nextPageToken?: string;
    }>(url.toString(), { accessToken });
    for (const acc of data.accountSummaries ?? []) {
      for (const p of acc.propertySummaries ?? []) {
        out.push({
          id: p.property.replace('properties/', ''),
          name: p.displayName,
          account: acc.displayName,
        });
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

type ReportRow = { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] };
type Report = { rows?: ReportRow[] };

async function runReport(token: string, propertyId: string, body: object): Promise<Report> {
  return googleRequest<Report>(
    `https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`,
    { accessToken: token, json: body },
  );
}

export type Ga4Totals = {
  sessions: number;
  users: number;
  keyEvents: number;
  engagementRate: number;
  newUsers: number;
};

export type Ga4Summary = {
  propertyId: string;
  period: { current: DateRange; previous: DateRange };
  totals: { current: Ga4Totals; previous: Ga4Totals };
  sessionsChangePct: number | null;
  usersChangePct: number | null;
  newUsersChangePct: number | null;
  keyEventsChangePct: number | null;
  /** Sessions from the "Organic Search" channel (null if the report wasn't available). */
  organicSessions: { current: number; previous: number; changePct: number | null } | null;
  topChannels: { channel: string; sessions: number }[];
  topLandingPages: { page: string; sessions: number; keyEvents: number }[];
  dailySessions: { date: string; sessions: number }[];
};

const num = (row: ReportRow | undefined, i: number) => Number(row?.metricValues?.[i]?.value ?? 0);
const dim = (row: ReportRow, i = 0) => row.dimensionValues?.[i]?.value ?? '';

export async function fetchGa4Summary(
  token: string,
  propertyId: string,
  now = Date.now(),
): Promise<Ga4Summary> {
  const period = comparePeriods(now, 1); // up to yesterday
  const cur = { startDate: period.current.start, endDate: period.current.end };
  const metrics = [
    { name: 'sessions' },
    { name: 'totalUsers' },
    { name: 'keyEvents' },
    { name: 'engagementRate' },
    { name: 'newUsers' },
  ];
  const bothRanges = [
    { ...cur, name: 'current' },
    { startDate: period.previous.start, endDate: period.previous.end, name: 'previous' },
  ];

  const [totals, channels, landing, daily, organic] = await Promise.all([
    runReport(token, propertyId, { dateRanges: bothRanges, metrics }),
    runReport(token, propertyId, {
      dateRanges: [cur],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 6,
    }),
    runReport(token, propertyId, {
      dateRanges: [cur],
      dimensions: [{ name: 'landingPage' }],
      metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 5,
    }),
    runReport(token, propertyId, {
      dateRanges: [cur],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      limit: 100,
    }),
    runReport(token, propertyId, {
      dateRanges: bothRanges,
      metrics: [{ name: 'sessions' }],
      dimensionFilter: {
        filter: {
          fieldName: 'sessionDefaultChannelGroup',
          stringFilter: { matchType: 'EXACT', value: 'Organic Search' },
        },
      },
    }),
  ]);
  return summarizeGa4({ propertyId, period, totals, channels, landing, daily, organic });
}

/** Pure function (unit-tested): GA4 reports -> compact summary. */
export function summarizeGa4(input: {
  propertyId: string;
  period: { current: DateRange; previous: DateRange };
  totals: Report;
  channels: Report;
  landing: Report;
  daily: Report;
  organic?: Report;
}): Ga4Summary {
  // With two named date ranges GA4 adds a "dateRange" dimension to each row.
  const rows = input.totals.rows ?? [];
  const pick = (name: string): Ga4Totals => {
    const r = rows.find((x) => dim(x) === name);
    return {
      sessions: num(r, 0),
      users: num(r, 1),
      keyEvents: num(r, 2),
      engagementRate: round(num(r, 3) * 100),
      newUsers: num(r, 4),
    };
  };
  const organicRows = input.organic?.rows;
  const organicOf = (name: string) => num(organicRows?.find((x) => dim(x) === name), 0);
  const current = pick('current');
  const previous = pick('previous');
  const change = (a: number, b: number) => {
    const p = pctChange(a, b);
    return p === null ? null : round(p);
  };

  return {
    propertyId: input.propertyId,
    period: input.period,
    totals: { current, previous },
    sessionsChangePct: change(current.sessions, previous.sessions),
    usersChangePct: change(current.users, previous.users),
    newUsersChangePct: change(current.newUsers, previous.newUsers),
    keyEventsChangePct: change(current.keyEvents, previous.keyEvents),
    organicSessions: input.organic
      ? {
          current: organicOf('current'),
          previous: organicOf('previous'),
          changePct: change(organicOf('current'), organicOf('previous')),
        }
      : null,
    topChannels: (input.channels.rows ?? []).map((r) => ({ channel: dim(r), sessions: num(r, 0) })),
    topLandingPages: (input.landing.rows ?? []).map((r) => ({
      page: dim(r),
      sessions: num(r, 0),
      keyEvents: num(r, 1),
    })),
    dailySessions: (input.daily.rows ?? []).map((r) => {
      const d = dim(r); // YYYYMMDD
      return { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, sessions: num(r, 0) };
    }),
  };
}
