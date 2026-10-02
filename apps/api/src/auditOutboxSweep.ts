import { createSystemScope, type AuditOutboxRepository, type Db } from '@truepath/db';

// ADR-0028 (supersedes ADR-0021), issue #13: the backstop behind every Better Auth action's audit
// row. `apps/api/src/audit.ts` enqueues-then-completes inline on every request; this periodic sweep
// (run in-process by apps/api, not a new BullMQ queue — it needs no cross-process distribution, and
// a new queue name needs HLD §8 sign-off) finishes whatever that inline attempt couldn't, and prunes
// old finished rows.

export const AUDIT_OUTBOX_SWEEP_INTERVAL_MS = 5 * 60_000; // 5 min: a backstop, not the primary path
// Rows younger than this are left alone — the request that enqueued one may still be retrying it
// itself (ATTEMPTS=2, retryDelayMs=100 in audit.ts: finishes in well under a second either way).
export const AUDIT_OUTBOX_SWEEP_GRACE_MS = 60_000;
// The audit_log row (once written) is the permanent record (S-4, ≥ 1 year); the outbox row is only
// needed long enough to prove it happened, so a short retention is fine here.
export const AUDIT_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const AUDIT_OUTBOX_SWEEP_BATCH_SIZE = 200;

export interface AuditOutboxSweepDeps {
  readonly db: Db;
  readonly outbox: AuditOutboxRepository;
  readonly log?: (line: Record<string, unknown>) => void;
}

export interface AuditOutboxSweepResult {
  readonly completed: number;
  readonly stillFailing: number;
  readonly deleted: number;
}

/**
 * One sweep pass: completes pending rows older than the grace period, and deletes finished
 * (`done`/`abandoned`) rows older than the retention window. `complete` is the same idempotent,
 * lock-based operation `audit.ts` itself calls — safe to run concurrently with an in-flight request
 * still retrying the same row (whichever gets there first wins; the other is a no-op).
 */
export async function runAuditOutboxSweep(
  deps: AuditOutboxSweepDeps,
  now: Date = new Date(),
): Promise<AuditOutboxSweepResult> {
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)));
  const scope = await createSystemScope(deps.db, 'audit_outbox_sweep');
  const olderThan = new Date(now.getTime() - AUDIT_OUTBOX_SWEEP_GRACE_MS);

  const pending = await deps.outbox.listPending(scope, olderThan, {
    limit: AUDIT_OUTBOX_SWEEP_BATCH_SIZE,
  });
  let completed = 0;
  let stillFailing = 0;
  for (const row of pending) {
    try {
      await deps.outbox.complete(row.id);
      completed += 1;
    } catch (error) {
      stillFailing += 1;
      log({
        event: 'audit_outbox_sweep_complete_failed',
        outbox_id: row.id,
        error_name: error instanceof Error ? error.name : 'Unknown',
      });
    }
  }

  const retentionCutoff = new Date(now.getTime() - AUDIT_OUTBOX_RETENTION_MS);
  const { deleted } = await deps.outbox.deleteFinished(scope, retentionCutoff);

  const result = { completed, stillFailing, deleted };
  log({ event: 'audit_outbox_swept', ...result });
  return result;
}

/** Registers the periodic sweep. Returns a stop function; the timer is `unref`'d (never keeps the process alive on its own). */
export function startAuditOutboxSweep(
  deps: AuditOutboxSweepDeps,
  intervalMs = AUDIT_OUTBOX_SWEEP_INTERVAL_MS,
): () => void {
  let inFlight: Promise<AuditOutboxSweepResult> | null = null;
  const tick = (): void => {
    if (inFlight) return; // an overrunning sweep is never doubled up
    inFlight = runAuditOutboxSweep(deps).finally(() => {
      inFlight = null;
    });
    inFlight.catch((error) => {
      (deps.log ?? ((line) => console.log(JSON.stringify(line))))({
        event: 'audit_outbox_sweep_failed',
        error_name: error instanceof Error ? error.name : 'Unknown',
      });
    });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
