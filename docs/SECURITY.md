# Security

## Authentication

- **Sign in with Google** (OpenID Connect, scopes `openid email profile`), separate from the client
  "Connect Google" flows.
- Every OAuth flow uses **`state`** (bound to a short-lived `HttpOnly` cookie, single use, 10 min TTL in KV),
  **PKCE S256** and a **`nonce`**. ID token claims checked: issuer, audience, expiry, nonce, verified email.
- **Turnstile** protects the login form (server-side verification, fails closed).
- **Rate limit**: `/auth/*` 20 requests/min/IP (KV fixed window, soft limit).

## Sessions

- 256-bit random session ID in an `HttpOnly; Secure; SameSite=Lax` cookie; data in KV.
- **Absolute expiry 7 days** (enforced in code, not only by KV TTL).
- **Rotation**: the session ID is replaced every 24 h (old ID valid 60 s for in-flight requests).
- **Logout** deletes the session. **Log out of all devices** increments `users.session_version`, which
  invalidates every existing session of that user.
- A fresh session is issued on each login (prevents session fixation).

## CSRF

Every non-GET `/api/*` request and `/auth/logout*` needs `X-CSRF-Token` equal to the session's token
(synchronizer token, constant-time compare). Cross-site `Origin` headers are rejected.

## Tenant isolation

- `agency_id` comes **only** from the signed-in user (never from the request).
- Every tenant query filters by `agency_id`; members are further limited to assigned clients.
- Proven by [`test/tenant-isolation.test.ts`](../test/tenant-isolation.test.ts): cross-agency reads, updates,
  deletes, report downloads/sends/re-exports, Google connection use, job logs, audit logs.

## Secrets and tokens

- Google **refresh tokens** and cached **access tokens** are encrypted with **AES-256-GCM** (Web Crypto),
  random 96-bit IV per value. Format `v2.<keyId>.<iv>.<ciphertext>`.
- **Key rotation**: set a new `TOKEN_ENCRYPTION_KEY` + `TOKEN_ENCRYPTION_KEY_ID`, keep the old one in
  `TOKEN_ENCRYPTION_KEY_PREVIOUS="<oldId>:<oldKey>"`. Old tokens still decrypt and are re-encrypted with the
  new key on next use. Remove the previous key once all clients have refreshed.
- Secrets live in `.dev.vars` (local, gitignored) and Worker secrets (`wrangler secret put`) in production.
  Nothing secret is sent to the browser.
- **Secret-safe logging** ([`src/lib/log.ts`](../src/lib/log.ts)): Google tokens, API keys, client secrets,
  bearer headers and encrypted blobs are redacted from all logs and audit metadata.

## Token revocation

- Disconnect → token revoked at Google and deleted locally.
- Refresh fails with `invalid_grant` → connection marked revoked, client shows **Reconnect needed**.

## Audit logs

`audit_logs` records logins, logouts, agency/client changes, Google connect/disconnect, manual jobs and
report sends. IPs are stored only as a **salted SHA-256** (needs `AUDIT_HASH_SALT`; otherwise not stored).
Only the agency owner can read their own agency's log.

## File uploads

Logos: max 512 KB, type detected from magic bytes (PNG/JPEG/WebP only; SVG/HTML rejected), stored in D1,
served with `X-Content-Type-Options: nosniff`.

## Report sharing

Share links use a 192-bit random token (`/r/:token`), are read-only, `noindex`, and only work for
`ready`/`sent` reports.

## Headers

`hono/secure-headers` on Worker responses; static assets get `X-Frame-Options: DENY`, `nosniff`,
`Referrer-Policy`, `Permissions-Policy` via `web/public/_headers`.

## API keys

- PageSpeed key: restricted to the PageSpeed Insights API, server-side only.
- **Recommended**: separate Google OAuth clients and API keys for development and production.

## Known gaps / before public launch

- Production Turnstile still uses Cloudflare test keys until a real widget is created.
- Google OAuth app is in **Testing** mode: refresh tokens expire after 7 days.
- Sensitive scopes need Google verification (see [API_INTEGRATIONS.md](API_INTEGRATIONS.md)).
- The OAuth client secret and PageSpeed key were shared in a chat during setup: rotate both before launch.
- No automated dependency/vulnerability scanning yet (`npm audit` shows dev-only issues in drizzle-kit).
