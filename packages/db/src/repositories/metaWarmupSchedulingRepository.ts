import { and, eq } from 'drizzle-orm';
import type { Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { adAccounts, integrations, stores } from '../schema/index.js';
import { SystemScopeRequiredError } from './suppressionRebuildRepository.js';

// Which stores have a registered Meta warm-up account to run (meta-integration.md §2.2 `meta-warmup`) —
// the one cross-tenant read behind scheduling the repeatable job for every registered store. One row per
// store (not per ad account): `AdSyncMetaJob{storeId}` carries only the store id, per the LLD's job
// registry — the processor reads `settings.ad_account_ids` itself to know which accounts to pull, so a
// store with several registered accounts still needs only one scheduled job. Same exemption pattern as
// `suppressionRebuildRepository` / `collectorConfigRepository`: guarded by an audited SystemScope, not a
// store, so it sits outside the generated cross-tenant harness; its own test proves a TenantScope is
// refused.

export interface WarmupStore {
  readonly storeId: string;
  readonly organizationId: string;
}

export interface MetaWarmupSchedulingRepository {
  /** Every store with an active Meta integration and at least one registered ad account. Requires a `SystemScope`. */
  listWarmupStores(scope: Scope): Promise<WarmupStore[]>;
}

export function createMetaWarmupSchedulingRepository(db: Db): MetaWarmupSchedulingRepository {
  return {
    async listWarmupStores(scope) {
      if (scope.kind !== 'system') throw new SystemScopeRequiredError();
      return db
        .selectDistinct({ storeId: stores.id, organizationId: stores.organizationId })
        .from(integrations)
        .innerJoin(stores, eq(stores.id, integrations.storeId))
        .innerJoin(
          adAccounts,
          and(eq(adAccounts.storeId, integrations.storeId), eq(adAccounts.provider, 'meta')),
        )
        .where(and(eq(integrations.provider, 'meta'), eq(integrations.status, 'active')));
    },
  };
}
