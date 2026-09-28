# LLD — Shopify integration

> Names are defined in [HLD §8](../HLD.md#8-cross-cutting-concepts). Shopify API facts are cited inline and pinned to Admin API **`2026-07`** (latest stable; supported until 2027-07-16 — [versioning](https://shopify.dev/docs/api/usage/versioning)).

## 1. Purpose & scope

Everything TruePath does with Shopify:
- **Install and connection**: OAuth from the dashboard, `stores` and `integrations` records, **expiring** offline tokens with refresh, uninstall.
- **The Web Pixel extension**: config, creation, settings. The event contract is in [collector.md §2.2](collector.md#22-request-body-zod-packagessharedcollectorts); consent behaviour is in [privacy-dpdp.md](privacy-dpdp.md).
- **Webhooks** at `POST /webhooks/shopify/:topic` (Core API): HMAC verification, idempotency, the out-of-order guard, mapping orders to `orders` (including refunds), COD detection.
- **Privacy webhooks** into the DSR pipeline.
- **Backfill** (60 days now, 90 once `read_all_orders` is approved), daily **reconciliation**, and debounced single-order **refresh** on `shopify-sync`.
- **Protected customer data** (Level 2: email, phone, address) and behaviour when fields are `null`.
- The `IntegrationAdapter` implementation in `packages/integrations/shopify`, including `fetchOrderContact` for the CAPI send-time re-fetch.

**Non-goals**
- DSR processing — [privacy-dpdp.md](privacy-dpdp.md). This module only turns webhooks into `dsr_requests`.
- Order ↔ visitor stitching — [identity-stitching.md](identity-stitching.md).
- Delivery tracking. Shiprocket owns `in_transit`/`delivered`/`rto` (HLD §8 precedence).
- Products and catalogue (Open question 1).
- The embedded app's UI. It is minimal: connection status plus a dashboard link ([dashboard.md](dashboard.md)).

## 2. Interfaces

### 2.1 Endpoints (Core API; SPEC v0.3 §10, as modified by ADR-0024/ADR-0025 — M1-1)

| Method & path | Purpose |
|---|---|
| `GET /v1/orgs/:id/integrations/shopify/connect?shop=<name>.myshopify.com` | **ADR-0024**: nested under `/v1/orgs/:id`, not a flat path with `?orgId=` — reuses `requireOrgScope`/`requirePermission('integrations.manage')` like every other org-scoped route, and the generated cross-tenant harness covers it with no override. Validates the shop domain against `^[a-z0-9][a-z0-9-]*\.myshopify\.com$`, then `302` to `https://{shop}/admin/oauth/authorize?client_id&scope&redirect_uri&state`. `redirect_uri` is the one fixed URL below. `state` is **not a JWT** (ADR-0025): an HMAC-signed token (`userId`, `organizationId`, `shop`, `nonce`, `exp` = 10 min) whose `nonce` is also written to durable Redis (`oauth:shopify:state:<nonce>`, `EX 600`) as the actual single-use control. |
| `GET /v1/integrations/shopify/callback` | **Deliberately flat, no `:id`** (ADR-0024): Shopify's `redirect_uri` must exactly match one URL pre-registered in the app's own config, on the same host as the Application URL — it cannot carry a per-organization path segment. Verifies (ADR-0025): the state's HMAC signature and `exp`; that its nonce hasn't already been consumed (atomic GET-then-DEL); that the signed-in session's user matches the state's `userId`; that the `shop` query param matches the state's `shop`; and that the user still holds `integrations.manage` in the state's `organizationId` (re-checked live, in case of a role change between connect and callback). Every one of these failures replies the same `403 invalid_oauth_state`. On success: exchanges the code for an **expiring offline token + refresh token**, queries `shop { id myshopifyDomain currencyCode }`, upserts `stores`/`integrations` (credentials envelope-encrypted per ADR-0023), audits `integration_connected`, redirects to the dashboard. A shop already linked to a different org is `409 shop_linked_elsewhere`. **Not yet done in M1-1** (tracked as follow-ups): creating the Web Pixel, publishing the collector config, and enqueuing the backfill — each depends on a module (M1-4, M1-3) that doesn't exist yet. |
| `PUT /v1/integrations/:id/settings` | Owner/admin. Validated per provider (`ShopifySettingsPatch`: `cod_mapping`, confirmations for unmapped gateways). Secrets are rejected by schema. Audit `integration_settings_changed`. **Not built in M1-1** — no settings exist yet to change (M1-2+). |
| `DELETE /v1/orgs/:id/integrations/:integrationId` | **ADR-0024**: nested under `/v1/orgs/:id`, provider-agnostic (will also serve Meta/Google Ads integrations from M2). The integration is looked up *within* the already-established org scope (joined through `stores`), so a foreign integration id under the caller's own org id is the same 404 as a nonexistent one — no bootstrap primitive needed. Marks the integration revoked and wipes `encrypted_credentials`. **M1-1 does not call Shopify.** A real self-uninstall mutation exists (`appUninstall`, GraphQL Admin API ≥ 2026-07 — the exact version this codebase pins — "can only be used by apps to uninstall themselves," no arguments, called with the store's own offline access token, irreversible), so this is a corrected earlier claim, not a genuine API gap — see the tracked follow-up issue for calling it best-effort before wiping our copy. The dashboard also tells the merchant they can uninstall from Shopify admin directly. Audit `integration_disconnected`. |
| `POST /webhooks/shopify/:topic` | All Shopify webhooks. `:topic` is one of `orders | order-hints | app | compliance` (§2.2); `X-Shopify-Topic` is authoritative and must belong to that group. **M1-1 fully implements only `app/uninstalled` and the three compliance topics** (as a durable `dsr_requests` receipt, never a silent no-op — see §4.3/§4.8 below); `orders/*`, `order-hints/*` and `bulk_operations/finish` are acknowledged (`200`) but not processed until M1-2/M1-3 (tracked issue). No session or `:id`-shaped param authenticates this route — it is exempted from the CSRF/Origin hook and from the generated cross-tenant harness for the same reason: HMAC + a verified shop domain is the entire authentication story (ADR-0024). |

### 2.2 App configuration

`apps/shopify-app/shopify.app.toml` (syntax per [app configuration](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration)):

```toml
[access_scopes]
scopes = "read_orders,write_pixels,read_customer_events"   # + read_all_orders once approved (§2.3)

[webhooks]
api_version = "2026-07"

[[webhooks.subscriptions]]
topics = [ "orders/create", "orders/updated", "orders/cancelled" ]
uri = "https://api.<domain>/webhooks/shopify/orders"

[[webhooks.subscriptions]]
topics = [ "refunds/create", "fulfillments/create", "fulfillments/update" ]
uri = "https://api.<domain>/webhooks/shopify/order-hints"

[[webhooks.subscriptions]]
topics = [ "app/uninstalled", "bulk_operations/finish" ]
uri = "https://api.<domain>/webhooks/shopify/app"

[[webhooks.subscriptions]]
compliance_topics = [ "customers/data_request", "customers/redact", "shop/redact" ]
uri = "https://api.<domain>/webhooks/shopify/compliance"
```

`:topic` in our route is therefore one of `orders | order-hints | app | compliance`, and the handler dispatches on `X-Shopify-Topic`.

Web Pixel extension `extensions/truepath-pixel/shopify.extension.toml` (keys per [pixel privacy](https://shopify.dev/docs/api/web-pixels-api/pixel-privacy), [build web pixels](https://shopify.dev/docs/apps/build/marketing-analytics/build-web-pixels)):
- `type = "web_pixel_extension"`, `runtime_context = "strict"` (required).
- The `customer_privacy` block:

  ```toml
  [customer_privacy]
  analytics = true        # Shopify loads the pixel only with analytics consent (P-1)
  marketing = false       # not required to load; evaluated per event (CAPI eligibility)
  preferences = false
  sale_of_data = "enabled"
  ```

  `sale_of_data = "enabled"` is the documented value. It means the pixel also respects sale-of-data opt-outs; that is conservative and harmless for India.
- `[settings]` fields `storeKey`, `collectorUrl`, `signingKid`, `signingSecret`, `noticeVersion` (`single_line_text_field`). `webPixelCreate` fails if the settings don't match this schema.

### 2.3 Scopes and protected customer data

| Scope / access | Why | Approval |
|---|---|---|
| `read_orders` | Webhooks and queries. Covers the **last 60 days** ([access scopes](https://shopify.dev/docs/api/usage/access-scopes)). Also covers `customerJourneySummary` and `CustomerVisit` ([CustomerJourneySummary](https://shopify.dev/docs/api/admin-graphql/latest/objects/CustomerJourneySummary)). | none |
| `read_all_orders` | Extends the backfill from 60 to 90 days | **Shopify approval**. Applied for in M0-7, **non-blocking** (SPEC v0.3). Added to the scope string once approved; merchants then re-authorise and the backfill auto-extends (§4.7). |
| `write_pixels` + `read_customer_events` | `webPixelCreate` / `webPixelUpdate` ([webPixelCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/webPixelCreate), [webPixelUpdate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/webPixelUpdate)) | none |
| ~~`read_customers`~~ | **Not requested.** `Customer` needs `read_customers` ([Customer](https://shopify.dev/docs/api/admin-graphql/latest/objects/Customer)), but we don't need it: order-level `email`/`phone` and `shippingAddress.phone` give the identifiers, and `customerJourneySummary.customerOrderIndex` gives first-order status. | — |
| **Protected customer data, Level 2**: email, phone, **address** | Hashing (orders, pixel checkout contact, CAPI re-fetch); the shipping phone and **zip → `pincode_prefix`** (zip is a Level 2 address field — [protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data)) | Level 1 + Level 2 review for production. Dev stores work without it. In **M0-7**. Name is not requested. |

**Without approval**: unapproved fields return `null`, with an error in the GraphQL `errors` hash and HTTP 200. The mapper treats `null` as absent: no hash, no pincode, and CAPI skipped with `identity_fetch_failed`. The health check (§4.9) flags it.

**Level 2 requirements we must evidence**: backup encryption, environment separation, data-loss prevention, limited staff access, strong staff passwords, access logging, incident response. These map to S-2/S-3/S-4/S-5 and privacy-dpdp §4.11/§4.12.

### 2.4 Webhook topics

| Topic | Handler | Source timestamp (version) |
|---|---|---|
| `orders/create`, `orders/updated` | full snapshot apply (§4.4). On create also enqueue identity-stitch and a debounced `order_refresh` to fetch `customerJourneySummary` and refunds | payload `updated_at` |
| `orders/cancelled` | snapshot apply; `cancelled` per HLD §8 precedence | payload `updated_at` |
| `refunds/create`, `fulfillments/create`, `fulfillments/update` | Record `order_status_events` (idempotency and trail), then **debounced** `order_refresh`. These payloads are partial. | refund `created_at` / fulfillment `updated_at` for the event row |
| `app/uninstalled` | §4.8 | — |
| `customers/data_request`, `customers/redact`, `shop/redact` | → `dsr_requests` ([privacy-dpdp.md §2.3](privacy-dpdp.md#23-webhooks-routed-into-the-dsr-pipeline)) | — |
| `bulk_operations/finish` | enqueue `ShopifySyncJob{mode:'bulk_result', bulkOperationId}` | — |

Delivery rules ([HTTPS webhooks](https://shopify.dev/docs/apps/build/webhooks/subscribe/https), [best practices](https://shopify.dev/docs/apps/build/webhooks/best-practices)):
- respond `200`; 1 s connect and 5 s total timeout;
- 8 retries over 4 hours;
- no ordering guarantee within or across topics;
- deduplicate on `X-Shopify-Webhook-Id`;
- run reconciliation jobs.

### 2.5 Snapshot schemas

Webhook payloads are REST-shaped (the REST Admin API is legacy for requests since 2024-10-01; new public apps must use GraphQL for API calls — [REST Order](https://shopify.dev/docs/api/admin-rest/latest/resources/order)).

```ts
const MoneyString = z.string().regex(/^-?\d+(\.\d{1,2})?$/);         // e.g. "1299.00"
const Address = z.object({ zip: z.string().nullable().optional(), phone: z.string().nullable().optional() }).passthrough();

export const ShopifyOrderWebhook = z.object({
  id: z.number().int(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  cancelled_at: z.string().datetime({ offset: true }).nullable(),
  currency: z.string().length(3),
  total_price: MoneyString,
  total_outstanding: MoneyString.optional(),       // present on the REST Order resource; used for partial COD
  financial_status: z.string().nullable(),
  fulfillment_status: z.string().nullable(),
  payment_gateway_names: z.array(z.string()),
  email: z.string().nullable().optional(),         // Level 2
  phone: z.string().nullable().optional(),         // Level 2
  shipping_address: Address.nullable().optional(), // Level 2 (address)
  landing_site: z.string().nullable().optional(),
  referring_site: z.string().nullable().optional(),
  note_attributes: z.array(z.object({ name: z.string(), value: z.string().nullable() })).optional(),
  discount_codes: z.array(z.object({ code: z.string() }).passthrough()).optional(),
}).passthrough();                                  // everything else (customer, line items, names, addresses) is discarded
```

GraphQL order snapshot (backfill, reconcile, refresh — [Order](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order), [CustomerJourneySummary](https://shopify.dev/docs/api/admin-graphql/latest/objects/CustomerJourneySummary), [CustomerVisit](https://shopify.dev/docs/api/admin-graphql/latest/objects/CustomerVisit), [UTMParameters](https://shopify.dev/docs/api/admin-graphql/latest/objects/UTMParameters)):

```graphql
fragment OrderSnapshot on Order {
  id createdAt updatedAt cancelledAt email phone
  totalPriceSet { shopMoney { amount currencyCode } }
  totalRefundedSet { shopMoney { amount } }
  totalOutstandingSet { shopMoney { amount } }
  paymentGatewayNames displayFinancialStatus displayFulfillmentStatus
  discountCodes customAttributes { key value }
  shippingAddress { zip phone }
  customerJourneySummary {
    ready customerOrderIndex
    lastVisit  { landingPage referrerUrl utmParameters { source medium campaign content term } }
    firstVisit { landingPage referrerUrl utmParameters { source medium campaign content term } }
  }
}
```

Both shapes map to one internal `ShopifyOrderSnapshot`. For webhook snapshots, `refunded_amount_paise` is left unchanged, and `order_refresh` supplies it.

### 2.6 Queue job
`ShopifySyncJob{storeId, mode:'backfill'|'reconcile'|'bulk_result'|'order_refresh', bulkOperationId?, externalOrderIds?}` on `shopify-sync` (SPEC v0.3).

| mode | `jobId` | Notes |
|---|---|---|
| `backfill` | `shopify-backfill:<storeId>:<days>` | `days` = 60 or 90 |
| `bulk_result` | `shopify-bulk:<bulkOperationId>` | |
| `reconcile` | `shopify-reconcile:<storeId>:<yyyymmdd>` | |
| `order_refresh` | `shopify-refresh:<storeId>:<externalOrderId>` | **Debounced, 30 s**: enqueued with `delay: 30000`. While a job with that id is waiting or delayed, BullMQ ignores further adds with the same `jobId`, so a burst of `orders/create` + `refunds/create` + `fulfillments/*` for one order collapses into one fetch ~30 s after the first hint. `removeOnComplete: true`, so the next hint after completion schedules a new refresh. One job per order (`externalOrderIds` has length 1). |

### 2.7 Adapter (`packages/integrations/src/shopify`)

**M1-1 implements the subset OAuth install/uninstall needs.** `upsertWebPixel`, `startBulkOrders`,
`bulkResultUrl`, `ordersUpdatedSince`, `fetchOrder` and `fetchOrderContact` are added incrementally by
the tickets that need them (M1-3/M1-4/M4-1), not defined as unimplemented stubs ahead of time —
matching `packages/integrations`'s own M0-1 scaffold comment ("provider subfolders are added starting
M1-1"). `ShopifyCredentials` has no `pixelSigningKeys` yet, for the same reason (that's M1-4's job).

```ts
export interface ShopifyCredentials {           // stored only in integrations.encrypted_credentials,
  accessToken: string; accessTokenExpiresAt: string;   // envelope-encrypted per ADR-0023
  refreshToken: string; refreshTokenExpiresAt: string;
  scope: string;                                // comma-separated, as Shopify returns it
}

export interface ShopifyAdapter {   // SPEC §8's IntegrationAdapter, M1-1 subset
  provider: 'shopify';
  authUrl(shop: string, state: string, redirectUri: string): string;
  exchangeCode(shop: string, code: string): Promise<ShopifyCredentials>;
  refresh(shop: string, creds: ShopifyCredentials): Promise<ShopifyCredentials>;   // expiring offline tokens (§4.1) — not yet called anywhere in M1-1; wired in when a later ticket first needs a stored token
  shopInfo(shop: string, creds: ShopifyCredentials): Promise<{ gid: string; myshopifyDomain: string; currency: string }>;
  healthCheck(shop: string, creds: ShopifyCredentials): Promise<{ healthy: boolean; reason?: string }>;   // token validity only; the full health screen is M2-4
  verifyWebhook(rawBody: Buffer, hmacHeaderValue: string): boolean;  // current + previous client secret, timing-safe
}
```

**Credential storage** (ADR-0023): `integrationRepository.upsertShopify` — not the route or the
adapter — owns encryption. It resolves the row's id first (the existing row's id on re-auth, a freshly
generated one on first connect, both inside a Postgres advisory transaction lock keyed on the store, to
serialise concurrent connect attempts), then encrypts `JSON.stringify(credentials)` with that id bound
into the envelope's AAD, then writes the row. This ordering only exists because the AAD must bind the
row's *actual* id, which isn't known until the insert/update is about to happen.

## 3. Data owned

| Item | Access | Columns / notes |
|---|---|---|
| `stores` | create/update | `organization_id`, `platform='shopify'`, `shop_domain`, `currency`, `timezone` (`Asia/Kolkata`), `installed_at`, `status` (`active`\|`uninstalled`\|`deleted`) |
| `integrations` (provider `shopify`) | create/update | `external_account_id` (shop GID); `encrypted_credentials` (KMS envelope, `ShopifyCredentials` — **all secrets**); `scopes`; `status` (`active`\|`needs_reauth`\|`revoked`\|`error`); `last_synced_at`; `error`; `settings` (**non-secret only**: `store_key`, `shop_hosts`, `cod_mapping`, `unmapped_gateways`, `backfill {days, status, bulk_operation_id, started_at}`, `last_reconcile_at`, `pixel_id`) |
| `orders` | upsert | SPEC v0.3 columns per §4.5, including `refunded_amount_paise`; never `visitor_id` |
| `order_status_events` | insert | `source='shopify'`, `status` (`created`\|`updated`\|`cancelled`\|`refund`\|`fulfillment`), `occurred_at` (source timestamp), `raw_ref` = `X-Shopify-Webhook-Id` or `recon:<updatedAt>`; unique `(order_id, source, raw_ref)` |
| ClickHouse `order_status` | insert (full-row projection, HLD §8) | SPEC v0.3 columns |
| `dsr_requests` | insert (compliance webhooks) | via the privacy module |
| `shopify_webhook_deliveries` (**M1-1**, new — not in SPEC §6.1, flagged here per HLD §8's process) | insert | `store_id`, `webhook_id` (`X-Shopify-Webhook-Id`), `topic`, `received_at`; unique `(store_id, webhook_id)`; cross-topic dedup gate (§4.3) |
| Redis `collector:store:<store_key>` | publish | HLD §8 |
| BullMQ `identity-stitch`, `shopify-sync` | enqueue | |

## 4. Processing flow

### 4.1 Install and tokens
1. The onboarding wizard (after DPA acceptance, SPEC §11) → `connect?orgId&shop` → Shopify's consent screen.
2. `callback`: verify the query `hmac`; verify `state`; exchange the code. New public apps must use **expiring offline tokens**: the access token lasts 1 h (`expires_in: 3600`), and the refresh token lasts 90 days (`refresh_token_expires_in: 7776000`). Non-expiring offline tokens can't be used by new public apps for GraphQL Admin requests ([offline access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-token-types/offline-access-tokens)).
3. **Refresh** (inside the adapter, before any call):
   - If the access token expires in < 5 min, take a **Postgres advisory transaction lock** on `hashtext('shopify-token:' || store_id)`. This avoids a race between Core API and workers rotating the refresh token, and needs no new Redis key.
   - Re-read the credentials; if another process already refreshed, use its token. Otherwise call `refresh()`, store the new pair, and commit.
   - A failed refresh (refresh token expired or revoked) → `status='needs_reauth'` and syncs paused.
   - Daily reconciliation keeps the refresh token in regular use.
4. `shopInfo` → upsert `stores` (unique `shop_domain`) with the org from `state`. A shop linked to another org → `409 shop_linked_elsewhere`.
5. Generate `store_key = "pk_" + 24 base62` (→ `settings`) and a signing key `{kid:'s1', secret: 32 random bytes base64url}` (→ `encrypted_credentials`).
6. `upsertWebPixel` (settings `{storeKey, collectorUrl, signingKid, signingSecret, noticeVersion}`) → `settings.pixel_id`.
7. Publish `collector:store:<store_key>`: decrypt the signing keys, `status='active'` only if the current DPA is accepted (privacy-dpdp §4.10).
8. Enqueue `ShopifySyncJob{mode:'backfill'}` with `days = 90` if `read_all_orders` ∈ granted scopes, else 60. Integration `active`. Audit.
9. **Shopify-initiated installs** (App Store / admin) without a TruePath org: the embedded app shows "Connect this store to your TruePath account", which opens the dashboard connect flow with `shop` prefilled. No store row and no data collection exist until then.
10. **Embedded app session storage.** `shopifyApp()`'s `sessionStorage` is optional only for apps created in the Shopify Admin; ours is a Partner/CLI app, so we supply a custom adapter implementing the `SessionStorage` interface ([shopifyApp](https://shopify.dev/docs/api/shopify-app-react-router/latest/entrypoints/shopifyapp)). The adapter is backed by `integrations.encrypted_credentials`, so there is **no Session table**. Core API remains the only writer of tokens; the embedded app reads them and uses the same locked refresh path.

### 4.2 Webhook intake (Core API)
1. A raw-body parser for `/webhooks/shopify/*`. Body logging is disabled for these routes, and so is Sentry request-body capture.
2. `verifyWebhook(rawBody, X-Shopify-Hmac-SHA256)`: HMAC-SHA256 of the raw body with the app's client secret, base64, constant-time compare. The current and previous secrets are both accepted during rotation. Failure → `401`.
3. Resolve the store by `X-Shopify-Shop-Domain`. Unknown or deleted → `200` and drop. Compliance topics are handled for uninstalled stores too.
4. Dispatch on `X-Shopify-Topic`. Target `200` within **1 s** (the limit is 5 s); heavy work is enqueued.
5. Parse into a snapshot. Only mapped fields survive; **the payload is never persisted or logged**.

### 4.3 Idempotency
- **M1-1: a store-scoped webhook-delivery dedup runs before any topic handler, for every topic.**
  `shopify_webhook_deliveries` (unique on `(store_id, webhook_id)`) is written with
  `ON CONFLICT DO NOTHING` immediately after the store is resolved; a conflict (a Shopify retry, or
  any duplicate at-least-once delivery) short-circuits to `200` without dispatching to a handler at
  all — this is what makes `app/uninstalled` (and future `orders/*`/`order-hints/*` handling) a true
  dedup, not just idempotent-by-state. Old rows are cleaned up by a later retention job (not built
  yet; nothing needs to remember a delivery past Shopify's 8x/4h retry window).
- Order topics (**not yet implemented**, M1-2): `INSERT order_status_events (…, raw_ref = X-Shopify-Webhook-Id) ON CONFLICT (order_id, source, raw_ref) DO NOTHING RETURNING id`, in the same transaction as the order upsert — a second, order-scoped dedup layered on top of the delivery-level one above, since one order can legitimately receive several different webhook deliveries.
- Compliance: dedupe on `dsr_requests.result_summary.source_ref` (unique partial index on `(store_id, (result_summary->>'source_ref'))`) — redundant with the delivery-level dedup above, kept as defense in depth for the DSR row specifically.
- `bulk_operations/finish`: `jobId`. `app/uninstalled`: covered by the delivery-level dedup; also naturally idempotent by state as a backstop.

### 4.4 Order snapshot apply and out-of-order guard

**M1-2 implementation note**: the snapshot passed into this flow is always fully resolved *before*
this section's transaction ever opens — straight from the REST payload for `orders/*`, or via a
synchronous `fetchOrder` GraphQL call for `refunds/*`/`fulfillments/*` hints (§4.7). `orderRepository
.applySnapshot` (`packages/db`) has no reference to the Shopify adapter at all, by construction, so
it is structurally impossible for it to make a network call from inside its own transaction — this
was a specific M1-2 review requirement, not an incidental design choice.

1. `ts` = snapshot `updated_at` / `updatedAt`.
2. One transaction, in this order (**not** the reverse — see the concurrency note below):
   a. `INSERT ... ON CONFLICT (store_id, external_order_id) DO NOTHING`, using the snapshot's own
      values. Guarantees the row exists without racing a bare "SELECT, then insert if missing."
   b. `SELECT … FOR UPDATE` on the row — whichever of possibly several concurrent deliveries created
      it, or found it already there. Every concurrent delivery for this order serializes here.
   c. `last = max(occurred_at) FROM order_status_events WHERE order_id=? AND source='shopify'`.
3. If `ts < last` → **stale**: record the event row only. If `ts ≥ last` → apply §4.5. Fields owned by
   other sources are never touched: `visitor_id`, `delivered_at`/`rto_at`, and the
   `in_transit`/`delivered`/`rto` statuses.
4. HLD §8 precedence:
   - `cancelled_at` set **and** `delivery_status='pending'` → `cancelled`.
   - `refunded_amount_paise` is set from `totalRefundedSet` (GraphQL snapshots) under the same guard
     and never changes `delivery_status`. Delivered revenue = `max(0, total − refunded)` when
     `delivered`. A REST `orders/*` snapshot carries no `totalRefundedSet` at all — the repository
     leaves the stored value untouched rather than resetting it to 0.
5. **The actual idempotency decision** (issue #26) is `INSERT order_status_events (…, raw_ref)
   ON CONFLICT (order_id, source, raw_ref) DO NOTHING` — a unique constraint added in M1-2 (it was
   missing from the original schema; the webhook route's own delivery-dedup table, §4.3, is a
   fast-path only and has an accepted race window under genuinely concurrent duplicate deliveries,
   which this constraint closes). Two concurrent *first-ever* deliveries for the same new order are
   both correct: step 2a's `ON CONFLICT DO NOTHING` means only one of them creates the row, and step
   2b's lock serializes the rest.
6. After commit, project the full current row to ClickHouse `order_status`, with
   `source_updated_at = max(order_status_events.occurred_at)` across all sources — **not built in
   M1-2** (no ClickHouse writer exists yet; tracked with the other M1-6 work).
7. `IdentityStitchJob` enqueue on a new order — **not built in M1-2** (M1-7; no BullMQ queue exists
   yet, issue #27). `is_first_order` and `note_attributes`' `customerJourneySummary`-based UTM
   fallback are, for the same reason, **always** resolved via their documented fallback path in this
   ticket (§4.5), not just when Shopify's own enrichment is unavailable. `attribution_confidence`
   stays at its schema default (`NULL`, not `'high'`) until identity-stitching actually computes it —
   setting it either way here would be asserting a confidence level nothing has computed (M1-7 must
   backfill this column for orders M1-2 already created before it lands).
8. Webhooks only create orders with `created_at ≥ install_time − backfill days` — **not enforced in
   M1-2** (no install-time gating yet; every order webhook received is processed).

**M1-2 implementation note**: this diagram shows the target end-state, including the ClickHouse
projection and debounced-refresh queue neither of which M1-2 builds (§4.4 steps 6–7). What M1-2
actually does for a hint webhook is call `fetchOrder` synchronously, inline in the request — no
queue, no debounce, no delay — *before* opening any transaction, then applies the resulting full
snapshot the same way an `orders/*` webhook would. See `apps/api/src/shopifyOrderCredentials.ts`
(`fetchOrderWithTokenRefresh`) and `apps/api/src/routes/shopifyWebhooks.ts`
(`handleOrderHintWebhook`). This keeps the response within Shopify's 5-second budget only because
`fetchOrder` itself is capped at 2 attempts / a fixed 250 ms retry delay (§4.7) and fails fast
(throws, relying on Shopify's own webhook retry) if Shopify's GraphQL API is still throttling past
that — there is no BullMQ debounce to fall back on in M1-2, so a slow or throttled Shopify response
is a webhook failure, not a deferred job. Issue #27 tracks adding the debounce once M1-6's queue
infrastructure exists — it is more valuable there than as a delay in front of a call this ticket
already makes synchronous.

```mermaid
sequenceDiagram
  participant S as Shopify
  participant API as Core API /webhooks/shopify/:topic
  participant SH as Shopify GraphQL (fetchOrder, hints only)
  participant PG as Postgres
  participant CH as ClickHouse order_status
  participant Q as shopify-sync / identity-stitch
  S->>API: orders/updated or refunds/create (HMAC, X-Shopify-Webhook-Id)
  API->>API: verify HMAC; parse; hash email/phone; drop raw
  opt partial hint (refunds/*, fulfillments/*)
    API->>SH: fetchOrder (outside any transaction/lock; ≤2 attempts, 250ms delay, fails fast on sustained throttling)
    SH-->>API: full ShopifyOrderSnapshot, or thrown error (Shopify retries the webhook)
  end
  API->>PG: BEGIN; INSERT order (ON CONFLICT DO NOTHING); SELECT ... FOR UPDATE; INSERT order_status_events(raw_ref) ON CONFLICT DO NOTHING
  alt duplicate (order_id, source, raw_ref)
    API-->>S: 200 (no-op)
  else T ≥ last shopify event
    API->>PG: apply mapping (+cancelled if pending); COMMIT
    API->>CH: INSERT full row, source_updated_at = max over sources — not built in M1-2 (M1-6)
    API-->>S: 200
  else stale (T < last shopify event)
    API->>PG: keep event row only; COMMIT
    API-->>S: 200
  end
  Note over API,Q: order_refresh / IdentityStitchJob enqueue — not built in M1-2 (M1-7, issue #27)
```

### 4.5 Field mapping (`ShopifyOrderSnapshot` → `orders`)

| `orders` column | Source | Rule |
|---|---|---|
| `external_order_id` | `id` / GID numeric part | string |
| `created_at_platform` | `created_at` | UTC |
| `total_amount_paise` | `total_price` / `totalPriceSet.shopMoney.amount` | Decimal string → integer paise with **no float**: `parseMoneyToPaise` (`packages/integrations/src/shopify/mapper.ts`) splits on `.`, right-pads/truncates the fraction to 2 digits, and combines whole+fraction with plain JS `number` arithmetic (`mode: 'number'` on the Drizzle bigint column — a safe integer, not a `BigInt`; SPEC money values never approach `Number.MAX_SAFE_INTEGER`). A parsed value ≥ `ORDER_MONEY_SANITY_BOUND_PAISE` (₹10,00,00,000, i.e. `1_000_000_000` paise) is stored as-is but logged (`order_id`, `store_id`, no amount) so a parser bug doesn't scale silently. |
| `refunded_amount_paise` | `totalRefundedSet.shopMoney.amount` (GraphQL snapshots only) | same parser; a REST `orders/*` snapshot carries no field for this at all, so the repository leaves the previously stored value untouched rather than treating "absent" as "zero" |
| `currency` | `currency` | **M1-2 decision (review item 5): non-`INR` orders are rejected, not stored.** No downstream code (attribution, reports, `store_delivery_rates`) is currency-aware, so a merchant with a non-INR ad account or a stray non-INR order would have silently wrong paise values compounding into every rollup — the same failure mode SPEC §2/§15 already rejects for non-INR *ad accounts*. The handler checks `store.currency === 'INR'` **before** any money parsing and, if it fails, records only the `order_status_events` row (topic, timestamp) and skips `applyOrderSnapshot` entirely: no `orders` row, no amount, for that delivery. Revisit only if a design partner actually needs multi-currency, as a new ticket + ADR, not silently. |
| `payment_method` | gateways (§4.6) | `cod`\|`prepaid`\|`partial_cod` |
| `financial_status` / `fulfilment_status` | `financial_status` / `display*` | lowercased; `null` fulfilment → `unfulfilled` |
| `delivery_status` | `pending` on insert; §4.4 step 4 | Shiprocket owns the rest |
| `pincode_prefix` | `shipping_address.zip` | digits only; first 3 if 6 digits, else `NULL` (Level 2 address) |
| `phone_hash_hmac` | `phone ?? shipping_address.phone` | `normalisePhone` (dummy blocklist → `null`) → `hmac`; raw discarded |
| `email_hash_hmac` | `email` | `normaliseEmail` → `hmac` |
| `landing_site` | `landing_site`, else `customerJourneySummary.lastVisit.landingPage`, else `firstVisit.landingPage` | `sanitiseUrl` |
| `referring_site` | `referring_site`, else `lastVisit.referrerUrl` | `sanitiseUrl`, origin + path |
| `note_attributes` | `note_attributes` / `customAttributes`, plus `lastVisit.utmParameters` when the landing page has no UTMs | **allowlist**: keys `utm_source\|medium\|campaign\|content\|term`, `fbclid\|gclid\|gbraid\|wbraid` only; everything else dropped |
| `discount_codes` | codes | as-is (approved: codes can be personalized, e.g. `RAHUL10` — issue #25 now tracks that erasure must cover this column too) |
| `is_first_order` | `customerJourneySummary.customerOrderIndex` ("position of the current order within the customer's order history") | `= 1` → `true`. **In M1-2** `customerJourneySummary` is never queried at all (`ORDER_QUERY` in `adapter.ts` omits it — no BullMQ refresh job exists yet to re-check `ready`), so this field always takes the fallback path: `true` unless an earlier order in `orders` has the same phone/email HMAC. Once M1-6/M1-7 land the refresh job, this becomes the primary path and the fallback stays for guests/`ready=false`. |
| `attribution_confidence` | — | Left `NULL` (schema default; **not** `'high'`) by every M1-2 write path. Asserting a confidence level before identity-stitching (M1-7) has run would be asserting something nothing computed. M1-7 must backfill this column for every order M1-2 creates before it lands (tracked on the M1-7 issue). |

**Erased identity at webhook time** (HLD §6b): if any computed HMAC (under every read key version) is in `suppress:<s>:erased:identity`, both hashes are stored `NULL`, no stitch job is enqueued, and the order counts toward revenue totals only.

**Validation failures never log received values** (M1-2 review item 6): a payload that fails its zod
schema (`webhookSchemas.ts`) is logged with only the issue's field `path` (e.g. `total_price`,
`shipping_address.zip`) — never `.message` or the value itself, since a zod message can echo the
input it rejected. `reportValidationFailure` / `zodIssuePaths` in `shopifyWebhooks.ts` enforce this;
`shopifyWebhooks.test.ts` plants a distinctive "poison" string in an invalid field and asserts it
never appears in the captured log output.

### 4.6 COD detection
- Config `integrations.settings.cod_mapping = { cod: string[], partial_cod: string[], prepaid: string[] }`, as lowercase substrings, editable through `PUT /v1/integrations/:id/settings`.
- **Defaults** (gateway names **need design-partner data**):
  - `cod`: `"cash on delivery"`, `"cod"` (exact token), `"cash_on_delivery"`. Shopify's own example gateway name is `"Cash on Delivery (COD)"` ([REST Order](https://shopify.dev/docs/api/admin-rest/latest/resources/order)).
  - `partial_cod`: `"partial cod"`, `"partial_cod"`.
  - `prepaid`: `"shopify_payments"`, `"razorpay"`, `"payu"`, `"cashfree"`, `"phonepe"`, `"paytm"`, `"ccavenue"`, `"gokwik"`, `"snapmint"`, `"simpl"`.
- Evaluation order (first match wins):
  1. any `partial_cod` gateway → `partial_cod`;
  2. a `cod` gateway together with a `prepaid` gateway, **or** a `cod` gateway with `0 < total_outstanding < total_price` → `partial_cod`;
  3. any `cod` → `cod`;
  4. any `prepaid` → `prepaid`;
  5. **unmapped**: `financial_status='pending'` → `cod`, else `prepaid`. The name is recorded in `settings.unmapped_gateways` (count, first/last seen) and surfaced with "Is this COD?" buttons.
- A mapping edit → `ShopifySyncJob{mode:'reconcile'}` over the backfill window to re-derive `payment_method`.

### 4.7 Backfill, bulk results, reconciliation, refresh (`shopify-sync`)

**M1-3 / M1-3b status**: the `shopify-sync` BullMQ queue exists, and the OAuth callback enqueues
`{mode:'backfill', days}` on every successful connect. `backfill` starts the bulk query and records
`settings.backfill {days, status:'running', bulk_operation_id, started_at}`; the `bulk_operations/finish`
webhook enqueues `bulk_result`, which streams the JSONL through §4.4 and finishes the record with
`status`, `orders_applied`, `orders_reported` (Shopify's own `rootObjectCount`, for reconciliation),
`invalid_lines` and `finished_at`. Both modes refresh an expired access token once on a 401.
Deviations from the text below, all deliberate:
- The `bulk_result` job id is `bulk-result-<n>`, not `shopify-bulk:<id>` — BullMQ custom job ids can't
  contain `:`.
- Orders are applied one at a time, each in its own transaction, not in batches of 1,000.
- A result with any unreadable line applies the rest, then fails the job and marks the backfill
  `failed` (`error_code: invalid_lines`) instead of reporting a partly-read backfill as complete.
- Not built, tracked in issue #41: the `partialDataUrl` restart, `IdentityStitchJob` enqueueing (waits
  on the `identity-stitch` queue, M1-7), the audit row for backfill counts, `reconcile`,
  `order_refresh`, the 60→90-day auto-extend, and the up-to-5-concurrent-queries accounting.

- **`backfill`**:
  - `startBulkOrders(since = now − days)`, where `days` = 60 without `read_all_orders`, else 90.
  - Up to 5 concurrent bulk queries per shop are allowed from API 2026-01 ([bulk queries](https://shopify.dev/docs/api/usage/bulk-operations/queries)); we use 1.
  - **Auto-extend**: when a re-authorisation adds `read_all_orders`, enqueue `backfill` with `days = 90` for the 60–90-day range only (`untilIso = now − 60 d`, or the earliest order already held).
- **`bulk_result`**:
  - **Stream** the JSONL from the signed URL (valid one week); nothing touches disk or S3.
  - Apply each line through §4.4 with `raw_ref = recon:<updatedAt>`, in batches of 1,000.
  - Bulk-enqueue `IdentityStitchJob{attempt:2}` and project each batch.
  - If only `partialDataUrl` is available, process it and restart from the last `createdAt` seen.
  - Set `settings.backfill.status='done'`, `last_synced_at`; audit counts.
- **`reconcile`** (daily 03:30 IST, `SystemScope` fan-out):
  - `ordersUpdatedSince(last_reconcile_at − 1 h)`, 250 per page, applied through §4.4. More than 10,000 changed orders → bulk instead.
  - Refreshes `shop_hosts` and republishes the collector config on change. Keeps the refresh token in use.
  - **Consent-region check** (SPEC v0.6, if the scope is approved): `consentPolicy(countryCode: IN) { consentRequired }` ([consentPolicy](https://shopify.dev/docs/api/admin-graphql/latest/queries/consentPolicy)). `consentRequired = false` → republish the collector config `inactive` (`consent_policy_not_required`), with a banner and email (privacy-dpdp §4.13). The query also runs at onboarding step 8. The required access scope isn't documented — **VERIFY** in a dev store (pending in HLD §8).
- **`order_refresh`**: `fetchOrder` → §4.4 (debounced as in §2.6). **Not built in M1-2**: M1-2's
  `refunds/*`/`fulfillments/*` handlers call `fetchOrder` synchronously inline instead (§4.4), since
  no `shopify-sync` queue exists yet to debounce into. Issue #27 tracks adding this job and moving
  hint-triggered refreshes onto it.
- **Rate limits** ([GraphQL rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits)):
  - The calculated-cost leaky bucket restores 100 points/s (Standard), 200 (Advanced), 1,000 (Plus), 2,000 (Commerce Components).
  - A single query may not exceed 1,000 points.
  - The client reads `extensions.cost.throttleStatus.{maximumAvailable, currentlyAvailable, restoreRate}` after every call and waits until the next page's requested cost is available. Bucket size is not hard-coded; `maximumAvailable` is used.
  - `THROTTLED` → backoff 1 s → 32 s, 6 tries.

### 4.8 Uninstall and privacy webhooks
- **`app/uninstalled`**:
  - `stores.status='uninstalled'`; the integration becomes `revoked` and the tokens are wiped from `encrypted_credentials`;
  - collector config `inactive`; the store's repeatable jobs paused;
  - export banner; audit `integration_disconnected`;
  - data is kept until `shop/redact` (privacy-dpdp §4.7).
- **Compliance**:
  - `customers/data_request` → `dsr_requests(type='access')`;
  - `customers/redact` → `type='erasure'` (plus `result_summary.orders_to_redact`);
  - `shop/redact` → `type='store_erasure'`.

  All with `trigger='shopify_webhook'` and `source_ref`. Payload email/phone are hashed in memory and discarded. `200` after commit. Shopify's deadline is 30 days ([privacy compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)); ours is 7 days.

  **M1-1 scope note**: this ticket implements the *receipt* only — inserting the `dsr_requests` row,
  deduped on `(store_id, source_ref)` so a retried webhook delivery never creates a second row. It does
  not implement *fulfilment* (actually exporting or erasing the shopper's data). Not fulfilling these
  requests within the SLA is a compliance failure, so that pipeline is tracked as a launch-blocking
  follow-up issue, not deferred silently. `identity_hash` is nullable (corrected from the original
  schema, which had it `NOT NULL`) specifically for `store_erasure`, which is store-wide and carries no
  shopper identity — see privacy-dpdp.md's own line for this mapping, which already specified `null`.

### 4.9 Health check (SPEC M2-4)

| Check | Failing state shown |
|---|---|
| Token valid and refreshable | `needs_reauth` → "Reconnect Shopify" |
| Scopes ⊇ required | "Missing scope: …". `read_all_orders` missing → informational "Backfill limited to 60 days" |
| Protected data present (last 20 orders have any email/phone hash) | "Protected customer data not approved — attribution and CAPI limited" |
| Pixel installed (`settings.pixel_id` exists via the `webPixel` query) | "Pixel missing — reinstall" |
| **Consent region** (SPEC v0.6): India opt-in confirmed; `consentPolicy(IN).consentRequired` (if available); default-on signal (`consent_health`) | "Tracking disabled: confirm India requires opt-in" / "India isn't set to require consent" / "Many visitors tracked without banner interaction" |
| **Pixel coverage** (last 7 days): orders with `attribution_confidence='high'` ÷ all orders (reporting-api §4.2) | < 50% warn, < 25% error: "Only 31% of orders matched a tracked visit — check your consent banner and that the pixel is installed". `attribution_confidence` is `NULL` for every order until M1-7's identity-stitching sets it (§4.5), so this check reads 0% until M1-7 lands — expected, not an M1-2 bug. |
| Last webhook < 24 h (if orders exist) | "No Shopify webhooks in 24 h" |
| Unmapped gateways | list with COD / prepaid choice |
| Currency ≠ INR | **M1-2 decision (§4.5): non-INR orders are rejected outright, not stored-and-flagged as this row previously said.** Shown as "Orders skipped: store currency isn't INR — N orders since <date> weren't recorded" once M2-4 builds this screen; M1-2 itself only logs the skip (`order_status_events` row only, no `orders` row). |

## 5. Failure modes

| Failure | Behaviour | Recovery |
|---|---|---|
| HMAC invalid | `401`, metric `shopify_webhook_hmac_failed_total` | Shopify retries; check the secret rotation |
| Handler > 5 s or error | Shopify retries 8× / 4 h | idempotency makes retries safe; daily reconcile |
| Out-of-order snapshot | stale → event row only | §4.4 guard |
| Burst of hints for one order | collapsed into one refresh ~30 s later | §2.6 debounce |
| Postgres down during a webhook | `503` → retried | as above |
| ClickHouse down after the Postgres commit | projection write fails, logged; the webhook still returns `200` | nightly `order-status-reconcile` re-projects |
| Protected fields `null` | no hashes; stitching limited to `order_id`; CAPI skipped | health flag |
| Access token expired, refresh fails | `needs_reauth`; syncs paused | re-run connect |
| Concurrent refresh | advisory lock serialises; the loser reuses the new token | §4.1 |
| Bulk operation failed | retry once after 10 min, then integration `error` | manual retry button |
| Throttled | wait on `currentlyAvailable` / backoff | — |
| Shop linked to another org | `409` | support |
| Client-secret rotation | both secrets accepted for 7 days (S-6) | — |

Dead letters: `shopify-sync-failed`. Webhooks have no DLQ; Shopify retries plus reconciliation replace one.

## 6. Privacy touchpoints

| ID | How |
|---|---|
| P-1 / P-5 | `customer_privacy.analytics = true` (loads only with analytics consent); marketing evaluated per event. |
| P-6 | `child_directed` propagated to the collector config. |
| §5.4 | Email, phone and address are used only to derive HMACs and `pincode_prefix`, in memory. `read_customers` and names are not requested. `note_attributes` allowlisted; URLs sanitised; dummy phones never hashed. Raw webhook bodies and bulk JSONL are never persisted or logged. |
| §5.6 / §5.7 | Compliance webhooks → DSR (7-day SLA vs Shopify's 30); `shop/redact` → `store_erasure`. |
| Erasure | Erased-identity check on every snapshot. |
| S-2 | All secrets (access/refresh tokens, pixel signing keys) only in `encrypted_credentials` (SPEC v0.3 rule). |
| S-4 | Audit on connect, disconnect, settings edits and compliance webhooks. |
| S-6 | Client-secret rotation overlap; pixel key rotation via `webPixelUpdate` with a new `kid` (the Collector accepts two). |
| Level 2 | Evidence mapped to S-2/S-3/S-4/S-5 and privacy-dpdp §4.11/§4.12. |

## 7. Performance & limits

| Item | Target |
|---|---|
| Webhook handler | p95 < 300 ms, p99 < 1 s (Shopify limit 5 s) |
| Webhook volume | ~5 per order lifecycle; sized for 50/s per Core API task |
| Refresh | ≤ 1 per order per 30 s (debounce); ≤ 5/s per store (BullMQ limiter); ~10–20 points per snapshot query |
| Backfill | 60 days (~20k orders) in < 10 min; 90 days in < 15 min |
| Reconcile | daily; 250 per page; paced by `throttleStatus` |
| Order money sanity bound | ≤ ₹1,00,00,000 per order; larger → flagged |

## 8. Test plan

**Unit**
- Money parser (`"1299"`, `"1299.5"` → 129950, `"0.01"`; no float path).
- Refunded amount; delivered revenue floor at 0.
- COD mapping (defaults, partial COD by outstanding, unmapped + `pending` → `cod`).
- `note_attributes` allowlist; `pincode_prefix`.
- Topic path ↔ header; HMAC with current and previous secret; `state` JWT expiry and user mismatch.
- Token refresh when < 5 min left.
- Debounce: 5 hints in 10 s → 1 refresh job.

**Integration** (webhook fixtures, msw-recorded GraphQL)
- `orders/create` → order row, event row, projection, stitch job and one refresh.
- Duplicate webhook id → one apply.
- `orders/updated` T2 then T1 → T2 wins.
- `orders/cancelled` while `pending` → `cancelled`; while `in_transit` → unchanged.
- `refunds/create` → refresh → `refunded_amount_paise` set, `delivery_status` unchanged.
- Protected fields `null` → no hashes, health flag.
- Erased identity → null hashes, no stitch job.
- Bulk JSONL with a partial URL.
- Re-auth adding `read_all_orders` → 60–90-day backfill only.
- Concurrent refresh from two processes → a single rotation.
- `app/uninstalled` → collector config inactive.
- Compliance webhooks → `dsr_requests` with `trigger='shopify_webhook'`; duplicates deduped; bad HMAC → `401`.
- Log scan: no emails, phones or zips (§5.10 test 4).

**§5.10 compliance tests supported**
- Test 3: projection holds no identifiers.
- Test 4: logs.
- Test 5: `customers/redact`.
- Test 7: the store is resolved from the signed shop domain, so a webhook can't touch another store.
- Test 8: audit.

## 9. Open questions

**Resolved in batch-2 review**
- Connect parameters and `PUT /v1/integrations/:id/settings` (SPEC v0.3).
- `read_all_orders` is non-blocking.
- Full-snapshot refresh.
- Refunds (net delivered revenue).
- Secrets only in `encrypted_credentials`.
- VERIFY items resolved from docs (cited inline): TOML keys, `customer_privacy` keys, `read_customers` not needed, `total_outstanding`, `customerJourneySummary`, `webPixelCreate`/`webPixelUpdate`, expiring offline tokens, throttle rates, session storage.

**Open**
1. *(resolved: `read_products` dropped — SPEC v0.5 §8.1.)*
2. **Discount codes** can be personalised ("RAHUL10"). Store as-is (SPEC), or store only a hash plus the discount type?
3. **Guest-checkout `is_first_order`** falls back to our own history when `customerOrderIndex` is unavailable, which overstates "new" customers early on.
4. **Pixel order-id format** (`checkout.order.id`) isn't documented; the normaliser accepts both a GID and a numeric id. Dev-store test.
5. **COD gateway names** — needs design-partner data.
