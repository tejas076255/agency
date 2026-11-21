# API Integrations

"Enabled" in Google Cloud ≠ "approved" ≠ "authorized by the user". Each integration below lists all three.
Approval/scope facts are based on Google documentation as of 2026; re-check the official docs before
building each Phase 2/3 integration.

## Readiness matrix

| #   | API                                  | Feature                   | Enabled (Cloud project)                              | Auth                                    | Approval needed                                           | Status in app                                                                             |
| --- | ------------------------------------ | ------------------------- | ---------------------------------------------------- | --------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Business Profile Performance API     | Calls, directions, clicks | Unknown – verify                                     | OAuth `business.manage` (sensitive)     | **Yes** – GBP API access request (quota 0 until approved) | **Built**, mock-tested; not live-verified                                                 |
| 2   | Google My Business API (v4)          | Reviews, replies, posts   | Unknown – verify                                     | OAuth `business.manage`                 | **Yes** (same approval)                                   | **Built**, mock-tested; blocked until access is approved. Q&A API discontinued (not used) |
| 3   | My Business Account Management API   | Accounts, locations       | Unknown – verify                                     | OAuth `business.manage`                 | **Yes**                                                   | **Built**, mock-tested; not live-verified                                                 |
| 4   | My Business Business Information API | NAP, categories, hours    | Unknown – verify                                     | OAuth `business.manage`                 | **Yes**                                                   | **Built**, mock-tested; not live-verified                                                 |
| 5   | Google Analytics Admin API           | GA4 property picker       | User reported enabled (21 Nov 2026)                  | OAuth `analytics.readonly` (sensitive)  | No                                                        | **Built**, not yet tested with a real account                                             |
| –   | Google Analytics Data API            | GA4 metrics               | User reported enabled (21 Nov 2026) – please confirm | OAuth `analytics.readonly`              | No                                                        | **Built**, not yet tested with a real account                                             |
| 6   | Search Console API                   | Clicks, queries, pages    | User reported enabled                                | OAuth `webmasters.readonly` (sensitive) | No                                                        | **Built**, not yet tested with a real account                                             |
| 7   | PageSpeed Insights API               | Speed, CWV                | ✅ Verified by a live call                           | API key (restricted)                    | No                                                        | **Built and verified**                                                                    |
| 8   | Google Drive API                     | Template copy, PDF export | User reported enabled                                | OAuth `drive.file` (non-sensitive)      | No                                                        | **Built**, not yet tested live                                                            |
| 9   | Google Sheets API                    | Data exports              | Unknown – verify                                     | OAuth `drive.file` (app-created files)  | No                                                        | **Built**, mock-tested; not live-verified                                                 |
| 10  | Google Slides API                    | Report deck               | User reported enabled                                | OAuth `presentations` (sensitive)       | No                                                        | **Built**, not yet tested live                                                            |
| 11  | Gmail API                            | Send report               | User reported enabled                                | OAuth `gmail.send` (sensitive)          | No                                                        | **Built**, not yet tested live                                                            |
| 12  | Google Ads API                       | Ads reporting             | Unknown – verify                                     | OAuth `adwords` + developer token       | **Yes** – Basic Access application for real accounts      | **Built**, mock-tested; not live-verified                                                 |
| 13  | Places API (New)                     | Competitors               | Unknown – verify                                     | API key (server-side)                   | No, but **billing required**                              | **Built**, mock-tested; not live-verified                                                 |
| 14  | YouTube Analytics API                | Channel analytics         | Unknown – verify                                     | OAuth `yt-analytics.readonly`           | No (OAuth verification)                                   | **Built**, mock-tested; not live-verified                                                 |
| –   | YouTube Data API v3                  | Channel/video metadata    | **Needs enabling**                                   | API key / OAuth `youtube.readonly`      | Default 10,000 units/day; audit for more                  | **Built**, mock-tested; not live-verified                                                 |
| 15  | Cloud Natural Language API           | Review sentiment          | Unknown – verify                                     | Restricted API key or service account   | No, but **billing required**                              | **Built**, mock-tested; not live-verified                                                 |
| 16  | Google Cloud APIs                    | Infrastructure            | –                                                    | –                                       | –                                                         | No integration needed                                                                     |

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

## Phase 2 / 3 integrations (built, mock-tested, not live-verified)

| Integration      | Code                     | Calls                                                                                                                                                    | Auth / config                                                                                                                                    | Cost & quota notes                                                                                                                                                          |
| ---------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Business Profile | `src/google/business.ts` | Account Mgmt `accounts.list`, Business Info `locations.list/get` (readMask), Performance `fetchMultiDailyMetricsTimeSeries`, v4 `reviews.list` + `reply` | Client connection `client_business`, scope `business.manage`                                                                                     | Quota is **0 until Google approves access**; the app shows "not approved" instead of failing silently. Only 1 retry to protect the per-minute quota                         |
| Places (New)     | `src/google/places.ts`   | `places:searchText`, `places/{id}` with field masks                                                                                                      | `PLACES_API_KEY` (server-side)                                                                                                                   | Billed per request by SKU; rating + userRatingCount are needed for comparison. Max 10 tracked places per client; fetched only when the tab is opened. Only place IDs stored |
| Natural Language | `src/google/language.ts` | `documents:annotateText` (sentiment + entities)                                                                                                          | `NATURAL_LANGUAGE_API_KEY`                                                                                                                       | Billed per 1,000 characters per feature; at most 25 new reviews per sync, text capped at 5,000 chars                                                                        |
| Sheets           | `src/google/sheets.ts`   | `spreadsheets.create`, `values.batchUpdate`, `batchUpdate` (formatting)                                                                                  | Agency workspace connection, `drive.file`                                                                                                        | Manual export only                                                                                                                                                          |
| Google Ads       | `src/google/ads.ts`      | `customers:listAccessibleCustomers`, `googleAds:search` (GAQL)                                                                                           | Client connection `client_ads`, scope `adwords`; `GOOGLE_ADS_DEVELOPER_TOKEN`, optional `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `GOOGLE_ADS_API_VERSION` | Test-access tokens only read test accounts; Basic Access needed                                                                                                             |
| YouTube          | `src/google/youtube.ts`  | Data `channels.list` (mine), `videos.list`; Analytics `reports.query` (`channel==MINE`)                                                                  | Client connection `client_youtube`, scopes `youtube.readonly` + `yt-analytics.readonly`                                                          | Data API default 10,000 units/day                                                                                                                                           |

Every product has its **own** Google connection and asks only for its own scopes, so a client can connect just
YouTube without granting Business Profile. Syncs run inside the weekly health check (one queue message per
client); each product fails independently and records a failed snapshot with a readable error.

### How to get access

- **Business Profile API**: request access for the Cloud project via the Business Profile API prerequisites page
  (https://developers.google.com/my-business/content/prereqs). Usually needs a verified business listing and can
  take weeks. Then enable the 4 Business Profile APIs and add `https://www.googleapis.com/auth/business.manage`
  to the consent screen.
- **Google Ads API**: create a Google Ads **manager** account, then Tools, API Center, developer token (starts as
  Test Account Access), then apply for **Basic Access**. Store with `npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN`.
- **Places / Natural Language**: link a billing account, enable the API, create an API key restricted to that one
  API, store it as a Worker secret, and set budget alerts in Cloud Billing.
- **YouTube**: enable YouTube Data API v3 and YouTube Analytics API; the scopes are sensitive (verification before launch).

### Additional sensitive scopes before public launch

`business.manage`, `adwords`, `youtube.readonly`, `yt-analytics.readonly` must be added to the consent-screen
verification request. `spreadsheets` is **not** requested (Sheets uses `drive.file`).
