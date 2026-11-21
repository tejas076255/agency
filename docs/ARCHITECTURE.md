# Architecture

One Cloudflare Worker serves the API, background jobs and the React app (Workers Static Assets).

```
Browser (React SPA)  ──►  Worker (Hono)  ──►  D1 (SQLite via Drizzle)
        ▲                     │   │
        │ static assets       │   ├──►  KV  (sessions, OAuth state, rate limits, token cache, report PDFs, chart data)
        └─────────────────────┘   ├──►  Workers AI (via AI Gateway)
                                  ├──►  Google APIs (OAuth, Search Console, GA4, PageSpeed, Slides, Drive, Gmail)
Cron Triggers ──► scheduled() ──► Queue "agency-jobs" ──► queue() consumer ──► (same services)
                                        └─ after 3 crashes ─► "agency-jobs-dlq" ──► marked failed
```

## Code layout (refined from the spec's suggested structure)

The spec suggests `apps/web`, `worker/`, `packages/shared`. The project keeps a flatter layout that already
works and deploys; the same separation exists at folder level:

| Spec area                                   | Here                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `worker/src/routes`                         | `src/routes/` (auth, agency, me, clients, reports+jobs+workspace, public)                                 |
| `worker/src/middleware`                     | `src/middleware/auth.ts` (session, roles, CSRF, usage tracking)                                           |
| `services/google/*`                         | `src/google/` (http, tokens, gsc, ga4, pagespeed, workspace)                                              |
| `services/ai`                               | `src/lib/ai.ts` (only place that calls a model) + `src/lib/insights.ts` (compact input, fallback)         |
| `services/reports`, `jobs`, `queue`, `cron` | `src/jobs/` (report, health-check, queue: cron fan-out + consumer + DLQ)                                  |
| `lib`                                       | `src/lib/` (crypto, session, audit, log, usage, score, dates, png-chart, rate-limit, turnstile, validate) |
| `apps/web`                                  | `web/` (pages, components, lib)                                                                           |
| `migrations`                                | `migrations/` (drizzle-kit generated, wrangler applied)                                                   |
| `tests`                                     | `test/`                                                                                                   |

## Request flow

`secureHeaders` → public routes (`/api/health`, `/r/:token`, `/api/public/*`) →
`loadSession` (session, version check, 24 h rotation) → `csrfProtect` → `trackApiUsage` → route
(`requireAuth` / `requireAgency` / `requireOwner`) → Zod validation → tenant-scoped Drizzle queries.

## Background jobs

1. Cron (`30 0 * * 1` Monday 06:00 IST, `30 0 1 * *` 1st 06:00 IST) selects clients and calls `enqueueJobs`.
2. Each job gets a `job_runs` row with a **dedupe key** (`health_check:<client>:<ISO week>`,
   `monthly_report:<client>:<YYYY-MM>`), unique in D1 → a cron firing twice can't double-queue.
3. One queue message per client (`max_concurrency: 5`). The consumer skips messages whose job already
   finished (at-least-once delivery), runs the job inside `withUsageTracking`, and records status.
4. Health checks: transient Google errors → retry with backoff (1, 2, 4 min, max 3 attempts).
   Reports are never auto-retried (to avoid double emails).
5. Crashes beyond `max_retries` go to the DLQ, whose consumer marks the job failed.

## Health check pipeline

GSC, GA4 and PageSpeed run in parallel (`Promise.allSettled`), each failure is isolated (partial result).
→ score v2 (`docs/HEALTH_SCORE.md`) → compact summary → AI (validate, grounding check, 1 retry) → or
deterministic fallback → `insights` + `action_items`.

## Monthly report pipeline

Ensure template in agency Drive (created by the app) → copy → recolor headers → replace text/image
placeholders (logo + PNG charts rendered by the Worker) → export PDF → KV → share token → optional Gmail
send (subject/message/CC/Hinglish from `report_settings`). Agencies can edit the copy in Google Slides and
**Re-export PDF** before sending.

## Data model (D1)

agencies, users (session_version), files (logos), clients, google_connections (encrypted tokens),
health_checks (formula_version), insights, action_items (description, supporting metrics), reports
(data snapshot, PDF KV key, share token), job_runs (dedupe_key), audit_logs, report_settings, api_usage.
OAuth transactions are stored in KV (10-minute TTL, single use) instead of a D1 table.

## Limits to know

- **Workers Free plan: 10 ms CPU per invocation.** Report generation (PDF base64 for email, PNG charts) may
  exceed it → Workers Paid ($5/month) recommended before real use.
- **KV free plan: 1,000 writes/day** (sessions, rate limits, token cache, PDFs).
- Workers AI free: 10,000 neurons/day.
