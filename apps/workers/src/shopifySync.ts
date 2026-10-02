import type { Job, Queue } from 'bullmq';
import {
  createIntegrationRepository,
  createOrderRepository,
  createStoreRepository,
  createSystemScope,
  type Db,
  type IntegrationRow,
} from '@truepath/db';
import {
  mapOrderSnapshot,
  ShopifyUnauthorizedError,
  type ShopifyAdapter,
  type ShopifyCredentials,
  type ShopifyOrderSnapshot,
} from '@truepath/integrations';
import {
  isIdentityErased,
  type CredentialsCipher,
  type IdentityHasher,
  type SuppressionReader,
} from '@truepath/privacy';
import {
  IDENTITY_STITCH_JOB_OPTIONS,
  identityStitchJobId,
  type IdentityStitchJob,
  type Scope,
  type ShopifySyncJob,
} from '@truepath/shared';

// The `shopify-sync` queue's processor (HLD §8; shopify-integration.md §4.7). Implements
// `mode: 'backfill'` (start the bulk order query, M1-3), `mode: 'bulk_result'` (stream and apply its
// JSONL, M1-3b), and `mode: 'order_refresh'` (re-fetch and apply one order, issue #41 — the debounced
// job `apps/api/src/routes/shopifyWebhooks.ts`'s hint handler now enqueues). `reconcile` and the
// 60→90-day auto-extend are still deferred (issue #41).

export interface ShopifySyncDeps {
  readonly db: Db;
  readonly adapter: ShopifyAdapter;
  readonly cipher: CredentialsCipher;
  /** Hashes phone/email in memory (packages/privacy); raw values never leave `mapOrderSnapshot`. */
  readonly hasher: IdentityHasher;
  /** Durable Redis, read for the erased-identity list when an order is stored (HLD §6b). */
  readonly redis: SuppressionReader;
  /**
   * HLD §8 `identity-stitch`: backfilled orders enter at attempt 2 in bulk (identity-stitching.md
   * §5); a single `order_refresh` apply enqueues one attempt-0 job, the same as a webhook (`add`).
   */
  readonly identityStitchQueue: Pick<Queue<IdentityStitchJob>, 'addBulk' | 'add'>;
}

function decryptCredentials(
  cipher: CredentialsCipher,
  integrationId: string,
  encrypted: Buffer,
): ShopifyCredentials {
  return JSON.parse(cipher.decrypt({ integrationId }, encrypted)) as ShopifyCredentials;
}

/**
 * Runs `call` with the store's decrypted credentials; on a 401 (offline access tokens live one
 * hour), refreshes once, stores the rotated pair and retries. Same behaviour as the API's
 * `fetchOrderWithTokenRefresh`, kept separate because that one is tied to a request-scoped
 * `TenantScope`. No transaction or lock is held around either network call.
 *
 * `integration` is passed in already loaded, so a job that makes several calls reads it once.
 */
async function withTokenRefresh<T>(
  deps: ShopifySyncDeps,
  scope: Scope,
  storeId: string,
  shop: string,
  integration: IntegrationRow,
  call: (creds: ShopifyCredentials) => Promise<T>,
): Promise<T> {
  if (!integration.encryptedCredentials) {
    throw new Error(`shopify-sync: no active Shopify integration for store ${storeId}`);
  }
  const creds = decryptCredentials(deps.cipher, integration.id, integration.encryptedCredentials);
  try {
    return await call(creds);
  } catch (error) {
    if (!(error instanceof ShopifyUnauthorizedError)) throw error;
    const refreshed = await deps.adapter.refresh(shop, creds);
    await createIntegrationRepository(deps.db).upsertShopify(scope, {
      storeId,
      externalAccountId: integration.externalAccountId ?? '',
      credentialsJson: JSON.stringify(refreshed),
      scopes: integration.scopes ?? [],
      cipher: deps.cipher,
    });
    return call(refreshed);
  }
}

/**
 * Both modes have no signed-in user and no organizationId in their payload (HLD §8's `ShopifySyncJob`
 * shape is `{storeId, mode, ...}` only) — a `SystemScope` is the sanctioned unscoped path for a
 * background job to act on a store it doesn't yet have a `TenantScope` for (ADR-0016).
 * `'shopify_reconcile'` is the closest of the fixed `SystemReason`s to "the shopify-sync worker
 * acting on one store outside a request". Decision for review: revisit the reason name once
 * `reconcile`/`order_refresh` land and it's clearer whether they should share it.
 */
async function loadStoreAndIntegration(deps: ShopifySyncDeps, job: ShopifySyncJob) {
  const scope = await createSystemScope(deps.db, 'shopify_reconcile', {
    metadata: { store_id: job.storeId, mode: job.mode },
  });

  const store = await createStoreRepository(deps.db).getById(scope, job.storeId);
  if (!store) {
    // The store was deleted/uninstalled between enqueue and processing — nothing to do.
    return null;
  }

  const integration = await createIntegrationRepository(deps.db).getActiveByStore(
    scope,
    job.storeId,
    'shopify',
  );
  if (!integration?.encryptedCredentials) {
    throw new Error(
      `shopify-sync ${job.mode}: no active Shopify integration for store ${job.storeId}`,
    );
  }
  return { scope, store, integration };
}

async function runBackfill(deps: ShopifySyncDeps, job: ShopifySyncJob): Promise<void> {
  const loaded = await loadStoreAndIntegration(deps, job);
  if (!loaded) return;
  const { scope, store, integration } = loaded;

  const days = job.days ?? 60;
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const startedAt = new Date().toISOString();
  const bulkOperationId = await withTokenRefresh(
    deps,
    scope,
    job.storeId,
    store.shopDomain,
    integration,
    (creds) => deps.adapter.startBulkOrders(store.shopDomain, creds, sinceIso),
  );

  // Recorded so `bulk_result` (webhook- or operator-triggered) can be tied back to this run, and so
  // the integration health screen can say "backfill running" (LLD §2.7 `settings.backfill`).
  await createIntegrationRepository(deps.db).patchShopifyBackfillState(scope, job.storeId, {
    days,
    status: 'running',
    bulk_operation_id: bulkOperationId,
    started_at: startedAt,
  });
}

type ApplySnapshotOutcome =
  | { outcome: 'applied'; orderId: string }
  | { outcome: 'skipped_non_inr'; orderId?: undefined };

/**
 * Applies one order snapshot (shopify-integration.md §4.4/§4.5), regardless of whether it came from
 * a bulk result line or a GraphQL `fetchOrder` call. Mirrors the API's `applyOrderSnapshot` (webhook
 * path): a non-INR order is skipped (this codebase has no per-row FX handling — an MVP limitation,
 * SPEC §2), and the money-sanity flag is logged but the order is still stored (LLD §7). The two
 * copies are kept in step by hand for now — deduplicating them needs a home that both `packages/db`
 * (which must not import the adapter, see `orderRepository.ts`) and the API can share; tracked in
 * issue #41.
 */
async function applyOrderSnapshotInWorker(
  deps: ShopifySyncDeps,
  scope: Scope,
  storeId: string,
  snapshot: ShopifyOrderSnapshot,
  eventStatus: 'updated' | 'refund' | 'fulfillment',
  rawRef: string,
): Promise<ApplySnapshotOutcome> {
  if (snapshot.currency !== 'INR') return { outcome: 'skipped_non_inr' };

  const fields = mapOrderSnapshot(snapshot, storeId, deps.hasher);
  if (fields.moneySanityExceeded) {
    console.error(
      JSON.stringify({ event: 'shopify_order_money_sanity_exceeded', store_id: storeId }),
    );
  }

  // HLD §6b: an erased shopper's order is stored without their hashes (the same rule as the webhook).
  const erased = await isIdentityErased(
    deps.redis,
    storeId,
    fields.identityLookup,
    Math.floor(Date.now() / 1000),
  );

  const applied = await createOrderRepository(deps.db).applySnapshot(scope, {
    storeId,
    externalOrderId: snapshot.externalOrderId,
    createdAtPlatform: fields.createdAtPlatform,
    totalAmountPaise: fields.totalAmountPaise,
    currency: fields.currency,
    paymentMethod: fields.paymentMethod,
    refundedAmountPaise: fields.refundedAmountPaise,
    financialStatus: fields.financialStatus,
    fulfilmentStatus: fields.fulfilmentStatus,
    cancelledAt: fields.cancelledAt,
    pincodePrefix: fields.pincodePrefix,
    phoneHashHmac: erased ? null : fields.phoneHashHmac,
    emailHashHmac: erased ? null : fields.emailHashHmac,
    landingSite: fields.landingSite,
    referringSite: fields.referringSite,
    noteAttributes: fields.noteAttributes,
    discountCodes: fields.discountCodes,
    sourceTimestamp: new Date(snapshot.updatedAtPlatform),
    eventStatus,
    rawRef,
  });
  return { outcome: 'applied', orderId: applied.orderId };
}

/**
 * Applies one order from the bulk result. Re-running the same bulk result re-derives the same
 * `recon:<updatedAt>` key, so `applySnapshot`'s (order, source, raw_ref) unique constraint makes the
 * whole job idempotent.
 */
function applyBulkOrder(
  deps: ShopifySyncDeps,
  scope: Scope,
  storeId: string,
  snapshot: ShopifyOrderSnapshot,
): Promise<ApplySnapshotOutcome> {
  return applyOrderSnapshotInWorker(
    deps,
    scope,
    storeId,
    snapshot,
    'updated',
    `recon:${snapshot.updatedAtPlatform}`,
  );
}

// Shopify's terminal-but-unsuccessful bulk statuses. CREATED/RUNNING/CANCELING are "not done yet".
const BULK_FAILED_STATUSES = new Set(['FAILED', 'CANCELED', 'EXPIRED']);

async function runBulkResult(deps: ShopifySyncDeps, job: ShopifySyncJob): Promise<void> {
  const bulkOperationId = job.bulkOperationId;
  if (!bulkOperationId) {
    throw new Error('shopify-sync bulk_result: job has no bulkOperationId');
  }
  const loaded = await loadStoreAndIntegration(deps, job);
  if (!loaded) return;
  const { scope, store, integration } = loaded;
  const integrations = createIntegrationRepository(deps.db);

  const operation = await withTokenRefresh(
    deps,
    scope,
    job.storeId,
    store.shopDomain,
    integration,
    (creds) => deps.adapter.bulkOperation(store.shopDomain, creds, bulkOperationId),
  );
  if (!operation) {
    await integrations.patchShopifyBackfillState(scope, job.storeId, {
      status: 'failed',
      error_code: 'operation_not_found',
    });
    return; // Retrying cannot make Shopify find an operation it doesn't know.
  }

  if (BULK_FAILED_STATUSES.has(operation.status)) {
    await integrations.patchShopifyBackfillState(scope, job.storeId, {
      status: 'failed',
      // Shopify's `errorCode` is a short enum (e.g. ACCESS_DENIED), safe to store; the status is a fallback.
      error_code: operation.errorCode ?? operation.status.toLowerCase(),
    });
    // Partial-data recovery ("restart from the last createdAt seen", LLD §4.7) is deferred (#41).
    return;
  }
  if (operation.status !== 'COMPLETED') {
    // Still CREATED/RUNNING. Thrown, not swallowed, so BullMQ's retry/backoff re-checks it rather
    // than this job being marked done with nothing applied.
    throw new Error(`shopify-sync bulk_result: operation is ${operation.status}, not COMPLETED`);
  }

  let applied = 0;
  let skippedNonInr = 0;
  const toStitch: string[] = [];
  let invalidLines = 0;
  // A completed query that matched no orders has no result file at all.
  if (operation.url) {
    for await (const line of deps.adapter.streamBulkOrders(operation.url)) {
      if (line.kind === 'invalid') {
        invalidLines += 1;
        continue;
      }
      const result = await applyBulkOrder(deps, scope, job.storeId, line.snapshot);
      if (result.outcome === 'applied') {
        applied += 1;
        toStitch.push(result.orderId);
        if (toStitch.length >= STITCH_ENQUEUE_CHUNK)
          await enqueueStitch(deps, job.storeId, toStitch.splice(0));
      } else {
        skippedNonInr += 1;
      }
    }
  }
  await enqueueStitch(deps, job.storeId, toStitch.splice(0));

  if (skippedNonInr > 0) {
    console.error(
      JSON.stringify({
        event: 'shopify_order_non_inr_skipped',
        store_id: job.storeId,
        count: skippedNonInr,
      }),
    );
  }

  const finishedAt = new Date().toISOString();
  if (invalidLines > 0) {
    // Valid orders above are already applied (and re-applying them is a no-op), so failing here
    // loses nothing — it just refuses to report a partly-unreadable backfill as complete.
    await integrations.patchShopifyBackfillState(scope, job.storeId, {
      status: 'failed',
      error_code: 'invalid_lines',
      orders_applied: applied,
      orders_reported: operation.rootObjectCount,
      invalid_lines: invalidLines,
      finished_at: finishedAt,
    });
    throw new Error(
      `shopify-sync bulk_result: ${invalidLines} unreadable line(s) in the bulk result (${applied} orders applied)`,
    );
  }

  await integrations.patchShopifyBackfillState(scope, job.storeId, {
    status: 'done',
    orders_applied: applied,
    orders_reported: operation.rootObjectCount,
    invalid_lines: 0,
    finished_at: finishedAt,
  });
}

const STITCH_ENQUEUE_CHUNK = 500;

/**
 * Backfilled orders have no pixel data to wait for, so they enter the stitch chain at its last attempt:
 * the HMAC fallback, then the UTM fallback (identity-stitching.md §5, shopify-integration.md §4.7).
 * The job ids dedupe a re-run of the same bulk result.
 */
async function enqueueStitch(
  deps: ShopifySyncDeps,
  storeId: string,
  orderIds: readonly string[],
): Promise<void> {
  if (orderIds.length === 0) return;
  await deps.identityStitchQueue.addBulk(
    orderIds.map((orderId) => ({
      name: 'stitch',
      data: { storeId, orderId, attempt: 2 as const },
      opts: { jobId: identityStitchJobId(orderId, 2), ...IDENTITY_STITCH_JOB_OPTIONS },
    })),
  );
}

/**
 * `order_refresh` (shopify-integration.md §2.6/§4.7): the debounced follow-up to an `orders/updated`,
 * `refunds/create` or `fulfillments/*` hint. The producer (the webhook handler) already collapsed a
 * burst of hints for one order into this single job, so by the time it runs there is no reliable way
 * to say which topic(s) triggered it — `eventStatus: 'updated'` records it as a generic re-sync
 * (**decision for review**: the original hint's topic is not reflected in the resulting
 * `order_status_events` row; it remains visible in the `shopify_webhook_deliveries` trail instead).
 * `fetchOrder` returning `null` means Shopify has no such order — logged and acked, not retried
 * forever, same as the webhook path this replaces.
 */
async function runOrderRefresh(deps: ShopifySyncDeps, job: ShopifySyncJob): Promise<void> {
  const externalOrderId = job.externalOrderIds?.[0];
  if (!externalOrderId || job.externalOrderIds!.length !== 1) {
    throw new Error(
      `shopify-sync order_refresh: expected exactly one externalOrderId, got ${JSON.stringify(job.externalOrderIds)}`,
    );
  }
  const loaded = await loadStoreAndIntegration(deps, job);
  if (!loaded) return;
  const { scope, store, integration } = loaded;

  const snapshot = await withTokenRefresh(
    deps,
    scope,
    job.storeId,
    store.shopDomain,
    integration,
    (creds) => deps.adapter.fetchOrder(store.shopDomain, creds, externalOrderId),
  );
  if (!snapshot) {
    console.error(
      JSON.stringify({
        event: 'shopify_order_refresh_not_found',
        store_id: job.storeId,
      }),
    );
    return;
  }

  const result = await applyOrderSnapshotInWorker(
    deps,
    scope,
    job.storeId,
    snapshot,
    'updated',
    `refresh:${snapshot.updatedAtPlatform}`,
  );
  if (result.outcome !== 'applied') return;

  // One job per refresh, same as a webhook's own apply (shopifyWebhooks.ts `applyOrderSnapshot`) —
  // unlike the bulk backfill path, there is exactly one order here, so no batching is needed.
  await deps.identityStitchQueue.add(
    'stitch',
    { storeId: job.storeId, orderId: result.orderId, attempt: 0 },
    { jobId: identityStitchJobId(result.orderId, 0), ...IDENTITY_STITCH_JOB_OPTIONS },
  );
}

export function createShopifySyncProcessor(deps: ShopifySyncDeps) {
  return async function processShopifySyncJob(job: Job<ShopifySyncJob>): Promise<void> {
    switch (job.data.mode) {
      case 'backfill':
        return runBackfill(deps, job.data);
      case 'bulk_result':
        return runBulkResult(deps, job.data);
      case 'order_refresh':
        return runOrderRefresh(deps, job.data);
      case 'reconcile':
        throw new Error(`shopify-sync: mode '${job.data.mode}' is not implemented yet`);
    }
  };
}
