import { and, asc, gt, inArray } from 'drizzle-orm';
import type { Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { suppressedIdentities } from '../schema/index.js';

// The one cross-tenant read of `suppressed_identities`: the suppression rebuild (HLD §8 "Suppression
// set"; privacy-dpdp.md §4.9) has to reload EVERY store's active entries into Redis, so it cannot take a
// store-scoped TenantScope. It therefore requires an audited SystemScope (ADR-0016) and refuses anything
// else. Because its guard is "system scope only" rather than "covers this store", it does not fit the
// generated cross-tenant harness (`repositoryRegistry`, which probes store/organization-scoped methods);
// it is exempt from it for that reason, and its own test proves a TenantScope is rejected.

export class SystemScopeRequiredError extends Error {
  constructor() {
    super('This operation requires an audited SystemScope');
    this.name = 'SystemScopeRequiredError';
  }
}

export interface ActiveSuppressionRow {
  readonly id: string;
  readonly storeId: string;
  readonly identifierType: 'visitor_id' | 'identity_hash_hmac';
  /** Always an HMAC, `k<N>:<hex>`. */
  readonly identifier: string;
  readonly reason: 'erased' | 'withdrawn';
  readonly expiresAt: Date;
}

export interface ListActiveSuppressionsOptions {
  /** Keyset cursor: the last `id` of the previous page (null for the first). */
  readonly afterId: string | null;
  readonly limit: number;
  /** Only entries that expire after this instant are active. */
  readonly now: Date;
  /** Restrict to these stores (a targeted rebuild, or a test); omitted = every store. */
  readonly storeIds?: readonly string[];
}

export interface SuppressionRebuildRepository {
  /** One page of active entries ordered by `id`. Requires a `SystemScope`. */
  listActivePage(
    scope: Scope,
    options: ListActiveSuppressionsOptions,
  ): Promise<ActiveSuppressionRow[]>;
}

export function createSuppressionRebuildRepository(db: Db): SuppressionRebuildRepository {
  return {
    async listActivePage(scope, options) {
      if (scope.kind !== 'system') throw new SystemScopeRequiredError();
      const conditions = [gt(suppressedIdentities.expiresAt, options.now)];
      if (options.afterId !== null) conditions.push(gt(suppressedIdentities.id, options.afterId));
      if (options.storeIds !== undefined) {
        if (options.storeIds.length === 0) return [];
        conditions.push(inArray(suppressedIdentities.storeId, [...options.storeIds]));
      }
      const rows = await db
        .select({
          id: suppressedIdentities.id,
          storeId: suppressedIdentities.storeId,
          identifierType: suppressedIdentities.identifierType,
          identifier: suppressedIdentities.identifier,
          reason: suppressedIdentities.reason,
          expiresAt: suppressedIdentities.expiresAt,
        })
        .from(suppressedIdentities)
        .where(and(...conditions))
        .orderBy(asc(suppressedIdentities.id))
        .limit(options.limit);
      return rows;
    },
  };
}
