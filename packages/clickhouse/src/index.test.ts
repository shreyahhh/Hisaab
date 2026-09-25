import { describe, expect, it } from 'vitest';
import { createClickHouseClient } from './index.js';

describe('@truepath/clickhouse', () => {
  it('constructs a client from env without connecting (constructor is lazy)', () => {
    const client = createClickHouseClient({
      CLICKHOUSE_URL: 'http://localhost:8123',
      CLICKHOUSE_USER: 'truepath',
      CLICKHOUSE_PASSWORD: 'truepath',
      CLICKHOUSE_DB: 'truepath',
    });
    expect(client).toBeDefined();
  });
});
