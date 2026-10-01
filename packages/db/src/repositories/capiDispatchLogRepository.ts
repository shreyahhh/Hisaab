import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { assertStoreInScope, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { capiDispatchLog } from '../schema/index.js';

// `capi_dispatch_log` is currently inert — nothing in this codebase writes it yet (CAPI dispatch
// lands with M4-1) — but issue #25's erasure flow (privacy-dpdp.md §4.4 step 4) redacts it alongside
// every other order-linked table, so a later CAPI dispatch worker doesn't have to remember to.

export interface CapiDispatchLogRepository {
  /**
   * Redacts `last_error` for the given orders — a Meta API error response can echo request data
   * (hashed identifiers, the event payload), so it's treated the same as any other order-linked
   * field an erasure must clear. A no-op (0 redacted) for an empty `orderIds`.
   */
  redactLastErrorForOrders(
    scope: Scope,
    storeId: string,
    orderIds: readonly string[],
  ): Promise<{ readonly redacted: number }>;
}

/** The only sanctioned way to write `capi_dispatch_log` outside the (not-yet-built) CAPI dispatcher (ADR-0016). */
export function createCapiDispatchLogRepository(db: Db): CapiDispatchLogRepository {
  return {
    async redactLastErrorForOrders(scope, storeId, orderIds) {
      assertStoreInScope(scope, storeId);
      if (orderIds.length === 0) return { redacted: 0 };
      const updated = await db
        .update(capiDispatchLog)
        .set({ lastError: null })
        .where(
          and(
            eq(capiDispatchLog.storeId, storeId),
            inArray(capiDispatchLog.orderId, [...orderIds]),
            isNotNull(capiDispatchLog.lastError),
          ),
        )
        .returning({ id: capiDispatchLog.id });
      return { redacted: updated.length };
    },
  };
}
