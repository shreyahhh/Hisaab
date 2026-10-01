import { eq } from 'drizzle-orm';
import { assertStoreInScope, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import {
  adAccounts,
  attributionSettings,
  channelRules,
  consentRecords,
  integrations,
  orders,
  suppressedIdentities,
} from '../schema/index.js';

// Issue #25 (privacy-dpdp.md §4.7 step 3): the Postgres half of `store_erasure` — everything that
// carries shopper or merchant-integration data for the store, except what's kept as the tombstone +
// record (`stores`, `audit_log`, `dsr_requests` — none of which hold shopper data). `orders` cascades
// `order_status_events` and `capi_dispatch_log` (both FK `ON DELETE CASCADE` to `orders.id`), so
// deleting it is enough for those two tables.

export interface EraseStoreResult {
  readonly orders: number;
  readonly consentRecords: number;
  readonly channelRules: number;
  readonly attributionSettings: number;
  readonly adAccounts: number;
  readonly integrations: number;
  readonly suppressedIdentities: number;
}

export interface DsrStoreErasureRepository {
  /** One transaction; a no-op on a second call (every delete is already empty, so counts come back 0). */
  eraseStore(scope: Scope, storeId: string): Promise<EraseStoreResult>;
}

/** The only sanctioned way to run `store_erasure`'s Postgres deletes (ADR-0016). */
export function createDsrStoreErasureRepository(db: Db): DsrStoreErasureRepository {
  return {
    async eraseStore(scope, storeId) {
      assertStoreInScope(scope, storeId);
      return db.transaction(async (tx) => {
        const deletedOrders = await tx
          .delete(orders)
          .where(eq(orders.storeId, storeId))
          .returning({ id: orders.id });
        const deletedConsent = await tx
          .delete(consentRecords)
          .where(eq(consentRecords.storeId, storeId))
          .returning({ id: consentRecords.id });
        const deletedChannelRules = await tx
          .delete(channelRules)
          .where(eq(channelRules.storeId, storeId))
          .returning({ id: channelRules.id });
        const deletedAttributionSettings = await tx
          .delete(attributionSettings)
          .where(eq(attributionSettings.storeId, storeId))
          .returning({ storeId: attributionSettings.storeId });
        const deletedAdAccounts = await tx
          .delete(adAccounts)
          .where(eq(adAccounts.storeId, storeId))
          .returning({ id: adAccounts.id });
        const deletedIntegrations = await tx
          .delete(integrations)
          .where(eq(integrations.storeId, storeId))
          .returning({ id: integrations.id });
        const deletedSuppressed = await tx
          .delete(suppressedIdentities)
          .where(eq(suppressedIdentities.storeId, storeId))
          .returning({ id: suppressedIdentities.id });

        return {
          orders: deletedOrders.length,
          consentRecords: deletedConsent.length,
          channelRules: deletedChannelRules.length,
          attributionSettings: deletedAttributionSettings.length,
          adAccounts: deletedAdAccounts.length,
          integrations: deletedIntegrations.length,
          suppressedIdentities: deletedSuppressed.length,
        };
      });
    },
  };
}
