# Health Score (formula v2)

A deterministic 0-100 score per client, computed after every health check.
Source of truth: [`src/lib/score.ts`](../src/lib/score.ts). Tests: [`test/score.test.ts`](../test/score.test.ts).

## Weights

| Category                            | Weight | Parts (part max)                          | Scale                                                                        |
| ----------------------------------- | -----: | ----------------------------------------- | ---------------------------------------------------------------------------- |
| Search performance (Search Console) |     35 | Clicks trend (15)                         | −50% or worse → 0 · no change → half · +50% or better → full (linear)        |
|                                     |        | Impressions trend (5)                     | same trend scale                                                             |
|                                     |        | Average position (10)                     | ≤ 3 → full · ≥ 30 → 0 (linear)                                               |
|                                     |        | CTR (5)                                   | ≥ 5% → full · 0% → 0 (linear)                                                |
| Organic traffic (GA4)               |     30 | Organic Search sessions trend (15)        | trend scale; falls back to all sessions if the organic report is unavailable |
|                                     |        | Engagement rate (10)                      | ≥ 60% → full · 0% → 0                                                        |
|                                     |        | Key events trend (5)                      | trend scale                                                                  |
| Website performance (PageSpeed)     |     25 | Mobile Lighthouse score (15)              | score / 100                                                                  |
|                                     |        | Desktop Lighthouse score (5)              | score / 100                                                                  |
|                                     |        | Core Web Vitals, real-user field data (5) | passed → full · failed → 0                                                   |
| Data completeness                   |     10 | Sources that returned data / 3            | GSC, GA4, PageSpeed                                                          |

"Trend" always compares the **last 28 complete days** with the **previous 28 days**
(Search Console ends 3 days ago because its data lags; GA4 ends yesterday).

## Normalization rules

1. **Category points** = `weight × (earned / max of the parts that have valid data)`.
   A category keeps its full weight even if some parts are missing.
2. **Invalid values** (NaN, Infinity, missing) → that part is left out.
3. **Out-of-range values** are clamped (e.g. position −5 → treated as best, Lighthouse 150 → 100).
4. **Trend not computable** (previous period was 0) → counts as "no change" (half points).
5. **Missing category** (source not connected, failed, or zero data) → left out of the total.
6. **Total** = `sum(category points) / sum(weights of included categories) × 100`, rounded.
7. **Data completeness is always included**, so missing sources lower the score slightly
   instead of hiding the problem.
8. If **none** of search / traffic / performance has data, the score is `null` ("—" in the UI).
9. Category points are rounded to 1 decimal; the total to an integer.

## Worked examples (all are unit tests)

**Mixed site** → **49**

- Search: clicks 0% → 7.5 · impressions −25% → 1.25 · position 16.5 → 5 · CTR 2.5% → 2.5 = 16.25/35 → **16.3**
- Traffic: organic −25% → 3.75 · engagement 30% → 5 · key events 0% → 2.5 = 11.25/30 → **11.3**
- Performance: mobile 50 → 7.5 · desktop 80 → 4 · CWV failed → 0 = 11.5/25 → **11.5**
- Completeness: 3/3 → **10**
- Total: (16.3 + 11.3 + 11.5 + 10) / 100 → **49**

**Only PageSpeed connected** (mobile 80, desktop 80, no field data) → **67**

- Performance: (12 + 4) / 20 × 25 = **20** · Completeness: 1/3 × 10 = **3.3**
- Total: 23.3 / 35 → **67**

**Worst possible site, all sources connected** → **10** (completeness only).

## Versioning

Each health check stores `formula_version`. Version 1 (40 SEO / 30 traffic / 30 speed) was used before
21 Nov 2026; those scores are kept as they were and are not directly comparable to v2 scores.
The UI shows "formula v1/v2" next to the score.
