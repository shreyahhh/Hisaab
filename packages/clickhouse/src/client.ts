import { createClient, type ClickHouseClient } from '@clickhouse/client';

export interface ClickHouseEnv {
  CLICKHOUSE_URL: string;
  CLICKHOUSE_USER: string;
  CLICKHOUSE_PASSWORD: string;
  CLICKHOUSE_DB: string;
}

// The one place @clickhouse/client is instantiated (ADR-0016 data-access boundary). From M0-4,
// the scoped query builder (`ch(scope, storeId)`) is the only other permitted API onto ClickHouse
// — no raw SQL strings anywhere else in the codebase.
export function createClickHouseClient(env: ClickHouseEnv): ClickHouseClient {
  return createClient({
    url: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USER,
    password: env.CLICKHOUSE_PASSWORD,
    database: env.CLICKHOUSE_DB,
  });
}
