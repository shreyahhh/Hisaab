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
// JSONL, M1-3b), and `mode: 'order_refresh'` (re-fetch and apply one or more orders — the debounced
// replacement for the refund/fulfillment hint webhook's old synchronous apply, issue #41).
// `reconcile` and the 60→90-day auto-extend are tracked separately (issues #111, #112): each is its
// own fan-out/scheduling surface, not a small addition to this file.

export interface ShopifySyncDeps {
  readonly db: Db;
  readonly adapter: ShopifyAdapter;
  readonly cipher: CredentialsCipher;
  /** Hashes phone/email in memory (packages/privacy); raw values never leave `mapOrderSnapshot`. */
  readonly hasher: IdentityHasher;
  /** Durable Redis, read for the erased-identity list when an order is stored (HLD §6b). */
  readonly redis: SuppressionReader;
  /** HLD §8 `identity-stitch`: backfilled orders enter at attempt 2 (identity-stitching.md §5). */
  readonly identityStitchQueue: Pick<Queue<IdentityStitchJob>, 'addBulk'>;
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

/**
 * Applies one order from the bulk result. Mirrors the API's `applyOrderSnapshot` (webhook path):
 * a non-INR order is skipped (this codebase has no per-row FX handling — an MVP limitation, SPEC §2),
 * and the money-sanity flag is logged but the order is still stored (LLD §7). The two copies are
 * kept in step by hand for now — deduplicating them needs a home that both `packages/db` (which
 * must not import the adapter, see `orderRepository.ts`) and the API can share; tracked in issue #41.
 */
async function applyBulkOrder(
  deps: ShopifySyncDeps,
  scope: Scope,
  storeId: string,
  snapshot: ShopifyOrderSnapshot,
): Promise<
  { outcome: 'applied'; orderId: string } | { outcome: 'skipped_non_inr'; orderId?: undefined }
> {
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
    eventStatus: 'updated',
    // LLD §4.7: `recon:<updatedAt>`. Re-running the same bulk result re-derives the same keys, so
    // `applySnapshot`'s (order, source, raw_ref) unique constraint makes the whole job idempotent.
    rawRef: `recon:${snapshot.updatedAtPlatform}`,
  });
  return { outcome: 'applied', orderId: applied.orderId };
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
          await enqueueStitch(deps, job.storeId, toStitch.splice(0), 2);
      } else {
        skippedNonInr += 1;
      }
    }
  }
  await enqueueStitch(deps, job.storeId, toStitch.splice(0), 2);

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
 * Enqueues a stitch attempt for each order id. `attempt` is the caller's choice: backfilled orders
 * (no pixel data to wait for) enter at the last attempt, 2 — the HMAC fallback, then the UTM fallback
 * (identity-stitching.md §5, shopify-integration.md §4.7) — while an `order_refresh` apply re-enters
 * at attempt 0, same as the webhook path it replaces (shopifyWebhooks.ts's `applyOrderSnapshot`). The
 * job ids dedupe a re-run of the same result.
 */
async function enqueueStitch(
  deps: ShopifySyncDeps,
  storeId: string,
  orderIds: readonly string[],
  attempt: 0 | 2,
): Promise<void> {
  if (orderIds.length === 0) return;
  await deps.identityStitchQueue.addBulk(
    orderIds.map((orderId) => ({
      name: 'stitch',
      data: { storeId, orderId, attempt },
      opts: { jobId: identityStitchJobId(orderId, attempt), ...IDENTITY_STITCH_JOB_OPTIONS },
    })),
  );
}

/**
 * `order_refresh` (issue #41): re-fetches one or more orders and applies them, same as the
 * refund/fulfillment "hint" webhook path used to do synchronously, inline in the request
 * (shopifyWebhooks.ts's `handleOrderHintWebhook`) — moved here so the webhook handler can debounce
 * instead (LLD §2.6: 30s, one job per order, stable job id). Reuses `applyBulkOrder` rather than a
 * third near-copy of the apply logic: a refetched order and a bulk-result row are the same shape
 * (`ShopifyOrderSnapshot`), and `recon:<updatedAtPlatform>` is in fact a better idempotency key here
 * than the old path's webhook id — it's keyed to the data, not the delivery, so several webhooks
 * collapsing into one debounced fetch still applies cleanly exactly once per distinct order state.
 */
async function runOrderRefresh(deps: ShopifySyncDeps, job: ShopifySyncJob): Promise<void> {
  const externalOrderIds = job.externalOrderIds ?? [];
  if (externalOrderIds.length === 0) {
    throw new Error('shopify-sync order_refresh: job has no externalOrderIds');
  }
  const loaded = await loadStoreAndIntegration(deps, job);
  if (!loaded) return;
  const { scope, store, integration } = loaded;

  const stitched: string[] = [];
  for (const externalOrderId of externalOrderIds) {
    const snapshot = await withTokenRefresh(
      deps,
      scope,
      job.storeId,
      store.shopDomain,
      integration,
      (creds) => deps.adapter.fetchOrder(store.shopDomain, creds, externalOrderId),
    );
    if (!snapshot) {
      // Same reasoning as the webhook path this replaces: shouldn't happen for a refund/fulfillment
      // hint in practice; log and move on to the next id rather than retrying forever.
      console.error(
        JSON.stringify({
          event: 'shopify_order_refresh_order_not_found',
          store_id: job.storeId,
        }),
      );
      continue;
    }
    const result = await applyBulkOrder(deps, scope, job.storeId, snapshot);
    if (result.outcome === 'applied') stitched.push(result.orderId);
  }
  await enqueueStitch(deps, job.storeId, stitched, 0);
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
