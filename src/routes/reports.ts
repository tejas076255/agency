import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { and, desc, eq } from 'drizzle-orm';
import { clients, jobRuns, reports } from '../db/schema';
import { describeError } from '../google/http';
import { deleteConnection, getConnection, WORKSPACE_SCOPES } from '../google/tokens';
import { refreshReportPdf, sendReportEmail } from '../jobs/report';
import { auditRequest } from '../lib/audit';
import { getDb } from '../lib/db';
import { OAUTH_STATE_COOKIE, startGoogleOAuth } from '../lib/google-oauth';
import { currentUser, requireAgency, requireOwner } from '../middleware/auth';
import type { AppEnv } from '../types';
import { clientScope } from './clients';

// ------------------------------------- Reports -------------------------------------

export const reportRoutes = new Hono<AppEnv>();
reportRoutes.use('*', requireAgency);

async function loadReport(c: Parameters<typeof clientScope>[0], id: string) {
  const db = getDb(c.env);
  const report = await db.query.reports.findFirst({
    where: and(eq(reports.id, id), eq(reports.agencyId, c.get('agencyId'))),
  });
  if (!report) return null;
  // Members may only access reports of their assigned clients.
  const client = await db.query.clients.findFirst({ where: clientScope(c, report.clientId) });
  return client ? report : null;
}

/** "Preview": the PDF, for signed-in agency users. */
reportRoutes.get('/:id/pdf', async (c) => {
  const report = await loadReport(c, c.req.param('id'));
  if (!report?.pdfKvKey) return c.json({ error: 'Report PDF not found' }, 404);
  const pdf = await c.env.KV.get(report.pdfKvKey, 'arrayBuffer');
  if (!pdf) return c.json({ error: 'Report PDF not found' }, 404);
  return new Response(pdf, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="report-${report.month}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
  });
});

/** Report history across all (visible) clients, newest first. */
reportRoutes.get('/', async (c) => {
  const rows = await getDb(c.env)
    .select({
      id: reports.id,
      clientId: reports.clientId,
      clientName: clients.name,
      month: reports.month,
      status: reports.status,
      error: reports.error,
      shareToken: reports.shareToken,
      slidesFileId: reports.slidesFileId,
      sentAt: reports.sentAt,
      createdAt: reports.createdAt,
    })
    .from(reports)
    .innerJoin(
      clients,
      and(eq(clients.id, reports.clientId), eq(clients.agencyId, reports.agencyId)),
    )
    .where(and(eq(reports.agencyId, c.get('agencyId')), clientScope(c)))
    .orderBy(desc(reports.createdAt))
    .limit(100);
  return c.json({
    reports: rows.map(({ shareToken, ...r }) => ({ ...r, shareUrl: `/r/${shareToken}` })),
  });
});

/** "Send manually": email a ready report to the client's contact email. */
reportRoutes.post('/:id/send', async (c) => {
  const report = await loadReport(c, c.req.param('id'));
  if (!report) return c.json({ error: 'Report not found' }, 404);
  try {
    await sendReportEmail(c.env, c.get('agencyId'), report.id);
    await auditRequest(c, 'report.send', {
      targetType: 'report',
      targetId: report.id,
      metadata: { month: report.month, clientId: report.clientId },
    });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: describeError(err) }, 400);
  }
});

/**
 * Manual editing: after the agency edits the report in Google Slides,
 * re-export the PDF so the email attachment and share link show the edited version.
 */
reportRoutes.post('/:id/refresh-pdf', async (c) => {
  const report = await loadReport(c, c.req.param('id'));
  if (!report) return c.json({ error: 'Report not found' }, 404);
  try {
    await refreshReportPdf(c.env, c.get('agencyId'), report.id);
    await auditRequest(c, 'report.pdf_refresh', { targetType: 'report', targetId: report.id });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: describeError(err) }, 400);
  }
});

// ------------------------------------- Job logs -------------------------------------

export const jobRoutes = new Hono<AppEnv>();
jobRoutes.use('*', requireAgency);

jobRoutes.get('/', async (c) => {
  const db = getDb(c.env);
  const rows = await db
    .select({
      id: jobRuns.id,
      type: jobRuns.type,
      trigger: jobRuns.trigger,
      status: jobRuns.status,
      error: jobRuns.error,
      attempt: jobRuns.attempt,
      createdAt: jobRuns.createdAt,
      startedAt: jobRuns.startedAt,
      finishedAt: jobRuns.finishedAt,
      clientId: jobRuns.clientId,
      clientName: clients.name,
    })
    .from(jobRuns)
    .innerJoin(
      clients,
      and(eq(clients.id, jobRuns.clientId), eq(clients.agencyId, jobRuns.agencyId)),
    )
    .where(and(eq(jobRuns.agencyId, c.get('agencyId')), clientScope(c)))
    .orderBy(desc(jobRuns.createdAt))
    .limit(100);
  return c.json({ jobs: rows });
});

// ------------------------- Agency Google account (Slides/Drive/Gmail) -------------------------

export const workspaceRoutes = new Hono<AppEnv>();
workspaceRoutes.use('*', requireAgency);

workspaceRoutes.get('/', async (c) => {
  const conn = await getConnection(c.env, c.get('agencyId'), 'agency_workspace');
  return c.json({
    connection: conn
      ? { googleEmail: conn.googleEmail, status: conn.status, connectedAt: conn.connectedAt }
      : null,
  });
});

workspaceRoutes.post('/connect', requireOwner, async (c) => {
  const { url, state } = await startGoogleOAuth(
    c.env,
    { purpose: 'connect_agency', userId: currentUser(c).id, agencyId: c.get('agencyId') },
    WORKSPACE_SCOPES,
    { offline: true, loginHint: currentUser(c).email },
  );
  setCookie(c, OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/auth',
    maxAge: 600,
  });
  return c.json({ url });
});

workspaceRoutes.delete('/', requireOwner, async (c) => {
  const conn = await getConnection(c.env, c.get('agencyId'), 'agency_workspace');
  if (conn) await deleteConnection(c.env, conn);
  await auditRequest(c, 'google.workspace_disconnect', {
    targetType: 'agency',
    targetId: c.get('agencyId'),
  });
  return c.json({ ok: true });
});
