import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { ch, type ClickHouseClient } from '@truepath/clickhouse';
import {
  createCapiDispatchLogRepository,
  createConsentRecordRepository,
  createDsrRequestRepository,
  createOrderRepository,
  createSuppressedIdentityRepository,
  type Db,
  type OrderRow,
} from '@truepath/db';
import { storeContext, type IdentityHasher } from '@truepath/privacy';
import {
  ATTRIBUTION_RUN_JOB_OPTIONS,
  EVENT_WORKERS_GROUP,
  STREAM_EVENTS_DEAD,
  STREAM_EVENTS_RAW,
  STREAM_FIELD_STORE_ID,
  SUPPRESSION_TTL_DAYS,
  attributionRunJobId,
  checkoutKey,
  sessionKey,
  storeBoundScope,
  type AttributionRunJob,
} from '@truepath/shared';
import { queueSuppressionMirror, type SuppressionMirrorOp } from '../eventSuppression.js';
import { parseStreamEntry, toRawEntry } from '../streamEntries.js';
import { resolveErasureScope } from './resolveErasureScope.js';

// privacy-dpdp.md §4.4 (webhook erasure + §4.4 step 9 follow-up) and §4.5 (withdrawal-triggered
// erasure). Three distinct scopes share the same delete primitives:
//   - webhook: the full one-hop H/V/O expansion, full anonymisation (§4.4).
//   - follow-up: `job.visitorIds` only (no re-expansion — the identity is already suppressed),
//     same full anonymisation, scoped to those visitors' orders (§4.4 step 9).
//   - withdrawal: `job.visitorIds` only, but the NARROW §4.5 scope — order rows and their phone/email
//     hashes are kept, only `visitor_id` is unlinked, and the affected orders are re-attributed.
// `runErasure` (worker.ts) picks between them using `request.resultSummary.trigger`: only a
// `consent_withdrawn`-triggered request ever takes the narrow path — a `suppression_hit` follow-up's
// `requestId` always points at a full `erased`-reason request, never a `withdrawn`-reason one (HLD §8
// "Suppression set": `erased` and `withdrawn` are separate identifier-type/reason rows).

/** A `<queue>-failed` DLQ, typed loosely so a real BullMQ `Queue` satisfies it structurally. */
export interface DlqJobRef {
  readonly data: unknown;
  remove(): Promise<void>;
}
export interface DlqQueueRef {
  getJobs(types: Array<'waiting' | 'delayed'>): Promise<DlqJobRef[]>;
}

export interface ErasureDeps {
  readonly db: Db;
  readonly clickhouse: ClickHouseClient;
  readonly redis: Pick<Redis, 'del' | 'pipeline' | 'xpending' | 'xrange' | 'xdel'>;
  readonly hasher: IdentityHasher;
  readonly attributionQueue: Pick<Queue<AttributionRunJob>, 'add'>;
  readonly now: () => Date;
  /**
   * issue #93: the `<queue>-failed` DLQs to scan for a job whose payload references an erased
   * order/visitor (privacy-dpdp.md §4.4 step 5 / §4.5 step 3). Omit (or pass `[]`) to skip the
   * scan — every call site still works without it, since suppression is re-checked at every
   * consumption point regardless (a stray DLQ entry for an already-suppressed visitor is a no-op
   * on its own). Production wiring passes the live set (index.ts); most tests don't need to.
   */
  readonly dlqQueues?: readonly DlqQueueRef[];
  /** Test-only override of the real stream/group names (mirrors EventConsumerOptions). */
  readonly streamNames?: {
    readonly eventsRaw: string;
    readonly eventsDead: string;
    readonly group: string;
  };
}

export interface ErasureCounts {
  readonly visitorsScoped: number;
  readonly ordersAffected: number;
  readonly guardRejectedHashes: number;
}

function visitorScopedWhere(visitorIds: readonly string[]) {
  return {
    visitor_id: { op: 'IN' as const, value: [...visitorIds], type: 'Array(String)' as const },
  };
}

function orderScopedWhere(orderIds: readonly string[]) {
  return { order_id: { op: 'IN' as const, value: [...orderIds], type: 'Array(String)' as const } };
}

async function deleteVisitorScopedRows(
  deps: ErasureDeps,
  storeId: string,
  visitorIds: readonly string[],
): Promise<void> {
  if (visitorIds.length === 0) return;
  const scoped = ch(deps.clickhouse, storeBoundScope(storeId), storeId);
  const where = visitorScopedWhere(visitorIds);
  await scoped.delete({ table: 'events', where });
  await scoped.delete({ table: 'touchpoints', where });
  await scoped.delete({ table: 'identity_links', where });
}

async function deleteOrderScopedRows(
  deps: ErasureDeps,
  storeId: string,
  orderIds: readonly string[],
  options: { readonly includeOrderStatus: boolean },
): Promise<void> {
  if (orderIds.length === 0) return;
  const scoped = ch(deps.clickhouse, storeBoundScope(storeId), storeId);
  const where = orderScopedWhere(orderIds);
  await scoped.delete({ table: 'attribution_results', where });
  if (options.includeOrderStatus) await scoped.delete({ table: 'order_status', where });
}

/** privacy-dpdp.md §4.4 step 7: re-count every target and require 0 (ADR-0015 — visible immediately). */
async function verifyVisitorRowsGone(
  deps: ErasureDeps,
  storeId: string,
  visitorIds: readonly string[],
): Promise<void> {
  if (visitorIds.length === 0) return;
  const scoped = ch(deps.clickhouse, storeBoundScope(storeId), storeId);
  const where = visitorScopedWhere(visitorIds);
  for (const table of ['events', 'touchpoints', 'identity_links'] as const) {
    const [row] = await scoped.select<{ n: string }>({
      table,
      columns: [],
      aggregates: [{ fn: 'count', as: 'n' }],
      where,
    });
    if (Number(row?.n ?? 0) > 0) {
      throw new Error(
        `DSR erasure verification failed: ${table} still has rows for store ${storeId}`,
      );
    }
  }
}

const STREAM_PENDING_SCAN_LIMIT = 1000;
const DEAD_STREAM_SCAN_PAGE = 1000;

/**
 * privacy-dpdp.md §4.4 step 5: `stream:events-raw`'s pending (not-yet-`XACK`ed) entries — the only
 * ones that could still reach ClickHouse — and every entry on the capped `stream:events-dead`.
 * Best-effort cleanliness, not correctness: `event-workers` re-checks suppression before writing
 * anything, so a stray in-flight entry for an already-suppressed visitor is a no-op either way.
 */
async function purgeStreamEntries(
  deps: ErasureDeps,
  storeId: string,
  visitorIds: ReadonlySet<string>,
): Promise<void> {
  if (visitorIds.size === 0) return;
  const eventsRaw = deps.streamNames?.eventsRaw ?? STREAM_EVENTS_RAW;
  const eventsDead = deps.streamNames?.eventsDead ?? STREAM_EVENTS_DEAD;
  const group = deps.streamNames?.group ?? EVENT_WORKERS_GROUP;

  // NOGROUP means event-workers has never run against this stream yet — nothing is pending.
  let pending: [string, string, number, number][] | null = null;
  try {
    pending = (await deps.redis.xpending(eventsRaw, group, '-', '+', STREAM_PENDING_SCAN_LIMIT)) as
      [string, string, number, number][] | null;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('NOGROUP')) throw error;
  }
  const toDeleteRaw: string[] = [];
  for (const [id] of pending ?? []) {
    const rows = await deps.redis.xrange(eventsRaw, id, id);
    const row = rows[0];
    if (!row) continue;
    const raw = toRawEntry(row[0], row[1]);
    if (raw.fields[STREAM_FIELD_STORE_ID] !== storeId) continue;
    const parsed = parseStreamEntry(raw);
    if (parsed && visitorIds.has(parsed.entry.visitor_id)) toDeleteRaw.push(id);
  }
  if (toDeleteRaw.length > 0) await deps.redis.xdel(eventsRaw, ...toDeleteRaw);

  let cursor = '-';
  const toDeleteDead: string[] = [];
  for (;;) {
    const rows = await deps.redis.xrange(eventsDead, cursor, '+', 'COUNT', DEAD_STREAM_SCAN_PAGE);
    if (rows.length === 0) break;
    for (const [id, flat] of rows) {
      const raw = toRawEntry(id, flat);
      if (raw.fields[STREAM_FIELD_STORE_ID] !== storeId) continue;
      const parsed = parseStreamEntry(raw);
      if (parsed && visitorIds.has(parsed.entry.visitor_id)) toDeleteDead.push(id);
    }
    if (rows.length < DEAD_STREAM_SCAN_PAGE) break;
    cursor = `(${rows[rows.length - 1]![0]}`; // exclusive — resume just past the last id read
  }
  if (toDeleteDead.length > 0) await deps.redis.xdel(eventsDead, ...toDeleteDead);
}

/**
 * privacy-dpdp.md §4.4 step 5: every `<queue>-failed` DLQ, for a job whose payload has an
 * `orderId ∈ O` or `visitorIds` intersecting `V`. Only the payload is inspected — never the
 * job's error message (HLD §8 "Error handling & retries": that can carry SQL parameters).
 */
async function purgeDlqJobs(
  deps: ErasureDeps,
  visitorIds: ReadonlySet<string>,
  orderIds: ReadonlySet<string>,
): Promise<void> {
  if (visitorIds.size === 0 && orderIds.size === 0) return;
  for (const queue of deps.dlqQueues ?? []) {
    const jobs = await queue.getJobs(['waiting', 'delayed']);
    for (const job of jobs) {
      const data = job.data as { orderId?: string; visitorIds?: readonly string[] } | undefined;
      const matchesOrder = data?.orderId !== undefined && orderIds.has(data.orderId);
      const matchesVisitor = data?.visitorIds?.some((v) => visitorIds.has(v)) ?? false;
      if (matchesOrder || matchesVisitor) await job.remove();
    }
  }
}

async function redisCleanup(
  deps: ErasureDeps,
  storeId: string,
  visitorIds: readonly string[],
  orders: readonly OrderRow[],
): Promise<void> {
  const scope = storeBoundScope(storeId);
  const keys = [
    ...visitorIds.map((v) => sessionKey(scope, storeId, v)),
    ...orders.map((o) => checkoutKey(scope, storeId, o.externalOrderId)),
  ];
  if (keys.length > 0) await deps.redis.del(...keys);

  const visitorIdSet = new Set(visitorIds);
  await purgeStreamEntries(deps, storeId, visitorIdSet);
  await purgeDlqJobs(deps, visitorIdSet, new Set(orders.map((o) => o.id)));
}

function visitorHmacs(deps: ErasureDeps, storeId: string, visitorIds: readonly string[]): string[] {
  const hctx = storeContext(storeId);
  return visitorIds.map((v) => deps.hasher.hmac(hctx, v));
}

/**
 * privacy-dpdp.md §4.3 steps 1–2 / §4.4 steps 2–8: the full webhook-triggered erasure. Resolves H/V/O
 * from the request's own `identity_hash`, suppresses first, then anonymises orders (phone/email/
 * visitor_id/discount_codes/note_attributes/landing+referring site) and deletes every ClickHouse row
 * keyed by V or O.
 */
export async function runWebhookErasure(
  deps: ErasureDeps,
  storeId: string,
  requestId: string,
  identityHash: string,
): Promise<ErasureCounts> {
  const scope = storeBoundScope(storeId);
  const { hashes, visitorIds, orderIds, guardRejectedHashes } = await resolveErasureScope(
    deps,
    storeId,
    identityHash,
  );

  // Suppress first (PG then Redis), before any delete: a job that dies partway still leaves the
  // identity suppressed (HLD §8 "Suppression set"; privacy-dpdp.md §4.4 step 2).
  const suppression = createSuppressedIdentityRepository(deps.db);
  const expiresAt = new Date(deps.now().getTime() + SUPPRESSION_TTL_DAYS * 86_400_000);
  const expiresAtSeconds = Math.floor(expiresAt.getTime() / 1000);
  const mirror: SuppressionMirrorOp[] = [];
  for (const hash of hashes) {
    await suppression.add(scope, storeId, {
      identifierType: 'identity_hash_hmac',
      identifier: hash,
      reason: 'erased',
      dsrRequestId: requestId,
      expiresAt,
    });
    mirror.push({ op: 'add', storeId, kind: 'erased:identity', member: hash, expiresAtSeconds });
  }
  for (const hmac of visitorHmacs(deps, storeId, visitorIds)) {
    await suppression.add(scope, storeId, {
      identifierType: 'visitor_id',
      identifier: hmac,
      reason: 'erased',
      dsrRequestId: requestId,
      expiresAt,
    });
    mirror.push({ op: 'add', storeId, kind: 'erased:visitor', member: hmac, expiresAtSeconds });
  }
  const pipeline = deps.redis.pipeline();
  queueSuppressionMirror(pipeline, mirror);
  for (const [error] of (await pipeline.exec()) ?? []) if (error) throw error;

  const orders = createOrderRepository(deps.db);
  const orderRows =
    orderIds.length > 0 ? await orders.findByVisitorIds(scope, storeId, visitorIds) : [];
  const byHash = await orders.findByIdentityHashes(scope, storeId, hashes);
  const ordersById = new Map([...orderRows, ...byHash].map((o) => [o.id, o]));

  await deleteVisitorScopedRows(deps, storeId, visitorIds);
  await deleteOrderScopedRows(deps, storeId, orderIds, { includeOrderStatus: true });
  await orders.anonymiseErasedOrders(scope, storeId, orderIds);
  await createCapiDispatchLogRepository(deps.db).redactLastErrorForOrders(scope, storeId, orderIds);
  await createConsentRecordRepository(deps.db).deleteByVisitorHmacs(
    scope,
    storeId,
    visitorHmacs(deps, storeId, visitorIds),
  );
  await redisCleanup(deps, storeId, visitorIds, [...ordersById.values()]);
  await verifyVisitorRowsGone(deps, storeId, visitorIds);

  return {
    visitorsScoped: visitorIds.length,
    ordersAffected: orderIds.length,
    guardRejectedHashes: guardRejectedHashes.length,
  };
}

/**
 * privacy-dpdp.md §4.4 step 9: the follow-up purge after a `suppression_hit` — steps 3–7 only, scoped
 * to the given (already-suppressed) visitors, no re-expansion.
 */
export async function runFollowupErasure(
  deps: ErasureDeps,
  storeId: string,
  requestId: string,
  visitorIds: readonly string[],
  followupKey: string,
): Promise<ErasureCounts> {
  const scope = storeBoundScope(storeId);
  const orders = createOrderRepository(deps.db);
  const orderRows = await orders.findByVisitorIds(scope, storeId, visitorIds);
  const orderIds = orderRows.map((o) => o.id);

  await deleteVisitorScopedRows(deps, storeId, visitorIds);
  await deleteOrderScopedRows(deps, storeId, orderIds, { includeOrderStatus: true });
  await orders.anonymiseErasedOrders(scope, storeId, orderIds);
  await createCapiDispatchLogRepository(deps.db).redactLastErrorForOrders(scope, storeId, orderIds);
  const hmacs = visitorHmacs(deps, storeId, visitorIds);
  await createConsentRecordRepository(deps.db).deleteByVisitorHmacs(scope, storeId, hmacs);
  await redisCleanup(deps, storeId, visitorIds, orderRows);
  await verifyVisitorRowsGone(deps, storeId, visitorIds);

  await createDsrRequestRepository(deps.db).appendFollowup(scope, storeId, requestId, {
    followupKey,
    visitorCount: visitorIds.length,
    rowsDeleted: orderIds.length,
    at: deps.now(),
  });

  return {
    visitorsScoped: visitorIds.length,
    ordersAffected: orderIds.length,
    guardRejectedHashes: 0,
  };
}

/**
 * privacy-dpdp.md §4.5 steps 3–4: the narrow, single-visitor scope a consent withdrawal gets. Order
 * rows and their phone/email hashes are kept — only `orders.visitor_id` is unlinked — and the affected
 * orders are re-attributed (they fall back to UTM or Unattributed without their touchpoints).
 */
export async function runWithdrawalErasure(
  deps: ErasureDeps,
  storeId: string,
  visitorIds: readonly string[],
): Promise<ErasureCounts> {
  const scope = storeBoundScope(storeId);
  const orders = createOrderRepository(deps.db);
  const orderRows = await orders.findByVisitorIds(scope, storeId, visitorIds);
  const orderIds = orderRows.map((o) => o.id);

  await deleteVisitorScopedRows(deps, storeId, visitorIds);
  // Not order_status (§4.5 step 3): the order itself isn't erased, so its delivery-status projection
  // stays — only its attribution credit, which depended on the now-deleted touchpoints.
  await deleteOrderScopedRows(deps, storeId, orderIds, { includeOrderStatus: false });
  await orders.unlinkVisitor(scope, storeId, orderIds);
  const hmacs = visitorHmacs(deps, storeId, visitorIds);
  await createConsentRecordRepository(deps.db).deleteByVisitorHmacs(scope, storeId, hmacs);
  await redisCleanup(deps, storeId, visitorIds, orderRows);
  await verifyVisitorRowsGone(deps, storeId, visitorIds);

  for (const orderId of orderIds) {
    await deps.attributionQueue.add(
      'incremental',
      { storeId, mode: 'incremental', orderIds: [orderId] },
      { jobId: attributionRunJobId(orderId), ...ATTRIBUTION_RUN_JOB_OPTIONS },
    );
  }

  return {
    visitorsScoped: visitorIds.length,
    ordersAffected: orderIds.length,
    guardRejectedHashes: 0,
  };
}
