import type { SystemReason, SystemScope } from '@truepath/shared';
import type { Db } from './client.js';
import { auditLog } from './schema/index.js';

export interface CreateSystemScopeOptions {
  /** Set for a system action scoped to one organization (e.g. org deletion); omit for platform-wide jobs (retention, suppression rebuild). */
  readonly organizationId?: string | null;
  readonly metadata?: Record<string, unknown>;
}

/**
 * The only constructor for a SystemScope (ADR-0016, auth-tenancy.md §4.4): writes the
 * `system_scope_used` audit_log entry immediately and returns a scope carrying that row's id.
 * There is no other way to obtain a SystemScope — it can never exist without an audit trail of
 * why it was created.
 */
export async function createSystemScope(
  db: Db,
  reason: SystemReason,
  options: CreateSystemScopeOptions = {},
): Promise<SystemScope> {
  const [row] = await db
    .insert(auditLog)
    .values({
      organizationId: options.organizationId ?? null,
      actorUserId: null,
      actorType: 'system',
      action: 'system_scope_used',
      targetType: 'system_scope',
      targetId: reason,
      metadata: options.metadata ?? {},
    })
    .returning({ id: auditLog.id });
  if (!row) {
    throw new Error('createSystemScope: audit_log insert did not return an id');
  }
  return { kind: 'system', reason, auditId: row.id };
}
