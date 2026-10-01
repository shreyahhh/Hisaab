import type { Queue } from 'bullmq';
import { ch, type ClickHouseClient } from '@truepath/clickhouse';
import type { Db } from '@truepath/db';
import {
  ATTRIBUTION_RUN_JOB_OPTIONS,
  attributionRunJobId,
  storeBoundScope,
  type AttributionRunJob,
} from '@truepath/shared';
import { resolveErasureScope } from './resolveErasureScope.js';

// privacy-dpdp.md §4.6: DSR correction (`unlink_identity`). Unlike erasure, nothing is suppressed
// and no order is touched — only the cross-device merges `identity_links` recorded are undone, so a
// shopper who was wrongly linked to another device's identity gets their journey re-split. Future
// checkouts may re-link the identity (SPEC §5.6's "limited" correction), which is why this isn't a
// full unlink.

export interface CorrectionDeps {
  readonly db: Db;
  readonly clickhouse: ClickHouseClient;
  readonly attributionQueue: Pick<Queue<AttributionRunJob>, 'add'>;
  readonly now: () => Date;
}

export interface CorrectionCounts {
  readonly hashesScoped: number;
  readonly ordersAffected: number;
}

/**
 * §4.6 steps 1-4: resolve H/O (the same one-hop expansion erasure uses, reused as-is and read-only),
 * delete `identity_links` for H, and re-run attribution for O. `orders.visitor_id` is never touched
 * here — only a primary `order_id` match sets it (SPEC §7.3 rule 2), and this never un-sets it.
 */
export async function runCorrection(
  deps: CorrectionDeps,
  storeId: string,
  identityHash: string,
): Promise<CorrectionCounts> {
  const scope = storeBoundScope(storeId);
  const { hashes, orderIds } = await resolveErasureScope(
    { db: deps.db, clickhouse: deps.clickhouse, now: deps.now },
    storeId,
    identityHash,
  );

  if (hashes.length > 0) {
    await ch(deps.clickhouse, scope, storeId).delete({
      table: 'identity_links',
      where: {
        identity_hash_hmac: { op: 'IN', value: [...hashes], type: 'Array(String)' },
      },
    });
  }

  for (const orderId of orderIds) {
    await deps.attributionQueue.add(
      'incremental',
      { storeId, mode: 'incremental', orderIds: [orderId] },
      { jobId: attributionRunJobId(orderId), ...ATTRIBUTION_RUN_JOB_OPTIONS },
    );
  }

  return { hashesScoped: hashes.length, ordersAffected: orderIds.length };
}
