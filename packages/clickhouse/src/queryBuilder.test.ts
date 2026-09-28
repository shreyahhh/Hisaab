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

  it('insert() is synchronous and accepts ISO-8601 timestamps (event-workers XACKs right after it)', async () => {
    const storeC = randomUUID();
    const eventId = randomUUID();
    const scoped = ch(client, tenantScope(storeC), storeC);
    try {
      await scoped.insert('events', [
        {
          store_id: storeC,
          event_id: eventId,
          event_name: 'page_viewed',
          // an ISO-8601 timestamp with an offset, as a stream entry can carry
          occurred_at: '2026-09-28T15:30:00.123+05:30',
          received_at: '2026-09-28T10:00:01.000Z',
          visitor_id: 'v1',
          session_id: 's1',
          page_url: 'https://shop.example.com/',
          referrer: '',
          utm_source: '',
          utm_medium: '',
          utm_campaign: '',
          utm_content: '',
          utm_term: '',
          fbclid: '',
          gclid: '',
          gbraid: '',
          wbraid: '',
          fbp: '',
          fbc: '',
          device_type: 'mobile',
          os: 'Android',
          browser: 'Chrome',
          is_in_app_browser: 0,
          geo_state: '',
          geo_city: '',
          consent_purposes: ['attribution_analytics'],
          identity_hash_hmac: '',
          properties: '{}',
        },
      ]);
      // Visible the moment insert() returns — no waiting, no OPTIMIZE.
      const rows = await scoped.select<{ event_id: string }>({
        table: 'events',
        columns: ['event_id'],
      });
      expect(rows.map((r) => r.event_id)).toEqual([eventId]);
    } finally {
      await client.command({
        query: `ALTER TABLE events DELETE WHERE store_id = {s:UUID}`,
        query_params: { s: storeC },
      });
    }
  });

  it('insert() asks ClickHouse for a synchronous, committed insert (contract with the caller that XACKs)', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fake = {
      insert: (params: Record<string, unknown>) => {
        calls.push(params);
        return Promise.resolve();
      },
    } as unknown as Parameters<typeof ch>[0];
    const scoped = ch(fake, tenantScope(storeA), storeA);
    await scoped.insert('touchpoints', [{ store_id: storeA }]);
    await scoped.insert('touchpoints', []); // nothing to send, nothing sent

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      table: 'touchpoints',
      format: 'JSONEachRow',
      clickhouse_settings: { wait_end_of_query: 1, async_insert: 0 },
    });
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
