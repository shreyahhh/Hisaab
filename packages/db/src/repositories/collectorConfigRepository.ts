import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { integrations, stores } from '../schema/index.js';
import { SystemScopeRequiredError } from './suppressionRebuildRepository.js';

// Which stores have a collector config to (re)publish — the one cross-tenant read behind the suppression
// rebuild's config step (#56). Like `suppressionRebuildRepository`, its guard is "audited SystemScope
// only" rather than "covers this store", so it is exempt from the generated cross-tenant harness
// (`repositoryRegistry`); its own test proves a TenantScope is refused. It returns only ids — the
// publisher then reads each store under a one-store scope (ADR-0026).

export interface PublishableStore {
  readonly storeId: string;
  readonly organizationId: string;
}

export interface CollectorConfigRepository {
  /** Stores with an active Shopify integration, in store-id order. Requires a `SystemScope`. */
  listActiveShopifyStores(
    scope: Scope,
    options?: { readonly storeIds?: readonly string[] },
  ): Promise<PublishableStore[]>;
}

export function createCollectorConfigRepository(db: Db): CollectorConfigRepository {
  return {
    async listActiveShopifyStores(scope, options = {}) {
      if (scope.kind !== 'system') throw new SystemScopeRequiredError();
      if (options.storeIds !== undefined && options.storeIds.length === 0) return [];
      const conditions = [eq(integrations.provider, 'shopify'), eq(integrations.status, 'active')];
      if (options.storeIds !== undefined) {
        conditions.push(inArray(stores.id, [...options.storeIds]));
      }
      return db
        .select({ storeId: stores.id, organizationId: stores.organizationId })
        .from(integrations)
        .innerJoin(stores, eq(stores.id, integrations.storeId))
        .where(and(...conditions))
        .orderBy(asc(stores.id));
    },
  };
}
