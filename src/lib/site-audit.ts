// Measured on-page checks for a prospect's website (free audit / lead generation).
// Fetches only public http(s) URLs (no IPs, localhost or internal hosts), limits size and redirects.
import { fetchPageSpeedSummary } from '../google/pagespeed';
import type { SiteChecks } from './ai-tools';

const MAX_HTML_BYTES = 1_500_000;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 4;

/** Normalizes and validates a prospect URL. Throws a readable error for unsafe/invalid input. */
export function normalizeProspectUrl(raw: string): URL {
  let text = raw.trim();
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new Error('Enter a valid website address, e.g. example.com');
  }
  assertPublicHost(u);
  u.hash = '';
  return u;
}

function assertPublicHost(u: URL) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) websites');
  if (u.username || u.password) throw new Error('URLs with credentials are not allowed');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('Custom ports are not allowed');
  const host = u.hostname.toLowerCase();
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');
  if (
    isIp ||
    !host.includes('.') ||
    /(^|\.)(localhost|local|internal|intranet|lan|home|corp|test|invalid|example)$/.test(host)
  ) {
    throw new Error('Enter a public website domain (IP addresses and local hosts are not allowed)');
  }
}

/** Fetch with manual redirects (each hop re-validated), timeout and a size cap. */
export async function safeFetch(
  url: URL,
  fetchImpl: typeof fetch,
): Promise<{ res: Response; finalUrl: URL; body: string; ms: number }> {
  let current = url;
  const started = Date.now();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(current.toString(), {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'user-agent': 'AgencyAutopilotAudit/1.0 (+website audit)',
        accept: 'text/html,*/*',
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, current);
      assertPublicHost(current);
      continue;
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        chunks.push(value);
        if (size > MAX_HTML_BYTES) {
          await reader.cancel();
          break;
        }
      }
    }
    const bytes = new Uint8Array(Math.min(size, MAX_HTML_BYTES));
    let off = 0;
    for (const c of chunks) {
      const part = c.subarray(0, Math.max(0, bytes.length - off));
      bytes.set(part, off);
      off += part.length;
    }
    return {
      res,
      finalUrl: current,
      body: new TextDecoder().decode(bytes),
      ms: Date.now() - started,
    };
  }
  throw new Error('Too many redirects');
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

const attr = (tag: string, name: string) =>
  tag
    .match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
    ?.slice(2)
    .find((x) => x !== undefined) ?? null;

/** Pure (unit-tested): on-page facts from the HTML. */
export function analyzeHtml(html: string, pageUrl: URL) {
  const head = html.slice(0, 200_000);
  const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const metas = head.match(/<meta\b[^>]*>/gi) ?? [];
  const meta = (key: string) => {
    const tag = metas.find((m) => (attr(m, 'name') ?? attr(m, 'property'))?.toLowerCase() === key);
    return tag ? attr(tag, 'content') : null;
  };
  const links = head.match(/<link\b[^>]*>/gi) ?? [];
  const canonical = links.find((l) => attr(l, 'rel')?.toLowerCase() === 'canonical');
  const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)]
    .map((m) => decode(m[1]!.replace(/<[^>]+>/g, ' ')))
    .filter(Boolean);
  const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
  const missingAlt = imgs.filter((t) => !(attr(t, 'alt') ?? '').trim()).length;
  const schemaTypes = new Set<string>();
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const t of m[1]!.matchAll(/"@type"\s*:\s*"([^"]+)"/g)) schemaTypes.add(t[1]!);
  }
  if (/itemtype\s*=\s*["']https?:\/\/schema\.org\//i.test(html)) schemaTypes.add('microdata');
  const text = decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
  const anchors = [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi)].map((m) => m[1]!);
  const internal = anchors.filter((h) => {
    try {
      return new URL(h, pageUrl).hostname === pageUrl.hostname;
    } catch {
      return false;
    }
  }).length;
  return {
    title: title ? decode(title).slice(0, 300) || null : null,
    metaDescription: meta('description')?.slice(0, 500) ?? null,
    h1: h1.slice(0, 5).map((h) => h.slice(0, 200)),
    canonical: canonical ? attr(canonical, 'href') : null,
    viewport: Boolean(meta('viewport')),
    lang: html.match(/<html\b[^>]*\blang\s*=\s*["']?([\w-]+)/i)?.[1] ?? null,
    openGraph: Boolean(meta('og:title')),
    schemaTypes: [...schemaTypes].slice(0, 10),
    images: imgs.length,
    imagesMissingAlt: missingAlt,
    wordCount: text ? text.split(' ').length : 0,
    internalLinks: internal,
  };
}

/** robots.txt / sitemap.xml present? Sites that answer every path with their homepage say "no". */
async function exists(url: URL, fetchImpl: typeof fetch): Promise<boolean | null> {
  try {
    const { res, body } = await safeFetch(url, fetchImpl);
    if (!res.ok) return false;
    const start = body.slice(0, 2000);
    if (url.pathname.endsWith('.xml')) return /<(urlset|sitemapindex)\b/i.test(start);
    return !/<html\b/i.test(start);
  } catch {
    return null;
  }
}

export async function runSiteChecks(
  rawUrl: string,
  pageSpeedKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<SiteChecks> {
  const url = normalizeProspectUrl(rawUrl);
  const base: SiteChecks = {
    url: url.toString(),
    finalUrl: null,
    fetchError: null,
    https: url.protocol === 'https:',
    statusCode: null,
    responseMs: null,
    htmlKb: null,
    title: null,
    metaDescription: null,
    h1: [],
    canonical: null,
    viewport: false,
    lang: null,
    openGraph: false,
    schemaTypes: [],
    images: 0,
    imagesMissingAlt: 0,
    wordCount: 0,
    internalLinks: 0,
    robotsTxt: null,
    sitemap: null,
    mobileScore: null,
    desktopScore: null,
    mobileLcpMs: null,
    cwvPassed: null,
    speedFixes: [],
  };

  const page = (async () => {
    try {
      const r = await safeFetch(url, fetchImpl);
      base.finalUrl = r.finalUrl.toString();
      base.https = r.finalUrl.protocol === 'https:';
      base.statusCode = r.res.status;
      base.responseMs = r.ms;
      base.htmlKb = Math.round(new TextEncoder().encode(r.body).length / 1024);
      if (!r.res.ok) base.fetchError = `The website returned HTTP ${r.res.status}`;
      else Object.assign(base, analyzeHtml(r.body, r.finalUrl));
      const origin = new URL('/', r.finalUrl);
      [base.robotsTxt, base.sitemap] = await Promise.all([
        exists(new URL('/robots.txt', origin), fetchImpl),
        exists(new URL('/sitemap.xml', origin), fetchImpl),
      ]);
    } catch (err) {
      base.fetchError = `Could not load the website: ${(err as Error).message}`.slice(0, 300);
    }
  })();

  const speed = (async () => {
    if (!pageSpeedKey) return;
    try {
      const psi = await fetchPageSpeedSummary(pageSpeedKey, url.toString());
      base.mobileScore = psi.mobile?.score ?? null;
      base.desktopScore = psi.desktop?.score ?? null;
      base.mobileLcpMs = psi.mobile?.lab?.lcpMs ?? psi.mobile?.lcpMs ?? null;
      base.cwvPassed = psi.mobile?.field?.cwvPassed ?? null;
      base.speedFixes = (psi.mobile?.opportunities ?? []).slice(0, 5).map((o) => o.title);
    } catch {
      // Speed is optional for the audit; the on-page checks still work.
    }
  })();

  await Promise.all([page, speed]);
  return base;
}
