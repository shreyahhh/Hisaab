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
// JSONL, M1-3b), `mode: 'order_refresh'` (re-fetch and apply one order, issue #41 — the debounced job
// `apps/api/src/routes/shopifyWebhooks.ts`'s hint handler enqueues), and `mode: 'reconcile'` (page
// through orders updated since the store's last run, issue #41 — registered as a daily per-store
// BullMQ Job Scheduler, `apps/workers/src/index.ts`). The 60→90-day auto-extend, the `reconcile`
// shop_hosts refresh / collector-config republish, and its >10,000-orders bulk fallback are still
// deferred (issue #41).

export interface ShopifySyncDeps {
  readonly db: Db;
  readonly adapter: ShopifyAdapter;
  readonly cipher: CredentialsCipher;
  /** Hashes phone/email in memory (packages/privacy); raw values never leave `mapOrderSnapshot`. */
  readonly hasher: IdentityHasher;
  /** Durable Redis, read for the erased-identity list when an order is stored (HLD §6b). */
  readonly redis: SuppressionReader;
  /**
   * HLD §8 `identity-stitch`: `bulk_result`'s backfilled orders enter at attempt 2 in bulk
   * (identity-stitching.md §5); `reconcile` bulk-enqueues attempt 0 (same chunking, same reasoning,
   * different entry point — its orders are recent updates, not an old-history backfill); a single
   * `order_refresh` apply enqueues one attempt-0 job, the same as a webhook (`add`).
   */
  readonly identityStitchQueue: Pick<Queue<IdentityStitchJob>, 'addBulk' | 'add'>;
  /**
   * `reconcile`'s defensive per-run cap (default `RECONCILE_MAX_ORDERS_PER_RUN`, 10,000) — overridable
   * so a test can exercise the cap path without writing 10,000 real rows.
   */
  readonly reconcileMaxOrdersPerRun?: number;
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
  { outcome: 'applied'; orderId: string } | { outcome: 'skipped_non_inr'; orderId?: undefined };

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
 * Enqueued on every apply, not only a new order: a crash between the apply and this call would
 * otherwise lose the job for good, and the job id dedupes the repeats (same reasoning as the API's
 * own `applyOrderSnapshot`). Backfilled orders (`attempt: 2`) have no pixel data to wait for, so they
 * enter the stitch chain at its last attempt: the HMAC fallback, then the UTM fallback
 * (identity-stitching.md §5, shopify-integration.md §4.7). `order_refresh`/`reconcile` use `attempt: 0`,
 * the same entry point a direct webhook apply uses.
 */
async function enqueueStitch(
  deps: ShopifySyncDeps,
  storeId: string,
  orderIds: readonly string[],
  attempt: 0 | 1 | 2,
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

// LLD: `ordersUpdatedSince(last_reconcile_at - 1h)` — the 1h overlap covers an order whose update
// landed just before the previous run's watermark was stamped (its own re-application is a no-op,
// §4.4's out-of-order guard / the `recon:<updatedAt>` raw_ref being identical either way).
const RECONCILE_WATERMARK_OVERLAP_MS = 60 * 60 * 1000;
// No prior `last_reconcile_at` (first run for this store): cover a bit over 24h, so a store connected
// just after yesterday's run time isn't missing part of a day once this job starts running for it.
const RECONCILE_FIRST_RUN_LOOKBACK_MS = 25 * 60 * 60 * 1000;
/**
 * Defensive cap, not the LLD's own design: §4.7 says ">10,000 changed orders in a run should switch
 * to a bulk query instead," but `startBulkOrders` only filters by *creation* date, not `updated_at` —
 * reconcile needs orders *changed* since a watermark, a different query Shopify's bulk API doesn't
 * expose today. Rather than build a new, untested bulk-query shape for a volume no MVP-sized store
 * (SPEC §2: ₹10L–5Cr GMV) is likely to hit, this stops the run and logs instead of looping unboundedly
 * or silently dropping the excess. Tracked as a real gap in issue #41, not silently assumed away.
 */
const RECONCILE_MAX_ORDERS_PER_RUN = 10_000;

/**
 * `reconcile` (shopify-integration.md §4.7): daily per store. Pages `ordersUpdatedSince` 250 at a
 * time and applies each through the same §4.4 path as every other mode, advancing
 * `settings.last_reconcile_at` only after a full, uncapped page-through — if the cap is hit, the
 * watermark is left where it was so the next run retries the same window rather than silently
 * skipping whatever this run didn't reach. Not built here (issue #41, explicitly scoped out): the
 * `shop_hosts` refresh / collector-config republish, and the consent-policy check (SPEC v0.6, pending
 * the access scope).
 */
async function runReconcile(deps: ShopifySyncDeps, job: ShopifySyncJob): Promise<void> {
  const loaded = await loadStoreAndIntegration(deps, job);
  if (!loaded) return;
  const { scope, store, integration } = loaded;

  const settings = (integration.settings ?? null) as { last_reconcile_at?: string } | null;
  const runStartedAt = new Date();
  const sinceMs = settings?.last_reconcile_at
    ? new Date(settings.last_reconcile_at).getTime() - RECONCILE_WATERMARK_OVERLAP_MS
    : runStartedAt.getTime() - RECONCILE_FIRST_RUN_LOOKBACK_MS;
  const sinceIso = new Date(sinceMs).toISOString();

  let applied = 0;
  let skippedNonInr = 0;
  let processed = 0;
  let after: string | null = null;
  let hasNextPage = true;
  let capReached = false;
  const toStitch: string[] = [];

  while (hasNextPage) {
    const page = await withTokenRefresh(
      deps,
      scope,
      job.storeId,
      store.shopDomain,
      integration,
      (creds) => deps.adapter.ordersUpdatedSince(store.shopDomain, creds, sinceIso, after),
    );
    for (const snapshot of page.orders) {
      const result = await applyOrderSnapshotInWorker(
        deps,
        scope,
        job.storeId,
        snapshot,
        'updated',
        `recon:${snapshot.updatedAtPlatform}`,
      );
      if (result.outcome === 'applied') {
        applied += 1;
        toStitch.push(result.orderId);
        // Attempt 0, the same entry point a direct webhook apply uses — reconciled orders are recent
        // updates, not an old-history backfill with no pixel data to wait for (unlike bulk_result).
        if (toStitch.length >= STITCH_ENQUEUE_CHUNK)
          await enqueueStitch(deps, job.storeId, toStitch.splice(0), 0);
      } else {
        skippedNonInr += 1;
      }
    }
    processed += page.orders.length;
    hasNextPage = page.hasNextPage;
    after = page.endCursor;
    if (
      hasNextPage &&
      processed >= (deps.reconcileMaxOrdersPerRun ?? RECONCILE_MAX_ORDERS_PER_RUN)
    ) {
      capReached = true;
      console.error(
        JSON.stringify({
          event: 'shopify_reconcile_order_cap_reached',
          store_id: job.storeId,
          processed,
        }),
      );
      break;
    }
  }
  await enqueueStitch(deps, job.storeId, toStitch.splice(0), 0);

  if (skippedNonInr > 0) {
    console.error(
      JSON.stringify({
        event: 'shopify_order_non_inr_skipped',
        store_id: job.storeId,
        count: skippedNonInr,
      }),
    );
  }

  if (!capReached) {
    await createIntegrationRepository(deps.db).patchShopifySettings(scope, job.storeId, {
      last_reconcile_at: runStartedAt.toISOString(),
    });
  }
  console.log(
    JSON.stringify({
      event: 'shopify_reconcile_completed',
      store_id: job.storeId,
      applied,
      skipped_non_inr: skippedNonInr,
      cap_reached: capReached,
    }),
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
        return runReconcile(deps, job.data);
    }
  };
}
