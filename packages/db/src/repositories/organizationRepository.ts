import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { assertOrganizationInScope, type Scope } from '@truepath/shared';
import { memberships, organizations, users } from '../schema/index.js';
import type { DbExecutor } from './auditLogRepository.js';
import { SystemScopeRequiredError } from './suppressionRebuildRepository.js';

export type OrganizationRow = typeof organizations.$inferSelect;

/**
 * `organizations` (auth-tenancy.md §4.6, issue #8). Better Auth's own organization CRUD covers
 * everything except deletion (`disableOrganizationDeletion: true` in `packages/auth/src/betterAuth.ts`
 * — ours is an audited, 7-day-grace flow, never Better Auth's immediate one), so this repository
 * exists only for that lifecycle.
 */
export interface OrganizationRepository {
  getById(scope: Scope, organizationId: string): Promise<OrganizationRow | null>;
  /**
   * `active` → `pending_deletion`, stamping `metadata.deletion_scheduled_at` (+7 days, the grace
   * period's end — also the earliest the erasure scheduler may run) and `metadata.deletion_due_by`
   * (+30 days, SPEC §5.7's completion deadline). Only from `active`: returns `null` (no-op) if the
   * organization is already `pending_deletion` or `deleted`, so a route can tell "started" from
   * "already in progress" without a separate read.
   */
  requestDeletion(
    scope: Scope,
    organizationId: string,
    options: { readonly now: Date },
  ): Promise<OrganizationRow | null>;
  /**
   * `pending_deletion` → `active`, clearing the deletion metadata keys. Only within the grace period
   * (`now` before the stored `deletion_scheduled_at`) — returns `null` if the organization isn't
   * `pending_deletion`, or the grace period has already elapsed.
   */
  cancelDeletion(
    scope: Scope,
    organizationId: string,
    options: { readonly now: Date },
  ): Promise<OrganizationRow | null>;
  /**
   * Issue #84 (auth-tenancy.md §4.6 step 4): orgs whose 7-day grace period has elapsed and are ready
   * for the erasure scheduler to run. `SystemScope`-only (this is a cross-organization scan, not a
   * `GET` for one org) — same `SystemScopeRequiredError` convention as
   * `suppressionRebuildRepository`/`webhookDeliveryRepository`/`metaWarmupSchedulingRepository`.
   */
  listReadyForErasure(scope: Scope, now: Date): Promise<OrganizationRow[]>;
  /**
   * Issue #84 (auth-tenancy.md §5 "Org deletion overdue"): orgs still `pending_deletion` past their
   * 30-day `deletion_due_by` — meant to be read *after* a scheduler run, so orgs it just finished
   * tombstoning no longer match. `SystemScope`-only, same reason as `listReadyForErasure`.
   */
  listOverdue(scope: Scope, now: Date): Promise<OrganizationRow[]>;
  /**
   * Issue #84 (auth-tenancy.md §4.6 step 5): the completion tombstone — `status='deleted'`, `name`
   * replaced by `deleted-<id>` (never reused, so it can't collide), `metadata` cleared (it held only
   * the deletion-lifecycle timestamps). Idempotent: returns `null` if already `deleted`. `audit_log`
   * and `dsr_requests` are untouched — neither holds shopper or org-identifying data beyond ids.
   */
  markDeleted(scope: Scope, organizationId: string): Promise<OrganizationRow | null>;
  /**
   * Issue #52 (event-pipeline.md §4.4): who the default-on-region auto-pause email goes to. Emails
   * only — never used to join against any shopper-identity hash.
   */
  listOwnerAndAdminEmails(scope: Scope, organizationId: string): Promise<string[]>;
}

/** The only sanctioned way to read/write `organizations`' deletion lifecycle (ADR-0016). */
export function createOrganizationRepository(db: DbExecutor): OrganizationRepository {
  return {
    async getById(scope, organizationId) {
      assertOrganizationInScope(scope, organizationId);
      const rows = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);
      return rows[0] ?? null;
    },

    async requestDeletion(scope, organizationId, options) {
      assertOrganizationInScope(scope, organizationId);
      const scheduledAt = new Date(options.now.getTime() + 7 * 86_400_000);
      const dueBy = new Date(options.now.getTime() + 30 * 86_400_000);
      const patch = {
        deletion_scheduled_at: scheduledAt.toISOString(),
        deletion_due_by: dueBy.toISOString(),
      };
      const [row] = await db
        .update(organizations)
        .set({
          status: 'pending_deletion',
          metadata: sql`coalesce(${organizations.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
        })
        .where(and(eq(organizations.id, organizationId), eq(organizations.status, 'active')))
        .returning();
      return row ?? null;
    },

    async cancelDeletion(scope, organizationId, options) {
      assertOrganizationInScope(scope, organizationId);
      const [row] = await db
        .update(organizations)
        .set({
          status: 'active',
          metadata: sql`(${organizations.metadata} - 'deletion_scheduled_at') - 'deletion_due_by'`,
        })
        .where(
          and(
            eq(organizations.id, organizationId),
            eq(organizations.status, 'pending_deletion'),
            sql`(${organizations.metadata}->>'deletion_scheduled_at')::timestamptz > ${options.now.toISOString()}::timestamptz`,
          ),
        )
        .returning();
      return row ?? null;
    },

    async listReadyForErasure(scope, now) {
      if (scope.kind !== 'system') throw new SystemScopeRequiredError();
      return db
        .select()
        .from(organizations)
        .where(
          and(
            eq(organizations.status, 'pending_deletion'),
            sql`(${organizations.metadata}->>'deletion_scheduled_at')::timestamptz <= ${now.toISOString()}::timestamptz`,
          ),
        );
    },

    async listOverdue(scope, now) {
      if (scope.kind !== 'system') throw new SystemScopeRequiredError();
      return db
        .select()
        .from(organizations)
        .where(
          and(
            eq(organizations.status, 'pending_deletion'),
            sql`(${organizations.metadata}->>'deletion_due_by')::timestamptz <= ${now.toISOString()}::timestamptz`,
          ),
        );
    },

    async markDeleted(scope, organizationId) {
      assertOrganizationInScope(scope, organizationId);
      const [row] = await db
        .update(organizations)
        .set({ status: 'deleted', name: `deleted-${organizationId}`, metadata: {} })
        .where(and(eq(organizations.id, organizationId), ne(organizations.status, 'deleted')))
        .returning();
      return row ?? null;
    },

    async listOwnerAndAdminEmails(scope, organizationId) {
      assertOrganizationInScope(scope, organizationId);
      const rows = await db
        .select({ email: users.email })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            inArray(memberships.role, ['owner', 'admin']),
          ),
        );
      return rows.map((r) => r.email);
    },
  };
}
