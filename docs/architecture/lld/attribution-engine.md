# LLD — Attribution engine

> Names are defined in [HLD §8](../HLD.md#8-cross-cutting-concepts); model rules come from [SPEC §9](../../SPEC.md#9-attribution-engine-packagesattribution). Journey visitors come from [identity-stitching.md](identity-stitching.md).

## 1. Purpose & scope

Two parts:
1. **`packages/attribution`** — pure, deterministic functions with no I/O. They implement the six rule-based models of SPEC §9.
2. **`attribution-run` worker** (`apps/workers`). It:
   - loads journeys and runs all six models per order;
   - writes versioned credit sets to `attribution_results` (`computed_at` = run version);
   - cleans up superseded versions;
   - enqueues the `Purchase` CAPI job after an incremental run;
   - computes `store_delivery_rates` nightly.

It also defines the **read contract** used by [reporting-api.md](reporting-api.md): the latest version per (order, model), placed vs. delivered revenue computed at query time, and the pending-revenue projection with the delivery-rate fallback chain.

**Non-goals**
- Data-driven models (Markov/Shapley) — out of scope (SPEC §2).
- Visitor resolution — `resolveJourneyVisitors` in identity-stitching.
- Channel classification — done at ingest ([event-pipeline.md §4.3](event-pipeline.md#43-channel-classification)).
- Report endpoints, caching, and response shapes — [reporting-api.md](reporting-api.md). This LLD fixes only the query semantics.
- Re-running attribution when the delivery status changes. Explicitly not done (HLD §4).

## 2. Interfaces

### 2.1 `packages/attribution` (pure)

```ts
// SPEC §9 types, plus the optional sessionId needed for "collapse consecutive identical touchpoints within the same session"
export type Touchpoint = {
  ts: number;                                  // epoch ms
  channel: string;                             // HLD §8 channel slug
  subChannel?: string;
  platform?: 'meta' | 'google' | null;
  campaignId?: string; adsetId?: string; adId?: string;
  isDirect: boolean;
  sessionId?: string;
};
export type Model = 'first_click' | 'last_click' | 'last_non_direct' | 'linear' | 'time_decay' | 'position_based';
export const MODELS: readonly Model[] = ['first_click', 'last_click', 'last_non_direct', 'linear', 'time_decay', 'position_based'];

export type Credit = {
  rank: number;                                // 1-based position in the filtered, collapsed journey; 0 = Unattributed
  touchpoint: Touchpoint | null;               // null ⇒ Unattributed
  credit: number;                              // ≥ 0; the credits for one call sum to 1 ± 1e-9
};

export function attribute(tps: Touchpoint[], orderTs: number, model: Model,
                          opts: { lookbackDays: number; halfLifeDays?: number }): Credit[];
```

### 2.2 Queue job
`AttributionRunJob{storeId, mode:'incremental'|'nightly', orderIds?}` on queue `attribution-run` (HLD §8).

| mode | `orderIds` | Enqueued by | `jobId` |
|---|---|---|---|
| `incremental` | required, 1–500 | identity-stitch; withdrawal erasure and correction DSRs (privacy-dpdp §4.5/§4.6); attribution-settings change (as `nightly`, see §4.5) | `attr:<orderId>` for one order; `attr:<storeId>:<sha1(ids)>` for a set |
| `nightly` | omitted (all orders placed in the last 45 days) | scheduler, 02:30 IST, one per active store under `SystemScope` | `attr-nightly:<storeId>:<yyyymmdd>` |

```ts
export const AttributionRunJobSchema = z.object({
  storeId: z.string().uuid(),
  mode: z.enum(['incremental', 'nightly']),
  orderIds: z.array(z.string().uuid()).min(1).max(500).optional(),
}).strict().refine(j => j.mode === 'nightly' || !!j.orderIds);
```

### 2.3 Read contract (consumed by reporting-api)

```ts
export type RevenueBasis = 'placed' | 'delivered';

export type PendingProjection = {
  value_paise: number;                          // projected delivered revenue from pending/in_transit orders
  fallback_level: 'store_payment_method' | 'store' | 'platform_default';   // worst level used
  low_confidence: boolean;                      // true if any pending order's rate came from level 2 or 3
};
```

## 3. Data owned

| Item | Access | Notes |
|---|---|---|
| ClickHouse `attribution_results` | **owns**; insert, lightweight delete of superseded versions, read | `MergeTree ORDER BY (store_id, order_id, model, computed_at, touchpoint_rank)` (SPEC v0.2) |
| Postgres `store_delivery_rates` | **owns**; replace nightly | SPEC v0.2 |
| ClickHouse `touchpoints` | read `FINAL` | |
| ClickHouse `order_status` | read (the query-time join) | SPEC v0.3, including `refunded_amount_paise` and the reporting columns |
| Postgres `orders` | read `id`, `created_at_platform`, `total_amount_paise`, `payment_method`, `delivery_status`, `landing_site`, `referring_site`, `note_attributes`, `attribution_confidence`, hashes via `resolveJourneyVisitors` | |
| Postgres `attribution_settings` | read `default_model`, `lookback_days` (default 30), `revenue_basis` | SPEC |
| BullMQ `capi-dispatch` | enqueue `Purchase` | |

**Column semantics for `attribution_results`** (SPEC v0.3 — `revenue_basis` and `credited_revenue_paise` dropped)
- `touchpoint_rank`: `Credit.rank`.
- `channel`/`platform`/`campaign_id`/`adset_id`/`ad_id`: copied from the touchpoint; `channel='unattributed'` when there are no touchpoints (approved slug).
- `credit`, `computed_at` (run version). Revenue is never stored here; it is always computed from `order_status` (§4.4), so order edits, refunds and status changes are always current.

No additions beyond HLD §8.

## 4. Processing flow

### 4.1 The engine (`attribute`)
1. **Filter** to `orderTs − lookbackDays·86 400 000 ≤ ts ≤ orderTs`.
2. **Sort** by `ts`, with a deterministic tie-break of `(channel, platform, campaignId, adsetId, adId, sessionId)`.
3. **Collapse** consecutive touchpoints that share a `sessionId` and are identical on `(channel, subChannel, platform, campaignId, adsetId, adId, isDirect)`, keeping the first. With one touchpoint per session ([event-pipeline §4.2](event-pipeline.md#42-sessionisation-session_assign_v1-lua-atomic-per-visitor)) this is usually a no-op. It is kept because SPEC requires it and the UTM-fallback touchpoint has no session.
4. **Empty** → `[{rank: 0, touchpoint: null, credit: 1}]` (Unattributed).
5. **Weights** for n touchpoints; `wᵢ` is the credit for rank i:

   | Model | Weights |
   |---|---|
   | `first_click` | w₁ = 1 |
   | `last_click` | wₙ = 1 |
   | `last_non_direct` | 1 on the last `isDirect = false`; if all are direct, wₙ = 1 |
   | `linear` | wᵢ = 1/n |
   | `time_decay` | wᵢ = 2^(−(orderTs − tsᵢ)/(halfLifeDays·86 400 000)), halfLifeDays default 7, then normalised to sum 1 |
   | `position_based` | n = 1 → [1]; n = 2 → [0.5, 0.5]; n ≥ 3 → w₁ = 0.4, wₙ = 0.4, middle each 0.2/(n−2) |

6. **Sum guard**: after computing, set the largest weight to `1 − Σ(others)`, so the sum is exactly 1 in floating point. Assert every `w ≥ 0`.
7. No clock, randomness or I/O. `orderTs` and `opts` are the only context.

### 4.2 Incremental run
1. Parse the job. Suppression re-check per order through `SuppressionClient` on the order's hashes and journey visitors: an order whose identity is erased is skipped (it would only be Unattributed anyway).
2. `computed_at = now()` at the moment inputs are read, in ms. It is the **run version**. A later run always reads newer inputs, so the newer version is the more correct one.
3. For each order:
   - `resolveJourneyVisitors` → visitor set V (≤ 10).
   - Load `touchpoints FINAL WHERE store_id=? AND visitor_id IN V AND occurred_at BETWEEN orderTs − lookback AND orderTs`.
   - If V is empty and `attribution_confidence='low'`: build one touchpoint in memory from `orders.landing_site` / `referring_site` / `note_attributes` UTMs, classified with the event-pipeline `classify()` and the store's `channel_rules`, `ts = created_at_platform`. It is not persisted.
4. Run `attribute` for **all six models**, since model comparison needs them all. The store's `default_model` only selects what the dashboard shows first.
5. Insert every `Credit` row for every (order, model) with the shared `computed_at`. One `INSERT` per job.
6. **Do not delete** older versions here. Readers ignore them, and per-order lightweight deletes would create thousands of small mutations a day (ADR-0015). Cleanup is nightly (§4.3).
7. **Only if the store opted in** (`integrations.settings.capi.purchase_enabled = true` on the Meta integration; OFF by default, SPEC v0.3): enqueue `CapiDispatchJob{storeId, orderId, eventName:'Purchase'}` with `jobId = capi:Purchase:<orderId>`. This happens for incremental runs triggered by identity-stitch only (not DSR or settings runs). `capi-dispatch` also checks `capi_dispatch_log` for an already-sent `order_<id>`, so a re-enqueue after the job was removed doesn't resend.

### 4.3 Nightly run (02:30 IST, after retention at 01:00)
1. Select orders with `created_at_platform ≥ now − 45 days` for the store, in chunks of 500 ordered by id.
2. Per chunk:
   - `computed_at = now()`;
   - batch-load journeys: one `identity_links` query for all order hashes and one `touchpoints FINAL` query for the union of visitors, time-bounded by `min(orderTs) − lookback`;
   - run the six models;
   - one `INSERT`.

   This picks up late touchpoints, cross-device links discovered after purchase, and re-stitches (identity-stitching §4.3).
3. **Superseded-version cleanup** (once per store, after all chunks), using the ADR-0015 mechanism (lightweight `DELETE` recommended):
   ```sql
   DELETE FROM attribution_results
   WHERE store_id = {store:UUID}
     AND (order_id, model, computed_at) NOT IN (
       SELECT order_id, model, max(computed_at) FROM attribution_results
       WHERE store_id = {store:UUID} GROUP BY order_id, model)
   ```
   This never deletes a version newer than the one the nightly wrote, because `max()` is evaluated at delete time.
4. **`store_delivery_rates`** (§4.6).
5. Write `audit_log` `system_scope_used` (reason `attribution_nightly`) with order and row counts.

### 4.4 Read contract — the latest version, placed vs delivered
Every report query on `attribution_results` must restrict to the latest version per `(store_id, order_id, model)`. The canonical ClickHouse shape, through the scoped query builder:

```sql
WITH latest AS (
  SELECT order_id, model, max(computed_at) AS v
  FROM attribution_results
  WHERE store_id = {store:UUID} AND model IN {models:Array(String)}
  GROUP BY order_id, model
),
os AS (
  SELECT order_id,
         argMax(delivery_status,    source_updated_at) AS delivery_status,
         argMax(total_amount_paise, source_updated_at) AS amount_paise,
         argMax(refunded_amount_paise, source_updated_at) AS refunded_paise,
         argMax(placed_at,          source_updated_at) AS placed_at,
         argMax(payment_method,     source_updated_at) AS payment_method
  FROM order_status WHERE store_id = {store:UUID}
  GROUP BY order_id
)
SELECT ar.model, ar.channel, ar.campaign_id,
       sum(ar.credit * os.amount_paise)                                                        AS placed_revenue_paise,
       sumIf(ar.credit * greatest(os.amount_paise - os.refunded_paise, 0),
             os.delivery_status = 'delivered')                                                AS delivered_revenue_paise,
       sumIf(ar.credit * greatest(os.amount_paise - os.refunded_paise, 0),
             os.delivery_status IN ('pending','in_transit'))                                  AS pending_revenue_paise,
       sum(ar.credit)                                                            AS attributed_orders
FROM attribution_results ar
INNER JOIN latest l ON ar.order_id = l.order_id AND ar.model = l.model AND ar.computed_at = l.v
INNER JOIN os ON ar.order_id = os.order_id
WHERE ar.store_id = {store:UUID}
  AND os.placed_at >= {from:DateTime64(3,'Asia/Kolkata')} AND os.placed_at < {to:DateTime64(3,'Asia/Kolkata')}
GROUP BY ar.model, ar.channel, ar.campaign_id
```

- **Placed**: credit × the order's total. **Delivered**: only `delivery_status = 'delivered'`, net of refunds (`max(0, total − refunded)`, SPEC v0.3); RTO and cancelled contribute 0 (SPEC §9).
- Sums are Float64 over integer paise. They are rounded to integer paise once, at the response layer. Per-order display (the journey view) uses largest-remainder rounding so rows add up to the order total.
- `attributed_orders` is fractional under multi-touch models, which is intended.
- `order_status.placed_at` (SPEC v0.3) carries the IST date filter, so no order-id list is shipped from Postgres.

### 4.5 Settings changes
- `PUT attribution-settings` changing `lookback_days` → enqueue a `nightly`-mode run for the store immediately. Orders older than 45 days keep credits computed under the old lookback; the dashboard shows "lookback changed on <date>" (Open question 2).
- Changing `default_model` or `revenue_basis` affects display only; no recompute.
- `channel_rules` changes apply to touchpoints classified from then on. Historical touchpoints are not reclassified in MVP (Open question 3).

### 4.6 `store_delivery_rates` and the pending projection
**Nightly computation** (Postgres, per store):
1. Window: orders with `created_at_platform ∈ [now − 104 d, now − 14 d)`. That is 90 days (`window_days`), ending 14 days ago so most COD orders have had time to resolve; RTOs typically resolve more slowly than deliveries, and including very recent orders would bias the rate upward (the 14-day lag **needs design-partner data**).
2. Resolved = `delivery_status IN ('delivered','rto','cancelled')`. `delivery_rate = delivered / (delivered + rto + cancelled)`.
3. Rows (replaced nightly, unique on `(store_id, payment_method)` with `NULLS NOT DISTINCT`):
   - one per `payment_method ∈ {cod, prepaid, partial_cod}` with `resolved_orders` for that method;
   - one store-wide row (`payment_method NULL`).
4. **Fallback chain**, resolved per pending order at projection time, for the order's `payment_method`:
   1. the store + payment_method row if `resolved_orders ≥ 50` → `fallback_level='store_payment_method'`;
   2. else the store-wide row if `resolved_orders ≥ 50` → `'store'`;
   3. else the platform default for that payment method from `packages/shared/constants.ts` → `'platform_default'`. Proposed defaults: `cod 0.65`, `prepaid 0.97`, `partial_cod 0.80` (all three **need design-partner data**).

   Each stored row records the level it resolves to, so reports don't re-derive it.

**Projection** (reporting query, per row group):
- `value_paise = Σ over pending/in_transit orders of credit × max(0, amount_paise − refunded_paise) × rate(order.payment_method)`.
- `fallback_level` = the worst level used in the group.
- `low_confidence = true` if any contributing order used level 2 or 3.

Shown as "projected" next to delivered revenue (SPEC §9). It is never added into delivered ROAS.

```mermaid
sequenceDiagram
  participant Q as attribution-run
  participant PG as Postgres
  participant ID as identity (resolveJourneyVisitors)
  participant CH as ClickHouse
  participant E as packages/attribution
  participant C as capi-dispatch
  Q->>Q: suppression re-check; computed_at = now()
  Q->>PG: load orders (+ settings)
  Q->>ID: visitor sets
  Q->>CH: touchpoints FINAL (visitors, time-bounded)
  Q->>E: attribute() × 6 models per order
  E-->>Q: Credit[] (sum = 1)
  Q->>CH: INSERT attribution_results (shared computed_at)
  alt incremental from identity-stitch, and store opted in to Purchase (off by default)
    Q->>C: CapiDispatchJob Purchase (jobId capi:Purchase:<orderId>)
  else nightly
    Q->>CH: DELETE superseded versions (ADR-0015)
    Q->>PG: replace store_delivery_rates
  end
```

## 5. Failure modes

| Failure | Behaviour | Idempotency |
|---|---|---|
| ClickHouse insert fails | Job retried (2 s base, 5 attempts) → `attribution-run-failed`, alert | Re-run writes a new version; any partially inserted older version is ignored by readers and deleted nightly |
| Engine assertion (negative credit, sum off) | Job fails and the order id goes to the DLQ; alert. This is a code bug; property tests should prevent it | — |
| Nightly run overlaps an incremental run for the same order | Both write; the latest `computed_at` wins; cleanup never removes the newest | — |
| Nightly run doesn't finish by 06:00 IST | Chunks already written are valid; the remaining orders keep their previous version; the next night resumes. Alert if > 2 nights | `jobId` per date |
| Superseded cleanup fails | Harmless for correctness (readers use the latest); storage grows; retried the next night | — |
| `store_delivery_rates` computation fails | Previous rows stay; projections carry their stored `computed_at`; alert if older than 48 h | — |
| Order status projection missing in ClickHouse | The order is absent from the revenue join; the nightly `order-status-reconcile` repairs it; the reporting-api health check compares counts | — |
| `suppress:ready` absent | Queue paused | — |

## 6. Privacy touchpoints

| ID | How |
|---|---|
| P-5 | Uses only touchpoints from events accepted with `attribution_analytics`. `attribution_results` holds per-order credits; no identifiers beyond `order_id`. |
| Erasure / withdrawal | Suppression re-check per order at execution. Erasure deletes `attribution_results` by `order_id` (privacy-dpdp §4.4). Withdrawal erasure re-runs attribution for affected orders after unlinking (§4.5 there). |
| §5.7 | `attribution_results` rows are order-linked, so they follow order retention (25 months, privacy-dpdp §4.8). They are not "aggregated reports" with indefinite retention. |
| P-6 | Child-directed stores: the engine is unchanged; stitching limits the journey (identity-stitching §4.2), and CAPI is suppressed downstream. |
| Logs | Job metrics only: orders processed, models, rows, duration. No visitor ids. |

## 7. Performance & limits

| Item | Target |
|---|---|
| `attribute()` | < 50 µs for ≤ 50 touchpoints |
| Incremental job (1 order) | p95 < 300 ms end to end |
| Nightly run | 45 days × up to ~20k orders/store (50k orders per 90 days, SPEC §13) in < 15 min per store at 500 orders/chunk |
| Rows | ≈ orders × 6 models × avg touchpoints (~3) → ~360k rows per 20k orders per version |
| Journey caps | ≤ 10 visitors, ≤ 200 touchpoints per order (older ones dropped beyond the cap, logged) |
| Report query | Must fit the reporting p95 < 1.5 s for 90 days / 50k orders; the latest-version CTE is on the `(store_id, order_id, model, computed_at)` prefix |

## 8. Test plan

**Unit / property** (fast-check, SPEC §9 and §14)
- For every model and random touchpoint lists (0–60, random timestamps, random `isDirect`): credits sum to 1 ± 1e-9; all ≥ 0; output identical across two calls and across input permutations (determinism, given the tie-break).
- Examples:
  - `position_based` n = 1, 2, 3, 5;
  - `last_non_direct` with all direct;
  - `time_decay` with half-life 7: a 7-day-old touchpoint gets half the weight of one at order time;
  - lookback excludes day 31;
  - empty → Unattributed.
- Collapse: same-session duplicates collapse; identical touchpoints in different sessions do not.
- Largest-remainder rounding of paise sums exactly to the total.

**Integration**
- Incremental then nightly for the same order → exactly one visible version (the latest); after cleanup, the older rows are gone.
- A recompute producing fewer touchpoints (a touchpoint deleted by withdrawal erasure) → no stale rank-3 row is visible (HLD §8 rationale).
- Delivered revenue flips from 0 to the full amount when an `order_status` row with a newer `source_updated_at` says `delivered`, with no attribution run.
- An out-of-order `in_transit` after `delivered` doesn't change delivered revenue.
- Delivery-rate fallback: 49 resolved COD orders → store-wide; store-wide < 50 → platform default with `low_confidence: true`; cancelled orders count as resolved.

**§5.10 compliance tests supported**
- Test 5 (erasure removes identity from all stores): `attribution_results` deleted by order.
- Test 6 (retention): 25-month order-linked deletion.
- Test 7 (cross-tenant): the query builder requires `store_id`.

## 9. Open questions
1. *(resolved: both columns dropped in SPEC v0.3.)*
2. **Lookback changes** only re-credit the last 45 days. Should a lookback change trigger a full-history recompute (up to 25 months)? That is expensive but consistent.
3. **Channel-rule edits** don't reclassify historical touchpoints. A "reclassify last N days" job would rebuild `touchpoints` from `events` and then re-run attribution. Needed for MVP? Proposed: no; show "rules apply from <date>".
4. **Platform default delivery rates** and the **14-day resolution lag** — **needs design-partner data**.
5. **Report date axis**: orders are bucketed by `placed_at` in IST, while spend is bucketed by the ad account's reporting timezone (HLD §8). ROAS over short ranges near midnight can be slightly skewed; the dashboard labels this.
