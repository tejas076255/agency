import { describe, expect, it } from 'vitest';
import { computeHealthScore, trendPoints } from '../src/lib/score';

describe('trendPoints', () => {
  it('maps -50%..+50% linearly onto 0..max and clamps', () => {
    expect(trendPoints(-50, 20)).toBe(0);
    expect(trendPoints(-80, 20)).toBe(0);
    expect(trendPoints(0, 20)).toBe(10);
    expect(trendPoints(25, 20)).toBe(15);
    expect(trendPoints(50, 20)).toBe(20);
    expect(trendPoints(300, 20)).toBe(20);
  });
  it('treats an unknown trend as no change', () => {
    expect(trendPoints(null, 20)).toBe(10);
  });
});

describe('computeHealthScore', () => {
  it('perfect site scores 100', () => {
    const r = computeHealthScore({
      seo: { hasData: true, clicksChangePct: 60, avgPosition: 2, ctrPct: 8 },
      traffic: { hasData: true, sessionsChangePct: 50, engagementRatePct: 70 },
      speed: { mobile: 100, desktop: 100 },
    });
    expect(r.score).toBe(100);
    expect(r.breakdown).toEqual({
      seo: { points: 40, max: 40 },
      traffic: { points: 30, max: 30 },
      speed: { points: 30, max: 30 },
    });
  });

  it('computes a mixed example exactly as documented', () => {
    // SEO: trend 0% -> 10, position 16.5 -> 5, CTR 2.5% -> 5  => 20/40
    // Traffic: -25% -> 5, engagement 30% -> 5                 => 10/30
    // Speed: mobile 50 -> 10, desktop 80 -> 8                  => 18/30
    // Total 48/100
    const r = computeHealthScore({
      seo: { hasData: true, clicksChangePct: 0, avgPosition: 16.5, ctrPct: 2.5 },
      traffic: { hasData: true, sessionsChangePct: -25, engagementRatePct: 30 },
      speed: { mobile: 50, desktop: 80 },
    });
    expect(r.breakdown.seo).toEqual({ points: 20, max: 40 });
    expect(r.breakdown.traffic).toEqual({ points: 10, max: 30 });
    expect(r.breakdown.speed).toEqual({ points: 18, max: 30 });
    expect(r.score).toBe(48);
  });

  it('re-scales when sections are missing (only speed: 24/30 -> 80)', () => {
    const r = computeHealthScore({ speed: { mobile: 80, desktop: 80 } });
    expect(r.breakdown.seo).toBeNull();
    expect(r.breakdown.traffic).toBeNull();
    expect(r.score).toBe(80);
  });

  it('uses the single available speed strategy for all 30 points', () => {
    expect(computeHealthScore({ speed: { mobile: 70, desktop: null } }).breakdown.speed).toEqual({
      points: 21,
      max: 30,
    });
  });

  it('ignores sections without data and returns null when nothing is available', () => {
    expect(
      computeHealthScore({
        seo: { hasData: false, clicksChangePct: null, avgPosition: 0, ctrPct: 0 },
        speed: null,
      }).score,
    ).toBeNull();
  });

  it('always stays within 0..100', () => {
    const worst = computeHealthScore({
      seo: { hasData: true, clicksChangePct: -100, avgPosition: 90, ctrPct: 0 },
      traffic: { hasData: true, sessionsChangePct: -100, engagementRatePct: 0 },
      speed: { mobile: 0, desktop: 0 },
    });
    expect(worst.score).toBe(0);
  });
});
