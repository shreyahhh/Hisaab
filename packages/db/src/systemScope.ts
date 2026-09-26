import type { SystemReason, SystemScope } from '@truepath/shared';
import { insertAuditRow, type DbExecutor } from './repositories/auditLogRepository.js';

export interface CreateSystemScopeOptions {
  /** Set for a system action scoped to one organization (e.g. org deletion); omit for platform-wide jobs (retention, suppression rebuild). */
  readonly organizationId?: string | null;
  /** Flat scalars only (the `system_scope_used` schema in @truepath/shared): ids, enums, counts. */
  readonly metadata?: Record<string, string | number | boolean>;
}

/**
 * The only constructor for a SystemScope (ADR-0016, auth-tenancy.md §4.4): writes the
 * `system_scope_used` audit_log entry immediately and returns a scope carrying that row's id.
 * There is no other way to obtain a SystemScope — it can never exist without an audit trail of
 * why it was created. The row goes through the same writer, and metadata check, as every other.
 */
export async function createSystemScope(
  db: DbExecutor,
  reason: SystemReason,
  options: CreateSystemScopeOptions = {},
): Promise<SystemScope> {
  const auditId = await insertAuditRow(db, {
    organizationId: options.organizationId ?? null,
    actorUserId: null,
    actorType: 'system',
    action: 'system_scope_used',
    targetType: 'system_scope',
    targetId: reason,
    metadata: options.metadata ?? {},
  });
  return { kind: 'system', reason, auditId };
}
