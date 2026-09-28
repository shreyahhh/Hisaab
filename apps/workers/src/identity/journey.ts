import type { Redis } from 'ioredis';
import { ch, parseClickHouseInt64, type ClickHouseClient } from '@truepath/clickhouse';
import { createOrderRepository, createStoreRepository, type Db, type OrderRow } from '@truepath/db';
import { storeContext, visitorSuppression, type IdentityHasher } from '@truepath/privacy';
import { IDENTITY_GUARD, MAX_JOURNEY_VISITORS, storeBoundScope } from '@truepath/shared';

// Which visitors belong to an order's journey (identity-stitching.md §4.2 step 4, §4.3). Everything is
// per store: queries go through the scoped ClickHouse builder and the scoped repositories with a
// one-store scope (ADR-0016, ADR-0026), and HMAC keys are per tenant, so a phone shared by two stores'
// customers produces unrelated hashes and can never link across them (SPEC §7.3 rule 5).

export interface IdentityDeps {
  readonly db: Db;
  readonly redis: Pick<Redis, 'zscore'>;
  readonly clickhouse: ClickHouseClient;
  readonly hasher: IdentityHasher;
  readonly now: () => Date;
}

export interface LinkedVisitor {
  readonly visitorId: string;
  readonly firstSeenMs: number;
  readonly lastSeenMs: number;
  /** The order's hashes this visitor is already linked to. */
  readonly linkedHashes: ReadonlySet<string>;
}

export interface LinkedVisitors {
  /** Most recently seen first. */
  readonly visitors: readonly LinkedVisitor[];
  /** The hash the visitors were found through (phone first, else email), if any hash matched. */
  readonly via: string | null;
  /** A hash was ignored as a shared / dummy identifier (metric `identity_guard_rejected_total`). */
  readonly guardRejected: boolean;
}

const ROWS_PER_HASH_LIMIT = IDENTITY_GUARD.maxVisitorsPerHash + 1;

/** Is this visitor erased or withdrawn? Checked under every read key version. */
export async function isVisitorSuppressed(
  deps: Pick<IdentityDeps, 'redis' | 'hasher' | 'now'>,
  storeId: string,
  visitorId: string,
): Promise<boolean> {
  const hmacs = deps.hasher.hmacAll(storeContext(storeId), visitorId);
  const verdict = await visitorSuppression(
    deps.redis,
    storeId,
    hmacs,
    Math.floor(deps.now().getTime() / 1000),
  );
  return verdict !== null;
}

/**
 * Visitors linked to the order's phone (else email) HMAC by `identity_links`, after the shared-identifier
 * guard, the suppression filter and the "no activity that started after the order" filter.
 *
 * Phone first: the first of the two hashes that has any link (and passes the guard) is the only one used —
 * email is a fallback for a phone with no usable links, not a union (LLD Q3).
 */
export async function findLinkedVisitors(
  deps: IdentityDeps,
  order: OrderRow,
): Promise<LinkedVisitors> {
  const storeId = order.storeId;
  const scope = storeBoundScope(storeId);
  const scoped = ch(deps.clickhouse, scope, storeId);
  const orderHashes = [order.phoneHashHmac, order.emailHashHmac].filter(
    (h): h is string => h !== null,
  );
  const windowStart = new Date(deps.now().getTime() - IDENTITY_GUARD.ordersWindowDays * 86_400_000);
  let guardRejected = false;

  for (const hash of orderHashes) {
    const rows = await scoped.select<{
      visitor_id: string;
      first_ms: string;
      last_ms: string;
    }>({
      table: 'identity_links',
      columns: ['visitor_id'],
      aggregates: [
        { fn: 'minEpochMs', column: 'first_seen', as: 'first_ms' },
        { fn: 'maxEpochMs', column: 'last_seen', as: 'last_ms' },
      ],
      groupBy: ['visitor_id'],
      where: { identity_hash_hmac: { op: 'IN', value: [hash], type: 'Array(String)' } },
      final: true,
      orderBy: 'visitor_id',
      limit: ROWS_PER_HASH_LIMIT,
    });
    if (rows.length === 0) continue;

    // A hash on too many visitors or orders is a shared or dummy identifier (a store's own number, a
    // courier agent's phone): ignored, as if it had matched nothing.
    const tooManyVisitors = rows.length > IDENTITY_GUARD.maxVisitorsPerHash;
    const tooManyOrders =
      !tooManyVisitors &&
      (await createOrderRepository(deps.db).countOrdersByIdentityHash(
        scope,
        storeId,
        hash,
        windowStart,
      )) > IDENTITY_GUARD.maxOrdersPerHash;
    if (tooManyVisitors || tooManyOrders) {
      guardRejected = true;
      continue;
    }

    const visitors: LinkedVisitor[] = [];
    for (const row of rows) {
      const firstSeenMs = parseClickHouseInt64(row.first_ms);
      // A journey can't include activity that began after the order.
      if (firstSeenMs > order.createdAtPlatform.getTime()) continue;
      if (await isVisitorSuppressed(deps, storeId, row.visitor_id)) continue;
      visitors.push({
        visitorId: row.visitor_id,
        firstSeenMs,
        lastSeenMs: parseClickHouseInt64(row.last_ms),
        linkedHashes: new Set([hash]),
      });
    }
    visitors.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
    return { visitors, via: hash, guardRejected };
  }
  return { visitors: [], via: null, guardRejected };
}

export interface JourneyVisitors {
  /** Primary first. At most MAX_JOURNEY_VISITORS. */
  readonly visitorIds: readonly string[];
  readonly via: 'order_id' | 'identity_hash' | 'none';
}

/**
 * The visitor set attribution loads touchpoints for (identity-stitching.md §4.3): the order's own visitor
 * (from `order_id` / the `checkout:` key), plus — unless the store is child-directed — visitors linked
 * through the order's phone / email, capped at 10 (the primary plus the most recently seen).
 *
 * Runs at every attribution run, so a link found *after* the purchase (the same phone entered later on
 * another device) is picked up without re-stitching.
 */
export async function resolveJourneyVisitors(
  deps: IdentityDeps,
  order: OrderRow,
): Promise<JourneyVisitors> {
  const primary =
    order.visitorId !== null && !(await isVisitorSuppressed(deps, order.storeId, order.visitorId))
      ? order.visitorId
      : null;

  const store = await createStoreRepository(deps.db).getById(
    storeBoundScope(order.storeId),
    order.storeId,
  );
  const fallback =
    store && !store.childDirected ? (await findLinkedVisitors(deps, order)).visitors : [];

  const others = fallback.map((v) => v.visitorId).filter((id) => id !== primary);
  const visitorIds = [...(primary ? [primary] : []), ...others].slice(0, MAX_JOURNEY_VISITORS);
  return {
    visitorIds,
    via: primary ? 'order_id' : others.length > 0 ? 'identity_hash' : 'none',
  };
}
