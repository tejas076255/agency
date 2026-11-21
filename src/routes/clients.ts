import { Hono, type Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { actionItems, clients, healthChecks, insights, reports } from '../db/schema';
import { listGa4Properties } from '../google/ga4';
import { listGscSites } from '../google/gsc';
import { describeError, ReconnectNeededError } from '../google/http';
import {
  CLIENT_DATA_SCOPES,
  deleteConnection,
  getAccessToken,
  getConnection,
  hasScope,
  SCOPE,
} from '../google/tokens';
import { enqueueJobs, hasPendingJob } from '../jobs/queue';
import { getDb } from '../lib/db';
import { OAUTH_STATE_COOKIE, startGoogleOAuth } from '../lib/google-oauth';
import { readJson } from '../lib/validate';
import { currentUser, requireAgency } from '../middleware/auth';
import type { AppEnv } from '../types';

export const clientRoutes = new Hono<AppEnv>();
clientRoutes.use('*', requireAgency);

const httpUrl = z
  .string()
  .trim()
  .url('Enter a full URL like https://example.com')
  .refine((u) => /^https?:\/\//i.test(u), 'URL must start with http:// or https://');

const clientInput = z.object({
  name: z.string().trim().min(2).max(100),
  websiteUrl: httpUrl,
  contactEmail: z.string().trim().email('Enter a valid email'),
  autoSendReport: z.boolean().optional(),
});

/**
 * Tenant scoping for clients. Always filters by the signed-in user's agency.
 * Members only see clients assigned to them; owners see all clients of their agency.
 */
export function clientScope(c: Context<AppEnv>, clientId?: string): SQL {
  const user = currentUser(c);
  const conds: SQL[] = [eq(clients.agencyId, c.get('agencyId'))];
  if (user.role === 'member') conds.push(eq(clients.assignedUserId, user.id));
  if (clientId) conds.push(eq(clients.id, clientId));
  return and(...conds)!;
}

async function loadClient(c: Context<AppEnv>, id: string) {
  return getDb(c.env).query.clients.findFirst({ where: clientScope(c, id) });
}

const parseJson = <T>(s: string | null): T | null => (s ? (JSON.parse(s) as T) : null);

clientRoutes.get('/', async (c) => {
  const db = getDb(c.env);
  const agencyId = c.get('agencyId');
  const list = await db.select().from(clients).where(clientScope(c)).orderBy(clients.name);
  const ids = list.map((x) => x.id);
  const checks = ids.length
    ? await db
        .select({
          clientId: healthChecks.clientId,
          score: healthChecks.score,
          runAt: healthChecks.runAt,
          status: healthChecks.status,
        })
        .from(healthChecks)
        .where(and(eq(healthChecks.agencyId, agencyId), inArray(healthChecks.clientId, ids)))
        .orderBy(desc(healthChecks.runAt))
        .limit(1000)
    : [];
  const byClient = new Map<string, typeof checks>();
  for (const ch of checks) {
    const arr = byClient.get(ch.clientId) ?? [];
    if (arr.length < 2) arr.push(ch);
    byClient.set(ch.clientId, arr);
  }
  return c.json({
    clients: list.map((cl) => {
      const [latest, prev] = byClient.get(cl.id) ?? [];
      return {
        id: cl.id,
        name: cl.name,
        websiteUrl: cl.websiteUrl,
        status: cl.status,
        score: latest?.score ?? null,
        previousScore: prev?.score ?? null,
        lastRunAt: latest?.runAt ?? null,
        lastStatus: latest?.status ?? null,
        sourcesSelected: Boolean(cl.gscSiteUrl || cl.ga4PropertyId),
      };
    }),
  });
});

clientRoutes.post('/', async (c) => {
  const input = await readJson(c, clientInput);
  const now = Date.now();
  const [row] = await getDb(c.env)
    .insert(clients)
    .values({
      id: crypto.randomUUID(),
      agencyId: c.get('agencyId'),
      name: input.name,
      websiteUrl: input.websiteUrl,
      contactEmail: input.contactEmail,
      autoSendReport: input.autoSendReport ?? false,
      status: 'not_connected',
      assignedUserId: currentUser(c).role === 'member' ? currentUser(c).id : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return c.json({ client: row }, 201);
});

clientRoutes.get('/:id', async (c) => {
  const client = await loadClient(c, c.req.param('id'));
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const db = getDb(c.env);
  const agencyId = c.get('agencyId');

  const conn = await getConnection(c.env, agencyId, 'client_data', client.id);
  const checks = await db
    .select()
    .from(healthChecks)
    .where(and(eq(healthChecks.clientId, client.id), eq(healthChecks.agencyId, agencyId)))
    .orderBy(desc(healthChecks.runAt))
    .limit(12);
  const latest = checks[0];

  let insight = null;
  if (latest) {
    // Show the most recent insight (latest check might have failed AI generation).
    const recentIds = checks.map((x) => x.id);
    const ins = await db
      .select()
      .from(insights)
      .where(and(eq(insights.agencyId, agencyId), inArray(insights.healthCheckId, recentIds)))
      .orderBy(desc(insights.createdAt))
      .limit(1);
    if (ins[0]) {
      const items = await db
        .select()
        .from(actionItems)
        .where(and(eq(actionItems.insightId, ins[0].id), eq(actionItems.agencyId, agencyId)))
        .orderBy(actionItems.priority);
      insight = {
        id: ins[0].id,
        healthCheckId: ins[0].healthCheckId,
        summary: ins[0].summary,
        summaryHinglish: ins[0].summaryHinglish,
        modelUsed: ins[0].modelUsed,
        createdAt: ins[0].createdAt,
        actionItems: items.map((a) => ({
          id: a.id,
          priority: a.priority,
          title: a.title,
          why: a.why,
          expectedImpact: a.expectedImpact,
          done: a.done,
        })),
      };
    }
  }

  const reportRows = await db
    .select({
      id: reports.id,
      month: reports.month,
      status: reports.status,
      error: reports.error,
      shareToken: reports.shareToken,
      sentAt: reports.sentAt,
      createdAt: reports.createdAt,
      slidesFileId: reports.slidesFileId,
    })
    .from(reports)
    .where(and(eq(reports.clientId, client.id), eq(reports.agencyId, agencyId)))
    .orderBy(desc(reports.createdAt))
    .limit(12);

  return c.json({
    client: {
      id: client.id,
      name: client.name,
      websiteUrl: client.websiteUrl,
      contactEmail: client.contactEmail,
      gscSiteUrl: client.gscSiteUrl,
      ga4PropertyId: client.ga4PropertyId,
      status: client.status,
      autoSendReport: client.autoSendReport,
    },
    connection: conn
      ? {
          googleEmail: conn.googleEmail,
          status: conn.status,
          connectedAt: conn.connectedAt,
          canReadGsc: hasScope(conn, SCOPE.gsc),
          canReadGa4: hasScope(conn, SCOPE.ga4),
        }
      : null,
    latestCheck: latest
      ? {
          id: latest.id,
          runAt: latest.runAt,
          score: latest.score,
          status: latest.status,
          errors: parseJson<Record<string, string>>(latest.errorsJson) ?? {},
          breakdown: parseJson(latest.scoreBreakdownJson),
          gsc: parseJson(latest.gscJson),
          ga4: parseJson(latest.ga4Json),
          pagespeed: parseJson(latest.pagespeedJson),
        }
      : null,
    history: checks
      .map((h) => {
        const psi = parseJson<{
          mobile?: { score: number } | null;
          desktop?: { score: number } | null;
        }>(h.pagespeedJson);
        return {
          runAt: h.runAt,
          score: h.score,
          mobileSpeed: psi?.mobile?.score ?? null,
          desktopSpeed: psi?.desktop?.score ?? null,
        };
      })
      .reverse(),
    insight,
    reports: reportRows.map((r) => ({ ...r, shareUrl: `/r/${r.shareToken}` })),
    pending: {
      healthCheck: await hasPendingJob(c.env, agencyId, client.id, 'health_check'),
      report: await hasPendingJob(c.env, agencyId, client.id, 'monthly_report'),
    },
  });
});

clientRoutes.put('/:id', async (c) => {
  const client = await loadClient(c, c.req.param('id'));
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const input = await readJson(c, clientInput.partial());
  const [row] = await getDb(c.env)
    .update(clients)
    .set({ ...input, updatedAt: Date.now() })
    .where(clientScope(c, client.id))
    .returning();
  return c.json({ client: row });
});

clientRoutes.delete('/:id', async (c) => {
  const client = await loadClient(c, c.req.param('id'));
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const conn = await getConnection(c.env, c.get('agencyId'), 'client_data', client.id);
  if (conn) await deleteConnection(c.env, conn);
  await getDb(c.env).delete(clients).where(clientScope(c, client.id));
  return c.json({ ok: true });
});

// ---------------------------------- Google connection ----------------------------------

/** Starts "Connect Google" for a client. Returns the Google consent URL for the browser to open. */
clientRoutes.post('/:id/google/connect', async (c) => {
  const client = await loadClient(c, c.req.param('id'));
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const { url, state } = await startGoogleOAuth(
    c.env,
    {
      purpose: 'connect_client',
      userId: currentUser(c).id,
      agencyId: c.get('agencyId'),
      clientId: client.id,
    },
    CLIENT_DATA_SCOPES,
    { offline: true },
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

/** Dropdown options: Search Console sites and GA4 properties the connected account can access. */
clientRoutes.get('/:id/google/options', async (c) => {
  const client = await loadClient(c, c.req.param('id'));
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const conn = await getConnection(c.env, c.get('agencyId'), 'client_data', client.id);
  if (!conn) return c.json({ error: 'Connect a Google account first' }, 400);
  try {
    const token = await getAccessToken(c.env, conn);
    const [sites, properties] = await Promise.allSettled([
      hasScope(conn, SCOPE.gsc) ? listGscSites(token) : Promise.resolve([]),
      hasScope(conn, SCOPE.ga4) ? listGa4Properties(token) : Promise.resolve([]),
    ]);
    return c.json({
      sites: sites.status === 'fulfilled' ? sites.value : [],
      properties: properties.status === 'fulfilled' ? properties.value : [],
      errors: {
        sites: sites.status === 'rejected' ? describeError(sites.reason) : null,
        properties: properties.status === 'rejected' ? describeError(properties.reason) : null,
      },
    });
  } catch (err) {
    if (err instanceof ReconnectNeededError) return c.json({ error: 'reconnect_needed' }, 409);
    throw err;
  }
});

const selectionInput = z.object({
  gscSiteUrl: z.string().trim().min(1).max(500).nullable(),
  ga4PropertyId: z.string().trim().regex(/^\d+$/, 'Invalid GA4 property').nullable(),
});

clientRoutes.put('/:id/google/selection', async (c) => {
  const client = await loadClient(c, c.req.param('id'));
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const input = await readJson(c, selectionInput);
  const conn = await getConnection(c.env, c.get('agencyId'), 'client_data', client.id);
  if (!conn) return c.json({ error: 'Connect a Google account first' }, 400);

  // Only allow sites/properties the connected account can actually read.
  const token = await getAccessToken(c.env, conn);
  if (input.gscSiteUrl) {
    const sites = await listGscSites(token);
    if (!sites.some((s) => s.siteUrl === input.gscSiteUrl)) {
      return c.json(
        { error: 'That Search Console site is not available for this Google account' },
        400,
      );
    }
  }
  if (input.ga4PropertyId) {
    const props = await listGa4Properties(token);
    if (!props.some((p) => p.id === input.ga4PropertyId)) {
      return c.json({ error: 'That GA4 property is not available for this Google account' }, 400);
    }
  }
  const [row] = await getDb(c.env)
    .update(clients)
    .set({
      gscSiteUrl: input.gscSiteUrl,
      ga4PropertyId: input.ga4PropertyId,
      updatedAt: Date.now(),
    })
    .where(clientScope(c, client.id))
    .returning();
  return c.json({ client: row });
});

clientRoutes.delete('/:id/google', async (c) => {
  const client = await loadClient(c, c.req.param('id'));
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const conn = await getConnection(c.env, c.get('agencyId'), 'client_data', client.id);
  if (conn) await deleteConnection(c.env, conn);
  await getDb(c.env)
    .update(clients)
    .set({ status: 'not_connected', gscSiteUrl: null, ga4PropertyId: null, updatedAt: Date.now() })
    .where(clientScope(c, client.id));
  return c.json({ ok: true });
});

// ---------------------------------------- Jobs ----------------------------------------

const runInput = z.object({
  type: z.enum(['health_check', 'monthly_report']).default('health_check'),
  send: z.boolean().optional(),
});

/** "Run now": queue a health check (or report preview) for this client. */
clientRoutes.post('/:id/run', async (c) => {
  const client = await loadClient(c, c.req.param('id'));
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const input = await readJson(c, runInput);
  const agencyId = c.get('agencyId');
  if (
    input.type === 'monthly_report' &&
    !(await getConnection(c.env, agencyId, 'agency_workspace'))
  ) {
    return c.json(
      { error: 'Connect your agency Google account in Settings before creating reports' },
      400,
    );
  }
  if (await hasPendingJob(c.env, agencyId, client.id, input.type)) {
    return c.json({ error: 'This job is already queued or running for this client' }, 409);
  }
  const [jobRunId] = await enqueueJobs(c.env, [
    {
      agencyId,
      clientId: client.id,
      type: input.type,
      trigger: 'manual',
      send: input.type === 'monthly_report' ? (input.send ?? false) : undefined,
    },
  ]);
  return c.json({ jobRunId }, 202);
});

// ------------------------------------- Action items -------------------------------------

export const actionItemRoutes = new Hono<AppEnv>();
actionItemRoutes.use('*', requireAgency);

actionItemRoutes.patch('/:id', async (c) => {
  const { done } = await readJson(c, z.object({ done: z.boolean() }));
  const db = getDb(c.env);
  const item = await db.query.actionItems.findFirst({
    where: and(eq(actionItems.id, c.req.param('id')), eq(actionItems.agencyId, c.get('agencyId'))),
  });
  if (!item || !(await loadClient(c, item.clientId)))
    return c.json({ error: 'Action item not found' }, 404);
  await db
    .update(actionItems)
    .set({ done, doneAt: done ? Date.now() : null })
    .where(and(eq(actionItems.id, item.id), eq(actionItems.agencyId, c.get('agencyId'))));
  return c.json({ ok: true, done });
});
