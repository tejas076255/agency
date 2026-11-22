// Phase 2/3 client integrations: Business Profile (+reviews), Places competitors, Natural Language
// sentiment, Sheets export, Google Ads, YouTube. All routes are tenant-scoped via clientScope().
import { Hono, type Context } from 'hono';
import { setCookie } from 'hono/cookie';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  clients,
  competitors,
  healthChecks,
  reviews,
  reviewSentiments,
  sheetsExports,
  users,
} from '../db/schema';
import { listAdsCustomers, type AdsSummary } from '../google/ads';
import {
  listGbpAccounts,
  listGbpLocations,
  replyToReview,
  type GbpSummary,
} from '../google/business';
import type { Ga4Summary } from '../google/ga4';
import type { GscSummary } from '../google/gsc';
import { describeError, ReconnectNeededError } from '../google/http';
import { topThemes, type SentimentLabel } from '../google/language';
import { compareWithCompetitors, getPlace, searchPlaces } from '../google/places';
import { createSpreadsheet, type SheetTab } from '../google/sheets';
import {
  CLIENT_PRODUCTS,
  deleteConnection,
  getAccessToken,
  getConnection,
  type ClientProduct,
} from '../google/tokens';
import { listMyChannels, type YouTubeSummary } from '../google/youtube';
import { runGbpDiagnostics } from '../jobs/gbp-diagnostics';
import { latestSnapshot, reviewStats } from '../jobs/integrations';
import { auditRequest } from '../lib/audit';
import { getDb } from '../lib/db';
import { OAUTH_STATE_COOKIE, startGoogleOAuth } from '../lib/google-oauth';
import { readJson } from '../lib/validate';
import { currentUser, requireAgency, requireOwner } from '../middleware/auth';
import type { AppEnv } from '../types';
import { clientScope } from './clients';

export const integrationRoutes = new Hono<AppEnv>();
integrationRoutes.use('*', requireAgency);

type Product = Exclude<ClientProduct, 'data'>;
const productSchema = z.enum(['gbp', 'ads', 'youtube']);
const MAX_COMPETITORS = 10;

async function loadClient(c: Context<AppEnv>) {
  return getDb(c.env).query.clients.findFirst({ where: clientScope(c, c.req.param('id')) });
}

function parseProduct(c: Context<AppEnv>): Product | null {
  const p = productSchema.safeParse(c.req.param('product'));
  return p.success ? p.data : null;
}

/** Everything the client's Local SEO / Ads / YouTube tabs need, in one call. */
integrationRoutes.get('/:id/integrations', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const agencyId = c.get('agencyId');
  const db = getDb(c.env);

  const product = async (p: Product, selected: string | null) => {
    const conn = await getConnection(c.env, agencyId, CLIENT_PRODUCTS[p].purpose, client.id);
    return {
      connection: conn
        ? { googleEmail: conn.googleEmail, status: conn.status, connectedAt: conn.connectedAt }
        : null,
      selected,
      latest: await latestSnapshot(c.env, agencyId, client.id, p),
    };
  };

  const recent = await db
    .select({
      id: reviews.id,
      reviewerName: reviews.reviewerName,
      starRating: reviews.starRating,
      comment: reviews.comment,
      reviewCreatedAt: reviews.reviewCreatedAt,
      replyComment: reviews.replyComment,
      label: reviewSentiments.label,
      score: reviewSentiments.score,
      entitiesJson: reviewSentiments.entitiesJson,
    })
    .from(reviews)
    .leftJoin(reviewSentiments, eq(reviewSentiments.reviewId, reviews.id))
    .where(and(eq(reviews.agencyId, agencyId), eq(reviews.clientId, client.id)))
    .orderBy(desc(reviews.reviewCreatedAt))
    .limit(100);

  const analyzed = recent
    .filter((r) => r.label)
    .map((r) => ({
      label: r.label as SentimentLabel,
      entities: r.entitiesJson ? (JSON.parse(r.entitiesJson) as { name: string }[]) : [],
    }));
  const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
  for (const a of analyzed) sentimentCounts[a.label]++;

  // Monthly review trend (count + average stars) for the last 6 months, months in IST.
  const trend = await c.env.DB.prepare(
    `SELECT strftime('%Y-%m', review_created_at / 1000, 'unixepoch', '+330 minutes') AS month,
            COUNT(*) AS count, ROUND(AVG(star_rating), 2) AS avgRating
     FROM reviews WHERE agency_id = ?1 AND client_id = ?2 AND review_created_at >= ?3
     GROUP BY month ORDER BY month`,
  )
    .bind(agencyId, client.id, Date.now() - 183 * 86_400_000)
    .all<{ month: string; count: number; avgRating: number }>();

  const comps = await db
    .select()
    .from(competitors)
    .where(and(eq(competitors.agencyId, agencyId), eq(competitors.clientId, client.id)))
    .orderBy(competitors.createdAt);
  const exports = await db
    .select()
    .from(sheetsExports)
    .where(and(eq(sheetsExports.agencyId, agencyId), eq(sheetsExports.clientId, client.id)))
    .orderBy(desc(sheetsExports.createdAt))
    .limit(10);

  return c.json({
    config: {
      places: Boolean(c.env.PLACES_API_KEY),
      naturalLanguage: Boolean(c.env.NATURAL_LANGUAGE_API_KEY),
      workspaceConnected: Boolean(await getConnection(c.env, agencyId, 'agency_workspace')),
    },
    gbp: await product('gbp', client.gbpLocationName),
    ads: await product('ads', client.adsCustomerId),
    youtube: await product('youtube', client.youtubeChannelId),
    reviews: {
      stats: await reviewStats(c.env, agencyId, client.id),
      sentimentCounts,
      themes: {
        positive: topThemes(analyzed, 'positive'),
        negative: topThemes(analyzed, 'negative'),
      },
      trend: trend.results ?? [],
      recent: recent.slice(0, 50).map(({ entitiesJson, score, ...r }) => ({
        ...r,
        sentimentScore: score === null ? null : score / 100,
        entities: entitiesJson
          ? (JSON.parse(entitiesJson) as { name: string }[]).map((e) => e.name)
          : [],
      })),
    },
    competitors: comps.map((x) => ({
      id: x.id,
      placeId: x.placeId,
      label: x.label,
      isClient: x.isClient,
    })),
    exports: exports.map((e) => ({
      id: e.id,
      url: e.url,
      status: e.status,
      error: e.error,
      createdAt: e.createdAt,
    })),
  });
});

/** Start the Google consent flow for one product. */
integrationRoutes.post('/:id/integrations/:product/connect', async (c) => {
  const client = await loadClient(c);
  const product = parseProduct(c);
  if (!client || !product) return c.json({ error: 'Not found' }, 404);
  const { url, state } = await startGoogleOAuth(
    c.env,
    {
      purpose: 'connect_client',
      product,
      userId: currentUser(c).id,
      agencyId: c.get('agencyId'),
      clientId: client.id,
    },
    [...CLIENT_PRODUCTS[product].scopes],
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

async function productToken(c: Context<AppEnv>, product: Product, clientId: string) {
  const conn = await getConnection(
    c.env,
    c.get('agencyId'),
    CLIENT_PRODUCTS[product].purpose,
    clientId,
  );
  if (!conn) return null;
  return getAccessToken(c.env, conn);
}

const fmtAdsId = (id: string) => id.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');

/** Dropdown options for the product (GBP locations, Ads accounts, YouTube channels). */
integrationRoutes.get('/:id/integrations/:product/options', async (c) => {
  const client = await loadClient(c);
  const product = parseProduct(c);
  if (!client || !product) return c.json({ error: 'Not found' }, 404);
  try {
    const token = await productToken(c, product, client.id);
    if (!token) return c.json({ error: 'Connect the Google account first' }, 400);
    if (product === 'gbp') {
      const accounts = await listGbpAccounts(token);
      const locations = (
        await Promise.all(accounts.slice(0, 10).map((a) => listGbpLocations(token, a.name)))
      ).flat();
      return c.json({
        options: locations.map((l) => ({
          id: l.name,
          label: `${l.title}${l.address ? ` · ${l.address}` : ''}`,
          accountName: l.accountName,
        })),
      });
    }
    if (product === 'ads') {
      const customers = (await listAdsCustomers(c.env, token)) ?? [];
      return c.json({
        options: customers
          .filter((x) => !x.manager)
          .map((x) => ({
            id: x.id,
            label: `${x.name} (${fmtAdsId(x.id)})${x.currency ? ` · ${x.currency}` : ''}`,
          })),
      });
    }
    const channels = await listMyChannels(token);
    return c.json({
      options: channels.map((ch) => ({
        id: ch.id,
        label: `${ch.title}${ch.subscribers !== null ? ` · ${ch.subscribers.toLocaleString('en-IN')} subscribers` : ''}`,
      })),
    });
  } catch (err) {
    if (err instanceof ReconnectNeededError) return c.json({ error: 'reconnect_needed' }, 409);
    return c.json({ error: describeError(err) }, 400);
  }
});

/**
 * Business Profile diagnostics (owner only): token scopes, accounts, locations, the user's role per
 * location, and a live probe of each sync call with Google's full error response.
 * Open in the browser while signed in: /api/clients/<clientId>/integrations/gbp/debug
 */
integrationRoutes.get('/:id/integrations/gbp/debug', requireOwner, async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const conn = await getConnection(c.env, c.get('agencyId'), 'client_business', client.id);
  if (!conn) return c.json({ error: 'Business Profile is not connected for this client' }, 400);
  let token: string;
  try {
    token = await getAccessToken(c.env, conn);
  } catch (err) {
    return c.json({ error: describeError(err) }, 400);
  }
  const report = await runGbpDiagnostics(token, conn.googleEmail, {
    accountName: client.gbpAccountName,
    locationName: client.gbpLocationName,
  });
  return c.json({
    connection: { status: conn.status, storedScopes: conn.scopes.split(' ') },
    ...report,
  });
});

integrationRoutes.put('/:id/integrations/:product/selection', async (c) => {
  const client = await loadClient(c);
  const product = parseProduct(c);
  if (!client || !product) return c.json({ error: 'Not found' }, 404);
  const { id, accountName } = await readJson(
    c,
    z.object({
      id: z.string().trim().min(1).max(200),
      accountName: z.string().trim().max(200).optional(),
    }),
  );
  // Only accept values the connected account can actually access.
  const token = await productToken(c, product, client.id);
  if (!token) return c.json({ error: 'Connect the Google account first' }, 400);
  const set: Partial<typeof clients.$inferInsert> = { updatedAt: Date.now() };
  try {
    if (product === 'gbp') {
      if (!/^locations\/\d+$/.test(id) || !accountName || !/^accounts\/\d+$/.test(accountName)) {
        return c.json({ error: 'Invalid location' }, 400);
      }
      const locs = await listGbpLocations(token, accountName);
      if (!locs.some((l) => l.name === id))
        return c.json({ error: 'Location not available for this account' }, 400);
      set.gbpLocationName = id;
      set.gbpAccountName = accountName;
    } else if (product === 'ads') {
      const customers = (await listAdsCustomers(c.env, token)) ?? [];
      if (!customers.some((x) => x.id === id && !x.manager))
        return c.json({ error: 'Ads account not available' }, 400);
      set.adsCustomerId = id;
    } else {
      const channels = await listMyChannels(token);
      if (!channels.some((ch) => ch.id === id))
        return c.json({ error: 'Channel not available' }, 400);
      set.youtubeChannelId = id;
    }
  } catch (err) {
    return c.json({ error: describeError(err) }, 400);
  }
  await getDb(c.env).update(clients).set(set).where(clientScope(c, client.id));
  await auditRequest(c, 'client.integration_selection', {
    targetType: 'client',
    targetId: client.id,
    metadata: { product, id },
  });
  return c.json({ ok: true });
});

integrationRoutes.delete('/:id/integrations/:product', async (c) => {
  const client = await loadClient(c);
  const product = parseProduct(c);
  if (!client || !product) return c.json({ error: 'Not found' }, 404);
  const conn = await getConnection(
    c.env,
    c.get('agencyId'),
    CLIENT_PRODUCTS[product].purpose,
    client.id,
  );
  if (conn) await deleteConnection(c.env, conn);
  const clear =
    product === 'gbp'
      ? { gbpLocationName: null, gbpAccountName: null }
      : product === 'ads'
        ? { adsCustomerId: null }
        : { youtubeChannelId: null };
  await getDb(c.env)
    .update(clients)
    .set({ ...clear, updatedAt: Date.now() })
    .where(clientScope(c, client.id));
  await auditRequest(c, 'google.product_disconnect', {
    targetType: 'client',
    targetId: client.id,
    metadata: { product },
  });
  return c.json({ ok: true });
});

// ------------------------------------ Reviews ------------------------------------

integrationRoutes.post('/:id/reviews/:reviewId/reply', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const { comment } = await readJson(c, z.object({ comment: z.string().trim().min(2).max(4000) }));
  const db = getDb(c.env);
  const review = await db.query.reviews.findFirst({
    where: and(
      eq(reviews.id, c.req.param('reviewId')),
      eq(reviews.clientId, client.id),
      eq(reviews.agencyId, c.get('agencyId')),
    ),
  });
  if (!review) return c.json({ error: 'Review not found' }, 404);
  try {
    const token = await productToken(c, 'gbp', client.id);
    if (!token) return c.json({ error: 'Business Profile is not connected' }, 400);
    await replyToReview(token, review.googleReviewName, comment);
  } catch (err) {
    return c.json({ error: describeError(err) }, 400);
  }
  await db
    .update(reviews)
    .set({ replyComment: comment, replyUpdatedAt: Date.now() })
    .where(and(eq(reviews.id, review.id), eq(reviews.agencyId, c.get('agencyId'))));
  await auditRequest(c, 'review.reply', { targetType: 'review', targetId: review.id });
  return c.json({ ok: true });
});

// ---------------------------------- Competitors ----------------------------------

integrationRoutes.get('/:id/competitors/search', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  if (!c.env.PLACES_API_KEY)
    return c.json({ error: 'Places API is not configured (PLACES_API_KEY)' }, 400);
  const q = z.string().trim().min(3).max(120).safeParse(c.req.query('q'));
  if (!q.success) return c.json({ error: 'Type at least 3 characters' }, 400);
  try {
    return c.json({ results: await searchPlaces(c.env.PLACES_API_KEY, q.data) });
  } catch (err) {
    return c.json({ error: describeError(err) }, 400);
  }
});

integrationRoutes.post('/:id/competitors', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const input = await readJson(
    c,
    z.object({
      placeId: z.string().regex(/^[A-Za-z0-9_-]{10,300}$/),
      label: z.string().trim().min(1).max(120),
      isClient: z.boolean().default(false),
    }),
  );
  const db = getDb(c.env);
  const existing = await db
    .select({ n: sql<number>`count(*)` })
    .from(competitors)
    .where(and(eq(competitors.agencyId, c.get('agencyId')), eq(competitors.clientId, client.id)));
  if ((existing[0]?.n ?? 0) >= MAX_COMPETITORS) {
    return c.json({ error: `Up to ${MAX_COMPETITORS} places per client` }, 400);
  }
  await db
    .insert(competitors)
    .values({
      id: crypto.randomUUID(),
      agencyId: c.get('agencyId'),
      clientId: client.id,
      ...input,
      createdAt: Date.now(),
    })
    .onConflictDoNothing();
  await auditRequest(c, 'competitor.add', {
    targetType: 'client',
    targetId: client.id,
    metadata: { label: input.label },
  });
  return c.json({ ok: true }, 201);
});

integrationRoutes.delete('/:id/competitors/:competitorId', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  await getDb(c.env)
    .delete(competitors)
    .where(
      and(
        eq(competitors.id, c.req.param('competitorId')),
        eq(competitors.clientId, client.id),
        eq(competitors.agencyId, c.get('agencyId')),
      ),
    );
  await auditRequest(c, 'competitor.remove', { targetType: 'client', targetId: client.id });
  return c.json({ ok: true });
});

/** Live comparison: ratings and review counts are fetched now and never stored (Places terms). */
integrationRoutes.get('/:id/competitors/live', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  if (!c.env.PLACES_API_KEY)
    return c.json({ error: 'Places API is not configured (PLACES_API_KEY)' }, 400);
  const key = c.env.PLACES_API_KEY;
  const rows = await getDb(c.env)
    .select()
    .from(competitors)
    .where(and(eq(competitors.agencyId, c.get('agencyId')), eq(competitors.clientId, client.id)));
  const live = await Promise.allSettled(rows.map((r) => getPlace(key, r.placeId)));
  const ok = live.flatMap((r, i) =>
    r.status === 'fulfilled'
      ? [
          {
            ...r.value,
            label: rows[i]!.label,
            isClient: rows[i]!.isClient,
            competitorId: rows[i]!.id,
          },
        ]
      : [],
  );
  const failed = live.filter((r) => r.status === 'rejected').length;
  return c.json({ ...compareWithCompetitors(ok), failed, attribution: 'Data © Google' });
});

// ---------------------------------- Sheets export ----------------------------------

type ExportReview = {
  createdAt: number | null;
  stars: number | null;
  comment: string | null;
  reply: string | null;
  label: string | null;
  score: number | null;
};

/** Pure (unit-tested): data -> spreadsheet tabs. Original and AI-derived columns are labelled. */
export function buildExportTabs(d: {
  gsc: GscSummary | null;
  ga4: Ga4Summary | null;
  gbp: GbpSummary | null;
  ads: AdsSummary | null;
  yt: YouTubeSummary | null;
  reviews: ExportReview[];
}): SheetTab[] {
  const tabs: SheetTab[] = [];
  if (d.gsc) {
    tabs.push({
      title: 'Search queries',
      rows: [
        ['Query', 'Clicks', 'Impressions', 'CTR %', 'Position'],
        ...d.gsc.topQueries.map((q) => [q.query, q.clicks, q.impressions, q.ctr, q.position]),
      ],
    });
    tabs.push({
      title: 'Quick wins',
      rows: [
        ['Query', 'Impressions', 'Clicks', 'Position'],
        ...d.gsc.quickWins.map((q) => [q.query, q.impressions, q.clicks, q.position]),
      ],
    });
    tabs.push({
      title: 'Daily clicks',
      rows: [['Date', 'Clicks'], ...d.gsc.dailyClicks.map((x) => [x.date, x.clicks])],
    });
  }
  if (d.ga4) {
    tabs.push({
      title: 'GA4 channels',
      rows: [['Channel', 'Sessions'], ...d.ga4.topChannels.map((x) => [x.channel, x.sessions])],
    });
    tabs.push({
      title: 'GA4 daily sessions',
      rows: [['Date', 'Sessions'], ...d.ga4.dailySessions.map((x) => [x.date, x.sessions])],
    });
  }
  if (d.gbp) {
    tabs.push({
      title: 'Business Profile',
      rows: [
        ['Date', 'Impressions', 'Calls', 'Directions', 'Website clicks'],
        ...d.gbp.daily.map((x) => [x.date, x.impressions, x.calls, x.directions, x.websiteClicks]),
      ],
    });
  }
  if (d.reviews.length) {
    tabs.push({
      title: 'Reviews',
      rows: [
        [
          'Date',
          'Stars',
          'Review (original)',
          'Reply',
          'Sentiment (AI-derived)',
          'Sentiment score (AI-derived)',
        ],
        ...d.reviews.map((r) => [
          r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '',
          r.stars,
          r.comment,
          r.reply,
          r.label,
          r.score === null ? null : r.score / 100,
        ]),
      ],
    });
  }
  if (d.ads) {
    tabs.push({
      title: 'Google Ads campaigns',
      rows: [
        [
          'Campaign',
          'Status',
          `Cost (${d.ads.currency})`,
          'Clicks',
          'Impressions',
          'Conversions',
          'Conv. value',
        ],
        ...d.ads.campaigns.map((x) => [
          x.name,
          x.status,
          x.cost,
          x.clicks,
          x.impressions,
          x.conversions,
          x.conversionValue,
        ]),
      ],
    });
    tabs.push({
      title: 'Wasted search terms',
      rows: [
        ['Search term', 'Campaign', `Cost (${d.ads.currency})`, 'Clicks'],
        ...d.ads.wastedSearchTerms.map((x) => [x.term, x.campaign, x.cost, x.clicks]),
      ],
    });
  }
  if (d.yt) {
    tabs.push({
      title: 'YouTube daily',
      rows: [
        ['Date', 'Views', 'Watch minutes', 'Net subscribers'],
        ...d.yt.daily.map((x) => [x.date, x.views, x.watchMinutes, x.netSubscribers]),
      ],
    });
    tabs.push({
      title: 'YouTube top videos',
      rows: [
        ['Video', 'Views', 'Watch minutes', 'Avg view (s)'],
        ...d.yt.topVideos.map((x) => [x.title, x.views, x.watchMinutes, x.avgViewDurationSec]),
      ],
    });
  }
  return tabs;
}

integrationRoutes.post('/:id/exports/sheets', async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const agencyId = c.get('agencyId');
  const db = getDb(c.env);
  const conn = await getConnection(c.env, agencyId, 'agency_workspace');
  if (!conn) return c.json({ error: 'Connect the agency Google account in Settings first' }, 400);

  const check = await db.query.healthChecks.findFirst({
    where: and(eq(healthChecks.agencyId, agencyId), eq(healthChecks.clientId, client.id)),
    orderBy: desc(healthChecks.runAt),
  });
  const revRows = await db
    .select({
      createdAt: reviews.reviewCreatedAt,
      stars: reviews.starRating,
      comment: reviews.comment,
      reply: reviews.replyComment,
      label: reviewSentiments.label,
      score: reviewSentiments.score,
    })
    .from(reviews)
    .leftJoin(reviewSentiments, eq(reviewSentiments.reviewId, reviews.id))
    .where(and(eq(reviews.agencyId, agencyId), eq(reviews.clientId, client.id)))
    .orderBy(desc(reviews.reviewCreatedAt))
    .limit(500);

  const tabs = buildExportTabs({
    gsc: check?.gscJson ? (JSON.parse(check.gscJson) as GscSummary) : null,
    ga4: check?.ga4Json ? (JSON.parse(check.ga4Json) as Ga4Summary) : null,
    gbp: (await latestSnapshot<GbpSummary>(c.env, agencyId, client.id, 'gbp'))?.data ?? null,
    ads: (await latestSnapshot<AdsSummary>(c.env, agencyId, client.id, 'ads'))?.data ?? null,
    yt: (await latestSnapshot<YouTubeSummary>(c.env, agencyId, client.id, 'youtube'))?.data ?? null,
    reviews: revRows,
  });
  if (tabs.length === 0)
    return c.json({ error: 'No data to export yet. Run a health check first.' }, 400);

  const id = crypto.randomUUID();
  try {
    const token = await getAccessToken(c.env, conn);
    const title = `${client.name} - Agency Autopilot export ${new Date().toISOString().slice(0, 10)}`;
    const res = await createSpreadsheet(token, title, tabs);
    await db.insert(sheetsExports).values({
      id,
      agencyId,
      clientId: client.id,
      spreadsheetId: res.spreadsheetId,
      url: res.url,
      status: 'ok',
      createdAt: Date.now(),
    });
    await auditRequest(c, 'export.sheets', {
      targetType: 'client',
      targetId: client.id,
      metadata: { tabs: tabs.map((t) => t.title) },
    });
    return c.json({ url: res.url });
  } catch (err) {
    const msg = describeError(err);
    await db.insert(sheetsExports).values({
      id,
      agencyId,
      clientId: client.id,
      status: 'failed',
      error: msg.slice(0, 500),
      createdAt: Date.now(),
    });
    return c.json({ error: msg }, 400);
  }
});

// Owner-only: assign a client to a member (Phase 2 team).
integrationRoutes.put('/:id/assignee', requireOwner, async (c) => {
  const client = await loadClient(c);
  if (!client) return c.json({ error: 'Client not found' }, 404);
  const { userId } = await readJson(c, z.object({ userId: z.string().nullable() }));
  if (userId) {
    const member = await getDb(c.env).query.users.findFirst({
      where: and(eq(users.id, userId), eq(users.agencyId, c.get('agencyId'))),
    });
    if (!member) return c.json({ error: 'User is not in your agency' }, 400);
  }
  await getDb(c.env)
    .update(clients)
    .set({ assignedUserId: userId, updatedAt: Date.now() })
    .where(clientScope(c, client.id));
  await auditRequest(c, 'client.assign', {
    targetType: 'client',
    targetId: client.id,
    metadata: { userId },
  });
  return c.json({ ok: true });
});

// ----------------------------- Agency-wide channel overview -----------------------------

export const channelRoutes = new Hono<AppEnv>();
channelRoutes.use('*', requireAgency);

/** Latest Local SEO / Ads / YouTube numbers for every visible client (agency pages). */
channelRoutes.get('/overview', async (c) => {
  const agencyId = c.get('agencyId');
  const list = await getDb(c.env)
    .select()
    .from(clients)
    .where(clientScope(c))
    .orderBy(clients.name);
  const rows = await Promise.all(
    list.map(async (cl) => {
      const [gbp, ads, yt, rev] = await Promise.all([
        cl.gbpLocationName ? latestSnapshot<GbpSummary>(c.env, agencyId, cl.id, 'gbp') : null,
        cl.adsCustomerId ? latestSnapshot<AdsSummary>(c.env, agencyId, cl.id, 'ads') : null,
        cl.youtubeChannelId
          ? latestSnapshot<YouTubeSummary>(c.env, agencyId, cl.id, 'youtube')
          : null,
        reviewStats(c.env, agencyId, cl.id),
      ]);
      return {
        id: cl.id,
        name: cl.name,
        gbpSelected: Boolean(cl.gbpLocationName),
        adsSelected: Boolean(cl.adsCustomerId),
        youtubeSelected: Boolean(cl.youtubeChannelId),
        gbp: gbp && {
          runAt: gbp.runAt,
          error: gbp.error,
          calls: gbp.data?.totals.current.calls ?? null,
          callsChangePct: gbp.data?.changePct.calls ?? null,
          directions: gbp.data?.totals.current.directions ?? null,
          impressions: gbp.data?.totals.current.impressions ?? null,
          rating: gbp.data?.reviews.averageRating ?? null,
          reviewCount: gbp.data?.reviews.totalReviewCount ?? null,
        },
        reviews: rev,
        ads: ads && {
          runAt: ads.runAt,
          error: ads.error,
          currency: ads.data?.currency ?? null,
          cost: ads.data?.totals.current.cost ?? null,
          conversions: ads.data?.totals.current.conversions ?? null,
          roas: ads.data?.derived.roas ?? null,
          wastedSpend: ads.data?.wastedSpend ?? null,
        },
        youtube: yt && {
          runAt: yt.runAt,
          error: yt.error,
          views: yt.data?.totals.current.views ?? null,
          viewsChangePct: yt.data?.changePct.views ?? null,
          netSubscribers: yt.data
            ? yt.data.totals.current.subscribersGained - yt.data.totals.current.subscribersLost
            : null,
        },
      };
    }),
  );
  return c.json({ clients: rows });
});
