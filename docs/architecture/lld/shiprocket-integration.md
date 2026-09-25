# LLD — Shiprocket integration

> Names are defined in [HLD §8](../HLD.md#8-cross-cutting-concepts), including **delivery-status precedence**. Shiprocket's public API reference ([apidocs.shiprocket.in](https://apidocs.shiprocket.in/)) is a Postman collection whose endpoint details could not be retrieved for this review. Facts confirmed from Shiprocket's [API helpsheet](https://support.shiprocket.in/support/solutions/articles/43000337456-shiprocket-api-document-helpsheet) are cited. Endpoint paths, webhook payload fields and status ids are **VERIFY** until checked against the collection or a live account.

## 1. Purpose & scope

Shiprocket is the authoritative source for `in_transit`, `delivered`, `rto` and `cancelled`-before-pickup (HLD §8). This module:
- stores the merchant's API-user credentials and keeps a valid token;
- receives tracking webhooks at the neutral path `POST /webhooks/lp/:token` (Core API; "lp" = logistics provider, SPEC v0.4 §10) and treats them as **hints**;
- fetches authoritative status from the tracking API; polls every 6 h where webhooks are absent;
- maps Shiprocket statuses to our five statuses through a tested table;
- matches shipments to orders;
- applies the precedence rules, projects to `order_status`, and triggers `DeliveredPurchase`/`RTO` CAPI.

**Non-goals**
- Creating orders, shipments, labels or pickups (merchants do this in Shiprocket).
- NDR actions.
- Courier-level analytics beyond status.
- Other logistics providers (`logistics_provider` is an adapter slot, SPEC §2).

## 2. Interfaces

### 2.1 Endpoints (SPEC §10)

| Method & path | Purpose |
|---|---|
| `POST /v1/integrations/shiprocket` | Owner/admin. Body `{ storeId, email, password }` for the **API user** (created by the merchant under Settings → API, with an email not already on Shiprocket — [helpsheet](https://support.shiprocket.in/support/solutions/articles/43000337456-shiprocket-api-document-helpsheet)). Validated by logging in, then stored. Returns `{ webhook_url, webhook_token }` (the token shown once) for the merchant to paste into Shiprocket's webhook settings. Audit `integration_connected`. |
| `POST /webhooks/lp/:token` | Public tracking webhook (Core API). The path is neutral because Shiprocket may reject webhook URLs containing "shiprocket", "kartrocket" or short forms (such as "sr"). `:token` is the per-store webhook token; it identifies the store **and** the logistics provider (§4.3). Any header token Shiprocket also sends is checked as a second factor if configured. |
| `PUT /v1/integrations/:id/settings` | `status_overrides` (per-store mapping corrections), `rotate_webhook_token: true`. Audit. |

### 2.2 Queue job
`ShiprocketSyncJob{storeId, shipmentRef?}` on `shiprocket-sync` (HLD §8).

| Trigger | `shipmentRef` | `jobId` |
|---|---|---|
| Webhook hint | AWB | `sr:<storeId>:<awb>`, `delay: 15 000 ms` (debounces scan bursts) |
| Poll (repeatable, every 6 h) | omitted → all open shipments for the store | `sr-poll:<storeId>:<yyyymmddhh>` |
| Safety sweep (daily 04:00 IST) | omitted → open orders older than 7 days, even with webhooks active | `sr-sweep:<storeId>:<yyyymmdd>` |

### 2.3 Shiprocket API (adapter `packages/integrations/shiprocket`)

| Call | Detail |
|---|---|
| Login | `POST https://apiv2.shiprocket.in/v1/external/auth/login` `{email, password}` → `{token}`. The token **is valid 240 h (10 days)** and is sent as `Authorization: Bearer <token>` ([helpsheet](https://support.shiprocket.in/support/solutions/articles/43000337456-shiprocket-api-document-helpsheet)). |
| Track by AWB | `GET /v1/external/courier/track/awb/{awb}` (**VERIFY** path and response shape: `tracking_data.shipment_track[].current_status`, `shipment_status`, `shipment_track_activities[]`) |
| Track by order | `GET /v1/external/courier/track?order_id={channel_order_id}` (**VERIFY**) |
| List orders | `GET /v1/external/orders?page=&per_page=100&…` for the poll sweep, returning `channel_order_id`, `status`, `shipments[].awb` (**VERIFY** filters) |

```ts
export type ShiprocketCredentials = {       // encrypted_credentials only
  email: string; password: string;          // API user; needed to renew the 10-day token
  token: string; tokenExpiresAt: string;
  webhookTokenPrevious?: { sha256: string; validUntil: string };
};

export type ShiprocketStatusUpdate = {      // normalised adapter output; no customer data
  awb: string;
  channelOrderId: string | null;
  shiprocketStatusId: number | null;
  shiprocketStatus: string;                  // e.g. "DELIVERED", "RTO INITIATED"
  occurredAt: string;                        // scan / status timestamp → the source timestamp for precedence
};
```

### 2.4 Status mapping (`packages/integrations/shiprocket/status-map.ts`)
Matched on the upper-cased, trimmed status name (ids when known). Every name and id is **VERIFY** against the live status list; unmapped names are never defaulted (§4.5).

| Shiprocket status (name) | → `delivery_status` | Notes |
|---|---|---|
| NEW, INVOICED, READY TO SHIP, PICKUP SCHEDULED, PICKUP GENERATED, PICKUP QUEUED, MANIFEST GENERATED, OUT FOR PICKUP, PICKUP EXCEPTION | *(no change; stays `pending`)* | Recorded in `order_status_events` only |
| PICKED UP, SHIPPED, IN TRANSIT, REACHED AT DESTINATION HUB, OUT FOR DELIVERY, UNDELIVERED (NDR), DELAYED, MISROUTED | `in_transit` | |
| DELIVERED | `delivered` | `delivered_at = occurredAt` |
| RTO INITIATED, RTO IN TRANSIT, RTO OUT FOR DELIVERY, RTO NDR, RTO DELIVERED, RTO ACKNOWLEDGED | `rto` | `rto_at` = the first RTO status time |
| CANCELED, CANCELLATION REQUESTED (before pickup) | `cancelled` | only if `pending` (HLD §8) |
| LOST, DAMAGED, DESTROYED, DISPOSED OFF | `cancelled` | not delivered, revenue 0; `order_status_events.status='lost'` (Open question 3) |

Per-store `settings.status_overrides` (name → our status) are applied before the default table.

## 3. Data owned

| Item | Access | Notes |
|---|---|---|
| `integrations` (provider `shiprocket`) | write | `encrypted_credentials` = `ShiprocketCredentials` (**all secrets**). `settings` (non-secret): `webhook_token_sha256` (SHA-256 of a 32-byte random token — not reversible, so not a secret; used for lookup), `webhook_active` (bool), `last_webhook_at`, `last_poll_at`, `status_overrides`, `unmapped_statuses` (name → count, first/last seen), `match_key` (`order_id`\|`order_name`, §4.4) |
| `orders` | update | `delivery_status`, `delivered_at`, `rto_at` — only through the precedence rules; read `external_order_id` |
| `order_status_events` | insert | `source='shiprocket'`, `status` (our mapped status, or the raw class for no-change statuses), `occurred_at = occurredAt`, `raw_ref = <awb>:<statusId or name>:<occurredAt>`; unique `(order_id, source, raw_ref)` |
| ClickHouse `order_status` | insert | full-row projection (HLD §8) |
| BullMQ `capi-dispatch` | enqueue | `DeliveredPurchase` / `RTO` |

Possible addition (Open question 1): `orders.external_order_name` (e.g. `#1001`), if Shiprocket's `channel_order_id` for Shopify orders is the order *name* rather than the numeric id. This is **not added** until verified; it would be flagged in HLD §8 first.

## 4. Processing flow

### 4.1 Connect
1. `POST /v1/integrations/shiprocket` → adapter login. On failure → `422 invalid_credentials`.
2. Store the credentials and token (`tokenExpiresAt = now + 240 h`).
3. Generate the webhook token (32 random bytes, base64url). Store only its SHA-256 in `settings.webhook_token_sha256`; return the plaintext once, inside `webhook_url = https://api.<domain>/webhooks/lp/<token>`.
4. Register the 6-h poll and the daily sweep. `webhook_active = false` until the first valid webhook arrives. Audit.

### 4.2 Token upkeep
Before any call: if `tokenExpiresAt − now < 24 h`, re-login under a Postgres advisory lock (`hashtext('sr-token:' || store_id)`) and store the new token. `401` mid-call → re-login once and retry. A failed login → `needs_reauth` (the merchant probably changed the API-user password).

### 4.3 Webhook intake (Core API, `/webhooks/lp/:token`)
1. Raw-body route; body logging and Sentry body capture off (the payload may contain customer name, address or phone — **treated as PII; never persisted or logged**).
2. Take `:token` from the path. Compute its SHA-256 and look up `integrations WHERE settings->>'webhook_token_sha256' = $1` (any logistics provider — the row's `provider` selects the adapter), falling back to the previous-token hash during rotation. No match → `401`.
   - **Token-in-URL hygiene.** The Fastify route logger records the path as `/webhooks/lp/:token` (templated), never the value, and the log redaction hook also masks it. The Core API ALB access logs (30-day lifecycle, privacy-dpdp §4.11) *will* contain the full URL, so read access to that bucket is limited to the security role. Tokens are rotatable (`rotate_webhook_token`, 7-day overlap), and each is only good for submitting hints that are re-verified against the API anyway.
3. Parse only the `awb`, the status name or id, and the timestamp (**VERIFY** field names, e.g. `awb`, `current_status`, `current_status_id`, `current_timestamp`). Drop the rest.
4. Set `settings.webhook_active = true` and `last_webhook_at`. Enqueue `ShiprocketSyncJob{storeId, shipmentRef: awb}` (15 s debounce) → `200`.
5. The webhook's status is **not applied directly**. The worker re-reads it from the tracking API. This removes the need to trust the payload (forged or stale webhooks can't set `delivered`) and gives one code path for webhooks and polling.

### 4.4 Sync worker
1. Suppression isn't relevant to status updates themselves; CAPI gates handle it later.
2. **Collect updates**:
   - `shipmentRef` set → track by AWB;
   - poll/sweep → page through open orders: those with `delivery_status IN ('pending','in_transit')` and `created_at_platform > now − 60 days`, looked up via list/track. Rate-limited to 1 request/s per store (**VERIFY** Shiprocket's limits).
3. **Match to the order** (SPEC §8.5 "via channel order id"):
   - `match_key='order_id'` (default): `channel_order_id` = `orders.external_order_id`.
   - If the first 20 matches fail but the values look like `#\d+`, switch to `match_key='order_name'` and raise a health warning (this needs the Open question 1 column).
   - Unmatched shipments → metric plus health list (the first 20 AWBs, no customer data).
4. **Map** via §2.4 (overrides first). Unmapped → record in `settings.unmapped_statuses`, write the event row with `status='unmapped'`, leave `delivery_status` unchanged, and alert when an unmapped name appears more than 10 times.
5. **Apply** in one transaction (HLD §8 precedence):
   - `INSERT order_status_events … ON CONFLICT DO NOTHING RETURNING id` → a duplicate scan does nothing.
   - `occurredAt < max(occurred_at WHERE source='shiprocket')` → stale: event row only.
   - Transition rules:
     - `pending → in_transit|delivered|rto|cancelled`;
     - `in_transit → delivered|rto|cancelled(lost)`;
     - `delivered → rto` only (misreported delivery);
     - `rto` and `cancelled` are terminal;
     - `delivered` after `rto` is ignored and logged.
   - Update `delivery_status`, `delivered_at` / `rto_at`.
6. **Project** the full row to `order_status` (`source_updated_at = max(occurred_at)` across sources).
7. **CAPI** on the first transition into `delivered` → `CapiDispatchJob{eventName:'DeliveredPurchase'}`; into `rto` → `CapiDispatchJob{eventName:'RTO'}`. Toggles and gates are enforced in `capi-dispatch` ([meta-integration.md §4.3](meta-integration.md#43-capi-dispatch-capi-dispatch)). A `delivered → rto` correction also enqueues `RTO`; Meta keeps both events, and the merchant sees the correction in the journey view.
8. **Multi-shipment orders** (several AWBs per order): the order status is aggregated:
   - all shipments `delivered` → `delivered`;
   - any shipment still `in_transit` → `in_transit`;
   - all terminal and any `rto` → `rto` if no shipment was delivered, else `delivered`, with a `partial_rto` event row (Open question 2).

```mermaid
sequenceDiagram
  participant SR as Shiprocket
  participant API as Core API /webhooks/lp/:token
  participant Q as shiprocket-sync
  participant PG as Postgres
  participant CH as ClickHouse order_status
  participant C as capi-dispatch
  SR->>API: tracking webhook to /webhooks/lp/<token>
  API->>API: SHA-256(path token) → store; parse awb only; drop payload
  API->>Q: ShiprocketSyncJob{storeId, awb} (debounce 15 s)
  API-->>SR: 200
  Note over Q: or: 6-hourly poll / daily sweep
  Q->>SR: GET track/awb/{awb} (Bearer token, 10-day validity)
  SR-->>Q: current status + timestamp
  Q->>Q: status-map (+overrides); match channel_order_id → order
  Q->>PG: order_status_events (raw_ref dedupe); precedence guard; update delivery_status
  Q->>CH: project full row
  alt first transition to delivered / rto
    Q->>C: CapiDispatchJob DeliveredPurchase / RTO
  end
```

### 4.5 Capability flag (resolves the HLD §11 risk)
- `webhook_active` becomes true on the first valid webhook. It becomes false again if no webhook arrives for 72 h while the store has open shipments.
- The 6-h poll runs only for stores where `webhook_active = false`.
- The daily sweep runs for **all** stores, catching missed webhooks.
- The health screen shows "Webhook active / polling".

## 5. Failure modes

| Failure | Handling | Idempotency |
|---|---|---|
| Login fails | `needs_reauth`; polls paused; health prompt | — |
| Token expired mid-run | re-login once (advisory lock) | — |
| `429` / `5xx` | backoff 5 s → 5 min, 6 tries; poll resumes at the next window | — |
| Webhook token unknown | `401`; metric | — |
| Duplicate scan (webhook + poll) | `raw_ref` unique → no-op | `(order_id, source, raw_ref)` |
| Out-of-order status | per-source timestamp guard | — |
| Unmapped status | no status change, recorded and alerted | — |
| Shipment not matched to an order | health list; the sweep retries daily for 7 days | — |
| ClickHouse projection fails | the nightly `order-status-reconcile` repairs it | — |
| DLQ `shiprocket-sync-failed` | health screen | — |

## 6. Privacy touchpoints

| ID | How |
|---|---|
| §5.4 minimisation | We read only AWB, status and timestamps. Webhook and API payloads can include name, address and phone; they are parsed for the allowlisted fields and discarded, never persisted or logged. |
| S-2 | API-user email/password and token in `encrypted_credentials`; webhook token stored only as SHA-256. |
| S-6 | Webhook token rotation (`rotate_webhook_token`) with a 7-day overlap; API-user password rotation → reconnect. |
| S-4 | Connect, settings and rotation audited. |
| P-5 / P-6 / consent | Not applied here; enforced at `capi-dispatch` (meta-integration §4.3). |
| Erasure | Shiprocket data we hold is status-only and order-linked, so it is covered by order anonymisation and deletion (privacy-dpdp §4.4, §4.7). |

## 7. Performance & limits

| Item | Target |
|---|---|
| Freshness | webhook stores: minutes; polling stores: ≤ 6 h (SPEC §13) |
| Poll cost | ≈ open shipments / 100 list pages + tracking calls, at 1 request/s per store |
| Webhook handler | p95 < 100 ms (hash lookup + enqueue) |
| Open-order window | 60 days after placement; older orders still `pending` or `in_transit` are flagged "stuck" on the health screen |

## 8. Test plan

**Unit**
- Status map (every row, overrides, unmapped handling).
- Transition rules (including `delivered → rto`, and ignoring `delivered` after `rto`).
- Multi-shipment aggregation.
- Token-expiry decision; webhook token hashing and rotation window.

**Integration** (msw-recorded Shiprocket, Postgres, ClickHouse)
- Webhook with a valid token → debounced job → track call → `delivered` → projection → one `DeliveredPurchase` job.
- The same scan via webhook and poll → one event row.
- Out-of-order `IN TRANSIT` after `DELIVERED` → no change.
- `RTO INITIATED` → `rto`, `RTO` CAPI job.
- Forged webhook (bad token) → `401`.
- Valid token but a spoofed status in the payload → ignored (the API is the source of truth).
- Login `401` → `needs_reauth`.
- Log scan: no names, addresses or phones.

**§5.10 compliance tests supported**: Test 4 (logs) and Test 7 (webhook tokens resolve exactly one store; the query builder scopes by `store_id`).

## 9. Open questions
1. **`channel_order_id` format** for Shopify-channel orders in Shiprocket: numeric Shopify id or order name (`#1001`)? If it is the name, we need `orders.external_order_name` (a new column; would be flagged in HLD §8). **VERIFY** on a design partner's account.
2. **Partial RTO** (multi-shipment, some delivered and some returned). MVP counts the order as `delivered` at full value. Should delivered revenue be pro-rated by shipment value? That needs per-shipment amounts, which Shiprocket may or may not expose.
3. **Lost/damaged shipments** are mapped to `cancelled` (revenue 0). Is a separate `lost` status needed in the `delivery_status` enum for the RTO report?
4. *(resolved: neutral path `/webhooks/lp/:token`, SPEC v0.4 §10.)*
5. **Webhook payload fields** (`awb`, `current_status`, `current_status_id`, `current_timestamp`), whether Shiprocket also sends a header token, and the **status id list** — **VERIFY** against the Postman collection or a test webhook.

### Phase 2 note — stores without a logistics integration
Some merchants ship with their own couriers or with Shopify-native shipping, so there is no Shiprocket connection. In Phase 2, Shopify fulfilment `shipment_status` (carried on `fulfillments/update`, e.g. `delivered`, `failure`) could serve as a **low-confidence delivery source**:
- it would write `order_status_events(source='shopify_fulfilment')`;
- it would be accepted only for stores with no active logistics integration, and it would never override Shiprocket (HLD §8 precedence);
- delivered revenue from this source would be labelled "delivery unconfirmed" in reports.

Not in MVP. Carrier-reported fulfilment status coverage in India is uneven, and RTOs are often not reflected back to Shopify.
6. **Shiprocket rate limits** — not published in the helpsheet. **VERIFY** before raising the 1 request/s per-store pacing.
