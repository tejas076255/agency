import type { Context } from 'hono';
import { auditLogs } from '../db/schema';
import type { Env } from '../env';
import type { AppEnv } from '../types';
import { getDb } from './db';
import { log, redact } from './log';

export type AuditAction =
  | 'auth.login'
  | 'auth.logout'
  | 'auth.logout_all'
  | 'agency.create'
  | 'agency.update'
  | 'agency.logo_update'
  | 'agency.logo_delete'
  | 'agency.report_settings_update'
  | 'client.create'
  | 'client.update'
  | 'client.delete'
  | 'client.sources_update'
  | 'google.client_connect'
  | 'google.client_disconnect'
  | 'google.workspace_connect'
  | 'google.workspace_disconnect'
  | 'job.run_requested'
  | 'report.pdf_refresh'
  | 'report.send'
  | 'client.assign'
  | 'client.integration_selection'
  | 'google.product_disconnect'
  | 'review.reply'
  | 'competitor.add'
  | 'competitor.remove'
  | 'export.sheets'
  | 'team.invite'
  | 'team.invite_revoke'
  | 'team.member_remove'
  | 'keyword.add'
  | 'keyword.remove';

export type AuditEntry = {
  agencyId: string | null;
  userId: string | null;
  action: AuditAction;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
};

async function hashIp(salt: string, ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${ip}`));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Writes an audit log entry. Never throws: auditing must not break the user's action. */
export async function audit(env: Pick<Env, 'DB' | 'AUDIT_HASH_SALT'>, entry: AuditEntry) {
  try {
    await getDb(env)
      .insert(auditLogs)
      .values({
        id: crypto.randomUUID(),
        agencyId: entry.agencyId,
        userId: entry.userId,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        ipHash:
          entry.ip && env.AUDIT_HASH_SALT ? await hashIp(env.AUDIT_HASH_SALT, entry.ip) : null,
        metadataJson: entry.metadata ? JSON.stringify(redact(entry.metadata)) : null,
        createdAt: Date.now(),
      });
  } catch (err) {
    log.error('Audit log write failed', err, { action: entry.action });
  }
}

/** Convenience: audit an action by the signed-in user of this request. */
export function auditRequest(
  c: Context<AppEnv>,
  action: AuditAction,
  extra: Omit<AuditEntry, 'action' | 'agencyId' | 'userId' | 'ip'> & {
    agencyId?: string | null;
  } = {},
) {
  const user = c.get('user');
  return audit(c.env, {
    action,
    agencyId: extra.agencyId ?? user?.agencyId ?? null,
    userId: user?.id ?? null,
    ip: c.req.header('cf-connecting-ip') ?? null,
    targetType: extra.targetType,
    targetId: extra.targetId,
    metadata: extra.metadata,
  });
}
