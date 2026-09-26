import { and, eq } from 'drizzle-orm';
import { schema } from '@truepath/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, testAuth, testDb } from './testApp.js';
import {
  addRealMember,
  cleanupRealMember,
  cleanupRealTenant,
  cleanupRealUser,
  seedRealTenant,
  seedRealUser,
  type RealTenant,
  type RealUser,
} from './testAuthTenant.js';

// POST /v1/invites/:token/accept. The :token is an invitation id (a capability), so the harness
// exempts it from foreign-id substitution (crossTenant.ts) — these tests cover what actually
// guards it: the recipient's email, and the inviter's standing *at acceptance time*.

const app = buildTestApp();
const cleanupQueue: Array<() => Promise<void>> = [];
const ORIGIN = 'http://localhost:5173';

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  while (cleanupQueue.length > 0) await cleanupQueue.pop()!();
});

function asUser(user: { cookie: string }) {
  return { cookie: user.cookie, origin: ORIGIN };
}

async function invite(from: RealTenant, orgId: string, email: string, role: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/orgs/${orgId}/invites`,
    headers: asUser(from),
    payload: { email, role },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

function accept(user: { cookie: string }, invitationId: string) {
  return app.inject({
    method: 'POST',
    url: `/v1/invites/${invitationId}/accept`,
    headers: asUser(user),
    payload: {},
  });
}

async function membershipOf(userId: string, orgId: string) {
  const [row] = await testDb
    .select()
    .from(schema.memberships)
    .where(
      and(eq(schema.memberships.userId, userId), eq(schema.memberships.organizationId, orgId)),
    );
  return row;
}

async function setup() {
  const owner = await seedRealTenant(testAuth, testDb, 'inv-owner');
  cleanupQueue.push(() => cleanupRealTenant(testDb, owner));
  return owner;
}

async function recipient(email: string): Promise<RealUser> {
  const user = await seedRealUser(testAuth, testDb, 'inv-recipient', email);
  cleanupQueue.push(() => cleanupRealUser(testDb, user));
  return user;
}

describe('invite acceptance — recipient email', () => {
  it('a logged-in user with a different email cannot accept it; the real recipient still can', async () => {
    const owner = await setup();
    const invitee = `invitee-${Date.now()}@example.invalid`;
    const invitationId = await invite(owner, owner.organizationId, invitee, 'analyst');

    const stranger = await seedRealUser(testAuth, testDb, 'inv-stranger');
    cleanupQueue.push(() => cleanupRealUser(testDb, stranger));
    const rejected = await accept(stranger, invitationId);
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toEqual({ error: 'invite_email_mismatch' });
    expect(await membershipOf(stranger.userId, owner.organizationId)).toBeUndefined();

    // The failed attempt must not have burned the invitation.
    const real = await recipient(invitee);
    const ok = await accept(real, invitationId);
    expect(ok.statusCode).toBe(200);
    expect((await membershipOf(real.userId, owner.organizationId))?.role).toBe('analyst');
  });

  it('is case-insensitive on the recipient address', async () => {
    const owner = await setup();
    const invitee = `MixedCase-${Date.now()}@example.invalid`;
    const invitationId = await invite(owner, owner.organizationId, invitee, 'viewer');
    const real = await recipient(invitee.toLowerCase());
    expect((await accept(real, invitationId)).statusCode).toBe(200);
  });
});

describe("invite acceptance — the inviter's standing is re-checked at acceptance", () => {
  it('accepts when the inviter is still an admin (control case)', async () => {
    const owner = await setup();
    const admin = await addRealMember(testAuth, testDb, owner, 'inv-admin', 'admin');
    cleanupQueue.push(() => cleanupRealMember(testDb, admin));
    const email = `ok-${Date.now()}@example.invalid`;
    const invitationId = await invite(admin, owner.organizationId, email, 'viewer');

    const real = await recipient(email);
    expect((await accept(real, invitationId)).statusCode).toBe(200);
    expect((await membershipOf(real.userId, owner.organizationId))?.role).toBe('viewer');
  });

  it('rejects when the inviter was demoted below the invited role after inviting', async () => {
    const owner = await setup();
    const admin = await addRealMember(testAuth, testDb, owner, 'inv-demoted', 'admin');
    cleanupQueue.push(() => cleanupRealMember(testDb, admin));
    const email = `demoted-${Date.now()}@example.invalid`;
    // Admin inviting admin is same-rank, so allowed at creation time…
    const invitationId = await invite(admin, owner.organizationId, email, 'admin');

    // …then the owner demotes the inviter to viewer. The pending invite must not mint an admin.
    const demote = await app.inject({
      method: 'PUT',
      url: `/v1/orgs/${owner.organizationId}/members/${admin.userId}`,
      headers: asUser(owner),
      payload: { role: 'viewer' },
    });
    expect(demote.statusCode).toBe(200);

    const real = await recipient(email);
    const res = await accept(real, invitationId);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'invite_no_longer_valid' });
    expect(await membershipOf(real.userId, owner.organizationId)).toBeUndefined();
  });

  it('rejects when the inviter lost team.manage, even for a role at or below their new rank', async () => {
    const owner = await setup();
    const admin = await addRealMember(testAuth, testDb, owner, 'inv-analyst-now', 'admin');
    cleanupQueue.push(() => cleanupRealMember(testDb, admin));
    const email = `viewer-${Date.now()}@example.invalid`;
    const invitationId = await invite(admin, owner.organizationId, email, 'viewer');

    await app.inject({
      method: 'PUT',
      url: `/v1/orgs/${owner.organizationId}/members/${admin.userId}`,
      headers: asUser(owner),
      payload: { role: 'analyst' },
    });

    const real = await recipient(email);
    expect((await accept(real, invitationId)).statusCode).toBe(403);
    expect(await membershipOf(real.userId, owner.organizationId)).toBeUndefined();
  });

  it('rejects when the inviter has since been removed from the organization', async () => {
    const owner = await setup();
    const admin = await addRealMember(testAuth, testDb, owner, 'inv-removed', 'admin');
    cleanupQueue.push(() => cleanupRealMember(testDb, admin));
    const email = `removed-${Date.now()}@example.invalid`;
    const invitationId = await invite(admin, owner.organizationId, email, 'analyst');

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${owner.organizationId}/members/${admin.userId}`,
      headers: asUser(owner),
    });
    expect(removed.statusCode).toBe(200);

    const real = await recipient(email);
    const res = await accept(real, invitationId);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'invite_no_longer_valid' });
  });
});
