// Pure (unit-tested) matching rules that pick the right Search Console property, GA4 property,
// Business Profile location and YouTube channel for a client's website, so users do not have to
// choose from long lists (where wrong picks like "www" properties or another business happen).
import { bareHost, phoneKey } from './website-facts';

export type Candidate<T> = { value: T; label: string; score: number; reasons: string[] };
export type Pick<T> = {
  chosen: Candidate<T> | null;
  candidates: Candidate<T>[];
  /** Safe to apply without asking (clear winner). */
  confident: boolean;
};

function finish<T>(cands: Candidate<T>[], minScore: number, margin: number): Pick<T> {
  const sorted = [...cands].sort((a, b) => b.score - a.score);
  const top = sorted[0] ?? null;
  const second = sorted[1];
  const confident = Boolean(
    top && top.score >= minScore && (!second || top.score - second.score >= margin),
  );
  return { chosen: top && top.score > 0 ? top : null, candidates: sorted.slice(0, 10), confident };
}

const words = (s: string | null | undefined) =>
  new Set(
    (s ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]+/gu, ' ')
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 2 && !['the', 'and', 'pvt', 'ltd', 'private', 'limited', 'llp'].includes(w),
      ),
  );

/** 0..1 overlap of meaningful words ("Upmark Digital" vs "Upmark - Digital Marketing Institute"). */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.min(A.size, B.size);
}

/** Search Console: Domain property > exact https URL-prefix of the live host > other variants. */
export function pickGscSite(
  sites: { siteUrl: string }[],
  websiteUrl: string,
  finalUrl: string | null,
): Pick<string> {
  const host = bareHost(finalUrl ?? websiteUrl);
  let liveHost: string | null = null;
  try {
    liveHost = new URL(finalUrl ?? websiteUrl).hostname.toLowerCase();
  } catch {
    liveHost = null;
  }
  const cands = sites.map((s) => {
    const reasons: string[] = [];
    let score = 0;
    if (s.siteUrl.startsWith('sc-domain:')) {
      if (s.siteUrl.slice(10).toLowerCase() === host) {
        score = 100;
        reasons.push('Domain property covers every page (www and non-www)');
      }
    } else {
      try {
        const u = new URL(s.siteUrl);
        const h = u.hostname.toLowerCase();
        if (bareHost(h) === host) {
          if (h === liveHost && u.protocol === 'https:') {
            score = 90;
            reasons.push('Matches the address the website actually uses');
          } else {
            score = 40;
            reasons.push(
              h === liveHost
                ? 'Old http:// version'
                : `The site redirects ${h} to ${liveHost}, so this property misses most data`,
            );
          }
        }
      } catch {
        // ignore malformed
      }
    }
    return { value: s.siteUrl, label: s.siteUrl, score, reasons };
  });
  return finish(
    cands.filter((c) => c.score > 0),
    90,
    1,
  );
}

export type Ga4Candidate = {
  propertyId: string;
  name: string;
  streams: { measurementId: string | null; defaultUri: string | null }[];
};

/** GA4: the property whose web stream uses the website's measurement ID, else its URL. */
export function pickGa4Property(
  props: Ga4Candidate[],
  websiteHost: string | null,
  siteMeasurementIds: string[],
): Pick<string> {
  const cands = props.map((p) => {
    const reasons: string[] = [];
    let score = 0;
    if (p.streams.some((s) => s.measurementId && siteMeasurementIds.includes(s.measurementId))) {
      score = 100;
      reasons.push('Its tracking ID is installed on the website');
    } else if (websiteHost && p.streams.some((s) => bareHost(s.defaultUri) === websiteHost)) {
      score = 70;
      reasons.push('Its data stream is for this website');
      if (siteMeasurementIds.length) reasons.push('but the website uses a different tracking ID');
    } else if (websiteHost && p.name.toLowerCase().includes(websiteHost.split('.')[0]!)) {
      score = 25;
      reasons.push('Name looks similar');
    }
    return { value: p.propertyId, label: `${p.name} (${p.propertyId})`, score, reasons };
  });
  return finish(
    cands.filter((c) => c.score > 0),
    70,
    20,
  );
}

export type GbpCandidate = {
  accountName: string;
  locationName: string;
  title: string;
  websiteUri: string | null;
  phone: string | null;
  address: string;
  verified: boolean | null;
};

/** Business Profile: same website > same phone > similar name; verified listings win ties. */
export function pickGbpLocation(
  locs: GbpCandidate[],
  site: { host: string | null; phones: string[]; names: (string | null)[] },
): Pick<{ accountName: string; locationName: string }> {
  const cands = locs.map((l) => {
    const reasons: string[] = [];
    let score = 0;
    if (site.host && bareHost(l.websiteUri) === site.host) {
      score += 50;
      reasons.push('Same website');
    }
    const pk = phoneKey(l.phone);
    if (pk && site.phones.includes(pk)) {
      score += 30;
      reasons.push('Same phone number');
    }
    const sim = Math.max(...site.names.map((n) => nameSimilarity(l.title, n)), 0);
    if (sim >= 0.5) {
      score += Math.round(20 * sim);
      reasons.push('Similar name');
    }
    if (l.verified) {
      score += 10;
      reasons.push('Verified on Google');
    } else if (l.verified === false) {
      reasons.push('Not verified');
    }
    return {
      value: { accountName: l.accountName, locationName: l.locationName },
      label: `${l.title}${l.address ? `, ${l.address}` : ''}`,
      score,
      reasons,
    };
  });
  // Only a website/phone/name match counts as a real candidate (verified alone is not enough).
  return finish(
    cands.filter((c) => c.reasons.some((r) => r !== 'Verified on Google' && r !== 'Not verified')),
    50,
    20,
  );
}

/** YouTube: the only channel, or the one whose name matches the business. */
export function pickYouTubeChannel(
  channels: { id: string; title: string }[],
  names: (string | null)[],
): Pick<string> {
  const cands = channels.map((ch) => {
    const sim = Math.max(...names.map((n) => nameSimilarity(ch.title, n)), 0);
    return {
      value: ch.id,
      label: ch.title,
      score: channels.length === 1 ? 100 : Math.round(100 * sim),
      reasons:
        channels.length === 1
          ? ['Only channel on this Google account']
          : sim > 0
            ? ['Similar name']
            : [],
    };
  });
  return finish(cands, 50, 20);
}
