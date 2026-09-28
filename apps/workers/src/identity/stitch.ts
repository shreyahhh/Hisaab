import { DelayedError, type Job, type Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { ch } from '@truepath/clickhouse';
import { createOrderRepository, createStoreRepository } from '@truepath/db';
import { isIdentityErased } from '@truepath/privacy';
import {
  ATTRIBUTION_RUN_JOB_OPTIONS,
  IDENTITY_STITCH_DELAY_MS,
  IDENTITY_STITCH_JOB_OPTIONS,
  IdentityStitchJobSchema,
  attributionRunJobId,
  checkoutKey,
  identityStitchJobId,
  storeBoundScope,
  type AttributionRunJob,
  type IdentityStitchJob,
} from '@truepath/shared';
import { isSuppressionReady, SuppressionNotReadyError } from '../eventSuppression.js';
import { findLinkedVisitors, isVisitorSuppressed, type IdentityDeps } from './journey.js';

// `stitchOrder` (identity-stitching.md §4.2): finds the visitor(s) whose journey an order belongs to and
// hands the order to attribution. Rule order (SPEC §7.3): (2) the order's own visitor — from the pixel's
// `checkout_completed` via `orders.visitor_id`, or the `checkout:` key — then (3) the phone/email HMAC
// fallback, then re-tries at +5 and +30 min, then (4) the UTM fallback with `attribution_confidence='low'`.
// Suppression is checked when the job RUNS, not when it was enqueued: a delayed attempt for a shopper
// erased in the meantime does nothing (HLD §8).

export type StitchOutcome =
  | { kind: 'matched'; via: 'order_id' | 'checkout_key' | 'identity_hash' }
  | { kind: 'retry'; nextAttempt: 1 | 2; delayMs: number }
  | { kind: 'utm_fallback' }
  | { kind: 'skipped'; reason: 'suppressed' | 'anonymised' | 'order_missing' };

export interface StitchDeps extends IdentityDeps {
  readonly redis: Pick<Redis, 'zscore' | 'get' | 'exists'>;
  readonly stitchQueue: Pick<Queue<IdentityStitchJob>, 'add'>;
  readonly attributionQueue: Pick<Queue<AttributionRunJob>, 'add'>;
  /** The suppression readiness marker; only tests override the default. */
  readonly readyKey?: string;
}

export interface StitchResult {
  readonly outcome: StitchOutcome;
  /** A hash was ignored as a shared/dummy identifier this run (metric `identity_guard_rejected_total`). */
  readonly guardRejected: boolean;
}

async function enqueueAttribution(
  deps: StitchDeps,
  storeId: string,
  orderId: string,
): Promise<void> {
  await deps.attributionQueue.add(
    'incremental',
    { storeId, mode: 'incremental', orderIds: [orderId] },
    { jobId: attributionRunJobId(orderId), ...ATTRIBUTION_RUN_JOB_OPTIONS },
  );
}

export async function stitchOrder(deps: StitchDeps, job: IdentityStitchJob): Promise<StitchResult> {
  // Without the suppression sets we can't tell who was erased: do nothing (fail closed, HLD §8).
  if (!(await isSuppressionReady(deps.redis, deps.readyKey))) throw new SuppressionNotReadyError();

  const { storeId, orderId } = job;
  const scope = storeBoundScope(storeId);
  const orders = createOrderRepository(deps.db);
  const done = (outcome: StitchOutcome, guardRejected = false): StitchResult => ({
    outcome,
    guardRejected,
  });

  // 1. The order, and the store's child-directed flag.
  const order = await orders.getById(scope, storeId, orderId);
  const store = await createStoreRepository(deps.db).getById(scope, storeId);
  if (!order || !store) return done({ kind: 'skipped', reason: 'order_missing' });

  // 2. Suppression gate.
  const hashes = [order.phoneHashHmac, order.emailHashHmac].filter((h): h is string => h !== null);
  if (hashes.length === 0) {
    // Anonymised (or its identity was suppressed at webhook time): still attributed, as Unattributed.
    await enqueueAttribution(deps, storeId, orderId);
    return done({ kind: 'skipped', reason: 'anonymised' });
  }
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  if (await isIdentityErased(deps.redis, storeId, hashes, nowSeconds)) {
    return done({ kind: 'skipped', reason: 'suppressed' }); // no attribution, no CAPI
  }

  // 3. Rule 2 — the order's own visitor.
  let primary: { visitorId: string; via: 'order_id' | 'checkout_key' } | null = null;
  if (order.visitorId !== null) {
    if (!(await isVisitorSuppressed(deps, storeId, order.visitorId))) {
      primary = { visitorId: order.visitorId, via: 'order_id' };
    }
  } else {
    const fromCheckout = await deps.redis.get(checkoutKey(scope, storeId, order.externalOrderId));
    if (fromCheckout !== null && !(await isVisitorSuppressed(deps, storeId, fromCheckout))) {
      await orders.linkVisitorIfUnset(scope, storeId, orderId, fromCheckout);
      primary = { visitorId: fromCheckout, via: 'checkout_key' };
    }
  }
  if (primary) {
    await orders.setAttributionConfidence(scope, storeId, orderId, 'high');
    await enqueueAttribution(deps, storeId, orderId);
    return done({ kind: 'matched', via: primary.via });
  }

  // 4. Rule 3 — the phone/email HMAC fallback (not for child-directed stores, pending legal: LLD Q1).
  let guardRejected = false;
  if (!store.childDirected) {
    const linked = await findLinkedVisitors(deps, order);
    guardRejected = linked.guardRejected;
    if (linked.visitors.length > 0) {
      // Link the order's *other* hash to those visitors too, so a later lookup by either finds them.
      const rows = linked.visitors.flatMap((v) =>
        hashes
          .filter((h) => !v.linkedHashes.has(h))
          .map((h) => ({
            store_id: storeId,
            visitor_id: v.visitorId,
            identity_hash_hmac: h,
            first_seen: order.createdAtPlatform.toISOString(),
            last_seen: order.createdAtPlatform.toISOString(),
          })),
      );
      await ch(deps.clickhouse, scope, storeId).insert('identity_links', rows);
      await orders.setAttributionConfidence(scope, storeId, orderId, 'high');
      await enqueueAttribution(deps, storeId, orderId);
      return done({ kind: 'matched', via: 'identity_hash' }, guardRejected);
    }
  }

  // 5. No match: try again later, or fall back to UTMs.
  if (job.attempt < 2) {
    const nextAttempt = (job.attempt + 1) as 1 | 2;
    const delayMs = IDENTITY_STITCH_DELAY_MS[nextAttempt];
    await deps.stitchQueue.add(
      'stitch',
      { storeId, orderId, attempt: nextAttempt },
      {
        jobId: identityStitchJobId(orderId, nextAttempt),
        delay: delayMs,
        ...IDENTITY_STITCH_JOB_OPTIONS,
      },
    );
    return done({ kind: 'retry', nextAttempt, delayMs }, guardRejected);
  }
  // Never downgrade: a backfill re-enqueues attempt 2 for orders that may already have matched.
  if (order.attributionConfidence !== 'high') {
    await orders.setAttributionConfidence(scope, storeId, orderId, 'low');
  }
  await enqueueAttribution(deps, storeId, orderId);
  return done({ kind: 'utm_fallback' }, guardRejected);
}

/**
 * The BullMQ processor. It returns only the outcome *kind*: job results are stored in Redis, and a
 * visitor id or hash must not be. While suppression is unavailable a job is put back on the delayed set
 * rather than failed (failing would burn its 5 attempts in a minute; the rebuild can take longer).
 */
export function createIdentityStitchProcessor(
  deps: StitchDeps,
  log: (line: Record<string, unknown>) => void,
) {
  return async function processIdentityStitchJob(
    job: Job<IdentityStitchJob>,
    token?: string,
  ): Promise<{ kind: StitchOutcome['kind'] }> {
    const data = IdentityStitchJobSchema.parse(job.data);
    try {
      const { outcome, guardRejected } = await stitchOrder(deps, data);
      log({
        event: 'identity_stitch',
        attempt: data.attempt,
        outcome: outcome.kind,
        via: 'via' in outcome ? outcome.via : undefined,
        reason: 'reason' in outcome ? outcome.reason : undefined,
        identity_guard_rejected: guardRejected || undefined,
      });
      return { kind: outcome.kind };
    } catch (error) {
      if (error instanceof SuppressionNotReadyError && token !== undefined) {
        log({ event: 'identity_stitch_paused', reason: 'suppression_not_ready' });
        await job.moveToDelayed(Date.now() + 30_000, token);
        throw new DelayedError();
      }
      throw error;
    }
  };
}
