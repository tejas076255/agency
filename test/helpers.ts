import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import type { Env, JobMessage } from '../src/env';
import { bytesToBase64 } from '../src/lib/crypto';
import type { CompactSummary } from '../src/lib/insights';

export const TEST_KEY = bytesToBase64(new Uint8Array(32).fill(7));

/** Real (local, in-memory) D1 + KV via Miniflare, with all migrations applied. */
export async function createTestEnv(overrides: Partial<Env> = {}) {
  const proxy = await getPlatformProxy<{ DB: D1Database; KV: KVNamespace }>({
    configPath: 'test/wrangler.test.jsonc',
    persist: false,
  });
  const dir = 'migrations';
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(dir, file), 'utf8');
    for (const stmt of sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)) {
      await proxy.env.DB.prepare(stmt).run();
    }
  }
  const sent: JobMessage[] = [];
  const queue = {
    send: async (m: JobMessage) => void sent.push(m),
    sendBatch: async (ms: { body: JobMessage }[]) => void sent.push(...ms.map((m) => m.body)),
  } as unknown as Queue<JobMessage>;

  const env = {
    DB: proxy.env.DB,
    KV: proxy.env.KV,
    JOBS_QUEUE: queue,
    AI: { run: async () => ({ response: '{}' }) } as unknown as Ai,
    ASSETS: {} as Fetcher,
    APP_URL: 'http://localhost:5173',
    AI_MODEL: '@cf/test/model',
    AI_GATEWAY_ID: '',
    TURNSTILE_SITE_KEY: 'site',
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    PAGESPEED_API_KEY: 'psi-key',
    TURNSTILE_SECRET_KEY: 'ts',
    ...overrides,
  } satisfies Env;
  return { env, sent, dispose: () => proxy.dispose() };
}

/** Five valid action items the fake AI returns. */
export const validAiOutput = {
  summary: 'Clicks grew 12% month over month, but mobile speed is slowing growth on key pages.',
  summary_hinglish:
    'Is mahine clicks 12% badhe, lekin mobile speed slow hone se growth ruk rahi hai.',
  action_items: [1, 2, 3, 4, 5].map((p) => ({
    priority: p,
    title: `Action number ${p}`,
    description: `Do the concrete task number ${p} on the website.`,
    why: `Because the data shows reason ${p}.`,
    expected_impact: `Could add a few more clicks (item ${p})`,
    // Numbers below 10 are not checked by the grounding guard.
    supporting_metrics: [`Metric for item ${p}`],
  })),
};

/** A realistic compact summary (what the AI receives). */
export function sampleSummary(overrides: Partial<CompactSummary> = {}): CompactSummary {
  return {
    client: 'Acme Dental',
    website: 'https://acme.example',
    health_score: 62,
    period_days: 28,
    search_console: {
      clicks: 1240,
      clicks_prev: 1500,
      clicks_change_pct: -17.3,
      impressions: 48200,
      impressions_change_pct: 4.1,
      avg_position: 14.2,
      ctr_pct: 1.6,
      top_queries: [{ q: 'dentist pune', clicks: 210, pos: 4.1 }],
      top_pages: [{ page: 'https://acme.example/', clicks: 600 }],
      quick_wins: [{ q: 'teeth whitening pune', impressions: 3100, pos: 11.4 }],
      dropping_pages: [{ page: 'https://acme.example/braces', before: 320, now: 140 }],
    },
    analytics: {
      sessions: 5400,
      sessions_change_pct: -12.5,
      organic_sessions: 3100,
      organic_sessions_change_pct: -15,
      users: 4100,
      new_users: 3300,
      key_events: 0,
      key_events_change_pct: 0,
      engagement_rate_pct: 35.2,
      top_channels: [{ channel: 'Organic Search', sessions: 3100 }],
      top_landing_pages: [{ page: '/', sessions: 2100, keyEvents: 0 }],
    },
    speed: {
      mobile: {
        lighthouse_score: 38,
        lab_lcp_ms: 6200,
        lab_cls: 0.21,
        field_core_web_vitals_passed: false,
        field_inp_ms: 310,
        top_fixes: ['Reduce unused JavaScript'],
      },
      desktop: { lighthouse_score: 81 },
    },
    ...overrides,
  };
}
