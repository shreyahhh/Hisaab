import { and, eq } from 'drizzle-orm';
import type { Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { adAccounts, integrations, stores } from '../schema/index.js';
import type { MetaWarmupStatePatch } from './integrationRepository.js';
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

/**
 * One store's warm-up ledger (issue #63 — the internal dashboard behind `GET /v1/system/status`).
 * `warmup` is `null` for a store that has an active Meta integration but hasn't had a warm-up run
 * yet (the ledger is created on first run, not on connect).
 */
export interface WarmupState {
  readonly storeId: string;
  readonly organizationId: string;
  readonly warmup: MetaWarmupStatePatch | null;
}

export interface MetaWarmupSchedulingRepository {
  /** Every store with an active Meta integration and at least one registered ad account. Requires a `SystemScope`. */
  listWarmupStores(scope: Scope): Promise<WarmupStore[]>;
  /**
   * Every store with an active Meta integration and its `settings.warmup` ledger, regardless of
   * whether it has a registered ad account yet (unlike `listWarmupStores`, which schedules jobs and
   * so only cares about stores actually due to run one) — issue #63. Requires a `SystemScope`.
   */
  listWarmupStates(scope: Scope): Promise<WarmupState[]>;
}

/** `integrations.settings` is untyped jsonb; `warmup` is only ever written by `patchMetaWarmupState`,
 * so `MetaWarmupStatePatch` (the same type that shape comes from) is the right contract for reading
 * it back, not a fresh `any`. */
function readWarmup(settings: unknown): MetaWarmupStatePatch | null {
  if (typeof settings !== 'object' || settings === null) return null;
  const warmup = (settings as Record<string, unknown>)['warmup'];
  return typeof warmup === 'object' && warmup !== null ? (warmup as MetaWarmupStatePatch) : null;
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

    async listWarmupStates(scope) {
      if (scope.kind !== 'system') throw new SystemScopeRequiredError();
      const rows = await db
        .select({
          storeId: stores.id,
          organizationId: stores.organizationId,
          settings: integrations.settings,
        })
        .from(integrations)
        .innerJoin(stores, eq(stores.id, integrations.storeId))
        .where(and(eq(integrations.provider, 'meta'), eq(integrations.status, 'active')));
      return rows.map((row) => ({
        storeId: row.storeId,
        organizationId: row.organizationId,
        warmup: readWarmup(row.settings),
      }));
    },
  };
}
