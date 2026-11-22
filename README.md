# Agency Autopilot

SaaS for small digital marketing agencies and freelancers in India. Connect each client's Google
accounts once; the app runs weekly health checks (SEO, traffic, site speed), uses AI to write a
"do these 5 things this week" action list, and emails each client a branded monthly PDF report.

**Live:** https://agency-autopilot.invoice-to-excel.workers.dev

**Stack:** Cloudflare Workers (Hono, TypeScript) · D1 + Drizzle · KV · Queues · Cron Triggers ·
Workers AI (+ AI Gateway) · Turnstile · React + Vite + Tailwind (Workers Static Assets) ·
Google Search Console, GA4 Data/Admin, PageSpeed Insights, Slides, Drive and Gmail APIs.

> Status: **Phases 1-3 code complete, Phase 4 plans/limits done (no payments)** (see [PROJECT_STATUS.md](PROJECT_STATUS.md) for what is verified and what
> still needs the owner's test with real Google accounts). Phase 2/3 integrations need Google approvals/billing before they return real data.

**Docs:** [Project status](PROJECT_STATUS.md) · [Architecture](docs/ARCHITECTURE.md) ·
[API integrations & readiness](docs/API_INTEGRATIONS.md) · [Security](docs/SECURITY.md) ·
[Health score](docs/HEALTH_SCORE.md)

> Storage note: the spec mentions R2, but by the owner's decision **R2 is not used**. Logos are stored in D1
> and report PDFs in KV.

---

## Features (Phase 1)

| Feature                                                                                      | Where                                                     |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Sign in with Google (OIDC + PKCE + state + nonce), Turnstile on login                        | `src/routes/auth.ts`                                      |
| Agency onboarding: name, brand color, logo (stored in D1)                                    | `src/routes/agency.ts`, `web/src/pages/Onboarding.tsx`    |
| Clients CRUD, "Connect Google", pick Search Console site + GA4 property                      | `src/routes/clients.ts`, `web/src/pages/ClientDetail.tsx` |
| Weekly health check: Cron → Queue → one message per client                                   | `src/jobs/queue.ts`, `src/jobs/health-check.ts`           |
| Search Console: 28d vs previous 28d, top queries, quick wins (pos. 8-20), dropping pages     | `src/google/gsc.ts`                                       |
| GA4: sessions, users, key events, engagement, channels, landing pages                        | `src/google/ga4.ts`                                       |
| PageSpeed: mobile + desktop score, LCP, CLS, INP, top 3 fixes                                | `src/google/pagespeed.ts`                                 |
| Health score 0-100 (formula below)                                                           | `src/lib/score.ts`                                        |
| AI insights: summary + exactly 5 prioritized actions + Hinglish, Zod-validated, 1 retry      | `src/lib/ai.ts`                                           |
| Dashboard with scores, trend arrows, "Reconnect needed" flags                                | `web/src/pages/Dashboard.tsx`                             |
| Client page: charts (clicks, sessions, speed), action items with "done" checkbox             | `web/src/pages/ClientDetail.tsx`                          |
| Monthly report: Slides template → fill → PDF (stored in KV) → Gmail → share link `/r/:token` | `src/jobs/report.ts`, `src/routes/public.ts`              |
| "Preview & send manually" or auto-send per client                                            | Client page → Monthly reports                             |
| Job logs with errors + "Run now"                                                             | `web/src/pages/Jobs.tsx`                                  |
| Edit report in Google Slides → "Re-export PDF"; report email settings (subject, message, CC) | `src/jobs/report.ts`, `web/src/pages/Settings.tsx`        |
| Audit log, API usage (quota) tracking, logout from all devices                               | `src/lib/audit.ts`, `src/lib/usage.ts`                    |
| AI fallback: rule-based 5 actions when AI fails; metric-grounding check                      | `src/lib/insights.ts`                                     |
| Keyword rank tracker: weekly Google positions per keyword (Search Console), 13-week graph    | `src/jobs/keywords.ts`, client page → Keywords            |
| AI review reply drafts (English / Hinglish / Hindi), edited before posting                   | `src/lib/ai.ts`, client page → Local SEO & reviews        |
| AI tools: SEO assistant chat, content writer, Google Ads copy, smart alerts                  | `src/lib/ai-tools.ts`, client page → AI tools             |
| AI competitor review analysis, opt-in AI auto-reply to 4-5 star reviews                      | client page → Local SEO & reviews                         |
| Prospect audits (free website audit + PDF for lead generation)                               | `src/lib/site-audit.ts`, Prospect audits page             |
| Privacy policy and terms pages (for the Google consent screen)                               | `web/src/pages/Legal.tsx` (`/privacy`, `/terms`)          |

Times are shown in IST; numbers use Indian grouping (1,23,456).

## Project layout

```
src/
  index.ts            Worker entry: fetch / scheduled (cron) / queue handlers
  app.ts              Hono app + route mounting (imported by tests)
  env.ts              Typed bindings, vars, secrets, queue message type
  db/schema.ts        Drizzle schema (source of truth for the DB)
  middleware/auth.ts  Session loading, requireAuth/Agency/Owner, CSRF
  routes/             auth, agency, me, clients, reports (+jobs, workspace), public
  google/             http (backoff), tokens (encrypted refresh tokens), gsc, ga4, pagespeed, workspace (Slides/Drive/Gmail)
  jobs/               queue (cron fan-out + consumer), health-check, report
  lib/                crypto (AES-GCM, PKCE), session, google-oauth, ai, score, dates, png-chart, rate-limit, turnstile
web/src/              React app (pages, components, lib)
migrations/           SQL generated by drizzle-kit, applied by wrangler
test/                 Vitest (unit + integration on local D1/KV)
```

---

## Setup from zero

### 1. Prerequisites

- Node.js 20+ (tested on Node 24), Git, VS Code
- A Cloudflare account (free plan works) and a Google account

### 2. Install

```bash
npm install
cp .dev.vars.example .dev.vars       # PowerShell: Copy-Item .dev.vars.example .dev.vars
npm run db:migrate:local
```

### 3. Google Cloud Console (one time)

1. https://console.cloud.google.com → project dropdown → **New Project** → `agency-autopilot` → **Create**, then select it.
2. **APIs & Services → Library**, search and **Enable** each:
   Google Search Console API · Google Analytics Data API · Google Analytics Admin API ·
   PageSpeed Insights API · Google Slides API · Google Drive API · Gmail API.
3. **Google Auth Platform** (OAuth consent screen) → **Get started** → App name, support email →
   Audience **External** → contact email → **Create**.
4. **Audience → Test users → Add users**: add every Google account you will log in or connect with
   (yours and your test clients'). In Testing mode only these accounts work.
5. **Data Access → Add or remove scopes**: add `openid`, `email`, `profile`,
   `.../auth/webmasters.readonly`, `.../auth/analytics.readonly`, `.../auth/drive.file`,
   `.../auth/presentations`, `.../auth/gmail.send` → **Save**.
6. **Clients → Create client → Web application**:
   - Authorized JavaScript origins: `http://localhost:5173` and `https://<your-worker>.workers.dev`
   - Authorized redirect URIs: `http://localhost:5173/auth/google/callback` and
     `https://<your-worker>.workers.dev/auth/google/callback`
   - Copy **Client ID** and **Client secret** into `.dev.vars`.
7. **APIs & Services → Credentials → Create credentials → API key** → edit it →
   **API restrictions → Restrict key → PageSpeed Insights API** → Save. Put it in `.dev.vars` as `PAGESPEED_API_KEY`.
8. Generate the encryption key and put it in `.dev.vars` as `TOKEN_ENCRYPTION_KEY`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```

### 4. Run locally

```bash
npm run dev
```

Open **http://localhost:5173** (Vite, hot reload). Vite proxies `/api`, `/auth`, `/r/` to the
Worker on `http://127.0.0.1:8787`, which uses local D1/KV/Queues stored in `.wrangler/`.
Workers AI always runs remotely (you must be logged in with `npx wrangler login`).

Test the cron locally: `curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled?cron=30+0+*+*+1"`.

> Local limitation: Google Slides must download images from a public URL, so in local dev the
> report is created **without** the logo and chart images. Everything else works locally.

### 5. Try the full flow

1. Sign in with Google → create agency → upload logo.
2. **Settings → Reports: agency Google account → Connect** (Slides, Drive files, Gmail send).
3. **Clients → Add client** (use your own website and your own email as client email).
4. On the client page → **Connect Google** → pick the Search Console site and GA4 property → **Save**.
5. **Run health check** → wait 1-2 minutes → score, charts and 5 AI action items appear.
6. **Monthly reports → Generate preview now** → **Preview PDF** → **Send to client** → check your Gmail.

---

## Deploy

### First deploy on a new Cloudflare account

1. `npx wrangler login`, then `npx wrangler whoami` and put your Account ID in `wrangler.jsonc` → `account_id`.
2. Create resources and copy the printed IDs into `wrangler.jsonc`:
   ```bash
   npx wrangler d1 create agency-autopilot          # -> d1_databases[0].database_id
   npx wrangler kv namespace create KV              # -> kv_namespaces[0].id
   npx wrangler queues create agency-jobs
   npx wrangler queues create agency-jobs-dlq
   ```
   No R2 needed: logos live in D1 (`files` table, max 512 KB), report PDFs in KV (max 25 MiB).
3. `npm run db:migrate:remote`
4. Secrets (each command asks for the value; never paste secrets in chat or commit them):
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put TOKEN_ENCRYPTION_KEY     # a NEW key, different from local
   npx wrangler secret put PAGESPEED_API_KEY
   npx wrangler secret put TURNSTILE_SECRET_KEY
   ```
5. Set `vars.APP_URL` in `wrangler.jsonc` to your `https://….workers.dev` URL.
6. `npm run deploy`

### Later deploys

```bash
npm run db:migrate:remote   # only when there are new files in migrations/
npm run deploy
```

### Turnstile (real bot protection)

Local dev and the current production config use Cloudflare's **test keys** (always pass).
For real protection: Cloudflare dashboard → **Turnstile → Add widget** → hostname = your
workers.dev domain → mode **Managed** → put the **site key** in `wrangler.jsonc` →
`vars.TURNSTILE_SITE_KEY`, run `npx wrangler secret put TURNSTILE_SECRET_KEY` with the secret,
then `npm run deploy`.

### AI Gateway (logging, caching, rate limits)

Cloudflare dashboard → **AI → AI Gateway → Create Gateway** → name `agency-autopilot`
(must match `vars.AI_GATEWAY_ID`). If the gateway doesn't exist the app falls back to calling
Workers AI directly. To switch models, change `vars.AI_MODEL` (all AI calls go through
`runModel()` in `src/lib/ai.ts`).

---

## Health score formula

Formula v2: Search performance **35** · Organic traffic **30** · Website performance **25** ·
Data completeness **10**. Full rules, missing-data handling and worked examples:
**[docs/HEALTH_SCORE.md](docs/HEALTH_SCORE.md)**.

## Jobs and reliability

- **Cron** (UTC in `wrangler.jsonc`): `30 0 * * 1` = Monday 06:00 IST health checks;
  `30 0 1 * *` = 1st of month 06:00 IST reports for the previous month.
- Cron only enqueues **one queue message per client**, so one failing client never affects others.
- Each source (GSC, GA4, PageSpeed, AI) is independent: if one fails the check is saved as
  **partial** with the error shown on the client page and in Job logs.
- Google calls retry with **exponential backoff + jitter** on 429/5xx (respects `Retry-After`).
  Transient health-check failures are retried by the queue up to 3 times. Report emails are never
  retried automatically (to avoid double emails).
- Revoked refresh token → connection marked revoked, client shows **Reconnect needed**.

## Security

- Refresh tokens and cached access tokens are encrypted with **AES-256-GCM** (Web Crypto),
  key = `TOKEN_ENCRYPTION_KEY` secret.
- Sessions: 256-bit random ID, `HttpOnly; Secure; SameSite=Lax` cookie, data in KV (7 days).
- CSRF: `X-CSRF-Token` (synchronizer token) on all non-GET `/api/*` + Origin check.
- OAuth: `state` (bound to a cookie) + **PKCE S256** + `nonce` on every flow.
- Every query is scoped by `agency_id`; members only see assigned clients.
  `test/tenant-isolation.test.ts` proves agency A can't read or change agency B's data.
- Zod validation on all inputs; KV rate limit on `/auth/*` (20/min/IP); logo type checked by magic bytes.

## Google OAuth scopes and verification

| Scope                  | Used for                                                          | Google classification       |
| ---------------------- | ----------------------------------------------------------------- | --------------------------- |
| `openid email profile` | Sign in                                                           | Non-sensitive               |
| `webmasters.readonly`  | Search Console data                                               | **Sensitive**               |
| `analytics.readonly`   | GA4 data + property list                                          | **Sensitive**               |
| `drive.file`           | Copy the report template, export PDF (only files the app created) | Non-sensitive               |
| `presentations`        | Fill the Slides report                                            | **Sensitive**               |
| `gmail.send`           | Email the report from the agency's Gmail                          | **Sensitive** (Gmail scope) |

While the app is in **Testing** mode, only listed test users can sign in and refresh tokens expire
after 7 days (clients will show "Reconnect needed" weekly). Before going public you must submit
the app for **verification** (privacy policy, homepage, demo video) for the four sensitive scopes.
`gmail.send` is sensitive (not restricted), so a CASA security assessment is not required.

## Testing

```bash
npm test          # Vitest: 142 tests
npm run typecheck # strict TypeScript (Worker + web)
npm run lint
```

Covers token encryption, PKCE, ID token validation, health-score math, AI output validation and
retry, Google response parsing, PNG chart, MIME email, tenant isolation (real local D1/KV via
`getPlatformProxy`) and the full health-check pipeline with **mocked Google APIs** (partial
failures, backoff, token caching, revoked tokens) and cron fan-out. No test hits a real API.

## Free-tier notes

- **KV free plan: 1,000 writes/day.** Sessions, rate-limit counters, access-token cache and
  report PDFs all write to KV. Fine for testing and a handful of clients; upgrade to Workers Paid
  ($5/month) before onboarding many agencies.
- Workers AI free allocation: 10,000 neurons/day (roughly a few hundred insight generations).

## Troubleshooting

| Problem                                            | Fix                                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `redirect_uri_mismatch`                            | The redirect URI in Google Console must exactly match `APP_URL + /auth/google/callback` |
| "Access blocked: app not verified" / can't sign in | Add the Google account under **Audience → Test users**                                  |
| Client shows "Reconnect needed" every week         | Normal in Testing mode (7-day refresh tokens). Publish/verify the app to fix            |
| "Invalid or missing CSRF token"                    | Refresh the page; locally use http://localhost:5173 (not :8787)                         |
| No Search Console sites in the dropdown            | The connected Google account must be an owner/user of the property in Search Console    |
| Report has no images locally                       | Expected; images need a public URL (works in production)                                |
| `wrangler dev` slow to start                       | It's opening the remote Workers AI connection; wait or retry                            |

## Roadmap

- **Phase 2:** Business Profile (calls, directions, reviews; needs Google access approval),
  Places competitor tracking, review sentiment (Natural Language API), Sheets export,
  team member invites, white-label report domain.
- **Phase 3:** YouTube Data/Analytics, Google Ads (needs Explorer access on the Google Cloud project),
  optional Google Trends, billing/plans in INR (likely Razorpay).

## Phase 2 / 3 / 4 setup (optional integrations)

All of these are optional: until configured, each section shows "not configured" or "not approved" instead of fake data.
Details and approval steps: [docs/API_INTEGRATIONS.md](docs/API_INTEGRATIONS.md).

| Feature                                              | What you need                                                                    | How to configure                                                                                                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Business Profile (calls, directions, reviews) | Google approval of Business Profile API access                                   | Enable the 4 Business Profile APIs, add scope `business.manage` to the consent screen; then on a client, Local SEO tab, Connect                                                                      |
| Competitors (Places API New)                         | Billing on the Cloud project                                                     | Restricted API key, then `npx wrangler secret put PLACES_API_KEY`                                                                                                                                    |
| Review sentiment (Natural Language)                  | Billing on the Cloud project                                                     | Restricted API key, then `npx wrangler secret put NATURAL_LANGUAGE_API_KEY`                                                                                                                          |
| Google Ads                                           | Explorer access for the Google Cloud project (no developer token since Sep 2026) | Enable "Google Ads API", apply for Explorer in Cloud Console > Google Ads API > Overview, add scope `adwords`; optional `npx wrangler secret put GOOGLE_ADS_LOGIN_CUSTOMER_ID` for a manager account |
| YouTube                                              | Channel owner signs in                                                           | Enable YouTube Data API v3 + YouTube Analytics API; add `youtube.readonly` and `yt-analytics.readonly` scopes                                                                                        |
| Sheets export                                        | Agency Google account connected (Settings)                                       | Nothing extra (uses `drive.file`)                                                                                                                                                                    |
| Team members                                         | Pro/Agency plan (Free = owner only)                                              | Settings, Team, Invite                                                                                                                                                                               |
| Plans                                                | No payments yet                                                                  | Change with `npx wrangler d1 execute agency-autopilot --remote --command "UPDATE agencies SET plan='pro' WHERE id='<id>'"`                                                                           |

For local dev put the same names in `.dev.vars` (see `.dev.vars.example`).

## Continuous deployment from GitHub

Repository: https://github.com/tejas076255/agency

- **GitHub Actions** (`.github/workflows/ci.yml`) runs lint, typecheck, tests and the web build on every push and pull request.
- **Cloudflare Workers Builds** is connected to the repo and deploys `main` automatically. Settings used
  (Cloudflare dashboard, Workers & Pages, agency-autopilot, Settings, Build):
  - Git repository: `tejas076255/agency`, production branch `main`
  - Build command: `npm run build` (Cloudflare installs dependencies from `package-lock.json` first; `.npmrc` keeps the Windows-made lockfile valid on Linux)
  - Deploy command: `npx wrangler deploy`
  - Root directory: `/`
- Secrets are **not** in the repo. They stay as Worker secrets (`npx wrangler secret put ...`) and keep working
  across Git deployments.
- Database migrations are not run automatically. After pushing a new file in `migrations/`, run
  `npm run db:migrate:remote` once (before or right after the deploy).
