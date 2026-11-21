import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { reports } from '../db/schema';
import { escapeHtml, type ReportData } from '../jobs/report';
import { getDb } from '../lib/db';
import { renderBarChartPng } from '../lib/png-chart';
import type { AppEnv } from '../types';

export const publicRoutes = new Hono<AppEnv>();

/** Chart images referenced from Google Slides reports. Token is random and short-lived (KV TTL). */
publicRoutes.get('/api/public/chart/:token', async (c) => {
  const token = c.req.param('token');
  if (!/^[A-Za-z0-9_-]{24}$/.test(token)) return c.json({ error: 'Not found' }, 404);
  const raw = await c.env.KV.get(`chart:${token}`);
  if (!raw) return c.json({ error: 'Not found' }, 404);
  const { values, color } = JSON.parse(raw) as { values: number[]; color: string };
  const png = await renderBarChartPng(values, { color, width: 640, height: 380 });
  return new Response(png, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
  });
});

async function findShared(c: { env: AppEnv['Bindings'] }, token: string) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const report = await getDb(c.env).query.reports.findFirst({
    where: eq(reports.shareToken, token),
  });
  if (!report || (report.status !== 'ready' && report.status !== 'sent') || !report.dataJson)
    return null;
  return report;
}

const notFoundPage = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Report not found</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f8fafc;color:#334155">
<div style="text-align:center"><h1 style="font-size:20px">Report not found</h1><p>This link is invalid or the report was removed.</p></div></body>`;

/** Read-only shareable report page for the client (no login). */
publicRoutes.get('/r/:token', async (c) => {
  const report = await findShared(c, c.req.param('token'));
  if (!report) return c.html(notFoundPage, 404);
  const d = JSON.parse(report.dataJson!) as ReportData;
  const e = escapeHtml;
  const n = (v: number | null) => (v === null ? 'n/a' : Math.round(v).toLocaleString('en-IN'));
  const ch = (v: number | null) =>
    v === null
      ? ''
      : `<span style="color:${v >= 0 ? '#15803d' : '#b91c1c'}">${v >= 0 ? '▲' : '▼'} ${Math.abs(v).toFixed(1)}%</span> vs previous 28 days`;
  const kpi = (label: string, value: string, sub = '') =>
    `<div class="kpi"><div class="l">${e(label)}</div><div class="v">${e(value)}</div><div class="s">${sub}</div></div>`;
  const bars = (vals: number[]) => {
    const max = Math.max(1, ...vals);
    return `<div class="bars" role="img" aria-label="Daily values">${vals
      .map(
        (v) =>
          `<span title="${v.toLocaleString('en-IN')}" style="height:${Math.max(2, (v / max) * 100)}%"></span>`,
      )
      .join('')}</div>`;
  };
  const brand = /^#[0-9a-fA-F]{6}$/.test(d.agency.brandColor) ? d.agency.brandColor : '#4f46e5';

  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${e(d.client.name)} · ${e(d.monthLabel)} report</title>
<style>
:root{--brand:${brand}}*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a}
header{background:var(--brand);color:#fff;padding:16px}header .in{max-width:880px;margin:0 auto;display:flex;align-items:center;gap:12px}
header img{height:36px;width:36px;object-fit:contain;background:#fff;border-radius:6px}main{max-width:880px;margin:0 auto;padding:24px 16px}
h1{margin:4px 0 0;font-size:26px}.muted{color:#64748b}.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-top:16px}
.score{font-size:40px;font-weight:700}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.kpi{border:1px solid #e2e8f0;border-radius:10px;padding:14px;background:#fff}.kpi .l{font-size:13px;color:#64748b}.kpi .v{font-size:24px;font-weight:700;margin:4px 0}.kpi .s{font-size:12px;color:#64748b}
.bars{display:flex;align-items:flex-end;gap:2px;height:140px;border-bottom:1px solid #cbd5e1;margin-top:8px}.bars span{flex:1;background:var(--brand);border-radius:3px 3px 0 0;min-width:2px}
ol{padding-left:20px}li{margin-bottom:12px;line-height:1.5}.btn{display:inline-block;background:var(--brand);color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px}
</style></head><body>
<header><div class="in">${d.agency.logoUrl ? `<img src="${e(d.agency.logoUrl)}" alt="">` : ''}<strong>${e(d.agency.name)}</strong></div></header>
<main>
<p class="muted" style="margin:0">Monthly report · ${e(d.monthLabel)}</p>
<h1>${e(d.client.name)}</h1>
<p class="muted" style="margin:4px 0 0">${e(d.client.websiteUrl)}</p>
<div class="card"><div class="muted">Website health score</div><div class="score">${d.score ?? 'n/a'}<span class="muted" style="font-size:18px">/100</span></div></div>
<div class="grid" style="margin-top:16px">
${kpi('Search clicks', n(d.kpis.clicks), ch(d.kpis.clicksChangePct))}
${kpi('Website sessions', n(d.kpis.sessions), ch(d.kpis.sessionsChangePct))}
${kpi('Leads / key events', n(d.kpis.keyEvents))}
${kpi('Mobile speed', d.kpis.mobileSpeed === null ? 'n/a' : `${d.kpis.mobileSpeed}/100`, d.kpis.desktopSpeed === null ? '' : `Desktop ${d.kpis.desktopSpeed}/100`)}
</div>
${d.dailyClicks.length ? `<div class="card"><strong>Daily search clicks</strong>${bars(d.dailyClicks.map((x) => x.clicks))}</div>` : ''}
${d.dailySessions.length ? `<div class="card"><strong>Daily website sessions</strong>${bars(d.dailySessions.map((x) => x.sessions))}</div>` : ''}
${d.summary ? `<div class="card"><strong>Summary</strong><p style="line-height:1.6">${e(d.summary)}</p></div>` : ''}
${
  d.actions.length
    ? `<div class="card"><strong>What we will do next</strong><ol>${d.actions
        .map(
          (a) =>
            `<li><b>${e(a.title)}</b><br><span class="muted">${e(a.why)}</span><br><small>Expected impact: ${e(a.expectedImpact)}</small></li>`,
        )
        .join('')}</ol></div>`
    : ''
}
<p style="margin-top:24px"><a class="btn" href="/r/${e(report.shareToken)}/pdf">Download PDF</a></p>
<p class="muted" style="font-size:12px">Prepared by ${e(d.agency.name)} · ${new Date(d.generatedAt).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' })}</p>
</main></body></html>`);
});

publicRoutes.get('/r/:token/pdf', async (c) => {
  const report = await findShared(c, c.req.param('token'));
  if (!report?.pdfKvKey) return c.html(notFoundPage, 404);
  const pdf = await c.env.KV.get(report.pdfKvKey, 'arrayBuffer');
  if (!pdf) return c.html(notFoundPage, 404);
  return new Response(pdf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="report-${report.month}.pdf"`,
      'X-Robots-Tag': 'noindex',
    },
  });
});
