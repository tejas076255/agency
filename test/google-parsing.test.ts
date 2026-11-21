import { describe, expect, it } from 'vitest';
import { summarizeGa4 } from '../src/google/ga4';
import { summarizeGsc } from '../src/google/gsc';
import { parsePageSpeed } from '../src/google/pagespeed';
import { buildMimeMessage } from '../src/google/workspace';
import { comparePeriods, previousIstMonth } from '../src/lib/dates';
import { renderBarChartPng } from '../src/lib/png-chart';

const period = comparePeriods(Date.UTC(2026, 10, 21, 3, 0), 3);
const row = (key: string | null, clicks: number, impressions: number, position: number) => ({
  ...(key ? { keys: [key] } : {}),
  clicks,
  impressions,
  ctr: impressions ? clicks / impressions : 0,
  position,
});

describe('dates', () => {
  it('builds two back-to-back 28-day periods ending 3 days ago (IST)', () => {
    // now = 21 Nov 2026 08:30 IST -> current ends 18 Nov
    expect(period.current).toEqual({ start: '2026-10-22', end: '2026-11-18' });
    expect(period.previous).toEqual({ start: '2026-09-24', end: '2026-10-21' });
  });
  it('previous month handles January', () => {
    expect(previousIstMonth(Date.UTC(2027, 0, 1, 1))).toBe('2026-12');
    // 31 Oct 19:00 UTC is already 1 Nov in IST
    expect(previousIstMonth(Date.UTC(2026, 9, 31, 19))).toBe('2026-10');
  });
});

describe('summarizeGsc', () => {
  const s = summarizeGsc({
    siteUrl: 'sc-domain:example.com',
    period,
    totCur: [row(null, 120, 4000, 14.2)],
    totPrev: [row(null, 100, 3500, 15)],
    queries: [
      row('seo agency pune', 50, 900, 3.1),
      row('digital marketing pune', 4, 800, 11.4), // quick win
      row('ppc company', 1, 300, 18.9), // quick win
      row('rare query', 0, 5, 12), // too few impressions
      row('page two hero', 2, 50, 21), // outside 8-20
    ],
    pagesCur: [row('/a', 30, 0, 0), row('/b', 5, 0, 0)],
    pagesPrev: [row('/a', 20, 0, 0), row('/b', 25, 0, 0), row('/gone', 10, 0, 0)],
    daily: [row('2026-10-22', 5, 0, 0), row('2026-10-21', 4, 0, 0)],
  });

  it('computes period-over-period change', () => {
    expect(s.clicksChangePct).toBe(20);
    expect(s.totals.current.clicks).toBe(120);
  });
  it('finds quick wins at positions 8-20 sorted by impressions', () => {
    expect(s.quickWins.map((q) => q.query)).toEqual(['digital marketing pune', 'ppc company']);
  });
  it('finds pages with the biggest click drop (including pages that vanished)', () => {
    expect(s.droppingPages.map((p) => [p.page, p.change])).toEqual([
      ['/b', -20],
      ['/gone', -10],
    ]);
  });
  it('sorts daily clicks by date', () => {
    expect(s.dailyClicks.map((d) => d.date)).toEqual(['2026-10-21', '2026-10-22']);
  });
  it('handles an empty property', () => {
    const empty = summarizeGsc({
      siteUrl: 'x',
      period,
      totCur: [],
      totPrev: [],
      queries: [],
      pagesCur: [],
      pagesPrev: [],
      daily: [],
    });
    expect(empty.totals.current.clicks).toBe(0);
    expect(empty.clicksChangePct).toBe(0);
  });
});

describe('summarizeGa4', () => {
  const mv = (...v: number[]) => v.map((x) => ({ value: String(x) }));
  const s = summarizeGa4({
    propertyId: '123',
    period,
    totals: {
      rows: [
        { dimensionValues: [{ value: 'previous' }], metricValues: mv(1000, 800, 20, 0.5) },
        { dimensionValues: [{ value: 'current' }], metricValues: mv(1250, 900, 30, 0.6123) },
      ],
    },
    channels: { rows: [{ dimensionValues: [{ value: 'Organic Search' }], metricValues: mv(700) }] },
    landing: { rows: [{ dimensionValues: [{ value: '/pricing' }], metricValues: mv(200, 9) }] },
    daily: { rows: [{ dimensionValues: [{ value: '20261101' }], metricValues: mv(42) }] },
  });
  it('picks named date ranges regardless of row order', () => {
    expect(s.totals.current.sessions).toBe(1250);
    expect(s.sessionsChangePct).toBe(25);
    expect(s.keyEventsChangePct).toBe(50);
    expect(s.totals.current.engagementRate).toBe(61.2);
  });
  it('maps channels, landing pages and dates', () => {
    expect(s.topChannels[0]).toEqual({ channel: 'Organic Search', sessions: 700 });
    expect(s.topLandingPages[0]).toEqual({ page: '/pricing', sessions: 200, keyEvents: 9 });
    expect(s.dailySessions[0]).toEqual({ date: '2026-11-01', sessions: 42 });
  });
});

describe('GA4 new users and organic sessions', () => {
  const mv = (...v: number[]) => v.map((x) => ({ value: String(x) }));
  const base = {
    propertyId: '1',
    period,
    totals: {
      rows: [
        { dimensionValues: [{ value: 'current' }], metricValues: mv(100, 90, 2, 0.5, 60) },
        { dimensionValues: [{ value: 'previous' }], metricValues: mv(80, 70, 1, 0.5, 40) },
      ],
    },
    channels: {},
    landing: {},
    daily: {},
  };
  it('reads new users and their change', () => {
    const s = summarizeGa4(base);
    expect(s.totals.current.newUsers).toBe(60);
    expect(s.newUsersChangePct).toBe(50);
    expect(s.organicSessions).toBeNull(); // organic report not provided
  });
  it('reads organic search sessions for both periods', () => {
    const s = summarizeGa4({
      ...base,
      organic: {
        rows: [
          { dimensionValues: [{ value: 'current' }], metricValues: mv(45) },
          { dimensionValues: [{ value: 'previous' }], metricValues: mv(60) },
        ],
      },
    });
    expect(s.organicSessions).toEqual({ current: 45, previous: 60, changePct: -25 });
  });
});

describe('GSC top pages', () => {
  it('lists the pages with the most clicks', () => {
    const s = summarizeGsc({
      siteUrl: 'x',
      period,
      totCur: [],
      totPrev: [],
      queries: [],
      pagesCur: [row('/low', 1, 10, 9), row('/top', 50, 900, 3.2)],
      pagesPrev: [],
      daily: [],
    });
    expect(s.topPages.map((p) => p.page)).toEqual(['/top', '/low']);
    expect(s.topPages[0]).toMatchObject({ clicks: 50, impressions: 900, position: 3.2 });
  });
});

describe('PageSpeed lab vs field data', () => {
  const lab = {
    lighthouseResult: {
      categories: { performance: { score: 0.9 } },
      audits: {
        'largest-contentful-paint': { numericValue: 1800 },
        'first-contentful-paint': { numericValue: 900 },
      },
    },
  };
  it('passes Core Web Vitals when LCP, CLS and INP are all good (75th percentile)', () => {
    const r = parsePageSpeed(
      {
        ...lab,
        loadingExperience: {
          metrics: {
            LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2100 },
            CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5 }, // = 0.05
            INTERACTION_TO_NEXT_PAINT: { percentile: 150 },
          },
        },
      },
      'mobile',
    );
    expect(r.lab).toEqual({ lcpMs: 1800, cls: null, tbtMs: null, fcpMs: 900 });
    expect(r.field).toEqual({ source: 'url', lcpMs: 2100, cls: 0.05, inpMs: 150, cwvPassed: true });
  });
  it('fails CWV when one metric is poor, and falls back to origin data', () => {
    const r = parsePageSpeed(
      {
        ...lab,
        loadingExperience: { metrics: {} },
        originLoadingExperience: {
          metrics: {
            LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2100 },
            CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 30 }, // 0.3 = poor
          },
        },
      },
      'mobile',
    );
    expect(r.field).toMatchObject({ source: 'origin', cls: 0.3, inpMs: null, cwvPassed: false });
  });
  it('has no field data for low-traffic sites (lab only)', () => {
    expect(parsePageSpeed(lab, 'desktop').field).toBeNull();
  });
});

describe('parsePageSpeed', () => {
  it('extracts score, vitals and the top 3 opportunities', () => {
    const r = parsePageSpeed(
      {
        lighthouseResult: {
          categories: { performance: { score: 0.47 } },
          audits: {
            'largest-contentful-paint': { numericValue: 4210.7 },
            'cumulative-layout-shift': { numericValue: 0.1234 },
            'total-blocking-time': { numericValue: 380.2 },
            a: {
              title: 'Reduce unused JavaScript',
              score: 0.2,
              details: { type: 'opportunity', overallSavingsMs: 1200 },
            },
            b: {
              title: 'Render blocking requests',
              score: 0,
              metricSavings: { LCP: 900, FCP: 400, CLS: 0.2 },
            },
            c: { title: 'Properly size images', score: 0.5, details: { overallSavingsMs: 300 } },
            d: { title: 'Small thing', score: 0.6, details: { overallSavingsMs: 50 } },
            e: { title: 'Already good', score: 1, details: { overallSavingsMs: 5000 } },
          },
        },
        loadingExperience: { metrics: { INTERACTION_TO_NEXT_PAINT: { percentile: 245 } } },
      },
      'mobile',
    );
    expect(r).toMatchObject({ score: 47, lcpMs: 4211, cls: 0.123, inpMs: 245, tbtMs: 380 });
    expect(r.opportunities.map((o) => o.title)).toEqual([
      'Render blocking requests',
      'Reduce unused JavaScript',
      'Properly size images',
    ]);
  });
  it('throws when there is no score', () => {
    expect(() => parsePageSpeed({}, 'desktop')).toThrow();
  });
});

describe('renderBarChartPng', () => {
  it('produces a valid PNG of the requested size', async () => {
    const png = await renderBarChartPng([1, 5, 3, 0, 8], {
      width: 200,
      height: 100,
      color: '#ff6600',
    });
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(200); // IHDR width
    expect(view.getUint32(20)).toBe(100); // IHDR height
  });
});

describe('buildMimeMessage', () => {
  it('builds a multipart email and blocks header injection', () => {
    const mime = buildMimeMessage({
      to: 'client@example.com\r\nBcc: victim@example.com',
      subject: 'Report ✅ November',
      html: '<p>Hello</p>',
      attachment: {
        filename: 'r.pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array([37, 80, 68, 70]),
      },
    });
    expect(mime).not.toMatch(/\r\nBcc:/);
    expect(mime).toMatch(/^To: client@example.com Bcc: victim@example.com\r\n/);
    expect(mime).toContain('Subject: =?UTF-8?B?');
    expect(mime).toContain('Content-Disposition: attachment; filename="r.pdf"');
    expect(mime).toContain('JVBERg=='); // "%PDF" in base64
  });
});
