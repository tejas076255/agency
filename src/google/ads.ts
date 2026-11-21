// Google Ads API (Phase 3), REST interface with GAQL.
// Needs: OAuth scope adwords + a developer token from a Google Ads MANAGER account.
// A new token only has "Test Account Access"; real client accounts need Basic Access approval.
import type { Env } from '../env';
import { comparePeriods, pctChange, round, type DateRange } from '../lib/dates';
import { googleRequest, GoogleApiError } from './http';

export class AdsNotConfiguredError extends Error {
  constructor(msg = 'Google Ads is not configured: set the GOOGLE_ADS_DEVELOPER_TOKEN secret.') {
    super(msg);
    this.name = 'AdsNotConfiguredError';
  }
}

type AdsEnv = Pick<
  Env,
  'GOOGLE_ADS_DEVELOPER_TOKEN' | 'GOOGLE_ADS_LOGIN_CUSTOMER_ID' | 'GOOGLE_ADS_API_VERSION'
>;

function base(env: AdsEnv) {
  return `https://googleads.googleapis.com/${env.GOOGLE_ADS_API_VERSION || 'v21'}`;
}

function headers(env: AdsEnv): Record<string, string> {
  if (!env.GOOGLE_ADS_DEVELOPER_TOKEN) throw new AdsNotConfiguredError();
  const h: Record<string, string> = { 'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN };
  if (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID)
    h['login-customer-id'] = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/-/g, '');
  return h;
}

function explain(err: unknown): never {
  if (
    err instanceof GoogleApiError &&
    /DEVELOPER_TOKEN_NOT_APPROVED|test account/i.test(err.message + err.reason)
  ) {
    throw new AdsNotConfiguredError(
      'Your Google Ads developer token only has Test Account Access. Apply for Basic Access to read real client accounts.',
    );
  }
  throw err;
}

export async function listAdsCustomers(env: AdsEnv, token: string) {
  try {
    const data = await googleRequest<{ resourceNames?: string[] }>(
      `${base(env)}/customers:listAccessibleCustomers`,
      {
        accessToken: token,
        headers: headers(env),
        retries: 1,
      },
    );
    const ids = (data.resourceNames ?? []).map((r) => r.replace('customers/', '')).slice(0, 50);
    // Names need one small query per account (managers cannot be queried for metrics).
    const out = await Promise.all(
      ids.map(async (id) => {
        try {
          const r = await gaql<{
            customer?: { descriptiveName?: string; currencyCode?: string; manager?: boolean };
          }>(
            env,
            token,
            id,
            'SELECT customer.descriptive_name, customer.currency_code, customer.manager FROM customer LIMIT 1',
          );
          const c = r[0]?.customer;
          return {
            id,
            name: c?.descriptiveName || id,
            currency: c?.currencyCode ?? null,
            manager: Boolean(c?.manager),
          };
        } catch {
          return { id, name: id, currency: null, manager: false };
        }
      }),
    );
    return out;
  } catch (err) {
    explain(err);
  }
}

export async function gaql<T>(
  env: AdsEnv,
  token: string,
  customerId: string,
  query: string,
): Promise<T[]> {
  if (!/^\d{10}$/.test(customerId)) throw new Error('Invalid Google Ads customer ID');
  try {
    const out: T[] = [];
    let pageToken: string | undefined;
    do {
      const data = await googleRequest<{ results?: T[]; nextPageToken?: string }>(
        `${base(env)}/customers/${customerId}/googleAds:search`,
        {
          accessToken: token,
          headers: headers(env),
          json: { query, ...(pageToken ? { pageToken } : {}) },
          retries: 2,
        },
      );
      out.push(...(data.results ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken && out.length < 5000);
    return out;
  } catch (err) {
    explain(err);
  }
}

type M = {
  impressions?: string;
  clicks?: string;
  costMicros?: string;
  conversions?: number;
  conversionsValue?: number;
};
type Totals = {
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  conversionValue: number;
};

const toTotals = (m: M | undefined): Totals => ({
  impressions: Number(m?.impressions ?? 0),
  clicks: Number(m?.clicks ?? 0),
  cost: Number(m?.costMicros ?? 0) / 1e6,
  conversions: Number(m?.conversions ?? 0),
  conversionValue: Number(m?.conversionsValue ?? 0),
});

export type AdsSummary = {
  customerId: string;
  currency: string;
  period: { current: DateRange; previous: DateRange };
  totals: { current: Totals; previous: Totals };
  derived: {
    ctrPct: number | null;
    avgCpc: number | null;
    costPerConversion: number | null;
    roas: number | null;
  };
  changePct: { cost: number | null; clicks: number | null; conversions: number | null };
  campaigns: {
    id: string;
    name: string;
    status: string;
    cost: number;
    clicks: number;
    impressions: number;
    conversions: number;
    conversionValue: number;
    dailyBudget: number | null;
    budgetUtilizationPct: number | null;
  }[];
  wastedSearchTerms: { term: string; campaign: string; cost: number; clicks: number }[];
  wastedSpend: number;
  daily: { date: string; cost: number; clicks: number; conversions: number }[];
};

const ratio = (a: number, b: number) => (b > 0 ? round(a / b, 2) : null);

/** Pure (unit-tested): GAQL rows -> compact summary. */
export function summarizeAds(input: {
  customerId: string;
  currency: string;
  period: { current: DateRange; previous: DateRange };
  days: number;
  totalsCurrent: { metrics?: M }[];
  totalsPrevious: { metrics?: M }[];
  campaigns: {
    campaign?: { id?: string; name?: string; status?: string };
    campaignBudget?: { amountMicros?: string };
    metrics?: M;
  }[];
  searchTerms: {
    searchTermView?: { searchTerm?: string };
    campaign?: { name?: string };
    metrics?: M;
  }[];
  daily: { segments?: { date?: string }; metrics?: M }[];
}): AdsSummary {
  const sum = (rows: { metrics?: M }[]) =>
    rows
      .map((r) => toTotals(r.metrics))
      .reduce(
        (a, b) => ({
          impressions: a.impressions + b.impressions,
          clicks: a.clicks + b.clicks,
          cost: a.cost + b.cost,
          conversions: a.conversions + b.conversions,
          conversionValue: a.conversionValue + b.conversionValue,
        }),
        toTotals(undefined),
      );
  const current = sum(input.totalsCurrent);
  const previous = sum(input.totalsPrevious);
  const ch = (a: number, b: number) => {
    const p = pctChange(a, b);
    return p === null ? null : round(p);
  };

  const campaigns = input.campaigns
    .map((c) => {
      const t = toTotals(c.metrics);
      const dailyBudget = c.campaignBudget?.amountMicros
        ? Number(c.campaignBudget.amountMicros) / 1e6
        : null;
      return {
        id: c.campaign?.id ?? '',
        name: c.campaign?.name ?? '(unnamed)',
        status: c.campaign?.status ?? 'UNKNOWN',
        cost: round(t.cost, 2),
        clicks: t.clicks,
        impressions: t.impressions,
        conversions: round(t.conversions, 2),
        conversionValue: round(t.conversionValue, 2),
        dailyBudget,
        budgetUtilizationPct: dailyBudget
          ? round((t.cost / (dailyBudget * input.days)) * 100)
          : null,
      };
    })
    .sort((a, b) => b.cost - a.cost);

  const wasted = input.searchTerms
    .map((r) => ({
      term: r.searchTermView?.searchTerm ?? '',
      campaign: r.campaign?.name ?? '',
      cost: round(toTotals(r.metrics).cost, 2),
      clicks: toTotals(r.metrics).clicks,
      conversions: toTotals(r.metrics).conversions,
    }))
    .filter((r) => r.term && r.cost > 0 && r.conversions === 0)
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 20)
    .map(({ conversions: _c, ...r }) => r);

  return {
    customerId: input.customerId,
    currency: input.currency,
    period: input.period,
    totals: {
      current: { ...current, cost: round(current.cost, 2) },
      previous: { ...previous, cost: round(previous.cost, 2) },
    },
    derived: {
      ctrPct:
        current.impressions > 0 ? round((current.clicks / current.impressions) * 100, 2) : null,
      avgCpc: ratio(current.cost, current.clicks),
      costPerConversion: ratio(current.cost, current.conversions),
      // ROAS only when conversion values are tracked.
      roas: current.conversionValue > 0 ? ratio(current.conversionValue, current.cost) : null,
    },
    changePct: {
      cost: ch(current.cost, previous.cost),
      clicks: ch(current.clicks, previous.clicks),
      conversions: ch(current.conversions, previous.conversions),
    },
    campaigns: campaigns.slice(0, 25),
    wastedSearchTerms: wasted,
    wastedSpend: round(
      wasted.reduce((s, w) => s + w.cost, 0),
      2,
    ),
    daily: input.daily
      .map((r) => ({ date: r.segments?.date ?? '', ...toTotals(r.metrics) }))
      .filter((r) => r.date)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => ({
        date: r.date,
        cost: round(r.cost, 2),
        clicks: r.clicks,
        conversions: round(r.conversions, 2),
      })),
  };
}

export async function fetchAdsSummary(
  env: AdsEnv,
  token: string,
  customerId: string,
  now = Date.now(),
): Promise<AdsSummary> {
  const period = comparePeriods(now, 1);
  const cur = `segments.date BETWEEN '${period.current.start}' AND '${period.current.end}'`;
  const prev = `segments.date BETWEEN '${period.previous.start}' AND '${period.previous.end}'`;
  const m =
    'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value';
  const [cust, totalsCurrent, totalsPrevious, campaigns, searchTerms, daily] = await Promise.all([
    gaql<{ customer?: { currencyCode?: string } }>(
      env,
      token,
      customerId,
      'SELECT customer.currency_code FROM customer LIMIT 1',
    ),
    gaql<{ metrics?: M }>(env, token, customerId, `SELECT ${m} FROM customer WHERE ${cur}`),
    gaql<{ metrics?: M }>(env, token, customerId, `SELECT ${m} FROM customer WHERE ${prev}`),
    gaql<never>(
      env,
      token,
      customerId,
      `SELECT campaign.id, campaign.name, campaign.status, campaign_budget.amount_micros, ${m} FROM campaign WHERE ${cur} AND campaign.status != 'REMOVED'`,
    ),
    gaql<never>(
      env,
      token,
      customerId,
      `SELECT search_term_view.search_term, campaign.name, ${m} FROM search_term_view WHERE ${cur} AND metrics.cost_micros > 0 ORDER BY metrics.cost_micros DESC LIMIT 200`,
    ),
    gaql<never>(env, token, customerId, `SELECT segments.date, ${m} FROM customer WHERE ${cur}`),
  ]);
  return summarizeAds({
    customerId,
    currency: cust[0]?.customer?.currencyCode ?? 'INR',
    period,
    days: 28,
    totalsCurrent,
    totalsPrevious,
    campaigns,
    searchTerms,
    daily,
  });
}
