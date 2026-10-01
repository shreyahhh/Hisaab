import { DelayedError, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  createAuditLogRepository,
  createDsrRequestRepository,
  createStoreRepository,
  jobScope,
} from '@truepath/db';
import { DsrJobSchema, storeBoundScope, type DsrJob } from '@truepath/shared';
import { isSuppressionReady, SuppressionNotReadyError } from '../eventSuppression.js';
import {
  runFollowupErasure,
  runWebhookErasure,
  runWithdrawalErasure,
  type ErasureDeps,
} from './erasure.js';

// The `dsr` queue's BullMQ processor (HLD §8; privacy-dpdp.md §4.4/§4.5). `erasure` is the only type
// fulfilled here — `store_erasure` lands with issue #25's third PR, `access`/`correction` have no
// producer yet (SPEC v0.5: access needs an S3 export bucket this phase doesn't build; correction has
// no caller anywhere in the codebase).

export class DsrTypeNotImplementedError extends Error {
  constructor(type: string) {
    super(`dsr: type '${type}' is not implemented yet`);
    this.name = 'DsrTypeNotImplementedError';
  }
}

export interface DsrWorkerDeps extends ErasureDeps {
  readonly redis: ErasureDeps['redis'] & Pick<Redis, 'exists'>;
  /** The suppression readiness marker; only tests override the default. */
  readonly readyKey?: string;
}

export type DsrOutcome =
  | { readonly kind: 'webhook'; readonly visitorsScoped: number; readonly ordersAffected: number }
  | {
      readonly kind: 'withdrawal';
      readonly visitorsScoped: number;
      readonly ordersAffected: number;
    }
  | { readonly kind: 'followup'; readonly visitorsScoped: number; readonly ordersAffected: number }
  | { readonly kind: 'already_completed' };

/**
 * Dispatches one `erasure` job to the right scope (webhook / withdrawal / follow-up), per the
 * `resultSummary.trigger` the request was created with (erasure.ts's module comment explains why that,
 * not the job payload, is what distinguishes a follow-up from a withdrawal — both carry `visitorIds`).
 */
export async function processDsr(
  deps: DsrWorkerDeps,
  job: DsrJob,
  jobId: string,
): Promise<DsrOutcome> {
  if (job.type !== 'erasure') throw new DsrTypeNotImplementedError(job.type);

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
  const trigger = (row.resultSummary as { trigger?: string } | null)?.trigger;

  const audit = createAuditLogRepository(deps.db);

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
    // trigger === 'consent_withdrawn'
    const counts = await runWithdrawalErasure(deps, job.storeId, job.visitorIds);
    await dsrRequests.complete(orgScope, job.storeId, job.requestId, {
      resultSummaryPatch: {
        visitors_scoped: counts.visitorsScoped,
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
      metadata: { type: 'erasure', trigger: dsrTrigger },
    });
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
