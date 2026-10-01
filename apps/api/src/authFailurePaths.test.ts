import { randomUUID } from 'node:crypto';
import { APIError } from 'better-auth/api';
import { schema } from '@truepath/db';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, testAuth, testDb } from './testApp.js';
import {
  addRealMember,
  cleanupRealMember,
  cleanupRealTenant,
  cleanupRealUser,
  seedRealTenant,
  seedRealUser,
  type RealTenant,
} from './testAuthTenant.js';

// One failure-path test per `auth.api.*` call site in apps/api: what the HTTP client sees, and
// which audit rows exist afterwards. Better Auth reports failure two ways — it throws an APIError,
// or (with `asResponse: true`) it returns a 4xx Response — and every site must treat both as a
// failure: same status, same `{ error: <code> }` body, and no success audit row. Where a real
// failure is hard to provoke (a sign-out that fails after a valid session), the call is stubbed to
// fail in the way Better Auth does.

const app = buildTestApp();
const ORIGIN = 'http://localhost:5173';
const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  await app.close();
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanups.pop()!();
});

const asHeaders = (t: { cookie: string }) => ({ cookie: t.cookie, origin: ORIGIN });

// issue #11: a time-window query (`createdAt >= since`) can pick up a *different* test's row —
// one already sitting in this worker's shared audit_log table from earlier in the file (this file
// never cleans audit_log up) — if the two land within the same tick, which a loaded, truly
// parallel suite makes measurably more likely than the old fully-serial one. An existence-based
// snapshot/diff is immune to that: it only ever reports rows that did not exist before this
// specific call, regardless of what else is already in the table or when it was written.
async function auditSnapshot(): Promise<ReadonlySet<string>> {
  const rows = await testDb.select({ id: schema.auditLog.id }).from(schema.auditLog);
  return new Set(rows.map((r) => r.id));
}

async function newAuditActionsSince(before: ReadonlySet<string>): Promise<string[]> {
  const rows = await testDb.select().from(schema.auditLog);
  return rows.filter((r) => !before.has(r.id)).map((r) => r.action);
}

const errorResponse = (status: number, code: string) =>
  new Response(JSON.stringify({ code, message: 'simulated' }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

async function tenant(label: string, role: 'owner' | 'admin' | 'viewer' = 'owner') {
  const t = await seedRealTenant(testAuth, testDb, label, role);
  cleanups.push(() => cleanupRealTenant(testDb, t));
  return t;
}

async function member(owner: RealTenant, label: string, role: 'admin' | 'analyst' | 'viewer') {
  const m = await addRealMember(testAuth, testDb, owner, label, role);
  cleanups.push(() => cleanupRealMember(testDb, m));
  return m;
}

describe('signUpEmail (POST /v1/auth/signup) — returns a 4xx Response', () => {
  it('a rejected sign-up is a 400 with the Better Auth code, and writes no audit row', async () => {
    const before = await auditSnapshot();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers: { origin: ORIGIN },
      remoteAddress: '10.20.30.1',
      payload: { email: `fail-${randomUUID()}@example.invalid`, password: 'short', name: 'X' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'PASSWORD_TOO_SHORT' });
    expect(await newAuditActionsSince(before)).toEqual([]);
  });
});

describe('signInEmail (POST /v1/auth/login) — returns a 4xx Response', () => {
  it('a wrong password is a 401 with the code, one login_failed row and no login_succeeded row', async () => {
    const user = await seedRealUser(testAuth, testDb, 'fail-login');
    cleanups.push(() => cleanupRealUser(testDb, user));
    const before = await auditSnapshot();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: ORIGIN },
      remoteAddress: '10.20.30.2',
      payload: { email: user.email, password: 'not-the-password-123' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'INVALID_EMAIL_OR_PASSWORD' });
    expect(await newAuditActionsSince(before)).toEqual(['login_failed']);
  });

  it('a server error while signing in is a 500, not a failed login', async () => {
    vi.spyOn(testAuth.api, 'signInEmail').mockRejectedValue(new Error('database is down'));
    const before = await auditSnapshot();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: ORIGIN },
      remoteAddress: '10.20.30.3',
      payload: { email: 'someone@example.invalid', password: 'not-the-password-123' },
    });
    expect(res.statusCode).toBe(500);
    expect(await newAuditActionsSince(before)).toEqual([]);
  });
});

describe('signOut (POST /v1/auth/logout) — returns a 4xx Response', () => {
  it('a failing sign-out is reported with its status and code, and writes no audit row', async () => {
    const user = await seedRealUser(testAuth, testDb, 'fail-logout');
    cleanups.push(() => cleanupRealUser(testDb, user));
    vi.spyOn(testAuth.api, 'signOut').mockResolvedValue(
      errorResponse(400, 'FAILED_TO_GET_SESSION') as never,
    );
    const before = await auditSnapshot();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      // The CSRF hook wants a JSON content type on every state-changing POST, logout included.
      headers: { ...asHeaders(user), 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'FAILED_TO_GET_SESSION' });
    expect(await newAuditActionsSince(before)).toEqual([]);
  });
});

describe('createInvitation (POST /v1/orgs/:id/invites) — throws', () => {
  it('inviting someone who is already a member is a 400 with the code, and no member_invited row', async () => {
    const owner = await tenant('fail-invite-owner');
    const existing = await member(owner, 'fail-invite-existing', 'viewer');
    const before = await auditSnapshot();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${owner.organizationId}/invites`,
      headers: asHeaders(owner),
      payload: { email: existing.email, role: 'viewer' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION' });
    expect(await newAuditActionsSince(before)).not.toContain('member_invited');
  });
});

describe('acceptInvitation (POST /v1/invites/:token/accept) — throws', () => {
  it('an unknown invitation is a 400 with the code, and no member_invite_accepted row', async () => {
    const user = await seedRealUser(testAuth, testDb, 'fail-accept');
    cleanups.push(() => cleanupRealUser(testDb, user));
    const before = await auditSnapshot();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/invites/${randomUUID()}/accept`,
      headers: asHeaders(user),
      remoteAddress: '10.20.30.4',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'INVITATION_NOT_FOUND' });
    expect(await newAuditActionsSince(before)).not.toContain('member_invite_accepted');
  });
});

describe('updateMemberRole (PUT /v1/orgs/:id/members/:userId) — throws', () => {
  it('demoting the sole owner is a 409 last_owner, and no member_role_changed row', async () => {
    const owner = await tenant('fail-role-owner');
    const before = await auditSnapshot();
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/orgs/${owner.organizationId}/members/${owner.userId}`,
      headers: asHeaders(owner),
      payload: { role: 'viewer' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'last_owner' });
    expect(await newAuditActionsSince(before)).not.toContain('member_role_changed');
  });

  it('any other rejection keeps its status and code, and writes no audit row', async () => {
    const owner = await tenant('fail-role-other');
    const viewer = await member(owner, 'fail-role-other-viewer', 'viewer');
    vi.spyOn(testAuth.api, 'updateMemberRole').mockRejectedValue(
      new APIError('FORBIDDEN', { code: 'SIMULATED_FAILURE', message: 'simulated' }),
    );
    const before = await auditSnapshot();
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/orgs/${owner.organizationId}/members/${viewer.userId}`,
      headers: asHeaders(owner),
      payload: { role: 'analyst' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'SIMULATED_FAILURE' });
    expect(await newAuditActionsSince(before)).toEqual([]);
  });
});

describe('leaveOrganization (DELETE /v1/orgs/:id/members/:userId, yourself) — throws', () => {
  it('the sole owner leaving is a 409 last_owner, and no member_removed row', async () => {
    const owner = await tenant('fail-leave-owner');
    const before = await auditSnapshot();
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${owner.organizationId}/members/${owner.userId}`,
      headers: asHeaders(owner),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'last_owner' });
    expect(await newAuditActionsSince(before)).not.toContain('member_removed');
  });
});

describe('removeMember (DELETE /v1/orgs/:id/members/:userId, someone else) — throws', () => {
  it('a rejected removal keeps its status and code, and writes no member_removed row', async () => {
    const owner = await tenant('fail-remove-owner');
    const viewer = await member(owner, 'fail-remove-viewer', 'viewer');
    vi.spyOn(testAuth.api, 'removeMember').mockRejectedValue(
      new APIError('BAD_REQUEST', { code: 'SIMULATED_FAILURE', message: 'simulated' }),
    );
    const before = await auditSnapshot();
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/orgs/${owner.organizationId}/members/${viewer.userId}`,
      headers: asHeaders(owner),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'SIMULATED_FAILURE' });
    expect(await newAuditActionsSince(before)).toEqual([]);
  });
});

describe('createOrganization (POST /v1/orgs) — throws', () => {
  it('a taken slug is a 400 with the code, in the same { error } shape', async () => {
    const owner = await tenant('fail-org');
    const before = await auditSnapshot();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/orgs',
      headers: asHeaders(owner),
      payload: {
        name: 'Duplicate',
        slug: `real-tenant-${owner.email.split('real-tenant-')[1]!.split('@')[0]}`,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.json())).toEqual(['error']);
    expect(await newAuditActionsSince(before)).toEqual([]);
  });
});

describe('listOrganizations (GET /v1/orgs) — throws', () => {
  it('a failure keeps its status and code, in the { error } shape', async () => {
    const user = await seedRealUser(testAuth, testDb, 'fail-list');
    cleanups.push(() => cleanupRealUser(testDb, user));
    vi.spyOn(testAuth.api, 'listOrganizations').mockRejectedValue(
      new APIError('INTERNAL_SERVER_ERROR', { code: 'SIMULATED_FAILURE', message: 'simulated' }),
    );
    const before = await auditSnapshot();
    const res = await app.inject({ method: 'GET', url: '/v1/orgs', headers: asHeaders(user) });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'SIMULATED_FAILURE' });
    expect(await newAuditActionsSince(before)).toEqual([]);
  });
});

describe('getSession (every session-guarded route) — throws', () => {
  it('a Better Auth rejection is reported with its status and code, in the { error } shape', async () => {
    vi.spyOn(testAuth.api, 'getSession').mockRejectedValue(
      new APIError('UNAUTHORIZED', { code: 'SIMULATED_FAILURE', message: 'simulated' }),
    );
    const before = await auditSnapshot();
    const res = await app.inject({ method: 'GET', url: '/v1/orgs', headers: { origin: ORIGIN } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'SIMULATED_FAILURE' });
    expect(await newAuditActionsSince(before)).toEqual([]);
  });
});
