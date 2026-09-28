# LLD — Privacy & DPDP module

> Names (queues, keys, tables, job payloads) are defined once in [HLD §8](../HLD.md#8-cross-cutting-concepts) and used here verbatim. Requirement IDs refer to [SPEC §5](../../SPEC.md#5-dpdp-compliance-requirements-hard-requirements).

## 1. Purpose & scope

This module turns SPEC §5 into code paths. It covers:

- **`packages/privacy`** — phone/email normalisers, SHA-256 and tenant-HMAC hashing, the `ConsentProvider` interface, URL/log redaction, the suppression-set client, and the audit-log writer. Every other module imports these rather than reimplementing them.
- **Consent evidence** — the semantics of `consent_records` rows. `event-workers` performs the insert ([event-pipeline.md](event-pipeline.md)).
- **Suppression set** — erasure and withdrawal suppression, and its rebuild and fail-closed behaviour (HLD §8).
- **Data-principal requests (DSR)** — access, erasure and correction via Core API and the `dsr` worker, including Shopify's mandatory privacy webhooks and tenant offboarding (`store_erasure`).
- **Retention** — the nightly `retention` worker.
- **Privacy settings and DPA gating** — `privacy-settings` endpoints and `dpa_acceptances`.
- **Audit log** — the writer, the action catalogue, and access to `GET /v1/orgs/:id/audit-log`.
- **Breach register** — `breach_incidents` tooling and tenant notification.

**Non-goals**
- Legal text (shopper notice, DPA, RoPA, breach runbook). Counsel drafts these (SPEC M0-7); this LLD only lists the engineering facts they must reflect ([docs/dpdp/README.md](../../dpdp/README.md)).
- The consent banner itself. The merchant's Shopify banner or CMP feeds the Customer Privacy API; we only read it.
- Integrating a registered Consent Manager (P-7). Only the interface ships in MVP.
- Age verification. P-6 is a per-store setting, not per-shopper detection.
- The Collector request path and the stream consumer. Those are [collector.md](collector.md) and [event-pipeline.md](event-pipeline.md); this module supplies the functions they call.

## 2. Interfaces

### 2.1 `packages/privacy` — TypeScript

```ts
export type StoreId = string & { readonly __brand: 'StoreId' };
export type Purpose = 'attribution_analytics' | 'ad_platform_measurement';

// Normalisers — return null when the input is not a usable identifier (never hash garbage).
export function normalisePhone(raw: string, defaultCountry: 'IN' = 'IN'): string | null; // E.164, e.g. "+919812345678"
export function normaliseEmail(raw: string): string | null;                               // trim + lowercase

// Hashing
// Unsalted SHA-256 for Meta CAPI is `sha256ForMetaCapi(field, raw)` in the separate entry point `@truepath/privacy/meta-capi`
// (Meta's normalisation; only packages/integrations/meta may import it — eslint.config.js, ADR-0020 / M0-5).
export type KeyVersion = `k${number}`;
export type VersionedHmac = `${KeyVersion}:${string}`;                                     // e.g. "k1:3f9a…" (64 hex)
// M0-5: a context picks the key — a store, or a platform purpose for hashes that belong to no tenant.
export type HashContext = { kind: 'store'; storeId: StoreId } | { kind: 'purpose'; purpose: HashPurpose };
export type HashPurpose = 'rate_limit_ip' | 'rate_limit_email';                            // closed list; add one per distinct use
export interface IdentityHasher {                                                          // was TenantHasher
  readonly writeVersion: KeyVersion;                                                       // IDENTITY_KEY_WRITE
  readonly readVersions: readonly KeyVersion[];                                            // IDENTITY_KEY_READ, includes writeVersion
  hmac(context: HashContext, value: string): VersionedHmac;                                // under writeVersion — use for writes
  hmacAll(context: HashContext, value: string): VersionedHmac[];                           // one per readVersion — use for lookups
  hashEmail(context: HashContext, raw: string): VersionedHmac | null;                      // normalise, then hash; null if unusable
  hashPhone(context: HashContext, raw: string): VersionedHmac | null;                      // (+ hashEmailAll / hashPhoneAll)
}
export type HashedIdentity = {
  phoneHmac?: VersionedHmac;
  emailHmac?: VersionedHmac;
  identityHashHmac?: VersionedHmac;                                                        // phoneHmac ?? emailHmac (SPEC §7.3 rule 3)
  lookup: VersionedHmac[];                                                                 // phone+email under every read version
};
export function hashContact(h: IdentityHasher, storeId: StoreId,
  contact: { phone?: string; email?: string }): HashedIdentity;                            // raw values never leave this call

// Consent (P-7: pluggable so a Consent Manager can replace Shopify later)
export type ConsentSignal = {
  source: 'shopify_customer_privacy';
  analytics: boolean;          // analyticsProcessingAllowed
  marketing: boolean;          // marketingAllowed
  noticeVersion: string;
};
export type ConsentDecision = {
  purposes: Purpose[];         // stamped on the event as consent_purposes
  canStore: boolean;           // purposes includes 'attribution_analytics'
  canSendToAdPlatforms: boolean;
};
export interface ConsentProvider {
  readonly id: ConsentSignal['source'];
  evaluate(signal: ConsentSignal, store: { childDirected: boolean }): ConsentDecision;
}

// Suppression (HLD §8)
export type SuppressionReason = 'erased' | 'withdrawn';
export interface SuppressionClient {
  isReady(): Promise<boolean>;                                                              // suppress:ready present
  isVisitorSuppressed(storeId: StoreId, visitorHmac: string,
    opts: { includeWithdrawn: boolean }): Promise<SuppressionReason | null>;
  isIdentitySuppressed(storeId: StoreId, identityHashHmac: string): Promise<boolean>;
  add(storeId: StoreId, entry: {
    identifierType: 'visitor_id' | 'identity_hash_hmac';
    identifier: string;         // always an HMAC
    reason: SuppressionReason;
    dsrRequestId?: string;
  }): Promise<void>;            // Postgres first, then Redis
  removeWithdrawn(storeId: StoreId, visitorHmac: string): Promise<void>;
  rebuildAll(scope: SystemScope): Promise<{ stores: number; entries: number }>;
}

// Redaction
export function sanitiseUrl(url: string): string;        // allowlisted query params, token paths masked (collector.md §4 step 9)
export function sanitiseReferrer(url: string): string;  // origin + path only, same token masking (M0-5)
export function redactLogValue(value: unknown): unknown; // used by the pino redaction hook and Sentry beforeSend
export function findPii(text: string): { kind: 'email'|'phone'|'hash'|'secret'; index: number }[]; // log-scan tests (§5.10 test 4)

// Audit
export type AuditAction =
  | 'dpa_accepted' | 'privacy_settings_changed' | 'attribution_settings_changed' | 'channel_rules_changed'
  | 'integration_connected' | 'integration_disconnected' | 'integration_settings_changed'
  | 'login_succeeded' | 'login_failed'
  | 'member_invited' | 'member_invite_accepted' | 'member_role_changed' | 'member_removed'
  | 'org_deletion_requested' | 'org_deletion_cancelled' | 'org_deleted'
  | 'consent_region_confirmed' | 'consent_default_on_warned' | 'consent_default_on_paused' | 'consent_default_on_resumed'
  | 'dsr_created' | 'dsr_completed' | 'dsr_failed' | 'dsr_followup_erasure' | 'dsr_export_downloaded'
  | 'report_exported' | 'order_journey_viewed' | 'audit_log_viewed'
  | 'retention_run' | 'system_scope_used' | 'suppression_rebuilt'
  | 'breach_created' | 'breach_confirmed' | 'breach_notified' | 'breach_closed';
// M0-6. The catalogue, the per-action metadata schemas (zod, strict, flat scalars only) and the entry
// types live in packages/shared/src/audit.ts; the interface and metadata check are in packages/privacy;
// the Postgres implementation (createAuditLogRepository) is in packages/db, the only code that writes audit_log.
export interface AuditLogger {
  // Organization entries. `scope` must cover entry.organizationId; `action` is any non-platform action,
  // and `metadata` has the shape AUDIT_METADATA_SCHEMAS[action] requires (required only where non-empty).
  write(scope: Scope, entry: OrganizationAuditEntry): Promise<void>;
  // Platform-wide entries (organization_id null): only PLATFORM_AUDIT_ACTIONS — login_succeeded, login_failed,
  // retention_run, suppression_rebuilt, breach_* — enforced by the type and at runtime. No scope needed.
  writePlatform(entry: PlatformAuditEntry): Promise<void>;
}
// Every entry is validated before insert: the action's schema is the real check (an unexpected key, an
// email or a hash fails); findPii over string values and a sensitive-key-name scan are a backstop for the
// free-form maps (retention_run, system_scope_used). Errors name paths and codes, never values.
```

`TenantScope` and `SystemScope` come from the scoped data-access layer ([ADR-0016](../../adr/0016-tenant-isolation-strategy.md), [auth-tenancy.md](auth-tenancy.md)).

**ConsentProvider mapping (`shopify_customer_privacy`)**
| Signal | Purpose granted |
|---|---|
| `analytics = true` | `attribution_analytics` |
| `marketing = true` and `store.childDirected = false` | `ad_platform_measurement` |
| `marketing = true` and `store.childDirected = true` | nothing extra (P-6) |

`preferencesProcessingAllowed` and `saleOfDataAllowed` exist in the Shopify API but map to no MVP purpose ([Shopify customerPrivacy API](https://shopify.dev/docs/api/web-pixels-api/standard-api/customerprivacy)).

### 2.2 REST endpoints (Core API; paths exactly as SPEC §10)

| Method & path | Roles | Body / query | Response | Audit |
|---|---|---|---|---|
| `POST /v1/stores/:id/privacy/requests` | owner, admin | `DsrCreateBody` | `201 { id, status:'pending', due_at }` | `dsr_created` |
| `GET /v1/stores/:id/privacy/requests` | owner, admin | `?status&type&cursor` | `{ items: DsrSummary[], next_cursor }` | — |
| `GET /v1/stores/:id/privacy/requests/:rid/export` | owner, admin | — | `302` to a presigned S3 URL (60 s), or `409 export_not_ready` | `dsr_export_downloaded` |
| `GET /v1/stores/:id/privacy-settings` | owner, admin, analyst | — | `PrivacySettings` | — |
| `PUT /v1/stores/:id/privacy-settings` | owner, admin | `PrivacySettings` | `200 PrivacySettings` | `privacy_settings_changed` (changed field names only) |
| `POST /v1/orgs/:id/dpa/accept` | owner | `{ dpa_version }` | `201` | `dpa_accepted` |
| `GET /v1/orgs/:id/audit-log` | owner, admin | `?from&to&action&cursor&limit` (ISO datetimes; `action` must be in the catalogue; `limit` 1–200, default 50; `cursor` is opaque; unknown parameters and `from` > `to` are `400 invalid_query`) | `{ items: [{id, action, actor_type, actor_user_id, target_type, target_id, metadata, created_at}], next_cursor }`, newest first | `audit_log_viewed`, on the first page only (no `cursor`), written before the response is sent |

Error codes: `400 invalid_identifier` (neither phone nor email normalises), `403 forbidden_role`, `404 not_found` (includes cross-tenant ids — §5.10 test 7), `409 dpa_version_mismatch`, `422 retention_out_of_range`.

```ts
import { z } from 'zod';

export const DsrCreateBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('access'), phone: z.string().max(32).optional(), email: z.string().max(254).optional() }).strict(),
  z.object({ type: z.literal('erasure'), phone: z.string().max(32).optional(), email: z.string().max(254).optional() }).strict(),
  z.object({
    type: z.literal('correction'),
    phone: z.string().max(32).optional(), email: z.string().max(254).optional(),
    correction: z.object({ action: z.literal('unlink_identity') }).strict(),   // MVP: the only correction (SPEC §5.6 "re-link identity")
  }).strict(),
]).refine(b => !!(b.phone || b.email), { message: 'phone or email required' });

export const PrivacySettings = z.object({
  retention_months: z.number().int().min(3).max(25),     // stores.retention_months
  child_directed: z.boolean(),                          // stores.child_directed
  notice_version: z.string().min(1).max(32),            // stores.privacy_config.notice_version
  grievance_contact: z.object({
    name: z.string().min(1).max(120),
    email: z.string().email().max(254),
    phone: z.string().max(32).optional(),
  }).strict(),
  checklist: z.object({
    notice_published_at: z.string().datetime().nullable(),
    banner_live_confirmed_at: z.string().datetime().nullable(),
    india_opt_in_confirmed_at: z.string().datetime().nullable(),   // SPEC v0.6 tracking gate (§4.13)
  }).strict(),
}).strict();
// One home per setting (SPEC v0.6): retention_months and child_directed are stores COLUMNS and are never duplicated
// in stores.privacy_config. privacy_config holds notice_version, grievance_contact, checklist and consent_health
// (written by event-workers, read-only in the API).
```

### 2.3 Webhooks routed into the DSR pipeline

Core API receives them on `POST /webhooks/shopify/:topic` ([shopify-integration.md](shopify-integration.md)) and hands them to this module. Payload fields, timing and deadlines are from [Shopify privacy compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance).

| Topic | Payload fields used | Creates | Deadline |
|---|---|---|---|
| `customers/data_request` | `shop_domain`, `customer.email`, `customer.phone`, `data_request.id` | `dsr_requests(type='access', requested_by_user_id=null)` | Shopify: 30 days; ours: 7 days |
| `customers/redact` | `shop_domain`, `customer.email`, `customer.phone`, `orders_to_redact` | `dsr_requests(type='erasure')` | Shopify: 30 days; ours: 7 days |
| `shop/redact` (sent 48 h after uninstall) | `shop_domain` | `dsr_requests(type='store_erasure', identity_hash=null)` | Shopify: 30 days; ours: 7 days after receipt |

Handlers respond `200` after the row is created and the job enqueued, and `401` on HMAC failure. Raw `customer.email` and `customer.phone` are hashed in memory and discarded; the payload is never persisted or logged.

### 2.4 Queue job payloads (HLD §8)

- `DsrJob{storeId, type:'access'|'erasure'|'correction'|'store_erasure', requestId, visitorIds?}` on queue `dsr`. BullMQ `jobId = dsr-<requestId>`, or `dsr-followup-<requestId>-<suppression row id>` for follow-ups, so duplicates are dropped. (`-` not `:`: BullMQ rejects a custom job id containing `:` unless it has exactly three parts, and an id built from the visitor's HMAC would put an identifier into logged ids — changed in M1-6b.)
- `RetentionJob{storeId}` on queue `retention`. The nightly scheduler fans out one job per active store under `SystemScope`; `jobId = retention:<storeId>:<yyyymmdd>`.

## 3. Data owned

| Table / key | Access | Columns used | SPEC §6 status |
|---|---|---|---|
| `consent_records` | owns semantics; `event-workers` inserts; DSR and retention delete | `id` (= source `event_id`), `store_id`, `visitor_id` (= `HMAC(visitor_id)`), `purposes`, `state` (`granted`\|`withdrawn`), `notice_version`, `source`, `occurred_at` | SPEC. Hashing of `visitor_id` follows P-4. |
| `dsr_requests` | read/write | `id`, `store_id`, `type`, `identity_hash`, `status` (`pending`\|`in_progress`\|`completed`\|`failed`), `requested_by_user_id`, `created_at`, `due_at`, `completed_at`, `result_summary` | SPEC; `type='store_erasure'` **flagged in HLD §8** |
| `suppressed_identities` | read/write | all | **Flagged addition (HLD §8)** |
| `audit_log` | write (all modules through `AuditLogger`); read via API | all | SPEC |
| `breach_incidents` | read/write (`SystemScope` only) | all | SPEC |
| `dpa_acceptances` | write/read | all; `ip_truncated` = IPv4 /24 or IPv6 /48 of the accepting user | SPEC |
| `stores` | read/write | `retention_months`, `child_directed`, `status`, `privacy_config` | SPEC; `privacy_config` **flagged in HLD §8** |
| `orders` | anonymise on erasure; delete on retention | `phone_hash_hmac`, `email_hash_hmac`, `visitor_id`, `created_at_platform` | SPEC |
| `order_status_events`, `capi_dispatch_log` | delete (retention, store erasure); redact `last_error` (erasure) | — | SPEC |
| ClickHouse `events`, `touchpoints`, `identity_links`, `attribution_results`, `order_status` | read (access export); delete (erasure, retention) | via the scoped query builder only | SPEC plus HLD §8 flagged items |
| Redis `suppress:*`, `suppress:ready` | read/write | — | HLD §8 flagged |
| Redis `session:*`, `checkout:*`, `stream:events-raw`, `stream:events-dead`, `dedupe:*` | delete matching entries on erasure | — | HLD §8 flagged |
| S3 `dsr-exports/<store_id>/<request_id>.json` | write/delete | SSE-KMS; 30-day lifecycle rule | HLD §7 |

This LLD adds no tables, columns, keys or queues beyond HLD §8.

## 4. Processing flow

### 4.1 Hashing, the tenant key, and key rotation
1. At boot, Collector, Core API and Workers load every master secret listed in `IDENTITY_KEY_READ`. Secrets are named `truepath/identity-master/k<N>` in Secrets Manager (KMS-encrypted) and reach the process as env vars `IDENTITY_MASTER_K<N>` (base64, ≥ 32 bytes) injected by ECS — [ADR-0020](../../adr/0020-identity-master-keys-via-env.md). `IDENTITY_KEY_WRITE` must be one of them. A missing or malformed variable fails startup, with no default in any environment, and because the environment is read once, **rotation needs a task restart**.
2. Per-context key: `k_ctx,N = HKDF-SHA256(ikm = master_N, salt = "truepath-identity", info = "k<N>:" + ctx, L = 32)`, cached in process, where `ctx` is `store:<store_id>` for a store or `purpose:<name>` for a hash that belongs to no tenant (rate-limit keys). The prefix names the kind and both payloads are closed alphabets without `:` (a UUID; a fixed list), so the encodings cannot collide. Store and purpose hashes are deliberately unlinkable.
3. `hmac(ctx, v) = "k<W>:" + hex(HMAC-SHA256(k_ctx,W, v))`, where W is the write version. `hmacAll` returns one value per read version. The same function hashes normalised phone, normalised email, and `visitor_id` (for `consent_records` and suppression). Every stored HMAC therefore carries its key version (HLD §8 HMAC value format).
   - **Writes** use `hmac` only. Short-lived keys (the rate limiter) also use only `hmac`: after a rotation their counters start fresh.
   - **Lookups** use `hmacAll` wherever the raw value is available: Collector suppression checks, Core API order webhooks, DSR resolution. They query with `IN (…all versions…)`, so data hashed under an older version is still found.
   - During a rotation window, writers that hold the raw value also write `identity_links` rows under the previous version, so cross-device stitching keeps working across the boundary.
4. Phone normalisation: strip everything except digits and a leading `+`. `+91` followed by 10 digits → keep. 12 digits starting `91` → `+` prefix. 11 digits starting `0` → drop the `0`, add `+91`. 10 digits starting 6–9 → `+91` + digits. Other `+` numbers of 8–15 digits → keep. Anything else → `null`.
   - **Dummy-number blocklist** (SPEC v0.3), applied after normalisation and before any hashing. If it matches, the result is `null`: no hash, no stitching, no suppression entry. Checked on the national number (the 10 digits after `+91`, or the digits after the country code for other countries):
     - one digit repeated throughout (`9999999999`, `0000000000`);
     - a two-digit block repeated (`9898989898`, `1212121212`);
     - ascending or descending runs of 8 or more digits within the number (`1234567890`, `9876543210`, `0123456789`);
     - a platform list in `packages/shared/constants.ts`, `DUMMY_PHONES` — for example `9000000000`, plus known test numbers found during design-partner onboarding.

     Metric `dummy_phone_rejected_total` (no value in labels). This runs **before** the shared-identifier thresholds in identity-stitching §4.2.
5. Email normalisation: trim, lowercase, require exactly one `@` with a non-empty local part and a dotted domain; else `null`. No Gmail dot or plus stripping, so the result matches Meta's documented normalisation: "Trim any leading and trailing spaces. Convert all characters to lowercase" ([customer information parameters](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters)).
6. `sha256Hex` is computed only inside `capi-dispatch`, in memory, for the outgoing request. It is never persisted. `capi-dispatch` re-fetches the order's phone and email from Shopify at send time; if the fetch fails, it skips the event with `capi_dispatch_log.status='skipped'` and `last_error='identity_fetch_failed'` (accepted in batch-1 review; detail in `meta-integration.md`).

**Key rotation procedure**

*Scheduled rotation* (for example yearly, or when an engineer with secret access leaves):
1. Create `truepath/identity-master/k2` (32 random bytes, KMS-encrypted). Audit `system_scope_used`, reason `key_rotation`.
2. Deploy all services with `IDENTITY_KEY_READ=k1,k2` and `IDENTITY_KEY_WRITE=k1`. Everyone can now *read* k2 before anyone writes it.
3. Deploy with `IDENTITY_KEY_WRITE=k2`. New hashes are `k2:…`.
4. Re-key the values that can be recomputed, because the raw input still exists:
   - visitor-id HMACs in `consent_records.visitor_id` and `suppressed_identities` (`identifier_type='visitor_id'`);
   - suppression-set members.

   A `SystemScope` job reads raw visitor ids per store from ClickHouse `events`, computes both versions, updates rows whose k1 value matches, and rebuilds the Redis sets. Audit counts.
5. Phone and email HMACs **cannot** be re-keyed; the raw values are never stored. They age out naturally: `orders` after 25 months, `events`/`identity_links` with retention, suppression entries after 13 months. `dsr_requests.identity_hash` values under k1 stay as erasure records but can no longer be matched once k1 is retired.
6. After 25 months (the longest retention), remove k1 from `IDENTITY_KEY_READ` and schedule deletion of the k1 secret.

*Emergency rotation* (suspected master-key compromise):
- Treat it as a breach (§4.12). Run steps 1–4 the same day.
- k1-hashed phone/email values should be assumed brute-forceable by whoever holds k1. Retiring k1 early does not undo that exposure; it only stops matching.
- Keep k1 readable unless counsel advises purging k1-hashed identity data. That purge would null the order hashes and delete the affected `identity_links`, and cross-device attribution would be lost for those orders.

Cost of the version prefix: 3–4 bytes per stored hash; suppression checks and lookups do one `ZSCORE`/`IN` element per read version (normally 1, 2 during rotation).

### 4.2 Consent evidence
1. The pixel sends `consent_granted` when it first loads and again at most every 30 days while consent holds. It sends `consent_granted` or `consent_withdrawn` whenever `visitorConsentCollected` fires ([Shopify pixel privacy](https://shopify.dev/docs/api/web-pixels-api/pixel-privacy)).
2. The Collector evaluates `ConsentProvider` and stamps `consent_purposes`. Consent events are accepted even without analytics consent, because they are evidence, not analytics.
3. `event-workers` inserts `consent_records(id = event_id, …)` with `ON CONFLICT (id) DO NOTHING`.
4. On `consent_withdrawn` (analytics withdrawn): `SuppressionClient.add(visitor, 'withdrawn')`, then a withdrawal-triggered erasure (§4.5). On `consent_granted` for a visitor with a `withdrawn` entry: `removeWithdrawn`. `erased` entries are unaffected. Withdrawing marketing consent alone arrives as `consent_granted` with only `attribution_analytics`: CAPI stops, and nothing is erased.
5. CAPI eligibility (used by `capi-dispatch`): the **latest** `consent_records` row for `HMAC(visitor_id)` has `state='granted'` and includes `ad_platform_measurement`. No row → skip.
6. The 30-day refresh means an active visitor always has a consent record less than 30 days older than any of its retained events. That is what lets retention (§4.8) delete consent rows safely.

### 4.3 DSR — access
1. Core API validates `DsrCreateBody`, normalises and hashes the identifier (the raw value is discarded), and inserts `dsr_requests(status='pending', due_at = now + 7 days)`. It writes the `dsr_created` audit entry and enqueues `DsrJob`.
2. The worker sets `status='in_progress'` and resolves the person one hop out:
   - **Hashes H**: the hash(es) entered, plus the `phone_hash_hmac` and `email_hash_hmac` of every order matching any of them.
   - **Visitors V**: `identity_links FINAL WHERE store_id=? AND identity_hash_hmac IN H`, plus `orders.visitor_id` of matched orders.
   - **Orders O**: orders matching H, plus orders whose `visitor_id ∈ V`.
3. The worker collects:
   - Orders: `external_order_id`, `created_at_platform`, `total_amount_paise`, `payment_method`, `financial_status`, `delivery_status`, `delivered_at`, `rto_at`, `pincode_prefix`, `discount_codes`.
   - `order_status_events` for O.
   - `events` and `touchpoints` for V (all columns except the hashes).
   - `consent_records` for `HMAC(V)`.
   - `attribution_results` (latest version) for O.
   - Prior `dsr_requests` with `type='erasure'` and `identity_hash ∈ H` — the minimal erasure records (HLD Q9).
4. It writes the JSON to `dsr-exports/<store_id>/<request_id>.json` (SSE-KMS), then sets `status='completed'` and `result_summary = {orders, events, touchpoints, consent_records, erasure_records}` as counts only. It writes the `dsr_completed` audit entry.
5. Download: `GET …/export` checks the role, writes `dsr_export_downloaded`, and redirects to a 60-second presigned URL.

### 4.4 DSR — erasure (HLD §6d) and follow-up
1. Steps 1–2 of §4.3 (resolve H, V, O).
2. **Suppress first**: `add(identity_hash_hmac, h)` for each h ∈ H, and `add(visitor_id, HMAC(v))` for each v ∈ V, all with `reason='erased'` and `dsr_request_id`.
3. ClickHouse deletes, through the query builder, using the mechanism ADR-0015 selects:
   - `events` and `touchpoints` where `visitor_id IN V`;
   - `identity_links` where `visitor_id IN V`;
   - `attribution_results` and `order_status` where `order_id IN O`.
4. Postgres, in one transaction:
   - null `phone_hash_hmac`, `email_hash_hmac` and `visitor_id` on O;
   - set `note_attributes = '{}'` and `landing_site`/`referring_site` to their origin only, because these can carry UTMs with personal values;
   - redact `capi_dispatch_log.last_error` for O;
   - `DELETE consent_records WHERE visitor_id IN HMAC(V)`.
5. Redis: `DEL session:<store_id>:<v>` for each v; `DEL checkout:<store_id>:<o>` for each o. Scan `stream:events-raw` pending entries and `stream:events-dead` for `visitor_id ∈ V` and `XDEL` them. Scan every `<queue>-failed` DLQ for jobs whose payload has an `orderId ∈ O` or `visitorIds ∩ V`, and remove them.
6. S3: delete any `dsr-exports/<store_id>/*` objects produced for requests with `identity_hash ∈ H`.
7. **Verify**: re-count each target (`count()` with the store and ids filter) and require 0. Lightweight deletes (ADR-0015) are visible to queries immediately; wait for the `DELETE` statement to return (timeout 30 min, then retry).
   - **Physical purge**: masked rows are removed from disk within **7 days** by forced merges (`min_age_to_force_merge_seconds = 604800`, ADR-0015). If the staging check shows that isn't reliable, a weekly `APPLY DELETED MASK IN PARTITION` runs for partitions touched by erasures. `result_summary.physical_purge_by = completed_at + 7 days` is recorded, and merchants are told: *hidden immediately, purged from disk within 7 days, gone from backups within 30 days after that.*
8. Set `status='completed'`, `result_summary` = per-target deleted counts, and write the `dsr_completed` audit entry.
9. **Follow-up** (`DsrJob.visitorIds` set, triggered by `suppression_hit`): run steps 3–7 for those visitors only. Append `{visitor_count, rows_deleted, at}` to `result_summary.followups[]` and write `dsr_followup_erasure`.

```mermaid
sequenceDiagram
  participant API as Core API
  participant PG as Postgres
  participant Q as dsr worker
  participant SUP as SuppressionClient
  participant CH as ClickHouse (query builder)
  participant R as Redis durable
  participant S3
  API->>PG: dsr_requests(pending) + audit dsr_created
  API->>Q: DsrJob{type:'erasure', requestId}
  Q->>PG: status=in_progress; resolve H (hashes), O (orders)
  Q->>CH: resolve V via identity_links FINAL
  Q->>SUP: add erased entries for H and HMAC(V) (PG then Redis)
  Q->>CH: DELETE events/touchpoints/identity_links (V); attribution_results/order_status (O)
  Q->>PG: anonymise orders O; redact capi_dispatch_log; delete consent_records
  Q->>R: DEL session:/checkout: keys; XDEL stream entries; purge DLQ jobs
  Q->>S3: delete prior exports for H
  Q->>CH: verify count() = 0 per target
  Q->>PG: status=completed, result_summary counts + audit dsr_completed
```

### 4.5 Withdrawal-triggered erasure (DPDP s.8(7))
Decision (batch-1 review): withdrawing **analytics** consent erases that visitor's data. **Counsel review pending** on the legal reading, and on keeping Shopify-sourced order hashes (below).

1. `event-workers`, on `consent_withdrawn`, in the same transaction as the `consent_records` insert:
   - inserts `dsr_requests(type='erasure', identity_hash = hmac(store, visitor_id), requested_by_user_id = null, due_at = now + 24 h, result_summary = {trigger:'consent_withdrawn'})`;
   - enqueues `DsrJob{storeId, type:'erasure', requestId}` with `delay: 60 000 ms` (a coalescing window) and `jobId = dsr-<requestId>`. The request row is created with `result_summary.source_ref = 'withdrawal:<event_id>'`, so a redelivered batch finds the same request rather than a second one, and the `dsr_created` audit row is written in the same transaction, only when the request is new.
2. When the worker picks up a withdrawal-triggered request, it also claims up to 500 other pending withdrawal-triggered requests for the same store (`SELECT … FOR UPDATE SKIP LOCKED`) and processes them as one set V of visitors. It issues one delete statement per table instead of one per visitor, so a burst of withdrawals doesn't create a burst of ClickHouse deletes. The claimed requests' own queued jobs then find `status='completed'` and do nothing.
3. Scope — **one visitor, not a person**. The one-hop identity expansion of §4.3 is not done:
   - ClickHouse: delete `events`, `touchpoints` and `identity_links` where `visitor_id IN V`; delete `attribution_results` for orders with `orders.visitor_id IN V`.
   - Postgres: `orders.visitor_id = NULL` for those orders; `DELETE consent_records WHERE visitor_id IN hmac(V)`.
   - Redis: `session:` / `checkout:` keys; best-effort stream and DLQ purge, as in §4.4 step 5.
4. Re-attribute: enqueue `AttributionRunJob{storeId, mode:'incremental', orderIds}` for the affected orders. They fall back to UTM or Unattributed.
5. **Kept**:
   - order rows and their phone/email HMACs;
   - the `withdrawn` suppression entry (so the visitor can re-consent and start fresh on the same `visitor_id`);
   - the `dsr_requests` row as the record.

   **Counsel note:** the order hashes are kept because they come from the merchant's own order system (Shopify order data, processed under the merchant's contract with the shopper), not from the pixel. The consent being withdrawn covers pixel tracking, not the merchant's order records. A shopper who wants those gone too must make an erasure request (§4.4).
6. Verify (count = 0), complete, and audit `dsr_completed` with `metadata.trigger='consent_withdrawn'`.
7. The Privacy page lists these requests separately from merchant-initiated DSRs, filtered on `result_summary.trigger`.

### 4.6 DSR — correction (`unlink_identity`)
1. Resolve H and V as in §4.3.
2. Delete `identity_links` rows where `identity_hash_hmac ∈ H`. This removes cross-device merges.
3. Keep `orders.visitor_id` where it came from the primary `order_id` match (SPEC §7.3 rule 2).
4. Enqueue `AttributionRunJob{storeId, mode:'incremental', orderIds: O}`.
5. Future checkouts may re-link the identity. This is the "limited" correction SPEC §5.6 describes; see Open question 4.

### 4.7 Store erasure (`shop/redact`, offboarding)
1. On `app/uninstalled` ([shopify-integration.md](shopify-integration.md)): set `stores.status='uninstalled'`, mark the collector config inactive, and show the owner a banner offering an access-style export of aggregate reports.
2. On `shop/redact`: insert `dsr_requests(type='store_erasure', due_at = now + 7 days)` and enqueue a `DsrJob` delayed 7 days. The delay keeps the export window open; it stays within Shopify's 30-day deadline.
3. The job, under `SystemScope` limited to that store, runs:
   - ClickHouse deletes for all five tables plus `order_status` where `store_id=?`.
   - Postgres deletes of `orders`, `order_status_events`, `consent_records`, `capi_dispatch_log`, `channel_rules`, `attribution_settings`, `ad_accounts`, `integrations` (including `encrypted_credentials`), and `suppressed_identities` for the store.
   - Redis: delete `suppress:<store_id>:*`, `session:<store_id>:*`, `checkout:<store_id>:*`, `stats:collector:<store_id>:*`, `dedupe:<store_id>:*`, and `collector:store:<store_key>` (SCAN with a store-prefixed MATCH).
   - S3: delete `dsr-exports/<store_id>/`.
   - Keep the `stores` row as a tombstone (`status='deleted'`, `privacy_config` nulled), plus `audit_log` and `dsr_requests`. These hold no shopper data.
4. Verify as in §4.4 step 7, then complete and audit.

### 4.8 Retention (nightly, ~01:00 IST)
Mechanism (**ADR-0015, Accepted**):
- **Postgres** deletes run nightly per store, as below.
- **ClickHouse** retention deletes run **weekly** (Sunday 01:00 IST). They are one lightweight `DELETE` per table covering all stores, grouped by cutoff (≤ 23 distinct `retention_months` values). So ClickHouse rows can outlive their window by up to 7 days, and are then physically purged within 7 more days.
- The per-store nightly `RetentionJob{storeId}` handles Postgres, suppression expiry and the dead stream. The ClickHouse statements are issued by the retention **scheduler** itself, on Sundays after fanning out the per-store jobs. It runs under `SystemScope` with one `system_scope_used` audit row and per-table deleted counts. No new job type is needed.
1. The scheduler fans out one `RetentionJob{storeId}` per store under `SystemScope`, writing `system_scope_used`.
2. For each store (cutoff `C_ev = now − stores.retention_months`, cutoff `C_ord = now − 25 months`):

   | Target | Rule |
   |---|---|
   | `events`, `touchpoints` | delete `occurred_at < C_ev` |
   | `identity_links` | delete `last_seen < C_ev` |
   | `attribution_results`, `order_status` | delete for orders with `created_at_platform < C_ord` |
   | `orders`, `order_status_events`, `capi_dispatch_log` | delete where the order is older than `C_ord` |
   | `consent_records` | delete `occurred_at < now − (retention_months + 12 months)` |
   | `suppressed_identities` + Redis sets | delete / `ZREMRANGEBYSCORE` where `expires_at < now` |
   | `stream:events-dead` | `XTRIM MINID` to 7 days |
   | `audit_log` | handled by a separate platform-wide job: delete rows older than 24 months (≥ 1 year per S-4) |

3. Write `audit_log(action='retention_run', metadata = per-target row counts)`.
4. The table-level TTL of 25 months on `events`/`touchpoints` is only a backstop (HLD §8).

### 4.9 Suppression rebuild
Covered in HLD §8. This module implements `rebuildAll`:
1. Stream `suppressed_identities WHERE expires_at > now()` in pages of 10,000.
2. `ZADD` into the matching `suppress:<store_id>:…` sets (pipelined).
3. Republish `collector:store:*` configs.
4. Set `suppress:ready = <timestamp>` and write `suppression_rebuilt` with counts.

### 4.10 DPA gating and privacy settings
- **Tracking gate** (SPEC v0.6). Core API publishes `collector:store:<store_key>` with `status='active'` only when **all** hold:
  1. the store's org has a `dpa_acceptances` row for the current `DPA_VERSION` (env, validated at boot);
  2. `privacy_config.checklist.india_opt_in_confirmed_at` is set (§4.13);
  3. `privacy_config.consent_health.status ≠ 'paused'`;
  4. where the `consentPolicy` check is available, it doesn't report `consentRequired = false` for India.

  Otherwise it publishes `status='inactive'` with the matching `inactiveReason`, and the Collector drops everything (`store_inactive`).
- `PUT privacy-settings` updates `stores` and republishes the collector config (`childDirected`, `noticeVersion`). Changing `child_directed` to `true` also cancels waiting `capi-dispatch` jobs for the store: they re-check at execution and skip anyway.
- Lowering `retention_months` takes effect at the next retention run. The UI warns that the deletion is irreversible.

### 4.11 Infrastructure logs
Application logs are covered by redaction (§6). These AWS-level logs would otherwise capture shopper IPs or URLs:

| Log | Decision | Why |
|---|---|---|
| ALB access logs — **Collector** | **Disabled.** The Collector has its own ALB, because access logging is a per-load-balancer setting, not per target group. | Each line would hold the shopper's full IP, the user agent and the request URL, which the Collector itself discards. Fallback if an investigation needs them: enable temporarily, delivered to `s3://…/alb-collector/` with a **7-day** lifecycle rule, and audit `system_scope_used` with the reason. |
| ALB access logs — Core API | Enabled, S3 with a 30-day lifecycle; bucket read limited to the security role | Merchant-staff and webhook-sender IPs; we are Fiduciary for staff data; useful for security investigations (S-4). Also contains `/webhooks/lp/:token` URLs, i.e. logistics webhook tokens — hence the restricted read (shiprocket-integration §4.3). |
| VPC Flow Logs | If enabled: exclude the Collector ALB's network interfaces, or 7-day retention | Flow records include shopper source IPs reaching the Collector ALB |
| AWS WAF on the Collector ALB | Logging disabled (metrics only) | Same as ALB logs |
| CloudFront (dashboard) | Standard logs disabled | Not needed; merchant IPs |
| CloudWatch Logs (ECS task logs) | 30-day retention | Already PII-free by redaction; retention bounded anyway |

The platform infrastructure-as-code enforces these settings. A CI policy check fails if the Collector ALB has `access_logs.s3.enabled = true` without a matching 7-day lifecycle rule.

### 4.12 Breach register
- MVP has no internal admin UI. On-call engineers use a CLI in `apps/workers`: `pnpm --filter workers privacy:breach create|update|notify|close`. It runs under `SystemScope` and writes the `breach_*` audit actions.
- `notify` sets `notified_at`. The next `GET /v1/me` for any user of an org in `affected_tenants` returns `breach_notices[]` (id, severity, description, detected_at), which the dashboard shows as a banner.
- Email to org owners goes through **Amazon SES in ap-south-1** (approved), from `privacy@<our domain>`. It contains the incident summary and a link to the dashboard, and no shopper data.
- **Timelines.** Under DPDP Rules 2025, **Rule 7**, the Data Fiduciary (the merchant) must:
  - intimate **each affected Data Principal and the Data Protection Board without delay**;
  - give the Board a **detailed report within 72 hours** of becoming aware of the breach (or a longer period if the Board allows).

  As **Data Processor**, TruePath notifies affected merchants **within 24 hours of confirming** a breach. The notice carries what the merchant needs for both obligations: nature, extent, timing and location; affected stores and data categories; likely consequences; mitigation taken; our contact. The runbook's clock starts at confirmation. Confirmation is recorded by `privacy:breach update --status confirmed`, which writes a `breach_confirmed` audit entry, so no new column is needed. `breach_incidents.notified_at` must be ≤ that entry's `created_at` + 24 h, with an alert at 12 h. *Counsel review: confirm the Rule 7 reading, the processor-to-fiduciary 24 h commitment in the DPA, and the notice template.*
- Process steps (detect → contain → assess → notify → post-mortem) live in `/docs/dpdp/breach-runbook.md`, drafted with counsel.

### 4.13 Consent-region gate — default-on regions (SPEC v0.6)
Where tracking is enabled by default, Shopify runs pixel callbacks until the shopper opts out ([Shopify pixels](https://shopify.dev/docs/apps/build/marketing/pixels)). India is likely default-on unless the merchant configures opt-in, and without the steps below, "analytics allowed" would not be valid consent (P-1). The full design is in HLD §8 *Consent-region gate*.

1. **Onboarding gate.**
   - The merchant follows the guide (dashboard §4.1 step 8; [docs/dpdp/README.md](../../dpdp/README.md)) and ticks "India requires opt-in in my consent banner".
   - `PUT privacy-settings` sets `checklist.india_opt_in_confirmed_at` (audit `consent_region_confirmed`, with the confirming user). Until then the collector config is `inactive` (`consent_region_unconfirmed`).
   - If the `consentPolicy` query is available (scope pending), Core API checks `consentPolicy(countryCode: IN)` at confirmation and in the daily Shopify reconcile. `consentRequired = false` → `inactive` (`consent_policy_not_required`) regardless of the tick, with a dashboard banner.
2. **Runtime signal.** `event-workers` computes `default_on_ratio` per store:
   - **warn** ≥ 0.2 over ≥ 50 new visitors in 24 h;
   - **auto-pause** ≥ 0.5 over ≥ 100 new visitors sustained 48 h (event-pipeline §4.4).

   The privacy page and integration health show the warning; a pause triggers an SES email and a banner. Audit `consent_default_on_warned` / `consent_default_on_paused`.
3. **Resume**:
   - the merchant fixes the banner and re-confirms (a new `india_opt_in_confirmed_at`);
   - `consent_health` is reset, the config republished `active`, audit `consent_default_on_resumed`;
   - the store is watched at the warn threshold for 7 days.
4. **Data collected before detection** (counsel decision, Q5(e)). The proposed remedy is a **store-level erasure of visitors whose only consent evidence is `pixel_initial_state` within the affected window**. It runs as a batch of withdrawal-style erasures (§4.5) with `trigger='consent_region_remediation'` in `result_summary`, offered to the merchant on the pause screen and audited. It is not automatic until counsel decides.
5. Until the dev-store test (collector.md Q3c) shows that opt-in stores produce `interaction`-triggered consent for new visitors, auto-pause ships **disabled** (config value `CONSENT_AUTOPAUSE_ENABLED=false`). Warnings still show. The onboarding gate is enforced from day one.

## 5. Failure modes

| Failure | Detection | Handling | Idempotency |
|---|---|---|---|
| Master identity secret missing at boot | startup check | process exits; ECS keeps the old tasks | — |
| DSR job crashes mid-way | BullMQ stall / attempt count | retry with backoff (2 s base, 5 attempts). Every step is a delete-where or an insert-if-absent, so re-running is safe. After 5 attempts: `status='failed'`, `dsr_failed` audit entry, job in `dsr-failed`, alert | `jobId = dsr-<requestId>` |
| ClickHouse mutation never completes | `system.mutations` poll exceeds 30 min | job fails → retry; alert if `due_at − now < 24 h` | the delete is re-issued, which is harmless |
| Verify step finds rows > 0 | count check | retry the delete once more, then fail with the target named in `result_summary` | — |
| S3 delete fails | SDK error | retry within the job; lifecycle expiry (30 days) is the backstop | — |
| Suppression add: Postgres succeeds, Redis fails | error on `ZADD` | the job fails and retries. The Postgres row is unique, so a retry is a no-op there. The worst case until the retry is a missing hot copy; a rebuild also restores it | unique `(store_id, identifier_type, identifier, reason)` |
| Durable Redis empty or unreachable | `suppress:ready` absent | fail closed (HLD §8): Collector 503, workers pause, automatic rebuild, alert | `rebuildAll` is replace-safe |
| Shopify privacy webhook delivered twice | webhook id seen | first delivery creates the request; later ones return `200` without creating another | webhook-id dedupe ([shopify-integration.md](shopify-integration.md)) |
| DSR approaches its SLA | cron every 15 min: `due_at − now < 24 h` and status not completed | alert on-call; dashboard shows "at risk" | — |
| Retention job fails for a store | attempt count | retried next night as well as by backoff; alert after 2 consecutive failed nights | `jobId` includes the date |

## 6. Privacy touchpoints

| ID | How it is met here |
|---|---|
| P-1 | `ConsentProvider.evaluate` makes `canStore` depend on analytics consent; the Collector uses it ([collector.md](collector.md)). **Default-on regions**: tracking gate plus runtime signal (§4.13), so "allowed" means opted in. |
| P-2 | Notice version and checklist in `stores.privacy_config`; the dashboard checklist reads them. Notice text is counsel's (`/docs/dpdp/shopper-notice.md`). |
| P-3 | `consent_withdrawn` → `consent_records` row, `withdrawn` suppression, and withdrawal-triggered erasure of the visitor's data (§4.5, DPDP s.8(7)); CAPI requires a latest `granted` record. Counsel review pending. |
| P-4 | `consent_records` with `HMAC(visitor_id)`, purposes, notice version, source, timestamp; refreshed every 30 days. |
| P-5 | Purposes enumerated in `Purpose`; `consent_purposes` stamped per event; `capi-dispatch` checks `ad_platform_measurement`. |
| P-6 | `child_directed` strips `ad_platform_measurement` in `evaluate`; `capi-dispatch` also checks `stores.child_directed`. Cross-device stitching for such stores: Open question 3. |
| P-7 | `ConsentProvider` interface; the Shopify implementation is the only one in MVP. |
| §5.4 | Normalisers and HMAC in one package; `sha256` never persisted; `sanitiseUrl`; log redaction. |
| §5.6 | DSR access/erasure/correction, `dsr_requests` with an SLA timer, Shopify privacy webhooks, grievance contact in `privacy_config`. |
| §5.7 | Retention table in §4.8; offboarding via `store_erasure` (§4.7). Infrastructure-log retention in §4.11. |
| §5.8 | `breach_incidents` CLI, `breach_notices` banner, runbook link. |
| §5.9 | Exports in ap-south-1 S3; no transfer outside India except CAPI (hashed). |
| S-2 | Exports SSE-KMS; master identity secret KMS-encrypted in Secrets Manager. |
| S-3 | Owner/admin only for DSR and exports; everything through the scoped data-access layer. |
| S-4 | `AuditLogger` action catalogue covers personal-data views (`order_journey_viewed`), exports, DSRs and settings changes; retained 24 months. |
| S-6 | Versioned master secrets and the rotation procedure (§4.1). |
| S-7 | Amazon SES (ap-south-1) listed in [`/docs/dpdp/subprocessors.md`](../../dpdp/subprocessors.md). |

**Log redaction.** A pino `formatters.log` hook and Sentry `beforeSend` both run `redactLogValue`. It replaces:
- Indian mobile patterns `(?:\+?91[\s-]?)?[6-9]\d{9}`,
- generic E.164 `\+\d{8,15}`,
- emails `[^\s@]+@[^\s@]+\.[^\s@]+`,
- and any 64-hex string (hashes),
- and `IDENTITY_MASTER_*=…` / `IDENTITY_MASTER_*: …` assignments

with `[redacted]`. Object keys are blanked by name (`IDENTITY_MASTER_*`, passwords, tokens, cookies, `email`, `phone`, `ip`, `user_agent`, `visitor_id`, …), whatever the value. Known false positives, such as 10-digit Shopify order numbers starting 6–9, are accepted.

## 7. Performance & limits

| Item | Target |
|---|---|
| `hashContact` | < 50 µs per contact (in-process HMAC) |
| DSR erasure end-to-end | p95 < 1 h; hard SLA 7 days (`due_at`) |
| Access export size | streamed JSON; capped at 200 MB per request; larger → `result_summary.truncated=true` and support follow-up |
| Retention run | all stores complete within 01:00–05:00 IST; one delete statement per table per store per night |
| Suppression rebuild | < 2 min for 100k entries (pipelined `ZADD`, pages of 10,000) |
| Suppression lookup | one pipelined Redis round-trip, < 2 ms p99 in-VPC |
| Audit writes | our own writes: synchronous in the request/job transaction (`createAuditLogRepository` takes a transaction); < 5 ms. Better Auth actions can't share its transaction, so they are written right after it commits, retried once, and reported on failure — [ADR-0021](../../adr/0021-audit-writes-after-better-auth-commits.md) |

Scale note: per-store retention deletes are fine for MVP (tens of stores). Beyond ~500 stores, group stores that share a retention value into one statement (Open question 7).

## 8. Test plan

**Unit**
- Normalisers: table-driven — `+91 97531 24680`, `097531 24680`, `919753124680`, `9753124680`, `+14155550123`, junk → `null`; email case and whitespace; dummy numbers → `null`. (The original fixture `98123 45678` contains the run `12345678` and is itself a dummy under §4.1 step 4.) The email normaliser must accept everything Better Auth's `z.email()` accepts.
- HMAC: deterministic per store; different across stores. Property test: `hmac(a, v) ≠ hmac(b, v)` for `a ≠ b` (no cross-tenant joins, SPEC §7.3 rule 5).
- `ConsentProvider`: every combination of analytics, marketing and child-directed.
- `sanitiseUrl`: allowlist kept; `email=`/`phone=`/`q=` dropped; `/checkouts/<token>` masked.
- `redactLogValue`: fixtures of phone, email and hash.

**Integration** (Postgres, ClickHouse, Redis in testcontainers)
- Erasure over a seeded shopper with 2 devices and 3 orders: all targets reach 0; the suppression rows exist; the delayed `IdentityStitchJob` enqueued before erasure does nothing.
- Follow-up: new visitor → checkout with the erased phone → `suppression_hit` → follow-up job → zero rows.
- Access after erasure returns only the erasure record.
- `shop/redact` flow leaves only the tombstone, audit and DSR rows.
- Retention with `retention_months=3` deletes 4-month-old rows only.
- Rebuild: flush Redis, `suppress:ready` gone → Collector 503 and workers paused → rebuild → resume.
- Shopify privacy webhook fixtures with a bad HMAC → 401.

**§5.10 compliance tests supported**
- Test 2 (withdrawal → no CAPI): the latest-record check.
- Test 3 (no raw PII in ClickHouse): the normalise/hash boundary. The CI scan regex is shared with `redactLogValue`.
- Test 4 (no PII in logs): redaction hook plus a log-scan over the seeded run.
- Test 5 (erasure complete): primary owner.
- Test 6 (retention): primary owner.
- Test 8 (audit for every DSR, export and settings change): asserts an `audit_log` row per action in the catalogue.

## 9. Open questions

**Resolved in batch-1 review**
- CAPI re-fetches phone/email from Shopify at send time and skips on failure.
- Withdrawal of analytics consent triggers erasure (§4.5).
- HKDF keys carry a key version (§4.1).
- Amazon SES is the email provider.

**Open**
1. **"Behavioural profiling" for child-directed stores (P-6).** MVP disables CAPI. Should cross-device stitching via `identity_hash_hmac` (SPEC §7.3 rule 3) also be disabled for these stores? Proposed: yes. For legal review. See `identity-stitching.md`.
2. **Correction scope.** `unlink_identity` is the only correction. Merchants may need "unlink this order from this visitor", which needs a visitor or order selector in the request body. Defer?
3. *(resolved: ADR-0015 accepted — weekly batched ClickHouse retention.)*
4. *(resolved: the store-scoped `POST /v1/stores/:id/privacy/requests` is the only DSR path; SPEC v0.5 §5.6 updated. Machine-credential API keys remain deferred.)*
5. **For counsel (one review):**
   - (a) consent-record deletion on erasure versus keeping it as evidence;
   - (b) 13-month retention of HMAC'd identifiers in the suppression set;
   - (c) the DPDP s.8(7) reading behind §4.5, and keeping Shopify-sourced order hashes after a withdrawal;
   - (d) whether k1-hashed identity data must be purged after an emergency key rotation (§4.1);
   - (e) **default-on regions** (§4.13): is a merchant's confirmation that India requires opt-in sufficient evidence? Must data collected before detection under a default-on configuration be erased (the proposed remediation), and within what time? Wording of the onboarding confirmation and of the pause notice.
