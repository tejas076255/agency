// Compact input for AI insights + the deterministic (rule-based) fallback used when AI fails.
import type { Ga4Summary } from '../google/ga4';
import type { GscSummary } from '../google/gsc';
import type { PageSpeedSummary } from '../google/pagespeed';

export type InsightAction = {
  priority: number;
  title: string;
  description: string;
  why: string;
  expected_impact: string;
  supporting_metrics: string[];
};

export type InsightResult = {
  summary: string;
  summary_hinglish?: string;
  action_items: InsightAction[];
};

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Small JSON sent to the AI (not raw API data): keeps tokens low and avoids noise. */
export function buildCompactSummary(
  client: { name: string; websiteUrl: string },
  gsc: GscSummary | null,
  ga4: Ga4Summary | null,
  psi: PageSpeedSummary | null,
  score: number | null,
) {
  const mobile = psi?.mobile ?? null;
  return {
    client: client.name,
    website: client.websiteUrl,
    health_score: score,
    period_days: 28,
    search_console: gsc && {
      clicks: gsc.totals.current.clicks,
      clicks_prev: gsc.totals.previous.clicks,
      clicks_change_pct: gsc.clicksChangePct,
      impressions: gsc.totals.current.impressions,
      impressions_change_pct: gsc.impressionsChangePct,
      avg_position: r1(gsc.totals.current.position),
      ctr_pct: r1(gsc.totals.current.ctr * 100),
      top_queries: gsc.topQueries.slice(0, 5).map((q) => ({ q: q.query, clicks: q.clicks, pos: q.position })),
      top_pages: (gsc.topPages ?? []).slice(0, 3).map((p) => ({ page: p.page, clicks: p.clicks })),
      quick_wins: gsc.quickWins
        .slice(0, 5)
        .map((q) => ({ q: q.query, impressions: q.impressions, pos: q.position })),
      dropping_pages: gsc.droppingPages
        .slice(0, 3)
        .map((p) => ({ page: p.page, before: p.clicksBefore, now: p.clicksNow })),
    },
    analytics: ga4 && {
      sessions: ga4.totals.current.sessions,
      sessions_change_pct: ga4.sessionsChangePct,
      organic_sessions: ga4.organicSessions?.current ?? null,
      organic_sessions_change_pct: ga4.organicSessions?.changePct ?? null,
      users: ga4.totals.current.users,
      new_users: ga4.totals.current.newUsers ?? null,
      key_events: ga4.totals.current.keyEvents,
      key_events_change_pct: ga4.keyEventsChangePct,
      engagement_rate_pct: ga4.totals.current.engagementRate,
      top_channels: ga4.topChannels.slice(0, 4),
      top_landing_pages: ga4.topLandingPages.slice(0, 3),
    },
    speed: psi && {
      mobile: mobile && {
        lighthouse_score: mobile.score,
        lab_lcp_ms: mobile.lab?.lcpMs ?? mobile.lcpMs,
        lab_cls: mobile.lab?.cls ?? mobile.cls,
        field_core_web_vitals_passed: mobile.field?.cwvPassed ?? null,
        field_inp_ms: mobile.field?.inpMs ?? null,
        top_fixes: mobile.opportunities.map((o) => o.title),
      },
      desktop: psi.desktop && { lighthouse_score: psi.desktop.score },
    },
  };
}

export type CompactSummary = ReturnType<typeof buildCompactSummary>;

const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? 'n/a' : `${n > 0 ? '+' : ''}${r1(n)}%`;
const fmt = (n: number) => Math.round(n).toLocaleString('en-IN');

type Candidate = Omit<InsightAction, 'priority'>;

/**
 * Rule-based insights from the same compact summary. Used when the AI is unavailable or returns
 * invalid output twice. Only quotes numbers that exist in the data and never promises results.
 */
export function buildFallbackInsights(s: CompactSummary): InsightResult {
  const sc = s.search_console;
  const ga = s.analytics;
  const mob = s.speed?.mobile ?? null;
  const out: Candidate[] = [];

  const drop = sc?.dropping_pages[0];
  if (drop) {
    out.push({
      title: 'Refresh the page that lost the most search clicks',
      description: `Update the content, title, meta description and internal links of ${drop.page}.`,
      why: `This page went from ${fmt(drop.before)} to ${fmt(drop.now)} clicks compared with the previous 28 days.`,
      expected_impact: 'Could recover part of the lost clicks over the next 4-8 weeks.',
      supporting_metrics: [`${drop.page}: ${fmt(drop.before)} → ${fmt(drop.now)} clicks`],
    });
  }

  if (sc && sc.quick_wins.length > 0) {
    const top = sc.quick_wins.slice(0, 3);
    out.push({
      title: 'Push quick-win keywords onto page 1',
      description: `Improve on-page content and add internal links for: ${top.map((q) => `"${q.q}"`).join(', ')}.`,
      why: 'These keywords already rank on page 2 (positions 8-20) and get impressions, so a small improvement can bring clicks.',
      expected_impact: 'May bring additional clicks if these keywords move into the top 5.',
      supporting_metrics: top.map((q) => `"${q.q}": position ${q.pos}, ${fmt(q.impressions)} impressions`),
    });
  }

  if (mob && (mob.lighthouse_score < 50 || mob.field_core_web_vitals_passed === false)) {
    const fix = mob.top_fixes[0];
    const metrics = [`Mobile performance score: ${mob.lighthouse_score}/100`];
    if (mob.lab_lcp_ms !== null && mob.lab_lcp_ms !== undefined) metrics.push(`Lab LCP: ${r1(mob.lab_lcp_ms / 1000)} s`);
    if (mob.field_core_web_vitals_passed === false) metrics.push('Core Web Vitals (real users): failed');
    out.push({
      title: fix ? `Fix the top mobile speed issue: ${fix}` : 'Improve mobile page speed',
      description: 'Work through the top PageSpeed recommendations for the mobile version of the home page.',
      why: 'Slow mobile pages lose visitors and can hurt search visibility.',
      expected_impact: 'Could improve mobile speed and reduce visitors leaving before the page loads.',
      supporting_metrics: metrics,
    });
  }

  if (sc && sc.ctr_pct < 2 && sc.impressions >= 1000) {
    out.push({
      title: 'Rewrite titles and meta descriptions to lift click-through rate',
      description: 'Make titles of the top pages more specific and add a clear benefit in meta descriptions.',
      why: 'The site is shown often in Google but few searchers click.',
      expected_impact: 'A higher CTR could bring more clicks without needing better rankings.',
      supporting_metrics: [`CTR: ${sc.ctr_pct}%`, `Impressions: ${fmt(sc.impressions)}`],
    });
  }

  if (ga && ga.sessions_change_pct !== null && ga.sessions_change_pct <= -10) {
    out.push({
      title: 'Investigate the drop in website traffic',
      description: 'Compare traffic channels and landing pages with the previous period to find where visits fell.',
      why: 'Sessions dropped noticeably compared with the previous 28 days.',
      expected_impact: 'Finding the cause early makes it easier to recover lost visits.',
      supporting_metrics: [`Sessions: ${fmt(ga.sessions)} (${pct(ga.sessions_change_pct)})`],
    });
  }

  if (ga && ga.key_events === 0 && ga.sessions >= 100) {
    out.push({
      title: 'Set up or check conversion (key event) tracking',
      description: 'Mark form submissions, calls or WhatsApp clicks as key events in GA4.',
      why: 'The site has traffic but no recorded key events, so leads cannot be measured.',
      expected_impact: 'Makes it possible to measure which channels bring leads.',
      supporting_metrics: [`Key events: 0`, `Sessions: ${fmt(ga.sessions)}`],
    });
  }

  if (ga && ga.engagement_rate_pct < 40 && ga.sessions >= 100) {
    out.push({
      title: 'Improve engagement on the top landing pages',
      description: 'Add a clear headline, faster first view and an obvious call-to-action on the main landing pages.',
      why: 'Many visitors leave without engaging with the site.',
      expected_impact: 'Could increase engaged visits and leads from the same traffic.',
      supporting_metrics: [`Engagement rate: ${ga.engagement_rate_pct}%`],
    });
  }

  if (!sc) {
    out.push({
      title: 'Connect Google Search Console',
      description: 'Connect the client Google account and select the Search Console property.',
      why: 'Without Search Console data, keyword rankings and click trends cannot be analysed.',
      expected_impact: 'Unlocks keyword opportunities and dropping-page alerts in the next health check.',
      supporting_metrics: ['Search Console data: not connected'],
    });
  }
  if (!ga) {
    out.push({
      title: 'Connect Google Analytics 4',
      description: 'Connect the client Google account and select the GA4 property.',
      why: 'Without GA4 data, traffic, engagement and leads cannot be measured.',
      expected_impact: 'Unlocks traffic and conversion insights in the next health check.',
      supporting_metrics: ['GA4 data: not connected'],
    });
  }

  // Safe generic items so there are always exactly five.
  const generic: Candidate[] = [
    {
      title: 'Add a clear call-to-action on the top landing page',
      description: 'Make sure the main page shows a phone number, WhatsApp button or enquiry form above the fold.',
      why: 'Clear next steps help turn visits into enquiries.',
      expected_impact: 'Could increase enquiries from existing traffic.',
      supporting_metrics: ga?.top_landing_pages[0]
        ? [`Top landing page: ${ga.top_landing_pages[0].page} (${fmt(ga.top_landing_pages[0].sessions)} sessions)`]
        : [`Health score: ${s.health_score ?? 'n/a'}/100`],
    },
    {
      title: 'Publish one new page targeting a relevant search query',
      description: 'Write a helpful page or blog post around a service + city query the business wants to rank for.',
      why: 'Regular, relevant content gives Google more pages to rank.',
      expected_impact: 'May bring new search impressions over the coming months.',
      supporting_metrics: sc ? [`Impressions (28 days): ${fmt(sc.impressions)}`] : [`Health score: ${s.health_score ?? 'n/a'}/100`],
    },
    {
      title: 'Check Search Console for indexing and coverage issues',
      description: 'Open the Pages report in Search Console and fix pages that are not indexed.',
      why: 'Pages that are not indexed cannot appear in Google search.',
      expected_impact: 'Helps make sure important pages can be found in search.',
      supporting_metrics: sc ? [`Average position: ${sc.avg_position}`] : ['Search Console data: not connected'],
    },
    {
      title: 'Review progress in next week’s health check',
      description: 'Compare next week’s score and metrics with this week to see which actions worked.',
      why: 'Tracking changes weekly shows what is improving.',
      expected_impact: 'Keeps the work focused on actions that move the numbers.',
      supporting_metrics: [`Health score: ${s.health_score ?? 'n/a'}/100`],
    },
  ];
  for (const g of generic) if (out.length < 5) out.push(g);

  const action_items = out.slice(0, 5).map((a, i) => ({ ...a, priority: i + 1 }));

  const parts: string[] = [];
  if (sc) parts.push(`In the last 28 days the site received ${fmt(sc.clicks)} search clicks (${pct(sc.clicks_change_pct)} vs the previous 28 days) at an average position of ${sc.avg_position}.`);
  if (ga) parts.push(`Website sessions were ${fmt(ga.sessions)} (${pct(ga.sessions_change_pct)}).`);
  if (mob) parts.push(`The mobile performance score is ${mob.lighthouse_score}/100.`);
  parts.push(`The health score is ${s.health_score ?? 'n/a'}/100.`);
  const summary = `${parts.join(' ')} These recommendations were generated by rules because AI insights were unavailable.`;

  const hParts: string[] = [];
  if (sc) hParts.push(`Pichle 28 din mein site ko ${fmt(sc.clicks)} search clicks mile (${pct(sc.clicks_change_pct)}).`);
  if (ga) hParts.push(`Website sessions ${fmt(ga.sessions)} rahe (${pct(ga.sessions_change_pct)}).`);
  if (mob) hParts.push(`Mobile speed score ${mob.lighthouse_score}/100 hai.`);
  hParts.push(`Health score ${s.health_score ?? 'n/a'}/100 hai.`);
  const summary_hinglish = `${hParts.join(' ')} Ye suggestions rules se bane hain kyunki AI available nahi tha.`;

  return { summary, summary_hinglish, action_items };
}

/** Numbers (>= 10) mentioned in text, e.g. "1,234 clicks" -> 1234, "4.2 s" -> 4.2 is ignored (< 10). */
function numbersIn(text: string): number[] {
  return (text.match(/-?\d[\d,]*(\.\d+)?/g) ?? [])
    .map((x) => Number(x.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n) && Math.abs(n) >= 10);
}

// Thresholds/constants the model may legitimately mention.
const ALLOWED_CONSTANTS = [20, 28, 30, 50, 60, 90, 100, 200, 2500];

/**
 * Guard against invented metrics: every number (>= 10) in supporting_metrics must appear in the
 * input data (1% tolerance, or as seconds of a millisecond value). Returns offending numbers.
 */
export function findUngroundedNumbers(metrics: string[], source: CompactSummary): number[] {
  const known = [...numbersIn(JSON.stringify(source)), ...ALLOWED_CONSTANTS];
  const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.6, Math.abs(b) * 0.01);
  return metrics
    .flatMap(numbersIn)
    .filter((n) => !known.some((k) => close(Math.abs(n), Math.abs(k)) || close(Math.abs(n), Math.abs(k) / 1000)));
}
