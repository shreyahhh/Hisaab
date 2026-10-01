import { eq } from 'drizzle-orm';
import type { SystemScope } from '@truepath/shared';
import { describe, expect, it } from 'vitest';
import { createOrgDeletionRepository } from './orgDeletionRepository.js';
import { invites, memberships, organizations, users } from '../schema/index.js';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '../testing.js';

// Issue #84: the membership/invite/orphaned-user half of org deletion.

const systemScope = (): SystemScope => ({
  kind: 'system',
  reason: 'org_deletion',
  auditId: 'test',
});

async function addMembership(organizationId: string, userId: string, role: TestTenant['role']) {
  await db.insert(memberships).values({ organizationId, userId, role });
}

describe('OrgDeletionRepository.eraseMembersAndInvites (issue #84)', () => {
  it('deletes memberships/invites and the orphaned user (no membership left anywhere)', async () => {
    const tenant = await seedTestTenant('org-erase-orphan');
    try {
      // An invite from this org, plus the pending-deletion org itself.
      await db.insert(invites).values({
        organizationId: tenant.organizationId,
        email: 'invitee@example.invalid',
        role: 'viewer',
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
        inviterId: tenant.userId,
      });

      const repo = createOrgDeletionRepository(db);
      const result = await repo.eraseMembersAndInvites(systemScope(), tenant.organizationId);
      expect(result).toEqual({
        membershipsDeleted: 1,
        invitesDeleted: 1,
        usersDeleted: 1,
        usersSkipped: 0,
      });

      expect(
        await db
          .select()
          .from(memberships)
          .where(eq(memberships.organizationId, tenant.organizationId)),
      ).toEqual([]);
      expect(
        await db.select().from(invites).where(eq(invites.organizationId, tenant.organizationId)),
      ).toEqual([]);
      expect(await db.select().from(users).where(eq(users.id, tenant.userId))).toEqual([]);
    } finally {
      // The user and its membership/invite are already gone; only the org row remains.
      await db.delete(organizations).where(eq(organizations.id, tenant.organizationId));
    }
  });

  it('keeps a user who still belongs to another organization', async () => {
    const tenant = await seedTestTenant('org-erase-keep-user-a');
    const otherOrg = await seedTestTenant('org-erase-keep-user-b');
    try {
      await addMembership(otherOrg.organizationId, tenant.userId, 'viewer');

      const repo = createOrgDeletionRepository(db);
      const result = await repo.eraseMembersAndInvites(systemScope(), tenant.organizationId);
      expect(result).toMatchObject({ membershipsDeleted: 1, usersDeleted: 0 });

      expect(await db.select().from(users).where(eq(users.id, tenant.userId))).toHaveLength(1);
      expect(
        await db.select().from(memberships).where(eq(memberships.userId, tenant.userId)),
      ).toHaveLength(1); // the otherOrg membership survives
    } finally {
      await cleanupTestTenant(otherOrg);
      await db.delete(memberships).where(eq(memberships.userId, tenant.userId));
      await db.delete(organizations).where(eq(organizations.id, tenant.organizationId));
      await db.delete(users).where(eq(users.id, tenant.userId));
    }
  });

  it('skips (does not throw for) a user still referenced as inviterId on a different organization', async () => {
    const tenant = await seedTestTenant('org-erase-skip-inviter-a');
    const otherOrg = await seedTestTenant('org-erase-skip-inviter-b');
    try {
      // tenant.userId invited someone into otherOrg, then left otherOrg (membership removed), but the
      // invite row (and its FK) is still there.
      await db.insert(invites).values({
        organizationId: otherOrg.organizationId,
        email: 'someone@example.invalid',
        role: 'viewer',
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
        inviterId: tenant.userId,
      });

      const repo = createOrgDeletionRepository(db);
      const result = await repo.eraseMembersAndInvites(systemScope(), tenant.organizationId);
      expect(result).toMatchObject({ membershipsDeleted: 1, usersDeleted: 0, usersSkipped: 1 });

      // The user survives — the FK violation was caught, not propagated.
      expect(await db.select().from(users).where(eq(users.id, tenant.userId))).toHaveLength(1);
    } finally {
      await db.delete(invites).where(eq(invites.organizationId, otherOrg.organizationId));
      await cleanupTestTenant(otherOrg);
      await db.delete(organizations).where(eq(organizations.id, tenant.organizationId));
      await db.delete(users).where(eq(users.id, tenant.userId));
    }
  });

  it('is idempotent: a second call on the same organization returns all-zero counts', async () => {
    const tenant = await seedTestTenant('org-erase-idempotent');
    try {
      const repo = createOrgDeletionRepository(db);
      await repo.eraseMembersAndInvites(systemScope(), tenant.organizationId);
      const second = await repo.eraseMembersAndInvites(systemScope(), tenant.organizationId);
      expect(second).toEqual({
        membershipsDeleted: 0,
        invitesDeleted: 0,
        usersDeleted: 0,
        usersSkipped: 0,
      });
    } finally {
      await db.delete(organizations).where(eq(organizations.id, tenant.organizationId));
    }
  });
});
