/**
 * HEALTH SCORE v2 (0-100). Full documentation with examples: docs/HEALTH_SCORE.md
 *
 * Category (weight)              Part (part max)                    Scale
 * -----------------------------  ---------------------------------  ------------------------------
 * Search performance (35)        Clicks trend (15)                  -50% => 0, 0% => half, +50% => full
 *                                Impressions trend (5)              same trend scale
 *                                Average position (10)              <= 3 => full, >= 30 => 0
 *                                CTR (5)                            >= 5% => full, 0% => 0
 * Organic traffic (30)           Organic sessions trend (15)        trend scale (falls back to all sessions)
 *                                Engagement rate (10)               >= 60% => full, 0% => 0
 *                                Key events trend (5)               trend scale
 * Website performance (25)       Mobile Lighthouse score (15)       score / 100
 *                                Desktop Lighthouse score (5)       score / 100
 *                                Core Web Vitals, field data (5)    passed => full, failed => 0
 * Data completeness (10)         Sources with data / 3              GSC, GA4, PageSpeed
 *
 * Rules:
 *  - category points = weight x (earned / max of the parts that have valid data)
 *  - a part with invalid data (NaN, Infinity, missing) is left out of its category
 *  - a trend that can't be computed (previous period was 0) counts as "no change" (half)
 *  - a category with no data is left out; score = sum(points) / sum(weights included) x 100
 *  - data completeness is always included, so missing sources lower the score a little
 *  - if none of search / traffic / performance has data, the score is null
 */

export const HEALTH_SCORE_FORMULA_VERSION = 2;

export const WEIGHTS = { search: 35, traffic: 30, performance: 25, completeness: 10 } as const;

export type ScoreInput = {
  search?: {
    hasData: boolean;
    clicksChangePct: number | null;
    impressionsChangePct: number | null;
    avgPosition: number | null;
    ctrPct: number | null;
  } | null;
  traffic?: {
    hasData: boolean;
    organicSessionsChangePct: number | null | undefined;
    sessionsChangePct: number | null;
    engagementRatePct: number | null;
    keyEventsChangePct: number | null;
  } | null;
  performance?: { mobile: number | null; desktop: number | null; cwvPassed: boolean | null } | null;
  sources: { gsc: boolean; ga4: boolean; pagespeed: boolean };
};

export type SectionScore = { points: number; max: number };
export type ScoreResult = {
  score: number | null;
  formulaVersion: number;
  breakdown: {
    search: SectionScore | null;
    traffic: SectionScore | null;
    performance: SectionScore | null;
    completeness: SectionScore;
  };
};

type Part = { fraction: number; max: number } | null;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** 0..1 for a percentage change: -50% => 0, 0% => 0.5, +50% => 1. null => 0.5 (unknown). */
export function trendFraction(changePct: number | null | undefined): number | null {
  if (changePct === null) return 0.5;
  if (!isNum(changePct)) return null;
  return clamp01((changePct + 50) / 100);
}

/** Linear 0..1 between zeroAt and fullAt (works for both directions). */
function linear(value: number | null | undefined, zeroAt: number, fullAt: number): number | null {
  if (!isNum(value)) return null;
  return clamp01((value - zeroAt) / (fullAt - zeroAt));
}

function part(fraction: number | null, max: number): Part {
  return fraction === null ? null : { fraction, max };
}

function category(parts: Part[], weight: number): SectionScore | null {
  const valid = parts.filter((p): p is NonNullable<Part> => p !== null);
  if (valid.length === 0) return null;
  const earned = valid.reduce((s, p) => s + p.fraction * p.max, 0);
  const max = valid.reduce((s, p) => s + p.max, 0);
  return { points: r1((earned / max) * weight), max: weight };
}

export function computeHealthScore(input: ScoreInput): ScoreResult {
  const s = input.search;
  const search = s?.hasData
    ? category(
        [
          part(trendFraction(s.clicksChangePct), 15),
          part(trendFraction(s.impressionsChangePct), 5),
          part(linear(s.avgPosition, 30, 3), 10),
          part(linear(s.ctrPct, 0, 5), 5),
        ],
        WEIGHTS.search,
      )
    : null;

  const t = input.traffic;
  const traffic = t?.hasData
    ? category(
        [
          // Organic sessions trend; if the organic report wasn't available use all sessions.
          part(
            trendFraction(
              t.organicSessionsChangePct === undefined
                ? t.sessionsChangePct
                : t.organicSessionsChangePct,
            ),
            15,
          ),
          part(linear(t.engagementRatePct, 0, 60), 10),
          part(trendFraction(t.keyEventsChangePct), 5),
        ],
        WEIGHTS.traffic,
      )
    : null;

  const p = input.performance;
  const performance = p
    ? category(
        [
          part(linear(p.mobile, 0, 100), 15),
          part(linear(p.desktop, 0, 100), 5),
          part(p.cwvPassed === null ? null : p.cwvPassed ? 1 : 0, 5),
        ],
        WEIGHTS.performance,
      )
    : null;

  const available = [input.sources.gsc, input.sources.ga4, input.sources.pagespeed].filter(
    Boolean,
  ).length;
  const completeness: SectionScore = {
    points: r1((available / 3) * WEIGHTS.completeness),
    max: WEIGHTS.completeness,
  };

  const breakdown = { search, traffic, performance, completeness };
  const dataSections = [search, traffic, performance].filter((x): x is SectionScore => x !== null);
  if (dataSections.length === 0) {
    return { score: null, formulaVersion: HEALTH_SCORE_FORMULA_VERSION, breakdown };
  }
  const all = [...dataSections, completeness];
  const earned = all.reduce((sum, x) => sum + x.points, 0);
  const max = all.reduce((sum, x) => sum + x.max, 0);
  return {
    score: Math.round((earned / max) * 100),
    formulaVersion: HEALTH_SCORE_FORMULA_VERSION,
    breakdown,
  };
}
