# Project Status

_Last updated: 21 November 2026_

**Live:** https://agency-autopilot.invoice-to-excel.workers.dev ·
**Current phase:** Phase 1 (code complete, waiting for owner's end-to-end test with real Google accounts) ·
**Phase 2 / 3 / 4:** not started (need explicit approval).

## Phase 1 milestones

| Milestone                      | Status                                                 | Notes                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1A Foundation & auth           | ✅ Done                                                | Google OIDC + PKCE/state/nonce, Turnstile, KV sessions with 24 h rotation + 7 d expiry, logout + logout-all, CSRF, rate limit, audit logs, key-versioned token encryption, secret-safe logging    |
| 1B Agency & client management  | ✅ Done                                                | Onboarding, branding, logo (D1), clients CRUD (React Hook Form + Zod), confirm dialogs, skeletons                                                                                                 |
| 1C Google OAuth, GSC, GA4      | ✅ Code done · ⚠ not tested with a real Google account | Connect flow, site/property picker, GSC (28 d vs 28 d, top queries/pages, quick wins, dropping pages), GA4 (sessions, users, new users, organic, engagement, key events, channels, landing pages) |
| 1D PageSpeed & health score    | ✅ Done (PageSpeed verified live)                      | Lab vs field data, CWV assessment, score v2 (35/30/25/10) with tests                                                                                                                              |
| 1E AI insights & dashboard     | ✅ Done (Workers AI verified live)                     | Exactly 5 actions with description/why/impact/supporting metrics, grounding + no-guarantee checks, retry, deterministic fallback; Overview, Clients, client detail with charts                    |
| 1F Slides, PDF, Gmail          | ✅ Code done · ⚠ not tested live                       | Template → copy → placeholders/branding/charts → PDF (KV) → share link → Gmail; preview, Slides editing + re-export, manual/auto send, email settings, report history                             |
| 1G Cron, queues, tests, deploy | ✅ Done                                                | Idempotent cron (dedupe keys), per-client messages, retries/backoff, DLQ consumer, concurrency limit, job logs + Run now, API usage tracking, 112 tests, deployed                                 |

## Definition of done – checklist

| #     | Item                                                                                   | Status                                                               |
| ----- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1     | Sign in with Google                                                                    | ✅ Built; owner signed in on production                              |
| 2     | Create agency                                                                          | ✅                                                                   |
| 3     | Configure branding                                                                     | ✅                                                                   |
| 4     | Add clients                                                                            | ✅ (verified locally)                                                |
| 5     | Connect Google accounts                                                                | ⚠ Built, owner test pending                                          |
| 6-7   | Select GSC / GA4 properties                                                            | ⚠ Built, owner test pending                                          |
| 8     | Run health checks                                                                      | ✅ Verified locally with real PageSpeed + Workers AI                 |
| 9-10  | View analytics / PageSpeed data                                                        | ✅ (PageSpeed live; GSC/GA4 pending real account)                    |
| 11    | Health scores                                                                          | ✅                                                                   |
| 12-13 | AI insights, exactly five actions                                                      | ✅ Verified with real Workers AI                                     |
| 14    | Mark actions complete                                                                  | ✅                                                                   |
| 15    | Branded PDF reports                                                                    | ⚠ Built, owner test pending                                          |
| 16    | **Store PDFs in R2**                                                                   | ❌ **Deviation by owner's decision**: PDFs stored in KV, logos in D1 |
| 17    | Email reports via Gmail                                                                | ⚠ Built, owner test pending                                          |
| 18    | Read-only share links                                                                  | ✅ Built (needs a generated report to try)                           |
| 19    | Automated jobs                                                                         | ✅ Cron + Queues deployed                                            |
| 20    | Job logs                                                                               | ✅                                                                   |
| –     | `npm run dev`, `npm test`, typecheck, lint, tenant isolation, fresh migrations, deploy | ✅                                                                   |

## Known limitations

- Not production-ready yet: Google OAuth app in **Testing** mode (refresh tokens expire after 7 days,
  only test users), sensitive scopes not verified, Turnstile using test keys.
- **Workers Free plan 10 ms CPU limit** may break report generation in production → Workers Paid recommended.
- KV free plan 1,000 writes/day.
- Report images (logo, charts) only work in production (Google must fetch them from a public URL).
- Same OAuth client is used for dev and prod; separate clients recommended.
- Secrets (OAuth client secret, PageSpeed key) were pasted in chat during setup → rotate before launch.
- Members/invites are Phase 2; today every user is the owner of their own agency.

## Manual steps pending (owner)

1. Test the full flow with your own Google account (connect client → pick GSC/GA4 → health check →
   connect agency Google → generate report → send).
2. OAuth consent screen → Branding: home page, `/privacy`, `/terms`, authorized domain.
3. Cloudflare: real Turnstile widget; AI Gateway named `agency-autopilot`; check Workers plan.
4. Optional: `npx wrangler secret put AUDIT_HASH_SALT` (random string) to record hashed IPs in audit logs.

## Next (after approval)

Phase 2A — Business Profile account management (requires Google Business Profile API access approval first).
