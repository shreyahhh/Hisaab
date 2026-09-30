import type { Queue } from 'bullmq';
import {
  createAuditLogRepository,
  createOrderRepository,
  createSystemScope,
  type Db,
} from '@truepath/db';
import {
  identityStitchJobId,
  IDENTITY_STITCH_JOB_OPTIONS,
  type IdentityStitchJob,
} from '@truepath/shared';

// Issue #35 (identity-stitching.md §4.4 step 7 / §4.5): every order M1-2/M1-3 created before M1-7's
// identity-stitching existed still has `orders.attribution_confidence = NULL` — nothing ever computed
// it for them. stitch.ts's own comment on its "never downgrade" guard ("a backfill re-enqueues attempt
// 2 for orders that may already have matched") is exactly this backfill: re-running `stitchOrder` at
// its *final* attempt gives each order one real shot at a rule 2/3 match using data that exists now,
// and falls straight through to the UTM-fallback `low` if nothing matches — no need to replay the
// +5min/+30min retry delays for years-old orders. Re-enqueueing reuses the identity-stitch worker's
// already-tested logic (suppression checks, the shared-identifier guard, attribution enqueue) instead
// of duplicating it here.
//
// One-time by nature (M1-7 now sets confidence for every order going forward, so this table only ever
// shrinks), so this ships as a manual/ops entry point
// (`apps/workers/src/devAttributionConfidenceBackfill.ts`), not a recurring scheduled job.

export const ATTRIBUTION_CONFIDENCE_BACKFILL_PAGE_SIZE = 1_000;

export interface BackfillAttributionConfidenceDeps {
  readonly db: Db;
  readonly stitchQueue: Pick<Queue<IdentityStitchJob>, 'add'>;
  readonly pageSize?: number;
  /** Limit the backfill to these stores (a targeted run, or a test). Omitted = every store. */
  readonly storeIds?: readonly string[];
  /** Counts only. */
  readonly log?: (line: Record<string, unknown>) => void;
}

export interface BackfillAttributionConfidenceResult {
  readonly enqueued: number;
}

export async function backfillAttributionConfidence(
  deps: BackfillAttributionConfidenceDeps,
): Promise<BackfillAttributionConfidenceResult> {
  const pageSize = deps.pageSize ?? ATTRIBUTION_CONFIDENCE_BACKFILL_PAGE_SIZE;
  const scope = await createSystemScope(deps.db, 'attribution_confidence_backfill');
  const orders = createOrderRepository(deps.db);

  let enqueued = 0;
  let afterId: string | null = null;
  for (;;) {
    const page = await orders.listMissingAttributionConfidence(scope, {
      afterId,
      limit: pageSize,
      ...(deps.storeIds !== undefined ? { storeIds: deps.storeIds } : {}),
    });
    for (const { storeId, id: orderId } of page) {
      await deps.stitchQueue.add(
        'stitch',
        { storeId, orderId, attempt: 2 },
        { jobId: identityStitchJobId(orderId, 2), ...IDENTITY_STITCH_JOB_OPTIONS },
      );
      enqueued += 1;
    }
    if (page.length < pageSize) break;
    afterId = page[page.length - 1]!.id;
  }

  await createAuditLogRepository(deps.db).writePlatform({
    action: 'attribution_confidence_backfilled',
    actorType: 'system',
    targetType: 'orders',
    targetId: 'all',
    metadata: { enqueued },
  });

  deps.log?.({ event: 'attribution_confidence_backfilled', enqueued });
  return { enqueued };
}
