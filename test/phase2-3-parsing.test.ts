import { describe, expect, it } from 'vitest';
import { summarizeAds } from '../src/google/ads';
import { originalReviewText, summarizeGbp } from '../src/google/business';
import { labelFor, parseAnnotation, topThemes } from '../src/google/language';
import { compareWithCompetitors, toPlaceResult } from '../src/google/places';
import { safeSheetTitle } from '../src/google/sheets';
import { reportRows, summarizeYouTube } from '../src/google/youtube';
import { comparePeriods } from '../src/lib/dates';
import { buildFallbackInsights } from '../src/lib/insights';
import { buildExportTabs } from '../src/routes/integrations';
import { sampleSummary } from './helpers';

const period = comparePeriods(Date.UTC(2026, 10, 21, 3), 3); // current 2026-10-22..2026-11-18

describe('Business Profile performance', () => {
  const dv = (date: string, value?: string) => {
    const [year, month, day] = date.split('-').map(Number) as [number, number, number];
    return { date: { year, month, day }, ...(value !== undefined ? { value } : {}) };
  };
  const s = summarizeGbp({
    location: {
      name: 'locations/1',
      title: 'Acme Dental',
      storefrontAddress: { addressLines: ['12 MG Road'], locality: 'Pune', postalCode: '411001' },
      phoneNumbers: { primaryPhone: '+91 20 1234 5678' },
      categories: {
        primaryCategory: { displayName: 'Dentist' },
        additionalCategories: [{ displayName: 'Dental clinic' }],
      },
      regularHours: { periods: [] },
      metadata: { mapsUri: 'https://maps.google.com/?cid=1' },
    },
    performance: {
      multiDailyMetricTimeSeries: [
        {
          dailyMetricTimeSeries: [
            {
              dailyMetric: 'CALL_CLICKS',
              timeSeries: {
                datedValues: [dv('2026-11-01', '5'), dv('2026-11-02'), dv('2026-10-01', '2')],
              },
            },
            {
              dailyMetric: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
              timeSeries: { datedValues: [dv('2026-11-01', '100')] },
            },
            {
              dailyMetric: 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
              timeSeries: { datedValues: [dv('2026-11-01', '20'), dv('2026-10-05', '60')] },
            },
            {
              dailyMetric: 'BUSINESS_DIRECTION_REQUESTS',
              timeSeries: { datedValues: [dv('2026-11-03', '4')] },
            },
          ],
        },
      ],
    },
    period,
    reviews: { averageRating: 4.4, totalReviewCount: 87 },
  });

  it('sums impressions across surfaces and splits current vs previous period', () => {
    expect(s.totals.current).toMatchObject({ impressions: 120, calls: 5, directions: 4 });
    expect(s.totals.previous).toMatchObject({ impressions: 60, calls: 2 });
    expect(s.changePct.impressions).toBe(100);
    expect(s.changePct.calls).toBe(150);
  });
  it('treats missing values as 0 and builds a sorted daily series', () => {
    expect(s.daily.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect(s.daily[0]).toMatchObject({ impressions: 120, calls: 5 });
  });
  it('extracts listing completeness fields', () => {
    expect(s.location).toMatchObject({
      title: 'Acme Dental',
      address: '12 MG Road, Pune, 411001',
      primaryCategory: 'Dentist',
      additionalCategories: ['Dental clinic'],
      website: null,
      hoursSet: false,
    });
    expect(s.reviews).toEqual({ averageRating: 4.4, totalReviewCount: 87 });
  });
});

describe('reviews', () => {
  it('keeps only the original text of Google-translated reviews', () => {
    expect(originalReviewText('Great doctor (Translated by Google) Bahut accha')).toBe(
      'Great doctor',
    );
    expect(originalReviewText('(Translated by Google) Very good\n\n(Original)\nबहुत अच्छा')).toBe(
      'बहुत अच्छा',
    );
    expect(originalReviewText('   ')).toBeNull();
    expect(originalReviewText(undefined)).toBeNull();
  });
});

describe('Natural Language sentiment', () => {
  it('labels scores with ±0.25 thresholds', () => {
    expect(labelFor(0.6)).toBe('positive');
    expect(labelFor(0.1)).toBe('neutral');
    expect(labelFor(-0.4)).toBe('negative');
  });
  it('parses annotateText and drops low-salience entities', () => {
    const r = parseAnnotation({
      documentSentiment: { score: -0.7, magnitude: 1.9 },
      entities: [
        { name: 'Waiting Time', type: 'OTHER', salience: 0.6 },
        { name: 'it', type: 'OTHER', salience: 0.01 },
      ],
    });
    expect(r).toMatchObject({ label: 'negative', score: -0.7 });
    expect(r.entities).toEqual([{ name: 'waiting time', type: 'OTHER', salience: 0.6 }]);
  });
  it('finds the most common complaint themes', () => {
    const themes = topThemes(
      [
        { label: 'negative', entities: [{ name: 'waiting time' }, { name: 'parking' }] },
        { label: 'negative', entities: [{ name: 'waiting time' }, { name: 'waiting time' }] },
        { label: 'positive', entities: [{ name: 'doctor' }] },
      ],
      'negative',
    );
    expect(themes).toEqual([
      { name: 'waiting time', count: 2 },
      { name: 'parking', count: 1 },
    ]);
  });
});

describe('Places competitors', () => {
  it('maps the field-masked response', () => {
    expect(
      toPlaceResult({
        id: 'ChIJabc1234567',
        displayName: { text: 'Smile Care' },
        rating: 4.7,
        userRatingCount: 210,
      }),
    ).toMatchObject({
      placeId: 'ChIJabc1234567',
      name: 'Smile Care',
      rating: 4.7,
      userRatingCount: 210,
    });
  });
  it('ranks the client against competitors', () => {
    const base = { address: null, primaryType: null, mapsUri: null };
    const r = compareWithCompetitors([
      {
        ...base,
        placeId: 'a',
        name: 'Client',
        rating: 4.2,
        userRatingCount: 80,
        isClient: true,
        label: 'Client',
      },
      {
        ...base,
        placeId: 'b',
        name: 'B',
        rating: 4.8,
        userRatingCount: 300,
        isClient: false,
        label: 'B',
      },
      {
        ...base,
        placeId: 'c',
        name: 'C',
        rating: 4.0,
        userRatingCount: 50,
        isClient: false,
        label: 'C',
      },
    ]);
    expect(r.clientRank).toBe(2);
    expect(r.competitorAvgRating).toBe(4.4);
    expect(r.competitorAvgReviews).toBe(175);
  });
});

describe('Google Ads summary', () => {
  const m = (cost: number, clicks: number, conv: number, value = 0, impressions = 1000) => ({
    impressions: String(impressions),
    clicks: String(clicks),
    costMicros: String(cost * 1e6),
    conversions: conv,
    conversionsValue: value,
  });
  const s = summarizeAds({
    customerId: '1234567890',
    currency: 'INR',
    period: comparePeriods(Date.UTC(2026, 10, 21, 3), 1),
    days: 28,
    totalsCurrent: [{ metrics: m(28000, 700, 35, 140000, 20000) }],
    totalsPrevious: [{ metrics: m(20000, 500, 25) }],
    campaigns: [
      {
        campaign: { id: '1', name: 'Brand', status: 'ENABLED' },
        campaignBudget: { amountMicros: String(500 * 1e6) },
        metrics: m(7000, 300, 20),
      },
      {
        campaign: { id: '2', name: 'Generic', status: 'ENABLED' },
        campaignBudget: { amountMicros: String(1000 * 1e6) },
        metrics: m(21000, 400, 15),
      },
    ],
    searchTerms: [
      {
        searchTermView: { searchTerm: 'free dentist' },
        campaign: { name: 'Generic' },
        metrics: m(1200, 40, 0),
      },
      {
        searchTermView: { searchTerm: 'dentist near me' },
        campaign: { name: 'Generic' },
        metrics: m(5000, 100, 9),
      },
      {
        searchTermView: { searchTerm: 'dental jobs' },
        campaign: { name: 'Generic' },
        metrics: m(800, 20, 0),
      },
    ],
    daily: [
      { segments: { date: '2026-11-02' }, metrics: m(1000, 25, 1) },
      { segments: { date: '2026-11-01' }, metrics: m(900, 20, 2) },
    ],
  });
  it('computes totals, derived metrics and change', () => {
    expect(s.totals.current).toMatchObject({ cost: 28000, clicks: 700, conversions: 35 });
    expect(s.derived).toEqual({ ctrPct: 3.5, avgCpc: 40, costPerConversion: 800, roas: 5 });
    expect(s.changePct).toEqual({ cost: 40, clicks: 40, conversions: 40 });
  });
  it('finds wasted (non-converting) search terms and budget utilisation', () => {
    expect(s.wastedSearchTerms.map((w) => w.term)).toEqual(['free dentist', 'dental jobs']);
    expect(s.wastedSpend).toBe(2000);
    expect(s.campaigns[0]).toMatchObject({ name: 'Generic', budgetUtilizationPct: 75 }); // 21000 / (1000 x 28)
    expect(s.daily.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-02']);
  });
  it('omits ROAS when conversion value is not tracked', () => {
    const noValue = summarizeAds({
      ...{ customerId: '1', currency: 'INR', period, days: 28 },
      totalsCurrent: [{ metrics: m(100, 10, 1) }],
      totalsPrevious: [],
      campaigns: [],
      searchTerms: [],
      daily: [],
    });
    expect(noValue.derived.roas).toBeNull();
  });
});

describe('YouTube summary', () => {
  const rep = (cols: string[], rows: (string | number)[][]) => ({
    columnHeaders: cols.map((name) => ({ name })),
    rows,
  });
  it('maps report rows by column name', () => {
    expect(reportRows(rep(['day', 'views'], [['2026-11-01', 10]]))).toEqual([
      { day: '2026-11-01', views: 10 },
    ]);
  });
  it('summarizes channel growth and top videos', () => {
    const cols = [
      'views',
      'estimatedMinutesWatched',
      'averageViewDuration',
      'subscribersGained',
      'subscribersLost',
    ];
    const s = summarizeYouTube({
      channel: {
        id: 'UC1',
        snippet: { title: 'Acme TV' },
        statistics: { subscriberCount: '1200', videoCount: '40', viewCount: '90000' },
      },
      period,
      current: rep(cols, [[3000, 9000, 180, 50, 10]]),
      previous: rep(cols, [[4000, 10000, 150, 30, 10]]),
      daily: rep(
        ['day', 'views', 'estimatedMinutesWatched', 'subscribersGained', 'subscribersLost'],
        [
          ['2026-11-02', 100, 300, 3, 1],
          ['2026-11-01', 90, 250, 2, 0],
        ],
      ),
      top: rep(
        ['video', 'views', 'estimatedMinutesWatched', 'averageViewDuration'],
        [['v1', 900, 2000, 200]],
      ),
      titles: { v1: 'Braces explained' },
    });
    expect(s.changePct).toEqual({ views: -25, watchMinutes: -10, netSubscribers: 100 });
    expect(s.daily[0]).toEqual({
      date: '2026-11-01',
      views: 90,
      watchMinutes: 250,
      netSubscribers: 2,
    });
    expect(s.topVideos[0]).toMatchObject({ title: 'Braces explained', views: 900 });
    expect(s.channel).toMatchObject({ title: 'Acme TV', subscribers: 1200 });
  });
});

describe('Sheets export', () => {
  it('sanitises sheet titles', () => {
    expect(safeSheetTitle('Reviews: [Q4]/2026?')).toBe('Reviews   Q4  2026 ');
  });
  it('labels AI-derived review columns separately from original data', () => {
    const tabs = buildExportTabs({
      gsc: null,
      ga4: null,
      gbp: null,
      ads: null,
      yt: null,
      reviews: [
        {
          createdAt: Date.UTC(2026, 10, 1),
          stars: 2,
          comment: 'Long wait',
          reply: null,
          label: 'negative',
          score: -60,
        },
      ],
    });
    expect(tabs.map((t) => t.title)).toEqual(['Reviews']);
    expect(tabs[0]!.rows[0]).toContain('Sentiment (AI-derived)');
    expect(tabs[0]!.rows[0]).toContain('Review (original)');
    expect(tabs[0]!.rows[1]).toEqual(['2026-11-01', 2, 'Long wait', null, 'negative', -0.6]);
  });
  it('returns no tabs when there is no data', () => {
    expect(
      buildExportTabs({ gsc: null, ga4: null, gbp: null, ads: null, yt: null, reviews: [] }),
    ).toEqual([]);
  });
});

describe('fallback insights use Phase 2/3 data', () => {
  it('recommends negative keywords and review replies when that data exists', () => {
    const s = sampleSummary({
      search_console: null,
      analytics: null,
      speed: null,
      google_ads: {
        currency: 'INR',
        cost: 28000,
        cost_change_pct: 40,
        clicks: 700,
        conversions: 35,
        cost_per_conversion: 800,
        roas: 5,
        wasted_spend_on_non_converting_terms: 2000,
        top_wasted_terms: [{ term: 'free dentist', cost: 1200 }],
        top_campaigns: [],
      },
      reviews_last_30_days: { new_reviews: 12, negative: 3, unanswered: 5 },
    });
    const titles = buildFallbackInsights(s)
      .action_items.map((a) => a.title)
      .join(' | ');
    expect(titles).toMatch(/negative keywords/);
    expect(titles).toMatch(/Reply to recent Google reviews/);
  });
});
