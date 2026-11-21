# Project Status

_Last updated: 21 November 2026_

**Live:** https://agency-autopilot.invoice-to-excel.workers.dev

**Code:** https://github.com/tejas076255/agency (GitHub Actions CI on every push; Cloudflare Workers Builds deploys `main` automatically)

| Phase                    | Code                                       | Verified with real Google APIs                                                                                               | Blocked by                                                                                    |
| ------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1 Core automation        | ✅ Complete                                | Partly: PageSpeed + Workers AI verified live. Search Console, GA4, Slides/Drive/Gmail **not yet tested with a real account** | Owner's end-to-end test                                                                       |
| 2 Local SEO & reputation | ✅ Complete (mock-tested)                  | ❌ Not verified                                                                                                              | Business Profile API access approval; billing for Places + Natural Language                   |
| 3 Advertising & YouTube  | ✅ Complete (mock-tested)                  | ❌ Not verified                                                                                                              | Google Ads developer token (Basic Access); YouTube needs only the channel owner's sign-in     |
| 4 Billing                | 🟡 4A + 4B done (plans, limits, Plan page) | –                                                                                                                            | **4C payments not built**: needs the owner's approval of a payment provider (likely Razorpay) |

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
4. Google Ads: manager account → developer token → apply for Basic Access →
   `npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN`.
5. YouTube: enable "YouTube Data API v3" and "YouTube Analytics API"; add both YouTube scopes to the consent screen.
6. Consent screen branding (home, /privacy, /terms), real Turnstile widget, AI Gateway, Workers Paid plan check.
7. Decide the payment provider for Phase 4C.

## Known limitations

- Testing-mode OAuth: refresh tokens expire after 7 days; only test users can sign in.
- Workers Free plan: 10 ms CPU per request may break heavy jobs (reports, large syncs) → Workers Paid recommended.
- KV free plan: 1,000 writes/day.
- Google Ads API version defaults to `v21` (`GOOGLE_ADS_API_VERSION`); Google sunsets versions roughly yearly.
- Review sync reads the newest 200 reviews per run; sentiment is limited to 25 new reviews per run.
