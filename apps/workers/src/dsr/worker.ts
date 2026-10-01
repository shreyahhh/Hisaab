import { DelayedError, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  createAuditLogRepository,
  createDsrRequestRepository,
  createStoreRepository,
  jobScope,
} from '@truepath/db';
import { DsrJobSchema, storeBoundScope, type DsrJob } from '@truepath/shared';
import { runCorrection } from './correction.js';
import { isSuppressionReady, SuppressionNotReadyError } from '../eventSuppression.js';
import {
  runFollowupErasure,
  runWebhookErasure,
  runWithdrawalErasure,
  type ErasureDeps,
} from './erasure.js';
import { runStoreErasure } from './storeErasure.js';

// The `dsr` queue's BullMQ processor (HLD §8; privacy-dpdp.md §4.4/§4.5/§4.6/§4.7). `erasure`,
// `store_erasure` and `correction` are fulfilled here; `access` has no fulfilment yet (issue #91 —
// needs an S3 export bucket this phase doesn't provision).

export class DsrTypeNotImplementedError extends Error {
  constructor(type: string) {
    super(`dsr: type '${type}' is not implemented yet`);
    this.name = 'DsrTypeNotImplementedError';
  }
}

/** A reference to the `dsr` queue itself, typed loosely so a real BullMQ `Queue` satisfies it. */
export interface DsrQueueRef {
  getJob(jobId: string): Promise<{ readonly data: unknown } | undefined>;
}

export interface DsrWorkerDeps extends ErasureDeps {
  readonly redis: ErasureDeps['redis'] & Pick<Redis, 'exists' | 'scan'>;
  /** The suppression readiness marker; only tests override the default. */
  readonly readyKey?: string;
  /**
   * privacy-dpdp.md §4.5 step 2: looks up a claimed withdrawal request's own queued job
   * (`dsr-<requestId>`, eventBatch.ts) to recover its raw `visitorIds` — `dsr_requests` itself only
   * ever stores an HMAC, which cannot be reverse-joined against ClickHouse's raw `visitor_id`
   * columns (jobs.ts's `DsrJob.visitorIds` doc comment).
   */
  readonly dsrQueue: DsrQueueRef;
}

export type DsrOutcome =
  | { readonly kind: 'webhook'; readonly visitorsScoped: number; readonly ordersAffected: number }
  | {
      readonly kind: 'withdrawal';
      readonly visitorsScoped: number;
      readonly ordersAffected: number;
    }
  | { readonly kind: 'followup'; readonly visitorsScoped: number; readonly ordersAffected: number }
  | { readonly kind: 'store_erasure'; readonly ordersDeleted: number }
  | { readonly kind: 'correction'; readonly hashesScoped: number; readonly ordersAffected: number }
  | { readonly kind: 'already_completed' };

/**
 * Dispatches one `erasure`/`store_erasure` job to the right scope (webhook / withdrawal / follow-up /
 * store-wide), per the `resultSummary.trigger` the request was created with for `erasure` (erasure.ts's
 * module comment explains why that, not the job payload, is what distinguishes a follow-up from a
 * withdrawal — both carry `visitorIds`).
 */
export async function processDsr(
  deps: DsrWorkerDeps,
  job: DsrJob,
  jobId: string,
): Promise<DsrOutcome> {
  if (job.type !== 'erasure' && job.type !== 'store_erasure' && job.type !== 'correction') {
    throw new DsrTypeNotImplementedError(job.type);
  }

  const scope = storeBoundScope(job.storeId);
  const store = await createStoreRepository(deps.db).getById(scope, job.storeId);
  if (!store) throw new Error(`dsr: store ${job.storeId} not found`);
  const orgScope = jobScope(store.organizationId, job.storeId);
  const dsrRequests = createDsrRequestRepository(deps.db);

  const { row, alreadyCompleted } = await dsrRequests.beginProcessing(
    orgScope,
    job.storeId,
    job.requestId,
  );

  if (job.type === 'store_erasure') {
    if (alreadyCompleted) return { kind: 'already_completed' };
    const result = await runStoreErasure(deps, job.storeId, row);
    return { kind: 'store_erasure', ordersDeleted: result.ordersDeleted };
  }

  const trigger = (row.resultSummary as { trigger?: string } | null)?.trigger;

  const audit = createAuditLogRepository(deps.db);

  if (job.type === 'correction') {
    if (alreadyCompleted) return { kind: 'already_completed' };
    if (row.identityHash === null) {
      throw new Error(`dsr: correction request ${job.requestId} has no identity_hash`);
    }
    const counts = await runCorrection(deps, job.storeId, row.identityHash);
    await dsrRequests.complete(orgScope, job.storeId, job.requestId, {
      resultSummaryPatch: {
        identity_links_deleted_hashes: counts.hashesScoped,
        orders_affected: counts.ordersAffected,
      },
      completedAt: deps.now(),
    });
    await audit.write(orgScope, {
      organizationId: store.organizationId,
      actorUserId: null,
      actorType: 'system',
      action: 'dsr_completed',
      targetType: 'dsr_request',
      targetId: job.requestId,
      metadata: {
        type: 'correction',
        trigger: trigger as
          'merchant' | 'shopify_webhook' | 'consent_withdrawn' | 'consent_region_remediation',
      },
    });
    return {
      kind: 'correction',
      hashesScoped: counts.hashesScoped,
      ordersAffected: counts.ordersAffected,
    };
  }

  if (job.visitorIds !== undefined && trigger !== 'consent_withdrawn') {
    // Follow-up purge (§4.4 step 9): `row` is the original, already-completed erasure this new
    // suppression hit was matched against — a separate, later action referencing it, not a re-run of
    // it, so its own status/result_summary.* top-level keys are untouched (only `followups[]` grows).
    const counts = await runFollowupErasure(
      deps,
      job.storeId,
      job.requestId,
      job.visitorIds,
      jobId,
    );
    await audit.write(orgScope, {
      organizationId: store.organizationId,
      actorUserId: null,
      actorType: 'system',
      action: 'dsr_followup_erasure',
      targetType: 'dsr_request',
      targetId: job.requestId,
      metadata: { visitor_count: counts.visitorsScoped, rows_deleted: counts.ordersAffected },
    });
    return {
      kind: 'followup',
      visitorsScoped: counts.visitorsScoped,
      ordersAffected: counts.ordersAffected,
    };
  }

  if (alreadyCompleted) return { kind: 'already_completed' };

  // Validated by the audit metadata schema itself at write time (AUDIT_METADATA_SCHEMAS.dsr_completed):
  // an unexpected `trigger` value fails loudly here rather than being silently mislabelled.
  const dsrTrigger = trigger as
    'merchant' | 'shopify_webhook' | 'consent_withdrawn' | 'consent_region_remediation';

  if (job.visitorIds !== undefined) {
    // trigger === 'consent_withdrawn'. §4.5 step 2: fold in up to 500 other pending
    // withdrawal-triggered requests for this store, so a burst of withdrawals issues one delete
    // per table instead of one per visitor.
    const claimed = await dsrRequests.claimPendingWithdrawalBatch(
      orgScope,
      job.storeId,
      job.requestId,
      500,
    );
    const foldedInIds: string[] = [];
    const unresolvedIds: string[] = [];
    const extraVisitorIds: string[] = [];
    for (const claim of claimed) {
      const claimedJob = await deps.dsrQueue.getJob(`dsr-${claim.id}`);
      const parsed = claimedJob ? DsrJobSchema.safeParse(claimedJob.data) : undefined;
      if (parsed?.success && parsed.data.visitorIds && parsed.data.visitorIds.length > 0) {
        extraVisitorIds.push(...parsed.data.visitorIds);
        foldedInIds.push(claim.id);
      } else {
        // Its own raw visitor id can't be recovered (the job is gone) — nothing to erase for it,
        // and leaving it `in_progress` forever would strand it, so it's completed as a no-op.
        unresolvedIds.push(claim.id);
      }
    }
    const allVisitorIds = [...new Set([...job.visitorIds, ...extraVisitorIds])];

    const counts = await runWithdrawalErasure(deps, job.storeId, allVisitorIds);

    for (const id of unresolvedIds) {
      await dsrRequests.complete(orgScope, job.storeId, id, {
        resultSummaryPatch: {
          visitors_scoped: 0,
          orders_affected: 0,
          note: 'job_data_unavailable',
        },
        completedAt: deps.now(),
      });
      await audit.write(orgScope, {
        organizationId: store.organizationId,
        actorUserId: null,
        actorType: 'system',
        action: 'dsr_completed',
        targetType: 'dsr_request',
        targetId: id,
        metadata: { type: 'erasure', trigger: 'consent_withdrawn' },
      });
    }
    for (const id of [job.requestId, ...foldedInIds]) {
      await dsrRequests.complete(orgScope, job.storeId, id, {
        resultSummaryPatch: {
          visitors_scoped: counts.visitorsScoped,
          orders_affected: counts.ordersAffected,
          ...(id === job.requestId ? {} : { batched_with: job.requestId }),
        },
        completedAt: deps.now(),
      });
      await audit.write(orgScope, {
        organizationId: store.organizationId,
        actorUserId: null,
        actorType: 'system',
        action: 'dsr_completed',
        targetType: 'dsr_request',
        targetId: id,
        metadata: { type: 'erasure', trigger: dsrTrigger },
      });
    }
    return {
      kind: 'withdrawal',
      visitorsScoped: counts.visitorsScoped,
      ordersAffected: counts.ordersAffected,
    };
  }

  if (row.identityHash === null) {
    throw new Error(`dsr: erasure request ${job.requestId} has no identity_hash`);
  }
  const counts = await runWebhookErasure(deps, job.storeId, job.requestId, row.identityHash);
  await dsrRequests.complete(orgScope, job.storeId, job.requestId, {
    resultSummaryPatch: {
      visitors_scoped: counts.visitorsScoped,
      orders_affected: counts.ordersAffected,
      guard_rejected_hashes: counts.guardRejectedHashes,
    },
    completedAt: deps.now(),
  });
  await audit.write(orgScope, {
    organizationId: store.organizationId,
    actorUserId: null,
    actorType: 'system',
    action: 'dsr_completed',
    targetType: 'dsr_request',
    targetId: job.requestId,
    metadata: { type: 'erasure', trigger: dsrTrigger },
  });
  return {
    kind: 'webhook',
    visitorsScoped: counts.visitorsScoped,
    ordersAffected: counts.ordersAffected,
  };
}

/**
 * The BullMQ processor, following `identity/stitch.ts`'s exact shape: validates the payload, fails
 * closed (delays, doesn't burn an attempt) while suppression is unavailable, and logs counts only.
 */
export function createDsrProcessor(
  deps: DsrWorkerDeps,
  log: (line: Record<string, unknown>) => void,
) {
  return async function processDsrJob(job: Job<DsrJob>, token?: string): Promise<{ kind: string }> {
    const data = DsrJobSchema.parse(job.data);
    if (!(await isSuppressionReady(deps.redis, deps.readyKey))) {
      if (token === undefined) throw new SuppressionNotReadyError();
      log({ event: 'dsr_job_paused', reason: 'suppression_not_ready' });
      await job.moveToDelayed(Date.now() + 30_000, token);
      throw new DelayedError();
    }
    const outcome = await processDsr(deps, data, job.id ?? `dsr-${data.requestId}`);
    log({ event: 'dsr_job', type: data.type, outcome: outcome.kind });
    return { kind: outcome.kind };
  };
}

/** Marks the request `failed` once BullMQ's retries are exhausted. Never downgrades a `completed` row. */
export function createDsrFailureHandler(deps: Pick<ErasureDeps, 'db'>) {
  return async function onDsrJobFailed(job: Job<DsrJob> | undefined): Promise<void> {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return; // will be retried

    const parsed = DsrJobSchema.safeParse(job.data);
    if (!parsed.success) return;
    const { storeId, requestId, type } = parsed.data;

    const scope = storeBoundScope(storeId);
    const store = await createStoreRepository(deps.db).getById(scope, storeId);
    if (!store) return;
    const orgScope = jobScope(store.organizationId, storeId);
    const dsrRequests = createDsrRequestRepository(deps.db);
    await dsrRequests.fail(orgScope, storeId, requestId);
    await createAuditLogRepository(deps.db).write(orgScope, {
      organizationId: store.organizationId,
      actorUserId: null,
      actorType: 'system',
      action: 'dsr_failed',
      targetType: 'dsr_request',
      targetId: requestId,
      metadata: { type, attempts: job.attemptsMade },
    });
  };
}
