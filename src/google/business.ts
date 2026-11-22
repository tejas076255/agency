// Google Business Profile (Phase 2): Account Management, Business Information, Performance,
// and reviews (My Business v4). All need OAuth scope business.manage AND Google's approval of
// Business Profile API access for the Cloud project (quota is 0 until approved).
import { comparePeriods, pctChange, round, type DateRange } from '../lib/dates';
import { googleRequest, GoogleApiError } from './http';

export class GbpNotApprovedError extends Error {
  constructor() {
    super(
      'Business Profile API access is not approved for this Google Cloud project yet (quota is 0). Apply at https://developers.google.com/my-business/content/prereqs',
    );
    this.name = 'GbpNotApprovedError';
  }
}

/** Google returns 429 "quota 0" or 403 for projects without Business Profile API access. */
function translate(err: unknown): never {
  if (err instanceof GoogleApiError) {
    const m = err.message.toLowerCase();
    if (
      (err.status === 429 && (m.includes('quota') || m.includes('rate'))) ||
      (err.status === 403 &&
        (m.includes('has not been used') ||
          m.includes('disabled') ||
          m.includes('not been approved')))
    ) {
      throw new GbpNotApprovedError();
    }
  }
  throw err;
}

async function gbp<T>(
  url: string,
  token: string,
  opts: { method?: 'GET' | 'PUT'; json?: unknown } = {},
) {
  try {
    // Low default quotas: only 1 retry so we don't burn the per-minute quota.
    return await googleRequest<T>(url, { accessToken: token, retries: 1, ...opts });
  } catch (err) {
    translate(err);
  }
}

export type GbpAccount = {
  name: string;
  accountName: string;
  /** PERSONAL, LOCATION_GROUP, USER_GROUP or ORGANIZATION */
  type?: string;
  /** The signed-in user's role on the account: PRIMARY_OWNER, OWNER, MANAGER, SITE_MANAGER */
  role?: string;
  verificationState?: string;
  vettedState?: string;
};
export type GbpLocationOption = {
  name: string;
  title: string;
  address: string;
  accountName: string;
};

export async function listGbpAccounts(token: string): Promise<GbpAccount[]> {
  const out: GbpAccount[] = [];
  let pageToken: string | undefined;
  do {
    const u = new URL('https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
    u.searchParams.set('pageSize', '20');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const data = await gbp<{ accounts?: GbpAccount[]; nextPageToken?: string }>(
      u.toString(),
      token,
    );
    out.push(...(data?.accounts ?? []));
    pageToken = data?.nextPageToken;
  } while (pageToken && out.length < 100);
  return out;
}

type RawLocation = {
  name: string;
  title?: string;
  storefrontAddress?: {
    addressLines?: string[];
    locality?: string;
    administrativeArea?: string;
    postalCode?: string;
  };
  phoneNumbers?: { primaryPhone?: string };
  websiteUri?: string;
  categories?: {
    primaryCategory?: { displayName?: string };
    additionalCategories?: { displayName?: string }[];
  };
  regularHours?: {
    periods?: {
      openDay?: string;
      openTime?: { hours?: number; minutes?: number };
      closeTime?: { hours?: number; minutes?: number };
    }[];
  };
  openInfo?: { status?: string };
  metadata?: { mapsUri?: string; placeId?: string; hasVoiceOfMerchant?: boolean };
};

const READ_MASK =
  'name,title,storefrontAddress,phoneNumbers,websiteUri,categories,regularHours,openInfo,metadata';

export function formatAddress(a: RawLocation['storefrontAddress']): string {
  if (!a) return '';
  return [...(a.addressLines ?? []), a.locality, a.administrativeArea, a.postalCode]
    .filter(Boolean)
    .join(', ');
}

export async function listGbpLocations(
  token: string,
  accountName: string,
): Promise<GbpLocationOption[]> {
  const out: GbpLocationOption[] = [];
  let pageToken: string | undefined;
  do {
    const u = new URL(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations`,
    );
    u.searchParams.set('readMask', 'name,title,storefrontAddress');
    u.searchParams.set('pageSize', '100');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const data = await gbp<{ locations?: RawLocation[]; nextPageToken?: string }>(
      u.toString(),
      token,
    );
    for (const l of data?.locations ?? []) {
      out.push({
        name: l.name,
        title: l.title ?? l.name,
        address: formatAddress(l.storefrontAddress),
        accountName,
      });
    }
    pageToken = data?.nextPageToken;
  } while (pageToken && out.length < 500);
  return out;
}

export const GBP_METRICS = {
  impressions: [
    'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
    'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
    'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
    'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  ],
  calls: ['CALL_CLICKS'],
  directions: ['BUSINESS_DIRECTION_REQUESTS'],
  websiteClicks: ['WEBSITE_CLICKS'],
  conversations: ['BUSINESS_CONVERSATIONS'],
} as const;
type MetricKey = keyof typeof GBP_METRICS;
type Totals = Record<MetricKey, number>;

type RawPerformance = {
  multiDailyMetricTimeSeries?: {
    dailyMetricTimeSeries?: {
      dailyMetric?: string;
      timeSeries?: {
        datedValues?: { date?: { year: number; month: number; day: number }; value?: string }[];
      };
    }[];
  }[];
};

export type GbpSummary = {
  /** Calls that failed in this sync (partial data). Empty/missing when everything worked. */
  failures?: GbpCallFailure[];
  location: {
    name: string;
    title: string;
    address: string;
    phone: string | null;
    website: string | null;
    primaryCategory: string | null;
    additionalCategories: string[];
    openStatus: string | null;
    mapsUri: string | null;
    hoursSet: boolean;
  };
  period: { current: DateRange; previous: DateRange };
  totals: { current: Totals; previous: Totals };
  changePct: Record<MetricKey, number | null>;
  daily: {
    date: string;
    impressions: number;
    calls: number;
    directions: number;
    websiteClicks: number;
  }[];
  reviews: { averageRating: number | null; totalReviewCount: number | null };
};

const emptyTotals = (): Totals => ({
  impressions: 0,
  calls: 0,
  directions: 0,
  websiteClicks: 0,
  conversations: 0,
});

/** Pure (unit-tested): performance time series + location info -> compact summary. */
export function summarizeGbp(input: {
  location: RawLocation;
  performance: RawPerformance;
  period: { current: DateRange; previous: DateRange };
  reviews: { averageRating?: number; totalReviewCount?: number };
}): GbpSummary {
  const metricToKey = new Map<string, MetricKey>();
  for (const [k, list] of Object.entries(GBP_METRICS))
    for (const m of list) metricToKey.set(m, k as MetricKey);

  const current = emptyTotals();
  const previous = emptyTotals();
  const byDay = new Map<string, GbpSummary['daily'][number]>();
  for (const multi of input.performance.multiDailyMetricTimeSeries ?? []) {
    for (const series of multi.dailyMetricTimeSeries ?? []) {
      const key = metricToKey.get(series.dailyMetric ?? '');
      if (!key) continue;
      for (const dv of series.timeSeries?.datedValues ?? []) {
        if (!dv.date) continue;
        const d = `${dv.date.year}-${String(dv.date.month).padStart(2, '0')}-${String(dv.date.day).padStart(2, '0')}`;
        const v = Number(dv.value ?? 0) || 0; // Google omits value when it is 0
        if (d >= input.period.current.start && d <= input.period.current.end) {
          current[key] += v;
          if (key !== 'conversations') {
            const row = byDay.get(d) ?? {
              date: d,
              impressions: 0,
              calls: 0,
              directions: 0,
              websiteClicks: 0,
            };
            row[key] += v;
            byDay.set(d, row);
          }
        } else if (d >= input.period.previous.start && d <= input.period.previous.end) {
          previous[key] += v;
        }
      }
    }
  }
  const changePct = Object.fromEntries(
    (Object.keys(current) as MetricKey[]).map((k) => {
      const p = pctChange(current[k], previous[k]);
      return [k, p === null ? null : round(p)];
    }),
  ) as Record<MetricKey, number | null>;

  const l = input.location;
  return {
    location: {
      name: l.name,
      title: l.title ?? l.name,
      address: formatAddress(l.storefrontAddress),
      phone: l.phoneNumbers?.primaryPhone ?? null,
      website: l.websiteUri ?? null,
      primaryCategory: l.categories?.primaryCategory?.displayName ?? null,
      additionalCategories: (l.categories?.additionalCategories ?? [])
        .map((c) => c.displayName ?? '')
        .filter(Boolean),
      openStatus: l.openInfo?.status ?? null,
      mapsUri: l.metadata?.mapsUri ?? null,
      hoursSet: (l.regularHours?.periods?.length ?? 0) > 0,
    },
    period: input.period,
    totals: { current, previous },
    changePct,
    daily: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    reviews: {
      averageRating: input.reviews.averageRating ?? null,
      totalReviewCount: input.reviews.totalReviewCount ?? null,
    },
  };
}

export type RawReview = {
  name: string;
  reviewId?: string;
  reviewer?: { displayName?: string };
  starRating?: 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE' | 'STAR_RATING_UNSPECIFIED';
  comment?: string;
  createTime?: string;
  updateTime?: string;
  reviewReply?: { comment?: string; updateTime?: string };
};

export const STARS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

/** Google appends "(Translated by Google)" blocks to reviews; keep only the original text. */
export function originalReviewText(comment: string | undefined): string | null {
  if (!comment) return null;
  const marker = comment.indexOf('(Translated by Google)');
  const original = comment.indexOf('(Original)');
  if (original !== -1) return comment.slice(original + '(Original)'.length).trim() || null;
  if (marker !== -1) return comment.slice(0, marker).trim() || null;
  return comment.trim() || null;
}

export async function listReviews(token: string, accountName: string, locationName: string) {
  const reviewsOut: RawReview[] = [];
  let averageRating: number | undefined;
  let totalReviewCount: number | undefined;
  let pageToken: string | undefined;
  do {
    const u = new URL(
      `https://mybusiness.googleapis.com/v4/${gbpReviewsPath(accountName, locationName)}/reviews`,
    );
    u.searchParams.set('pageSize', '50');
    u.searchParams.set('orderBy', 'updateTime desc');
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const data = await gbp<{
      reviews?: RawReview[];
      averageRating?: number;
      totalReviewCount?: number;
      nextPageToken?: string;
    }>(u.toString(), token);
    reviewsOut.push(...(data?.reviews ?? []));
    averageRating ??= data?.averageRating;
    totalReviewCount ??= data?.totalReviewCount;
    pageToken = data?.nextPageToken;
  } while (pageToken && reviewsOut.length < 200); // newest 200 per sync
  return { reviews: reviewsOut, averageRating, totalReviewCount };
}

export async function replyToReview(token: string, reviewName: string, comment: string) {
  await gbp(`https://mybusiness.googleapis.com/v4/${reviewName}/reply`, token, {
    method: 'PUT',
    json: { comment },
  });
}

/** One failed Business Profile call, with everything needed to debug it. */
export type GbpCallFailure = {
  call: 'business_information' | 'performance' | 'reviews';
  endpoint: string;
  status: number | null;
  reason: string;
  message: string;
  body: string | null;
};

export const GBP_CALL_LABEL: Record<GbpCallFailure['call'], string> = {
  business_information: 'Business Information API (locations.get)',
  performance: 'Business Profile Performance API (fetchMultiDailyMetricsTimeSeries)',
  reviews: 'My Business API v4 (accounts.locations.reviews.list)',
};

export function toCallFailure(call: GbpCallFailure['call'], err: unknown): GbpCallFailure {
  if (err instanceof GoogleApiError) {
    return {
      call,
      endpoint: err.endpoint ?? '',
      status: err.status,
      reason: err.reason,
      message: err.message,
      body: err.body ?? null,
    };
  }
  return {
    call,
    endpoint: '',
    status: null,
    reason: 'error',
    message: (err as Error)?.message ?? String(err),
    body: null,
  };
}

export function gbpInfoUrl(locationName: string) {
  return `https://mybusinessbusinessinformation.googleapis.com/v1/${locationName}?readMask=${READ_MASK}`;
}

/** v4 reviews always use the account + location path: accounts/{accountId}/locations/{locationId}/reviews */
export function gbpReviewsPath(accountName: string, locationName: string) {
  if (!/^accounts\/\d+$/.test(accountName) || !/^locations\/\d+$/.test(locationName)) {
    throw new Error(`Invalid Business Profile names: ${accountName} / ${locationName}`);
  }
  return `${accountName}/${locationName}`;
}

export function gbpPerformanceUrl(
  locationName: string,
  period: { current: DateRange; previous: DateRange },
) {
  const perfUrl = new URL(
    `https://businessprofileperformance.googleapis.com/v1/${locationName}:fetchMultiDailyMetricsTimeSeries`,
  );
  for (const list of Object.values(GBP_METRICS))
    for (const m of list) perfUrl.searchParams.append('dailyMetrics', m);
  const [sy, sm, sd] = period.previous.start.split('-').map(Number) as [number, number, number];
  const [ey, em, ed] = period.current.end.split('-').map(Number) as [number, number, number];
  perfUrl.searchParams.set('dailyRange.startDate.year', String(sy));
  perfUrl.searchParams.set('dailyRange.startDate.month', String(sm));
  perfUrl.searchParams.set('dailyRange.startDate.day', String(sd));
  perfUrl.searchParams.set('dailyRange.endDate.year', String(ey));
  perfUrl.searchParams.set('dailyRange.endDate.month', String(em));
  perfUrl.searchParams.set('dailyRange.endDate.day', String(ed));
  return perfUrl.toString();
}

/**
 * Fetches listing info, performance and reviews independently. If some calls fail, the others
 * are still returned (partial data) together with the exact failures. Throws only if all fail.
 */
export async function fetchGbpSummary(
  token: string,
  accountName: string,
  locationName: string,
  now = Date.now(),
): Promise<{ summary: GbpSummary; reviews: RawReview[]; failures: GbpCallFailure[] }> {
  // Performance data is a few days behind, like Search Console.
  const period = comparePeriods(now, 3);
  const [info, perf, rev] = await Promise.allSettled([
    gbp<RawLocation>(gbpInfoUrl(locationName), token),
    gbp<RawPerformance>(gbpPerformanceUrl(locationName, period), token),
    listReviews(token, accountName, locationName),
  ]);
  const failures: GbpCallFailure[] = [];
  if (info.status === 'rejected') failures.push(toCallFailure('business_information', info.reason));
  if (perf.status === 'rejected') failures.push(toCallFailure('performance', perf.reason));
  if (rev.status === 'rejected') failures.push(toCallFailure('reviews', rev.reason));

  if (failures.length === 3) {
    // Not-approved projects fail everything the same way: keep that clear message.
    const first = [info, perf, rev].find((r) => r.status === 'rejected') as PromiseRejectedResult;
    if (first.reason instanceof GbpNotApprovedError) throw first.reason;
    throw new GbpSyncError(failures);
  }

  const reviewsData: { reviews: RawReview[]; averageRating?: number; totalReviewCount?: number } =
    rev.status === 'fulfilled' ? rev.value : { reviews: [] };
  return {
    summary: summarizeGbp({
      location: (info.status === 'fulfilled' ? info.value : undefined) ?? { name: locationName },
      performance: (perf.status === 'fulfilled' ? perf.value : undefined) ?? {},
      period,
      reviews: reviewsData,
    }),
    reviews: reviewsData.reviews,
    failures,
  };
}

/** Human-readable one-liner per failed call (stored on the snapshot / shown in the UI). */
export function describeGbpFailures(failures: GbpCallFailure[]): string {
  return failures
    .map((f) =>
      `${GBP_CALL_LABEL[f.call]} failed: ${f.status ?? ''} ${f.reason} - ${f.message}`.replace(
        /\s+/g,
        ' ',
      ),
    )
    .join(' | ');
}

export class GbpSyncError extends Error {
  constructor(public readonly failures: GbpCallFailure[]) {
    super(describeGbpFailures(failures));
    this.name = 'GbpSyncError';
  }
}
