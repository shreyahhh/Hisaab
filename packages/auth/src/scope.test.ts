import { cleanupTestTenant, db, seedTestTenant } from '@truepath/db/testing';
import { describe, expect, it } from 'vitest';
import { resolveMembership, resolveMembershipsForUser } from './scope.js';

describe('resolveMembership (auth-tenancy.md §4.3 step 2a)', () => {
  it('resolves the id and role for a real membership', async () => {
    const tenant = await seedTestTenant('scope', 'admin');
    try {
      const membership = await resolveMembership(db, tenant.userId, tenant.organizationId);
      expect(membership).toEqual({ id: tenant.membershipId, role: 'admin' });
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('returns null when the user has no membership in that organization', async () => {
    const tenantA = await seedTestTenant('scope-a');
    const tenantB = await seedTestTenant('scope-b');
    try {
      const membership = await resolveMembership(db, tenantA.userId, tenantB.organizationId);
      expect(membership).toBeNull();
    } finally {
      await cleanupTestTenant(tenantA);
      await cleanupTestTenant(tenantB);
    }
  });
});

describe('resolveMembershipsForUser (GET /v1/me)', () => {
  it('lists every organization the user belongs to', async () => {
    const tenant = await seedTestTenant('scope-list', 'viewer');
    try {
      const memberships = await resolveMembershipsForUser(db, tenant.userId);
      expect(memberships).toEqual([{ organizationId: tenant.organizationId, role: 'viewer' }]);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('returns an empty array for a user with no memberships', async () => {
    const memberships = await resolveMembershipsForUser(db, '00000000-0000-0000-0000-000000000000');
    expect(memberships).toEqual([]);
  });
});
