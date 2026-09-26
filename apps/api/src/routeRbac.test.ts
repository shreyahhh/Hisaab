import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, testAuth, testDb } from './testApp.js';
import {
  addRealMember,
  cleanupRealMember,
  cleanupRealTenant,
  seedRealTenant,
  type RealTenant,
} from './testAuthTenant.js';

// Integration coverage for the RBAC matrix (auth-tenancy.md §2.4) that the cross-tenant harness
// doesn't exercise — it only proves foreign ids are denied, not that the *right* roles are allowed
// and the *wrong* ones are refused for a route each of them can otherwise reach.

const app = buildTestApp();
const cleanupQueue: Array<() => Promise<void>> = [];

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  while (cleanupQueue.length > 0) {
    const cleanup = cleanupQueue.pop()!;
    await cleanup();
  }
});

const TRUSTED_ORIGIN = 'http://localhost:5173'; // matches testApp.ts's buildTestApp trustedOrigin

// DELETE has no body, so no Content-Type to set — light-my-request already sets
// application/json for a plain-object `payload` on POST/PUT.
function cookieHeader(tenant: RealTenant) {
  return { cookie: tenant.cookie, origin: TRUSTED_ORIGIN };
}

describe('GET /v1/orgs/:id/stores — any role can read (reports.read)', () => {
  it('viewer can list stores', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'stores-owner');
    cleanupQueue.push(() => cleanupRealTenant(testDb, owner));
    const viewer = await addRealMember(testAuth, testDb, owner, 'stores-viewer', 'viewer');
    cleanupQueue.push(() => cleanupRealMember(testDb, viewer));

    const res = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${owner.organizationId}/stores`,
      headers: cookieHeader(viewer),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stores.map((s: { id: string }) => s.id)).toContain(owner.storeId);
  });
});

describe('GET /v1/orgs/:id/audit-log — audit.read (owner/admin only)', () => {
  it('owner can read the audit log', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'audit-owner');
    cleanupQueue.push(() => cleanupRealTenant(testDb, owner));

    const res = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${owner.organizationId}/audit-log`,
      headers: cookieHeader(owner),
    });
    expect(res.statusCode).toBe(200);
  });

  it('analyst and viewer are forbidden', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'audit-analyst-owner');
    cleanupQueue.push(() => cleanupRealTenant(testDb, owner));
    const analyst = await addRealMember(testAuth, testDb, owner, 'audit-analyst', 'analyst');
    cleanupQueue.push(() => cleanupRealMember(testDb, analyst));

    const res = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${owner.organizationId}/audit-log`,
      headers: cookieHeader(analyst),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /v1/orgs/:id/invites — team.manage (owner/admin), admins cannot invite owners', () => {
  it('owner can invite an admin', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'invite-owner');
    cleanupQueue.push(() => cleanupRealTenant(testDb, owner));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${owner.organizationId}/invites`,
      headers: cookieHeader(owner),
      payload: { email: 'invitee-a@example.invalid', role: 'admin' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('viewer cannot invite anyone', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'invite-viewer-owner');
    cleanupQueue.push(() => cleanupRealTenant(testDb, owner));
    const viewer = await addRealMember(testAuth, testDb, owner, 'invite-viewer', 'viewer');
    cleanupQueue.push(() => cleanupRealMember(testDb, viewer));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${owner.organizationId}/invites`,
      headers: cookieHeader(viewer),
      payload: { email: 'invitee-b@example.invalid', role: 'viewer' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin cannot invite an owner', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'invite-admin-owner');
    cleanupQueue.push(() => cleanupRealTenant(testDb, owner));
    const admin = await addRealMember(testAuth, testDb, owner, 'invite-admin', 'admin');
    cleanupQueue.push(() => cleanupRealMember(testDb, admin));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${owner.organizationId}/invites`,
      headers: cookieHeader(admin),
      payload: { email: 'invitee-c@example.invalid', role: 'owner' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin CAN invite another admin (same rank, not above it)', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'invite-admin-peer-owner');
    cleanupQueue.push(() => cleanupRealTenant(testDb, owner));
    const admin = await addRealMember(testAuth, testDb, owner, 'invite-admin-peer', 'admin');
    cleanupQueue.push(() => cleanupRealMember(testDb, admin));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${owner.organizationId}/invites`,
      headers: cookieHeader(admin),
      payload: { email: 'invitee-peer-admin@example.invalid', role: 'admin' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('an analyst is rejected before the role ceiling even applies (no team.manage)', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'invite-analyst-owner');
    cleanupQueue.push(() => cleanupRealTenant(testDb, owner));
    const analyst = await addRealMember(testAuth, testDb, owner, 'invite-analyst', 'analyst');
    cleanupQueue.push(() => cleanupRealMember(testDb, analyst));

    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${owner.organizationId}/invites`,
      headers: cookieHeader(analyst),
      payload: { email: 'invitee-d@example.invalid', role: 'viewer' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('PUT /v1/orgs/:id/members/:userId — admins manage analyst/viewer only, never owner/admin', () => {
  it('admin can promote a viewer to analyst', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'role-owner-1');
    cleanupQueue.push(() => cleanupRealTenant(testDb, owner));
    const admin = await addRealMember(testAuth, testDb, owner, 'role-admin-1', 'admin');
    cleanupQueue.push(() => cleanupRealMember(testDb, admin));
    const viewer = await addRealMember(testAuth, testDb, owner, 'role-viewer-1', 'viewer');
    cleanupQueue.push(() => cleanupRealMember(testDb, viewer));

    const res = await app.inject({
      method: 'PUT',
      url: `/v1/orgs/${owner.organizationId}/members/${viewer.userId}`,
      headers: cookieHeader(admin),
      payload: { role: 'analyst' },
    });
    expect(res.statusCode).toBe(200);
  });

  it("admin cannot promote a viewer to owner (role ceiling, via Better Auth's own creatorRole guard)", async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'role-owner-ceiling');
    cleanupQueue.push(() => cleanupRealTenant(testDb, owner));
    const admin = await addRealMember(testAuth, testDb, owner, 'role-admin-ceiling', 'admin');
    cleanupQueue.push(() => cleanupRealMember(testDb, admin));
    const viewer = await addRealMember(testAuth, testDb, owner, 'role-viewer-ceiling', 'viewer');
    cleanupQueue.push(() => cleanupRealMember(testDb, viewer));

    const res = await app.inject({
      method: 'PUT',
      url: `/v1/orgs/${owner.organizationId}/members/${viewer.userId}`,
      headers: cookieHeader(admin),
      payload: { role: 'owner' },
    });
    expect(res.statusCode).toBe(403);
  });

  it("admin cannot change another admin's role", async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'role-owner-2');
    cleanupQueue.push(() => cleanupRealTenant(testDb, owner));
    const admin1 = await addRealMember(testAuth, testDb, owner, 'role-admin-2a', 'admin');
    cleanupQueue.push(() => cleanupRealMember(testDb, admin1));
    const admin2 = await addRealMember(testAuth, testDb, owner, 'role-admin-2b', 'admin');
    cleanupQueue.push(() => cleanupRealMember(testDb, admin2));

    const res = await app.inject({
      method: 'PUT',
      url: `/v1/orgs/${owner.organizationId}/members/${admin2.userId}`,
      headers: cookieHeader(admin1),
      payload: { role: 'viewer' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('the sole owner cannot demote themselves (409 last_owner)', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'role-owner-3');
    cleanupQueue.push(() => cleanupRealTenant(testDb, owner));

    const res = await app.inject({
      method: 'PUT',
      url: `/v1/orgs/${owner.organizationId}/members/${owner.userId}`,
      headers: cookieHeader(owner),
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'last_owner' });
  });
});

describe('DELETE /v1/orgs/:id/members/:userId — team.manage, or removing yourself', () => {
  it('a viewer can remove themselves', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'remove-owner-1');
    cleanupQueue.push(() => cleanupRealTenant(testDb, owner));
    const viewer = await addRealMember(testAuth, testDb, owner, 'remove-viewer-1', 'viewer');
    cleanupQueue.push(() => cleanupRealMember(testDb, viewer));

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${owner.organizationId}/members/${viewer.userId}`,
      headers: cookieHeader(viewer),
    });
    expect(res.statusCode).toBe(200);
  });

  it('a viewer cannot remove another member', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'remove-owner-2');
    cleanupQueue.push(() => cleanupRealTenant(testDb, owner));
    const viewer = await addRealMember(testAuth, testDb, owner, 'remove-viewer-2', 'viewer');
    cleanupQueue.push(() => cleanupRealMember(testDb, viewer));
    const analyst = await addRealMember(testAuth, testDb, owner, 'remove-analyst-2', 'analyst');
    cleanupQueue.push(() => cleanupRealMember(testDb, analyst));

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${owner.organizationId}/members/${analyst.userId}`,
      headers: cookieHeader(viewer),
    });
    expect(res.statusCode).toBe(403);
  });

  it('the sole owner cannot remove themselves (409 last_owner)', async () => {
    const owner = await seedRealTenant(testAuth, testDb, 'remove-owner-3');
    cleanupQueue.push(() => cleanupRealTenant(testDb, owner));

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${owner.organizationId}/members/${owner.userId}`,
      headers: cookieHeader(owner),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'last_owner' });
  });
});
