import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { agencies, auditLogs, files, reportSettings, users } from '../db/schema';
import { auditRequest } from '../lib/audit';
import { bytesToBase64 } from '../lib/crypto';
import { getDb, type Agency } from '../lib/db';
import { loadReportSettings } from '../lib/report-settings';
import { getUsage } from '../lib/usage';
import { readJson } from '../lib/validate';
import { currentUser, requireAgency, requireAuth, requireOwner } from '../middleware/auth';
import type { AppEnv } from '../types';

export const MAX_LOGO_BYTES = 512 * 1024;

const brandColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex color like #4f46e5');
const agencyName = z.string().trim().min(2, 'At least 2 characters').max(80);

const createAgencySchema = z.object({ name: agencyName, brandColor: brandColor.optional() });
const updateAgencySchema = z
  .object({ name: agencyName.optional(), brandColor: brandColor.optional() })
  .refine((v) => v.name !== undefined || v.brandColor !== undefined, 'Nothing to update');

export function agencyDto(agency: Agency) {
  return {
    id: agency.id,
    name: agency.name,
    brandColor: agency.brandColor,
    plan: agency.plan,
    logoUrl: agency.logoFileId ? `/api/public/logo/${agency.logoFileId}` : null,
  };
}

export const agencyRoutes = new Hono<AppEnv>();

/** Onboarding: a signed-in user without an agency creates one and becomes its owner. */
agencyRoutes.post('/', requireAuth, async (c) => {
  const user = currentUser(c);
  if (user.agencyId) return c.json({ error: 'You already belong to an agency' }, 409);
  const input = await readJson(c, createAgencySchema);

  const db = getDb(c.env);
  const agency: Agency = {
    id: crypto.randomUUID(),
    name: input.name,
    brandColor: input.brandColor ?? '#4f46e5',
    plan: 'free',
    logoFileId: null,
    slidesTemplateId: null,
    createdAt: Date.now(),
  };
  // Atomic: create agency and attach the user to it.
  await db.batch([
    db.insert(agencies).values(agency),
    db.update(users).set({ agencyId: agency.id, role: 'owner' }).where(eq(users.id, user.id)),
  ]);
  await auditRequest(c, 'agency.create', {
    agencyId: agency.id,
    targetType: 'agency',
    targetId: agency.id,
    metadata: { name: agency.name },
  });
  return c.json({ agency: agencyDto(agency) }, 201);
});

agencyRoutes.get('/', requireAgency, async (c) => {
  const agency = await getDb(c.env).query.agencies.findFirst({
    where: eq(agencies.id, c.get('agencyId')),
  });
  if (!agency) return c.json({ error: 'Agency not found' }, 404);
  return c.json({ agency: agencyDto(agency) });
});

agencyRoutes.put('/', requireAgency, requireOwner, async (c) => {
  const input = await readJson(c, updateAgencySchema);
  const [agency] = await getDb(c.env)
    .update(agencies)
    .set(input)
    .where(eq(agencies.id, c.get('agencyId')))
    .returning();
  if (!agency) return c.json({ error: 'Agency not found' }, 404);
  await auditRequest(c, 'agency.update', { targetType: 'agency', targetId: agency.id, metadata: input });
  return c.json({ agency: agencyDto(agency) });
});

/** Detects the real image type from the file's first bytes (don't trust the browser's type). */
export function sniffImageType(
  bytes: Uint8Array,
): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 12 &&
    String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === 'RIFF' &&
    String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

agencyRoutes.post('/logo', requireAgency, requireOwner, async (c) => {
  const agencyId = c.get('agencyId');
  const body = await c.req.parseBody();
  const file = body['logo'];
  if (!(file instanceof File)) return c.json({ error: 'Attach an image in the "logo" field' }, 400);
  if (file.size > MAX_LOGO_BYTES) return c.json({ error: 'Logo must be 512 KB or smaller' }, 400);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = sniffImageType(bytes);
  if (!contentType) return c.json({ error: 'Logo must be a PNG, JPEG or WebP image' }, 400);

  const db = getDb(c.env);
  const agency = await db.query.agencies.findFirst({ where: eq(agencies.id, agencyId) });
  if (!agency) return c.json({ error: 'Agency not found' }, 404);

  const fileId = crypto.randomUUID();
  const statements = [
    db.insert(files).values({
      id: fileId,
      agencyId,
      kind: 'logo',
      contentType,
      sizeBytes: bytes.length,
      dataBase64: bytesToBase64(bytes),
      createdAt: Date.now(),
    }),
    db.update(agencies).set({ logoFileId: fileId }).where(eq(agencies.id, agencyId)),
  ] as const;
  if (agency.logoFileId) {
    await db.batch([
      ...statements,
      db.delete(files).where(and(eq(files.id, agency.logoFileId), eq(files.agencyId, agencyId))),
    ]);
  } else {
    await db.batch(statements);
  }
  await auditRequest(c, 'agency.logo_update', {
    targetType: 'file',
    targetId: fileId,
    metadata: { contentType, sizeBytes: bytes.length },
  });
  return c.json({ agency: agencyDto({ ...agency, logoFileId: fileId }) });
});

agencyRoutes.delete('/logo', requireAgency, requireOwner, async (c) => {
  const agencyId = c.get('agencyId');
  const db = getDb(c.env);
  const agency = await db.query.agencies.findFirst({ where: eq(agencies.id, agencyId) });
  if (!agency) return c.json({ error: 'Agency not found' }, 404);
  if (agency.logoFileId) {
    await db.batch([
      db.update(agencies).set({ logoFileId: null }).where(eq(agencies.id, agencyId)),
      db.delete(files).where(and(eq(files.id, agency.logoFileId), eq(files.agencyId, agencyId))),
    ]);
  }
  await auditRequest(c, 'agency.logo_delete', { targetType: 'agency', targetId: agencyId });
  return c.json({ agency: agencyDto({ ...agency, logoFileId: null }) });
});

// ---------------------------------- Report settings ----------------------------------

const reportSettingsInput = z.object({
  emailSubject: z.string().trim().min(3).max(150),
  emailMessage: z.string().trim().min(3).max(1000),
  ccAgency: z.boolean(),
  includeHinglish: z.boolean(),
});

agencyRoutes.get('/report-settings', requireAgency, async (c) => {
  return c.json({ settings: await loadReportSettings(c.env, c.get('agencyId')) });
});

agencyRoutes.put('/report-settings', requireAgency, requireOwner, async (c) => {
  const input = await readJson(c, reportSettingsInput);
  const agencyId = c.get('agencyId');
  await getDb(c.env)
    .insert(reportSettings)
    .values({ agencyId, ...input, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: reportSettings.agencyId, set: { ...input, updatedAt: Date.now() } });
  await auditRequest(c, 'agency.report_settings_update', { targetType: 'agency', targetId: agencyId });
  return c.json({ settings: input });
});

// ------------------------------- Audit log & API usage -------------------------------

agencyRoutes.get('/audit-logs', requireAgency, requireOwner, async (c) => {
  const rows = await getDb(c.env)
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      metadataJson: auditLogs.metadataJson,
      createdAt: auditLogs.createdAt,
      userName: users.name,
      userEmail: users.email,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.userId))
    .where(eq(auditLogs.agencyId, c.get('agencyId')))
    .orderBy(desc(auditLogs.createdAt))
    .limit(200);
  return c.json({
    logs: rows.map(({ metadataJson, ...r }) => ({
      ...r,
      metadata: metadataJson ? (JSON.parse(metadataJson) as Record<string, unknown>) : null,
    })),
  });
});

agencyRoutes.get('/usage', requireAgency, async (c) => {
  return c.json({ usage: await getUsage(c.env, c.get('agencyId'), 7) });
});
