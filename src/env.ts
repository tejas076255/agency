// All Worker bindings, vars and secrets in one typed place.
export interface Env {
  // Bindings (wrangler.jsonc)
  DB: D1Database;
  KV: KVNamespace; // sessions, API cache, report PDFs
  JOBS_QUEUE: Queue<JobMessage>;
  AI: Ai;
  ASSETS: Fetcher;

  // Plain vars (wrangler.jsonc "vars")
  APP_URL: string;
  AI_MODEL: string;
  AI_GATEWAY_ID: string;
  TURNSTILE_SITE_KEY: string;
  /** Id of TOKEN_ENCRYPTION_KEY (stored inside every ciphertext). Default "k1". */
  TOKEN_ENCRYPTION_KEY_ID?: string;

  // Secrets (.dev.vars locally, `wrangler secret put` in production)
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  /** Optional, only during key rotation: "<old id>:<old base64 key>". */
  TOKEN_ENCRYPTION_KEY_PREVIOUS?: string;
  PAGESPEED_API_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  /** Optional salt for hashing IPs in audit logs. Without it, IPs are not recorded at all. */
  AUDIT_HASH_SALT?: string;

  // ---- Phase 2 / 3 (optional: features show "not configured" until set) ----
  /** Places API (New) key, restricted to Places API. Needs billing. */
  PLACES_API_KEY?: string;
  /** Cloud Natural Language API key, restricted to that API. Needs billing. */
  NATURAL_LANGUAGE_API_KEY?: string;
  /** Optional manager (MCC) customer id, sent as login-customer-id when reading client accounts through it. */
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;
  /** Google Ads REST API version (default v26). Access comes from the Cloud project; no developer token. */
  GOOGLE_ADS_API_VERSION?: string;
}

// One queue message = one client + one job. A failing client never blocks others.
export type JobMessage = {
  jobRunId: string;
  agencyId: string;
  clientId: string;
  type: 'health_check' | 'monthly_report' | 'profile_scan';
  trigger?: 'cron' | 'manual' | 'setup';
  userId?: string;
  /** monthly_report only: "YYYY-MM" and whether to email it right away. */
  month?: string;
  send?: boolean;
};
