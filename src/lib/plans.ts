// Phase 4A/4B: subscription plans and usage limits. NO payment provider is integrated
// (the owner must approve one first). Plans are changed manually by the operator (see README).
import { and, eq, gte, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { agencies, clients, invitations, jobRuns, users } from '../db/schema';
import type { Env } from '../env';
import { istDate } from './dates';
import { getDb } from './db';

export type PlanId = 'free' | 'pro' | 'agency';

export const PLANS: Record<
  PlanId,
  {
    name: string;
    monthlyPriceInr: number;
    maxClients: number;
    maxMembers: number;
    manualRunsPerDay: number;
    /** Keyword rank tracker: keywords tracked per client. */
    maxKeywordsPerClient: number;
    /** On-demand AI requests per day (assistant, content, ad copy, audits, analyses). */
    aiRequestsPerDay: number;
  }
> = {
  // Prices are placeholders for planning only; nothing is charged.
  free: {
    name: 'Free',
    monthlyPriceInr: 0,
    maxClients: 5,
    maxMembers: 1,
    manualRunsPerDay: 30,
    maxKeywordsPerClient: 10,
    aiRequestsPerDay: 30,
  },
  pro: {
    name: 'Pro',
    monthlyPriceInr: 1999,
    maxClients: 25,
    maxMembers: 5,
    manualRunsPerDay: 200,
    maxKeywordsPerClient: 25,
    aiRequestsPerDay: 300,
  },
  agency: {
    name: 'Agency',
    monthlyPriceInr: 4999,
    maxClients: 100,
    maxMembers: 20,
    manualRunsPerDay: 1000,
    maxKeywordsPerClient: 50,
    aiRequestsPerDay: 1500,
  },
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** Epoch ms of today's 00:00 in IST. */
export function startOfIstDay(now = Date.now()): number {
  return Date.parse(`${istDate(now)}T00:00:00Z`) - IST_OFFSET_MS;
}

export async function getPlanUsage(env: Pick<Env, 'DB'>, agencyId: string, now = Date.now()) {
  const db = getDb(env);
  const agency = await db.query.agencies.findFirst({ where: eq(agencies.id, agencyId) });
  const plan = (agency?.plan ?? 'free') as PlanId;
  const count = (rows: { n: number }[]) => rows[0]?.n ?? 0;
  const [c, m, i, r] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)` })
      .from(clients)
      .where(eq(clients.agencyId, agencyId)),
    db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(eq(users.agencyId, agencyId)),
    db
      .select({ n: sql<number>`count(*)` })
      .from(invitations)
      .where(
        and(
          eq(invitations.agencyId, agencyId),
          sql`${invitations.acceptedAt} IS NULL`,
          gte(invitations.expiresAt, now),
        ),
      ),
    db
      .select({ n: sql<number>`count(*)` })
      .from(jobRuns)
      .where(
        and(
          eq(jobRuns.agencyId, agencyId),
          eq(jobRuns.trigger, 'manual'),
          gte(jobRuns.createdAt, startOfIstDay(now)),
        ),
      ),
  ]);
  return {
    plan,
    limits: PLANS[plan],
    usage: {
      clients: count(c),
      members: count(m),
      pendingInvites: count(i),
      manualRunsToday: count(r),
    },
  };
}

function limitError(message: string): never {
  throw new HTTPException(402, { message });
}

export async function assertCanAddClient(env: Pick<Env, 'DB'>, agencyId: string) {
  const { limits, usage } = await getPlanUsage(env, agencyId);
  if (usage.clients >= limits.maxClients) {
    limitError(
      `Your ${limits.name} plan allows ${limits.maxClients} clients. Upgrade the plan to add more.`,
    );
  }
}

export async function assertCanInvite(env: Pick<Env, 'DB'>, agencyId: string) {
  const { limits, usage } = await getPlanUsage(env, agencyId);
  if (usage.members + usage.pendingInvites >= limits.maxMembers) {
    limitError(
      `Your ${limits.name} plan allows ${limits.maxMembers} team member(s) including you.`,
    );
  }
}

export async function assertManualRunAllowed(env: Pick<Env, 'DB'>, agencyId: string) {
  const { limits, usage } = await getPlanUsage(env, agencyId);
  if (usage.manualRunsToday >= limits.manualRunsPerDay) {
    limitError(
      `Daily limit of ${limits.manualRunsPerDay} manual runs reached. Scheduled jobs still run.`,
    );
  }
}

const aiQuotaKey = (agencyId: string, now: number) => `aiq:${agencyId}:${istDate(now)}`;

/** AI requests used today (IST) by the agency. KV counter: a soft limit, good enough for cost control. */
export async function aiRequestsToday(env: Pick<Env, 'KV'>, agencyId: string, now = Date.now()) {
  return Number((await env.KV.get(aiQuotaKey(agencyId, now))) ?? '0');
}

/** Counts one on-demand AI request; HTTP 402 when the plan's daily AI limit is reached. */
export async function useAiQuota(env: Pick<Env, 'DB' | 'KV'>, agencyId: string, now = Date.now()) {
  const { limits } = await getPlanUsage(env, agencyId, now);
  const used = await aiRequestsToday(env, agencyId, now);
  if (used >= limits.aiRequestsPerDay) {
    limitError(
      `Daily limit of ${limits.aiRequestsPerDay} AI requests reached on the ${limits.name} plan. It resets at midnight IST.`,
    );
  }
  await env.KV.put(aiQuotaKey(agencyId, now), String(used + 1), { expirationTtl: 2 * 86_400 });
  return { used: used + 1, limit: limits.aiRequestsPerDay };
}
