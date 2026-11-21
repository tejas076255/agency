// Team invitations (Phase 2): the owner invites a member by email; the invite link carries a random
// token (only its SHA-256 is stored). The member signs in with Google using the SAME email to join.
import { and, eq, isNull } from 'drizzle-orm';
import { invitations, users } from '../db/schema';
import type { Env } from '../env';
import { randomToken } from './crypto';
import { getDb, type User } from './db';

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function sha256Hex(input: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createInvitation(
  env: Env,
  agencyId: string,
  email: string,
  invitedBy: string,
) {
  const token = randomToken(32);
  const row = {
    id: crypto.randomUUID(),
    agencyId,
    email: email.trim().toLowerCase(),
    role: 'member' as const,
    tokenHash: await sha256Hex(token),
    invitedByUserId: invitedBy,
    expiresAt: Date.now() + INVITE_TTL_MS,
    acceptedAt: null,
    createdAt: Date.now(),
  };
  await getDb(env).insert(invitations).values(row);
  return { invitation: row, url: `${env.APP_URL}/login?invite=${token}` };
}

export type InviteResult =
  | { ok: true; user: User }
  | { ok: false; reason: 'invalid' | 'expired' | 'email_mismatch' | 'already_in_agency' };

/** Accepts an invite for a signed-in user. Never moves a user who already belongs to an agency. */
export async function acceptInvitation(
  env: Env,
  user: User,
  token: string,
  now = Date.now(),
): Promise<InviteResult> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { ok: false, reason: 'invalid' };
  const db = getDb(env);
  const invite = await db.query.invitations.findFirst({
    where: and(eq(invitations.tokenHash, await sha256Hex(token)), isNull(invitations.acceptedAt)),
  });
  if (!invite) return { ok: false, reason: 'invalid' };
  if (invite.expiresAt < now) return { ok: false, reason: 'expired' };
  if (invite.email !== user.email.toLowerCase()) return { ok: false, reason: 'email_mismatch' };
  if (user.agencyId && user.agencyId !== invite.agencyId)
    return { ok: false, reason: 'already_in_agency' };

  await db.batch([
    db
      .update(users)
      .set({ agencyId: invite.agencyId, role: 'member' })
      .where(eq(users.id, user.id)),
    db.update(invitations).set({ acceptedAt: now }).where(eq(invitations.id, invite.id)),
  ]);
  return { ok: true, user: { ...user, agencyId: invite.agencyId, role: 'member' } };
}
