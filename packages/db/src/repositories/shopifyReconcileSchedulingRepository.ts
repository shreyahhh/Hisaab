import { and, eq } from 'drizzle-orm';
import type { Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { integrations, stores } from '../schema/index.js';
import { SystemScopeRequiredError } from './suppressionRebuildRepository.js';

// Which stores need the daily `shopify-sync` `reconcile` job registered (shopify-integration.md
// §4.7) — the one cross-tenant read behind scheduling the per-store repeatable job at Workers boot,
// same pattern as `metaWarmupSchedulingRepository`. Guarded by an audited SystemScope, not a store, so
// it sits outside the generated cross-tenant harness; its own test proves a TenantScope is refused.

export interface ReconcileStore {
  readonly storeId: string;
  readonly organizationId: string;
}

export interface ShopifyReconcileSchedulingRepository {
  /** Every store with an active Shopify integration. Requires a `SystemScope`. */
  listReconcileStores(scope: Scope): Promise<ReconcileStore[]>;
}

export function createShopifyReconcileSchedulingRepository(
  db: Db,
): ShopifyReconcileSchedulingRepository {
  return {
    async listReconcileStores(scope) {
      if (scope.kind !== 'system') throw new SystemScopeRequiredError();
      return db
        .select({ storeId: stores.id, organizationId: stores.organizationId })
        .from(integrations)
        .innerJoin(stores, eq(stores.id, integrations.storeId))
        .where(and(eq(integrations.provider, 'shopify'), eq(integrations.status, 'active')));
    },
  };
}
