# @truepath/clickhouse

ClickHouse schema/migrations, and — from M0-4 — the scoped query builder (`ch(scope, storeId)`)
that is the only permitted API onto ClickHouse (ADR-0016) — no raw SQL strings anywhere else in
the codebase.

## Schema (M0-3)

`migrations/*.sql`, one file per SPEC §6.2 table (`events`, `touchpoints`, `identity_links`,
`ad_spend_daily`, `attribution_results`, `order_status`), engines/`ORDER BY`/TTL exactly as HLD §8
specifies. `src/migrations.test.ts` checks each file's DDL shape against HLD §8 without needing a
live server.

```sh
pnpm --filter @truepath/clickhouse db:migrate   # applies migrations/*.sql, tracked in schema_migrations
```

Not run against a live ClickHouse in this sandbox (no Docker available) — only the DDL-shape tests
have been verified. Run `docker compose up clickhouse` and then `pnpm db:migrate` to confirm the
migrations actually apply.
