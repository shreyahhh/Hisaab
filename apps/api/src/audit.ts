import { redactLogValue, AuditMetadataError } from '@truepath/privacy';
import type { AuditLogRepository, AuditOutboxRepository } from '@truepath/db';
import type { OrganizationAuditEntry, PlatformAuditEntry, Scope } from '@truepath/shared';

// Audit writes for Better Auth actions (ADR-0028, supersedes ADR-0021; issue #13).
//
// Better Auth commits its own change (an invite, a role change, a removal, a session) and none of
// its organization hooks runs inside that transaction, so our audit row cannot be made atomic with
// it. Once Better Auth has committed, the client must get the real success response: a 500 would
// tell them a change failed that in fact happened.
//
// So the entry — already fully known once Better Auth has returned — is first durably recorded as
// *intent* in `audit_outbox` (one fast insert), then an attempt is made to complete it: lock the
// row, insert into `audit_log`, mark it done. If both completion attempts fail, the row stays
// `pending` and a background sweep (apps/workers) finishes it later; the failure is still reported
// immediately, with the outbox id, so ops sees it without waiting for the sweep's own cadence. Only
// if the *outbox write itself* fails twice is the entry truly unrecoverable — reported the same way,
// with no outbox id, which is this design's one remaining gap (see ADR-0028: closing it fully would
// require wrapping Better Auth's own commit, which the ADR already ruled out).
//
// Our own actions are different: viewing the audit log is not a committed change, and personal-data
// views must not be returned unaudited, so `audit_log_viewed` is written before the response and its
// failure fails the request. Writes we perform ourselves (settings changes, DSRs, exports) use
// `createAuditLogRepository(tx)` in the same transaction as the change.

export interface AuditFailureReport {
  readonly event: 'audit_write_failed';
  /** The alert rule matches on this. */
  readonly alert: 'audit_write_failed';
  readonly attempts: number;
  readonly organizationId: string | null;
  /** The whole intended entry; absent only when its metadata failed validation (see `error`). */
  readonly entry?: OrganizationAuditEntry | PlatformAuditEntry;
  readonly action: string;
  readonly error: { readonly name: string; readonly message: unknown };
  /**
   * Present when the entry is durably recorded in `audit_outbox` and a background sweep will finish
   * it — this report is visibility, not the only path to recovery. Absent means the outbox write
   * itself failed: nothing durable exists, and recovery is manual from this log line (ADR-0028's one
   * remaining gap).
   */
  readonly outboxId?: string;
}

export type AuditFailureReporter = (report: AuditFailureReport) => void;

/** Default reporter: one structured JSON line on stderr, for the log pipeline's alert rule. */
export const logAuditFailure: AuditFailureReporter = (report) => {
  console.error(JSON.stringify(report));
};

export interface AuditService {
  readonly log: AuditLogRepository;
  /** Records an organization entry for an action that has already committed. Retries once; never throws. */
  afterCommit(scope: Scope, entry: OrganizationAuditEntry): Promise<void>;
  /** Same, for a platform-wide entry (login outcomes). */
  afterCommitPlatform(entry: PlatformAuditEntry): Promise<void>;
}

export interface AuditServiceOptions {
  readonly report?: AuditFailureReporter;
  /** Wait before each retried attempt (enqueue or complete). */
  readonly retryDelayMs?: number;
}

const ATTEMPTS = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createAuditService(
  log: AuditLogRepository,
  outbox: AuditOutboxRepository,
  options: AuditServiceOptions = {},
): AuditService {
  const report = options.report ?? logAuditFailure;
  const retryDelayMs = options.retryDelayMs ?? 100;

  function reportFailure(
    entry: OrganizationAuditEntry | PlatformAuditEntry,
    attempts: number,
    error: unknown,
    outboxId: string | undefined,
  ): void {
    const err = error instanceof Error ? error : new Error(String(error));
    const invalid = error instanceof AuditMetadataError;
    try {
      report({
        event: 'audit_write_failed',
        alert: 'audit_write_failed',
        attempts,
        organizationId: 'organizationId' in entry ? entry.organizationId : null,
        action: entry.action,
        // Metadata that failed validation may hold what the check exists to keep out: leave it out.
        ...(invalid ? {} : { entry }),
        error: { name: err.name, message: redactLogValue(err.message) },
        ...(outboxId ? { outboxId } : {}),
      });
    } catch {
      // A broken reporter must not turn a committed action into a failed request.
    }
  }

  async function attempt(
    enqueue: () => Promise<string>,
    entry: OrganizationAuditEntry | PlatformAuditEntry,
  ): Promise<void> {
    // Step 1: durably record intent. Enqueueing twice would create two outbox rows for the same
    // logical entry (and, eventually, two audit_log rows), so this loop only ever calls `enqueue`
    // again if the previous call never created a row.
    let outboxId: string | undefined;
    let enqueueError: unknown;
    for (let i = 0; i < ATTEMPTS && outboxId === undefined; i += 1) {
      try {
        outboxId = await enqueue();
      } catch (error) {
        enqueueError = error;
        if (i < ATTEMPTS - 1 && retryDelayMs > 0) await sleep(retryDelayMs);
      }
    }
    if (outboxId === undefined) {
      reportFailure(entry, ATTEMPTS, enqueueError, undefined);
      return;
    }

    // Step 2: complete it. `outbox.complete` is idempotent (locks the row, checks it's still
    // `pending`), so retrying it is always safe.
    let completeError: unknown;
    let attempts = 0;
    while (attempts < ATTEMPTS) {
      attempts += 1;
      try {
        await outbox.complete(outboxId);
        return;
      } catch (error) {
        completeError = error;
        // A validation failure is a bug, not a transient fault: `complete` already marked the row
        // `abandoned`, and retrying can't help.
        if (error instanceof AuditMetadataError) break;
        if (attempts < ATTEMPTS && retryDelayMs > 0) await sleep(retryDelayMs);
      }
    }
    // The row stays `pending` (unless it was just abandoned above) for the sweep to finish later —
    // reported now so it's visible sooner than the sweep's own cadence.
    reportFailure(entry, attempts, completeError, outboxId);
  }

  return {
    log,
    afterCommit: (scope, entry) => attempt(() => outbox.enqueue(scope, entry), entry),
    afterCommitPlatform: (entry) => attempt(() => outbox.enqueuePlatform(entry), entry),
  };
}
