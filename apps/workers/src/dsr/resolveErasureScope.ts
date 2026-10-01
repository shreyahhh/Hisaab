import { ch, type ClickHouseClient } from '@truepath/clickhouse';
import { createOrderRepository, type Db } from '@truepath/db';
import { IDENTITY_GUARD, storeBoundScope } from '@truepath/shared';

// privacy-dpdp.md §4.3 steps 1–2 / §4.4 step 1: the one-hop identity expansion a webhook-triggered
// erasure resolves before anything is suppressed or deleted — hashes H, visitors V, orders O. The
// per-hash shared/dummy-identifier guard (issue #25 decision 3) mirrors identity/journey.ts's
// `findLinkedVisitors`, but this isn't journey-building: there's no "activity after the order"
// filter, because there's no single order driving the expansion.

export interface ErasureScopeDeps {
  readonly db: Db;
  readonly clickhouse: ClickHouseClient;
  readonly now: () => Date;
}

export interface ErasureScope {
  readonly hashes: readonly string[];
  readonly visitorIds: readonly string[];
  readonly orderIds: readonly string[];
  /** A hash ignored as a shared/dummy identifier (metric `identity_guard_rejected_total`). */
  readonly guardRejectedHashes: readonly string[];
}

const ROWS_PER_HASH_LIMIT = IDENTITY_GUARD.maxVisitorsPerHash + 1;

export async function resolveErasureScope(
  deps: ErasureScopeDeps,
  storeId: string,
  initialHash: string,
): Promise<ErasureScope> {
  const scope = storeBoundScope(storeId);
  const orders = createOrderRepository(deps.db);
  const scoped = ch(deps.clickhouse, scope, storeId);

  const ordersByHash = await orders.findByIdentityHashes(scope, storeId, [initialHash]);
  const hashes = new Set<string>([initialHash]);
  const visitorIds = new Set<string>();
  for (const o of ordersByHash) {
    if (o.phoneHashHmac) hashes.add(o.phoneHashHmac);
    if (o.emailHashHmac) hashes.add(o.emailHashHmac);
    if (o.visitorId) visitorIds.add(o.visitorId);
  }

  const windowStart = new Date(deps.now().getTime() - IDENTITY_GUARD.ordersWindowDays * 86_400_000);
  const guardRejectedHashes: string[] = [];

  for (const hash of hashes) {
    const rows = await scoped.select<{ visitor_id: string }>({
      table: 'identity_links',
      columns: ['visitor_id'],
      groupBy: ['visitor_id'],
      where: { identity_hash_hmac: { op: '=', value: hash, type: 'String' } },
      final: true,
      orderBy: 'visitor_id',
      limit: ROWS_PER_HASH_LIMIT,
    });
    if (rows.length === 0) continue;

    // A hash on too many visitors or orders is a shared or dummy identifier (a store's own number, a
    // courier agent's phone): ignored, as if it had matched nothing — the same guard identity-stitching
    // applies when building a journey, applied here so a DSR can't cascade-delete uninvolved shoppers.
    const tooManyVisitors = rows.length > IDENTITY_GUARD.maxVisitorsPerHash;
    const tooManyOrders =
      !tooManyVisitors &&
      (await orders.countOrdersByIdentityHash(scope, storeId, hash, windowStart)) >
        IDENTITY_GUARD.maxOrdersPerHash;
    if (tooManyVisitors || tooManyOrders) {
      guardRejectedHashes.push(hash);
      continue;
    }
    for (const row of rows) visitorIds.add(row.visitor_id);
  }

  const ordersByVisitor =
    visitorIds.size > 0 ? await orders.findByVisitorIds(scope, storeId, [...visitorIds]) : [];
  const orderIds = new Set<string>([...ordersByHash, ...ordersByVisitor].map((o) => o.id));

  return {
    hashes: [...hashes],
    visitorIds: [...visitorIds],
    orderIds: [...orderIds],
    guardRejectedHashes,
  };
}
