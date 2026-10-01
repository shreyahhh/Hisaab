import { ch, CLICKHOUSE_TABLES, type ClickHouseClient } from '@truepath/clickhouse';
import {
  createAuditLogRepository,
  createDsrRequestRepository,
  createDsrStoreErasureRepository,
  createIntegrationRepository,
  createStoreRepository,
  deleteCollectorConfig,
  jobScope,
  type Db,
  type DsrRequestRow,
} from '@truepath/db';
import { storeBoundScope } from '@truepath/shared';
import type { Redis } from 'ioredis';

// privacy-dpdp.md §4.7: `shop/redact` offboarding. Runs once, 7 days after the webhook (the enqueue
// delay keeps the export window open). Every ClickHouse/Postgres row the store ever owned is deleted;
// `stores`, `audit_log` and `dsr_requests` are kept as the tombstone + record — none of them hold
// shopper data.

export interface StoreErasureDeps {
  readonly db: Db;
  readonly clickhouse: ClickHouseClient;
  readonly redis: Pick<Redis, 'scan' | 'del'>;
  readonly now: () => Date;
}

export interface StoreErasureResult {
  readonly ordersDeleted: number;
  readonly redisKeysDeleted: number;
}

/** SCAN (never KEYS — this runs against the live durable Redis) every key under a store-prefixed pattern. */
async function scanDelete(redis: StoreErasureDeps['redis'], pattern: string): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) {
      await redis.del(...keys);
      deleted += keys.length;
    }
  } while (cursor !== '0');
  return deleted;
}

async function verifyClickHouseEmpty(deps: StoreErasureDeps, storeId: string): Promise<void> {
  const scoped = ch(deps.clickhouse, storeBoundScope(storeId), storeId);
  for (const table of CLICKHOUSE_TABLES) {
    const [row] = await scoped.select<{ n: string }>({
      table,
      columns: [],
      aggregates: [{ fn: 'count', as: 'n' }],
    });
    if (Number(row?.n ?? 0) > 0) {
      throw new Error(
        `store_erasure verification failed: ${table} still has rows for store ${storeId}`,
      );
    }
  }
}

/**
 * privacy-dpdp.md §4.7 step 3-4: the full store_erasure job body. `request` is the already-loaded,
 * `in_progress` `dsr_requests(type='store_erasure')` row.
 */
export async function runStoreErasure(
  deps: StoreErasureDeps,
  storeId: string,
  request: DsrRequestRow,
): Promise<StoreErasureResult> {
  const store = await createStoreRepository(deps.db).getById(storeBoundScope(storeId), storeId);
  if (!store) throw new Error(`store_erasure: store ${storeId} not found`);
  const scope = jobScope(store.organizationId, storeId);

  // The collector config is keyed by store_key (from integrations.settings), not store_id, so it
  // can't be found by a store-prefixed SCAN — delete it from every integration row before Postgres's
  // own delete removes them.
  const integrationsRepo = createIntegrationRepository(deps.db);
  for (const integration of await integrationsRepo.listByStore(scope, storeId)) {
    await deleteCollectorConfig(deps.redis, integration.settings);
  }

  // ClickHouse: every table, store-wide (ADR-0015's lightweight delete — no `where` beyond store_id,
  // which ch().delete() always injects itself).
  const scoped = ch(deps.clickhouse, storeBoundScope(storeId), storeId);
  for (const table of CLICKHOUSE_TABLES) await scoped.delete({ table });

  // Postgres: everything the store owns except the stores/audit_log/dsr_requests tombstone.
  const erased = await createDsrStoreErasureRepository(deps.db).eraseStore(scope, storeId);

  // Redis: every store-prefixed key, plus the collector config already handled above.
  let redisKeysDeleted = 0;
  for (const pattern of [
    `suppress:${storeId}:*`,
    `session:${storeId}:*`,
    `checkout:${storeId}:*`,
    `stats:collector:${storeId}:*`,
    `dedupe:${storeId}:*`,
  ]) {
    redisKeysDeleted += await scanDelete(deps.redis, pattern);
  }

  await verifyClickHouseEmpty(deps, storeId);

  await createStoreRepository(deps.db).markDeleted(scope, storeId);

  const dsrRequests = createDsrRequestRepository(deps.db);
  await dsrRequests.complete(scope, storeId, request.id, {
    resultSummaryPatch: {
      orders_deleted: erased.orders,
      consent_records_deleted: erased.consentRecords,
      integrations_deleted: erased.integrations,
      redis_keys_deleted: redisKeysDeleted,
    },
    completedAt: deps.now(),
  });
  await createAuditLogRepository(deps.db).write(scope, {
    organizationId: store.organizationId,
    actorUserId: null,
    actorType: 'system',
    action: 'dsr_completed',
    targetType: 'dsr_request',
    targetId: request.id,
    metadata: { type: 'store_erasure', trigger: 'shopify_webhook' },
  });

  return { ordersDeleted: erased.orders, redisKeysDeleted };
}
