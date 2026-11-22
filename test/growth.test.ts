// Grow flow: auto-detect (right Search Console / GA4 / Business location), website facts,
// Business Profile score, scan with ready fixes, one-click Post all, permissions and isolation.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { retryConfig } from '../src/google/http';
import { saveConnection, SCOPE } from '../src/google/tokens';
import { runProfileScan } from '../src/jobs/profile-scan';
import { scheduleSlot } from '../src/jobs/publish-fixes';
import { detectSources } from '../src/jobs/setup';
import {
  nameSimilarity,
  pickGa4Property,
  pickGbpLocation,
  pickGscSite,
  pickYouTubeChannel,
} from '../src/lib/auto-detect';
import { computeProfileScore, projectedScore, type ProfileFacts } from '../src/lib/profile-score';
import { createSession } from '../src/lib/session';
import { extractWebsiteFacts, parseHours, servicesFromSitemap } from '../src/lib/website-facts';
import { createTestEnv } from './helpers';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ------------------------------------ pure ------------------------------------

describe('auto-detect rules', () => {
  it('prefers the Domain property and flags a www property when the site redirects to non-www', () => {
    const both = pickGscSite(
      [
        { siteUrl: 'https://www.upmark.in/' },
        { siteUrl: 'sc-domain:upmark.in' },
        { siteUrl: 'https://other.com/' },
      ],
      'https://upmark.in/',
      'https://upmark.in/',
    );
    expect(both).toMatchObject({ confident: true, chosen: { value: 'sc-domain:upmark.in' } });
    expect(both.candidates).toHaveLength(2);
    const wwwOnly = pickGscSite(
      [{ siteUrl: 'https://www.upmark.in/' }],
      'https://upmark.in/',
      'https://upmark.in/',
    );
    expect(wwwOnly.confident).toBe(false);
    expect(wwwOnly.chosen?.reasons.join(' ')).toMatch(/redirects www\.upmark\.in to upmark\.in/);
  });

  it('picks the GA4 property whose tracking ID is on the website', () => {
    const r = pickGa4Property(
      [
        {
          propertyId: '1',
          name: 'Old site',
          streams: [{ measurementId: 'G-OLD1234', defaultUri: 'https://upmark.in' }],
        },
        {
          propertyId: '2',
          name: 'Upmark GA4',
          streams: [{ measurementId: 'G-NEW5678', defaultUri: 'https://upmark.in' }],
        },
      ],
      'upmark.in',
      ['G-NEW5678'],
    );
    expect(r).toMatchObject({ confident: true, chosen: { value: '2' } });
  });

  it('picks the business with the same website/phone, not another business at a similar address', () => {
    const r = pickGbpLocation(
      [
        {
          accountName: 'accounts/1',
          locationName: 'locations/10',
          title: 'Growify',
          websiteUri: null,
          phone: '096622 41631',
          address: 'Navarangpura',
          verified: true,
        },
        {
          accountName: 'accounts/1',
          locationName: 'locations/20',
          title: 'Upmark',
          websiteUri: 'https://upmark.in/',
          phone: '+91 83206 99679',
          address: 'Navrangpura',
          verified: true,
        },
      ],
      { host: 'upmark.in', phones: ['8320699679'], names: ['rikesh', 'Upmark'] },
    );
    expect(r.confident).toBe(true);
    expect(r.chosen?.value.locationName).toBe('locations/20');
    expect(r.chosen?.reasons).toEqual(
      expect.arrayContaining(['Same website', 'Same phone number']),
    );
    expect(r.candidates.map((c) => c.value.locationName)).toEqual(['locations/20']); // Growify is not a match
  });

  it('YouTube: the only channel is chosen; names are compared by words', () => {
    expect(pickYouTubeChannel([{ id: 'UC1', title: 'Anything' }], ['Upmark'])).toMatchObject({
      confident: true,
    });
    expect(nameSimilarity('Upmark - Digital Marketing Institute', 'Upmark')).toBe(1);
    expect(nameSimilarity('Growify', 'Upmark')).toBe(0);
  });
});

describe('website facts', () => {
  const html = `<html><head><title>Best Institute | Upmark</title>
    <script type="application/ld+json">{"@type":"LocalBusiness","telephone":"+91 83206 99679",
      "openingHoursSpecification":[{"dayOfWeek":["Monday","Tuesday"],"opens":"10:00","closes":"19:00"},
      {"dayOfWeek":"https://schema.org/Saturday","opens":"10:00:00","closes":"14:00:00"}]}</script>
    <script>gtag('config','G-ABC12345')</script><script src="https://www.googletagmanager.com/gtm.js?id=GTM-TK4CFL2"></script>
    </head><body><a href="tel:+918320699679">Call</a></body></html>`;
  it('reads phones, tracking IDs, hours and the brand name', () => {
    const f = extractWebsiteFacts(html, new URL('https://upmark.in/'));
    expect(f).toMatchObject({
      host: 'upmark.in',
      siteName: 'Upmark',
      phones: ['8320699679'],
      measurementIds: ['G-ABC12345'],
      gtmIds: ['GTM-TK4CFL2'],
      hasMapEmbed: false,
    });
    expect(f.hours).toEqual([
      { day: 'MONDAY', open: '10:00', close: '19:00' },
      { day: 'TUESDAY', open: '10:00', close: '19:00' },
      { day: 'SATURDAY', open: '10:00', close: '14:00' },
    ]);
    expect(parseHours([{ openingHours: 'Mo-Fr 09:00-18:00' }])).toHaveLength(5);
  });
  it('finds course/service pages in the sitemap but not blog posts', () => {
    const xml = [
      '/',
      '/ai-seo-course',
      '/google-ads-course',
      '/about-us',
      '/5-tips-to-improve-your-local-seo-a-complete-guide',
      'https://other.com/x-course',
    ]
      .map((p) => `<url><loc>${p.startsWith('http') ? p : `https://upmark.in${p}`}</loc></url>`)
      .join('');
    expect(servicesFromSitemap(xml, 'upmark.in')).toEqual(['AI SEO Course', 'Google Ads Course']);
  });
});

const fullFacts: ProfileFacts = {
  verified: true,
  title: 'Upmark',
  primaryCategory: 'Educational institution',
  additionalCategories: 2,
  websiteUri: 'https://upmark.in/',
  websiteMatchesClient: true,
  phone: '+91 83206 99679',
  phoneMatchesWebsite: true,
  hasAddress: true,
  hoursSet: true,
  descriptionLength: 700,
  descriptionMentionsCity: true,
  services: 8,
  attributesSet: 3,
  lastPostAt: Date.now() - 86_400_000,
  photoCount: 20,
  reviewCount: 120,
  averageRating: 4.8,
  replyRate: 1,
  recentReviews30: 5,
  competitorAvgReviews: 60,
  mapOnWebsite: true,
  brandPosition: 1,
  now: Date.now(),
};

describe('Business Profile score', () => {
  it('a complete listing scores 100 and the weights add up to 100', () => {
    const r = computeProfileScore(fullFacts);
    expect(r.score).toBe(100);
    expect(r.items.reduce((s, i) => s + i.max, 0)).toBe(100);
    expect(r.items.every((i) => i.status === 'ok')).toBe(true);
  });
  it('an empty listing scores low and says what is missing and who can fix it', () => {
    const r = computeProfileScore({
      ...fullFacts,
      verified: false,
      websiteUri: null,
      websiteMatchesClient: null,
      hoursSet: false,
      descriptionLength: 0,
      descriptionMentionsCity: false,
      services: 0,
      additionalCategories: 0,
      attributesSet: 0,
      lastPostAt: 0,
      photoCount: 0,
      reviewCount: 0,
      averageRating: null,
      replyRate: null,
      recentReviews30: 0,
      phoneMatchesWebsite: false,
      mapOnWebsite: false,
      brandPosition: 5.3,
    });
    expect(r.score).toBeLessThan(25);
    const byId = Object.fromEntries(r.items.map((i) => [i.id, i]));
    expect(byId.hours).toMatchObject({ status: 'missing', fix: 'app' });
    expect(byId.description_present).toMatchObject({ status: 'missing', fix: 'ai' });
    expect(byId.verified).toMatchObject({ status: 'missing', fix: 'google' });
    expect(byId.nap!.detail).toMatch(/Phone differs/);
    expect(projectedScore(r.score, r.items, new Set(['hours', 'description_present']))).toBe(
      r.score + 9,
    );
  });
  it('schedules spread-out posts at 10:00 IST', () => {
    const t = scheduleSlot(Date.parse('2026-11-22T12:00:00Z'), 3);
    expect(new Date(t).toISOString()).toBe('2026-11-25T04:30:00.000Z');
  });
});

// --------------------------------- integration ---------------------------------

let env: Env;
let dispose: () => Promise<void>;
const auth: Record<string, { cookie: string; csrf: string }> = {};
const REVIEW = 'accounts/1/locations/20/reviews/r1';

beforeAll(async () => {
  retryConfig.baseDelayMs = 1;
  const t = await createTestEnv();
  env = t.env;
  dispose = t.dispose;
  const run = (sql: string) => env.DB.prepare(sql).run();
  await run(
    `INSERT INTO agencies (id,name,brand_color,plan,created_at) VALUES ('A','A','#000000','pro',0),('B','B','#000000','free',0)`,
  );
  await run(`INSERT INTO users (id,agency_id,email,name,role,google_sub,created_at) VALUES
    ('ownerA','A','a@x.com','Owner A','owner','sa',0),('memberA','A','m@x.com','Member A','member','sm',0),
    ('ownerB','B','b@x.com','Owner B','owner','sb',0)`);
  await run(`INSERT INTO clients (id,agency_id,name,website_url,contact_email,status,auto_send_report,assigned_user_id,created_at,updated_at) VALUES
    ('cA','A','Upmark','https://upmark.in','c@a.com','active',0,'memberA',0,0),
    ('cB','B','Other','https://b.com','c@b.com','active',0,NULL,0,0)`);
  const base = {
    agencyId: 'A',
    clientId: 'cA',
    googleEmail: 'owner@upmark.in',
    refreshToken: 'rt',
    userId: 'ownerA',
  };
  await saveConnection(env, {
    ...base,
    purpose: 'client_data',
    scopes: `openid ${SCOPE.gsc} ${SCOPE.ga4}`,
  });
  await saveConnection(env, {
    ...base,
    purpose: 'client_business',
    scopes: `openid ${SCOPE.business}`,
  });
  await saveConnection(env, {
    ...base,
    purpose: 'client_youtube',
    scopes: `openid ${SCOPE.youtube} ${SCOPE.ytAnalytics}`,
  });
  for (const u of ['ownerA', 'memberA', 'ownerB']) {
    const s = await createSession(env.KV, u);
    auth[u] = { cookie: `sid=${s.id}`, csrf: s.data.csrfToken };
  }
}, 60_000);

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await dispose?.();
});

const req = (user: string, path: string, method = 'GET', body?: unknown) =>
  app.request(
    `http://localhost${path}`,
    {
      method,
      headers: {
        cookie: auth[user]!.cookie,
        'x-csrf-token': auth[user]!.csrf,
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
        'cf-connecting-ip': `ip-${user}-${Math.random()}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );

const SITE_HTML = `<html><head><title>Best Digital Marketing Institute | Upmark</title>
  <script type="application/ld+json">{"openingHoursSpecification":[{"dayOfWeek":["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],"opens":"10:00","closes":"19:00"}]}</script>
  <script src="https://www.googletagmanager.com/gtm.js?id=GTM-TK4CFL2"></script></head>
  <body><a href="tel:+918320699679">Call</a></body></html>`;

/** Fake web + Google with a mutable Business Profile listing. */
function fakeWorld(opts: { gscSites?: string[] } = {}) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  let listing: Record<string, unknown> = {
    name: 'locations/20',
    title: 'Upmark',
    phoneNumbers: { primaryPhone: '+91 83206 99679' },
    storefrontAddress: { addressLines: ['503 Ambience'], locality: 'Ahmedabad' },
    profile: { description: 'Institute.' },
    categories: {
      primaryCategory: {
        name: 'categories/gcid:educational_institution',
        displayName: 'Educational institution',
      },
    },
    metadata: { hasVoiceOfMerchant: true },
  };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = String(init?.body);
    }
    if (url.startsWith('https://oauth2.googleapis.com/token'))
      return json({ access_token: 'at', expires_in: 3600 });
    calls.push({ method, url, body });
    const html = (s: string, status = 200) =>
      new Response(s, { status, headers: { 'content-type': 'text/html' } });
    if (url === 'https://upmark.in/') return html(SITE_HTML);
    if (url.startsWith('https://www.googletagmanager.com/gtm.js'))
      return html('var x="G-NEW5678";');
    if (url === 'https://upmark.in/sitemap.xml') {
      return html(
        '<urlset><url><loc>https://upmark.in/ai-seo-course</loc></url><url><loc>https://upmark.in/google-ads-course</loc></url></urlset>',
      );
    }
    if (url.startsWith('https://www.googleapis.com/webmasters/v3/sites')) {
      return json({
        siteEntry: (opts.gscSites ?? ['https://www.upmark.in/', 'sc-domain:upmark.in']).map(
          (siteUrl) => ({ siteUrl, permissionLevel: 'siteOwner' }),
        ),
      });
    }
    if (url.startsWith('https://analyticsadmin.googleapis.com/v1beta/accountSummaries')) {
      return json({
        accountSummaries: [
          {
            displayName: 'Acc',
            propertySummaries: [
              { property: 'properties/1', displayName: 'Old' },
              { property: 'properties/2', displayName: 'Upmark GA4' },
            ],
          },
        ],
      });
    }
    if (url.includes('/properties/1/dataStreams'))
      return json({
        dataStreams: [
          { webStreamData: { measurementId: 'G-OLD1234', defaultUri: 'https://upmark.in' } },
        ],
      });
    if (url.includes('/properties/2/dataStreams'))
      return json({
        dataStreams: [
          { webStreamData: { measurementId: 'G-NEW5678', defaultUri: 'https://upmark.in' } },
        ],
      });
    if (url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts'))
      return json({ accounts: [{ name: 'accounts/1', accountName: 'Upmark' }] });
    const BI = 'https://mybusinessbusinessinformation.googleapis.com/v1';
    if (url.startsWith(`${BI}/accounts/1/locations`)) {
      return json({
        locations: [
          {
            name: 'locations/10',
            title: 'Growify',
            phoneNumbers: { primaryPhone: '096622 41631' },
            metadata: { hasVoiceOfMerchant: true },
          },
          {
            name: 'locations/20',
            title: 'Upmark',
            websiteUri: 'https://upmark.in/',
            phoneNumbers: { primaryPhone: '+91 83206 99679' },
            metadata: { hasVoiceOfMerchant: true },
          },
        ],
      });
    }
    if (url.startsWith(`${BI}/categories?`))
      return json({
        categories: [
          {
            name: 'categories/gcid:computer_training_school',
            displayName: 'Computer training school',
          },
        ],
      });
    if (url.startsWith(`${BI}/attributes?`)) return json({ attributeMetadata: [] });
    if (url.startsWith(`${BI}/locations/20/attributes`)) return json({ attributes: [] });
    if (url.startsWith(`${BI}/locations/20`)) {
      if (method === 'PATCH') {
        if (!url.includes('validateOnly=true')) listing = { ...listing, ...(body as object) };
        return json(listing);
      }
      return json(listing);
    }
    if (url.startsWith('https://businessprofileperformance.googleapis.com'))
      return json({ multiDailyMetricTimeSeries: [] });
    if (url.includes('/v4/accounts/1/locations/20/reviews') && method === 'GET') {
      return json({
        averageRating: 4.6,
        totalReviewCount: 12,
        reviews: [
          {
            name: REVIEW,
            reviewer: { displayName: 'Ravi' },
            starRating: 'FIVE',
            comment: 'Great course',
            createTime: new Date().toISOString(),
          },
        ],
      });
    }
    if (url.endsWith('/reviews/r1/reply') && method === 'PUT') return json({ comment: 'ok' });
    if (url.includes('/v4/accounts/1/locations/20/media')) return json({ totalMediaItemCount: 2 });
    if (url.includes('/v4/accounts/1/locations/20/localPosts') && method === 'GET')
      return json({ localPosts: [] });
    if (url.endsWith('/localPosts') && method === 'POST')
      return json({
        name: 'accounts/1/locations/20/localPosts/p1',
        searchUrl: 'https://g.page/p1',
      });
    if (url.startsWith('https://www.googleapis.com/youtube/v3/channels'))
      return json({
        items: [
          {
            id: 'UC1',
            snippet: { title: 'Upmark' },
            statistics: { subscriberCount: '10', videoCount: '3' },
          },
        ],
      });
    return json({}, 404);
  });
  return { calls, listing: () => listing };
}

/** One fake model that answers each AI tool by looking at its system prompt. */
function fakeAi() {
  env.AI = {
    run: async (_m: string, input: { messages: { content: string }[] }) => {
      const sys = input.messages[0]!.content;
      if (sys.includes('Google Business Profile (local SEO) expert')) {
        return {
          response: {
            description: {
              text: 'Upmark is an AI-powered digital marketing institute in Navrangpura, Ahmedabad. Learn SEO, Google Ads, social media and performance marketing with live projects, small batches and placement support from experienced trainers.',
              why: 'Current description is too short',
            },
            categories: [{ name: 'Computer training school', why: 'Teaches digital skills' }],
            services: [{ label: 'AI SEO Course', description: 'Learn SEO with AI tools.' }],
            attributes: [],
            notes: [],
          },
        };
      }
      if (sys.includes('replies from a business owner'))
        return { response: { reply: 'Thank you Ravi, we are glad you enjoyed the course!' } };
      if (sys.includes('Google Business Profile posts')) {
        return {
          response: {
            posts: [
              {
                text: 'New AI SEO batch starts next week at Upmark Ahmedabad. Learn to rank websites with modern AI tools and live projects.',
                call_to_action: 'LEARN_MORE',
              },
              {
                text: 'Tip: reply to every Google review. It builds trust and shows customers that your business cares about feedback.',
                call_to_action: 'LEARN_MORE',
              },
            ],
          },
        };
      }
      return { response: '{}' };
    },
  } as unknown as Ai;
}

describe('one-click setup', () => {
  it('auto-selects the right sources for an empty client', async () => {
    fakeWorld();
    const client = (await env.DB.prepare(`SELECT * FROM clients WHERE id='cA'`).first())!;
    const r = await detectSources(env, 'A', {
      ...(client as object),
      id: 'cA',
      agencyId: 'A',
      name: 'Upmark',
      websiteUrl: 'https://upmark.in',
      gscSiteUrl: null,
      ga4PropertyId: null,
      gbpAccountName: null,
      gbpLocationName: null,
      youtubeChannelId: null,
    } as Parameters<typeof detectSources>[2]);
    expect(r.gsc).toMatchObject({ current: 'sc-domain:upmark.in', autoApplied: true });
    expect(r.ga4).toMatchObject({ current: '2', autoApplied: true });
    expect(r.gbp.current).toEqual({ accountName: 'accounts/1', locationName: 'locations/20' });
    expect(r.youtube).toMatchObject({ current: 'UC1', autoApplied: true });
    expect(r.complete).toBe(true);
    const row = await env.DB.prepare(
      `SELECT gsc_site_url, ga4_property_id, gbp_location_name, youtube_channel_id FROM clients WHERE id='cA'`,
    ).first();
    expect(row).toEqual({
      gsc_site_url: 'sc-domain:upmark.in',
      ga4_property_id: '2',
      gbp_location_name: 'locations/20',
      youtube_channel_id: 'UC1',
    });
  });

  it('never overrides a user choice but flags a wrong one (www property, other business)', async () => {
    await env.DB.prepare(
      `UPDATE clients SET gsc_site_url='https://www.upmark.in/', gbp_account_name='accounts/1', gbp_location_name='locations/10' WHERE id='cA'`,
    ).run();
    fakeWorld();
    const res = await req('ownerA', '/api/clients/cA/setup/detect');
    const r = (await res.json()) as {
      gsc: { mismatch: boolean; current: string };
      gbp: { mismatch: boolean; recommended: { label: string } };
    };
    expect(r.gsc).toMatchObject({ mismatch: true, current: 'https://www.upmark.in/' });
    expect(r.gbp.mismatch).toBe(true);
    expect(r.gbp.recommended.label).toMatch(/^Upmark/);
    // One click "Switch to it" -> choose.
    expect(
      (
        await req('ownerA', '/api/clients/cA/setup/choose', 'POST', {
          gscSiteUrl: 'https://evil.com/',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req('ownerA', '/api/clients/cA/setup/choose', 'POST', {
          gscSiteUrl: 'sc-domain:upmark.in',
          gbp: { accountName: 'accounts/1', locationName: 'locations/20' },
        })
      ).status,
    ).toBe(200);
    expect((await req('ownerB', '/api/clients/cA/setup/detect')).status).toBe(404);
  });

  it('the setup sign-in asks for all products in one Google screen (not Ads)', async () => {
    const res = await req('ownerA', '/api/clients/cA/setup/connect', 'POST', {});
    const { url } = (await res.json()) as { url: string };
    const scope = new URL(url).searchParams.get('scope')!;
    for (const s of [SCOPE.gsc, SCOPE.ga4, SCOPE.business, SCOPE.youtube])
      expect(scope).toContain(s);
    expect(scope).not.toContain(SCOPE.ads);
  });
});

describe('scan, score and one-click post', () => {
  it('scans, scores and prepares fixes from AI and the website', async () => {
    fakeWorld();
    fakeAi();
    const r = await runProfileScan(env, 'A', 'cA', { trigger: 'setup', userId: 'ownerA' });
    expect(r.status).not.toBe('failed');
    expect(r.score).toBeGreaterThan(0);
    const res = await req('memberA', '/api/clients/cA/profile');
    const d = (await res.json()) as {
      scan: { score: number; projectedScore: number; items: { id: string; status: string }[] };
      fixes: {
        changes: { kind: string; source: string }[];
        posts: unknown[];
        reviews: { draft: string }[];
      };
      canPublish: boolean;
    };
    expect(d.canPublish).toBe(false); // member
    const kinds = d.fixes.changes.map((c) => `${c.kind}:${c.source}`).sort();
    expect(kinds).toEqual([
      'categories:ai',
      'description:ai',
      'hours:website',
      'services:ai',
      'website:website',
    ]);
    expect(d.fixes.posts).toHaveLength(2);
    expect(d.fixes.reviews[0]!.draft).toMatch(/Thank you Ravi/);
    expect(d.scan.projectedScore).toBeGreaterThan(d.scan.score);
    expect(d.scan.items.find((i) => i.id === 'hours')?.status).toBe('missing');
  });

  it('Post all: only the owner; applies changes, replies, publishes one post and schedules the rest', async () => {
    const world = fakeWorld();
    const d = (await (await req('ownerA', '/api/clients/cA/profile')).json()) as {
      scan: { score: number };
      fixes: { changes: { id: string }[]; posts: { id: string }[]; reviews: { id: string }[] };
    };
    const items = [
      ...d.fixes.changes.map((c) => ({ type: 'change', id: c.id })),
      ...d.fixes.reviews.map((r) => ({ type: 'review', id: r.id })),
      ...d.fixes.posts.map((p) => ({ type: 'post', id: p.id })),
    ];
    expect(
      (await req('memberA', '/api/clients/cA/profile/publish', 'POST', { items, all: true }))
        .status,
    ).toBe(403);
    expect(
      (await req('ownerB', '/api/clients/cA/profile/publish', 'POST', { items, all: true })).status,
    ).toBe(404);
    const res = await req('ownerA', '/api/clients/cA/profile/publish', 'POST', {
      items,
      all: true,
    });
    const r = (await res.json()) as {
      results: { type: string; status: string; error: string | null }[];
      before: number;
      after: number;
    };
    expect(r.results.filter((x) => x.status === 'failed')).toEqual([]);
    expect(r.results.filter((x) => x.type === 'post').map((x) => x.status)).toEqual([
      'published',
      'scheduled',
    ]);
    expect(r.results.find((x) => x.type === 'review')?.status).toBe('posted');
    expect(r.after).toBeGreaterThan(r.before);
    const l = world.listing();
    expect(l.websiteUri).toBe('https://upmark.in/');
    expect((l.regularHours as { periods: unknown[] }).periods).toHaveLength(6);
    expect((l.profile as { description: string }).description).toMatch(/^Upmark is an AI-powered/);
    const left = (await (await req('ownerA', '/api/clients/cA/profile')).json()) as {
      fixes: { changes: unknown[]; reviews: unknown[]; posts: unknown[] };
    };
    expect(left.fixes.changes.length + left.fixes.reviews.length + left.fixes.posts.length).toBe(0);
  });

  it('client list shows the profile score; other agencies cannot see the Grow data', async () => {
    const list = (await (await req('ownerA', '/api/clients')).json()) as {
      clients: { id: string; profileScore: number | null; fixesReady: number }[];
    };
    const a = list.clients.find((c) => c.id === 'cA')!;
    expect(a.profileScore).toBeGreaterThan(0);
    expect(a.fixesReady).toBe(0);
    expect((await req('ownerB', '/api/clients/cA/profile')).status).toBe(404);
    expect(
      (await req('ownerB', '/api/clients/cA/profile/dismiss', 'POST', { type: 'post', id: 'x' }))
        .status,
    ).toBe(404);
  });
});
