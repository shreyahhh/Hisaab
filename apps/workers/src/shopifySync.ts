import type { Job } from 'bullmq';
import {
  createIntegrationRepository,
  createStoreRepository,
  createSystemScope,
  type Db,
} from '@truepath/db';
import type { ShopifyAdapter, ShopifyCredentials } from '@truepath/integrations';
import type { CredentialsCipher } from '@truepath/privacy';
import type { ShopifySyncJob } from '@truepath/shared';

// The `shopify-sync` queue's processor (HLD §8; shopify-integration.md §4.7). This ticket (M1-3)
// implements only `mode: 'backfill'` — starting the bulk order query. `bulk_result` (fetching and
// applying the JSONL it produces), `reconcile` and `order_refresh` are deferred to follow-up
// tickets; nothing enqueues them yet.

export interface ShopifySyncDeps {
  readonly db: Db;
  readonly adapter: ShopifyAdapter;
  readonly cipher: CredentialsCipher;
}

function decryptCredentials(
  cipher: CredentialsCipher,
  integrationId: string,
  encrypted: Buffer,
): ShopifyCredentials {
  return JSON.parse(cipher.decrypt({ integrationId }, encrypted)) as ShopifyCredentials;
}

/**
 * Backfill has no signed-in user and no organizationId in its payload (HLD §8's `ShopifySyncJob`
 * shape is `{storeId, mode, ...}` only) — a `SystemScope` is the sanctioned unscoped path for a
 * background job to read a store it doesn't yet have a `TenantScope` for (ADR-0016). `'shopify_reconcile'`
 * is the closest of the fixed `SystemReason`s to "the shopify-sync worker acting on one store outside
 * a request"; a dedicated reason wasn't added since this is the only mode built so far. Decision for
 * review: revisit the reason name once `reconcile`/`order_refresh` land and it's clearer whether they
 * should share it or not.
 */
async function runBackfill(deps: ShopifySyncDeps, job: ShopifySyncJob): Promise<void> {
  const scope = await createSystemScope(deps.db, 'shopify_reconcile', {
    metadata: { store_id: job.storeId, mode: job.mode },
  });

  const store = await createStoreRepository(deps.db).getById(scope, job.storeId);
  if (!store) {
    // The store was deleted/uninstalled between enqueue and processing — nothing to back fill.
    return;
  }

  const integration = await createIntegrationRepository(deps.db).getActiveByStore(
    scope,
    job.storeId,
    'shopify',
  );
  if (!integration?.encryptedCredentials) {
    throw new Error(
      `shopify-sync backfill: no active Shopify integration for store ${job.storeId}`,
    );
  }
  const creds = decryptCredentials(deps.cipher, integration.id, integration.encryptedCredentials);

  const days = job.days ?? 60;
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  await deps.adapter.startBulkOrders(store.shopDomain, creds, sinceIso);
}

export function createShopifySyncProcessor(deps: ShopifySyncDeps) {
  return async function processShopifySyncJob(job: Job<ShopifySyncJob>): Promise<void> {
    switch (job.data.mode) {
      case 'backfill':
        return runBackfill(deps, job.data);
      case 'bulk_result':
      case 'reconcile':
      case 'order_refresh':
        throw new Error(`shopify-sync: mode '${job.data.mode}' is not implemented yet`);
    }
  };
}
