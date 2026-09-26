import { randomUUID } from 'node:crypto';
import type { SystemScope, TenantScope } from '@truepath/shared';
import { TenantScopeViolationError } from '@truepath/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDotEnvIfPresent, loadEnv, clickhouseEnvSchema } from '@truepath/shared';
import { createClickHouseClient } from './client.js';
import { ch } from './queryBuilder.js';
import { parseClickHouseInt64 } from './parseInt64.js';

loadDotEnvIfPresent('../../.env');
const env = loadEnv(clickhouseEnvSchema);
const client = createClickHouseClient(env);

function tenantScope(storeId: string): TenantScope {
  return {
    kind: 'tenant',
    userId: 'user-a',
    organizationId: 'org-a',
    role: 'owner',
    storeIds: new Set([storeId]),
  };
}

const systemScope: SystemScope = { kind: 'system', reason: 'retention', auditId: 'test' };

interface OrderStatusRow {
  order_id: string;
  delivery_status: string;
  total_amount_paise: string; // ClickHouse Int64 comes back as a quoted string over JSONEachRow
}

describe('ch() — scoped ClickHouse query builder (ADR-0016)', () => {
  const storeA = randomUUID();
  const storeB = randomUUID();
  const orderA = randomUUID();
  const orderB = randomUUID();

  beforeAll(async () => {
    const now = new Date().toISOString();
    await client.insert({
      table: 'order_status',
      values: [
        {
          store_id: storeA,
          order_id: orderA,
          delivery_status: 'delivered',
          total_amount_paise: 150000,
          refunded_amount_paise: 0,
          delivered_at: now,
          rto_at: null,
          placed_at: now,
          payment_method: 'cod',
          is_first_order: 1,
          pincode_prefix: '400',
          source_updated_at: now,
        },
        {
          store_id: storeB,
          order_id: orderB,
          delivery_status: 'delivered',
          total_amount_paise: 999999,
          refunded_amount_paise: 0,
          delivered_at: now,
          rto_at: null,
          placed_at: now,
          payment_method: 'prepaid',
          is_first_order: 1,
          pincode_prefix: '110',
          source_updated_at: now,
        },
      ],
      format: 'JSONEachRow',
    });
  });

  afterAll(async () => {
    await client.command({
      query: `ALTER TABLE order_status DELETE WHERE store_id IN ({a:UUID}, {b:UUID})`,
      query_params: { a: storeA, b: storeB },
    });
    await client.close();
  });

  it('throws immediately if the scope does not cover the requested store', () => {
    const scope = tenantScope(storeA);
    expect(() => ch(client, scope, storeB)).toThrow(TenantScopeViolationError);
  });

  it("scopes select() to the store, never returning another tenant's rows", async () => {
    const scoped = ch(client, tenantScope(storeA), storeA);
    const rows = await scoped.select<OrderStatusRow>({
      table: 'order_status',
      columns: ['order_id', 'delivery_status', 'total_amount_paise'],
    });
    expect(rows.map((r) => r.order_id)).toEqual([orderA]);
    expect(rows.every((r) => r.order_id !== orderB)).toBe(true);
  });

  it('parses an Int64 result column via parseClickHouseInt64', async () => {
    const scoped = ch(client, tenantScope(storeA), storeA);
    const [row] = await scoped.select<OrderStatusRow>({
      table: 'order_status',
      columns: ['total_amount_paise'],
    });
    expect(row).toBeDefined();
    expect(parseClickHouseInt64(row!.total_amount_paise)).toBe(150000);
  });

  it('allows a SystemScope to query any store', async () => {
    const scoped = ch(client, systemScope, storeB);
    const rows = await scoped.select<OrderStatusRow>({
      table: 'order_status',
      columns: ['order_id'],
    });
    expect(rows.map((r) => r.order_id)).toEqual([orderB]);
  });

  it('treats a where value containing SQL-like text as literal data, not injected SQL', async () => {
    const scoped = ch(client, tenantScope(storeA), storeA);
    const rows = await scoped.select<OrderStatusRow>({
      table: 'order_status',
      columns: ['order_id'],
      where: {
        delivery_status: { op: '=', value: "x' OR '1'='1", type: 'String' },
      },
    });
    expect(rows).toEqual([]);
  });

  it('rejects an unknown table name', async () => {
    const scoped = ch(client, tenantScope(storeA), storeA);
    const unknownTable =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately an invalid table name, to prove the allowlist rejects it
      'orders; DROP TABLE order_status' as any;
    await expect(scoped.select({ table: unknownTable, columns: ['order_id'] })).rejects.toThrow(
      /Unknown ClickHouse table/,
    );
  });

  it('rejects an unsafe column identifier', async () => {
    const scoped = ch(client, tenantScope(storeA), storeA);
    await expect(
      scoped.select({ table: 'order_status', columns: ['order_id, (SELECT 1)'] }),
    ).rejects.toThrow(/Unsafe ClickHouse identifier/);
  });

  it('insert() refuses a row whose store_id does not match the scoped store', async () => {
    const scoped = ch(client, tenantScope(storeA), storeA);
    await expect(
      scoped.insert('order_status', [
        {
          store_id: storeB,
          order_id: randomUUID(),
          delivery_status: 'delivered',
          total_amount_paise: 1,
          refunded_amount_paise: 0,
          placed_at: new Date().toISOString(),
          payment_method: 'cod',
          is_first_order: 1,
          pincode_prefix: '400',
          source_updated_at: new Date().toISOString(),
        },
      ]),
    ).rejects.toThrow(TenantScopeViolationError);
  });
});
