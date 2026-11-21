# API Integrations

"Enabled" in Google Cloud ≠ "approved" ≠ "authorized by the user". Each integration below lists all three.
Approval/scope facts are based on Google documentation as of 2026; re-check the official docs before
building each Phase 2/3 integration.

## Readiness matrix

| #   | API                                  | Feature                   | Enabled (Cloud project)                              | Auth                                    | Approval needed                                           | Status in app                                                        |
| --- | ------------------------------------ | ------------------------- | ---------------------------------------------------- | --------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | Business Profile Performance API     | Calls, directions, clicks | Unknown – verify                                     | OAuth `business.manage` (sensitive)     | **Yes** – GBP API access request (quota 0 until approved) | Phase 2, not built                                                   |
| 2   | Google My Business API (v4)          | Reviews, replies, posts   | Unknown – verify                                     | OAuth `business.manage`                 | **Yes** (same approval)                                   | Phase 2, not built. Many v4 endpoints migrated; Q&A API discontinued |
| 3   | My Business Account Management API   | Accounts, locations       | Unknown – verify                                     | OAuth `business.manage`                 | **Yes**                                                   | Phase 2, not built                                                   |
| 4   | My Business Business Information API | NAP, categories, hours    | Unknown – verify                                     | OAuth `business.manage`                 | **Yes**                                                   | Phase 2, not built                                                   |
| 5   | Google Analytics Admin API           | GA4 property picker       | User reported enabled (21 Nov 2026)                  | OAuth `analytics.readonly` (sensitive)  | No                                                        | **Built**, not yet tested with a real account                        |
| –   | Google Analytics Data API            | GA4 metrics               | User reported enabled (21 Nov 2026) – please confirm | OAuth `analytics.readonly`              | No                                                        | **Built**, not yet tested with a real account                        |
| 6   | Search Console API                   | Clicks, queries, pages    | User reported enabled                                | OAuth `webmasters.readonly` (sensitive) | No                                                        | **Built**, not yet tested with a real account                        |
| 7   | PageSpeed Insights API               | Speed, CWV                | ✅ Verified by a live call                           | API key (restricted)                    | No                                                        | **Built and verified**                                               |
| 8   | Google Drive API                     | Template copy, PDF export | User reported enabled                                | OAuth `drive.file` (non-sensitive)      | No                                                        | **Built**, not yet tested live                                       |
| 9   | Google Sheets API                    | Data exports              | Unknown – verify                                     | OAuth `drive.file` (app-created files)  | No                                                        | Phase 2, not built                                                   |
| 10  | Google Slides API                    | Report deck               | User reported enabled                                | OAuth `presentations` (sensitive)       | No                                                        | **Built**, not yet tested live                                       |
| 11  | Gmail API                            | Send report               | User reported enabled                                | OAuth `gmail.send` (sensitive)          | No                                                        | **Built**, not yet tested live                                       |
| 12  | Google Ads API                       | Ads reporting             | Unknown – verify                                     | OAuth `adwords` + developer token       | **Yes** – Basic Access application for real accounts      | Phase 3, not built                                                   |
| 13  | Places API (New)                     | Competitors               | Unknown – verify                                     | API key (server-side)                   | No, but **billing required**                              | Phase 2, not built                                                   |
| 14  | YouTube Analytics API                | Channel analytics         | Unknown – verify                                     | OAuth `yt-analytics.readonly`           | No (OAuth verification)                                   | Phase 3, not built                                                   |
| –   | YouTube Data API v3                  | Channel/video metadata    | **Needs enabling**                                   | API key / OAuth `youtube.readonly`      | Default 10,000 units/day; audit for more                  | Phase 3, not built                                                   |
| 15  | Cloud Natural Language API           | Review sentiment          | Unknown – verify                                     | Restricted API key or service account   | No, but **billing required**                              | Phase 2, not built                                                   |
| 16  | Google Cloud APIs                    | Infrastructure            | –                                                    | –                                       | –                                                         | No integration needed                                                |

## Phase 1 integrations (built)

| Integration            | Code                                            | Endpoints                                                                            | Quota notes                                            |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Sign-in (OIDC)         | `src/lib/google-oauth.ts`, `src/routes/auth.ts` | accounts.google.com, oauth2.googleapis.com/token                                     | –                                                      |
| Search Console         | `src/google/gsc.ts`                             | `sites.list`, `searchAnalytics.query` (6 calls/check)                                | Per-site and per-project QPS limits; backoff on 429    |
| GA4                    | `src/google/ga4.ts`                             | Admin `accountSummaries`, Data `runReport` (5 calls/check)                           | GA4 property token quotas; backoff on 429              |
| PageSpeed              | `src/google/pagespeed.ts`                       | `runPagespeed` mobile + desktop                                                      | 25,000/day default per key; each call can take 10-60 s |
| Slides / Drive / Gmail | `src/google/workspace.ts`                       | `presentations.create/batchUpdate`, `files.copy/export/get`, Gmail media upload send | Drive export limit 10 MB; Gmail send ≤ 35 MB           |
| Workers AI             | `src/lib/ai.ts` (`runModel`)                    | via AI Gateway `agency-autopilot` (falls back to direct)                             | Free 10k neurons/day                                   |

All Google calls go through `googleRequest()` (`src/google/http.ts`): exponential backoff + jitter on
429/5xx (respects `Retry-After`), timeouts, readable errors, and **usage counting** per agency per day
(`api_usage` table, shown on the Job logs page with quota-error warnings).

## OAuth flows and scopes

| Flow             | Who                           | Scopes                                                |
| ---------------- | ----------------------------- | ----------------------------------------------------- |
| Agency login     | agency user                   | `openid email profile`                                |
| Client data      | client's Google account       | `openid email webmasters.readonly analytics.readonly` |
| Agency reporting | agency owner's Google account | `openid email drive.file presentations gmail.send`    |

`drive.file` only allows access to files the app created (the report template and copies).

## Verification before public launch

- Sensitive scopes: `webmasters.readonly`, `analytics.readonly`, `presentations`, `gmail.send` →
  OAuth consent screen verification (privacy policy at `/privacy`, terms at `/terms`, homepage, demo video,
  scope justification).
- `gmail.send` is sensitive, not restricted → no CASA security assessment.
- Authorized domain must be verified in Search Console; a custom domain is recommended instead of
  `*.workers.dev`.
- While in Testing mode, only listed test users can sign in and refresh tokens expire after 7 days.

## Storage deviation from spec

The spec lists **R2** for logos and PDFs. By the owner's decision R2 is **not used**:
logos are stored in D1 (`files` table, ≤ 512 KB), report PDFs in KV (≤ 25 MiB per value).
