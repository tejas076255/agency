// Phase 2 team management + Phase 4 billing overview (plans and limits, no payments).
import { Hono } from 'hono';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { agencies, clients, invitations, users } from '../db/schema';
import { describeError } from '../google/http';
import { getAccessToken, getConnection } from '../google/tokens';
import { buildMimeMessage, sendGmail } from '../google/workspace';
import { auditRequest } from '../lib/audit';
import { getDb } from '../lib/db';
import { assertCanInvite, getPlanUsage, PLANS } from '../lib/plans';
import { createInvitation } from '../lib/team';
import { readJson } from '../lib/validate';
import { currentUser, requireAgency, requireOwner } from '../middleware/auth';
import { escapeHtml } from '../jobs/report';
import type { AppEnv } from '../types';

export const teamRoutes = new Hono<AppEnv>();
teamRoutes.use('*', requireAgency);

teamRoutes.get('/', async (c) => {
  const agencyId = c.get('agencyId');
  const db = getDb(c.env);
  const members = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      pictureUrl: users.pictureUrl,
      assignedClients: sql<number>`(SELECT COUNT(*) FROM clients WHERE clients.assigned_user_id = ${users.id} AND clients.agency_id = ${agencyId})`,
    })
    .from(users)
    .where(eq(users.agencyId, agencyId))
    .orderBy(users.createdAt);
  const isOwner = currentUser(c).role === 'owner';
  const invites = isOwner
    ? await db
        .select({
          id: invitations.id,
          email: invitations.email,
          expiresAt: invitations.expiresAt,
          createdAt: invitations.createdAt,
        })
        .from(invitations)
        .where(
          and(
            eq(invitations.agencyId, agencyId),
            isNull(invitations.acceptedAt),
            gte(invitations.expiresAt, Date.now()),
          ),
        )
        .orderBy(desc(invitations.createdAt))
    : [];
  return c.json({ members, invites });
});

teamRoutes.post('/invites', requireOwner, async (c) => {
  const { email, sendEmail } = await readJson(
    c,
    z.object({
      email: z.string().trim().toLowerCase().email(),
      sendEmail: z.boolean().default(false),
    }),
  );
  const agencyId = c.get('agencyId');
  const db = getDb(c.env);
  const existing = await db.query.users.findFirst({
    where: and(eq(users.email, email), eq(users.agencyId, agencyId)),
  });
  if (existing) return c.json({ error: 'This person is already in your agency' }, 409);
  await assertCanInvite(c.env, agencyId);

  const { invitation, url } = await createInvitation(c.env, agencyId, email, currentUser(c).id);
  let emailed = false;
  let emailError: string | null = null;
  if (sendEmail) {
    try {
      const conn = await getConnection(c.env, agencyId, 'agency_workspace');
      if (!conn)
        throw new Error('Connect the agency Google account in Settings to send invite emails');
      const agency = await db.query.agencies.findFirst({ where: eq(agencies.id, agencyId) });
      const name = escapeHtml(agency?.name ?? 'our agency');
      await sendGmail(
        await getAccessToken(c.env, conn),
        buildMimeMessage({
          to: email,
          subject: `You're invited to join ${agency?.name ?? 'an agency'} on Agency Autopilot`,
          html: `<p>Hi,</p><p>${escapeHtml(currentUser(c).name)} invited you to join <b>${name}</b> on Agency Autopilot.</p>
<p><a href="${escapeHtml(url)}">Accept the invitation</a> and sign in with Google using <b>${escapeHtml(email)}</b>.</p>
<p>This link expires in 7 days.</p>`,
        }),
      );
      emailed = true;
    } catch (err) {
      emailError = describeError(err);
    }
  }
  await auditRequest(c, 'team.invite', {
    targetType: 'invitation',
    targetId: invitation.id,
    metadata: { email, emailed },
  });
  return c.json({ url, emailed, emailError, expiresAt: invitation.expiresAt }, 201);
});

teamRoutes.delete('/invites/:id', requireOwner, async (c) => {
  await getDb(c.env)
    .delete(invitations)
    .where(and(eq(invitations.id, c.req.param('id')), eq(invitations.agencyId, c.get('agencyId'))));
  await auditRequest(c, 'team.invite_revoke', {
    targetType: 'invitation',
    targetId: c.req.param('id'),
  });
  return c.json({ ok: true });
});

/** Removes a member: they lose access immediately (sessions revoked) and their clients are unassigned. */
teamRoutes.delete('/members/:userId', requireOwner, async (c) => {
  const agencyId = c.get('agencyId');
  const userId = c.req.param('userId');
  const db = getDb(c.env);
  const member = await db.query.users.findFirst({
    where: and(eq(users.id, userId), eq(users.agencyId, agencyId)),
  });
  if (!member) return c.json({ error: 'Member not found' }, 404);
  if (member.role === 'owner') return c.json({ error: 'The owner cannot be removed' }, 400);
  await db.batch([
    db
      .update(users)
      .set({ agencyId: null, role: 'owner', sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(and(eq(users.id, userId), eq(users.agencyId, agencyId))),
    db
      .update(clients)
      .set({ assignedUserId: null, updatedAt: Date.now() })
      .where(and(eq(clients.assignedUserId, userId), eq(clients.agencyId, agencyId))),
  ]);
  await auditRequest(c, 'team.member_remove', {
    targetType: 'user',
    targetId: userId,
    metadata: { email: member.email },
  });
  return c.json({ ok: true });
});

export const billingRoutes = new Hono<AppEnv>();
billingRoutes.use('*', requireAgency);

billingRoutes.get('/', async (c) => {
  const status = await getPlanUsage(c.env, c.get('agencyId'));
  return c.json({ ...status, plans: PLANS, paymentsEnabled: false });
});
