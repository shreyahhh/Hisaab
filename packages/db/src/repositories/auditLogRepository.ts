import { and, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import { assertOrganizationInScope, type AUDIT_ACTIONS, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { auditLog } from '../schema/index.js';

export type AuditLogRow = typeof auditLog.$inferSelect;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface RecordAuditEntryInput {
  readonly organizationId: string;
  readonly actorUserId?: string | null;
  readonly actorType: 'user' | 'system' | 'shopify_webhook';
  readonly action: AuditAction;
  readonly targetType: string;
  readonly targetId: string;
  /** ids and counts only — never identifiers or hashes (privacy-dpdp.md §2.1). */
  readonly metadata?: Record<string, unknown>;
}

export type RecordGlobalAuditEntryInput = Omit<RecordAuditEntryInput, 'organizationId'>;

export interface ListAuditLogOptions {
  readonly from?: Date;
  readonly to?: Date;
  readonly action?: AuditAction;
  readonly limit?: number;
}

export interface AuditLogRepository {
  /** Requires a Scope that covers `entry.organizationId` (ADR-0016). */
  record(scope: Scope, entry: RecordAuditEntryInput): Promise<void>;
  /**
   * For events with no owning organization at all (e.g. a login attempt, before any tenant
   * context exists) — `organization_id` is null, "only for platform-wide system events" (SPEC
   * §6.1). No Scope to check: there is no tenant boundary to enforce for a global event.
   */
  recordGlobal(entry: RecordGlobalAuditEntryInput): Promise<void>;
  listByOrganization(
    scope: Scope,
    organizationId: string,
    opts?: ListAuditLogOptions,
  ): Promise<AuditLogRow[]>;
}

function insertValues(
  entry: RecordAuditEntryInput | RecordGlobalAuditEntryInput,
  organizationId: string | null,
) {
  return {
    organizationId,
    actorUserId: entry.actorUserId ?? null,
    actorType: entry.actorType,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata ?? {},
  };
}

/** The only sanctioned way to read/write `audit_log` (ADR-0016, SPEC S-4). */
export function createAuditLogRepository(db: Db): AuditLogRepository {
  return {
    async record(scope, entry) {
      assertOrganizationInScope(scope, entry.organizationId);
      await db.insert(auditLog).values(insertValues(entry, entry.organizationId));
    },
    async recordGlobal(entry) {
      await db.insert(auditLog).values(insertValues(entry, null));
    },
    async listByOrganization(scope, organizationId, opts = {}) {
      assertOrganizationInScope(scope, organizationId);
      const conditions: SQL[] = [eq(auditLog.organizationId, organizationId)];
      if (opts.from) conditions.push(gte(auditLog.createdAt, opts.from));
      if (opts.to) conditions.push(lte(auditLog.createdAt, opts.to));
      if (opts.action) conditions.push(eq(auditLog.action, opts.action));
      return db
        .select()
        .from(auditLog)
        .where(and(...conditions))
        .orderBy(desc(auditLog.createdAt))
        .limit(opts.limit ?? 100);
    },
  };
}
