import {
  createAuditLogRepository,
  createOrgDeletionRepository,
  createOrganizationRepository,
  createStoreRepository,
  createSystemScope,
} from '@truepath/db';
import { eraseStoreData, type StoreErasureDataDeps } from './dsr/storeErasure.js';

// auth-tenancy.md §4.6 steps 4-5 (issue #84): the org-deletion scheduler. A single cross-tenant sweep,
// not a per-store job, so it runs under an audited SystemScope('org_deletion') rather than the
// `retention` BullMQ queue (DPDP per-tenant retention, not built yet) or a new canonical queue name
// (HLD §8 requires those signed off, not invented) — same reasoning as webhookDeliveryPrune.ts. It is
// invoked by `dev:erase-overdue-orgs` (apps/workers/src/devOrgDeletionScheduler.ts); wiring an actual
// nightly trigger (ops cron / systemd timer / a scheduled workflow with production DB access) is a
// deploy step this run may not take (CLAUDE.md: no cloud resource changes, no touching secrets).

export interface OrgDeletionSchedulerDeps extends StoreErasureDataDeps {
  readonly now?: () => Date;
  /** Counts and error names only — never an org/user/store id with a name attached. */
  readonly log?: (line: Record<string, unknown>) => void;
}

export interface OrgDeletionSchedulerResult {
  readonly organizationsErased: number;
  readonly organizationsFailed: number;
  readonly overdueCount: number;
}

export async function runOrgDeletionScheduler(
  deps: OrgDeletionSchedulerDeps,
): Promise<OrgDeletionSchedulerResult> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? (() => undefined);
  const scope = await createSystemScope(deps.db, 'org_deletion', {});

  const organizations = createOrganizationRepository(deps.db);
  const stores = createStoreRepository(deps.db);
  const orgDeletion = createOrgDeletionRepository(deps.db);
  const audit = createAuditLogRepository(deps.db);

  const ready = await organizations.listReadyForErasure(scope, now);
  let organizationsErased = 0;
  let organizationsFailed = 0;

  for (const org of ready) {
    try {
      const storeRows = await stores.listByOrganization(scope, org.id);
      for (const store of storeRows) {
        await eraseStoreData(deps, scope, store.id);
      }

      const members = await orgDeletion.eraseMembersAndInvites(scope, org.id);
      const tombstoned = await organizations.markDeleted(scope, org.id);
      if (!tombstoned) {
        // Already tombstoned by a concurrent/earlier run — not an error.
        log({ event: 'org_deletion_already_tombstoned', organization_id: org.id });
        continue;
      }

      await audit.write(scope, {
        organizationId: org.id,
        actorUserId: null,
        actorType: 'system',
        action: 'org_deleted',
        targetType: 'organization',
        targetId: org.id,
        metadata: { stores: storeRows.length },
      });

      log({
        event: 'org_deleted',
        organization_id: org.id,
        stores: storeRows.length,
        memberships_deleted: members.membershipsDeleted,
        invites_deleted: members.invitesDeleted,
        users_deleted: members.usersDeleted,
        users_skipped: members.usersSkipped,
      });
      organizationsErased += 1;
    } catch (error) {
      organizationsFailed += 1;
      log({
        event: 'org_deletion_failed',
        organization_id: org.id,
        error_name: error instanceof Error ? error.name : 'unknown_error',
      });
    }
  }

  // Run after the sweep: orgs this run just tombstoned are no longer `pending_deletion` and drop out.
  const overdue = await organizations.listOverdue(scope, now);
  for (const org of overdue) {
    log({ event: 'org_deletion_overdue', organization_id: org.id });
  }

  return { organizationsErased, organizationsFailed, overdueCount: overdue.length };
}
