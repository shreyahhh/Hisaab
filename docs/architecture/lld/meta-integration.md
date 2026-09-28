# LLD — Meta integration (Marketing API insights + Conversions API)

> Names are defined in [HLD §8](../HLD.md#8-cross-cutting-concepts). Pinned to Marketing API **v25.0**, the latest Marketing API version (released 2026-02-18). Graph API v26.0 was released 2026-07-29, with a Marketing API auto-upgrade noted for that date ([versions](https://developers.facebook.com/docs/graph-api/changelog/versions)). The version string lives in one constant in `packages/integrations/meta`; upgrades are one-line changes behind the adapter (SPEC §0 rule 8).

> **⚠ Top-priority VERIFY (blocks the DeliveredPurchase value proposition):** can a `system_generated` `DeliveredPurchase`, with no IP or UA, be used as the **optimisation event of a Meta sales campaign**? The test is in §4.7; the fallback is designed there but **not implemented until the test result is known**.

## 1. Purpose & scope

1. **Connection**: Facebook Login for Business, token storage, ad account selection → `ad_accounts`.
2. **Insights sync** (`ad-sync-meta`): ad-level daily spend, impressions, clicks and platform-reported purchases/value → `ad_spend_daily` (`platform='meta'`). Daily, intraday, and backfill.
3. **Conversions API sendback** (`capi-dispatch`):
   - `DeliveredPurchase` and `RTO` — **on by default**;
   - `Purchase` — **opt-in, off by default** (SPEC v0.3), with the consent, suppression, child-directed and freshness gates, and `capi_dispatch_log`.

**Non-goals**
- Creating campaigns, audiences or custom conversions. The merchant creates a custom conversion on `DeliveredPurchase` in Events Manager; onboarding shows the steps.
- The browser Meta Pixel. The merchant's Shopify Facebook & Instagram channel owns it; we never inject it.
- Creative-level analytics, breakdowns (age/gender/placement), and anything beyond SPEC §2.
- Identity resolution. `capi-dispatch` uses `orders.visitor_id` from [identity-stitching.md](identity-stitching.md).

## 2. Interfaces

### 2.1 Endpoints (SPEC §10)

| Method & path | Purpose |
|---|---|
| `GET /v1/integrations/meta/connect?storeId=` | Owner/admin. `302` to the Facebook Login for Business dialog, with a `config_id` requesting `ads_read` + `business_management` and the merchant's ad accounts and dataset (pixel) as assets. Meta's CAPI template lists production permissions as "ads_management or business_management and pages_read_engagement and ads_read" ([template](https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business/conversions-api-integration-template/)). Also a signed `state` JWT. |
| `GET /v1/integrations/meta/callback` | Exchange the code for a token → list ad accounts → the dashboard shows the account picker. |
| `PUT /v1/integrations/:id/settings` | `MetaSettingsPatch` (below): selected ad accounts, CAPI dataset id, event toggles, test code. Enabling `purchase_enabled` requires `acknowledge_double_count: true` in the same request (the onboarding warning). Audit `integration_settings_changed`. |
| `GET /v1/stores/:id/integrations` | Health (§4.6). |

```ts
export const MetaSettingsPatch = z.object({
  ad_account_ids: z.array(z.string().regex(/^act_\d{1,20}$/)).min(1).max(10).optional(),
  capi: z.object({
    dataset_id: z.string().regex(/^\d{5,20}$/).optional(),   // Meta Pixel / dataset id
    delivered_purchase_enabled: z.boolean().optional(),     // default true
    rto_enabled: z.boolean().optional(),                    // default true
    purchase_enabled: z.boolean().optional(),               // default false
    acknowledge_double_count: z.literal(true).optional(),   // required when turning purchase_enabled on
    test_event_code: z.string().regex(/^TEST\w{1,20}$/).nullable().optional(),
  }).strict().optional(),
}).strict().refine(p => p.capi?.purchase_enabled !== true || p.capi?.acknowledge_double_count === true,
  { message: 'acknowledge_double_count required to enable Purchase' });
```

The onboarding warning text: *"Shopify's Facebook & Instagram channel already sends Purchase events to this dataset with its own event IDs. Turning this on will likely double-count purchases in Meta. Only enable it if you have disabled Purchase in that channel's data-sharing settings."*

### 2.2 Queue jobs
- `AdSyncMetaJob{storeId}` on `ad-sync-meta` (HLD §8). The job derives its date range from its **repeatable-job name** (`meta-daily`, `meta-intraday`, `meta-backfill`), so the payload is unchanged.

  | Name | Schedule | Range (ad account timezone) |
  |---|---|---|
  | `meta-daily` | 06:00 IST | yesterday − 7 days … yesterday (conversions settle within the 7-day click window) |
  | `meta-intraday` | every 3 h, 09:00–24:00 IST | the last 3 days including today (SPEC §8.2) |
  | `meta-backfill` | once on account selection | 90 days, in 30-day chunks |
  | `meta-warmup` (**M1 only**, SPEC v0.5 §12) | every 15 min | yesterday … today (each registered ad account's own timezone); read-only `GET act_<id>/insights`. Runs against our test ad account and one design partner's account, to build the ≥ 1,500 successful calls in 15 days (< 15% errors) that Advanced Access / App Review requires. It writes to `ad_spend_daily` like the other runs, so the data is useful. **Built in M1-8** (`apps/workers/src/metaWarmup.ts`): a per-account success/error ledger lives in `integrations.settings.warmup` (no live dashboard yet — read via `dev:meta-warmup status`, ADR-0027). There is no OAuth flow yet to supply a token (M2-1), so the account and its access token are registered by an operator CLI (ADR-0027); `meta:<storeId>:<name>:<hh>` in this table is written here as `meta-<storeId>-<name>-<hh>` — BullMQ 6.x rejects a 4-part, 3-colon custom job id, the same constraint hit for `dsr`/`identity-stitch` job ids. Removed once App Review passes; `meta-intraday` replaces it in M2. |

  `jobId = meta:<storeId>:<name>:<yyyymmddhh>`.
- `CapiDispatchJob{storeId, orderId, eventName}` on `capi-dispatch`. `jobId = capi:<eventName>:<orderId>`.

### 2.3 Meta API calls (adapter `packages/integrations/meta`)

| Call | Detail |
|---|---|
| Token | Facebook Login for Business configured for a **Business Integration System User (BISU) access token**. These "default to never expire for the common offline server-to-server communication"; a 60-day expiry is optional and not used ([Login for Business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business)). Authorization-code flow with `config_id`, `response_type=code`, `override_default_response_type=true`. This matches Meta's [CAPI integration template](https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business/conversions-api-integration-template/). Stored in `encrypted_credentials`. |
| Ad accounts | `GET /v25.0/me/adaccounts?fields=id,name,currency,timezone_name,account_status` |
| Insights | `GET /v25.0/act_<id>/insights` with `level=ad`, `time_increment=1`, `time_range={"since","until"}`, `fields=account_currency,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,actions,action_values`, `action_attribution_windows=["7d_click","1d_view"]`, `limit=500`, paginated by `paging.cursors.after`. Ranges over 7 days use an **async job**: `POST …/insights` → Ad Report Run id; poll until `async_status = "Job Completed"` and `async_percent_completion = 100`. A job can take up to an hour. Never store `report_run_id` beyond use (it expires after 30 days). Error `100` / subcode `1487534` (data-per-call limit) → split the date range and retry ([insights best practices](https://developers.facebook.com/docs/marketing-api/insights/best-practices/)). |
| CAPI | `POST /v25.0/<dataset_id>/events` with `data=[…]` (≤ 1,000 events), plus `test_event_code` when set |

**Attribution windows.** The supported `action_attribution_windows` values are `1d_click`, `7d_click`, `1d_view` and `incrementality`. `28d_click` and `28d_view` "are no longer supported … and will return an empty dataset" (Meta Insights docs, via [Insights API](https://developers.facebook.com/docs/marketing-api/insights/)). Industry sources date the 2026 removal of the view windows to 12 Jan 2026 ([ppc.land](https://ppc.land/meta-restricts-attribution-windows-and-data-retention-in-ads-insights-api/)). Each `actions` / `action_values` entry carries a field per requested window (`7d_click`, `1d_view`, …), plus `value` for the default window ([AdsActionStats](https://developers.facebook.com/docs/marketing-api/reference/ads-action-stats/)). The window actually used is stored per row (`attribution_window`, SPEC v0.4) and in `settings.insights.windows`.

**Platform conversions**: `actions` / `action_values` with `action_type = "omni_purchase"`, falling back to `"offsite_conversion.fb_pixel_purchase"` (**VERIFY** which one best matches Ads Manager "Purchases" for Shopify-channel pixels). The chosen type is stored in `settings.insights.purchase_action_type`.

**Rate limits** ([rate limiting](https://developers.facebook.com/docs/marketing-api/overview/rate-limiting)):
- The `x-business-use-case-usage` response header carries per-ad-account `call_count`, `total_cputime`, `total_time` and `estimated_time_to_regain_access` for type `ads_insights`.
- Ads Insights quota per ad account per hour: **600 + 400 × active ads** at development access, **190,000 + 400 × active ads** at standard access. Standard access comes with App Review (M0-7).
- Handling:
  - any usage metric ≥ 75 → pause 60 s between pages;
  - `estimated_time_to_regain_access > 0` → re-delay the job by that many minutes;
  - errors 17 / 613 (API level) and 80000 / 80004 (business use case) → exponential backoff (30 s → 16 min, 6 tries).

### 2.4 CAPI event payload

`action_source='system_generated'` is used because server-side **website** events require `client_ip_address`, which TruePath never keeps (SPEC v0.2 §5.4), plus `event_source_url` ([customer information parameters](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters), [server event parameters](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/server-event)).

```ts
type CapiEvent = {
  event_name: 'DeliveredPurchase' | 'RTO' | 'Purchase';
  event_time: number;               // unix seconds — when the thing HAPPENED: DeliveredPurchase = delivered_at,
                                    // RTO = rto_at, Purchase = order created_at. Never the send time or the order time for status events.
  event_id: string;                 // delivered_<id> | rto_<id> | order_<id>  (HLD §8)
  action_source: 'system_generated';
  user_data: {
    em?: string[];                  // SHA-256(trim+lowercase email) — computed in memory at send time
    ph?: string[];                  // SHA-256(digits incl. country code, no '+', no leading zeros), e.g. "919812345678"
    fbp?: string;                   // not hashed
    fbc?: string;                   // not hashed; "fb.1.<ms>.<fbclid>"
    external_id?: string[];         // hex part of HMAC(visitor_id) — already an opaque hash
  };
  custom_data: {
    currency: 'INR';
    value: number;                  // rupees, from paise: DeliveredPurchase/Purchase = max(0, total − refunded); RTO = total
    order_id: string;               // Shopify order id (not personal data)
  };
};
```

`client_user_agent` and `client_ip_address` are **not sent**, and neither is stored: the Collector parses the UA and discards the raw string (SPEC v0.5). Both would only be needed for `website` events (§4.7 fallback).

## 3. Data owned

| Item | Access | Notes |
|---|---|---|
| `integrations` (provider `meta`) | write | `encrypted_credentials` = `{accessToken, tokenType, expiresAt?}`; `scopes`; `status`; `settings` (non-secret): `ad_account_ids`, `capi {dataset_id, delivered_purchase_enabled, rto_enabled, purchase_enabled, purchase_ack_by_user_id, purchase_ack_at, test_event_code}`, `insights {windows, purchase_action_type, last_daily_at, last_intraday_at, backfill}` |
| `ad_accounts` | write | `provider='meta'`, `external_id` (`act_…`), `name`, `currency`, `timezone` (`timezone_name`) |
| ClickHouse `ad_spend_daily` | insert | `ReplacingMergeTree(synced_at)`, key `(store_id, platform, date, campaign_id, ad_id)` (SPEC v0.2); plus **`attribution_window`** (SPEC v0.4) |
| Postgres `capi_client_context` | **not built** — only if the §4.7 test fails and the fallback is approved | pending in HLD §8 |
| `capi_dispatch_log` | write | `event_name`, `event_id`, `status` (`queued`\|`sent`\|`skipped`\|`failed`), `attempts`, `last_error` (a code plus Meta `fbtrace_id`, redacted, ≤ 300 chars), `sent_at`; unique `(store_id, event_id)` |
| `orders`, `order_status` | read | `visitor_id`, amounts, `refunded_amount_paise`, `delivered_at`, `rto_at`, `created_at_platform` |
| `consent_records` | read | latest row for `HMAC(visitor_id)` |
| ClickHouse `events` | read | `fbp`, `fbc` for the order's visitor (latest non-empty, from events carrying `ad_platform_measurement`) |
| Shopify adapter `fetchOrderContact` | call | send-time email/phone (shopify-integration §2.7) |

## 4. Processing flow

### 4.1 Connect
1. `connect` → Login for Business → `callback`: exchange the code, store the token (KMS envelope), `GET me/adaccounts`.
2. The merchant picks 1–10 ad accounts and the CAPI dataset (pixel) id, the same pixel the Shopify channel uses, so `DeliveredPurchase` lands next to Meta's own Purchase data.
3. **Currency check** (accepted): accounts whose `currency ≠ INR` can't be selected. The picker shows them disabled with the error *"This ad account bills in USD. TruePath currently supports INR ad accounts only — spend in other currencies can't be compared with your INR revenue yet."* The API returns `422 unsupported_ad_account_currency`. FX conversion is **Phase 2**.
4. Write `ad_accounts`, register the repeatable jobs, enqueue `meta-backfill`. Audit `integration_connected`.

### 4.2 Insights sync (`ad-sync-meta`)
1. Suppression isn't relevant (no shopper data). Load the token; missing or expired → `needs_reauth`, stop.
2. For each selected account, fetch the insights for the range (§2.3), paging, with rate-limit handling.
3. Per row:
   - `date = date_start` (**the ad account's reporting timezone**, HLD §8);
   - `spend_paise` = decimal-string spend → paise with the integer parser (as in shopify-integration §4.5), rounding half-up if Meta returns more than 2 decimals;
   - `platform_conversions` = that action entry's `7d_click` + `1d_view` fields (click-through and view-through are separate windows). Parity with Ads Manager's "7-day click or 1-day view" column is checked with a design partner (it can differ slightly where Meta de-duplicates);
   - `platform_conversion_value_paise` likewise from `action_values`;
   - `attribution_window = '7d_click+1d_view'`.
4. Batch insert into `ad_spend_daily` with `synced_at = now()` (one insert per account per run). Re-pulled days supersede earlier rows (`ReplacingMergeTree`).
5. Update `settings.insights.last_*_at` and `integrations.last_synced_at`. On failure: `integrations.status='error'`, with `error` holding a code only.

### 4.3 CAPI dispatch (`capi-dispatch`)
Triggered by `shiprocket-sync` (DeliveredPurchase, RTO) and by `attribution-run` (Purchase, only when opted in). Gates, in order; the first failing gate writes `capi_dispatch_log(status='skipped', last_error=<code>)` and stops:

| # | Gate | Skip code |
|---|---|---|
| 1 | `suppress:ready` present (else the queue is paused, not skipped) | — |
| 2 | Event toggle enabled in `settings.capi` (`purchase_enabled` defaults false) | `event_disabled` |
| 3 | `stores.child_directed = false` (P-6) | `child_directed` |
| 4 | Order hashes and visitor not in the suppression set (erased or withdrawn) | `suppressed` |
| 5 | `orders.visitor_id` present, and the **latest** `consent_records` row for `HMAC(visitor_id)` is `granted` with `ad_platform_measurement` | `no_consent_record` |
| 6 | Not already sent: no `capi_dispatch_log` row with this `event_id` and `status='sent'` | `already_sent` |
| 7 | `event_time ≥ now − 6 days 20 h`, where `event_time = delivered_at` / `rto_at` (or order `created_at` for Purchase). Meta rejects `event_time` more than 7 days in the past; the margin absorbs retries. A delivery that happened days after the order is therefore fine. This gate only trips when **the status was learned more than ~7 days after it happened** (e.g. Shiprocket connected late, or a long polling outage). | `event_too_old` |
| 8 | `dataset_id` configured | `no_dataset` |
| 9 | `fetchOrderContact` succeeds (Shopify re-fetch, SPEC v0.2) | `identity_fetch_failed` |

Then:
1. Normalise email/phone with `packages/privacy` (including the dummy-phone blocklist). Compute `sha256Hex` **in memory**; the raw and hashed values are never persisted or logged.
   - Phone for Meta: E.164 without the `+` (`+919812345678` → `919812345678`), matching Meta's rule "remove symbols, letters and leading zeros; include country code".
   - Email: trim and lowercase.
2. `fbp`/`fbc` from the visitor's latest events that carry `ad_platform_measurement`. If `fbc` is missing but an `fbclid` is on the landing event, `event-pipeline` has already built `fbc = fb.1.<ms>.<fbclid>` ([fbp and fbc](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc): `subdomainIndex = 1` and creation time in ms when built server-side).
3. `external_id = [hex part of HMAC(visitor_id)]`.
4. Upsert `capi_dispatch_log(status='queued', attempts+1)`; `POST /<dataset_id>/events`, plus `test_event_code` if set.
5. `200` with `events_received = 1` → `status='sent'`, `sent_at`. Otherwise see §5.

**Dedup semantics** ([deduplication](https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events)): Meta dedupes on `event_id` + `event_name`, within 48 h of the first event with that id.
- `DeliveredPurchase` and `RTO` are server-only, so the ids just make our own retries idempotent.
- `Purchase` would only dedupe against a browser event with the same `eventID`. The Shopify channel uses its own ids, so it **won't** dedupe: hence off by default, with a warning.

```mermaid
sequenceDiagram
  participant SR as shiprocket-sync
  participant Q as capi-dispatch
  participant PG as Postgres
  participant R as Redis (suppression)
  participant SH as Shopify (fetchOrderContact)
  participant M as Meta CAPI
  SR->>Q: CapiDispatchJob{DeliveredPurchase, orderId}
  Q->>PG: settings.capi, stores.child_directed, orders, latest consent_records
  Q->>R: suppression check (order hashes, HMAC(visitor))
  Q->>PG: already sent? event_time within 7 d?
  Q->>SH: fetch email/phone (Level 2)
  SH-->>Q: raw contact (in memory only)
  Q->>Q: normalise → SHA-256; drop raw
  Q->>M: POST /v25.0/<dataset>/events (system_generated, event_id=delivered_<id>)
  M-->>Q: events_received / error
  Q->>PG: capi_dispatch_log (sent | failed | skipped + code)
```

### 4.4 Test mode
`settings.capi.test_event_code` set → every event carries it and appears in Events Manager → Test Events. The dashboard shows "CAPI in test mode" until the code is cleared.

### 4.5 Disconnect
`DELETE /v1/integrations/:id` → delete the token from `encrypted_credentials`. `DELETE /{user-id}/permissions` de-authorises *user* tokens ([revoking permissions](https://developers.facebook.com/docs/facebook-login/guides/permissions/request-revoke)), but it isn't documented for BISU tokens. So the dashboard also tells the merchant to remove TruePath under Business Settings → Integrations. Then: stop the repeatable jobs; keep `ad_spend_daily` history (aggregate, no personal data); audit.

### 4.6 Health check

| Check | Failing state |
|---|---|
| Token valid (`GET me?fields=id`) | `needs_reauth` |
| Permissions granted | missing `ads_read` / `business_management` |
| App access tier | "Development access — insights rate-limited" until standard access |
| Last daily sync < 30 h | "Meta spend is stale" |
| CAPI dataset set and last `sent` < 7 days (if deliveries occurred) | "No DeliveredPurchase sent in 7 days" |
| CAPI skip mix | shows counts by skip code for 7 days (e.g. many `identity_fetch_failed` → protected data not approved) |
| Purchase enabled | a warning banner (double counting) |

### 4.7 Top-priority VERIFY: `system_generated` DeliveredPurchase as an optimisation event

**Question.** SPEC §8.3's core promise is "merchants can optimise campaigns toward DeliveredPurchase". Can a `DeliveredPurchase` sent with `action_source='system_generated'` and no `client_ip_address`/`client_user_agent` be selected, and actually used, as the conversion event of a Meta **Sales** campaign ad set?

**Test** (run in M2 against a design partner's or our own test Business Manager; owner: the Meta integration engineer):
1. **Plumbing**: with `settings.capi.test_event_code` set, send 5 synthetic `DeliveredPurchase` events (`system_generated`, `em`/`ph`/`fbp`/`fbc`/`external_id`, `value`, `currency`). Confirm they appear in Events Manager → Test Events with no errors or warnings, and record the Event Match Quality shown.
2. **Production signal**: clear the test code; let real delivered orders flow for ≥ 3 days (Meta needs real, non-test events to build a custom conversion).
3. **Custom conversion**: in Events Manager, create a custom conversion "Delivered Purchase" based on the custom event `DeliveredPurchase`, value-based if the option is offered.
4. **Selectability**: create a draft Sales campaign → ad set → Conversion location *Website* → conversion event. Check whether "Delivered Purchase" appears and can be selected. Try both *Website* and *Website and app* locations, and a value-optimisation (ROAS) goal if offered.
5. **Record**: screenshots, the date, the API version, and whether Meta shows any warning such as "event not eligible", "low match quality" or "website events require…".

**Pass** = selectable for conversion optimisation with no eligibility warning → keep the current design.
**Fail** (not listed, greyed out, or eligibility warnings tied to `action_source` / missing browser fields) → the fallback below goes to you for approval.

**Fallback (designed, NOT implemented; pending in HLD §8; counsel note):** send DeliveredPurchase/RTO as `action_source='website'` with the browser fields Meta requires.
- **UA**: not stored today (SPEC v0.5). The fallback would capture the raw UA of the `checkout_completed` event only, for marketing-consented visitors, in the same `capi_client_context` row and under the same TTL as the IP (encrypted together).
- **IP**: at `checkout_completed`, **only if the event's `consent_purposes` includes `ad_platform_measurement`**:
  - the Collector encrypts the client IP with a KMS data key (envelope, AES-256-GCM, a per-day data key cached in memory);
  - the ciphertext of `{ip, user_agent}` travels in the stream entry; neither value is ever stored in plaintext or logged;
  - `event-workers` writes it to a new Postgres table, `capi_client_context(store_id, order_id, ctx_ciphertext bytea, key_ref, expires_at)`.
- **Retention**: the row is deleted as soon as DeliveredPurchase or RTO for that order is `sent` or `skipped` terminally, or at `expires_at = checkout time + 14 days`, whichever comes first (hourly sweep). It is also deleted by erasure, withdrawal erasure and store erasure.
- **Use**: `capi-dispatch` decrypts in memory and sets `client_ip_address`, `client_user_agent`, `action_source='website'` and `event_source_url = https://<primary shop host>/` (Meta requires `event_source_url` for website events).
- **What changes**: this reverses the SPEC v0.2 "no IP to CAPI" decision for a narrow, consented, short-lived case.
- **Counsel note**: storing an encrypted IP for 14 days for marketing-consented shoppers, and transferring it to Meta (outside India) as part of the consented measurement purpose, needs sign-off, including the notice wording and the purpose list (`ad_platform_measurement`).

## 5. Failure modes

| Failure | Handling | Idempotency |
|---|---|---|
| Insights 17/613/80000/80004 | backoff; re-delay from `estimated_time_to_regain_access` | `ReplacingMergeTree` absorbs re-pulls |
| Insights 190 (token invalid) | `needs_reauth`; jobs paused | — |
| Async report stuck > 30 min | abandon, retry next schedule | — |
| CAPI 5xx / network | BullMQ backoff 30 s → 32 min, 6 attempts, each re-running the gates (gate 7 may then skip with `event_too_old`) | `event_id` + gate 6 |
| CAPI 400 (bad parameter) | `status='failed'`, no retry, alert (payload bug) | — |
| CAPI 4xx auth | `needs_reauth`; events wait in the queue (paused) up to their 7-day freshness | — |
| Shopify contact fetch fails | skip `identity_fetch_failed` (accepted rule) | — |
| Consent withdrawn between enqueue and send | gate 5 at execution → skip | — |
| DLQ `capi-dispatch-failed` | reviewed on the health screen; erasure jobs purge entries for erased orders | — |

## 6. Privacy touchpoints

| ID | How |
|---|---|
| P-5 | Only visitors whose latest consent includes `ad_platform_measurement`; `fbp`/`fbc` only from events stamped with that purpose. |
| P-3 | Withdrawal → latest record not `granted` (or deleted by the withdrawal erasure) → skip. |
| P-6 | Child-directed stores never send (gate 3). |
| §5.4 | `em`/`ph` computed at send time from the Shopify re-fetch, never stored; no IP; no UA; `external_id` is an opaque HMAC. Logs carry order id, event name and status only. |
| §5.9 | The only personal-data transfer outside India: hashed identifiers to Meta, for the consented measurement purpose. Listed as a recipient in `docs/dpdp/subprocessors.md`. |
| Erasure | Gate 4, plus the DSR purges `capi_dispatch_log.last_error` and DLQ jobs (privacy-dpdp §4.4). Events already delivered to Meta cannot be recalled; disclosed in the notice. |
| S-2 / S-4 | Token in `encrypted_credentials`; connect, settings (including the Purchase acknowledgement with user and time) and disconnect audited. |

## 7. Performance & limits

| Item | Target |
|---|---|
| Insights freshness | intraday every 3 h → meets SPEC §13 "ad spend < 3 h" during 09:00–24:00 IST |
| Insights calls per account per day | ~6 intraday + 1 daily, ~2–5 pages each: far under development-tier quota for accounts with ≥ 1 active ad |
| CAPI | per-event jobs; BullMQ limiter 20 requests/s per store; p95 send latency < 2 s |
| CAPI freshness | a DeliveredPurchase is sent within minutes of the Shiprocket update; hard stop at 7 days |
| Backfill | 90 days × 10 accounts in < 20 min |

## 8. Test plan

**Unit**
- Gate order, including a table test for every skip code.
- Phone → Meta format (`+919812345678` → `919812345678`) and SHA-256 test vectors; email normalisation.
- `event_time` freshness boundary (6 d 19 h 59 m passes, 6 d 20 h 01 m skips).
- Value from paise (net of refunds; RTO = total).
- `fbc` construction.
- `MetaSettingsPatch` refusing Purchase without the acknowledgement.

**Integration** (msw-recorded Graph API)
- Insights paging and async flow → `ad_spend_daily` rows with the correct `date` in the account timezone.
- Rate-limit header at 80% → pacing.
- Error 80004 → re-delay.
- CAPI happy path → `sent`; duplicate job → `already_sent`; withdrawn visitor → `no_consent_record`; child-directed → skipped; Shopify fetch 5xx → `identity_fetch_failed`; test code included.
- Log scan: no emails, phones or SHA-256 values in logs.

**§5.10 compliance tests supported**
- Test 2 (withdrawal → no CAPI): primary owner.
- Test 4 (logs).
- Test 5 (erased order → no CAPI, DLQ purged).
- Test 8 (audit on settings changes, including the Purchase opt-in).

## 9. Open questions
1. **Top priority — §4.7 optimisation test.** Its result decides between the current design and the IP/UA fallback. Opt-in `Purchase` follows the same outcome: `system_generated` now, `website` if the fallback is approved.
2. *(resolved: BISU token, non-expiring by default.)* **Access tier timeline risk**: production use needs **Advanced Access** to the Marketing API Access Tier. Per Meta's template, that requires ≥ **1,500 successful Marketing API calls in the prior 15 days with < 15% errors**. Plan in M0-7/M2 to generate that volume against test or design-partner accounts before App Review.
3. *(resolved: non-INR accounts rejected with a clear onboarding error; FX conversion is Phase 2, needing a daily rate source and an original-currency column.)*
4. **Minimal permission set.** Meta's template accepts `business_management` in place of `ads_management`, together with `ads_read` and `pages_read_engagement`. We request `ads_read` + `business_management`; `pages_read_engagement` is added only if App Review requires it (confirm during App Review — counsel not needed).
5. *(resolved: `ad_spend_daily.attribution_window` folded into SPEC v0.4.)*
6. **Purchase action type** (`omni_purchase` vs `offsite_conversion.fb_pixel_purchase`) — **VERIFY** against Ads Manager for a design partner.
