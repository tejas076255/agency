/**
 * HEALTH SCORE (0-100)
 * ====================
 * Three sections, 100 points in total:
 *
 *  SEO (Search Console) ............ 40
 *    - Clicks trend ............... 20   (-50% or worse = 0, no change = 10, +50% or better = 20, linear)
 *    - Average position ........... 10   (position <= 3 = 10, position >= 30 = 0, linear)
 *    - Click-through rate ......... 10   (CTR >= 5% = 10, 0% = 0, linear)
 *
 *  Traffic (GA4) ................... 30
 *    - Sessions trend ............. 20   (same scale as clicks trend)
 *    - Engagement rate ............ 10   (>= 60% = 10, 0% = 0, linear)
 *
 *  Speed (PageSpeed) ............... 30
 *    - Mobile performance ......... 20   (Lighthouse score / 100 * 20)
 *    - Desktop performance ........ 10   (Lighthouse score / 100 * 10)
 *
 * If a section has no data (not connected, or the API failed), it is left out and the score is
 * re-scaled to 100 from the sections that do exist: score = earned / max_available * 100.
 * Example: only Speed available with 24/30 points -> score 80.
 * A trend that can't be computed (previous period was 0) counts as "no change" (half points).
 */

export type ScoreInput = {
  seo?: {
    clicksChangePct: number | null;
    avgPosition: number;
    ctrPct: number;
    hasData: boolean;
  } | null;
  traffic?: {
    sessionsChangePct: number | null;
    engagementRatePct: number;
    hasData: boolean;
  } | null;
  speed?: { mobile: number | null; desktop: number | null } | null;
};

export type SectionScore = { points: number; max: number };
export type ScoreResult = {
  score: number | null;
  breakdown: { seo: SectionScore | null; traffic: SectionScore | null; speed: SectionScore | null };
};

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const linear = (value: number, zeroAt: number, fullAt: number, points: number) =>
  clamp((value - zeroAt) / (fullAt - zeroAt), 0, 1) * points;

/** -50% => 0, 0% => half, +50% => full. */
export function trendPoints(changePct: number | null, points: number): number {
  if (changePct === null) return points / 2;
  return linear(changePct, -50, 50, points);
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function computeHealthScore(input: ScoreInput): ScoreResult {
  let seo: SectionScore | null = null;
  if (input.seo?.hasData) {
    const p =
      trendPoints(input.seo.clicksChangePct, 20) +
      linear(input.seo.avgPosition, 30, 3, 10) +
      linear(input.seo.ctrPct, 0, 5, 10);
    seo = { points: r1(p), max: 40 };
  }

  let traffic: SectionScore | null = null;
  if (input.traffic?.hasData) {
    const p =
      trendPoints(input.traffic.sessionsChangePct, 20) +
      linear(input.traffic.engagementRatePct, 0, 60, 10);
    traffic = { points: r1(p), max: 30 };
  }

  let speed: SectionScore | null = null;
  const m = input.speed?.mobile ?? null;
  const d = input.speed?.desktop ?? null;
  if (m !== null || d !== null) {
    // If only one strategy succeeded, scale it to the full 30 points.
    if (m !== null && d !== null) speed = { points: r1((m / 100) * 20 + (d / 100) * 10), max: 30 };
    else speed = { points: r1((((m ?? d) as number) / 100) * 30), max: 30 };
  }

  const sections = [seo, traffic, speed].filter((s): s is SectionScore => s !== null);
  if (sections.length === 0) return { score: null, breakdown: { seo, traffic, speed } };
  const earned = sections.reduce((s, x) => s + x.points, 0);
  const max = sections.reduce((s, x) => s + x.max, 0);
  return { score: Math.round((earned / max) * 100), breakdown: { seo, traffic, speed } };
}
