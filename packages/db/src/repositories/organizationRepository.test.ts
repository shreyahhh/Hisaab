import { eq } from 'drizzle-orm';
import type { SystemScope } from '@truepath/shared';
import { TenantScopeViolationError } from '@truepath/shared';
import { describe, expect, it } from 'vitest';
import { createOrganizationRepository } from './organizationRepository.js';
import { SystemScopeRequiredError } from './suppressionRebuildRepository.js';
import { organizations } from '../schema/index.js';
import { cleanupTestTenant, db, seedTestTenant } from '../testing.js';

// Issue #84 (auth-tenancy.md §4.6 steps 4-5): listReadyForErasure/listOverdue/markDeleted, the
// methods the org-deletion scheduler uses. requestDeletion/cancelDeletion already have end-to-end
// coverage at the route level (apps/api/src/routes/orgDeletion.test.ts).

const systemScope = (): SystemScope => ({
  kind: 'system',
  reason: 'org_deletion',
  auditId: 'test',
});

const NOW = new Date('2026-10-08T10:00:00.000Z');

async function setPendingDeletion(organizationId: string, scheduledAt: Date, dueBy: Date) {
  await db
    .update(organizations)
    .set({
      status: 'pending_deletion',
      metadata: {
        deletion_scheduled_at: scheduledAt.toISOString(),
        deletion_due_by: dueBy.toISOString(),
      },
    })
    .where(eq(organizations.id, organizationId));
}

describe('OrganizationRepository — listReadyForErasure/listOverdue (issue #84)', () => {
  it('lists an org whose grace period has elapsed, not one still within it', async () => {
    const past = await seedTestTenant('org-ready-past');
    const future = await seedTestTenant('org-ready-future');
    try {
      await setPendingDeletion(
        past.organizationId,
        new Date(NOW.getTime() - 1000),
        new Date(NOW.getTime() + 29 * 86_400_000),
      );
      await setPendingDeletion(
        future.organizationId,
        new Date(NOW.getTime() + 1000),
        new Date(NOW.getTime() + 30 * 86_400_000),
      );

      const repo = createOrganizationRepository(db);
      const ready = await repo.listReadyForErasure(systemScope(), NOW);
      const ids = ready.map((o) => o.id);
      expect(ids).toContain(past.organizationId);
      expect(ids).not.toContain(future.organizationId);
    } finally {
      await cleanupTestTenant(past);
      await cleanupTestTenant(future);
    }
  });

  it('an active org (never requested deletion) never appears', async () => {
    const active = await seedTestTenant('org-ready-active');
    try {
      const repo = createOrganizationRepository(db);
      const ready = await repo.listReadyForErasure(systemScope(), NOW);
      expect(ready.map((o) => o.id)).not.toContain(active.organizationId);
    } finally {
      await cleanupTestTenant(active);
    }
  });

  it('listOverdue lists an org past deletion_due_by, not one still within it', async () => {
    const overdue = await seedTestTenant('org-overdue-past');
    const onTime = await seedTestTenant('org-overdue-future');
    try {
      await setPendingDeletion(
        overdue.organizationId,
        new Date(NOW.getTime() - 31 * 86_400_000),
        new Date(NOW.getTime() - 1000),
      );
      await setPendingDeletion(
        onTime.organizationId,
        new Date(NOW.getTime() - 1000),
        new Date(NOW.getTime() + 1000),
      );

      const repo = createOrganizationRepository(db);
      const result = await repo.listOverdue(systemScope(), NOW);
      const ids = result.map((o) => o.id);
      expect(ids).toContain(overdue.organizationId);
      expect(ids).not.toContain(onTime.organizationId);
    } finally {
      await cleanupTestTenant(overdue);
      await cleanupTestTenant(onTime);
    }
  });

  it('requires a SystemScope', async () => {
    const tenant = await seedTestTenant('org-ready-scope');
    try {
      const repo = createOrganizationRepository(db);
      const tenantScope = {
        kind: 'tenant' as const,
        userId: tenant.userId,
        organizationId: tenant.organizationId,
        role: 'owner' as const,
        storeIds: new Set([tenant.storeId]),
      };
      await expect(repo.listReadyForErasure(tenantScope, NOW)).rejects.toThrow(
        SystemScopeRequiredError,
      );
      await expect(repo.listOverdue(tenantScope, NOW)).rejects.toThrow(SystemScopeRequiredError);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });
});

describe('OrganizationRepository.markDeleted (issue #84)', () => {
  it('tombstones the org once, idempotently, clearing metadata and renaming it', async () => {
    const tenant = await seedTestTenant('org-mark-deleted');
    try {
      await setPendingDeletion(
        tenant.organizationId,
        new Date(NOW.getTime() - 1000),
        new Date(NOW.getTime() + 1000),
      );
      const repo = createOrganizationRepository(db);
      const first = await repo.markDeleted(systemScope(), tenant.organizationId);
      expect(first).toMatchObject({
        status: 'deleted',
        name: `deleted-${tenant.organizationId}`,
        metadata: {},
      });

      const retry = await repo.markDeleted(systemScope(), tenant.organizationId);
      expect(retry).toBeNull();
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('denies markDeleted for an organization outside scope (SPEC §5.10 test 7)', async () => {
    const tenantA = await seedTestTenant('org-mark-deleted-a');
    const tenantB = await seedTestTenant('org-mark-deleted-b');
    try {
      const repo = createOrganizationRepository(db);
      const scopeA = {
        kind: 'tenant' as const,
        userId: tenantA.userId,
        organizationId: tenantA.organizationId,
        role: 'owner' as const,
        storeIds: new Set([tenantA.storeId]),
      };
      await expect(repo.markDeleted(scopeA, tenantB.organizationId)).rejects.toThrow(
        TenantScopeViolationError,
      );
    } finally {
      await cleanupTestTenant(tenantA);
      await cleanupTestTenant(tenantB);
    }
  });
});
