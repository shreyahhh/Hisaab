import { redactLogValue, AuditMetadataError } from '@truepath/privacy';
import type { AuditLogRepository } from '@truepath/db';
import type { OrganizationAuditEntry, PlatformAuditEntry, Scope } from '@truepath/shared';

// Audit writes for Better Auth actions (ADR-0021).
//
// Better Auth commits its own change (an invite, a role change, a removal, a session) and none of
// its organization hooks runs inside that transaction, so our audit row cannot be made atomic with
// it. Once Better Auth has committed, the client must get the real success response: a 500 would
// tell them a change failed that in fact happened. So after a commit the write is retried once, and
// if it still fails the failure is reported with the complete intended entry — enough to insert the
// row by hand — and an alert marker, and the request carries on. (Our own writes, such as viewing
// the audit log, don't use this: there the audit row must exist before the response.)

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
  /** Wait before the single retry. */
  readonly retryDelayMs?: number;
}

const ATTEMPTS = 2;

export function createAuditService(
  log: AuditLogRepository,
  options: AuditServiceOptions = {},
): AuditService {
  const report = options.report ?? logAuditFailure;
  const retryDelayMs = options.retryDelayMs ?? 100;

  async function attempt(
    write: () => Promise<void>,
    entry: OrganizationAuditEntry | PlatformAuditEntry,
  ): Promise<void> {
    let lastError: unknown;
    let attempts = 0;
    while (attempts < ATTEMPTS) {
      attempts += 1;
      try {
        await write();
        return;
      } catch (error) {
        lastError = error;
        // A validation failure is a bug, not a transient fault: retrying can't help.
        if (error instanceof AuditMetadataError) break;
        if (attempts < ATTEMPTS && retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    }
    const err = lastError instanceof Error ? lastError : new Error(String(lastError));
    const invalid = lastError instanceof AuditMetadataError;
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
      });
    } catch {
      // A broken reporter must not turn a committed action into a failed request.
    }
  }

  return {
    log,
    afterCommit: (scope, entry) => attempt(() => log.write(scope, entry), entry),
    afterCommitPlatform: (entry) => attempt(() => log.writePlatform(entry), entry),
  };
}
