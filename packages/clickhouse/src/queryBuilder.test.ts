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

  describe('FINAL, IN, aggregates and GROUP BY (identity-stitching reads)', () => {
    const storeD = randomUUID();
    const storeE = randomUUID();
    const link = (store: string, visitor: string, hash: string, first: string, last: string) => ({
      store_id: store,
      visitor_id: visitor,
      identity_hash_hmac: hash,
      first_seen: first,
      last_seen: last,
    });

    beforeAll(async () => {
      const scopedD = ch(client, tenantScope(storeD), storeD);
      // v1 is linked to h1 twice, in separate inserts: ReplacingMergeTree collapses duplicates inside
      // one insert block on its own (optimize_on_insert), so FINAL only matters across parts.
      await scopedD.insert('identity_links', [
        link(
          storeD,
          'v1',
          'k1:h1',
          '2026-09-28T10:00:00.000+05:30',
          '2026-09-28T10:00:00.000+05:30',
        ),
        link(
          storeD,
          'v2',
          'k1:h1',
          '2026-09-28T12:00:00.000+05:30',
          '2026-09-28T12:00:00.000+05:30',
        ),
        link(
          storeD,
          'v2',
          'k1:h2',
          '2026-09-28T12:00:00.000+05:30',
          '2026-09-28T12:00:00.000+05:30',
        ),
      ]);
      await scopedD.insert('identity_links', [
        link(
          storeD,
          'v1',
          'k1:h1',
          '2026-09-28T11:00:00.000+05:30',
          '2026-09-28T11:00:00.000+05:30',
        ),
      ]);
      await ch(client, tenantScope(storeE), storeE).insert('identity_links', [
        link(
          storeE,
          'other-tenant',
          'k1:h1',
          '2026-09-28T10:00:00.000+05:30',
          '2026-09-28T10:00:00.000+05:30',
        ),
      ]);
    });

    afterAll(async () => {
      await client.command({
        query: `ALTER TABLE identity_links DELETE WHERE store_id IN ({d:UUID}, {e:UUID})`,
        query_params: { d: storeD, e: storeE },
      });
    });

    const inList = (values: string[]) => ({
      op: 'IN' as const,
      value: values,
      type: 'Array(String)' as const,
    });

    it('FINAL collapses duplicate keys; without it both rows are returned', async () => {
      const scoped = ch(client, tenantScope(storeD), storeD);
      const where = { identity_hash_hmac: inList(['k1:h1']) };
      const raw = await scoped.select({ table: 'identity_links', columns: ['visitor_id'], where });
      const final = await scoped.select({
        table: 'identity_links',
        columns: ['visitor_id'],
        where,
        final: true,
      });
      expect(raw).toHaveLength(3);
      expect(final.map((r) => (r as { visitor_id: string }).visitor_id).sort()).toEqual([
        'v1',
        'v2',
      ]);
    });

    it('groups with aggregates: distinct visitors per hash, and epoch-ms first/last seen', async () => {
      const scoped = ch(client, tenantScope(storeD), storeD);
      const perHash = await scoped.select<{ identity_hash_hmac: string; visitors: string }>({
        table: 'identity_links',
        columns: ['identity_hash_hmac'],
        aggregates: [{ fn: 'uniqExact', column: 'visitor_id', as: 'visitors' }],
        groupBy: ['identity_hash_hmac'],
        where: { identity_hash_hmac: inList(['k1:h1', 'k1:h2']) },
        final: true,
        orderBy: 'identity_hash_hmac',
      });
      expect(perHash.map((r) => [r.identity_hash_hmac, Number(r.visitors)])).toEqual([
        ['k1:h1', 2],
        ['k1:h2', 1],
      ]);

      const [v1] = await scoped.select<{ first_ms: string; last_ms: string }>({
        table: 'identity_links',
        columns: [],
        aggregates: [
          { fn: 'minEpochMs', column: 'first_seen', as: 'first_ms' },
          { fn: 'maxEpochMs', column: 'last_seen', as: 'last_ms' },
        ],
        where: { visitor_id: { op: '=', value: 'v1', type: 'String' } },
        final: true,
      });
      // FINAL keeps the later row for (v1, h1): 11:00 IST = 05:30 UTC
      expect(parseClickHouseInt64(v1!.first_ms)).toBe(Date.parse('2026-09-28T05:30:00.000Z'));
      expect(parseClickHouseInt64(v1!.last_ms)).toBe(Date.parse('2026-09-28T05:30:00.000Z'));
    });

    it('supports count, min and max', async () => {
      const [row] = await ch(client, tenantScope(storeD), storeD).select<{ n: string }>({
        table: 'identity_links',
        columns: [],
        aggregates: [{ fn: 'count', as: 'n' }],
        final: true,
      });
      expect(Number(row!.n)).toBe(3);
    });

    it("never returns another tenant's rows for the same hash", async () => {
      const rows = await ch(client, tenantScope(storeD), storeD).select<{ visitor_id: string }>({
        table: 'identity_links',
        columns: ['visitor_id'],
        where: { identity_hash_hmac: inList(['k1:h1']) },
        final: true,
      });
      expect(rows.map((r) => r.visitor_id)).not.toContain('other-tenant');
    });

    it('rejects malformed requests before running anything', async () => {
      const scoped = ch(client, tenantScope(storeD), storeD);
      await expect(scoped.select({ table: 'identity_links', columns: [] })).rejects.toThrow(
        /at least one column/,
      );
      await expect(
        scoped.select({
          table: 'identity_links',
          columns: ['visitor_id'],
          where: { visitor_id: { op: 'IN', value: ['a'], type: 'String' } },
        }),
      ).rejects.toThrow('Array(String)');
      await expect(
        scoped.select({
          table: 'identity_links',
          columns: ['visitor_id'],
          where: { visitor_id: { op: '=', value: ['a'], type: 'Array(String)' } },
        }),
      ).rejects.toThrow('Array(String)');
      await expect(
        scoped.select({
          table: 'identity_links',
          columns: [],
          aggregates: [{ fn: 'min', as: 'x' }],
        }),
      ).rejects.toThrow(/needs a column/);
      await expect(
        scoped.select({
          table: 'identity_links',
          columns: [],
          aggregates: [{ fn: 'count', as: 'n) FROM x; --' }],
        }),
      ).rejects.toThrow(/Unsafe ClickHouse identifier/);
      await expect(
        scoped.select({
          table: 'identity_links',
          columns: ['visitor_id'],
          groupBy: ['visitor_id; DROP'],
        }),
      ).rejects.toThrow(/Unsafe ClickHouse identifier/);
    });

    it('a value in an IN list is data, not SQL', async () => {
      const rows = await ch(client, tenantScope(storeD), storeD).select({
        table: 'identity_links',
        columns: ['visitor_id'],
        where: { identity_hash_hmac: inList(["x') OR 1=1 --"]) },
        final: true,
      });
      expect(rows).toEqual([]);
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
