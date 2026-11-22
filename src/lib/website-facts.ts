// Facts read from the client's own public website, used to (1) auto-detect the right Google
// properties/locations and (2) prefill Business Profile fixes (hours, website, services) so the
// user does not have to type them. Pure parsers are unit-tested; fetching is SSRF-safe.
import type { Day } from '../google/business-edit';
import { normalizeProspectUrl, safeFetch } from './site-audit';

export type WebsiteFacts = {
  finalUrl: string | null;
  host: string | null;
  siteName: string | null;
  phones: string[]; // last 10 digits (Indian numbers)
  measurementIds: string[]; // GA4 "G-XXXX" (also read from the GTM container)
  gtmIds: string[];
  hours: { day: Day; open: string; close: string }[];
  hasMapEmbed: boolean;
  services: string[]; // from course/service pages in the sitemap
  error: string | null;
};

const DAY_MAP: Record<string, Day> = {
  monday: 'MONDAY',
  tuesday: 'TUESDAY',
  wednesday: 'WEDNESDAY',
  thursday: 'THURSDAY',
  friday: 'FRIDAY',
  saturday: 'SATURDAY',
  sunday: 'SUNDAY',
  mo: 'MONDAY',
  tu: 'TUESDAY',
  we: 'WEDNESDAY',
  th: 'THURSDAY',
  fr: 'FRIDAY',
  sa: 'SATURDAY',
  su: 'SUNDAY',
};

/** "www.example.in" and "example.in" are the same site. */
export function bareHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Last 10 digits, so +91 98250 12345, 098250 12345 and 9825012345 all match. */
export function phoneKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

const hhmm = (v: string) => {
  const m = v.match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : null;
};

/** Pure: opening hours from JSON-LD openingHoursSpecification / openingHours ("Mo-Sa 10:00-19:00"). */
export function parseHours(jsonLdBlocks: unknown[]): WebsiteFacts['hours'] {
  const out: WebsiteFacts['hours'] = [];
  const add = (day: Day, open: string | null, close: string | null) => {
    if (open && close && !out.some((h) => h.day === day && h.open === open))
      out.push({ day, open, close });
  };
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const o = node as Record<string, unknown>;
    const specs = o.openingHoursSpecification;
    for (const spec of Array.isArray(specs) ? specs : specs ? [specs] : []) {
      const s = spec as { dayOfWeek?: string | string[]; opens?: string; closes?: string };
      const days = Array.isArray(s.dayOfWeek) ? s.dayOfWeek : s.dayOfWeek ? [s.dayOfWeek] : [];
      for (const d of days) {
        const key = String(d).split('/').pop()!.toLowerCase();
        const day = DAY_MAP[key];
        if (day) add(day, hhmm(s.opens ?? ''), hhmm(s.closes ?? ''));
      }
    }
    const oh = o.openingHours;
    for (const line of Array.isArray(oh) ? oh : typeof oh === 'string' ? [oh] : []) {
      const m = String(line).match(
        /^([A-Za-z]{2})(?:-([A-Za-z]{2}))?\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/,
      );
      if (!m) continue;
      const order = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
      const from = order.indexOf(m[1]!.toLowerCase());
      const to = m[2] ? order.indexOf(m[2].toLowerCase()) : from;
      for (let i = from; i >= 0 && i <= to; i++) add(DAY_MAP[order[i]!]!, hhmm(m[3]!), hhmm(m[4]!));
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') visit(v);
  };
  jsonLdBlocks.forEach(visit);
  const order = Object.values(DAY_MAP).slice(0, 7);
  return out.sort((a, b) => order.indexOf(a.day) - order.indexOf(b.day));
}

/** Pure: facts from the homepage HTML. */
export function extractWebsiteFacts(html: string, pageUrl: URL) {
  const jsonLd: unknown[] = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      jsonLd.push(JSON.parse(m[1]!.trim()));
    } catch {
      // Ignore broken JSON-LD blocks.
    }
  }
  const phones = new Set<string>();
  for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) {
    const k = phoneKey(m[1]);
    if (k) phones.add(k);
  }
  for (const m of html.matchAll(/"telephone"\s*:\s*"([^"]+)"/gi)) {
    const k = phoneKey(m[1]);
    if (k) phones.add(k);
  }
  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)/i)?.[1];
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const fromTitle = title
    ?.split(/\s[|\-–—]\s/)
    .pop()
    ?.trim();
  return {
    host: bareHost(pageUrl.toString()),
    siteName: (og ?? fromTitle ?? null)?.slice(0, 120) ?? null,
    phones: [...phones].slice(0, 5),
    measurementIds: [...new Set(html.match(/\bG-[A-Z0-9]{6,12}\b/g) ?? [])].slice(0, 10),
    gtmIds: [...new Set(html.match(/\bGTM-[A-Z0-9]{4,10}\b/g) ?? [])].slice(0, 5),
    hours: parseHours(jsonLd),
    hasMapEmbed: /google\.[a-z.]+\/maps|maps\.google\./i.test(html),
  };
}

const SERVICE_WORDS =
  /(course|courses|service|services|training|class|classes|treatment|therapy|repair|consult|package|program|workshop|solution)/i;

/** Pure: service/course names from sitemap URLs like /ai-seo-course -> "Ai Seo Course". */
export function servicesFromSitemap(xml: string, host: string): string[] {
  const out = new Set<string>();
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    let u: URL;
    try {
      u = new URL(m[1]!);
    } catch {
      continue;
    }
    if (bareHost(u.toString()) !== host) continue;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length === 0 || parts.length > 2) continue;
    const slug = parts[parts.length - 1]!.replace(/\.(html?|php)$/, '');
    // Long slugs are blog posts ("5-tips-to-improve-..."), not services.
    if (!SERVICE_WORDS.test(slug) || slug.split('-').length > 5 || /^\d/.test(slug)) continue;
    out.add(
      slug
        .split('-')
        .map((w) =>
          w.length <= 3 && /^(ai|seo|ppc|smm|ui|ux|it|hr)$/i.test(w)
            ? w.toUpperCase()
            : w.charAt(0).toUpperCase() + w.slice(1),
        )
        .join(' '),
    );
  }
  return [...out].slice(0, 20);
}

/** Fetches the homepage, the GTM container (for GA4 IDs) and the sitemap. Never throws. */
export async function readWebsiteFacts(
  websiteUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<WebsiteFacts> {
  const empty: WebsiteFacts = {
    finalUrl: null,
    host: bareHost(websiteUrl),
    siteName: null,
    phones: [],
    measurementIds: [],
    gtmIds: [],
    hours: [],
    hasMapEmbed: false,
    services: [],
    error: null,
  };
  try {
    const url = normalizeProspectUrl(websiteUrl);
    const page = await safeFetch(url, fetchImpl);
    if (!page.res.ok) return { ...empty, error: `Website returned HTTP ${page.res.status}` };
    const facts = extractWebsiteFacts(page.body, page.finalUrl);
    const out: WebsiteFacts = { ...empty, ...facts, finalUrl: page.finalUrl.toString() };
    // GA4 is often only inside Google Tag Manager: read the public container script.
    for (const id of facts.gtmIds.slice(0, 2)) {
      try {
        const gtm = await safeFetch(
          new URL(`https://www.googletagmanager.com/gtm.js?id=${id}`),
          fetchImpl,
        );
        for (const g of gtm.body.match(/\bG-[A-Z0-9]{6,12}\b/g) ?? []) {
          if (!out.measurementIds.includes(g)) out.measurementIds.push(g);
        }
      } catch {
        // Optional.
      }
    }
    try {
      const sm = await safeFetch(new URL('/sitemap.xml', page.finalUrl), fetchImpl);
      if (sm.res.ok && out.host) out.services = servicesFromSitemap(sm.body, out.host);
    } catch {
      // Optional.
    }
    return out;
  } catch (err) {
    return { ...empty, error: (err as Error).message.slice(0, 200) };
  }
}
