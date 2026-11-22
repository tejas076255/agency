// AI feature routes. Client routes are tenant-scoped via clientScope() (members: assigned clients
// only). Every on-demand AI call counts towards the plan's daily AI limit (useAiQuota).
import { Hono, type Context } from 'hono';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { agencies, alerts, clients, competitors, prospectAudits } from '../db/schema';
import type { AdsSummary } from '../google/ads';
import type { GbpSummary } from '../google/business';
import { describeError } from '../google/http';
import { getPlaceReviews } from '../google/places';
import { buildClientContext } from '../jobs/client-context';
import { latestSnapshot } from '../jobs/integrations';
import {
  AiUnavailableError,
  analyzeCompetitors,
  assistantReply,
  generateAdCopy,
  generateContent,
  writeAuditReport,
  type SiteChecks,
} from '../lib/ai-tools';
import { auditRequest } from '../lib/audit';
import { getDb } from '../lib/db';
import { buildCompactSummary } from '../lib/insights';
import { aiRequestsToday, getPlanUsage, useAiQuota } from '../lib/plans';
import { rateLimit } from '../lib/rate-limit';
import { runSiteChecks } from '../lib/site-audit';
import { readJson } from '../lib/validate';
import { currentUser, requireAgency, requireOwner } from '../middleware/auth';
import type { AppEnv } from '../types';
import { clientScope } from './clients';

const languageSchema = z.enum(['en', 'hinglish', 'hi']).default('en');
const aiLimit = (name: string, limit = 20) => rateLimit({ name, limit, windowSeconds: 60 });

async function loadClient(c: Context<AppEnv>) {
  return getDb(c.env).query.clients.findFirst({ where: clientScope(c, c.req.param('id')) });
}

function aiError(c: Context<AppEnv>, err: unknown) {
  if (err instanceof AiUnavailableError) return c.json({ error: err.message }, 503);
  throw err;
}

// ------------------------------------ per-client AI tools ------------------------------------

export const aiClientRoutes = new Hono<AppEnv>();
aiClientRoutes.use('*', requireAgency);

aiClientRoutes.post('/:id/ai/assistant', aiLimit('ai-assistant', 30), async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const { messages } = await readJson(
    c,
    z.object({
      messages: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: z.string().trim().min(1).max(2000),
          }),
        )
        .min(1)
        .max(20)
        .refine((m) => m[m.length - 1]!.role === 'user', 'The last message must be from the user'),
    }),
  );
  await useAiQuota(c.env, c.get('agencyId'));
  try {
    const context = await buildClientContext(c.env, c.get('agencyId'), client);
    const r = await assistantReply(c.env, context, messages);
    return c.json({ reply: r.reply });
  } catch (err) {
    return aiError(c, err);
  }
});

aiClientRoutes.post('/:id/ai/content', aiLimit('ai-content'), async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const input = await readJson(
    c,
    z.object({
      type: z.enum(['meta_tags', 'blog_outline', 'blog_post', 'gbp_post']),
      keyword: z.string().trim().min(2).max(120),
      language: languageSchema,
      notes: z.string().trim().max(1500).optional(),
    }),
  );
  await useAiQuota(c.env, c.get('agencyId'));
  const gbp = await latestSnapshot<GbpSummary>(c.env, c.get('agencyId'), client.id, 'gbp');
  try {
    const r = await generateContent(c.env, {
      ...input,
      business: {
        name: client.name,
        website: client.websiteUrl,
        category: gbp?.data?.location.primaryCategory ?? null,
      },
    });
    return c.json({ type: r.type, data: r.data });
  } catch (err) {
    return aiError(c, err);
  }
});

aiClientRoutes.post('/:id/ai/ad-copy', aiLimit('ai-ad-copy'), async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const input = await readJson(
    c,
    z.object({
      product: z.string().trim().max(200).optional(),
      notes: z.string().trim().max(1000).optional(),
      language: languageSchema,
    }),
  );
  await useAiQuota(c.env, c.get('agencyId'));
  const ads = await latestSnapshot<AdsSummary>(c.env, c.get('agencyId'), client.id, 'ads');
  const compact = ads?.data
    ? buildCompactSummary(client, null, null, null, null, { ads: ads.data }).google_ads
    : null;
  try {
    const r = await generateAdCopy(c.env, {
      business: { name: client.name, website: client.websiteUrl },
      ads: compact,
      product: input.product,
      notes: input.notes,
      language: input.language,
    });
    return c.json({
      headlines: r.headlines,
      descriptions: r.descriptions,
      negativeKeywords: r.negative_keywords,
      tips: r.tips,
      basedOnAdsData: Boolean(compact),
    });
  } catch (err) {
    return aiError(c, err);
  }
});

/** Live: review texts come from Places now and are never stored; neither is the analysis. */
aiClientRoutes.post('/:id/competitors/ai-analysis', aiLimit('ai-competitors', 6), async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const key = c.env.PLACES_API_KEY;
  if (!key) return c.json({ error: 'Places API is not configured (PLACES_API_KEY)' }, 400);
  const { language } = await readJson(c, z.object({ language: languageSchema }));
  const rows = await getDb(c.env)
    .select()
    .from(competitors)
    .where(and(eq(competitors.agencyId, c.get('agencyId')), eq(competitors.clientId, client.id)));
  if (rows.length < 2) {
    return c.json({ error: 'Add the client’s own listing and at least one competitor first' }, 400);
  }
  await useAiQuota(c.env, c.get('agencyId'));
  const places = await Promise.allSettled(rows.map((r) => getPlaceReviews(key, r.placeId)));
  const ok = places.flatMap((p, i) =>
    p.status === 'fulfilled'
      ? [{ ...p.value, name: rows[i]!.label || p.value.name, isClient: rows[i]!.isClient }]
      : [],
  );
  if (ok.length < 2) {
    const first = places.find((p) => p.status === 'rejected') as PromiseRejectedResult | undefined;
    return c.json({ error: `Could not load reviews: ${describeError(first?.reason)}` }, 400);
  }
  try {
    const r = await analyzeCompetitors(c.env, ok, language);
    return c.json({
      summary: r.summary,
      places: r.places,
      opportunities: r.opportunities,
      reviewsAnalyzed: ok.reduce((n, p) => n + p.reviews.length, 0),
    });
  } catch (err) {
    return aiError(c, err);
  }
});

aiClientRoutes.get('/:id/alerts', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const rows = await getDb(c.env)
    .select()
    .from(alerts)
    .where(and(eq(alerts.agencyId, c.get('agencyId')), eq(alerts.clientId, client.id)))
    .orderBy(desc(alerts.createdAt))
    .limit(30);
  return c.json({ alerts: rows.map(toAlert) });
});

/** Review auto-reply rule. Owner only: it posts publicly on Google without a human check. */
aiClientRoutes.put('/:id/auto-reply', requireOwner, async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const input = await readJson(
    c,
    z.object({
      minStars: z.union([z.literal(4), z.literal(5), z.null()]),
      language: z.enum(['en', 'hinglish', 'hi']),
    }),
  );
  await getDb(c.env)
    .update(clients)
    .set({
      autoReplyMinStars: input.minStars,
      autoReplyLanguage: input.language,
      updatedAt: Date.now(),
    })
    .where(clientScope(c, client.id));
  await auditRequest(c, 'review.auto_reply_settings', {
    targetType: 'client',
    targetId: client.id,
    metadata: input,
  });
  return c.json({ ok: true });
});

// ------------------------------------ agency-wide alerts ------------------------------------

function toAlert(a: typeof alerts.$inferSelect) {
  return {
    id: a.id,
    clientId: a.clientId,
    kind: a.kind,
    severity: a.severity,
    title: a.title,
    explanation: a.explanation,
    explanationSource: a.explanationSource,
    emailed: Boolean(a.emailedAt),
    read: Boolean(a.readAt),
    createdAt: a.createdAt,
  };
}

export const alertRoutes = new Hono<AppEnv>();
alertRoutes.use('*', requireAgency);

alertRoutes.get('/', async (c) => {
  const rows = await getDb(c.env)
    .select({ alert: alerts, clientName: clients.name })
    .from(alerts)
    .innerJoin(clients, eq(clients.id, alerts.clientId))
    .where(and(eq(alerts.agencyId, c.get('agencyId')), clientScope(c)))
    .orderBy(desc(alerts.createdAt))
    .limit(50);
  return c.json({
    alerts: rows.map((r) => ({ ...toAlert(r.alert), clientName: r.clientName })),
    unread: rows.filter((r) => !r.alert.readAt).length,
  });
});

alertRoutes.post('/:alertId/read', async (c) => {
  const db = getDb(c.env);
  const row = await db
    .select({ id: alerts.id })
    .from(alerts)
    .innerJoin(clients, eq(clients.id, alerts.clientId))
    .where(
      and(
        eq(alerts.id, c.req.param('alertId')),
        eq(alerts.agencyId, c.get('agencyId')),
        clientScope(c),
      ),
    );
  if (!row.length) return c.json({ error: 'Alert not found' }, 404);
  await db
    .update(alerts)
    .set({ readAt: Date.now() })
    .where(and(eq(alerts.id, row[0]!.id), eq(alerts.agencyId, c.get('agencyId'))));
  return c.json({ ok: true });
});

alertRoutes.post('/read-all', async (c) => {
  const user = currentUser(c);
  const agencyId = c.get('agencyId');
  // Members only mark alerts of their assigned clients.
  const scope =
    user.role === 'member'
      ? sql`${alerts.clientId} IN (SELECT id FROM clients WHERE agency_id = ${agencyId} AND assigned_user_id = ${user.id})`
      : sql`1 = 1`;
  await getDb(c.env)
    .update(alerts)
    .set({ readAt: Date.now() })
    .where(and(eq(alerts.agencyId, agencyId), isNull(alerts.readAt), scope));
  return c.json({ ok: true });
});

// ------------------------------------ AI usage ------------------------------------

export const aiUsageRoutes = new Hono<AppEnv>();
aiUsageRoutes.use('*', requireAgency);
aiUsageRoutes.get('/usage', async (c) => {
  const { limits } = await getPlanUsage(c.env, c.get('agencyId'));
  return c.json({
    used: await aiRequestsToday(c.env, c.get('agencyId')),
    limit: limits.aiRequestsPerDay,
  });
});

// ------------------------------------ prospect audits ------------------------------------

export const prospectRoutes = new Hono<AppEnv>();
prospectRoutes.use('*', requireAgency);

function toAudit(a: typeof prospectAudits.$inferSelect) {
  const parse = <T>(s: string | null) => (s ? (JSON.parse(s) as T) : null);
  return {
    id: a.id,
    url: a.url,
    businessName: a.businessName,
    status: a.status,
    checks: parse<SiteChecks & { score?: number }>(a.checksJson),
    report: parse<unknown>(a.reportJson),
    reportSource: a.reportSource,
    error: a.error,
    createdAt: a.createdAt,
  };
}

prospectRoutes.get('/', async (c) => {
  const rows = await getDb(c.env)
    .select()
    .from(prospectAudits)
    .where(eq(prospectAudits.agencyId, c.get('agencyId')))
    .orderBy(desc(prospectAudits.createdAt))
    .limit(50);
  return c.json({
    audits: rows.map((r) => {
      const a = toAudit(r);
      return { ...a, report: undefined, score: a.checks?.score ?? null, checks: undefined };
    }),
  });
});

/** Runs the checks (PageSpeed can take up to ~60 s) and the AI write-up, then stores the audit. */
prospectRoutes.post('/', aiLimit('prospect-audit', 5), async (c) => {
  const input = await readJson(
    c,
    z.object({
      url: z.string().trim().min(4).max(300),
      businessName: z.string().trim().max(120).optional(),
      language: languageSchema,
    }),
  );
  const agencyId = c.get('agencyId');
  await useAiQuota(c.env, agencyId);
  const db = getDb(c.env);
  const agency = await db.query.agencies.findFirst({ where: eq(agencies.id, agencyId) });
  let checks: SiteChecks;
  try {
    checks = await runSiteChecks(input.url, c.env.PAGESPEED_API_KEY);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  const { report, source, score } = await writeAuditReport(c.env, checks, {
    agencyName: agency?.name ?? 'Our agency',
    businessName: input.businessName ?? null,
    language: input.language,
  });
  const id = crypto.randomUUID();
  const row = {
    id,
    agencyId,
    createdByUserId: currentUser(c).id,
    url: checks.finalUrl ?? checks.url,
    businessName: input.businessName ?? null,
    status: (checks.fetchError && checks.mobileScore === null ? 'failed' : 'ready') as
      'ready' | 'failed',
    checksJson: JSON.stringify({ ...checks, score }),
    reportJson: JSON.stringify(report),
    reportSource: source,
    error: checks.fetchError,
    createdAt: Date.now(),
  };
  await db.insert(prospectAudits).values(row);
  await auditRequest(c, 'prospect.audit', { targetType: 'prospect_audit', targetId: id });
  return c.json({ audit: toAudit(row) }, 201);
});

prospectRoutes.get('/:auditId', async (c) => {
  const row = await getDb(c.env).query.prospectAudits.findFirst({
    where: and(
      eq(prospectAudits.id, c.req.param('auditId')),
      eq(prospectAudits.agencyId, c.get('agencyId')),
    ),
  });
  if (!row) return c.json({ error: 'Audit not found' }, 404);
  return c.json({ audit: toAudit(row) });
});

prospectRoutes.delete('/:auditId', async (c) => {
  await getDb(c.env)
    .delete(prospectAudits)
    .where(
      and(
        eq(prospectAudits.id, c.req.param('auditId')),
        eq(prospectAudits.agencyId, c.get('agencyId')),
      ),
    );
  await auditRequest(c, 'prospect.delete', {
    targetType: 'prospect_audit',
    targetId: c.req.param('auditId'),
  });
  return c.json({ ok: true });
});
