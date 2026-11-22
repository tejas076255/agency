import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { publishDuePosts } from './gbp-edit';
import { runProfileScan } from './profile-scan';
import { clients, jobRuns } from '../db/schema';
import type { Env, JobMessage } from '../env';
import { describeError, GoogleApiError, ReconnectNeededError } from '../google/http';
import { istDate, istMonth, previousIstMonth } from '../lib/dates';
import { getDb } from '../lib/db';
import { log } from '../lib/log';
import { withUsageTracking } from '../lib/usage';
import { runHealthCheck } from './health-check';
import { generateReport } from './report';

export const CRON_WEEKLY_HEALTH = '30 0 * * 1'; // Monday 06:00 IST
export const CRON_MONTHLY_REPORT = '30 0 1 * *'; // 1st of month 06:00 IST
export const CRON_GBP_POSTS = '15 * * * *'; // hourly: publish scheduled Google posts
export const DLQ_NAME = 'agency-jobs-dlq';
const MAX_ATTEMPTS = 3;
const STALE_RUNNING_MS = 20 * 60 * 1000;

type JobType = JobMessage['type'];

/** ISO-8601 week of an IST date, e.g. "2026-W47" (used in weekly dedupe keys). */
export function isoWeek(ms: number): string {
  const d = new Date(`${istDate(ms)}T00:00:00Z`);
  const day = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // Thursday of this week decides the year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export type JobRequest = {
  agencyId: string;
  clientId: string;
  type: JobType;
  trigger: 'cron' | 'manual' | 'setup';
  /** profile_scan: user who started it (drafts are attributed to them). */
  userId?: string;
  month?: string;
  send?: boolean;
  /** Scheduled jobs pass one; a duplicate key is silently skipped (idempotent cron). */
  dedupeKey?: string;
};

/** Creates job_run rows and enqueues one message per client. Returns ids of jobs actually queued. */
export async function enqueueJobs(env: Env, jobs: JobRequest[]): Promise<string[]> {
  if (jobs.length === 0) return [];
  const db = getDb(env);
  const now = Date.now();
  const rows = jobs.map((j) => ({
    id: crypto.randomUUID(),
    agencyId: j.agencyId,
    clientId: j.clientId,
    type: j.type,
    trigger: j.trigger === 'setup' ? ('manual' as const) : j.trigger,
    status: 'queued' as const,
    attempt: 0,
    dedupeKey: j.dedupeKey ?? null,
    createdAt: now,
  }));

  // D1 limits bound parameters per statement, so insert in small chunks.
  const inserted = new Set<string>();
  for (let i = 0; i < rows.length; i += 8) {
    const res = await db
      .insert(jobRuns)
      .values(rows.slice(i, i + 8))
      .onConflictDoNothing({ target: jobRuns.dedupeKey })
      .returning({ id: jobRuns.id });
    for (const r of res) inserted.add(r.id);
  }

  const messages = rows
    .map((r, i) => ({ r, j: jobs[i]! }))
    .filter(({ r }) => inserted.has(r.id))
    .map(({ r, j }) => ({
      body: {
        jobRunId: r.id,
        agencyId: r.agencyId,
        clientId: r.clientId,
        type: r.type,
        month: j.month,
        send: j.send,
        trigger: j.trigger,
        userId: j.userId,
      } satisfies JobMessage,
    }));
  for (let i = 0; i < messages.length; i += 100) {
    await env.JOBS_QUEUE.sendBatch(messages.slice(i, i + 100));
  }
  return messages.map((m) => m.body.jobRunId);
}

/** Cron entry point: fan out one queue message per client. Safe to run twice (dedupe keys). */
export async function handleCron(cron: string, env: Env, now = Date.now()) {
  const db = getDb(env);
  if (cron === CRON_GBP_POSTS) {
    await publishDuePosts(env, now);
    return;
  }
  if (cron === CRON_MONTHLY_REPORT) {
    // Report on the month that just ended. Clients with auto-send get it emailed;
    // others get a ready-to-review report ("Preview & send manually").
    const list = await db
      .select({ id: clients.id, agencyId: clients.agencyId, autoSend: clients.autoSendReport })
      .from(clients)
      .where(eq(clients.status, 'active'));
    const month = previousIstMonth(now);
    const queued = await enqueueJobs(
      env,
      list.map((c) => ({
        agencyId: c.agencyId,
        clientId: c.id,
        type: 'monthly_report',
        trigger: 'cron',
        month,
        send: c.autoSend,
        dedupeKey: `monthly_report:${c.id}:${month}`,
      })),
    );
    log.info(`Monthly report cron: queued ${queued.length}/${list.length} clients for ${month}`);
    return;
  }
  // Weekly health check for every client (PageSpeed works even without a Google connection).
  const week = isoWeek(now);
  const list = await db
    .select({ id: clients.id, agencyId: clients.agencyId })
    .from(clients)
    .where(ne(clients.status, 'reconnect_needed'));
  const queued = await enqueueJobs(
    env,
    list.map((c) => ({
      agencyId: c.agencyId,
      clientId: c.id,
      type: 'health_check',
      trigger: 'cron',
      dedupeKey: `health_check:${c.id}:${week}`,
    })),
  );
  log.info(`Weekly health cron: queued ${queued.length}/${list.length} clients for ${week}`);
  // Weekly "Grow" autopilot: rescan Business Profiles and prepare new one-click fixes.
  const gbpClients = await db
    .select({ id: clients.id, agencyId: clients.agencyId })
    .from(clients)
    .where(isNotNull(clients.gbpLocationName));
  const scans = await enqueueJobs(
    env,
    gbpClients.map((c) => ({
      agencyId: c.agencyId,
      clientId: c.id,
      type: 'profile_scan' as const,
      trigger: 'cron' as const,
      dedupeKey: `profile_scan:${c.id}:${week}`,
    })),
  );
  log.info(`Weekly profile scans: queued ${scans.length}/${gbpClients.length}`);
}

function isTransient(err: unknown): boolean {
  if (err instanceof ReconnectNeededError) return false;
  if (err instanceof GoogleApiError) return err.transient;
  return false;
}

async function processMessage(env: Env, msg: Message<JobMessage>) {
  const db = getDb(env);
  const job = msg.body;
  const where = and(eq(jobRuns.id, job.jobRunId), eq(jobRuns.agencyId, job.agencyId));

  // Queues deliver at least once: skip messages whose job already finished (or no longer exists).
  const current = await db.query.jobRuns.findFirst({ where });
  if (!current || ['success', 'partial', 'failed'].includes(current.status)) {
    msg.ack();
    return;
  }

  await db
    .update(jobRuns)
    .set({ status: 'running', attempt: msg.attempts, startedAt: Date.now() })
    .where(where);

  try {
    if (job.type === 'profile_scan') {
      const r = await runProfileScan(env, job.agencyId, job.clientId, {
        trigger: job.trigger === 'cron' ? 'cron' : job.trigger === 'setup' ? 'setup' : 'manual',
        userId: job.userId ?? null,
      });
      await db
        .update(jobRuns)
        .set({
          status: r.status === 'ok' ? 'success' : r.status === 'partial' ? 'partial' : 'failed',
          error: r.status === 'failed' ? 'Profile scan failed (see the Grow tab)' : null,
          finishedAt: Date.now(),
        })
        .where(where);
    } else if (job.type === 'health_check') {
      const r = await runHealthCheck(env, job.agencyId, job.clientId);
      const errs = Object.entries(r.errors)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' | ');
      await db
        .update(jobRuns)
        .set({
          status: r.status === 'ok' ? 'success' : r.status === 'partial' ? 'partial' : 'failed',
          error: errs || null,
          finishedAt: Date.now(),
        })
        .where(where);
    } else {
      const client = await db.query.clients.findFirst({
        where: and(eq(clients.id, job.clientId), eq(clients.agencyId, job.agencyId)),
      });
      const send = job.send ?? client?.autoSendReport ?? false;
      const r = await generateReport(env, job.agencyId, job.clientId, {
        month: job.month ?? istMonth(Date.now()),
        send,
      });
      await db
        .update(jobRuns)
        .set({
          status: 'success',
          error: r.sent ? null : 'Report ready for review (not emailed)',
          finishedAt: Date.now(),
        })
        .where(where);
    }
    msg.ack();
  } catch (err) {
    log.error(`Job ${job.type} failed`, err, { clientId: job.clientId, jobRunId: job.jobRunId });
    const message = describeError(err).slice(0, 1000);
    // Monthly reports are not retried automatically (a partial retry could email twice).
    if (job.type === 'health_check' && isTransient(err) && msg.attempts < MAX_ATTEMPTS) {
      await db
        .update(jobRuns)
        .set({ status: 'queued', error: `Retrying: ${message}` })
        .where(where);
      msg.retry({ delaySeconds: 60 * 2 ** (msg.attempts - 1) }); // 1, 2, 4 min backoff
    } else {
      await db
        .update(jobRuns)
        .set({ status: 'failed', error: message, finishedAt: Date.now() })
        .where(where);
      msg.ack();
    }
  }
}

/** Messages that exhausted queue retries land in the DLQ: record them as failed. */
async function processDeadLetter(env: Env, msg: Message<JobMessage>) {
  const job = msg.body;
  await getDb(env)
    .update(jobRuns)
    .set({
      status: 'failed',
      error: 'Gave up after repeated crashes (moved to dead-letter queue)',
      finishedAt: Date.now(),
    })
    .where(
      and(
        eq(jobRuns.id, job.jobRunId),
        eq(jobRuns.agencyId, job.agencyId),
        inArray(jobRuns.status, ['queued', 'running']),
      ),
    );
  msg.ack();
}

/** Queue consumer: each message is handled on its own; one failure never affects the others. */
export async function handleQueueBatch(batch: MessageBatch<JobMessage>, env: Env) {
  for (const msg of batch.messages) {
    if (batch.queue === DLQ_NAME) {
      await processDeadLetter(env, msg);
      continue;
    }
    await withUsageTracking(env, msg.body.agencyId, () => processMessage(env, msg));
  }
}

/** True if a job of this type for this client is already waiting or running (prevents double clicks). */
export async function hasPendingJob(env: Env, agencyId: string, clientId: string, type: JobType) {
  const row = await getDb(env)
    .select({ id: jobRuns.id, createdAt: jobRuns.createdAt })
    .from(jobRuns)
    .where(
      and(
        eq(jobRuns.agencyId, agencyId),
        eq(jobRuns.clientId, clientId),
        eq(jobRuns.type, type),
        inArray(jobRuns.status, ['queued', 'running']),
      ),
    )
    .limit(1);
  // Ignore stale "running" rows (e.g. a crashed worker).
  return row.length > 0 && Date.now() - row[0]!.createdAt < STALE_RUNNING_MS;
}
