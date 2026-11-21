import { round } from '../lib/dates';
import { googleRequest } from './http';

export type SpeedResult = {
  strategy: 'mobile' | 'desktop';
  score: number; // 0-100
  lcpMs: number | null;
  cls: number | null;
  /** Real-user INP (Chrome UX Report field data). Null when Google has no field data for the site. */
  inpMs: number | null;
  tbtMs: number | null;
  opportunities: { title: string; savingsMs: number }[];
};

export type PageSpeedSummary = {
  url: string;
  mobile: SpeedResult | null;
  desktop: SpeedResult | null;
  errors?: { mobile?: string; desktop?: string };
};

type Audit = {
  title?: string;
  score?: number | null;
  numericValue?: number;
  details?: { type?: string; overallSavingsMs?: number };
  metricSavings?: Record<string, number>;
};
type PsiResponse = {
  lighthouseResult?: {
    categories?: { performance?: { score?: number | null } };
    audits?: Record<string, Audit>;
  };
  loadingExperience?: { metrics?: Record<string, { percentile?: number }> };
};

export async function fetchPageSpeed(
  apiKey: string,
  url: string,
  strategy: 'mobile' | 'desktop',
): Promise<SpeedResult> {
  const api = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  api.searchParams.set('url', url);
  api.searchParams.set('strategy', strategy);
  api.searchParams.set('category', 'performance');
  api.searchParams.set('key', apiKey);
  // Lighthouse runs can take a while; don't retry too aggressively.
  const data = await googleRequest<PsiResponse>(api.toString(), { timeoutMs: 120_000, retries: 2 });
  return parsePageSpeed(data, strategy);
}

/** Pure function (unit-tested): PageSpeed API response -> compact result. */
export function parsePageSpeed(data: PsiResponse, strategy: 'mobile' | 'desktop'): SpeedResult {
  const lh = data.lighthouseResult;
  const audits = lh?.audits ?? {};
  const perf = lh?.categories?.performance?.score;
  if (perf === undefined || perf === null)
    throw new Error('PageSpeed returned no performance score');
  const metric = (id: string) => audits[id]?.numericValue ?? null;

  // Works for both classic "opportunity" audits and newer Lighthouse "insight" audits.
  const savings = (a: Audit) =>
    a.details?.overallSavingsMs ??
    Object.entries(a.metricSavings ?? {})
      .filter(([k]) => k !== 'CLS')
      .reduce((s, [, v]) => s + v, 0);
  const opportunities = Object.values(audits)
    .filter((a) => a.title && typeof a.score === 'number' && a.score < 0.9 && savings(a) > 0)
    .sort((a, b) => savings(b) - savings(a))
    .slice(0, 3)
    .map((a) => ({ title: a.title ?? '', savingsMs: Math.round(savings(a)) }));

  const lcp = metric('largest-contentful-paint');
  const tbt = metric('total-blocking-time');
  const cls = metric('cumulative-layout-shift');
  return {
    strategy,
    score: Math.round(perf * 100),
    lcpMs: lcp === null ? null : Math.round(lcp),
    cls: cls === null ? null : round(cls, 3),
    inpMs: data.loadingExperience?.metrics?.INTERACTION_TO_NEXT_PAINT?.percentile ?? null,
    tbtMs: tbt === null ? null : Math.round(tbt),
    opportunities,
  };
}

export async function fetchPageSpeedSummary(
  apiKey: string,
  url: string,
): Promise<PageSpeedSummary> {
  const [mobile, desktop] = await Promise.allSettled([
    fetchPageSpeed(apiKey, url, 'mobile'),
    fetchPageSpeed(apiKey, url, 'desktop'),
  ]);
  if (mobile.status === 'rejected' && desktop.status === 'rejected') {
    throw mobile.reason instanceof Error ? mobile.reason : new Error(String(mobile.reason));
  }
  const errors: PageSpeedSummary['errors'] = {};
  if (mobile.status === 'rejected')
    errors.mobile = String((mobile.reason as Error)?.message ?? mobile.reason);
  if (desktop.status === 'rejected')
    errors.desktop = String((desktop.reason as Error)?.message ?? desktop.reason);
  return {
    url,
    mobile: mobile.status === 'fulfilled' ? mobile.value : null,
    desktop: desktop.status === 'fulfilled' ? desktop.value : null,
    ...(Object.keys(errors).length ? { errors } : {}),
  };
}
