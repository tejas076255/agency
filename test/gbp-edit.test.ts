// Business Profile editing + Google Posts: pure mapping, validation, AI suggestion drafts,
// validate-then-apply, undo, owner-only writes, tenant isolation, scheduled publishing.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import {
  buildLocalPost,
  buildPatch,
  toEditableProfile,
  type RawEditableLocation,
} from '../src/google/business-edit';
import { retryConfig } from '../src/google/http';
import { saveConnection } from '../src/google/tokens';
import { parseAfter, postInputSchema } from '../src/jobs/gbp-edit';
import { CRON_GBP_POSTS, handleCron } from '../src/jobs/queue';
import { createSession } from '../src/lib/session';
import { createTestEnv } from './helpers';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const RAW: RawEditableLocation = {
  name: 'locations/11',
  title: 'Smile Dental',
  profile: { description: 'Dental clinic.' },
  categories: {
    primaryCategory: { name: 'categories/gcid:dentist', displayName: 'Dentist' },
    additionalCategories: [],
  },
  serviceItems: [
    { structuredServiceItem: { serviceTypeId: 'job_type_id:cleaning' } },
    {
      freeFormServiceItem: {
        category: 'categories/gcid:dentist',
        label: { displayName: 'Root canal', description: 'Painless RCT' },
      },
    },
  ],
  regularHours: {
    periods: [
      {
        openDay: 'MONDAY',
        openTime: { hours: 9 },
        closeDay: 'MONDAY',
        closeTime: { hours: 18, minutes: 30 },
      },
    ],
  },
  metadata: { hasVoiceOfMerchant: true, hasPendingEdits: false },
};

// ------------------------------------ pure ------------------------------------

describe('profile mapping and patches', () => {
  it('maps Google JSON to the editable profile', () => {
    const p = toEditableProfile(RAW, [{ name: 'attributes/has_wheelchair', value: true }]);
    expect(p.description).toBe('Dental clinic.');
    expect(p.primaryCategory).toEqual({ name: 'categories/gcid:dentist', displayName: 'Dentist' });
    expect(p.services.map((s) => s.label)).toEqual(['job_type_id:cleaning', 'Root canal']);
    expect(p.services[0]!.structured).toBe(true);
    expect(p.hours).toEqual([{ day: 'MONDAY', open: '09:00', close: '18:30' }]);
    expect(p.verified).toBe(true);
  });

  it('builds minimal PATCH bodies; keeps the primary category and structured services', () => {
    const p = toEditableProfile(RAW);
    expect(buildPatch('description', { ...p, description: 'New' }, RAW)).toEqual({
      body: { profile: { description: 'New' } },
      updateMask: 'profile.description',
    });
    const cats = buildPatch(
      'categories',
      {
        ...p,
        additionalCategories: [{ name: 'categories/gcid:cosmetic', displayName: 'Cosmetic' }],
      },
      RAW,
    );
    expect(cats.body).toEqual({
      categories: {
        primaryCategory: { name: 'categories/gcid:dentist' },
        additionalCategories: [{ name: 'categories/gcid:cosmetic' }],
      },
    });
    const services = buildPatch(
      'services',
      {
        ...p,
        services: [
          ...p.services,
          { label: 'Whitening', description: '', category: 'categories/gcid:dentist' },
        ],
      },
      RAW,
    );
    const items = (services.body.serviceItems as Record<string, unknown>[]).map((i) =>
      Object.keys(i),
    );
    expect(items).toEqual([
      ['structuredServiceItem'],
      ['freeFormServiceItem'],
      ['freeFormServiceItem'],
    ]);
    const hours = buildPatch(
      'hours',
      { ...p, hours: [{ day: 'TUESDAY', open: '10:00', close: '24:00' }] },
      RAW,
    );
    expect(hours.body).toEqual({
      regularHours: {
        periods: [
          {
            openDay: 'TUESDAY',
            openTime: { hours: 10 },
            closeDay: 'TUESDAY',
            closeTime: { hours: 24 },
          },
        ],
      },
    });
  });

  it('validates changes before they can reach Google', () => {
    expect(() =>
      parseAfter('description', { description: 'Visit www.smile.in or call 98765 43210' }),
    ).toThrow(/links or phone/);
    expect(() => parseAfter('description', { description: 'x'.repeat(751) })).toThrow();
    expect(() =>
      parseAfter('hours', { hours: [{ day: 'MONDAY', open: '18:00', close: '09:00' }] }),
    ).toThrow(/after opening/);
    expect(() =>
      parseAfter('attributes', { attributes: [{ name: 'locations/1/x', value: true }] }),
    ).toThrow();
    expect(parseAfter('description', { description: '  Good clinic.  ' })).toEqual({
      description: 'Good clinic.',
    });
  });

  it('builds post bodies and rejects posts Google would refuse', () => {
    expect(
      buildLocalPost({ summary: 'Hello there everyone', action: 'CALL', url: 'https://x.in' }),
    ).toEqual({
      languageCode: 'en',
      summary: 'Hello there everyone',
      topicType: 'STANDARD',
      callToAction: { actionType: 'CALL' },
    });
    const ok = (o: object) => postInputSchema.safeParse(o).success;
    expect(ok({ summary: 'A friendly Diwali greeting to all.', actionType: null })).toBe(true);
    expect(ok({ summary: 'Call us on 98765 43210 for offers today', actionType: null })).toBe(
      false,
    );
    expect(ok({ summary: 'Book your visit with us this week!', actionType: 'BOOK' })).toBe(false);
    expect(
      ok({
        summary: 'Book your visit with us this week!',
        actionType: 'BOOK',
        actionUrl: 'http://x.in',
      }),
    ).toBe(false);
  });
});

// --------------------------------- storage and routes ---------------------------------

let env: Env;
let dispose: () => Promise<void>;
const auth: Record<string, { cookie: string; csrf: string }> = {};

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
    ('ownerA','A','a@x.com','Owner A','owner','sa',0),
    ('memberA','A','m@x.com','Member A','member','sm',0),
    ('ownerB','B','b@x.com','Owner B','owner','sb',0)`);
  await run(`INSERT INTO clients (id,agency_id,name,website_url,contact_email,status,auto_send_report,gbp_account_name,gbp_location_name,assigned_user_id,created_at,updated_at) VALUES
    ('cA','A','Smile Dental','https://smile.in','c@a.com','active',0,'accounts/1','locations/11','memberA',0,0),
    ('cB','B','Client B','https://b.com','c@b.com','active',0,NULL,NULL,NULL,0,0)`);
  await saveConnection(env, {
    agencyId: 'A',
    clientId: 'cA',
    purpose: 'client_business',
    googleEmail: 'biz@gmail.com',
    scopes: 'openid',
    refreshToken: 'refresh-biz',
    userId: 'ownerA',
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

type Call = { method: string; url: string; body: unknown };

/** Fake Google Business Profile with a mutable listing. */
function fakeGoogle(opts: { pendingAfterPatch?: boolean; failPatch?: boolean } = {}) {
  const calls: Call[] = [];
  let location: RawEditableLocation = structuredClone(RAW);
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
    const BI = 'https://mybusinessbusinessinformation.googleapis.com/v1';
    if (url.startsWith(`${BI}/categories?`)) {
      return json({
        categories: [{ name: 'categories/gcid:cosmetic_dentist', displayName: 'Cosmetic dentist' }],
      });
    }
    if (url.startsWith(`${BI}/attributes?`)) {
      return json({
        attributeMetadata: [
          {
            parent: 'attributes/has_wheelchair_accessible_entrance',
            valueType: 'BOOL',
            displayName: 'Wheelchair-accessible entrance',
          },
        ],
      });
    }
    if (url.startsWith(`${BI}/locations/11/attributes`)) {
      if (method === 'PATCH') return json({});
      return json({ attributes: [] });
    }
    if (url.startsWith(`${BI}/locations/11`)) {
      if (method === 'PATCH') {
        if (opts.failPatch) {
          return json(
            {
              error: {
                code: 400,
                status: 'INVALID_ARGUMENT',
                message: 'Description contains a URL',
              },
            },
            400,
          );
        }
        if (!url.includes('validateOnly=true')) {
          location = { ...location, ...(body as object) };
          if (opts.pendingAfterPatch)
            location.metadata = { ...location.metadata, hasPendingEdits: true };
        }
        return json(location);
      }
      return json(location);
    }
    if (url.endsWith('/localPosts') && method === 'POST') {
      return json({
        name: 'accounts/1/locations/11/localPosts/p1',
        searchUrl: 'https://g.page/p1',
        state: 'LIVE',
      });
    }
    if (url.includes('/localPosts/') && method === 'DELETE') return json({});
    return json({}, 404);
  });
  return { calls, current: () => location };
}

describe('AI suggestions -> drafts', () => {
  it('creates reviewable drafts with real category IDs and only allowed attributes', async () => {
    fakeGoogle();
    env.AI = {
      run: async () => ({
        response: {
          description: {
            text: 'Smile Dental is a friendly family dental clinic offering check-ups, cleaning, root canal treatment, teeth whitening and braces for patients of all ages. Our gentle team uses modern equipment and explains every step clearly.',
            why: 'Current description is too short',
          },
          categories: [{ name: 'Cosmetic dentist', why: 'Offers whitening' }],
          services: [
            { label: 'Teeth whitening', description: 'Brighter smile in one visit.' },
            { label: 'Root canal', description: 'duplicate, must be skipped' },
          ],
          attributes: [
            { name: 'attributes/has_wheelchair_accessible_entrance', why: 'Ground floor' },
            { name: 'attributes/made_up', why: 'not in the list' },
          ],
          notes: ['Add photos of the clinic'],
        },
      }),
    } as unknown as Ai;
    const res = await req('memberA', '/api/clients/cA/gbp/suggestions', 'POST', { language: 'en' });
    expect(res.status).toBe(200);
    const r = (await res.json()) as {
      drafts: { kind: string; after: Record<string, unknown> }[];
      notes: string[];
    };
    const byKind = Object.fromEntries(r.drafts.map((d) => [d.kind, d.after]));
    expect(Object.keys(byKind).sort()).toEqual([
      'attributes',
      'categories',
      'description',
      'services',
    ]);
    expect(byKind.categories).toEqual({
      additionalCategories: [
        { name: 'categories/gcid:cosmetic_dentist', displayName: 'Cosmetic dentist' },
      ],
    });
    const services = (byKind.services as { services: { label: string; category: string }[] })
      .services;
    expect(services.map((s) => s.label)).toEqual([
      'job_type_id:cleaning',
      'Root canal',
      'Teeth whitening',
    ]);
    expect(services[2]!.category).toBe('categories/gcid:dentist');
    expect(byKind.attributes).toEqual({
      attributes: [{ name: 'attributes/has_wheelchair_accessible_entrance', value: true }],
    });
    expect(r.notes).toContain('Add photos of the clinic');
  });
});

async function draftId(kind: string) {
  return (await env.DB.prepare(
    `SELECT id FROM gbp_changes WHERE kind=? AND status='draft' ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(kind)
    .first<{ id: string }>())!.id;
}

describe('apply, undo and permissions', () => {
  it('only the owner can apply; other agencies get 404', async () => {
    fakeGoogle();
    const id = await draftId('description');
    expect(
      (await req('memberA', `/api/clients/cA/gbp/changes/${id}/apply`, 'POST', {})).status,
    ).toBe(403);
    expect(
      (await req('ownerB', `/api/clients/cA/gbp/changes/${id}/apply`, 'POST', {})).status,
    ).toBe(404);
    expect((await req('ownerB', '/api/clients/cA/gbp/editor')).status).toBe(404);
  });

  it('validates on Google first, then applies, saves "before" and can undo', async () => {
    const g = fakeGoogle();
    const id = await draftId('description');
    const res = await req('ownerA', `/api/clients/cA/gbp/changes/${id}/apply`, 'POST', {});
    expect(await res.json()).toEqual({ status: 'applied', error: null });
    const patches = g.calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[0]!.url).toContain('validateOnly=true');
    expect(patches[0]!.url).toContain('updateMask=profile.description');
    expect(patches[1]!.url).not.toContain('validateOnly');
    expect(g.current().profile?.description).toMatch(/^Smile Dental is a friendly/);
    const row = await env.DB.prepare(`SELECT before_json FROM gbp_changes WHERE id=?`)
      .bind(id)
      .first<{ before_json: string }>();
    expect(JSON.parse(row!.before_json)).toEqual({ description: 'Dental clinic.' });
    // Applying twice is refused.
    expect(
      (await req('ownerA', `/api/clients/cA/gbp/changes/${id}/apply`, 'POST', {})).status,
    ).toBe(409);

    const undo = await req('ownerA', `/api/clients/cA/gbp/changes/${id}/undo`, 'POST', {});
    expect(((await undo.json()) as { status: string }).status).toBe('applied');
    expect(g.current().profile?.description).toBe('Dental clinic.');
    const orig = await env.DB.prepare(`SELECT status FROM gbp_changes WHERE id=?`)
      .bind(id)
      .first<{ status: string }>();
    expect(orig?.status).toBe('reverted');
  });

  it('shows "Google is reviewing" and stores Google’s error when a change is rejected', async () => {
    fakeGoogle({ pendingAfterPatch: true });
    const cat = await draftId('categories');
    const r1 = await req('ownerA', `/api/clients/cA/gbp/changes/${cat}/apply`, 'POST', {});
    expect(((await r1.json()) as { status: string }).status).toBe('pending_google');

    fakeGoogle({ failPatch: true });
    const svc = await draftId('services');
    const r2 = (await (
      await req('ownerA', `/api/clients/cA/gbp/changes/${svc}/apply`, 'POST', {})
    ).json()) as {
      status: string;
      error: string;
    };
    expect(r2.status).toBe('failed');
    expect(r2.error).toMatch(/Description contains a URL/);
  });

  it('attributes use the attributes endpoint with an attribute mask', async () => {
    const g = fakeGoogle();
    const id = await draftId('attributes');
    await req('ownerA', `/api/clients/cA/gbp/changes/${id}/apply`, 'POST', {});
    const patch = g.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toContain(
      '/locations/11/attributes?attributeMask=attributes%2Fhas_wheelchair_accessible_entrance',
    );
    expect(patch.body).toEqual({
      name: 'locations/11/attributes',
      attributes: [{ name: 'attributes/has_wheelchair_accessible_entrance', values: [true] }],
    });
  });

  it('manual drafts are validated (no links in the description)', async () => {
    const bad = await req('memberA', '/api/clients/cA/gbp/changes', 'POST', {
      kind: 'description',
      after: { description: 'See https://smile.in' },
    });
    expect(bad.status).toBe(400);
    const ok = await req('memberA', '/api/clients/cA/gbp/changes', 'POST', {
      kind: 'hours',
      after: { hours: [{ day: 'MONDAY', open: '09:00', close: '18:00' }] },
    });
    expect(ok.status).toBe(201);
  });
});

describe('Google Posts', () => {
  it('AI drafts -> owner publishes once; a second publish is refused', async () => {
    const g = fakeGoogle();
    env.AI = {
      run: async () => ({
        response: {
          posts: [
            {
              text: 'Happy Diwali from Smile Dental! Wishing your family bright smiles and good health this festive season.',
              call_to_action: 'BOOK',
            },
            {
              text: 'Monsoon tip: rinse after meals and keep brushing twice a day to protect your teeth this season.',
              call_to_action: 'LEARN_MORE',
            },
          ],
        },
      }),
    } as unknown as Ai;
    const gen = await req('memberA', '/api/clients/cA/gbp/posts/generate', 'POST', {
      topic: 'Diwali',
    });
    expect(gen.status).toBe(201);
    const { posts } = (await gen.json()) as {
      posts: { id: string; actionType: string; actionUrl: string }[];
    };
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({ actionType: 'BOOK', actionUrl: 'https://smile.in' });

    expect(
      (await req('memberA', `/api/clients/cA/gbp/posts/${posts[0]!.id}/publish`, 'POST', {}))
        .status,
    ).toBe(403);
    const pub = await req(
      'ownerA',
      `/api/clients/cA/gbp/posts/${posts[0]!.id}/publish`,
      'POST',
      {},
    );
    expect(await pub.json()).toMatchObject({ status: 'published', searchUrl: 'https://g.page/p1' });
    const create = g.calls.find((c) => c.url.endsWith('/localPosts'))!;
    expect(create.url).toBe(
      'https://mybusiness.googleapis.com/v4/accounts/1/locations/11/localPosts',
    );
    expect(create.body).toMatchObject({
      callToAction: { actionType: 'BOOK', url: 'https://smile.in' },
    });
    expect(
      (await req('ownerA', `/api/clients/cA/gbp/posts/${posts[0]!.id}/publish`, 'POST', {})).status,
    ).toBe(409);

    // Delete from Google.
    await req('ownerA', `/api/clients/cA/gbp/posts/${posts[0]!.id}`, 'DELETE');
    expect(g.calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/localPosts/p1'))).toBe(
      true,
    );
  });

  it('scheduled posts are published by the hourly cron (and the cron does not start health checks)', async () => {
    const g = fakeGoogle();
    const p = (await env.DB.prepare(`SELECT id FROM gbp_posts WHERE status='draft' LIMIT 1`).first<{
      id: string;
    }>())!;
    const when = Date.now() + 3600_000;
    expect(
      (
        await req('ownerA', `/api/clients/cA/gbp/posts/${p.id}/schedule`, 'POST', {
          scheduledFor: when,
        })
      ).status,
    ).toBe(200);
    await handleCron(CRON_GBP_POSTS, env, when - 60_000); // not due yet
    expect(g.calls.filter((c) => c.url.endsWith('/localPosts'))).toHaveLength(0);
    await handleCron(CRON_GBP_POSTS, env, when + 60_000);
    expect(g.calls.filter((c) => c.url.endsWith('/localPosts'))).toHaveLength(1);
    const row = await env.DB.prepare(`SELECT status FROM gbp_posts WHERE id=?`)
      .bind(p.id)
      .first<{ status: string }>();
    expect(row?.status).toBe('published');
    const jobs = await env.DB.prepare(`SELECT count(*) AS n FROM job_runs`).first<{ n: number }>();
    expect(jobs?.n).toBe(0);
  });
});
