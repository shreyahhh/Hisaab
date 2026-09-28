// ClickHouse migrations (SQL DDL under migrations/), and — from M0-4 — the scoped query builder
// (`ch(scope, storeId)`) that is the only permitted API onto ClickHouse (ADR-0016). No raw SQL
// strings anywhere else in the codebase.

export { createClickHouseClient, type ClickHouseEnv } from './client.js';
// Re-exported so other packages can type a client without importing `@clickhouse/client` themselves
// (eslint data-access boundary).
export type { ClickHouseClient } from '@clickhouse/client';
export { parseClickHouseBigInt, parseClickHouseInt64, parseInt64Fields } from './parseInt64.js';
export {
  ch,
  CLICKHOUSE_TABLES,
  type ClickHouseTableName,
  type ClickHouseParamType,
  type WhereCondition,
  type ScopedSelectOptions,
  type ScopedClickHouse,
} from './queryBuilder.js';
