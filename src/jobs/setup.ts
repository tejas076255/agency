// One-click setup: after a single Google sign-in, find the right Search Console property, GA4
// property, Business Profile location and YouTube channel for the client's website. Clear winners
// are saved automatically; close calls are returned as a short "which one is yours?" question.
import { and, eq } from 'drizzle-orm';
import { clients } from '../db/schema';
import type { Env } from '../env';
import { listGbpAccounts } from '../google/business';
import { listGa4Properties } from '../google/ga4';
import { listGscSites } from '../google/gsc';
import { googleRequest } from '../google/http';
import { getConnection, hasScope, SCOPE, withAccessToken } from '../google/tokens';
import { listMyChannels } from '../google/youtube';
import {
  pickGa4Property,
  pickGbpLocation,
  pickGscSite,
  pickYouTubeChannel,
  type Candidate,
  type Ga4Candidate,
  type GbpCandidate,
  type Pick,
} from '../lib/auto-detect';
import { getDb } from '../lib/db';
import { log } from '../lib/log';
import { readWebsiteFacts, type WebsiteFacts } from '../lib/website-facts';

type Client = typeof clients.$inferSelect;
type GbpValue = { accountName: string; locationName: string };

export type SourceState<T> = {
  connected: boolean;
  current: T | null;
  recommended: Candidate<T> | null;
  candidates: Candidate<T>[];
  /** Saved automatically during this detection. */
  autoApplied: boolean;
  /** The current choice is different from a clearly better match (e.g. a "www" property). */
  mismatch: boolean;
  needsChoice: boolean;
  error?: string;
};

export type DetectResult = {
  website: Omit<WebsiteFacts, 'services'> & { services: number };
  gsc: SourceState<string>;
  ga4: SourceState<string>;
  gbp: SourceState<GbpValue>;
  youtube: SourceState<string>;
  /** Every source is connected and chosen. */
  complete: boolean;
};

const BI = 'https://mybusinessbusinessinformation.googleapis.com/v1';

async function listGbpCandidates(token: string): Promise<GbpCandidate[]> {
  const accounts = await listGbpAccounts(token);
  const out: GbpCandidate[] = [];
  for (const a of accounts.slice(0, 10)) {
    const u = new URL(`${BI}/${a.name}/locations`);
    u.searchParams.set('readMask', 'name,title,websiteUri,phoneNumbers,storefrontAddress,metadata');
    u.searchParams.set('pageSize', '100');
    const r = await googleRequest<{
      locations?: {
        name: string;
        title?: string;
        websiteUri?: string;
        phoneNumbers?: { primaryPhone?: string };
        storefrontAddress?: { addressLines?: string[]; locality?: string };
        metadata?: { hasVoiceOfMerchant?: boolean };
      }[];
    }>(u.toString(), { accessToken: token, retries: 1 });
    for (const l of r.locations ?? []) {
      out.push({
        accountName: a.name,
        locationName: l.name,
        title: l.title ?? l.name,
        websiteUri: l.websiteUri ?? null,
        phone: l.phoneNumbers?.primaryPhone ?? null,
        address: [...(l.storefrontAddress?.addressLines ?? []), l.storefrontAddress?.locality]
          .filter(Boolean)
          .join(', '),
        verified: l.metadata?.hasVoiceOfMerchant ?? null,
      });
    }
  }
  return out;
}

async function listGa4Candidates(token: string): Promise<Ga4Candidate[]> {
  const props = (await listGa4Properties(token)).slice(0, 25);
  return Promise.all(
    props.map(async (p) => {
      try {
        const r = await googleRequest<{
          dataStreams?: { webStreamData?: { measurementId?: string; defaultUri?: string } }[];
        }>(
          `https://analyticsadmin.googleapis.com/v1beta/properties/${p.id}/dataStreams?pageSize=50`,
          {
            accessToken: token,
            retries: 1,
          },
        );
        return {
          propertyId: p.id,
          name: p.name,
          streams: (r.dataStreams ?? [])
            .filter((s) => s.webStreamData)
            .map((s) => ({
              measurementId: s.webStreamData?.measurementId ?? null,
              defaultUri: s.webStreamData?.defaultUri ?? null,
            })),
        };
      } catch {
        return { propertyId: p.id, name: p.name, streams: [] };
      }
    }),
  );
}

function state<T>(
  connected: boolean,
  current: T | null,
  pick: Pick<T> | null,
  same: (a: T, b: T) => boolean,
  error?: string,
): SourceState<T> {
  const rec = pick?.chosen ?? null;
  const mismatch = Boolean(current && rec && pick?.confident && !same(current, rec.value));
  return {
    connected,
    current,
    recommended: rec,
    candidates: pick?.candidates ?? [],
    autoApplied: false,
    mismatch,
    needsChoice: connected && !current && !(pick?.confident ?? false),
    ...(error ? { error } : {}),
  };
}

const sameStr = (a: string, b: string) => a === b;
const sameGbp = (a: GbpValue, b: GbpValue) => a.locationName === b.locationName;

/** Detects the best sources; saves clear winners for empty fields. Caches candidates for /choose. */
export async function detectSources(
  env: Env,
  agencyId: string,
  client: Client,
  fetchImpl: typeof fetch = fetch,
): Promise<DetectResult> {
  const site = await readWebsiteFacts(client.websiteUrl, fetchImpl);
  const names = [client.name, site.siteName];
  const [dataConn, bizConn, ytConn] = await Promise.all([
    getConnection(env, agencyId, 'client_data', client.id),
    getConnection(env, agencyId, 'client_business', client.id),
    getConnection(env, agencyId, 'client_youtube', client.id),
  ]);

  const run = async <T>(fn: () => Promise<T>): Promise<{ value: T | null; error?: string }> => {
    try {
      return { value: await fn() };
    } catch (err) {
      log.warn('Setup detection step failed', err, { clientId: client.id });
      return { value: null, error: (err as Error).message.slice(0, 200) };
    }
  };

  const [gscR, ga4R, gbpR, ytR] = await Promise.all([
    dataConn && hasScope(dataConn, SCOPE.gsc)
      ? run(() => withAccessToken(env, dataConn, (t) => listGscSites(t)))
      : Promise.resolve({ value: null, error: undefined }),
    dataConn && hasScope(dataConn, SCOPE.ga4)
      ? run(() => withAccessToken(env, dataConn, (t) => listGa4Candidates(t)))
      : Promise.resolve({ value: null, error: undefined }),
    bizConn
      ? run(() => withAccessToken(env, bizConn, (t) => listGbpCandidates(t)))
      : Promise.resolve({ value: null, error: undefined }),
    ytConn
      ? run(() => withAccessToken(env, ytConn, (t) => listMyChannels(t)))
      : Promise.resolve({ value: null, error: undefined }),
  ]);

  const gscPick = gscR.value ? pickGscSite(gscR.value, client.websiteUrl, site.finalUrl) : null;
  const ga4Pick = ga4R.value ? pickGa4Property(ga4R.value, site.host, site.measurementIds) : null;
  const gbpPick = gbpR.value
    ? pickGbpLocation(gbpR.value, { host: site.host, phones: site.phones, names })
    : null;
  const ytPick = ytR.value ? pickYouTubeChannel(ytR.value, names) : null;

  const curGbp =
    client.gbpAccountName && client.gbpLocationName
      ? { accountName: client.gbpAccountName, locationName: client.gbpLocationName }
      : null;
  const result: DetectResult = {
    website: { ...site, services: site.services.length },
    gsc: state(
      Boolean(dataConn && hasScope(dataConn, SCOPE.gsc)),
      client.gscSiteUrl,
      gscPick,
      sameStr,
      gscR.error,
    ),
    ga4: state(
      Boolean(dataConn && hasScope(dataConn, SCOPE.ga4)),
      client.ga4PropertyId,
      ga4Pick,
      sameStr,
      ga4R.error,
    ),
    gbp: state(Boolean(bizConn), curGbp, gbpPick, sameGbp, gbpR.error),
    youtube: state(Boolean(ytConn), client.youtubeChannelId, ytPick, sameStr, ytR.error),
    complete: false,
  };

  // Save clear winners for fields that are still empty (never silently override a user choice).
  const set: Partial<typeof clients.$inferInsert> = {};
  if (!client.gscSiteUrl && gscPick?.confident && gscPick.chosen) {
    set.gscSiteUrl = gscPick.chosen.value;
    result.gsc = {
      ...result.gsc,
      current: gscPick.chosen.value,
      autoApplied: true,
      needsChoice: false,
    };
  }
  if (!client.ga4PropertyId && ga4Pick?.confident && ga4Pick.chosen) {
    set.ga4PropertyId = ga4Pick.chosen.value;
    result.ga4 = {
      ...result.ga4,
      current: ga4Pick.chosen.value,
      autoApplied: true,
      needsChoice: false,
    };
  }
  if (!curGbp && gbpPick?.confident && gbpPick.chosen) {
    set.gbpAccountName = gbpPick.chosen.value.accountName;
    set.gbpLocationName = gbpPick.chosen.value.locationName;
    result.gbp = {
      ...result.gbp,
      current: gbpPick.chosen.value,
      autoApplied: true,
      needsChoice: false,
    };
  }
  if (!client.youtubeChannelId && ytPick?.confident && ytPick.chosen) {
    set.youtubeChannelId = ytPick.chosen.value;
    result.youtube = {
      ...result.youtube,
      current: ytPick.chosen.value,
      autoApplied: true,
      needsChoice: false,
    };
  }
  if (Object.keys(set).length) {
    await getDb(env)
      .update(clients)
      .set({ ...set, updatedAt: Date.now() })
      .where(and(eq(clients.id, client.id), eq(clients.agencyId, agencyId)));
  }
  result.complete = (['gsc', 'ga4', 'gbp'] as const).every(
    (k) => result[k].connected && result[k].current,
  );

  // Remember what this user may choose from (validated by chooseSources).
  await env.KV.put(
    `setup:${client.id}`,
    JSON.stringify({
      gsc: (gscR.value ?? []).map((s) => s.siteUrl),
      ga4: (ga4R.value ?? []).map((p) => p.propertyId),
      gbp: (gbpR.value ?? []).map((l) => ({
        accountName: l.accountName,
        locationName: l.locationName,
      })),
      youtube: (ytR.value ?? []).map((c) => c.id),
    }),
    { expirationTtl: 3600 },
  );
  return result;
}

export type Choice = {
  gscSiteUrl?: string;
  ga4PropertyId?: string;
  gbp?: GbpValue;
  youtubeChannelId?: string;
};

/** Saves the user's picks, but only values that detection listed for this client's accounts. */
export async function chooseSources(env: Env, agencyId: string, client: Client, choice: Choice) {
  const raw = await env.KV.get(`setup:${client.id}`);
  if (!raw) throw new Error('Please run detection again (it expired).');
  const allowed = JSON.parse(raw) as {
    gsc: string[];
    ga4: string[];
    gbp: GbpValue[];
    youtube: string[];
  };
  const set: Partial<typeof clients.$inferInsert> = {};
  if (choice.gscSiteUrl !== undefined) {
    if (!allowed.gsc.includes(choice.gscSiteUrl))
      throw new Error('That Search Console property is not available');
    set.gscSiteUrl = choice.gscSiteUrl;
  }
  if (choice.ga4PropertyId !== undefined) {
    if (!allowed.ga4.includes(choice.ga4PropertyId))
      throw new Error('That GA4 property is not available');
    set.ga4PropertyId = choice.ga4PropertyId;
  }
  if (choice.gbp) {
    const ok = allowed.gbp.find(
      (g) =>
        g.locationName === choice.gbp!.locationName && g.accountName === choice.gbp!.accountName,
    );
    if (!ok) throw new Error('That Business Profile location is not available');
    set.gbpAccountName = ok.accountName;
    set.gbpLocationName = ok.locationName;
  }
  if (choice.youtubeChannelId !== undefined) {
    if (!allowed.youtube.includes(choice.youtubeChannelId))
      throw new Error('That YouTube channel is not available');
    set.youtubeChannelId = choice.youtubeChannelId;
  }
  if (!Object.keys(set).length) return;
  await getDb(env)
    .update(clients)
    .set({ ...set, updatedAt: Date.now() })
    .where(and(eq(clients.id, client.id), eq(clients.agencyId, agencyId)));
}
