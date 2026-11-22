// "Grow" scan: reads the Business Profile, website, reviews and competitors, computes the
// Business Profile Score, and prepares every fix it can (AI drafts + values prefilled from the
// website) so the user only has to click "Post". Progress is kept in KV for the scan screen.
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  clients,
  competitors,
  gbpChanges,
  gbpPosts,
  healthChecks,
  profileScans,
  reviews,
  trackedKeywords,
  users,
} from '../db/schema';
import type { Env } from '../env';
import type { GbpSummary } from '../google/business';
import { countMedia, latestPostTime } from '../google/business-edit';
import type { GscSummary } from '../google/gsc';
import { getPlace } from '../google/places';
import { getAccessToken, getConnection, withAccessToken } from '../google/tokens';
import { buildMimeMessage, sendGmail } from '../google/workspace';
import { draftReviewReply } from '../lib/ai';
import { getDb } from '../lib/db';
import { log } from '../lib/log';
import {
  computeProfileScore,
  projectedScore,
  type ProfileFacts,
  type ScoreItem,
} from '../lib/profile-score';
import { bareHost, phoneKey, readWebsiteFacts, type WebsiteFacts } from '../lib/website-facts';
import { createAiSuggestions, generatePostDrafts, loadLiveProfile } from './gbp-edit';
import { saveSnapshot, syncGbp } from './integrations';
import { nameSimilarity } from '../lib/auto-detect';

type Client = typeof clients.$inferSelect;
export type ScanTrigger = 'setup' | 'manual' | 'cron' | 'after_publish';

export const SCAN_STEPS = [
  'Reading your Google Business Profile',
  'Checking your website',
  'Reading reviews',
  'Comparing with competitors',
  'Calculating your score',
  'AI is preparing improvements',
] as const;

export type ScanProgress = {
  step: number; // 0-based index into SCAN_STEPS
  total: number;
  label: string;
  startedAt: number;
  done: boolean;
  error: string | null;
};

const progressKey = (clientId: string) => `scan:${clientId}`;

export async function getScanProgress(env: Env, clientId: string): Promise<ScanProgress | null> {
  const raw = await env.KV.get(progressKey(clientId));
  return raw ? (JSON.parse(raw) as ScanProgress) : null;
}

async function setProgress(env: Env, clientId: string, p: ScanProgress) {
  await env.KV.put(progressKey(clientId), JSON.stringify(p), { expirationTtl: 3600 });
}

/** Map from an AI/app fix to the score items it completes. */
const FIX_ITEMS: Record<string, string[]> = {
  description: ['description_present', 'description_quality'],
  services: ['services'],
  categories: ['extra_categories'],
  attributes: ['attributes'],
  hours: ['hours'],
  website: ['website'],
  posts: ['posts'],
  replies: ['replies'],
};

/** Every fix waiting for a click: profile changes, post drafts and review reply drafts. */
export async function listReadyFixes(env: Env, agencyId: string, clientId: string) {
  const db = getDb(env);
  const [changes, posts, reviewDrafts] = await Promise.all([
    db
      .select()
      .from(gbpChanges)
      .where(
        and(
          eq(gbpChanges.agencyId, agencyId),
          eq(gbpChanges.clientId, clientId),
          inArray(gbpChanges.status, ['draft', 'failed']),
        ),
      )
      .orderBy(desc(gbpChanges.createdAt)),
    db
      .select()
      .from(gbpPosts)
      .where(
        and(
          eq(gbpPosts.agencyId, agencyId),
          eq(gbpPosts.clientId, clientId),
          inArray(gbpPosts.status, ['draft', 'failed']),
        ),
      )
      .orderBy(gbpPosts.createdAt),
    db
      .select()
      .from(reviews)
      .where(
        and(
          eq(reviews.agencyId, agencyId),
          eq(reviews.clientId, clientId),
          isNull(reviews.replyComment),
          isNotNull(reviews.aiDraftReply),
        ),
      )
      .orderBy(desc(reviews.reviewCreatedAt))
      .limit(10),
  ]);
  return { changes, posts, reviews: reviewDrafts };
}

function fixedItemIds(fixes: Awaited<ReturnType<typeof listReadyFixes>>): Set<string> {
  const ids = new Set<string>();
  for (const c of fixes.changes) for (const i of FIX_ITEMS[c.kind] ?? []) ids.add(i);
  if (fixes.posts.length) ids.add('posts');
  if (fixes.reviews.length) ids.add('replies');
  return ids;
}

/** Google position of the business name, from the latest health check and tracked keywords. */
async function brandPosition(env: Env, agencyId: string, client: Client, names: (string | null)[]) {
  const db = getDb(env);
  const check = await db.query.healthChecks.findFirst({
    where: and(eq(healthChecks.agencyId, agencyId), eq(healthChecks.clientId, client.id)),
    orderBy: desc(healthChecks.runAt),
    columns: { gscJson: true },
  });
  if (!check?.gscJson) return null;
  try {
    const gsc = JSON.parse(check.gscJson) as GscSummary;
    const hit = gsc.topQueries.find((q) =>
      names.some((n) => n && nameSimilarity(q.query, n) >= 0.99),
    );
    return hit ? hit.position : null;
  } catch {
    return null;
  }
}

const CITY_RE =
  /(ahmedabad|mumbai|delhi|pune|bangalore|bengaluru|hyderabad|chennai|kolkata|surat|vadodara|rajkot|jaipur|lucknow|indore|nagpur|noida|gurgaon|gurugram|thane|bhopal|chandigarh|kochi|coimbatore|nashik)/i;

/**
 * Runs a scan. Never throws: failures are saved on the scan row and in the progress record.
 * `generateFixes` = false for the quick re-score after publishing.
 */
export async function runProfileScan(
  env: Env,
  agencyId: string,
  clientId: string,
  opts: { trigger: ScanTrigger; generateFixes?: boolean; userId?: string | null; now?: number } = {
    trigger: 'manual',
  },
): Promise<{ scanId: string; score: number | null; status: 'ok' | 'partial' | 'failed' }> {
  const now = opts.now ?? Date.now();
  const db = getDb(env);
  const progress: ScanProgress = {
    step: 0,
    total: SCAN_STEPS.length,
    label: SCAN_STEPS[0],
    startedAt: now,
    done: false,
    error: null,
  };
  const step = async (i: number) => {
    progress.step = i;
    progress.label = SCAN_STEPS[i]!;
    await setProgress(env, clientId, progress);
  };
  const scanId = crypto.randomUUID();
  const warnings: string[] = [];

  try {
    const client = await db.query.clients.findFirst({
      where: and(eq(clients.id, clientId), eq(clients.agencyId, agencyId)),
    });
    if (!client) throw new Error('Client not found');
    if (!client.gbpLocationName || !client.gbpAccountName) {
      throw new Error('Connect Google Business Profile and pick the location first.');
    }
    const conn = await getConnection(env, agencyId, 'client_business', client.id);
    if (!conn) throw new Error('Connect Google Business Profile first.');

    // 1) Business Profile
    await step(0);
    const { raw, profile } = await loadLiveProfile(env, agencyId, client);
    const [photos, lastPost] = await withAccessToken(env, conn, (t) =>
      Promise.all([
        countMedia(t, client.gbpAccountName!, client.gbpLocationName!),
        latestPostTime(t, client.gbpAccountName!, client.gbpLocationName!),
      ]),
    );

    // 2) Website
    await step(1);
    const site: WebsiteFacts = await readWebsiteFacts(client.websiteUrl);
    if (site.error) warnings.push(`Website: ${site.error}`);

    // 3) Reviews (refresh from Google first so counts and drafts are current)
    await step(2);
    let summary: GbpSummary | null = null;
    try {
      summary = await syncGbp(env, client);
      if (summary) await saveSnapshot(env, client, 'gbp', { data: summary });
    } catch (err) {
      warnings.push(`Reviews: ${(err as Error).message.slice(0, 150)}`);
    }
    const recent = await db
      .select({
        star: reviews.starRating,
        reply: reviews.replyComment,
        at: reviews.reviewCreatedAt,
      })
      .from(reviews)
      .where(and(eq(reviews.agencyId, agencyId), eq(reviews.clientId, client.id)))
      .orderBy(desc(reviews.reviewCreatedAt))
      .limit(50);
    const stars = recent.map((r) => r.star).filter((s): s is number => s !== null);
    const reviewCount = summary?.reviews.totalReviewCount ?? (recent.length || null);
    const averageRating =
      summary?.reviews.averageRating ??
      (stars.length ? stars.reduce((a, b) => a + b, 0) / stars.length : null);

    // 4) Competitors (live from Places, never stored)
    await step(3);
    let competitorAvgReviews: number | null = null;
    if (env.PLACES_API_KEY) {
      const comps = await db
        .select()
        .from(competitors)
        .where(
          and(
            eq(competitors.agencyId, agencyId),
            eq(competitors.clientId, client.id),
            eq(competitors.isClient, false),
          ),
        )
        .limit(5);
      const got = await Promise.allSettled(
        comps.map((c) => getPlace(env.PLACES_API_KEY!, c.placeId)),
      );
      const counts = got.flatMap((g) =>
        g.status === 'fulfilled' && g.value.userRatingCount !== null
          ? [g.value.userRatingCount]
          : [],
      );
      if (counts.length) competitorAvgReviews = counts.reduce((a, b) => a + b, 0) / counts.length;
    }

    // 5) Score
    await step(4);
    const names = [client.name, site.siteName, raw.title ?? null];
    const listingPhone = raw.phoneNumbers?.primaryPhone ?? null;
    const facts: ProfileFacts = {
      verified: profile.verified,
      title: raw.title ?? null,
      primaryCategory: profile.primaryCategory?.displayName ?? null,
      additionalCategories: profile.additionalCategories.length,
      websiteUri: profile.websiteUri,
      websiteMatchesClient: profile.websiteUri
        ? bareHost(profile.websiteUri) === bareHost(client.websiteUrl)
        : null,
      phone: listingPhone,
      phoneMatchesWebsite:
        listingPhone && site.phones.length
          ? site.phones.includes(phoneKey(listingPhone) ?? '')
          : null,
      hasAddress: Boolean(
        raw.storefrontAddress?.addressLines?.length || raw.storefrontAddress?.locality,
      ),
      hoursSet: profile.hours.length > 0,
      descriptionLength: profile.description.length,
      descriptionMentionsCity:
        CITY_RE.test(profile.description) ||
        Boolean(
          raw.storefrontAddress?.locality &&
          profile.description.toLowerCase().includes(raw.storefrontAddress.locality.toLowerCase()),
        ),
      services: profile.services.length,
      attributesSet: profile.attributes.filter((a) => a.value).length,
      lastPostAt: lastPost,
      photoCount: photos,
      reviewCount,
      averageRating,
      replyRate: recent.length ? recent.filter((r) => r.reply).length / recent.length : null,
      recentReviews30: recent.filter((r) => (r.at ?? 0) >= now - 30 * 86_400_000).length,
      competitorAvgReviews,
      mapOnWebsite: site.error ? null : site.hasMapEmbed,
      brandPosition: await brandPosition(env, agencyId, client, names),
      now,
    };
    const { score, items } = computeProfileScore(facts);

    // 6) Fixes
    if (opts.generateFixes !== false) {
      await step(5);
      await prepareFixes(env, agencyId, client, {
        profile,
        site,
        facts,
        items,
        userId: opts.userId ?? null,
        warnings,
      });
    }
    const fixes = await listReadyFixes(env, agencyId, client.id);
    const projected = projectedScore(score, items, fixedItemIds(fixes));
    const status = warnings.length ? 'partial' : 'ok';
    await db.insert(profileScans).values({
      id: scanId,
      agencyId,
      clientId: client.id,
      runAt: now,
      trigger: opts.trigger,
      status,
      score,
      projectedScore: projected,
      itemsJson: JSON.stringify(items),
      factsJson: JSON.stringify({
        ...facts,
        website: {
          host: site.host,
          phones: site.phones,
          hours: site.hours.length,
          services: site.services,
        },
      }),
      error: warnings.length ? warnings.join(' | ').slice(0, 1000) : null,
    });
    progress.done = true;
    progress.step = SCAN_STEPS.length - 1;
    await setProgress(env, clientId, progress);

    const ready = fixes.changes.length + fixes.posts.length + fixes.reviews.length;
    if (opts.trigger === 'cron' && ready > 0) {
      await emailFixesReady(env, agencyId, client, { score, projected, ready }).catch((err) =>
        log.warn('Fixes-ready email failed', err, { clientId }),
      );
    }
    return { scanId, score, status };
  } catch (err) {
    const message = (err as Error).message.slice(0, 500);
    log.warn('Profile scan failed', err, { clientId });
    progress.done = true;
    progress.error = message;
    await setProgress(env, clientId, progress);
    await db.insert(profileScans).values({
      id: scanId,
      agencyId,
      clientId,
      runAt: now,
      trigger: opts.trigger,
      status: 'failed',
      error: message,
    });
    return { scanId, score: null, status: 'failed' };
  }
}

async function prepareFixes(
  env: Env,
  agencyId: string,
  client: Client,
  ctx: {
    profile: Awaited<ReturnType<typeof loadLiveProfile>>['profile'];
    site: WebsiteFacts;
    facts: ProfileFacts;
    items: ScoreItem[];
    userId: string | null;
    warnings: string[];
  },
) {
  const db = getDb(env);
  const { profile, site, facts, userId, warnings } = ctx;
  const language = client.autoReplyLanguage ?? 'en';

  // a) AI profile suggestions (description, categories, services, attributes), using website facts.
  try {
    const kw = await db
      .select({ k: trackedKeywords.keyword })
      .from(trackedKeywords)
      .where(and(eq(trackedKeywords.agencyId, agencyId), eq(trackedKeywords.clientId, client.id)))
      .limit(10);
    const notes = [
      site.services.length
        ? `Services/courses offered (from the website): ${site.services.join(', ')}.`
        : '',
      site.siteName ? `Brand name on the website: ${site.siteName}.` : '',
      kw.length ? `Important searches: ${kw.map((x) => x.k).join(', ')}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
    await createAiSuggestions(env, agencyId, client, userId, { language, notes });
  } catch (err) {
    warnings.push(`AI suggestions: ${(err as Error).message.slice(0, 150)}`);
  }

  // b) Values copied from the client's own website (not AI): website link and opening hours.
  await db
    .delete(gbpChanges)
    .where(
      and(
        eq(gbpChanges.agencyId, agencyId),
        eq(gbpChanges.clientId, client.id),
        eq(gbpChanges.source, 'website'),
        eq(gbpChanges.status, 'draft'),
      ),
    );
  const base = {
    agencyId,
    clientId: client.id,
    locationName: client.gbpLocationName!,
    source: 'website' as const,
    status: 'draft' as const,
    createdByUserId: userId,
    createdAt: Date.now(),
  };
  const website =
    site.finalUrl ?? (client.websiteUrl.startsWith('https://') ? client.websiteUrl : null);
  if (!profile.websiteUri && website?.startsWith('https://')) {
    await db.insert(gbpChanges).values({
      ...base,
      id: crypto.randomUUID(),
      kind: 'website',
      reason: 'Your listing has no website. This is the client website.',
      beforeJson: JSON.stringify({ websiteUri: '' }),
      afterJson: JSON.stringify({ websiteUri: website }),
    });
  }
  if (!facts.hoursSet && site.hours.length) {
    await db.insert(gbpChanges).values({
      ...base,
      id: crypto.randomUUID(),
      kind: 'hours',
      reason: 'Opening hours found on your website. Please check they are correct.',
      beforeJson: JSON.stringify({ hours: [] }),
      afterJson: JSON.stringify({ hours: site.hours }),
    });
  }

  // c) Google Posts when nothing was posted in the last 7 days (and no drafts are waiting).
  const waiting = await db
    .select({ id: gbpPosts.id })
    .from(gbpPosts)
    .where(
      and(
        eq(gbpPosts.agencyId, agencyId),
        eq(gbpPosts.clientId, client.id),
        inArray(gbpPosts.status, ['draft', 'scheduled', 'failed']),
      ),
    )
    .limit(1);
  const stale =
    facts.lastPostAt !== null &&
    (facts.lastPostAt === 0 || facts.now - facts.lastPostAt > 7 * 86_400_000);
  if (stale && waiting.length === 0) {
    try {
      const topic = site.services[0] ?? facts.primaryCategory ?? client.name;
      await generatePostDrafts(env, agencyId, client, userId, {
        topic: `${topic}: a helpful tip and an update from ${client.name}`,
        language,
        notes: site.services.length
          ? `Services: ${site.services.slice(0, 8).join(', ')}`
          : undefined,
      });
    } catch (err) {
      warnings.push(`AI posts: ${(err as Error).message.slice(0, 150)}`);
    }
  }

  // d) Reply drafts for up to 5 unanswered reviews (posted only when the user clicks "Post").
  const unanswered = await db
    .select()
    .from(reviews)
    .where(
      and(
        eq(reviews.agencyId, agencyId),
        eq(reviews.clientId, client.id),
        isNull(reviews.replyComment),
        isNull(reviews.aiDraftReply),
      ),
    )
    .orderBy(desc(reviews.reviewCreatedAt))
    .limit(5);
  for (const r of unanswered) {
    const d = await draftReviewReply(env, {
      businessName: client.name,
      reviewerName: r.reviewerName,
      starRating: r.starRating,
      comment: r.comment,
      tone: 'friendly',
      language,
    });
    await db
      .update(reviews)
      .set({ aiDraftReply: d.reply, aiDraftAt: Date.now() })
      .where(and(eq(reviews.id, r.id), eq(reviews.agencyId, agencyId)));
  }
}

export async function latestScan(env: Env, agencyId: string, clientId: string) {
  const row = await getDb(env).query.profileScans.findFirst({
    where: and(eq(profileScans.agencyId, agencyId), eq(profileScans.clientId, clientId)),
    orderBy: desc(profileScans.runAt),
  });
  if (!row) return null;
  return {
    id: row.id,
    runAt: row.runAt,
    trigger: row.trigger,
    status: row.status,
    score: row.score,
    projectedScore: row.projectedScore,
    items: row.itemsJson ? (JSON.parse(row.itemsJson) as ScoreItem[]) : [],
    error: row.error,
  };
}

/** Score of the scan before the latest one (for the "before -> after" view). */
export async function previousScore(
  env: Env,
  agencyId: string,
  clientId: string,
): Promise<number | null> {
  const rows = await getDb(env)
    .select({ score: profileScans.score })
    .from(profileScans)
    .where(
      and(
        eq(profileScans.agencyId, agencyId),
        eq(profileScans.clientId, clientId),
        isNotNull(profileScans.score),
      ),
    )
    .orderBy(desc(profileScans.runAt))
    .limit(2);
  return rows[1]?.score ?? null;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

async function emailFixesReady(
  env: Env,
  agencyId: string,
  client: Client,
  info: { score: number; projected: number; ready: number },
) {
  const conn = await getConnection(env, agencyId, 'agency_workspace');
  if (!conn) return;
  const owners = await getDb(env)
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.agencyId, agencyId), eq(users.role, 'owner')));
  const to = [...new Set(owners.map((o) => o.email))].join(', ');
  if (!to) return;
  const link = `${env.APP_URL}/clients/${client.id}?tab=growth`;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#0f172a">
    <h2 style="margin:0 0 8px">${esc(client.name)}: ${info.ready} improvement(s) ready</h2>
    <p>Business Profile score: <b>${info.score}</b> → <b>${info.projected}</b> after posting them.</p>
    <p><a href="${esc(link)}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Review and post</a></p>
    <p style="color:#64748b;font-size:12px">Nothing is posted on Google until you click Post.</p>
  </body></html>`;
  const token = await getAccessToken(env, conn);
  await sendGmail(
    token,
    buildMimeMessage({
      to,
      subject: `${client.name}: ${info.ready} Google profile improvement(s) ready`,
      html,
    }),
  );
}
