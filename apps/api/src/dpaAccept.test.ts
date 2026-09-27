import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@truepath/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, TEST_DPA_VERSION, testAuth, testDb } from './testApp.js';
import {
  addRealMember,
  cleanupRealMember,
  cleanupRealTenant,
  cleanupRealUser,
  seedRealTenant,
  seedRealUser,
  type RealTenant,
} from './testAuthTenant.js';

// POST /v1/orgs/:id/dpa/accept (SPEC §5.1, §10; auth-tenancy.md §4.5). Real Postgres and real Better
// Auth sessions throughout: the owner-only rule, the version check, the evidence that is stored (and
// what must not be), idempotency under repeats and races, and that the acceptance and its
// `dpa_accepted` audit row commit or fail together.

const ORIGIN = 'http://localhost:5173';
const app = buildTestApp();
const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  await app.close();
});
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const asHeaders = (t: { cookie: string }) => ({ cookie: t.cookie, origin: ORIGIN });

async function tenant(label: string) {
  const t = await seedRealTenant(testAuth, testDb, label);
  cleanups.push(() => cleanupRealTenant(testDb, t));
  return t;
}
async function member(owner: RealTenant, label: string, role: 'admin' | 'analyst' | 'viewer') {
  const m = await addRealMember(testAuth, testDb, owner, label, role);
  cleanups.push(() => cleanupRealMember(testDb, m));
  return m;
}

const accept = (
  t: { organizationId: string; cookie: string },
  payload: unknown = { dpa_version: TEST_DPA_VERSION },
  extra: { remoteAddress?: string } = {},
) =>
  app.inject({
    method: 'POST',
    url: `/v1/orgs/${t.organizationId}/dpa/accept`,
    headers: asHeaders(t),
    payload: payload as object,
    ...extra,
  });

const acceptances = (organizationId: string) =>
  testDb
    .select()
    .from(schema.dpaAcceptances)
    .where(eq(schema.dpaAcceptances.organizationId, organizationId));

const auditRows = async (organizationId: string) =>
  (
    await testDb
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.organizationId, organizationId))
  ).filter((row) => row.action === 'dpa_accepted');

describe('POST /v1/orgs/:id/dpa/accept — owner accepts', () => {
  it('records the acceptance (201) with version, accepting user and time', async () => {
    const owner = await tenant('dpa-owner');
    const res = await accept(owner);

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['accepted_at', 'dpa_version', 'id']);
    expect(body.dpa_version).toBe(TEST_DPA_VERSION);
    expect(new Date(body.accepted_at).toISOString()).toBe(body.accepted_at);

    const rows = await acceptances(owner.organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.id,
      organizationId: owner.organizationId,
      dpaVersion: TEST_DPA_VERSION,
      acceptedByUserId: owner.userId,
    });
  });

  it('stores the accepting IP truncated to /24 (IPv4) and never in full', async () => {
    const owner = await tenant('dpa-ipv4');
    const res = await accept(owner, undefined, { remoteAddress: '203.0.113.77' });
    expect(res.statusCode).toBe(201);

    const [row] = await acceptances(owner.organizationId);
    expect(row?.ipTruncated).toBe('203.0.113.0/24');
    expect(JSON.stringify(row)).not.toContain('203.0.113.77');
    expect(res.body).not.toContain('203.0.113');
    for (const audit of await auditRows(owner.organizationId)) {
      expect(JSON.stringify(audit)).not.toContain('203.0.113');
    }
  });

  it('stores the accepting IP truncated to /48 (IPv6)', async () => {
    const owner = await tenant('dpa-ipv6');
    const res = await accept(owner, undefined, { remoteAddress: '2001:db8:abcd:12::77' });
    expect(res.statusCode).toBe(201);

    const [row] = await acceptances(owner.organizationId);
    expect(row?.ipTruncated).toBe('2001:db8:abcd::/48');
    expect(JSON.stringify(row)).not.toContain('12::77');
  });

  it('writes one dpa_accepted audit row: actor, target and only the version as metadata', async () => {
    const owner = await tenant('dpa-audit');
    await accept(owner, undefined, { remoteAddress: '203.0.113.9' });

    const rows = await auditRows(owner.organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: owner.organizationId,
      actorUserId: owner.userId,
      actorType: 'user',
      action: 'dpa_accepted',
      targetType: 'organization',
      targetId: owner.organizationId,
      metadata: { dpa_version: TEST_DPA_VERSION },
    });
  });

  it('shows up in the organization audit log endpoint', async () => {
    const owner = await tenant('dpa-audit-endpoint');
    await accept(owner);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${owner.organizationId}/audit-log?action=dpa_accepted`,
      headers: asHeaders(owner),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      expect.objectContaining({
        action: 'dpa_accepted',
        actor_user_id: owner.userId,
        metadata: { dpa_version: TEST_DPA_VERSION },
      }),
    ]);
  });
});

describe('POST /v1/orgs/:id/dpa/accept — repeats and races', () => {
  it('a repeat is a 200 with the same record, and writes no second row or audit entry', async () => {
    const owner = await tenant('dpa-repeat');
    const first = await accept(owner);
    const second = await accept(owner);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await acceptances(owner.organizationId)).toHaveLength(1);
    expect(await auditRows(owner.organizationId)).toHaveLength(1);
  });

  it('concurrent accepts create exactly one row and one audit entry (one 201, the rest 200)', async () => {
    const owner = await tenant('dpa-race');
    const responses = await Promise.all(Array.from({ length: 6 }, () => accept(owner)));

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(5);
    expect(new Set(responses.map((r) => r.json().id)).size).toBe(1);
    expect(await acceptances(owner.organizationId)).toHaveLength(1);
    expect(await auditRows(owner.organizationId)).toHaveLength(1);
  });

  it('an acceptance of an older version does not count as accepting the current one', async () => {
    const owner = await tenant('dpa-old-version');
    await testDb.insert(schema.dpaAcceptances).values({
      organizationId: owner.organizationId,
      dpaVersion: 'an-older-version',
      acceptedByUserId: owner.userId,
    });

    const res = await accept(owner);
    expect(res.statusCode).toBe(201);
    expect(await acceptances(owner.organizationId)).toHaveLength(2);
  });
});

describe('POST /v1/orgs/:id/dpa/accept — who may accept', () => {
  it.each(['admin', 'analyst', 'viewer'] as const)(
    'a %s is forbidden (403 forbidden_role) and nothing is recorded',
    async (role) => {
      const owner = await tenant(`dpa-role-owner-${role}`);
      const other = await member(owner, `dpa-role-${role}`, role);

      const res = await accept(other);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden_role' });
      expect(await acceptances(owner.organizationId)).toHaveLength(0);
      expect(await auditRows(owner.organizationId)).toHaveLength(0);
    },
  );

  it('an unauthenticated caller gets 401', async () => {
    const owner = await tenant('dpa-anon');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${owner.organizationId}/dpa/accept`,
      headers: { origin: ORIGIN },
      payload: { dpa_version: TEST_DPA_VERSION },
    });
    expect(res.statusCode).toBe(401);
    expect(await acceptances(owner.organizationId)).toHaveLength(0);
  });

  it("another organization's owner gets 404, records nothing, and learns nothing", async () => {
    const a = await tenant('dpa-cross-a');
    const b = await tenant('dpa-cross-b');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${b.organizationId}/dpa/accept`,
      headers: asHeaders(a),
      payload: { dpa_version: TEST_DPA_VERSION },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    // Same answer as for an organization that does not exist at all.
    const missing = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${randomUUID()}/dpa/accept`,
      headers: asHeaders(a),
      payload: { dpa_version: TEST_DPA_VERSION },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toBe(res.body);

    expect(await acceptances(b.organizationId)).toHaveLength(0);
    expect(await auditRows(b.organizationId)).toHaveLength(0);
  });

  it('a user with no organization at all gets 404', async () => {
    const owner = await tenant('dpa-nomember-owner');
    const stranger = await seedRealUser(testAuth, testDb, 'dpa-stranger');
    cleanups.push(() => cleanupRealUser(testDb, stranger));

    const res = await accept({ organizationId: owner.organizationId, cookie: stranger.cookie });
    expect(res.statusCode).toBe(404);
    expect(await acceptances(owner.organizationId)).toHaveLength(0);
  });
});

describe('POST /v1/orgs/:id/dpa/accept — the version and the body', () => {
  it('rejects a version that is not the current one (409), naming the current one', async () => {
    const owner = await tenant('dpa-mismatch');
    for (const wrong of ['something-else', 'TEST-1', ' test-1', 'test-1 ', 'test-']) {
      const res = await accept(owner, { dpa_version: wrong });
      expect(res.statusCode, wrong).toBe(409);
      expect(res.json()).toEqual({
        error: 'dpa_version_mismatch',
        current_version: TEST_DPA_VERSION,
      });
    }
    expect(await acceptances(owner.organizationId)).toHaveLength(0);
    expect(await auditRows(owner.organizationId)).toHaveLength(0);
  });

  it.each([
    ['an empty object', {}, ['dpa_version']],
    ['a non-string version', { dpa_version: 1 }, ['dpa_version']],
    ['an empty version', { dpa_version: '' }, ['dpa_version']],
    ['an unknown key', { dpa_version: TEST_DPA_VERSION, accepted_by_user_id: 'x' }, ['(root)']],
  ])('rejects %s with 400 invalid_body', async (_label, payload, fields) => {
    const owner = await tenant('dpa-body');
    const res = await accept(owner, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_body', fields });
    expect(await acceptances(owner.organizationId)).toHaveLength(0);
  });

  it('a wrong role or foreign organization is decided before the body is even looked at', async () => {
    const owner = await tenant('dpa-order-owner');
    const viewer = await member(owner, 'dpa-order-viewer', 'viewer');
    const stranger = await tenant('dpa-order-stranger');

    expect((await accept(viewer, { nonsense: true })).statusCode).toBe(403);
    expect(
      (await accept({ organizationId: owner.organizationId, cookie: stranger.cookie }, {}))
        .statusCode,
    ).toBe(404);
  });
});

describe('POST /v1/orgs/:id/dpa/accept — CSRF checks apply', () => {
  it('rejects a cross-origin request and a non-JSON content type, recording nothing', async () => {
    const owner = await tenant('dpa-csrf');

    const wrongOrigin = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${owner.organizationId}/dpa/accept`,
      headers: { cookie: owner.cookie, origin: 'https://evil.example' },
      payload: { dpa_version: TEST_DPA_VERSION },
    });
    expect(wrongOrigin.statusCode).toBe(403);
    expect(wrongOrigin.json()).toEqual({ error: 'invalid_origin' });

    const noOrigin = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${owner.organizationId}/dpa/accept`,
      headers: { cookie: owner.cookie },
      payload: { dpa_version: TEST_DPA_VERSION },
    });
    expect(noOrigin.statusCode).toBe(403);

    const form = await app.inject({
      method: 'POST',
      url: `/v1/orgs/${owner.organizationId}/dpa/accept`,
      headers: {
        cookie: owner.cookie,
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `dpa_version=${TEST_DPA_VERSION}`,
    });
    expect(form.statusCode).toBe(403);
    expect(form.json()).toEqual({ error: 'invalid_content_type' });

    expect(await acceptances(owner.organizationId)).toHaveLength(0);
  });
});

describe('POST /v1/orgs/:id/dpa/accept — the acceptance and its audit row succeed or fail together', () => {
  it('if the audit row cannot be written, nothing is accepted and the caller gets a 500', async () => {
    const owner = await tenant('dpa-atomic');
    const id = randomUUID().replaceAll('-', '_');
    const fn = `test_fail_dpa_audit_${id}`;
    // A trigger that fails only this organization's dpa_accepted audit insert, so nothing else
    // running against the shared database is affected. Names and the uuid are generated here.
    await testDb.execute(
      sql.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated audit failure'; END $$`),
    );
    await testDb.execute(
      sql.raw(`CREATE TRIGGER ${fn} BEFORE INSERT ON audit_log FOR EACH ROW
        WHEN (NEW.organization_id = '${owner.organizationId}' AND NEW.action = 'dpa_accepted')
        EXECUTE FUNCTION ${fn}()`),
    );
    try {
      const failing = await accept(owner);
      expect(failing.statusCode).toBe(500);
      expect(await acceptances(owner.organizationId)).toHaveLength(0);
      expect(await auditRows(owner.organizationId)).toHaveLength(0);
    } finally {
      await testDb.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON audit_log`));
      await testDb.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
    }

    // With the fault gone the same request succeeds: the failed attempt left nothing behind.
    const retry = await accept(owner);
    expect(retry.statusCode).toBe(201);
    expect(await acceptances(owner.organizationId)).toHaveLength(1);
    expect(await auditRows(owner.organizationId)).toHaveLength(1);
  });
});
