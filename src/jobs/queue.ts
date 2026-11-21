import { and, eq, inArray, ne } from 'drizzle-orm';
import { clients, jobRuns } from '../db/schema';
import type { Env, JobMessage } from '../env';
import { describeError, GoogleApiError, ReconnectNeededError } from '../google/http';
import { istMonth, previousIstMonth } from '../lib/dates';
import { getDb } from '../lib/db';
import { runHealthCheck } from './health-check';
import { generateReport } from './report';

export const CRON_WEEKLY_HEALTH = '30 0 * * 1'; // Monday 06:00 IST
export const CRON_MONTHLY_REPORT = '30 0 1 * *'; // 1st of month 06:00 IST
const MAX_ATTEMPTS = 3;

type JobType = JobMessage['type'];

/** Creates job_run rows and enqueues one message per client. */
export async function enqueueJobs(
  env: Env,
  jobs: {
    agencyId: string;
    clientId: string;
    type: JobType;
    trigger: 'cron' | 'manual';
    month?: string;
    send?: boolean;
  }[],
): Promise<string[]> {
  if (jobs.length === 0) return [];
  const db = getDb(env);
  const now = Date.now();
  const rows = jobs.map((j) => ({
    id: crypto.randomUUID(),
    agencyId: j.agencyId,
    clientId: j.clientId,
    type: j.type,
    trigger: j.trigger,
    status: 'queued' as const,
    attempt: 0,
    createdAt: now,
  }));
  // D1 limits bound parameters per statement, so insert in small chunks.
  for (let i = 0; i < rows.length; i += 10) await db.insert(jobRuns).values(rows.slice(i, i + 10));

  const messages = rows.map((r, i) => ({
    body: {
      jobRunId: r.id,
      agencyId: r.agencyId,
      clientId: r.clientId,
      type: r.type,
      month: jobs[i]!.month,
      send: jobs[i]!.send,
    } satisfies JobMessage,
  }));
  for (let i = 0; i < messages.length; i += 100)
    await env.JOBS_QUEUE.sendBatch(messages.slice(i, i + 100));
  return rows.map((r) => r.id);
}

/** Cron entry point: fan out one queue message per client. */
export async function handleCron(cron: string, env: Env, now = Date.now()) {
  const db = getDb(env);
  if (cron === CRON_MONTHLY_REPORT) {
    // Report on the month that just ended. Clients with auto-send get it emailed;
    // others get a ready-to-review report ("Preview & send manually").
    const list = await db
      .select({ id: clients.id, agencyId: clients.agencyId, autoSend: clients.autoSendReport })
      .from(clients)
      .where(eq(clients.status, 'active'));
    const month = previousIstMonth(now);
    await enqueueJobs(
      env,
      list.map((c) => ({
        agencyId: c.agencyId,
        clientId: c.id,
        type: 'monthly_report',
        trigger: 'cron',
        month,
        send: c.autoSend,
      })),
    );
    console.log(`Monthly report cron: queued ${list.length} clients for ${month}`);
    return;
  }
  // Weekly health check for every client (PageSpeed works even without a Google connection).
  const list = await db
    .select({ id: clients.id, agencyId: clients.agencyId })
    .from(clients)
    .where(ne(clients.status, 'reconnect_needed'));
  await enqueueJobs(
    env,
    list.map((c) => ({
      agencyId: c.agencyId,
      clientId: c.id,
      type: 'health_check',
      trigger: 'cron',
    })),
  );
  console.log(`Weekly health cron: queued ${list.length} clients`);
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
  await db
    .update(jobRuns)
    .set({ status: 'running', attempt: msg.attempts, startedAt: Date.now() })
    .where(where);

  try {
    if (job.type === 'health_check') {
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
    console.error(`Job ${job.type} failed for client ${job.clientId}`, err);
    const message = describeError(err).slice(0, 1000);
    // Monthly reports are not retried automatically (a partial retry could email twice).
    if (job.type === 'health_check' && isTransient(err) && msg.attempts < MAX_ATTEMPTS) {
      await db
        .update(jobRuns)
        .set({ status: 'queued', error: `Retrying: ${message}` })
        .where(where);
      msg.retry({ delaySeconds: 60 * msg.attempts });
    } else {
      await db
        .update(jobRuns)
        .set({ status: 'failed', error: message, finishedAt: Date.now() })
        .where(where);
      msg.ack();
    }
  }
}

/** Queue consumer: each message is handled on its own; one failure never affects the others. */
export async function handleQueueBatch(batch: MessageBatch<JobMessage>, env: Env) {
  for (const msg of batch.messages) await processMessage(env, msg);
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
  // Ignore stale "running" rows older than 20 minutes (e.g. a crashed worker).
  return row.length > 0 && Date.now() - row[0]!.createdAt < 20 * 60 * 1000;
}
