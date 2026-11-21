import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Conventions:
// - Primary keys are random UUID strings (crypto.randomUUID()).
// - Timestamps are Unix epoch milliseconds (integer). Convert to IST only in the UI.
// - Every tenant-owned row carries agency_id so every query can be scoped by it.

const id = () => text('id').primaryKey();
const createdAt = () => integer('created_at').notNull();

export const agencies = sqliteTable('agencies', {
  id: id(),
  name: text('name').notNull(),
  // Points to a row in `files` (logo bytes are stored in D1, no R2).
  logoFileId: text('logo_file_id'),
  brandColor: text('brand_color').notNull().default('#4f46e5'),
  plan: text('plan', { enum: ['free', 'pro'] })
    .notNull()
    .default('free'),
  // Google Slides file ID of the agency's report template (lives in the agency's Drive).
  slidesTemplateId: text('slides_template_id'),
  createdAt: createdAt(),
});

// Small uploaded files (agency logos) stored directly in D1 as base64.
// Max upload is 512 KB, which keeps each row well under D1's 2 MB row limit.
// Large files (report PDFs) go to KV instead, see reports.pdfKvKey.
export const files = sqliteTable(
  'files',
  {
    id: id(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['logo'] }).notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    dataBase64: text('data_base64').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('files_agency_idx').on(t.agencyId)],
);

export const users = sqliteTable(
  'users',
  {
    id: id(),
    // Null until the user finishes onboarding (creates an agency).
    agencyId: text('agency_id').references(() => agencies.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    name: text('name').notNull(),
    pictureUrl: text('picture_url'),
    role: text('role', { enum: ['owner', 'member'] })
      .notNull()
      .default('owner'),
    googleSub: text('google_sub').notNull(),
    // Incremented by "Log out of all devices"; sessions with an older version become invalid.
    sessionVersion: integer('session_version').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('users_google_sub_uq').on(t.googleSub),
    index('users_agency_idx').on(t.agencyId),
  ],
);

export const clients = sqliteTable(
  'clients',
  {
    id: id(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    websiteUrl: text('website_url').notNull(),
    contactEmail: text('contact_email').notNull(),
    gscSiteUrl: text('gsc_site_url'),
    ga4PropertyId: text('ga4_property_id'),
    status: text('status', { enum: ['not_connected', 'active', 'reconnect_needed'] })
      .notNull()
      .default('not_connected'),
    assignedUserId: text('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    autoSendReport: integer('auto_send_report', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('clients_agency_idx').on(t.agencyId)],
);

// purpose = 'client_data'      -> client's Google account (Search Console + GA4), client_id set
// purpose = 'agency_workspace' -> agency's own Google account (Slides, Drive, Gmail), client_id null
export const googleConnections = sqliteTable(
  'google_connections',
  {
    id: id(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    purpose: text('purpose', { enum: ['client_data', 'agency_workspace'] }).notNull(),
    googleEmail: text('google_email').notNull(),
    scopes: text('scopes').notNull(),
    // AES-GCM ciphertext, base64 "iv.ciphertext". Never stored in plain text.
    encryptedRefreshToken: text('encrypted_refresh_token').notNull(),
    connectedByUserId: text('connected_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    connectedAt: integer('connected_at').notNull(),
    status: text('status', { enum: ['active', 'revoked'] })
      .notNull()
      .default('active'),
  },
  (t) => [index('gconn_agency_idx').on(t.agencyId), index('gconn_client_idx').on(t.clientId)],
);

export const healthChecks = sqliteTable(
  'health_checks',
  {
    id: id(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    runAt: integer('run_at').notNull(),
    // Compact summaries (not raw API dumps). Null if that source failed.
    gscJson: text('gsc_json'),
    ga4Json: text('ga4_json'),
    pagespeedJson: text('pagespeed_json'),
    score: integer('score'),
    scoreBreakdownJson: text('score_breakdown_json'),
    // 1 = original 40/30/30 formula, 2 = 35/30/25/10 (see docs/HEALTH_SCORE.md).
    formulaVersion: integer('formula_version').notNull().default(1),
    status: text('status', { enum: ['ok', 'partial', 'failed'] }).notNull(),
    errorsJson: text('errors_json'),
  },
  (t) => [
    index('hc_client_run_idx').on(t.clientId, t.runAt),
    index('hc_agency_idx').on(t.agencyId),
  ],
);

export const insights = sqliteTable(
  'insights',
  {
    id: id(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    healthCheckId: text('health_check_id')
      .notNull()
      .references(() => healthChecks.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull(),
    summaryHinglish: text('summary_hinglish'),
    modelUsed: text('model_used').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('insights_hc_uq').on(t.healthCheckId)],
);

export const actionItems = sqliteTable(
  'action_items',
  {
    id: id(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    insightId: text('insight_id')
      .notNull()
      .references(() => insights.id, { onDelete: 'cascade' }),
    priority: integer('priority').notNull(), // 1 = most important
    title: text('title').notNull(),
    description: text('description'),
    why: text('why').notNull(),
    expectedImpact: text('expected_impact').notNull(),
    /** JSON array of short strings quoting metrics from the health check. */
    supportingMetricsJson: text('supporting_metrics_json'),
    done: integer('done', { mode: 'boolean' }).notNull().default(false),
    doneAt: integer('done_at'),
  },
  (t) => [index('ai_insight_idx').on(t.insightId), index('ai_agency_idx').on(t.agencyId)],
);

export const reports = sqliteTable(
  'reports',
  {
    id: id(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    month: text('month').notNull(), // "YYYY-MM"
    healthCheckId: text('health_check_id').references(() => healthChecks.id, {
      onDelete: 'set null',
    }),
    // Snapshot of the numbers/summary shown in the report (used by the public share page).
    dataJson: text('data_json'),
    slidesFileId: text('slides_file_id'),
    // KV key holding the PDF bytes (KV values can be up to 25 MiB).
    pdfKvKey: text('pdf_kv_key'),
    shareToken: text('share_token').notNull(),
    status: text('status', { enum: ['generating', 'ready', 'sent', 'failed'] }).notNull(),
    error: text('error'),
    sentAt: integer('sent_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('reports_share_token_uq').on(t.shareToken),
    index('reports_client_month_idx').on(t.clientId, t.month),
    index('reports_agency_idx').on(t.agencyId),
  ],
);

export const jobRuns = sqliteTable(
  'job_runs',
  {
    id: id(),
    agencyId: text('agency_id')
      .notNull()
      .references(() => agencies.id, { onDelete: 'cascade' }),
    clientId: text('client_id').references(() => clients.id, { onDelete: 'cascade' }),
    type: text('type', { enum: ['health_check', 'monthly_report'] }).notNull(),
    trigger: text('trigger', { enum: ['cron', 'manual'] }).notNull(),
    status: text('status', {
      enum: ['queued', 'running', 'success', 'partial', 'failed'],
    }).notNull(),
    error: text('error'),
    attempt: integer('attempt').notNull().default(1),
    /**
     * Idempotency key for scheduled jobs, e.g. "health_check:<clientId>:2026-W47".
     * Unique, so a cron that fires twice can't queue the same work twice. Null for manual runs.
     */
    dedupeKey: text('dedupe_key'),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('jobs_agency_created_idx').on(t.agencyId, t.createdAt),
    uniqueIndex('jobs_dedupe_uq').on(t.dedupeKey),
  ],
);

/** Who did what, when. Never stores secrets or raw IP addresses. */
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: id(),
    agencyId: text('agency_id').references(() => agencies.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(), // e.g. "client.create"
    targetType: text('target_type'),
    targetId: text('target_id'),
    /** Salted SHA-256 of the client IP (null if AUDIT_HASH_SALT is not set). */
    ipHash: text('ip_hash'),
    metadataJson: text('metadata_json'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_agency_created_idx').on(t.agencyId, t.createdAt)],
);

/** Per-agency report email settings. */
export const reportSettings = sqliteTable('report_settings', {
  agencyId: text('agency_id')
    .primaryKey()
    .references(() => agencies.id, { onDelete: 'cascade' }),
  /** Placeholders: {client}, {month}, {agency} */
  emailSubject: text('email_subject'),
  emailMessage: text('email_message'),
  ccAgency: integer('cc_agency', { mode: 'boolean' }).notNull().default(false),
  includeHinglish: integer('include_hinglish', { mode: 'boolean' }).notNull().default(false),
  updatedAt: integer('updated_at').notNull(),
});

/** Daily API call counters per agency, for quota/cost monitoring. */
export const apiUsage = sqliteTable(
  'api_usage',
  {
    id: id(),
    agencyId: text('agency_id').references(() => agencies.id, { onDelete: 'cascade' }),
    api: text('api').notNull(), // gsc, ga4, ga4_admin, pagespeed, slides, drive, gmail, oauth, workers_ai
    day: text('day').notNull(), // YYYY-MM-DD (IST)
    calls: integer('calls').notNull().default(0),
    errors: integer('errors').notNull().default(0),
    quotaErrors: integer('quota_errors').notNull().default(0),
  },
  (t) => [uniqueIndex('usage_agency_api_day_uq').on(t.agencyId, t.api, t.day)],
);
