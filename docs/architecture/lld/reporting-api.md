# LLD — Reporting API

> Names are defined in [HLD §8](../HLD.md#8-cross-cutting-concepts). Revenue and version semantics come from [attribution-engine.md §4.4](attribution-engine.md#44-read-contract--the-latest-version-placed-vs-delivered), which this module implements as HTTP endpoints. Endpoints are exactly [SPEC §10](../../SPEC.md#10-api-core--mvp-endpoints) unless flagged.

## 1. Purpose & scope

Core API read endpoints behind the dashboard's analysis screens (SPEC §11 screens 2–6):
- overview, breakdown (channel → campaign → ad set → ad), model comparison, order journey, RTO;
- CSV export of breakdowns (audited);
- the analysis-settings endpoints `attribution-settings` and `channel-rules`;
- Redis caching; the metric definitions from SPEC §9 "Metrics exposed".

**Non-goals**
- Privacy endpoints ([privacy-dpdp.md](privacy-dpdp.md)).
- Auth, orgs and team ([auth-tenancy.md](auth-tenancy.md)).
- Integration connect and health (the integration LLDs).
- Writing any analytical data. This module is read-only except the two settings resources.
- Scheduled or emailed reports, custom dashboards, and a public reporting API with API keys — not MVP.

## 2. Interfaces

### 2.1 Common query parameters (zod, `packages/shared/reports.ts`)

```ts
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);          // IST calendar date
export const ReportRange = z.object({
  from: IsoDate, to: IsoDate,                                      // inclusive, IST; to − from ≤ 400 days
  model: z.enum(['first_click','last_click','last_non_direct','linear','time_decay','position_based']).optional(),  // default: attribution_settings.default_model
  basis: z.enum(['placed','delivered']).optional(),                // default: attribution_settings.revenue_basis
}).strict().refine(r => r.from <= r.to, 'from after to');

export const BreakdownQuery = ReportRange.extend({
  level: z.enum(['channel','campaign','adset','ad']),
  parent: z.string().max(64).optional(),   // e.g. campaign_id when level=adset (drill-down)
  platform: z.enum(['meta','google']).optional(),
  sort: z.enum(['spend','revenue','roas','orders','cpa','rto_rate']).default('spend'),
  dir: z.enum(['asc','desc']).default('desc'),
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().max(200).optional(),
  format: z.enum(['json','csv']).default('json'),
});
export const RtoQuery = ReportRange.omit({ basis: true }).extend({
  level: z.enum(['campaign','ad','pincode_prefix','device_type','in_app_browser']),  // device_type, in_app_browser: SPEC v0.5
});
```

Money in responses is **integer paise** (`number`; safe up to 2⁵³). Ratios are `number` rounded to 4 decimals. The client formats both (dashboard.md).

### 2.2 Endpoints

| Endpoint (SPEC §10) | Roles | Returns |
|---|---|---|
| `GET /v1/stores/:id/reports/overview?from&to&model&basis` | all | `OverviewResponse` |
| `GET /v1/stores/:id/reports/breakdown?level=…` | all; `format=csv` needs analyst+ | `BreakdownResponse` or CSV |
| `GET /v1/stores/:id/reports/model-comparison?level&from&to&basis` | all | the same rows with one metric block per model |
| `GET /v1/stores/:id/orders/:orderId/journey` | owner, admin, analyst | `JourneyResponse` (a personal-data view: audited, not cached) |
| `GET /v1/stores/:id/reports/rto?level=…` | all | `RtoResponse` |
| `GET/PUT /v1/stores/:id/attribution-settings` | read all; write owner/admin | `{ default_model, lookback_days (1–90), revenue_basis }` |
| `GET/PUT /v1/stores/:id/channel-rules` | read all; write owner/admin | `ChannelRule[]` (≤ 100; `match` validated with `ChannelRuleMatch`, [event-pipeline.md §2.3](event-pipeline.md#23-channel_rulesmatch-schema-read-only-here)) |
| `GET /v1/stores/:id/privacy/consent-stats?from&to` (SPEC v0.5) | owner, admin | `ConsentStats` — the privacy page (SPEC §11 screen 8): pixel coverage, drop counts, withdrawals per week |

```ts
type Freshness = {
  events_max_received_at: string | null;
  spend_synced_at: { meta: string | null; google: string | null };
  delivery_synced_at: string | null;
  attribution_computed_at: string | null;       // max computed_at in range
};
type Money = number;                            // integer paise

type MetricBlock = {
  spend: Money; attributed_orders: number;      // credit-weighted
  revenue: Money;                               // per basis
  roas: number | null; cpa: Money | null;
  rto_rate: number | null; cod_share: number | null;
  platform_conversion_value: Money | null; platform_roas: number | null; roas_delta_pct: number | null;
};

type OverviewResponse = {
  range: { from: string; to: string; model: Model; basis: RevenueBasis };
  kpis: MetricBlock & { mer: number | null; total_revenue: Money; new_customer_share: number | null };
  pending_projection: PendingProjection;        // attribution-engine §2.3
  trend: { date: string; spend: Money; revenue: Money; roas: number | null }[];
  platforms: { platform: 'meta' | 'google'; ours: MetricBlock; }[];   // "Platform-reported vs TruePath"
  unattributed: { orders: number; revenue: Money };
  freshness: Freshness;
  notes: string[];                              // e.g. "Spend dates follow each ad account's timezone"
};

type BreakdownRow = { key: string; label: string; platform: 'meta' | 'google' | null; metrics: MetricBlock; has_children: boolean };
type BreakdownResponse = { rows: BreakdownRow[]; totals: MetricBlock; next_cursor: string | null; freshness: Freshness };

type JourneyResponse = {
  order: { external_order_id: string; placed_at: string; total: Money; refunded: Money;
           payment_method: string; delivery_status: string; attribution_confidence: 'high' | 'low'; is_first_order: boolean };
  devices: { label: string; device_type: string; os: string; browser: string; is_in_app_browser: boolean }[];  // "Device 1", "Device 2" — no visitor ids
  touchpoints: { ts: string; device: string; channel: string; sub_channel: string; platform: string | null;
                 campaign_id: string; adset_id: string; ad_id: string; landing_path: string;
                 credits: Record<Model, number> }[];
  status_timeline: { at: string; source: 'shopify' | 'shiprocket'; status: string }[];
  capi: { event_name: string; status: string; sent_at: string | null; skip_reason: string | null }[];
};

type ConsentStats = {                           // SPEC v0.5 replaces "consent rate" with these
  pixel_coverage: {                             // orders with a pixel match ÷ all orders placed in range
    ratio: number | null; matched_orders: number; total_orders: number;
    weekly: { week_start: string; ratio: number | null }[];
  };
  dropped_daily: { date: string;
    counts: Record<'no_analytics_consent'|'suppressed_visitor'|'suppressed_identity'|'store_inactive'|'stale_event'|'foreign_page', number> }[];
  withdrawals_weekly: { week_start: string; withdrawals: number; erasures_completed: number }[];
};
```

Errors:
- `400 invalid_query`;
- `403 forbidden_role`;
- `404 not_found` (unknown store **or another tenant's store** — §5.10 test 7);
- `422 range_too_large`;
- `503 report_unavailable` with `Retry-After` (ClickHouse unreachable or timed out).

## 3. Data owned

| Item | Access | Notes |
|---|---|---|
| ClickHouse `attribution_results`, `order_status`, `ad_spend_daily`, `touchpoints`, `events` | read via the scoped query builder | `FINAL`/`argMax` where `ReplacingMergeTree`; latest `computed_at` for attribution (attribution-engine §4.4) |
| Postgres `attribution_settings`, `channel_rules` | read/write | SPEC §6.1 |
| Postgres `orders`, `order_status_events`, `capi_dispatch_log`, `store_delivery_rates`, `consent_records` (counts), `dsr_requests` (counts) | read | journey, pending projection, consent stats |
| Redis (cache) `report:<store_id>:<endpoint>:<params_hash>` | read/write, TTL 300 s | HLD §8 |
| Redis (durable) `stats:collector:<store_id>:<yyyymmdd>` | read | consent stats |
| `audit_log` | write | `order_journey_viewed`, `report_exported`, `attribution_settings_changed`, `channel_rules_changed` |

No new tables or keys. The consent-stats endpoint and the two extra RTO levels are approved (SPEC v0.5 §10).

## 4. Processing flow

### 4.1 Request pipeline (all endpoints)
1. Authenticate → `TenantScope` for `:id` (auth-tenancy §4.3). A store outside scope → `404`.
2. Validate the query (zod). Resolve defaults from `attribution_settings`.
3. **Cache** (overview, breakdown, model-comparison, rto only):
   - key `report:<store_id>:<endpoint>:<sha1(canonical query)>`;
   - hit → return;
   - miss → compute, `SET … EX 300` (the cache Redis instance, `allkeys-lru`).

   Journey, CSV and consent stats are never cached. There is no explicit invalidation; staleness ≤ 5 min (SPEC §10).
4. Compute (§4.2–§4.6) with a per-query `max_execution_time = 10 s`. At most 4 concurrent ClickHouse queries per store (in-process semaphore).
5. Attach `freshness`. Return.

### 4.2 Metric definitions (SPEC §9)

| Metric | Definition |
|---|---|
| Spend | Σ `spend_paise` from `ad_spend_daily` (`argMax(…, synced_at)` per key) for `date ∈ [from, to]`. Dates are in **each ad account's timezone** (HLD §8; surfaced in `notes`). |
| Attributed orders | Σ `credit` over latest-version rows for orders with `placed_at ∈ [from, to]` IST; for `basis=delivered`, only orders with `delivery_status='delivered'` |
| Revenue | placed: Σ `credit × total`; delivered: Σ `credit × max(0, total − refunded)` where `delivered` (attribution-engine §4.4) |
| ROAS | revenue ÷ spend (`null` if spend = 0) |
| CPA | spend ÷ attributed orders (per basis) |
| RTO rate | credit-weighted `rto` ÷ credit-weighted (`delivered` + `rto`), orders only. `cancelled` excluded because those never shipped; pending excluded |
| COD share | credit-weighted `payment_method ∈ {cod, partial_cod}` ÷ attributed orders |
| New-customer share | credit-weighted `is_first_order` ÷ attributed orders |
| Platform ROAS | Σ `platform_conversion_value_paise` ÷ spend, for the same campaign/ad keys |
| ROAS delta % | (ROAS − platform ROAS) ÷ platform ROAS × 100 |
| MER (blended) | total revenue of **all** orders placed in the range (per basis, not attribution-weighted) ÷ total spend across platforms |
| Pending projection | attribution-engine §4.6, with `low_confidence` |
| Pixel coverage | orders placed in range with `attribution_confidence = 'high'` (a pixel journey was matched: order id, checkout key, or HMAC link — identity-stitching §4.2) ÷ all orders placed in range, excluding orders still inside the 35-min stitching window. Weeks start Monday (IST). Also shown on the Shopify integration-health card over the last 7 days: < 50% warns, < 25% errors. |
| Withdrawals per week | `consent_records` rows with `state='withdrawn'` by IST week, plus `dsr_requests` with `trigger='consent_withdrawn'` completed that week |

**Join keys between spend and attribution:**
- campaign level: `(platform, campaign_id)`;
- ad-set level: `(platform, adset_id)`;
- ad level: `(platform, ad_id)`. PMax spend rows have `ad_id='pmax:<campaign_id>'`, and attribution rows for PMax traffic have an empty `ad_id`, so at ad level, PMax attribution is shown under the synthetic `pmax:<campaign_id>` row (HLD §8).

At channel level, spend is attached to `meta_ads` / `google_ads` only.

Attribution rows with an empty `campaign_id` on a paid channel go to a row labelled "Meta — unmapped campaign" or "Google — unmapped campaign". Its share feeds the "UTM health" figure.

### 4.3 Overview and breakdown queries
- One ClickHouse query per response section (KPIs, trend, per-platform), each shaped like attribution-engine §4.4, grouped by the level key. Spend is a separate query on `ad_spend_daily`, joined in the API layer on the level key.
- Pagination: breakdowns sort in ClickHouse (`ORDER BY <metric> <dir>, key LIMIT limit+1`), and the cursor encodes `(sort value, key)`.
- **Model comparison** runs the §4.4 query with all six models, grouped by `(key, model)`.
- **CSV** (`format=csv`):
  - streams the full breakdown (no limit, cap 50,000 rows) with a header row;
  - values are rupees with 2 decimals, ratios with 4;
  - columns: `level_key,label,platform,spend_inr,orders,revenue_inr,roas,cpa_inr,rto_rate,cod_share,platform_roas,roas_delta_pct`;
  - writes `audit_log(action='report_exported', metadata={level, from, to, model, basis, rows})`;
  - `Content-Disposition: attachment; filename="truepath-<level>-<from>-<to>.csv"`.

### 4.4 Journey (`GET …/orders/:orderId/journey`)
1. `:orderId` is our `orders.id` (UUID) or the Shopify `external_order_id` (digits). The dashboard search also accepts the order name `#1001` if `orders.external_order_name` exists (SPEC v0.4, conditional).
2. Load the order through the scoped repository → `404` if missing or anonymised by erasure.
3. `resolveJourneyVisitors` ([identity-stitching.md §4.3](identity-stitching.md#43-resolvejourneyvisitors-used-by-attribution)) → up to 10 visitors, relabelled "Device 1…n" in `first_seen` order. Raw `visitor_id`s and hashes are never returned.
4. Touchpoints `FINAL` within lookback; latest-version credits for all six models; `order_status_events`; `capi_dispatch_log`. `landing_path` is the sanitised path only, with no query string beyond the allowlisted UTM names.
5. Write `audit_log(action='order_journey_viewed', target_type='order', target_id=<orders.id>)` (S-4 "access to personal-data views"). No caching.

### 4.5 RTO report
Grouped by `level`:
- `campaign` / `ad`: credit-weighted over attribution rows;
- `pincode_prefix`: from `order_status.pincode_prefix`, not attribution-weighted; order counts;
- `device_type` / `in_app_browser`: from the order's primary visitor's session-start touchpoint and event (SPEC v0.5).

Metrics: orders, RTO rate, COD share, RTO revenue lost (Σ total of `rto` orders). Rows with fewer than 20 resolved orders are shown with `low_sample: true`.

### 4.6 Settings resources
- `PUT attribution-settings` (owner/admin):
  - validate; update; write the audit entry;
  - if `lookback_days` changed → enqueue a nightly-mode `AttributionRunJob` (attribution-engine §4.5);
  - delete the store's cached reports: `SCAN report:<store_id>:*` + `DEL` on the cache instance.
- `PUT channel-rules`:
  - replace the full list in one transaction (≤ 100 rules, `priority` unique per store);
  - validate each `match` with `ChannelRuleMatch` and each `channel` against the HLD §8 slugs;
  - audit; cache purge;
  - response note: "rules apply to new visits from now" (attribution-engine Q3).

```mermaid
sequenceDiagram
  participant D as Dashboard
  participant API as Core API /reports/*
  participant C as Redis (cache)
  participant CH as ClickHouse (scoped builder)
  participant PG as Postgres
  D->>API: GET /v1/stores/:id/reports/breakdown?level=campaign…
  API->>API: auth → TenantScope(:id) (404 if other tenant); zod
  API->>C: GET report:<store>:breakdown:<hash>
  alt hit
    C-->>API: cached JSON
  else miss
    API->>PG: attribution_settings defaults
    API->>CH: latest-version credits × order_status (placed_at IST range)
    API->>CH: ad_spend_daily argMax by (platform, campaign_id)
    API->>API: join, metrics, sort, cursor
    API->>C: SET … EX 300
  end
  API-->>D: rows + totals + freshness
```

## 5. Failure modes

| Failure | Behaviour |
|---|---|
| ClickHouse down or timeout | `503 report_unavailable` + `Retry-After: 30`. The dashboard keeps the last good data (TanStack Query) and shows a banner |
| Cache Redis down | bypass the cache (compute directly), log a warning; latency may exceed the target |
| Durable Redis down (consent stats) | `dropped` counts return `null` with a note |
| Query exceeds 10 s | `503` + metric `report_timeout_total{endpoint}`. Analysed against the p95 target |
| Settings PUT validation failure | `400` with zod issues; nothing written |
| Data partially fresh | not an error: `freshness` lets the UI show "Meta spend last synced 4 h ago" |

## 6. Privacy touchpoints

| ID | How |
|---|---|
| S-3 / §5.10 test 7 | `TenantScope` on every request; the query builder injects `store_id`; other tenants' ids → `404`. Cache keys are `store_id`-prefixed. |
| S-4 / §5.10 test 8 | Journey views and CSV exports audited; settings changes audited. |
| §5.4 | Responses never include hashes, visitor ids, IPs or raw UAs. The journey shows device labels, parsed device fields, sanitised landing paths and order ids only. |
| §5.7 | Aggregates in responses are not stored anywhere else; the cache is 5 min. |
| Erasure | Erased orders are anonymised; the journey returns `404`; their credits are deleted (privacy-dpdp §4.4). Cached aggregates may lag by ≤ 5 min (aggregate, no identifiers). |
| P-6 | Child-directed stores see the same reports; there's no behavioural output beyond aggregates. |

## 7. Performance & limits

| Item | Target |
|---|---|
| Overview / breakdown / RTO | **p95 < 1.5 s for 90 days / 50k orders** (SPEC §10, §13), cache miss |
| Model comparison | p95 < 2.5 s (6× the rows), flagged as a separate target |
| Journey | p95 < 500 ms |
| Range | ≤ 400 days |
| Breakdown page | ≤ 500 rows; CSV ≤ 50,000 rows |
| Concurrency | ≤ 4 ClickHouse queries per store at a time; the global pool is sized to the single ClickHouse node |
| Cache | TTL 300 s; expected hit rate > 60% on overview (the dashboard re-polls) |

A load test in M4-6 runs on the SPEC §14 seed (a 90-day, 50k-order synthetic store).

## 8. Test plan

**Unit**
- Metric formulas (ROAS `null` on zero spend; RTO rate excludes cancelled; delta %).
- PMax join mapping.
- Cursor encoding.
- CSV escaping (commas and quotes in campaign names; formula-injection guard: prefix `'` for cells starting `= + - @`).
- Range validation.

**Integration** (seeded ClickHouse + Postgres)
- Golden-number tests: a hand-computed fixture store (10 orders, 2 campaigns, a known credits table) → exact overview and breakdown values for each basis and model.
- Delivered vs placed after a status change, with no recompute.
- Refunds reduce delivered revenue.
- Stale attribution versions are ignored.
- Journey audit row written; not cached.
- CSV → audit row.

**Security**
- The generated cross-tenant matrix (auth-tenancy §8) covers every route here → `404`.
- Viewer denied CSV and journey → `403`.

**Performance**
- 90-day / 50k-order seed → p95 measured in CI nightly (not per PR).

**§5.10 compliance tests supported**: test 7 (cross-tenant) and test 8 (audit for exports).

## 9. Open questions
1. *(resolved: consent-stats endpoint approved; "consent rate" replaced by pixel coverage, drop counts and weekly withdrawals — SPEC v0.5.)*
2. *(resolved: RTO levels `device_type` and `in_app_browser` approved — SPEC v0.5 §10.)*
3. **Model comparison latency** — accept a separate 2.5 s p95, or precompute per-day aggregates (materialised views, a Phase 2 optimisation)?
4. **Cache invalidation on new data**: TTL only. Should attribution runs purge the store's cache? Proposed: no (5 min staleness is acceptable per SPEC).
