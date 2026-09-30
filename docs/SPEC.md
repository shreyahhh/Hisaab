# MVP Build Spec — India-first Multi-Touch Attribution Platform (DPDP-compliant)

> **Working name:** `TruePath` (placeholder, rename freely)
> **Document purpose:** Single source of truth for building the MVP. Attach this file to every coding session with Claude (or put it in a Claude Project / `CLAUDE.md`).
> **Version:** 0.6 — MVP scope (design frozen for implementation)
> **Legal note:** The DPDP mapping below is an engineering interpretation of the DPDP Act 2023 and DPDP Rules 2025. Get it reviewed by a privacy lawyer before launch.

### Changelog
**v0.6 (2026-09-24)** — final design decisions; implementation starts next.
- §3 / §15: ADR-0011 **Drizzle** (Better Auth shares its schema and migrations); ADR-0013 **ClickHouse Cloud ap-south-1** (conditional on a staging test; smallest tier with idle scaling; backups in Mumbai); ADR-0014 **our own collector domain** (revisit if pixel coverage is low on desktop-heavy stores).
- §5.3 P-1: **default-on consent regions**:
  - tracking stays disabled until the merchant confirms India requires opt-in;
  - `consentPolicy` check where available;
  - a runtime default-on signal with warn and auto-pause thresholds;
  - dev-store test and counsel review.
- §6.1: `stores.privacy_config` (one home per setting), `consent_records.source` values, `dsr_requests.type='store_erasure'`.
- §6.2: `consent_granted` event (with trigger); channel slugs incl. `referral` and `other_campaign`.
- §7.1: pixel fields `visitor_new` and consent `trigger`.
- §10: `POST /v1/orgs/:id/deletion/cancel`.
- Redis keys, stream names and entry types approved as listed in HLD §8 (`store_id`-prefixed per ADR-0016, with documented exceptions).
- Still pending: the Meta CAPI website-event fallback (awaiting the optimisation test) and the `consentPolicy` access scope.

**v0.5 (2026-09-24)** — consistency-pass decisions and the ADR phase.
- §3: Better Auth (ADR-0012), TanStack Router, Grafana Cloud ap-south-1, Sentry SaaS EU.
- §5.4: raw user agent not stored.
- §5.6: store-scoped DSR path only.
- §6.1: Better Auth identity tables.
- §8.1: `read_products` dropped.
- §8.3: no `client_user_agent` on `system_generated` events.
- §10: new endpoints (consent stats, RTO levels, invites accept, members, org deletion, Better Auth routes).
- §11: pixel coverage replaces consent rate.
- §12: Meta app created in M0-7 and an App Review warm-up slice in M1.
- §8.4: Google API version policy.
- §15: ADR-0012 decided.

**v0.4 (2026-09-24)** — batch-3 architecture review.
- §2: FX conversion for non-INR ad accounts is Phase 2; MVP rejects them with a clear onboarding error.
- §6.1: conditional `orders.external_order_name`.
- §6.2: `ad_spend_daily.attribution_window`.
- §8.3: CAPI `event_time` = when the status happened (`delivered_at` / `rto_at`).
- §8.4: 3-hourly intraday Google pull (§13 freshness wins).
- §8.5 / §10: logistics webhook path `POST /webhooks/lp/:token`.
- Pending, not folded: the Meta optimisation-event test and its IP/UA fallback (HLD §8).

**v0.3 (2026-09-24)** — batch-2 architecture review.
- §5.4: dummy-phone blocklist before hashing.
- §5.7: ClickHouse retention runs weekly (≤ 7 days over the window); deleted rows are physically purged within 7 days (ADR-0015 Accepted).
- §6.1: `orders.refunded_amount_paise`; `integrations.settings` (non-secret only).
- §6.2: `order_status` reporting and refund columns; `attribution_results.revenue_basis` and `credited_revenue_paise` dropped.
- §8.1: Level 2 protected data includes address (zip → pincode prefix); `read_customers` not needed; backfill is 60 days via `read_orders` until `read_all_orders` is approved, then 90.
- §8.3: CAPI Purchase is opt-in (off by default); default sendback is DeliveredPurchase + RTO.
- §9: delivered revenue is net of refunds.
- §10: Shopify connect parameters; `PUT /v1/integrations/:id/settings`.
- §12: M0-7 and M1-3 updated.

**v0.2 (2026-09-24)** — folds in decisions approved during architecture review ([HLD](architecture/HLD.md), ADR-0016, ADR-0017). Items still pending sign-off remain flagged in HLD §8, not here.
- §3: approved libraries (DB-IP Lite, `ua-parser-js` 1.x, `@clickhouse/client`, Amazon SES ap-south-1). Redis split into a durable instance and a cache instance.
- §5.3 P-3: withdrawing analytics consent triggers erasure of that visitor's data (counsel review pending).
- §5.4: HMACs carry a key version; no IP is forwarded to CAPI; CAPI's SHA-256 values are computed at send time from a Shopify re-fetch and never stored.
- §5.6: the erasure record is the `dsr_requests` row.
- §6.1: added `orders.attribution_confidence`, `store_delivery_rates`, `suppressed_identities`; `consent_records.visitor_id` is an HMAC; `dsr_requests.result_summary.trigger`.
- §6.2: engines, keys and versioning for `events`, `touchpoints`, `identity_links`, `ad_spend_daily`, `attribution_results`; new `order_status` table; stored event names follow Shopify's; 25-month table TTL as a backstop.
- §7.2: Collector signature in query parameters.
- §8.3: CAPI identity source and event ids.
- §12 M0-7: request Shopify protected customer data access.
- §15: tenant isolation (ADR-0016) and event de-duplication (ADR-0017) decided.

**v0.1** — initial MVP scope.

---

## 0. Instructions for Claude (read first)

You are the senior engineer pairing on this project. Follow these rules in every session:

1. **Work milestone by milestone** (Section 12). Do not start a later milestone's work unless asked.
2. **Before writing code for a ticket**, restate the ticket, list the files you will create or change, and flag any ambiguity. Ask if something in this spec conflicts with the request.
3. **Privacy is a hard requirement, not a feature.** Every data path must respect Section 5 (DPDP rules). If an implementation would store raw PII, process data without a consent check, or skip audit logging, stop and flag it.
4. **TypeScript strict mode everywhere.** No `any` without a comment explaining why.
5. **Every module ships with:** unit tests, a short README section, and typed interfaces in `packages/shared`.
6. **Never hardcode secrets.** Use env vars validated with `zod` at boot.
7. **Prefer boring, well-documented libraries.** Ask before adding a new dependency that is not listed in Section 3.
8. **External API details change.** When calling Meta, Google Ads, Shopify or Shiprocket APIs, check the current API version and field names against official docs, and isolate each integration behind an adapter interface so version bumps are contained.
9. When a decision is not covered here, propose 2 options with trade-offs and let the human choose. Record chosen decisions in `docs/adr/` as short ADRs.

---

## 1. Product summary

An attribution platform for Indian D2C / e-commerce brands that shows **which ads actually drive delivered revenue**, independent of Meta's and Google's self-reporting.

### Core promise of the MVP
> "See your real, **delivered** ROAS per campaign, ad set and ad — and send better conversion signals back to Meta."

### Target user (MVP)
- Shopify-based Indian D2C brand, ₹10 lakh – ₹5 crore monthly GMV
- Runs Meta Ads and Google Ads
- Significant COD share, ships via Shiprocket
- Users: founder, performance marketer, or agency managing the brand

### What makes it India-specific
- **Delivered ROAS**: revenue counted on delivery, RTO orders excluded (COD + RTO reality)
- **Phone-number-first identity stitching** (COD checkouts always collect phone)
- **DPDP-ready by design**: consent-gated tracking, hashed identifiers, data-principal rights tooling
- INR, IST timezone, Indian sale-calendar awareness (Diwali, BBD) — dashboard-level in MVP

---

## 2. MVP scope

### In scope (MVP)
| # | Capability |
|---|---|
| S1 | Multi-tenant SaaS: organisations, users, roles, one or more stores per org |
| S2 | Shopify app (OAuth install) + order/refund/fulfilment webhooks + historical backfill (90 days) |
| S3 | First-party tracking pixel via **Shopify Web Pixel extension**, consent-gated via Shopify Customer Privacy API |
| S4 | Server-side event collector (ingest API) |
| S5 | Meta Ads ingestion: accounts, campaigns, ad sets, ads, daily spend & platform-reported conversions |
| S6 | Google Ads ingestion: accounts, campaigns, ad groups, ads, daily spend & platform-reported conversions |
| S7 | Shiprocket integration: shipment status → delivered / RTO / cancelled |
| S8 | Identity stitching: visitor ↔ session ↔ order via visitor cookie + hashed phone/email |
| S9 | Rules-based attribution: first click, last click, last non-direct, linear, time-decay, position-based (40/20/40) |
| S10 | Two revenue bases: **placed** vs **delivered** |
| S11 | Dashboard: overview, channel/campaign/ad tables, model comparison, order journey view, RTO by campaign |
| S12 | Meta Conversions API (CAPI) sendback: Purchase + custom `DeliveredPurchase` event |
| S13 | DPDP module: consent records, privacy notice config, data principal rights (access/erasure/correction), retention jobs, audit log, breach register |

### Out of scope (Phase 2+)
WooCommerce plugin · GoKwik / Shopflo / Razorpay Magic checkout integrations · Google Enhanced Conversions sendback · TikTok/other ad platforms · creative-level image/video analytics · profit (COGS) module · data-driven models (Markov/Shapley) · MMM / incrementality · WhatsApp / influencer tracking · marketplaces · billing & subscriptions (manual invoicing for design partners) · agency white-label.

> **v0.4:** Phase 2 also includes **FX conversion** for ad accounts billed in non-INR currencies. MVP rejects such accounts at connection with a clear error.

> **Design for later, build for now:** keep `platform`, `checkout_provider`, and `logistics_provider` as enums/adapters so Phase 2 integrations slot in without schema rewrites.

---

## 3. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict) | Everywhere |
| Monorepo | pnpm workspaces + Turborepo | |
| API server | Node 20+ with **Fastify** | `zod` for validation, `@fastify/swagger` for OpenAPI |
| Ingest collector | Separate Fastify service | High-throughput, stateless, writes to queue |
| Jobs / queues | **BullMQ** on Redis | Ad syncs, backfills, attribution runs, CAPI dispatch, retention. Two Redis instances: durable (AOF, `noeviction`) for the event stream and queues; cache (`allkeys-lru`) for report caching (v0.2) |
| OLTP DB | **PostgreSQL 16** | Prisma or Drizzle ORM (pick one, record ADR). **v0.6: Drizzle** (ADR-0011); Better Auth's Drizzle adapter shares the schema and migrations |
| Event / analytics DB | **ClickHouse** | Events, touchpoints, ad spend, attribution results. **v0.6: ClickHouse Cloud, AWS ap-south-1** (ADR-0013): smallest tier with idle scaling, backups in Mumbai; conditional on the staging purge/dedupe test, else self-managed EC2 |
| Dashboard | React + Vite + TypeScript | TanStack Query, TanStack Table, Recharts, Tailwind. **v0.5: TanStack Router**, with typed search params, so report filters live in the URL |
| Shopify app | Official Shopify app template (current version) + Web Pixel extension | Embedded admin app for install/settings; main dashboard is separate web app |
| Auth | Email + password / Google SSO via a library (e.g. Lucia/Auth.js) or managed (Clerk) | Record ADR. **v0.5 (ADR-0012): Better Auth**, self-hosted on our Postgres (ap-south-1), with its organization plugin. Lucia is deprecated; Clerk was rejected (US sub-processor) |
| Secrets | AWS Secrets Manager / KMS | OAuth tokens encrypted at rest (envelope encryption) |
| Hosting | **AWS ap-south-1 (Mumbai)** | Keep all personal data in India (see §5.9) |
| Observability | OpenTelemetry → Grafana/Loki or Datadog; Sentry for errors | **No PII in logs**. **v0.5:** **Grafana Cloud, AWS ap-south-1** for logs, metrics and traces. **Sentry SaaS, EU region** for errors, with strict scrubbing (`beforeSend` filter, no replay, no request bodies, no identifiers) — pending counsel sign-off |
| CI/CD | GitHub Actions | Lint, typecheck, test, migrate, deploy |
| Local dev | Docker Compose (Postgres, ClickHouse, Redis) | |
| ClickHouse client | `@clickhouse/client` (official) | v0.2 |
| IP geolocation | DB-IP Lite (local database file, CC BY 4.0) | v0.2. Attribution "IP geolocation by DB-IP" in the dashboard footer and docs |
| User-agent parsing | `ua-parser-js`, pinned to 1.x | v0.2. MIT; do not upgrade to 2.x (AGPL) |
| Transactional email | Amazon SES, ap-south-1 | v0.2. Breach and DSR notifications to merchant staff; listed in `/docs/dpdp/subprocessors.md` |

---

## 4. High-level architecture

```
                   ┌──────────────────────────┐
 Shopper browser → │ Shopify Web Pixel (ext.) │──(consent-gated events)──┐
                   └──────────────────────────┘                          │
                                                                         ▼
                                                             ┌─────────────────────┐
                                                             │ Ingest Collector    │
                                                             │ POST /v1/collect    │
                                                             │ - validate & hash   │
                                                             │ - consent check     │
                                                             └─────────┬───────────┘
                                                                       │ Redis stream / BullMQ
                                                                       ▼
 Shopify webhooks ─────► ┌──────────────┐        ┌──────────────────────────────┐
 Shiprocket webhooks ──► │ Webhook API  │──────► │ Workers                      │
                         └──────────────┘        │ - event enrichment           │
 Meta Marketing API ◄──┐                          │ - sessionisation            │
 Google Ads API ◄──────┤ (scheduled pulls)        │ - identity stitching        │
 Shiprocket API ◄──────┘                          │ - ad sync (Meta/Google)     │
                                                  │ - attribution engine        │
                                                  │ - CAPI dispatcher           │
                                                  │ - retention / DSR jobs      │
                                                  └───────┬───────────┬─────────┘
                                                          │           │
                                                   ┌──────▼───┐  ┌────▼────────┐
                                                   │PostgreSQL│  │ ClickHouse  │
                                                   └──────┬───┘  └────┬────────┘
                                                          └─────┬─────┘
                                                          ┌─────▼──────┐
                                                          │  Core API  │◄── React dashboard
                                                          └────────────┘
                                                                │
                                                  Meta CAPI ◄───┘ (sendback)
```

### Repo layout
```
/apps
  /api            # Core REST API (auth, tenants, reports, DPDP endpoints)
  /collector      # Ingest endpoint for pixel events
  /workers        # BullMQ workers (sync, attribution, capi, retention)
  /dashboard      # React + Vite SPA
  /shopify-app    # Shopify embedded app + web pixel extension
/packages
  /shared         # Types, zod schemas, enums, constants
  /db             # Postgres schema + migrations
  /clickhouse     # CH schema, migrations, query helpers
  /integrations   # Adapters: meta, google-ads, shopify, shiprocket
  /attribution    # Pure attribution engine (no I/O) — heavily unit tested
  /privacy        # Hashing, consent evaluation, masking, DSR helpers
/docs
  /adr            # Architecture decision records
  /dpdp           # Privacy notice templates, DPA template, RoPA
```

---

## 5. DPDP compliance requirements (hard requirements)

### 5.1 Roles
- **The brand (merchant) is the Data Fiduciary** for its shoppers' data.
- **Our platform is a Data Processor** acting on the brand's instructions under a contract.
- **For our own customers' users (merchant staff logging in)**, we are the Data Fiduciary.
- Implication: every tenant must accept a **Data Processing Agreement (DPA)** during onboarding before any tracking is enabled. Store acceptance (version, timestamp, user) in `dpa_acceptances`.

### 5.2 Key dates to design for
- DPDP Rules notified **13 Nov 2025**.
- Penalties and the Consent Manager framework begin **13 Nov 2026**.
- Full substantive compliance (notice, consent, security, rights, breach) due **13 May 2027**.
- MVP must already meet the full-compliance bar; do not plan to retrofit.

### 5.3 Notice & consent
| Req ID | Requirement | Implementation |
|---|---|---|
| P-1 | Tracking of shoppers only after valid consent (free, specific, informed, unambiguous, affirmative action) | Pixel reads **Shopify Customer Privacy API**; marketing/analytics events are only sent when `analyticsProcessingAllowed` / `marketingAllowed` (or current equivalents) are true. Collector re-checks the consent flag in the payload and **drops** events without it. **v0.6 — default-on regions:** where tracking is enabled by default, Shopify runs pixel callbacks until the shopper opts out, and India is likely default-on unless configured. So:<br/>(1) **Onboarding gate**: tracking stays disabled until the merchant confirms their consent banner treats India as opt-in (guide in the dashboard and `/docs/dpdp/README.md`). Where the Admin API `consentPolicy` query is available, `consentRequired=false` for India blocks tracking.<br/>(2) **Runtime signal**: new visitors whose first events arrive with analytics allowed and no consent interaction. **Warn** at ≥ 20% of ≥ 50 new visitors in 24 h; **auto-pause** at ≥ 50% of ≥ 100 sustained 48 h (auto-pause enabled after the dev-store test confirms the signal).<br/>(3) A dev-store test from an Indian IP before and after configuring the banner; counsel review of the confirmation wording and of remediating data collected before detection. |
| P-2 | Itemised, standalone, plain-language notice | Provide a **notice template** (`/docs/dpdp/shopper-notice.md`) in English + Hindi that the merchant embeds in its cookie/consent banner and privacy page. Dashboard shows a checklist: "notice published? banner live?" |
| P-3 | Withdrawal as easy as giving consent | Pixel honours consent revocation immediately; collector receives a `consent_withdrawn` event → visitor flagged, future events dropped, CAPI sendback stops for that visitor. **v0.2:** withdrawal of *analytics* consent also triggers erasure of that visitor's collected data (DPDP Act s.8(7)); marketing-only withdrawal just stops CAPI. *Counsel review pending.* |
| P-4 | Consent evidence | Store consent state changes in `consent_records` (hashed visitor id, purposes, notice version, timestamp, source). No raw PII. |
| P-5 | Purpose limitation | Purposes enumerated: `attribution_analytics`, `ad_platform_measurement` (CAPI). Each event carries the purposes it was consented for; workers check purpose before use. |
| P-6 | Children's data | Do not knowingly process data of children. Provide merchant setting "store sells to minors / child-directed" → disables CAPI sendback & behavioural profiling for that store; flag for legal review. |
| P-7 | Consent Managers (from Nov 2026) | Keep the consent layer behind an interface `ConsentProvider` so a registered Consent Manager can be plugged in later. |

### 5.4 Data minimisation & identifiers
- **Never store raw phone or email in ClickHouse.** Normalise then hash:
  - Phone: E.164 (`+91XXXXXXXXXX`), strip spaces/dashes → `SHA-256`. **v0.3:** dummy numbers (all one repeated digit, a repeated two-digit block, or ascending/descending sequences such as `1234567890` / `9876543210`, plus a platform blocklist) normalise to *no identifier* and are never hashed or used for stitching.
  - Email: trim, lowercase → `SHA-256`.
  - Use SHA-256 **without salt** for values sent to Meta CAPI (Meta requires plain SHA-256), and a **tenant-scoped HMAC-SHA256** (per-tenant key in KMS) for internal joins. Store both only where needed.
  - **v0.2:** CAPI SHA-256 values are never stored. `capi-dispatch` re-fetches the order's phone/email from Shopify at send time and hashes in memory; if the fetch fails, the event is skipped.
  - **v0.2:** per-tenant HMAC keys are derived (HKDF) from a versioned master secret. Every stored HMAC carries its key version as `k<N>:<hex>`, so the master can be rotated.
- IP address: use for geo lookup at ingest (state/city only), then **discard**. **v0.2:** IP is not forwarded to Meta CAPI (CAPI is sent from a worker after ingest, so there is no in-flight moment).
- User agent: parse to device/browser/OS; store parsed fields, keep raw UA ≤ 30 days. **v0.5: the raw UA is not stored at all.** It is parsed at ingest and discarded, until the Meta optimisation-event test decides whether a short-lived, encrypted capture for CAPI is needed.
- Orders in Postgres: store customer name/address **only if needed** — MVP does not need them. Store `order_id`, amounts, payment method (COD/prepaid), pincode (first 3 digits sufficient for RTO analysis in MVP), hashed phone/email.
- **No PII in application logs, error trackers, or analytics tools.** Add a log redaction middleware + a test that fails if a phone/email regex appears in log output.

### 5.5 Security safeguards
| Req ID | Requirement | Implementation |
|---|---|---|
| S-1 | Encryption in transit | TLS 1.2+ everywhere; HSTS on dashboard and collector |
| S-2 | Encryption at rest | RDS/EBS/S3 encryption; OAuth tokens envelope-encrypted with KMS |
| S-3 | Access control | RBAC: `owner`, `admin`, `analyst`, `viewer`; tenant isolation enforced in every query (Postgres RLS or mandatory `tenant_id` scoping in the repository layer + tests) |
| S-4 | Logging & monitoring | `audit_log` for all access to personal-data views, exports, DSR actions, settings changes. Retain security/audit logs **at least 1 year** |
| S-5 | Backups | Automated daily backups, 30-day retention, restore tested quarterly |
| S-6 | Secrets | No secrets in repo; rotate OAuth client secrets and API keys |
| S-7 | Vendor contracts | Sub-processors listed in `/docs/dpdp/subprocessors.md` (AWS, email provider, error tracker) |

### 5.6 Data principal rights (on behalf of merchants)
- Merchant dashboard page **"Privacy Requests"**:
  - Merchant enters shopper phone/email → system hashes it → finds matching identities.
  - Actions: **Access export** (JSON of events/orders linked to that identity), **Erasure** (delete/anonymise across Postgres + ClickHouse), **Correction** (limited: re-link identity).
  - Every request logged in `dsr_requests` with status and SLA timer. **v0.2:** after an erasure, the `dsr_requests` row is the minimal erasure record; the shopper's `consent_records` are deleted (counsel review pending). A later access export returns only that record.
- API endpoint for merchants to automate DSRs: `POST /v1/privacy/requests`. **v0.5:** the only DSR path is the store-scoped `POST /v1/stores/:id/privacy/requests` (§10). Machine API keys for automation are deferred.
- ClickHouse erasure: use `ALTER TABLE ... DELETE WHERE identity_hash IN (...)` via a queued job, or design with a `ReplacingMergeTree` + tombstone pattern; verify completion and record it.
- Grievance contact: each tenant configures a grievance officer contact shown in the notice template.

### 5.7 Retention & erasure
| Data | Default retention | Notes |
|---|---|---|
| Raw pixel events | 13 months | Configurable per tenant (min 3, max 25 months). v0.2: ClickHouse table TTL is 25 months as a backstop; per-tenant windows are enforced by the retention job (mechanism: ADR-0015) |
| Sessions/touchpoints | 13 months | |
| Aggregated reports (no identifiers) | Indefinite | Not personal data once aggregated |
| Order records (hashed ids) | 25 months | Needed for YoY comparisons |
| Consent records | Life of relationship + 1 year | Evidence of consent |
| Audit/security logs | ≥ 1 year | |
| Tenant offboarding | Delete all tenant personal data within 30 days of contract end; export offered first | |

- Nightly `retention` worker enforces these and writes a summary to `audit_log`. **v0.3 (ADR-0015):** ClickHouse row deletions for retention run **weekly**, batched across stores, so rows can outlive their window by up to 7 days. Deleted ClickHouse rows are hidden immediately and physically purged from disk within 7 days (forced merges); backups hold them up to 30 days (S-5).

### 5.8 Breach management
- `breach_incidents` table + internal runbook (`/docs/dpdp/breach-runbook.md`).
- Process: detect → contain → assess → notify affected merchants (the Fiduciaries) **without delay** with the details they need to notify the Data Protection Board and affected shoppers within the legally required timelines → post-mortem.
- Dashboard banner capability to notify tenants.

### 5.9 Data location
- Host all personal data in **AWS Mumbai (ap-south-1)**. Transfer outside India only to Meta/Google as part of the consented measurement purpose (CAPI), and only hashed identifiers.

### 5.10 Compliance acceptance tests (must pass before MVP launch)
1. Event without marketing/analytics consent → dropped at collector, counter incremented, nothing stored.
2. Consent withdrawn → no further events stored, no CAPI sends for that visitor.
3. No raw email/phone in ClickHouse (automated scan query in CI against seed data).
4. No PII in logs (log-scan test).
5. DSR erasure removes identity from all stores; follow-up access export returns empty.
6. Retention job deletes rows older than configured window.
7. Cross-tenant data access attempt returns 404/403 (integration test).
8. Audit log entry exists for every DSR, export and settings change.

---

## 6. Data model

### 6.1 PostgreSQL (OLTP)
```
organizations(id, name, created_at, plan, status)
users(id, email, name, password_hash|null, sso_provider|null, created_at)
  -- v0.5 (ADR-0012, Better Auth): users(id, email, name, email_verified, image, created_at, updated_at);
  --   password_hash and sso_provider move to auth_accounts.
auth_accounts(id, user_id, provider_id, account_id, password|null, access_token|null, refresh_token|null,
              id_token|null, access_token_expires_at, refresh_token_expires_at, scope, created_at, updated_at)   -- v0.5
sessions(id, token, user_id, expires_at, ip_address, user_agent, active_organization_id, created_at, updated_at)   -- v0.5; IP truncated
auth_tokens(id, identifier, value, expires_at, created_at, updated_at)   -- v0.5; email verification / reset
invites(id, organization_id, email, role, status, expires_at, inviter_id)   -- v0.5; 7-day expiry, purged 30 d after use
memberships(user_id, organization_id, role)             -- owner|admin|analyst|viewer
  -- v0.5: + id, created_at (Better Auth member model). organizations + slug, logo, metadata jsonb, status incl. pending_deletion
stores(id, organization_id, platform, shop_domain, currency='INR',
       timezone='Asia/Kolkata', installed_at, status,
       child_directed boolean default false,
       retention_months int default 13,
       privacy_config jsonb default '{}')   -- v0.6: { notice_version, grievance_contact{name,email,phone},
                                            --   checklist{notice_published_at, banner_live_confirmed_at, india_opt_in_confirmed_at},
                                            --   consent_health{status: ok|warn|paused, ratio, measured_at, paused_at} }
                                            -- ONE HOME PER SETTING: child_directed and retention_months live only in their columns
dpa_acceptances(id, organization_id, dpa_version, accepted_by_user_id, accepted_at, ip_truncated)
integrations(id, store_id, provider, external_account_id,
             encrypted_credentials bytea, scopes text[], status,
             last_synced_at, error,
             settings jsonb default '{}')                 -- provider: shopify|meta|google_ads|shiprocket
                                                          -- v0.3: settings = NON-secret config only; all secrets in encrypted_credentials
ad_accounts(id, store_id, provider, external_id, name, currency, timezone)
orders(id, store_id, external_order_id,
       external_order_name null,                              -- v0.4, CONDITIONAL: only if Shiprocket matches Shopify orders by name (e.g. "#1001")
       created_at_platform,
       total_amount_paise bigint, currency, payment_method,   -- cod|prepaid|partial_cod
       refunded_amount_paise bigint default 0,                -- v0.3: total refunded, from Shopify snapshots
       financial_status, fulfilment_status,
       delivery_status,                                       -- pending|in_transit|delivered|rto|cancelled
       delivered_at, rto_at,
       pincode_prefix, phone_hash_hmac, email_hash_hmac,
       visitor_id|null, landing_site, referring_site,
       note_attributes jsonb, discount_codes text[],
       is_first_order boolean,
       attribution_confidence text default 'high')        -- v0.2: high|low; low = UTM fallback (§7.3 rule 4)
order_status_events(id, order_id, source, status, occurred_at, raw_ref)
consent_records(id, store_id, visitor_id, purposes text[], state,   -- granted|withdrawn
                notice_version, source, occurred_at)               -- v0.2: visitor_id = HMAC(visitor_id); id = source event_id
                                                                   -- v0.6: source = pixel_interaction | pixel_initial_state | pixel_refresh
dsr_requests(id, store_id, type, identity_hash, status, requested_by_user_id,
             created_at, due_at, completed_at, result_summary jsonb)
                                                  -- v0.2: result_summary.trigger = merchant|shopify_webhook|consent_withdrawn
                                                  -- v0.6: type = access|erasure|correction|store_erasure (shop/redact, org deletion);
                                                  --       trigger also consent_region_remediation (pending counsel)
store_delivery_rates(store_id, payment_method null,   -- v0.2; null = store-wide row
                     window_days int default 90, delivery_rate numeric(5,4),
                     resolved_orders int,
                     fallback_level,                  -- store_payment_method|store|platform_default
                     computed_at)
  -- resolved = delivered|rto|cancelled; delivery_rate = delivered / (delivered + rto + cancelled)
  -- fallback: store+payment_method (>= 50 resolved) -> store-wide (>= 50) -> platform default
suppressed_identities(store_id, identifier_type,      -- v0.2; visitor_id|identity_hash_hmac
                      identifier,                     -- always an HMAC
                      reason,                         -- erased|withdrawn
                      dsr_request_id null, created_at, expires_at)   -- expires_at = created_at + 13 months
  unique (store_id, identifier_type, identifier, reason)
audit_log(id, organization_id, actor_user_id|null, actor_type, action,
          target_type, target_id, metadata jsonb, created_at)
breach_incidents(id, detected_at, severity, description, affected_tenants uuid[],
                 status, notified_at, closed_at)
channel_rules(id, store_id, priority, match jsonb, channel, sub_channel)   -- UTM→channel mapping
attribution_settings(store_id, default_model, lookback_days int default 30,
                     revenue_basis default 'delivered')
capi_dispatch_log(id, store_id, order_id, event_name, event_id,
                  status, attempts, last_error, sent_at)
```
> Money is stored as **integer paise**. Never floats.
> **v0.2:** every stored HMAC (`*_hash_hmac`, `identity_hash`, HMAC'd visitor ids, `suppressed_identities.identifier`) has the form `k<N>:<64 hex>`.

### 6.2 ClickHouse (events & analytics)
```
events(
  store_id UUID, event_id UUID, event_name LowCardinality(String),   -- v0.2 (Shopify names): page_viewed, product_viewed, product_added_to_cart, checkout_started, checkout_contact_info_submitted, checkout_completed, consent_withdrawn; v0.6: + consent_granted
  occurred_at DateTime64(3, 'Asia/Kolkata'), received_at DateTime64(3),
  visitor_id String, session_id String,
  page_url String, referrer String,
  utm_source, utm_medium, utm_campaign, utm_content, utm_term String,
  fbclid String, gclid String, gbraid String, wbraid String, fbp String, fbc String,
  device_type, os, browser LowCardinality(String), is_in_app_browser UInt8,
  geo_state, geo_city LowCardinality(String),
  consent_purposes Array(String),
  identity_hash_hmac String,           -- set when checkout gives phone/email
  properties String                    -- JSON, no PII
) ENGINE = ReplacingMergeTree PARTITION BY toYYYYMM(occurred_at)          -- v0.2 (ADR-0017)
  ORDER BY (store_id, visitor_id, occurred_at, event_id)                  -- v0.2: event_id appended
  TTL occurred_at + INTERVAL 25 MONTH  -- v0.2: backstop at the 25-month max; per-tenant windows enforced by the retention job

-- v0.6 channel slugs: meta_ads, google_ads, organic_search, email, whatsapp, influencer_affiliate, organic_social,
--   direct, referral, other_campaign (touchpoints); 'unattributed' only in attribution_results
touchpoints(store_id, visitor_id, session_id, occurred_at, channel, sub_channel,
            platform, campaign_id, adset_id, ad_id, click_id_type, is_direct UInt8,
            event_id)                                                    -- v0.2: id of the session-start event
  ENGINE = ReplacingMergeTree PARTITION BY toYYYYMM(occurred_at)          -- v0.2
  ORDER BY (store_id, visitor_id, occurred_at, event_id)
  TTL occurred_at + INTERVAL 25 MONTH

identity_links(store_id, visitor_id, identity_hash_hmac, first_seen, last_seen)
  ENGINE = ReplacingMergeTree(last_seen) ORDER BY (store_id, visitor_id, identity_hash_hmac)   -- v0.2

ad_spend_daily(store_id, platform, date, account_id, campaign_id, campaign_name,
               adset_id, adset_name, ad_id, ad_name,
               spend_paise Int64, impressions, clicks,
               platform_conversions Float64, platform_conversion_value_paise Int64,
               attribution_window LowCardinality(String),               -- v0.4: e.g. '7d_click+1d_view' (Meta), 'google_default'
               synced_at DateTime64(3))                                  -- v0.2: version column
  ENGINE = ReplacingMergeTree(synced_at)
  ORDER BY (store_id, platform, date, campaign_id, ad_id)                 -- v0.2: campaign_id added
  -- v0.2: ad_id = 'pmax:<campaign_id>' where no ad-level id exists (Performance Max)
  -- date is in the ad account's reporting timezone; reads use FINAL / argMax(metric, synced_at)

attribution_results(store_id, order_id, model LowCardinality(String),
                    touchpoint_rank, channel, platform, campaign_id, adset_id, ad_id,
                    credit Float64, computed_at DateTime64(3))
  -- v0.3: revenue_basis and credited_revenue_paise dropped; revenue is computed at query time from order_status.
  -- channel = 'unattributed' when an order has no touchpoints.
  ENGINE = MergeTree ORDER BY (store_id, order_id, model, computed_at, touchpoint_rank)   -- v0.2
  -- v0.2: computed_at is the run version; all rows from one run for an (order, model) share it.
  -- Readers use only max(computed_at) per (store_id, order_id, model); superseded versions are deleted.

order_status(store_id, order_id, delivery_status, total_amount_paise Int64,   -- v0.2: new
             refunded_amount_paise Int64,                                     -- v0.3
             delivered_at, rto_at,
             placed_at DateTime64(3, 'Asia/Kolkata'), payment_method LowCardinality(String),   -- v0.3: reporting columns
             is_first_order UInt8, pincode_prefix LowCardinality(String),
             source_updated_at DateTime64(3))
  ENGINE = ReplacingMergeTree(source_updated_at) ORDER BY (store_id, order_id)
  -- version = source timestamp (Shopify updated_at / Shiprocket status time), not insert time.
  -- Placed vs delivered revenue is computed at query time: latest credit × total_amount_paise (placed)
  -- or × max(0, total_amount_paise − refunded_amount_paise) where delivery_status = 'delivered' (delivered, v0.3).
  -- A delivery-status change never re-runs attribution.
  -- v0.3: tables with deletes set min_age_to_force_merge_seconds = 604800 (physical purge ≤ 7 days, ADR-0015).
```

---

## 7. Tracking & identity

### 7.1 Pixel (Shopify Web Pixel extension)
- Subscribe to standard events: `page_viewed`, `product_viewed`, `product_added_to_cart`, `checkout_started`, `checkout_contact_info_submitted`, `checkout_completed`.
- On first event per browser: generate `visitor_id` (UUID v7), persist in first-party storage available to the pixel sandbox.
- On landing: capture URL params (`utm_*`, `fbclid`, `gclid`, `gbraid`, `wbraid`), `_fbp`/`_fbc` values where accessible, referrer.
- Sessionisation hint: new session after 30 min inactivity or new campaign params (final sessionisation done server-side).
- At `checkout_completed`: include `order_id`, and **hash phone/email client-side is NOT required** — send over TLS to collector which normalises + hashes immediately and discards raw values in memory.
- **Consent gate:** read Customer Privacy API; if not allowed, do not send. Listen for consent changes. **v0.6:**
  - The batch carries `visitor_new` (true when this load created `visitor_id`).
  - `consent_granted` carries `trigger`: `interaction` (from `visitorConsentCollected`), `initial_state` (read at load) or `refresh` (the 30-day refresh).
  - Together these feed the default-on signal (P-1).
- Payload batched; `navigator.sendBeacon`/`fetch keepalive`; max 10 KB per request.

### 7.2 Collector (`POST /v1/collect`)
- Auth: public `store_key` + origin check + HMAC signature generated by pixel settings (rotateable). **v0.2:** the signature is carried in query parameters (`?k=&ts=&kid=&sig=`), with a `text/plain` body so no CORS preflight is needed.
- Validate with zod; reject > 10 KB; rate-limit per store and per IP.
- Steps: consent check → PII normalise & hash → IP → geo → drop IP → parse UA → push to Redis stream.
- Respond `204` quickly; p95 < 50 ms.
- Idempotency via `event_id`.

### 7.3 Identity stitching rules
1. Same `visitor_id` ⇒ same person.
2. Order ↔ visitor: match on `order_id` from `checkout_completed` event (primary).
3. Fallback: `identity_hash_hmac` (phone first, then email) linking multiple `visitor_id`s → merged journey for attribution (cross-device / in-app-browser → Chrome).
4. Fallback 2: Shopify order `landing_site` / `note_attributes` UTMs if no pixel data (mark `attribution_confidence = 'low'`).
5. Never link identities across tenants.

### 7.4 Channel classification (default rules, editable in `channel_rules`)
| Condition | Channel |
|---|---|
| `fbclid` present or `utm_source` ∈ {facebook, fb, instagram, ig, meta} | Meta Ads (paid) if `utm_medium` ∈ {cpc, paid, paid_social} or `fbclid`; else Organic Social |
| `gclid`/`gbraid`/`wbraid` present or `utm_source=google` & `utm_medium=cpc` | Google Ads |
| Referrer google/bing and no click id | Organic Search |
| `utm_medium` ∈ {email} | Email |
| `utm_source` ∈ {whatsapp, wa} | WhatsApp |
| `utm_medium` ∈ {influencer, affiliate} | Influencer/Affiliate |
| Referrer instagram/facebook without params | Organic Social |
| No referrer, no params | Direct |

Map to `campaign_id/adset_id/ad_id` using `utm_campaign/utm_content` conventions: recommend merchants use Meta dynamic params `{{campaign.id}}`, `{{adset.id}}`, `{{ad.id}}` and Google ValueTrack `{campaignid}`, `{adgroupid}`, `{creative}`. Onboarding shows copy-paste URL templates and a "UTM health" check.

---

## 8. Integrations

Each integration lives in `packages/integrations/<provider>` implementing:
```ts
interface IntegrationAdapter {
  provider: Provider;
  authUrl?(state: string): string;
  exchangeCode?(code: string): Promise<Credentials>;
  refresh?(creds: Credentials): Promise<Credentials>;
  healthCheck(creds: Credentials): Promise<HealthStatus>;
}
```

### 8.1 Shopify
- OAuth install from the Shopify app; scopes minimal: `read_orders`, `read_customers` (only if needed for hashed identifiers), `read_products`, pixel-related scopes as required by Web Pixel extension.
  - **v0.3:**
    - Scopes are `read_orders`, `write_pixels` and `read_customer_events`, plus `read_all_orders` once approved. **v0.6 correction (issue #73):** also `read_fulfillments` — required by Shopify to subscribe to the `fulfillments/create`/`fulfillments/update` webhook topics this section already lists; missing from this line since v0.3, caught when `shopify app deploy` refused to create a version without it.
    - `read_customers` is **not needed**: order-level email/phone and `customerJourneySummary.customerOrderIndex` suffice. **v0.5: `read_products` is dropped.**
    - Protected customer data Level 2 is needed for **email, phone and address** (zip → pincode prefix).
    - New public apps must use expiring offline tokens (1 h access, 90-day refresh).
- Webhooks: `orders/create`, `orders/updated`, `orders/cancelled`, `refunds/create`, `fulfillments/create`, `fulfillments/update`, `app/uninstalled`, plus **mandatory GDPR/privacy webhooks** (`customers/data_request`, `customers/redact`, `shop/redact`) → route into the DSR pipeline.
- Verify HMAC on every webhook. Idempotent by webhook id.
- Backfill last 90 days of orders via GraphQL bulk operations. **v0.3:** `read_orders` only reaches 60 days. MVP backfills 60 days, then extends to 90 automatically once `read_all_orders` is approved and granted.
- Payment method detection: COD via payment gateway names / transactions (make mapping configurable).

### 8.2 Meta Marketing API
- Facebook Login for Business → long-lived token; permissions: `ads_read`, `business_management` (as needed). App requires Business Verification + App Review for Advanced Access — **start this in week 1**.
- Daily sync (and intraday every 2–3 h for last 3 days): Ads Insights at ad level, `time_increment=1`, fields: spend, impressions, clicks, actions, action_values for purchase.
- Attribution windows: request only currently supported windows (7-day view & 28-day view were removed in Jan 2026). Store the window used alongside numbers.
- Store our own history from day one (Meta restricts some historical breakdowns to 13 months).
- Handle rate limits via headers (`x-business-use-case-usage`), exponential backoff.

### 8.3 Meta Conversions API (sendback)
- Event `Purchase` at order placed (dedupe with browser pixel via shared `event_id` = `order_<id>`). **v0.3: opt-in per store, OFF by default.** Shopify's Facebook & Instagram channel already sends Purchase with its own event ids, so ours would double-count. Enabling it shows an onboarding warning.
- Custom event `DeliveredPurchase` when Shiprocket marks delivered (value = order value). Merchants can optimise campaigns toward it. **v0.3: on by default;** value is net of refunds.
- Optional `RTO` custom event (for exclusion audiences). **v0.3: on by default,** can be disabled.
- user_data: `ph`, `em` (plain SHA-256 normalised), `fbp`, `fbc`, `client_user_agent`, `external_id` (HMAC visitor id). Only for consented visitors; never for `child_directed` stores.
- **v0.2:**
  - `ph`/`em` come from a Shopify re-fetch of the order at send time, hashed in memory and never stored; if the fetch fails, the event is skipped and logged.
  - No `client_ip_address`. **v0.5:** no `client_user_agent` either on `system_generated` events (DeliveredPurchase, RTO, opt-in Purchase); the raw UA isn't stored.
  - Event ids per event name: `order_<id>` (Purchase), `delivered_<id>` (DeliveredPurchase), `rto_<id>` (RTO).
  - No consent record for the visitor → skip.
- **v0.4:** `event_time` is when the status happened: `delivered_at` for DeliveredPurchase, `rto_at` for RTO, order time for Purchase. Meta rejects `event_time` more than 7 days old, so an event is skipped (`event_too_old`) only when the status was learned more than ~7 days after it happened.
- Log every dispatch in `capi_dispatch_log`; retries with backoff; test mode using `test_event_code`.

### 8.4 Google Ads API
- OAuth with `https://www.googleapis.com/auth/adwords` scope; developer token from our manager (MCC) account.
- Apply for **Basic access** in week 1 (Explorer access has low production quota); plan for Standard access before scaling.
- **v0.5 version policy:** the API version is one config constant in the Google adapter; a CI check fails within 60 days of the pinned version's sunset ([Google Ads deprecation and sunset](https://developers.google.com/google-ads/api/docs/sunset-dates)); upgrades are planned about twice a year.
- Daily GAQL reports: `ad_group_ad` level with `metrics.cost_micros`, `impressions`, `clicks`, `conversions`, `conversions_value`, `segments.date`. Convert micros → paise. **v0.4:** plus a **3-hourly intraday pull** (09:00–24:00 IST, yesterday + today) so §13's "ad spend < 3 h" holds; an account-total completeness check; REST API with no client-library dependency.
- Handle Performance Max (asset-group level; ad-level may be unavailable — record at campaign level).

### 8.5 Shiprocket
- Auth via API user token (merchant creates API user in Shiprocket); refresh as required.
- Webhook for tracking updates where available; else poll shipments for orders in `in_transit` every 6 h. **v0.4:**
  - The webhook URL is the neutral `/webhooks/lp/:token`, because Shiprocket may reject URLs containing its name.
  - A webhook is only a hint; status is always re-read from the tracking API.
  - A daily sweep runs for all stores.
  - Unmapped statuses never change an order's status.
- Map statuses → `delivered | rto | in_transit | cancelled`. Keep a mapping table; statuses vary.
- Match shipments to orders via channel order id.

---

## 9. Attribution engine (`packages/attribution`)

Pure, deterministic functions. No I/O.

```ts
type Touchpoint = { ts: number; channel: string; platform?: 'meta'|'google'|null;
                    campaignId?: string; adsetId?: string; adId?: string; isDirect: boolean };
type Model = 'first_click'|'last_click'|'last_non_direct'|'linear'|'time_decay'|'position_based';
function attribute(tps: Touchpoint[], orderTs: number, model: Model,
                   opts: { lookbackDays: number; halfLifeDays?: number }): Credit[]; // credits sum to 1
```

Rules:
- Filter touchpoints to `[orderTs - lookback, orderTs]`.
- Collapse consecutive identical touchpoints within the same session.
- `last_non_direct`: ignore direct unless all are direct.
- `time_decay`: default half-life 7 days.
- `position_based`: 40% first, 40% last, 20% spread over middle; 1 tp → 100%; 2 tps → 50/50.
- No touchpoints → credit 100% to `Unattributed`.
- Revenue basis: `placed` = order total at placement; `delivered` = order total only if `delivery_status = delivered` (RTO/cancelled → 0; pending → counted in a separate "pending" bucket, shown as projected with the store's historical delivery rate). **v0.3:** delivered = order total − refunded amount (floor 0).
- Run incrementally on new/updated orders + nightly full recompute of last 45 days (orders change status late).
- **Property-based tests**: credits always sum to 1 (±1e-9), no negative credits, deterministic output.

### Metrics exposed
Spend, attributed orders, attributed revenue (placed/delivered), ROAS (placed/delivered), CPA, platform-reported ROAS vs ours (delta %), RTO rate per campaign/ad, COD share, new vs returning customer split, blended MER (total revenue / total spend).

---

## 10. API (Core) — MVP endpoints

```
Auth
  POST /v1/auth/signup | /login | /logout ; GET /v1/me
Org & stores
  GET/POST /v1/orgs ; GET /v1/orgs/:id/stores ; POST /v1/orgs/:id/invites
  POST /v1/orgs/:id/dpa/accept
Integrations
  GET  /v1/stores/:id/integrations
  GET  /v1/integrations/:provider/connect?storeId=   (OAuth start)
       v0.3 — Shopify first install: /v1/integrations/shopify/connect?orgId=&shop=<name>.myshopify.com
  PUT  /v1/integrations/:id/settings                 (v0.3: non-secret settings, e.g. COD mapping, CAPI event toggles)
  GET  /v1/integrations/:provider/callback
  POST /v1/integrations/shiprocket   (API credentials)
  DELETE /v1/integrations/:id
Reports
  GET /v1/stores/:id/reports/overview?from&to&model&basis
  GET /v1/stores/:id/reports/breakdown?level=channel|campaign|adset|ad&...
  GET /v1/stores/:id/reports/model-comparison?...
  GET /v1/stores/:id/orders/:orderId/journey
  GET /v1/stores/:id/reports/rto?level=campaign|ad|pincode_prefix
Settings
  GET/PUT /v1/stores/:id/attribution-settings
  GET/PUT /v1/stores/:id/channel-rules
  GET/PUT /v1/stores/:id/privacy-settings   (retention, child_directed, notice version)
Privacy (DPDP)
  POST /v1/stores/:id/privacy/requests      {type, phone?|email?}
  GET  /v1/stores/:id/privacy/requests
  GET  /v1/stores/:id/privacy/requests/:rid/export
  GET  /v1/stores/:id/privacy/consent-stats  (v0.5: pixel coverage, dropped-event counts, withdrawals per week)
v0.5 additions
  GET  /v1/stores/:id/reports/rto?level=campaign|ad|pincode_prefix|device_type|in_app_browser
  POST /v1/invites/:token/accept
  PUT  /v1/orgs/:id/members/:userId    {role} ;  DELETE /v1/orgs/:id/members/:userId
  DELETE /v1/orgs/:id                   (owner only; export offered first; 7-day grace; full deletion ≤ 30 days; audited)
  POST /v1/orgs/:id/deletion/cancel     (v0.6: owner only, within the 7-day grace period; audited)
  /v1/auth/*                            (Better Auth-managed routes: Google sign-in/callback, email verification, password reset)
Audit
  GET /v1/orgs/:id/audit-log
Webhooks (public)
  POST /webhooks/shopify/:topic ; POST /webhooks/lp/:token   (v0.4: was /webhooks/shiprocket; :token identifies store + logistics provider)
Collector (separate service)
  POST /v1/collect
```
- All report endpoints: tenant-scoped, cached (Redis, 5 min), p95 < 1.5 s for 90-day ranges.
- Export endpoints write audit entries.

---

## 11. Dashboard (React) — MVP screens

1. **Onboarding wizard:** create org → accept DPA → install Shopify app → connect Meta → connect Google → connect Shiprocket → UTM template setup → consent/notice checklist → "tracking live" verification (shows first events arriving). **v0.6:** the consent/notice step includes a guided **"Set India to opt-in"** confirmation. Tracking stays disabled until it is ticked (and, where available, the `consentPolicy` check passes).
2. **Overview:** date range (IST), model selector, revenue basis toggle (Placed / Delivered). KPI cards: Spend, Revenue, ROAS, Orders, CPA, RTO %, MER. Trend chart. "Platform-reported vs TruePath" comparison for Meta & Google.
3. **Attribution table:** drill channel → campaign → ad set → ad. Columns: spend, orders, revenue, ROAS (placed/delivered), CPA, RTO %, COD %, platform ROAS, delta. Sort, filter, CSV export (audited).
4. **Model comparison:** same rows, columns per model.
5. **Order journeys:** search by order id → timeline of touchpoints with credits per model.
6. **RTO insights:** RTO % by campaign, ad, pincode prefix, device, in-app browser.
7. **Settings:** attribution defaults, channel rules, integrations health, team & roles.
8. **Privacy:** consent stats (consent rate, events dropped), privacy requests, retention settings, notice template download, sub-processor list, audit log. **v0.5:** "consent rate" is replaced by **pixel coverage** (orders with a pixel match ÷ all orders), **dropped-event counts**, and **withdrawals per week**. A consent rate can't be measured, because the pixel doesn't load without consent. Pixel coverage also appears on the integration health screen (settings).

UX: INR formatting with lakh/crore (`Intl.NumberFormat('en-IN')`), IST everywhere, empty states that explain what to connect.

---

## 12. Milestones & tickets (≈ 14 weeks, 3–4 engineers)

### M0 — Foundations (Week 1–2)
- [ ] M0-1 Monorepo scaffold, lint/format/typecheck, CI
- [ ] M0-2 Docker Compose (Postgres, ClickHouse, Redis); env validation with zod
- [ ] M0-3 Postgres schema v1 + migrations; ClickHouse schema v1
- [ ] M0-4 Auth, orgs, memberships, RBAC middleware, tenant scoping + tests
- [ ] M0-5 `packages/privacy`: normalisers, SHA-256 & HMAC hashing, log redaction + PII log-scan test
- [ ] M0-6 Audit log service
- [ ] M0-7 **Non-code:** **create the Meta app** (v0.5), apply for Meta App Review/Business Verification, Google Ads developer token (Basic), create Shopify Partner app; **request Shopify protected customer data access (Level 2: email, phone and address fields) for the app** (v0.2/v0.3 — needed for pixel checkout contact data, order webhooks, the CAPI re-fetch, and the zip → pincode prefix; dev stores work without approval, production does not); **apply for `read_all_orders`** (v0.3 — non-blocking; the backfill uses 60 days until approved); draft DPA + shopper notice with counsel
- **Exit:** user can sign up, create org, accept DPA; CI green.

### M1 — Shopify + tracking (Week 3–5)
- [ ] M1-1 Shopify OAuth install, store record, uninstall handling
- [ ] M1-2 Order webhooks + HMAC verification + idempotency; privacy webhooks → DSR pipeline
- [ ] M1-3 90-day order backfill (bulk operations) — v0.3: 60 days until `read_all_orders` is approved, then auto-extend to 90
- [ ] M1-4 Web Pixel extension with consent gating
- [ ] M1-5 Collector service (validation, consent check, hashing, geo, UA parse, queue)
- [ ] M1-6 Event worker → ClickHouse; sessionisation; touchpoint builder; channel rules
- [ ] M1-7 Identity stitching (order ↔ visitor, hashed phone/email links)
- [ ] M1-8 **(v0.5) Meta App Review warm-up**: a thin read-only insights-sync slice (one endpoint, `act_<id>/insights`, every 15 min) against our test ad account and one design partner's account. Meta's Advanced Access needs ≥ 1,500 successful Marketing API calls in 15 days with < 15% errors. The full Meta integration stays in M2.
- **Exit:** test store orders appear with full journeys; unconsented events dropped (test).

### M2 — Ad platforms + Shiprocket (Week 6–8)
- [ ] M2-1 Meta OAuth + ad account selection + daily/intraday insights sync
- [ ] M2-2 Google Ads OAuth + account selection + GAQL daily sync
- [ ] M2-3 Shiprocket credentials + status sync/webhook + status mapping
- [ ] M2-4 Integration health checks + error surfacing
- **Exit:** spend and delivery status populated for a real design-partner store.

### M3 — Attribution + reports (Week 9–11)
- [ ] M3-1 `packages/attribution` all 6 models + property-based tests
- [ ] M3-2 Attribution worker (incremental + nightly 45-day recompute)
- [ ] M3-3 Report queries (overview, breakdown, model comparison, journey, RTO)
- [ ] M3-4 Dashboard: onboarding wizard, overview, attribution table, journeys, RTO, settings
- **Exit:** design partner can compare platform ROAS vs delivered ROAS by campaign.

### M4 — CAPI + DPDP completion + hardening (Week 12–14)
- [ ] M4-1 Meta CAPI Purchase + DeliveredPurchase + dedupe + dispatch log
- [ ] M4-2 Privacy page: DSR (access/erasure/correction), consent stats, retention settings
- [ ] M4-3 Retention worker + ClickHouse deletion jobs + verification
- [ ] M4-4 Breach register + runbook; sub-processor list
- [ ] M4-5 Compliance acceptance tests (§5.10) in CI
- [ ] M4-6 Load test collector (target 500 events/s sustained on MVP infra), security review, backups/restore test
- **Exit:** all §5.10 tests pass; 3–5 design partners live.

---

## 13. Non-functional requirements
- Collector availability 99.9%; events never lost once `204` returned (queue persistence).
- Data freshness: pixel events < 5 min; ad spend < 3 h; delivery status < 6 h.
- Report API p95 < 1.5 s (90 days, 50k orders).
- All timestamps stored UTC in Postgres, rendered IST; ClickHouse `DateTime64` with explicit TZ.
- Money in paise (int64). Micros from Google converted with integer math.

## 14. Testing strategy
- Unit: attribution engine (property-based with fast-check), normalisers/hashing, channel rules.
- Integration: webhooks (fixtures), adapters with recorded HTTP (nock/msw), tenant isolation.
- E2E: Playwright for onboarding + reports on seeded data.
- Compliance suite: §5.10, runs in CI on every PR.
- Seed generator: synthetic store with realistic India mix (55% COD, 25% RTO on COD, 70% mobile, 40% in-app browser traffic).

## 15. Open decisions (create ADRs)
1. Prisma vs Drizzle — **v0.6: decided, ADR-0011 Accepted (Drizzle)**
2. Auth: self-hosted library vs Clerk — **v0.5: decided, ADR-0012 Accepted (Better Auth, self-hosted)**
3. ClickHouse self-managed on EC2 vs ClickHouse Cloud (India region availability) — **v0.6: decided, ADR-0013 Accepted (Cloud ap-south-1, conditional on the staging test)**
4. Pixel → collector domain: our domain first vs merchant subdomain CNAME (better first-party persistence; more onboarding friction) — **v0.6: decided, ADR-0014 Accepted (our own domain; revisit if pixel coverage is low on desktop-heavy stores)**
5. Deletion strategy in ClickHouse (lightweight deletes vs mutations vs tombstones) — ADR-0015 (**Accepted**, v0.3: lightweight deletes, weekly batched retention, physical purge ≤ 7 days)

v0.2 — decided during architecture review (not in the original list): tenant isolation via a mandatory scoped data layer (ADR-0016, Accepted); event de-duplication (ADR-0017, Accepted).

## 16. Glossary
- **RTO:** Return to Origin — undelivered order shipped back (mostly COD refusals).
- **Delivered ROAS:** attributed revenue from delivered orders ÷ spend.
- **MER:** Marketing Efficiency Ratio — total revenue ÷ total ad spend.
- **CAPI:** Meta Conversions API (server-side events).
- **DSR:** Data subject/principal request (access, correction, erasure).
- **Data Fiduciary / Processor:** DPDP roles — the brand decides purposes; we process on its behalf.
