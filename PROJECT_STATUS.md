# Project Status

_Last updated: 21 November 2026_

**Live:** https://agency-autopilot.invoice-to-excel.workers.dev
**Code:** https://github.com/tejas076255/agency (CI on GitHub Actions; Cloudflare Workers Builds deploys `main` automatically)

**Code:** https://github.com/tejas076255/agency (GitHub Actions CI on every push; Cloudflare Workers Builds deploys `main` automatically)

| Phase                    | Code                                       | Verified with real Google APIs                                                                                               | Blocked by                                                                                        |
| ------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1 Core automation        | ✅ Complete                                | Partly: PageSpeed + Workers AI verified live. Search Console, GA4, Slides/Drive/Gmail **not yet tested with a real account** | Owner's end-to-end test                                                                           |
| 2 Local SEO & reputation | ✅ Complete (mock-tested)                  | ❌ Not verified                                                                                                              | Business Profile API access approval; billing for Places + Natural Language                       |
| 3 Advertising & YouTube  | ✅ Complete (mock-tested)                  | ❌ Not verified                                                                                                              | Google Ads: Explorer access for the Cloud project; YouTube needs only the channel owner's sign-in |
| 4 Billing                | 🟡 4A + 4B done (plans, limits, Plan page) | –                                                                                                                            | **4C payments not built**: needs the owner's approval of a payment provider (likely Razorpay)     |

"Mock-tested" = covered by automated tests with simulated Google responses (142 tests). It has not received
real data from Google yet, so field-level surprises are possible.

## Phase 2 – what was built

| Milestone                              | Status                                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2A Business Profile account management | ✅ List accounts + locations, connect a location to a client, revoked/disconnected states                                                                |
| 2B Business information & performance  | ✅ Name, address, phone, website, categories, hours, status; impressions (maps + search), calls, directions, website clicks, conversations; 28 d vs 28 d |
| 2C Reviews                             | ✅ Sync newest 200 (original text kept), rating, date, reply status, post replies                                                                        |
| 2D Places competitor research          | ✅ Search, track up to 10 places, live comparison (ratings never stored; place IDs only)                                                                 |
| 2E Natural Language sentiment          | ✅ Per-review sentiment + entities (AI-derived, stored separately), themes, monthly trend, negative alerts; max 25 analyses per sync                     |
| 2F Sheets export                       | ✅ Manual formatted export to the agency Drive (scheduled exports: later)                                                                                |
| Team members                           | ✅ Invites (hashed tokens, email must match), assigned clients, member removal                                                                           |

## Phase 3 – what was built

| Milestone                       | Status                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 3A Ads auth & account discovery | ✅ Separate OAuth (adwords scope), accessible customers, manager accounts filtered                                             |
| 3B Campaign reporting           | ✅ Spend, clicks, impressions, conversions, value, CTR, CPC, daily trend, budget utilisation                                   |
| 3C Search terms & ROI           | ✅ Wasted (non-converting) search terms, wasted spend, ROAS only when values are tracked                                       |
| 3D YouTube Data                 | ✅ Channel discovery, channel stats, video titles                                                                              |
| 3E YouTube Analytics            | ✅ Views, watch time, avg view duration, subscribers gained/lost, daily trend, top videos                                      |
| 3F Combined dashboard           | ✅ Agency pages (Local SEO, Advertising, YouTube) + client tabs; AI action items and fallback rules use all connected channels |

## Extra features (after Phase 3)

| Feature                | Status                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyword rank tracker   | ✅ Agency tracks keywords per client (plan limit 10 / 25 / 50). 13 weeks of weekly Search Console positions load on add; refreshed by every weekly health check and "Check now". Suggestions from top + quick-win queries. Code: `src/jobs/keywords.ts`, `src/routes/keywords.ts`, `web/src/pages/ClientKeywords.tsx`. Mock-tested |
| AI review reply drafts | ✅ "Draft reply with AI" on each review (English / Hinglish / Hindi, friendly / professional). Validated (no placeholders, promises or refunds), retry once, rule-based fallback. Draft is only shown for editing, never auto-posted or stored. Code: `draftReviewReply` in `src/lib/ai.ts`. Mock-tested                           |

## AI features

All on-demand AI calls count towards a daily plan limit (Free 30 / Pro 300 / Agency 1500, KV
counter, HTTP 402 when reached). Every tool validates the model output (Zod + rules) and retries
once; tools with a sensible template fall back to it, the others return 503 instead of fake output.
Mock-tested (`test/ai-features.test.ts`); not yet tried against live client data.

| Feature                | What it does                                                                                                                                                                                                                                                                         | Code                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| AI SEO assistant       | Chat per client (client page → AI tools) answering from the latest health check, keywords, reviews, ads and alerts. Not stored                                                                                                                                                       | `assistantReply`, `src/jobs/client-context.ts`         |
| AI content writer      | SEO titles + meta descriptions, blog outline + FAQ, full blog post, Google Business Profile posts (English / Hinglish / Hindi)                                                                                                                                                       | `generateContent`                                      |
| AI Google Ads copy     | 15 headlines (≤30 chars) + 4 descriptions (≤90), enforced in code; negative keywords from wasted search terms                                                                                                                                                                        | `generateAdCopy`, `enforceAdLimits`                    |
| Smart alerts           | After each health check: clicks / impressions / visits / leads drops, score and speed drops, keywords falling (off page 1), negative reviews, Ads overspend. Deduped for 14 days, AI explanation (rule-based fallback), Dashboard + client tab, email to owners via the agency Gmail | `src/jobs/alerts.ts`                                   |
| AI competitor analysis | Live Places reviews (≤5 per place, never stored) → strengths, weaknesses and opportunities                                                                                                                                                                                           | `analyzeCompetitors`, `getPlaceReviews`                |
| Prospect audits        | Any public website → measured checks (PageSpeed, title/meta/H1, viewport, schema, alt text, sitemap, robots) → AI write-up + score, branded page with "Download PDF" (browser print). SSRF-safe fetch: public domains only, every redirect re-checked, size/time limits              | `src/lib/site-audit.ts`, `web/src/pages/Prospects.tsx` |
| AI review auto-reply   | Opt-in per client (owner only): 5-star or 4-5-star reviews from the last 30 days, max 5 per sync, audit-logged, marked "auto-replied by AI". Negative reviews are never auto-replied                                                                                                 | `autoReplyReviews`                                     |

### Business Profile editing (AI suggest → approve → apply)

Client page → **Google profile** tab (`src/jobs/gbp-edit.ts`, `src/google/business-edit.ts`,
`web/src/pages/ClientGbpEditor.tsx`). Mock-tested (`test/gbp-edit.test.ts`); not yet tried on a
live, verified listing.

- AI suggests a description (≤750 chars, no links/phones), extra categories (looked up in Google's
  category list, never the primary), services (free-form, under the primary category) and yes/no
  attributes (only ones Google offers for the listing). Opening hours are entered manually.
- Every suggestion is a draft with before/after; anyone can edit drafts, **only the owner applies**.
- Apply = `PATCH …?validateOnly=true` first, then the real PATCH (no automatic retries); status is
  "Live on Google", "Google is reviewing" (`metadata.hasPendingEdits`) or "Failed" with Google's
  error. Applied changes can be **undone** (the saved "before" is applied as a new audited change).
- Name, address and phone are never edited from the app.
- **Google Posts**: AI drafts (no phone numbers, button links must be https), edit, publish now or
  schedule; hourly cron `15 * * * *` publishes due posts (claimed atomically so nothing is posted
  twice); published posts can be deleted from Google.
- Needs a verified location (owner control) and Business Profile API access; unverified listings
  show a warning.

### Grow: one-click setup, Business Profile score, one-click Post

Client page → **🚀 Grow** tab (new clients open here). Mock-tested (`test/growth.test.ts`); not yet
tried with a live, verified listing.

1. **Connect**: one Google sign-in for Search Console, GA4, Business Profile and YouTube (Ads stays
   separate). Each product gets its own connection row with the same grant.
2. **Auto-detect** (`src/lib/auto-detect.ts`, `src/jobs/setup.ts`): reads the client website (final
   URL, phone numbers, GA4 IDs incl. those inside the GTM container, opening hours schema, sitemap
   services) and picks the Search Console Domain property, the GA4 property with the website's
   measurement ID, the Business location with the same website/phone/name, and the YouTube channel.
   Clear winners are saved for empty fields; existing choices are never overridden but a better
   match is flagged ("Switch to it"); ambiguous cases ask "Which one is yours?".
3. **Scan** (queue job `profile_scan`, progress in KV): listing, website, reviews (synced from
   Google), competitors (Places, live), then the **Business Profile Score** (`src/lib/profile-score.ts`,
   100 points: basics 30, content 25, reviews 30, consistency 15) with Missing / Improve / Done.
4. **Fixes ready**: AI description/categories/services/attributes, website link and opening hours
   copied from the website, 2 Google post drafts if nothing was posted in 7 days, and reply drafts
   for up to 5 unanswered reviews. Nothing is posted automatically.
5. **Post / Post all** (owner only): profile changes are validated then applied, replies posted,
   first post published and the rest scheduled every 3 days at 10:00 IST; then a quick re-scan
   shows the score before → after. Things only the owner or Google can do (verification, photos,
   reviews, phone mismatch) are listed as a to-do.
6. **Weekly autopilot**: the Monday cron also queues a profile scan for every client with a
   Business Profile; owners get a "N improvements ready" email (agency Gmail). The client list shows
   the profile score and ready fixes.

Not built: **WhatsApp bot** (needs a Meta WhatsApp Business account and approved message templates).
The monthly report already had an AI summary (English + Hinglish) before this.

## Phase 4

- ✅ 4A Subscription architecture: `agencies.plan` (free / pro / agency)
- ✅ 4B Plans & usage limits: clients, team members, manual runs per day (HTTP 402 when exceeded), Plan page
- ❌ 4C Payment integration: **not started** (approval required). Until then the operator changes plans with:
  `npx wrangler d1 execute agency-autopilot --remote --command "UPDATE agencies SET plan='pro' WHERE id='<agency id>'"`

## Deviations from the spec (documented)

- **No R2** (owner's decision): logos in D1, PDFs in KV.
- Spec tables `business_profile_metrics`, `ad_campaigns`, `ad_metrics`, `youtube_channels`, `youtube_metrics`
  are folded into `integration_snapshots` (one JSON summary per sync). `competitor_snapshots` is not created
  because storing Places content is not allowed by the Places terms.
- `oauth_transactions` live in KV (10-minute TTL, single use).
- Folder structure kept flat (see docs/ARCHITECTURE.md).
- Spec navigation "SEO", "Reviews", "Competitors" are combined into **Local SEO** and the client page tabs.

## Owner action items

1. Phase 1 end-to-end test with your Google account (connect client, GSC/GA4, report, Gmail).
2. Business Profile: apply for API access (see docs/API_INTEGRATIONS.md); add `business.manage` to the consent screen.
3. Places + Natural Language: enable billing, create two restricted API keys, then
   `npx wrangler secret put PLACES_API_KEY` and `npx wrangler secret put NATURAL_LANGUAGE_API_KEY`.
4. Google Ads: enable "Google Ads API" in Cloud project 91010309450, then apply for **Explorer** access
   (Cloud Console > Google Ads API > Overview). Developer tokens are no longer used (sunset Sep 2026).
5. YouTube: enable "YouTube Data API v3" and "YouTube Analytics API"; add both YouTube scopes to the consent screen.
6. Consent screen branding (home, /privacy, /terms), real Turnstile widget, AI Gateway, Workers Paid plan check.
7. Decide the payment provider for Phase 4C.

## Known limitations

- Testing-mode OAuth: refresh tokens expire after 7 days; only test users can sign in.
- Workers Free plan: 10 ms CPU per request may break heavy jobs (reports, large syncs) → Workers Paid recommended.
- KV free plan: 1,000 writes/day.
- Google Ads API version defaults to `v26` (`GOOGLE_ADS_API_VERSION`); Google sunsets versions roughly yearly.
- Review sync reads the newest 200 reviews per run; sentiment is limited to 25 new reviews per run.
