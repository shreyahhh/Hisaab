# @truepath/db

PostgreSQL 16 schema (Drizzle, ADR-0011) and migrations, and — from M0-4 — the scoped repository
layer that is the only permitted way to query Postgres for tenant data (ADR-0016). Better Auth
(`packages/auth`) is the one allowed exception, for its own identity tables only.

## Schema (M0-3, revised M0-3 fix-up)

`src/schema/` has one file per SPEC §6.1 group: `auth.ts` (Better Auth's own tables — schema only,
see the file header), `tenancy.ts`, `integrations.ts`, `orders.ts`, `privacy.ts`, `attribution.ts`,
plus `enums.ts` and `columns.ts`. `src/schema/schema.test.ts` checks table/column names, the
tenant-scope column rule, the "no raw phone/email column" rule, every CHECK constraint, every
idempotency unique constraint, and `audit_log`'s non-cascading FK.

**Enum columns are split two ways** (`enums.ts` vs `@truepath/shared` `valueLists.ts`):
- **Native `pgEnum`** (`enums.ts`) for value sets that are stable and fully code-controlled:
  `attribution_confidence`, `consent_state`, `delivery_rate_fallback_level`,
  `suppression_identifier_type`, `suppression_reason`, `revenue_basis`, `attribution_model`,
  `audit_actor_type`.
- **`text` + `CHECK`** (values from `@truepath/shared` `valueLists.ts`, via `columns.ts`'s
  `checkOneOf` helper) for external-facing or proven-to-evolve categories: `platform`, `provider`
  (`integrations`/`ad_accounts`), `delivery_status`, `payment_method`, channel slugs, `dsr` type,
  `audit_log.action`, CAPI event names, `order_status_events.source`, `consent_records.source`,
  plus the status-style columns `stores.status`, `organizations.status`, `integrations.status`,
  `dsr_requests.status`, `capi_dispatch_log.status`. A `CHECK` is a one-line migration to extend;
  a `pgEnum` needs `ALTER TYPE ... ADD VALUE`, which can't run inside a transaction with other DDL.
  `invites.status` deliberately has **no** `CHECK` — Better Auth's organization plugin owns that
  field's lifecycle (M0-4), and constraining it early risks rejecting a value the plugin considers
  valid.

**Idempotency unique constraints** the LLDs' upsert flows rely on: `orders(store_id,
external_order_id)`, `integrations(store_id, provider, external_account_id)` (`NULLS NOT DISTINCT`,
Postgres 16 — `external_account_id` is null until OAuth completes), `ad_accounts(store_id, provider,
external_id)`, `capi_dispatch_log(store_id, event_id)` (tenant-scoped, not a bare global unique),
`store_delivery_rates(store_id, payment_method)` (`NULLS NOT DISTINCT`, so the single store-wide
row is actually enforced), `suppressed_identities(store_id, identifier_type, identifier, reason)`,
and `auth_accounts(provider_id, account_id)` (a Better Auth/OAuth correctness necessity, not
explicitly named in `auth-tenancy.md`).

**`audit_log.organization_id`** has `onDelete: 'set null'`, not `cascade` — audit history must
outlive what it audits (S-4, "≥ 1 year"). In practice `organizations` rows are never hard-deleted
(`auth-tenancy.md` §4.6 tombstones them instead), so this is defence in depth. Once the app's own
Postgres role is created (M0-6), it will have no `UPDATE`/`DELETE` grant on `audit_log` — inserts
and reads only.

**Money as `bigint` `mode: 'number'`** (`orders.totalAmountPaise`/`refundedAmountPaise`): safe
because `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991) is ~₹90,000 crore in paise — orders of
magnitude beyond SPEC's target store size (₹10L–₹5Cr monthly GMV) or any plausible aggregate of
them. `mode: 'number'` is far simpler than `BigInt` for the arithmetic done elsewhere (attribution
credits, refund math) and this is the only place it would matter.

## Migrations

```sh
pnpm --filter @truepath/db db:generate   # drizzle-kit generate — schema -> SQL, no live DB needed
pnpm --filter @truepath/db db:migrate    # applies migrations/*.sql to DATABASE_URL
```

Two migrations: `0000_clean_sleeper.sql` (M0-3, applied — never edit it) and a second one from the
M0-3 fix-up (enum→text+CHECK, new unique constraints, composite indexes, `audit_log`'s FK). CI
(`db-migrations` job) applies both against real Postgres/ClickHouse containers on every PR.
