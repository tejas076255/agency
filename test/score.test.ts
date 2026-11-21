import { describe, expect, it } from 'vitest';
import { computeHealthScore, trendFraction, type ScoreInput } from '../src/lib/score';

const all = { gsc: true, ga4: true, pagespeed: true };

describe('trendFraction', () => {
  it('maps -50%..+50% linearly onto 0..1 and clamps', () => {
    expect(trendFraction(-50)).toBe(0);
    expect(trendFraction(-80)).toBe(0);
    expect(trendFraction(0)).toBe(0.5);
    expect(trendFraction(25)).toBe(0.75);
    expect(trendFraction(50)).toBe(1);
    expect(trendFraction(300)).toBe(1);
  });
  it('treats a not-computable trend (null) as no change, and invalid numbers as missing', () => {
    expect(trendFraction(null)).toBe(0.5);
    expect(trendFraction(Number.NaN)).toBeNull();
    expect(trendFraction(Number.POSITIVE_INFINITY)).toBeNull();
    expect(trendFraction(undefined)).toBeNull();
  });
});

describe('computeHealthScore v2 (35 / 30 / 25 / 10)', () => {
  it('a perfect site scores 100', () => {
    const r = computeHealthScore({
      search: { hasData: true, clicksChangePct: 60, impressionsChangePct: 60, avgPosition: 2, ctrPct: 8 },
      traffic: { hasData: true, organicSessionsChangePct: 50, sessionsChangePct: 50, engagementRatePct: 70, keyEventsChangePct: 50 },
      performance: { mobile: 100, desktop: 100, cwvPassed: true },
      sources: all,
    });
    expect(r.score).toBe(100);
    expect(r.formulaVersion).toBe(2);
    expect(r.breakdown).toEqual({
      search: { points: 35, max: 35 },
      traffic: { points: 30, max: 30 },
      performance: { points: 25, max: 25 },
      completeness: { points: 10, max: 10 },
    });
  });

  it('computes the documented mixed example exactly (docs/HEALTH_SCORE.md)', () => {
    const r = computeHealthScore({
      search: { hasData: true, clicksChangePct: 0, impressionsChangePct: -25, avgPosition: 16.5, ctrPct: 2.5 },
      traffic: { hasData: true, organicSessionsChangePct: -25, sessionsChangePct: 10, engagementRatePct: 30, keyEventsChangePct: 0 },
      performance: { mobile: 50, desktop: 80, cwvPassed: false },
      sources: all,
    });
    expect(r.breakdown.search).toEqual({ points: 16.3, max: 35 });
    expect(r.breakdown.traffic).toEqual({ points: 11.3, max: 30 });
    expect(r.breakdown.performance).toEqual({ points: 11.5, max: 25 });
    expect(r.breakdown.completeness).toEqual({ points: 10, max: 10 });
    expect(r.score).toBe(49);
  });

  it('missing data: only PageSpeed available -> 67 (completeness lowers it a bit)', () => {
    const r = computeHealthScore({
      performance: { mobile: 80, desktop: 80, cwvPassed: null },
      sources: { gsc: false, ga4: false, pagespeed: true },
    });
    expect(r.breakdown.search).toBeNull();
    expect(r.breakdown.traffic).toBeNull();
    expect(r.breakdown.performance).toEqual({ points: 20, max: 25 }); // (12 + 4) / 20 x 25
    expect(r.breakdown.completeness).toEqual({ points: 3.3, max: 10 });
    expect(r.score).toBe(67); // 23.3 / 35
  });

  it('partial data inside a category keeps the category weight', () => {
    // No field data (CWV) and invalid mobile score: only desktop counts, scaled to the full 25.
    const r = computeHealthScore({
      performance: { mobile: Number.NaN, desktop: 80, cwvPassed: null },
      sources: { gsc: false, ga4: false, pagespeed: true },
    });
    expect(r.breakdown.performance).toEqual({ points: 20, max: 25 });
  });

  it('clamps out-of-range values instead of breaking the scale', () => {
    const r = computeHealthScore({
      search: { hasData: true, clicksChangePct: 0, impressionsChangePct: 0, avgPosition: -5, ctrPct: 400 },
      performance: { mobile: 150, desktop: -20, cwvPassed: null },
      sources: { gsc: true, ga4: false, pagespeed: true },
    });
    // position -5 => treated as best (10/10), CTR 400% => 5/5, trends neutral => 7.5 + 2.5
    expect(r.breakdown.search).toEqual({ points: 25, max: 35 });
    // mobile 150 => 15/15, desktop -20 => 0/5 => 15/20 x 25
    expect(r.breakdown.performance).toEqual({ points: 18.8, max: 25 });
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('uses all sessions when the organic report was not available (undefined), neutral when null', () => {
    const base: ScoreInput = {
      traffic: { hasData: true, organicSessionsChangePct: undefined, sessionsChangePct: 50, engagementRatePct: 60, keyEventsChangePct: 50 },
      sources: { gsc: false, ga4: true, pagespeed: false },
    };
    expect(computeHealthScore(base).breakdown.traffic).toEqual({ points: 30, max: 30 });
    const neutral = computeHealthScore({
      ...base,
      traffic: { ...base.traffic!, organicSessionsChangePct: null },
    });
    expect(neutral.breakdown.traffic).toEqual({ points: 22.5, max: 30 }); // 7.5 + 10 + 5
  });

  it('returns null when no data category is available', () => {
    const r = computeHealthScore({
      search: { hasData: false, clicksChangePct: null, impressionsChangePct: null, avgPosition: null, ctrPct: null },
      sources: { gsc: true, ga4: false, pagespeed: false },
    });
    expect(r.score).toBeNull();
  });

  it('the worst possible site with all sources connected scores 10 (completeness only)', () => {
    const r = computeHealthScore({
      search: { hasData: true, clicksChangePct: -100, impressionsChangePct: -100, avgPosition: 90, ctrPct: 0 },
      traffic: { hasData: true, organicSessionsChangePct: -100, sessionsChangePct: -100, engagementRatePct: 0, keyEventsChangePct: -100 },
      performance: { mobile: 0, desktop: 0, cwvPassed: false },
      sources: all,
    });
    expect(r.score).toBe(10);
  });
});
