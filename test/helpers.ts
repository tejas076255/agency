import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import type { Env, JobMessage } from '../src/env';
import { bytesToBase64 } from '../src/lib/crypto';

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
    why: `Because the data shows reason ${p}.`,
    expected_impact: `+${p * 5}% clicks`,
  })),
};
