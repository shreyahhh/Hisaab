# 0004. PostgreSQL 16 for OLTP state

## Status
Accepted (fixed in SPEC §3); ORM: Accepted ADR-0011 (Drizzle)

## Context
Tenants, users, memberships, integrations (with encrypted credentials), orders, consent records, DSR requests, audit log, breach register and settings need transactions, constraints and relational integrity.

## Decision
Use **PostgreSQL 16 on RDS** (Multi-AZ, encrypted at rest, ap-south-1) for all OLTP tables in SPEC v0.5 §6.1, including the Better Auth identity tables (ADR-0012).
- Access goes through the scoped repository layer in `packages/db` (ADR-0016); Better Auth is the one exception, for its own tables.
- Postgres advisory locks serialise OAuth token refreshes (shopify / google / shiprocket LLDs), so no extra Redis lock keys are needed.

## Consequences
- Transactions make webhook idempotency (`ON CONFLICT` on `order_status_events.raw_ref`) and out-of-order guards simple.
- Daily backups with 30-day retention and quarterly restore tests (S-5). Erased data remains in backups until they expire; this is disclosed.
- RLS remains available as future defence-in-depth (ADR-0016).
