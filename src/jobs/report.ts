import { and, desc, eq } from 'drizzle-orm';
import {
  actionItems,
  agencies,
  clients,
  files,
  healthChecks,
  insights,
  reports,
} from '../db/schema';
import type { Env } from '../env';
import type { Ga4Summary } from '../google/ga4';
import type { GscSummary } from '../google/gsc';
import { GoogleApiError } from '../google/http';
import type { PageSpeedSummary } from '../google/pagespeed';
import { getAccessToken, getConnection } from '../google/tokens';
import {
  buildMimeMessage,
  copyDriveFile,
  createReportTemplate,
  driveFileUsable,
  exportPdf,
  HEADER_IDS,
  hexToRgbFloat,
  PLACEHOLDERS,
  sendGmail,
  slidesBatchUpdate,
} from '../google/workspace';
import { randomToken } from '../lib/crypto';
import { monthLabel } from '../lib/dates';
import { getDb } from '../lib/db';
import { log } from '../lib/log';
import { loadReportSettings } from '../lib/report-settings';
import { runHealthCheck } from './health-check';

const FRESH_CHECK_MS = 3 * 24 * 60 * 60 * 1000;
export const pdfKvKey = (reportId: string) => `report-pdf:${reportId}`;

/** Everything the report shows. Saved on the report row so the share page never changes later. */
export type ReportData = {
  agency: { name: string; brandColor: string; logoUrl: string | null };
  client: { name: string; websiteUrl: string };
  month: string;
  monthLabel: string;
  score: number | null;
  kpis: {
    clicks: number | null;
    clicksChangePct: number | null;
    sessions: number | null;
    sessionsChangePct: number | null;
    keyEvents: number | null;
    avgPosition: number | null;
    mobileSpeed: number | null;
    desktopSpeed: number | null;
  };
  dailyClicks: { date: string; clicks: number }[];
  dailySessions: { date: string; sessions: number }[];
  summary: string | null;
  summaryHinglish: string | null;
  actions: { title: string; why: string; expectedImpact: string }[];
  generatedAt: number;
};

const fmtNum = (n: number | null) => (n === null ? 'n/a' : Math.round(n).toLocaleString('en-IN'));
const fmtChange = (n: number | null) =>
  n === null
    ? 'No earlier data to compare'
    : `${n > 0 ? '+' : ''}${n.toFixed(1)}% vs previous 28 days`;

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
}

export async function buildReportData(
  env: Env,
  agencyId: string,
  clientId: string,
  month: string,
): Promise<{
  data: ReportData;
  healthCheckId: string | null;
}> {
  const db = getDb(env);
  const [agency, client] = await Promise.all([
    db.query.agencies.findFirst({ where: eq(agencies.id, agencyId) }),
    db.query.clients.findFirst({
      where: and(eq(clients.id, clientId), eq(clients.agencyId, agencyId)),
    }),
  ]);
  if (!agency || !client) throw new Error('Client not found');

  let check = await db.query.healthChecks.findFirst({
    where: and(eq(healthChecks.clientId, clientId), eq(healthChecks.agencyId, agencyId)),
    orderBy: desc(healthChecks.runAt),
  });
  if (!check || Date.now() - check.runAt > FRESH_CHECK_MS || check.status === 'failed') {
    const fresh = await runHealthCheck(env, agencyId, clientId);
    check = await db.query.healthChecks.findFirst({
      where: and(eq(healthChecks.id, fresh.healthCheckId), eq(healthChecks.agencyId, agencyId)),
    });
  }

  const gsc = check?.gscJson ? (JSON.parse(check.gscJson) as GscSummary) : null;
  const ga4 = check?.ga4Json ? (JSON.parse(check.ga4Json) as Ga4Summary) : null;
  const psi = check?.pagespeedJson ? (JSON.parse(check.pagespeedJson) as PageSpeedSummary) : null;
  const insight = check
    ? await db.query.insights.findFirst({
        where: and(eq(insights.healthCheckId, check.id), eq(insights.agencyId, agencyId)),
      })
    : undefined;
  const items = insight
    ? await db
        .select()
        .from(actionItems)
        .where(and(eq(actionItems.insightId, insight.id), eq(actionItems.agencyId, agencyId)))
        .orderBy(actionItems.priority)
    : [];

  return {
    healthCheckId: check?.id ?? null,
    data: {
      agency: {
        name: agency.name,
        brandColor: agency.brandColor,
        logoUrl: agency.logoFileId ? `/api/public/logo/${agency.logoFileId}` : null,
      },
      client: { name: client.name, websiteUrl: client.websiteUrl },
      month,
      monthLabel: monthLabel(month),
      score: check?.score ?? null,
      kpis: {
        clicks: gsc?.totals.current.clicks ?? null,
        clicksChangePct: gsc?.clicksChangePct ?? null,
        sessions: ga4?.totals.current.sessions ?? null,
        sessionsChangePct: ga4?.sessionsChangePct ?? null,
        keyEvents: ga4?.totals.current.keyEvents ?? null,
        avgPosition: gsc ? Math.round(gsc.totals.current.position * 10) / 10 : null,
        mobileSpeed: psi?.mobile?.score ?? null,
        desktopSpeed: psi?.desktop?.score ?? null,
      },
      dailyClicks: gsc?.dailyClicks ?? [],
      dailySessions: ga4?.dailySessions ?? [],
      summary: insight?.summary ?? null,
      summaryHinglish: insight?.summaryHinglish ?? null,
      actions: items.map((a) => ({ title: a.title, why: a.why, expectedImpact: a.expectedImpact })),
      generatedAt: Date.now(),
    },
  };
}

async function ensureTemplate(env: Env, agencyId: string, token: string): Promise<string> {
  const db = getDb(env);
  const agency = await db.query.agencies.findFirst({ where: eq(agencies.id, agencyId) });
  if (agency?.slidesTemplateId && (await driveFileUsable(token, agency.slidesTemplateId))) {
    return agency.slidesTemplateId;
  }
  const templateId = await createReportTemplate(token);
  await db.update(agencies).set({ slidesTemplateId: templateId }).where(eq(agencies.id, agencyId));
  return templateId;
}

/** Images in Slides must be fetchable by Google over the public internet (not localhost). */
const publicBase = (env: Env) => (env.APP_URL.startsWith('https://') ? env.APP_URL : null);

async function chartUrl(env: Env, values: number[], color: string): Promise<string | null> {
  const base = publicBase(env);
  if (!base || values.length === 0) return null;
  const token = randomToken(18);
  await env.KV.put(`chart:${token}`, JSON.stringify({ values, color }), {
    expirationTtl: 7 * 24 * 3600,
  });
  return `${base}/api/public/chart/${token}`;
}

/**
 * Generates the monthly report for one client: copy the Slides template, fill placeholders,
 * export PDF to KV, create the share link and (optionally) email it.
 */
export async function generateReport(
  env: Env,
  agencyId: string,
  clientId: string,
  opts: { month: string; send: boolean },
): Promise<{ reportId: string; sent: boolean }> {
  const db = getDb(env);
  const conn = await getConnection(env, agencyId, 'agency_workspace');
  if (!conn)
    throw new Error(
      'Connect your agency Google account (Settings → Reports) before creating reports',
    );

  const { data, healthCheckId } = await buildReportData(env, agencyId, clientId, opts.month);
  const reportId = crypto.randomUUID();
  const shareToken = randomToken(24);
  await db.insert(reports).values({
    id: reportId,
    agencyId,
    clientId,
    month: opts.month,
    healthCheckId,
    dataJson: JSON.stringify(data),
    shareToken,
    status: 'generating',
    createdAt: Date.now(),
  });

  try {
    const token = await getAccessToken(env, conn);
    const templateId = await ensureTemplate(env, agencyId, token);
    const fileId = await copyDriveFile(
      token,
      templateId,
      `${data.client.name} - ${data.monthLabel} report`,
    );
    await db.update(reports).set({ slidesFileId: fileId }).where(eq(reports.id, reportId));

    const shareUrl = `${env.APP_URL}/r/${shareToken}`;
    const values: Record<(typeof PLACEHOLDERS.text)[number], string> = {
      AGENCY_NAME: data.agency.name,
      CLIENT_NAME: data.client.name,
      MONTH: data.monthLabel,
      SCORE: data.score === null ? 'n/a' : String(data.score),
      CLICKS: fmtNum(data.kpis.clicks),
      CLICKS_CHANGE:
        data.kpis.clicks === null
          ? 'Search Console not connected'
          : fmtChange(data.kpis.clicksChangePct),
      SESSIONS: fmtNum(data.kpis.sessions),
      SESSIONS_CHANGE:
        data.kpis.sessions === null
          ? 'Analytics not connected'
          : fmtChange(data.kpis.sessionsChangePct),
      KEY_EVENTS: fmtNum(data.kpis.keyEvents),
      MOBILE_SPEED: fmtNum(data.kpis.mobileSpeed),
      DESKTOP_SPEED: fmtNum(data.kpis.desktopSpeed),
      AVG_POSITION: data.kpis.avgPosition === null ? 'n/a' : String(data.kpis.avgPosition),
      SUMMARY: data.summary ?? 'Summary not available for this period.',
      ACTIONS: data.actions.length
        ? data.actions
            .map(
              (a, i) =>
                `${i + 1}. ${a.title}\n    Why: ${a.why}\n    Expected impact: ${a.expectedImpact}`,
            )
            .join('\n')
        : 'Action plan not available for this period.',
      REPORT_LINK: shareUrl,
    };

    // Image placeholders (only when Google can fetch our URLs, i.e. in production).
    const images: Partial<Record<(typeof PLACEHOLDERS.image)[number], string | null>> = {};
    const base = publicBase(env);
    if (base) {
      const agency = await db.query.agencies.findFirst({ where: eq(agencies.id, agencyId) });
      if (agency?.logoFileId) {
        const f = await db.query.files.findFirst({
          where: and(eq(files.id, agency.logoFileId), eq(files.agencyId, agencyId)),
        });
        // Slides supports PNG/JPEG/GIF (not WebP).
        if (f && f.contentType !== 'image/webp') images.LOGO = `${base}/api/public/logo/${f.id}`;
      }
      images.CHART_CLICKS = await chartUrl(
        env,
        data.dailyClicks.map((d) => d.clicks),
        data.agency.brandColor,
      );
      images.CHART_SESSIONS = await chartUrl(
        env,
        data.dailySessions.map((d) => d.sessions),
        data.agency.brandColor,
      );
    }

    const brand = hexToRgbFloat(data.agency.brandColor);
    const colorRequests = HEADER_IDS.map((id) => ({
      updateShapeProperties: {
        objectId: id,
        shapeProperties: { shapeBackgroundFill: { solidFill: { color: { rgbColor: brand } } } },
        fields: 'shapeBackgroundFill.solidFill.color',
      },
    }));
    const textRequests = (Object.entries(values) as [string, string][]).map(([k, v]) => ({
      replaceAllText: { containsText: { text: `{{${k}}}`, matchCase: true }, replaceText: v },
    }));
    const imageRequests = Object.entries(images)
      .filter((e): e is [string, string] => Boolean(e[1]))
      .map(([k, url]) => ({
        replaceAllShapesWithImage: {
          imageUrl: url,
          imageReplaceMethod: 'CENTER_INSIDE',
          containsText: { text: `{{${k}}}`, matchCase: true },
        },
      }));
    const clearImageTokens = PLACEHOLDERS.image.map((k) => ({
      replaceAllText: { containsText: { text: `{{${k}}}`, matchCase: true }, replaceText: '' },
    }));

    try {
      await slidesBatchUpdate(token, fileId, [
        ...colorRequests,
        ...imageRequests,
        ...textRequests,
        ...clearImageTokens,
      ]);
    } catch (err) {
      // If Google couldn't fetch an image, still produce the report without images.
      if (!(err instanceof GoogleApiError) || err.status !== 400 || imageRequests.length === 0)
        throw err;
      log.warn('Slides image insert failed, retrying without images', err);
      await slidesBatchUpdate(token, fileId, [
        ...colorRequests,
        ...textRequests,
        ...clearImageTokens,
      ]);
    }

    const pdf = await exportPdf(token, fileId);
    await env.KV.put(pdfKvKey(reportId), pdf, { metadata: { contentType: 'application/pdf' } });
    await db
      .update(reports)
      .set({ pdfKvKey: pdfKvKey(reportId), status: 'ready', error: null })
      .where(eq(reports.id, reportId));
  } catch (err) {
    await db
      .update(reports)
      .set({ status: 'failed', error: (err as Error).message?.slice(0, 500) ?? 'Unknown error' })
      .where(eq(reports.id, reportId));
    throw err;
  }

  if (opts.send) {
    await sendReportEmail(env, agencyId, reportId);
    return { reportId, sent: true };
  }
  return { reportId, sent: false };
}

/** Fills {client}, {month}, {agency} in a report email template. */
export function fillTemplate(template: string, data: Pick<ReportData, 'client' | 'monthLabel' | 'agency'>) {
  return template
    .replaceAll('{client}', data.client.name)
    .replaceAll('{month}', data.monthLabel)
    .replaceAll('{agency}', data.agency.name);
}

export function reportEmailHtml(
  data: ReportData,
  shareUrl: string,
  opts: { message?: string; includeHinglish?: boolean } = {},
): string {
  const e = escapeHtml;
  const kpi = (label: string, value: string, sub: string) =>
    `<td style="padding:12px;border:1px solid #e2e8f0;border-radius:8px;vertical-align:top">
       <div style="font-size:12px;color:#64748b">${e(label)}</div>
       <div style="font-size:22px;font-weight:bold;color:#0f172a">${e(value)}</div>
       <div style="font-size:12px;color:#64748b">${e(sub)}</div></td>`;
  return `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:Arial,sans-serif;color:#0f172a">
  <div style="max-width:600px;margin:0 auto;background:#fff">
    <div style="background:${e(data.agency.brandColor)};color:#fff;padding:20px 24px;font-size:18px;font-weight:bold">${e(data.agency.name)}</div>
    <div style="padding:24px">
      <p style="margin:0 0 4px;color:#64748b">Monthly report · ${e(data.monthLabel)}</p>
      <h1 style="margin:0 0 16px;font-size:22px">${e(data.client.name)}</h1>
      ${opts.message ? `<p style="line-height:1.6;white-space:pre-line">${e(fillTemplate(opts.message, data))}</p>` : ''}
      <p style="font-size:16px;margin:0 0 16px">Website health score: <b>${data.score ?? 'n/a'}/100</b></p>
      <table cellspacing="8" style="width:100%;margin:0 -8px 16px"><tr>
        ${kpi('Search clicks', fmtNum(data.kpis.clicks), data.kpis.clicks === null ? '' : fmtChange(data.kpis.clicksChangePct))}
        ${kpi('Website sessions', fmtNum(data.kpis.sessions), data.kpis.sessions === null ? '' : fmtChange(data.kpis.sessionsChangePct))}
      </tr></table>
      ${data.summary ? `<p style="line-height:1.6">${e(data.summary)}</p>` : ''}
      ${opts.includeHinglish && data.summaryHinglish ? `<p style="line-height:1.6;color:#334155"><i>${e(data.summaryHinglish)}</i></p>` : ''}
      ${
        data.actions.length
          ? `<h2 style="font-size:16px;margin:24px 0 8px">What we will do next</h2><ol style="padding-left:20px;line-height:1.6">${data.actions
              .map(
                (a) =>
                  `<li><b>${e(a.title)}</b><br><span style="color:#64748b">${e(a.expectedImpact)}</span></li>`,
              )
              .join('')}</ol>`
          : ''
      }
      <p style="margin:24px 0"><a href="${e(shareUrl)}" style="background:${e(data.agency.brandColor)};color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">View the full report online</a></p>
      <p style="font-size:12px;color:#94a3b8">The full report is attached as a PDF.</p>
    </div>
  </div></body></html>`;
}

export async function sendReportEmail(env: Env, agencyId: string, reportId: string): Promise<void> {
  const db = getDb(env);
  const report = await db.query.reports.findFirst({
    where: and(eq(reports.id, reportId), eq(reports.agencyId, agencyId)),
  });
  if (!report) throw new Error('Report not found');
  if (report.status !== 'ready' && report.status !== 'sent')
    throw new Error('Report is not ready yet');
  const client = await db.query.clients.findFirst({
    where: and(eq(clients.id, report.clientId), eq(clients.agencyId, agencyId)),
  });
  if (!client) throw new Error('Client not found');
  const conn = await getConnection(env, agencyId, 'agency_workspace');
  if (!conn) throw new Error('Agency Google account is not connected');

  const pdf = report.pdfKvKey ? await env.KV.get(report.pdfKvKey, 'arrayBuffer') : null;
  if (!pdf) throw new Error('Report PDF not found. Please regenerate the report.');
  const data = JSON.parse(report.dataJson ?? '{}') as ReportData;
  const settings = await loadReportSettings(env, agencyId);
  const token = await getAccessToken(env, conn);
  const mime = buildMimeMessage({
    to: client.contactEmail,
    cc: settings.ccAgency && conn.googleEmail.includes('@') ? conn.googleEmail : undefined,
    subject: fillTemplate(settings.emailSubject, data),
    html: reportEmailHtml(data, `${env.APP_URL}/r/${report.shareToken}`, {
      message: settings.emailMessage,
      includeHinglish: settings.includeHinglish,
    }),
    attachment: {
      filename: `${data.client.name} - ${data.monthLabel} report.pdf`.replace(/[\\/:*?"<>|]/g, ''),
      contentType: 'application/pdf',
      bytes: new Uint8Array(pdf),
    },
  });
  await sendGmail(token, mime);
  await db
    .update(reports)
    .set({ status: 'sent', sentAt: Date.now() })
    .where(eq(reports.id, reportId));
}

/**
 * Re-exports the PDF from the report's Google Slides file (after manual edits in Slides)
 * and replaces the stored PDF. Works for reports that are ready or already sent.
 */
export async function refreshReportPdf(env: Env, agencyId: string, reportId: string): Promise<void> {
  const db = getDb(env);
  const report = await db.query.reports.findFirst({
    where: and(eq(reports.id, reportId), eq(reports.agencyId, agencyId)),
  });
  if (!report) throw new Error('Report not found');
  if (!report.slidesFileId) throw new Error('This report has no Google Slides file to export');
  const conn = await getConnection(env, agencyId, 'agency_workspace');
  if (!conn) throw new Error('Agency Google account is not connected');
  const token = await getAccessToken(env, conn);
  const pdf = await exportPdf(token, report.slidesFileId);
  await env.KV.put(pdfKvKey(reportId), pdf, { metadata: { contentType: 'application/pdf' } });
  await db
    .update(reports)
    .set({ pdfKvKey: pdfKvKey(reportId), error: null, status: report.status === 'failed' ? 'ready' : report.status })
    .where(and(eq(reports.id, reportId), eq(reports.agencyId, agencyId)));
}
