import { app } from './app';
import type { Env, JobMessage } from './env';
import { handleCron, handleQueueBatch } from './jobs/queue';

export default {
  fetch: app.fetch,

  // Cron Triggers: weekly health check (Mon 06:00 IST) and monthly report (1st, 06:00 IST).
  // The cron only fans out queue messages; the real work happens in the queue consumer.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleCron(controller.cron, env));
  },

  // Queue consumer: one message = one client + one job.
  async queue(batch: MessageBatch<JobMessage>, env: Env) {
    await handleQueueBatch(batch, env);
  },
} satisfies ExportedHandler<Env, JobMessage>;
