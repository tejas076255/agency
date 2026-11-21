// Job idempotency, redelivery, dead-letter handling and ISO weeks.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env, JobMessage } from '../src/env';
import { enqueueJobs, handleCron, handleQueueBatch, isoWeek } from '../src/jobs/queue';
import { createTestEnv } from './helpers';

let env: Env;
let sent: JobMessage[];
let dispose: () => Promise<void>;

beforeAll(async () => {
  const t = await createTestEnv();
  env = t.env;
  sent = t.sent;
  dispose = t.dispose;
  await env.DB.prepare(
    `INSERT INTO agencies (id,name,brand_color,plan,created_at) VALUES ('ag','Ag','#000000','free',0)`,
  ).run();
  for (const id of ['c1', 'c2']) {
    await env.DB.prepare(
      `INSERT INTO clients (id,agency_id,name,website_url,contact_email,status,auto_send_report,created_at,updated_at)
       VALUES (?,'ag',?,'https://x.com','c@x.com','active',0,0,0)`,
    )
      .bind(id, id)
      .run();
  }
}, 60_000);

afterAll(async () => {
  await dispose?.();
});

function fakeMessage(body: JobMessage, attempts = 1) {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

describe('isoWeek', () => {
  it('computes ISO weeks in IST (incl. year boundaries)', () => {
    expect(isoWeek(Date.UTC(2026, 10, 23, 1))).toBe('2026-W48'); // Mon 23 Nov 2026
    expect(isoWeek(Date.UTC(2027, 0, 1, 1))).toBe('2026-W53'); // Fri 1 Jan 2027 belongs to 2026-W53
    expect(isoWeek(Date.UTC(2026, 10, 22, 19))).toBe('2026-W48'); // Sun 19:00 UTC = Mon 00:30 IST
  });
});

describe('idempotent scheduling', () => {
  it('a duplicate dedupe key is skipped', async () => {
    const job = {
      agencyId: 'ag',
      clientId: 'c1',
      type: 'health_check' as const,
      trigger: 'cron' as const,
      dedupeKey: 'test:c1:k',
    };
    expect(await enqueueJobs(env, [job])).toHaveLength(1);
    expect(await enqueueJobs(env, [job])).toHaveLength(0);
    const n = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM job_runs WHERE dedupe_key='test:c1:k'`,
    ).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('running the weekly cron twice in the same week queues each client once', async () => {
    sent.length = 0;
    const monday = Date.UTC(2026, 10, 23, 1);
    await handleCron('30 0 * * 1', env, monday);
    await handleCron('30 0 * * 1', env, monday + 60_000);
    expect(sent.map((m) => m.clientId).sort()).toEqual(['c1', 'c2']);
    // Next week is a new key.
    await handleCron('30 0 * * 1', env, monday + 7 * 86_400_000);
    expect(sent).toHaveLength(4);
  });

  it('manual runs have no dedupe key (always allowed, guarded by hasPendingJob instead)', async () => {
    const a = await enqueueJobs(env, [
      { agencyId: 'ag', clientId: 'c2', type: 'health_check', trigger: 'manual' },
    ]);
    const b = await enqueueJobs(env, [
      { agencyId: 'ag', clientId: 'c2', type: 'health_check', trigger: 'manual' },
    ]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

describe('consumer safety', () => {
  it('skips a redelivered message whose job already finished', async () => {
    await env.DB.prepare(
      `INSERT INTO job_runs (id,agency_id,client_id,type,trigger,status,attempt,created_at) VALUES ('done-job','ag','c1','health_check','cron','success',1,0)`,
    ).run();
    const msg = fakeMessage({
      jobRunId: 'done-job',
      agencyId: 'ag',
      clientId: 'c1',
      type: 'health_check',
    });
    await handleQueueBatch(
      { queue: 'agency-jobs', messages: [msg] } as unknown as MessageBatch<JobMessage>,
      env,
    );
    expect(msg.ack).toHaveBeenCalled();
    const row = await env.DB.prepare(
      `SELECT status, started_at FROM job_runs WHERE id='done-job'`,
    ).first<{ status: string; started_at: number | null }>();
    expect(row).toEqual({ status: 'success', started_at: null }); // untouched, not re-run
  });

  it('dead-lettered messages are marked failed', async () => {
    await env.DB.prepare(
      `INSERT INTO job_runs (id,agency_id,client_id,type,trigger,status,attempt,created_at) VALUES ('dlq-job','ag','c1','health_check','cron','running',3,0)`,
    ).run();
    const msg = fakeMessage(
      { jobRunId: 'dlq-job', agencyId: 'ag', clientId: 'c1', type: 'health_check' },
      4,
    );
    await handleQueueBatch(
      { queue: 'agency-jobs-dlq', messages: [msg] } as unknown as MessageBatch<JobMessage>,
      env,
    );
    expect(msg.ack).toHaveBeenCalled();
    const row = await env.DB.prepare(
      `SELECT status, error FROM job_runs WHERE id='dlq-job'`,
    ).first<{ status: string; error: string }>();
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/dead-letter/);
  });
});
