import { and, eq, inArray, lt } from 'drizzle-orm';
import {
  assertOrganizationInScope,
  type OrganizationAuditEntry,
  type PlatformAuditEntry,
  type Scope,
} from '@truepath/shared';
import { AuditMetadataError } from '@truepath/privacy';
import type { Db } from '../client.js';
import { auditOutbox } from '../schema/index.js';
import { insertAuditRow } from './auditLogRepository.js';
import { SystemScopeRequiredError } from './suppressionRebuildRepository.js';

// ADR-0028 (supersedes ADR-0021), issue #13: the transactional outbox behind every Better Auth
// action's audit row. `apps/api/src/audit.ts` enqueues the already-known entry immediately after
// Better Auth's own commit, then attempts `complete` (the normal path); if both attempts fail, the
// row stays `pending` for the sweeper (apps/workers) to finish later.

export type AuditOutboxRow = typeof auditOutbox.$inferSelect;

export interface AuditOutboxRepository {
  /** Durably records intent for an organization-scoped entry. Returns the outbox row's id. */
  enqueue(scope: Scope, entry: OrganizationAuditEntry): Promise<string>;
  /** Same, for a platform-wide entry (no organization to scope the write to). */
  enqueuePlatform(entry: PlatformAuditEntry): Promise<string>;
  /**
   * Locks the row; if it is still `pending`, inserts into `audit_log` (through the one validated
   * path, `insertAuditRow`) and marks it `done`, atomically. A no-op if another writer (the original
   * request, or a later sweep) already completed or abandoned it — returns the existing
   * `audit_log` id (`null` if it was abandoned, or the row doesn't exist). A metadata-validation
   * failure marks the row `abandoned` (a bug, not a transient fault — retrying it forever would only
   * grow the sweep's pending set) and rethrows; any other error leaves it `pending` for a later retry.
   */
  complete(outboxId: string): Promise<string | null>;
  /**
   * Pending rows older than `olderThan`, oldest first, for the sweeper. Cross-tenant: requires
   * SystemScope. `outboxIds`, if given, restricts the scan to those ids — a targeted sweep, or a
   * test isolating itself from other rows in the shared table (same pattern as
   * `WebhookDeliveryRepository.pruneOlderThan`'s `storeIds`); omitted, it scans every row.
   */
  listPending(
    scope: Scope,
    olderThan: Date,
    options?: { readonly limit?: number; readonly outboxIds?: readonly string[] },
  ): Promise<readonly { readonly id: string }[]>;
  /**
   * Deletes `done`/`abandoned` rows older than `olderThan` (housekeeping). Requires SystemScope.
   * `outboxIds` scopes the sweep the same way as `listPending`.
   */
  deleteFinished(
    scope: Scope,
    olderThan: Date,
    outboxIds?: readonly string[],
  ): Promise<{ readonly deleted: number }>;
}

export function createAuditOutboxRepository(db: Db): AuditOutboxRepository {
  async function insertOutboxRow(
    organizationId: string | null,
    entry: OrganizationAuditEntry | PlatformAuditEntry,
  ): Promise<string> {
    const [row] = await db
      .insert(auditOutbox)
      .values({ organizationId, entry })
      .returning({ id: auditOutbox.id });
    if (!row) throw new Error('auditOutbox.enqueue: insert did not return an id');
    return row.id;
  }

  return {
    // Declared `async` so the scope check's synchronous throw becomes a rejected promise, not an
    // exception thrown out of the call before the caller ever gets a promise to await/catch.
    async enqueue(scope, entry) {
      assertOrganizationInScope(scope, entry.organizationId);
      return insertOutboxRow(entry.organizationId, entry);
    },

    async enqueuePlatform(entry) {
      return insertOutboxRow(null, entry);
    },

    async complete(outboxId) {
      try {
        return await db.transaction(async (tx) => {
          const [row] = await tx
            .select()
            .from(auditOutbox)
            .where(eq(auditOutbox.id, outboxId))
            .for('update');
          if (!row) return null;
          if (row.status !== 'pending') return row.auditLogId;

          const entry = row.entry as OrganizationAuditEntry | PlatformAuditEntry;
          const auditLogId = await insertAuditRow(tx, {
            organizationId: row.organizationId,
            action: entry.action,
            actorUserId: entry.actorUserId ?? null,
            actorType: entry.actorType,
            targetType: entry.targetType,
            targetId: entry.targetId,
            metadata: 'metadata' in entry ? entry.metadata : undefined,
          });
          await tx
            .update(auditOutbox)
            .set({ status: 'done', auditLogId })
            .where(eq(auditOutbox.id, outboxId));
          return auditLogId;
        });
      } catch (error) {
        if (error instanceof AuditMetadataError) {
          // The transaction above already rolled back (the row is still `pending`) — this is a
          // fresh statement.
          await db
            .update(auditOutbox)
            .set({ status: 'abandoned' })
            .where(eq(auditOutbox.id, outboxId));
        }
        throw error;
      }
    },

    async listPending(scope, olderThan, options = {}) {
      if (scope.kind !== 'system') throw new SystemScopeRequiredError();
      const condition =
        options.outboxIds && options.outboxIds.length > 0
          ? and(
              eq(auditOutbox.status, 'pending'),
              lt(auditOutbox.createdAt, olderThan),
              inArray(auditOutbox.id, options.outboxIds),
            )
          : and(eq(auditOutbox.status, 'pending'), lt(auditOutbox.createdAt, olderThan));
      return db
        .select({ id: auditOutbox.id })
        .from(auditOutbox)
        .where(condition)
        .orderBy(auditOutbox.createdAt)
        .limit(options.limit ?? 100);
    },

    async deleteFinished(scope, olderThan, outboxIds) {
      if (scope.kind !== 'system') throw new SystemScopeRequiredError();
      const condition =
        outboxIds && outboxIds.length > 0
          ? and(
              inArray(auditOutbox.status, ['done', 'abandoned']),
              lt(auditOutbox.createdAt, olderThan),
              inArray(auditOutbox.id, outboxIds),
            )
          : and(
              inArray(auditOutbox.status, ['done', 'abandoned']),
              lt(auditOutbox.createdAt, olderThan),
            );
      const deleted = await db
        .delete(auditOutbox)
        .where(condition)
        .returning({ id: auditOutbox.id });
      return { deleted: deleted.length };
    },
  };
}
