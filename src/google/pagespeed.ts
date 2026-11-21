import { round } from '../lib/dates';
import { googleRequest } from './http';

/**
 * LAB data = one simulated Lighthouse test run by Google right now (repeatable, but not real users).
 * FIELD data = real Chrome users over the last 28 days (Chrome UX Report). Only exists for sites
 * with enough traffic; may fall back to the whole origin instead of the exact URL.
 */
export type FieldData = {
  source: 'url' | 'origin';
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  /** Core Web Vitals assessment: LCP, CLS (and INP when available) all "good" at the 75th percentile. */
  cwvPassed: boolean | null;
};

export type SpeedResult = {
  strategy: 'mobile' | 'desktop';
  score: number; // 0-100, Lighthouse performance (lab)
  lab: { lcpMs: number | null; cls: number | null; tbtMs: number | null; fcpMs: number | null };
  field: FieldData | null;
  /** @deprecated kept for health checks saved before lab/field split (use lab/field). */
  lcpMs: number | null;
  /** @deprecated */
  cls: number | null;
  /** @deprecated real-user INP; use field.inpMs */
  inpMs: number | null;
  /** @deprecated */
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
  loadingExperience?: CruxBlock;
  originLoadingExperience?: CruxBlock;
};
type CruxBlock = { metrics?: Record<string, { percentile?: number; category?: string }> };

/** Core Web Vitals "good" thresholds at the 75th percentile (web.dev/vitals). */
export const CWV_GOOD = { lcpMs: 2500, inpMs: 200, cls: 0.1 } as const;

/** Pure: Chrome UX Report block -> field metrics + CWV assessment. */
export function parseFieldData(
  block: CruxBlock | undefined,
  source: 'url' | 'origin',
): FieldData | null {
  const m = block?.metrics;
  if (!m || Object.keys(m).length === 0) return null;
  const lcp = m.LARGEST_CONTENTFUL_PAINT_MS?.percentile;
  const inp = m.INTERACTION_TO_NEXT_PAINT?.percentile;
  const clsRaw = m.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile; // CrUX reports CLS x100
  const cls = clsRaw === undefined ? undefined : clsRaw / 100;
  let cwvPassed: boolean | null = null;
  if (lcp !== undefined && cls !== undefined) {
    cwvPassed =
      lcp <= CWV_GOOD.lcpMs && cls <= CWV_GOOD.cls && (inp === undefined || inp <= CWV_GOOD.inpMs);
  }
  return {
    source,
    lcpMs: lcp ?? null,
    cls: cls === undefined ? null : round(cls, 3),
    inpMs: inp ?? null,
    cwvPassed,
  };
}

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
  const fcp = metric('first-contentful-paint');
  const lab = {
    lcpMs: lcp === null ? null : Math.round(lcp),
    cls: cls === null ? null : round(cls, 3),
    tbtMs: tbt === null ? null : Math.round(tbt),
    fcpMs: fcp === null ? null : Math.round(fcp),
  };
  // Prefer field data for this exact URL; fall back to the whole origin.
  const field =
    parseFieldData(data.loadingExperience, 'url') ??
    parseFieldData(data.originLoadingExperience, 'origin');
  return {
    strategy,
    score: Math.round(perf * 100),
    lab,
    field,
    lcpMs: lab.lcpMs,
    cls: lab.cls,
    inpMs: field?.inpMs ?? null,
    tbtMs: lab.tbtMs,
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
