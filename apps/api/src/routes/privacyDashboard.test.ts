import { eq } from 'drizzle-orm';
import { schema } from '@truepath/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, TEST_DASHBOARD_URL, testAuth, testDb } from '../testApp.js';
import {
  addRealMember,
  cleanupRealMember,
  cleanupRealTenant,
  cleanupRealUser,
  seedRealTenant,
  seedRealUser,
  type RealTenant,
} from '../testAuthTenant.js';

// POST /v1/stores/:id/privacy/confirm-india-opt-in (HLD §8 "Consent-region gate" layer 1; SPEC P-1;
// issue #72). Real Postgres and real Better Auth sessions throughout, mirroring dpaAccept.test.ts:
// who may confirm, idempotency, the audit row, and CSRF. Collector-config republish behaviour (the
// store actually flipping to `active`) is covered alongside the rest of publishCollectorConfig's
// gates in integrations.pixel.test.ts, since that file already carries the Shopify-connect fixture.

const app = buildTestApp();
const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  await app.close();
});
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const asHeaders = (t: { cookie: string }) => ({ cookie: t.cookie, origin: TEST_DASHBOARD_URL });

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

const confirm = (t: { storeId: string; cookie: string }) =>
  app.inject({
    method: 'POST',
    url: `/v1/stores/${t.storeId}/privacy/confirm-india-opt-in`,
    headers: asHeaders(t),
    payload: {},
  });

const auditRows = async (organizationId: string) =>
  (
    await testDb
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.organizationId, organizationId))
  ).filter((row) => row.action === 'consent_region_confirmed');

const checklistOf = async (storeId: string) => {
  const [row] = await testDb.select().from(schema.stores).where(eq(schema.stores.id, storeId));
  const config = row?.privacyConfig as Record<string, unknown> | undefined;
  return (config?.['checklist'] ?? {}) as Record<string, unknown>;
};

describe('POST /v1/stores/:id/privacy/confirm-india-opt-in — owner or admin confirms', () => {
  it('records the confirmation (201) with an ISO timestamp', async () => {
    const owner = await tenant('optin-owner');
    const res = await confirm(owner);

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body)).toEqual(['india_opt_in_confirmed_at']);
    expect(new Date(body.india_opt_in_confirmed_at).toISOString()).toBe(
      body.india_opt_in_confirmed_at,
    );

    const checklist = await checklistOf(owner.storeId);
    expect(checklist['india_opt_in_confirmed_at']).toBe(body.india_opt_in_confirmed_at);
  });

  it('an admin may also confirm', async () => {
    const owner = await tenant('optin-admin-owner');
    const admin = await member(owner, 'optin-admin', 'admin');

    const res = await confirm(admin);
    expect(res.statusCode).toBe(201);
  });

  it('writes one consent_region_confirmed audit row: actor and target, no metadata beyond the schema', async () => {
    const owner = await tenant('optin-audit');
    await confirm(owner);

    const rows = await auditRows(owner.organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId: owner.organizationId,
      actorUserId: owner.userId,
      actorType: 'user',
      action: 'consent_region_confirmed',
      targetType: 'store',
      targetId: owner.storeId,
    });
  });
});

describe('POST /v1/stores/:id/privacy/confirm-india-opt-in — repeats', () => {
  it('a repeat is a 200 with the same timestamp, and writes no second row or audit entry', async () => {
    const owner = await tenant('optin-repeat');
    const first = await confirm(owner);
    const second = await confirm(owner);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await auditRows(owner.organizationId)).toHaveLength(1);
  });

  it('concurrent confirmations write exactly one audit entry (one 201, the rest 200)', async () => {
    const owner = await tenant('optin-race');
    const responses = await Promise.all(Array.from({ length: 6 }, () => confirm(owner)));

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(5);
    expect(new Set(responses.map((r) => r.json().india_opt_in_confirmed_at)).size).toBe(1);
    expect(await auditRows(owner.organizationId)).toHaveLength(1);
  });
});

describe('POST /v1/stores/:id/privacy/confirm-india-opt-in — who may confirm', () => {
  it.each(['analyst', 'viewer'] as const)(
    'a %s is forbidden (403 forbidden_role) and nothing is recorded',
    async (role) => {
      const owner = await tenant(`optin-role-owner-${role}`);
      const other = await member(owner, `optin-role-${role}`, role);

      const res = await confirm(other);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden_role' });
      expect(await auditRows(owner.organizationId)).toHaveLength(0);
      expect((await checklistOf(owner.storeId))['india_opt_in_confirmed_at']).toBeUndefined();
    },
  );

  it('an unauthenticated caller gets 401', async () => {
    const owner = await tenant('optin-anon');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/stores/${owner.storeId}/privacy/confirm-india-opt-in`,
      headers: { origin: TEST_DASHBOARD_URL },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(await auditRows(owner.organizationId)).toHaveLength(0);
  });

  it("another organization's owner gets 404, records nothing, and learns nothing", async () => {
    const a = await tenant('optin-cross-a');
    const b = await tenant('optin-cross-b');

    const res = await app.inject({
      method: 'POST',
      url: `/v1/stores/${b.storeId}/privacy/confirm-india-opt-in`,
      headers: asHeaders(a),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    expect(await auditRows(b.organizationId)).toHaveLength(0);
  });

  it('a user with no organization at all gets 404', async () => {
    const owner = await tenant('optin-nomember-owner');
    const stranger = await seedRealUser(testAuth, testDb, 'optin-stranger');
    cleanups.push(() => cleanupRealUser(testDb, stranger));

    const res = await confirm({ storeId: owner.storeId, cookie: stranger.cookie });
    expect(res.statusCode).toBe(404);
    expect(await auditRows(owner.organizationId)).toHaveLength(0);
  });
});

describe('POST /v1/stores/:id/privacy/confirm-india-opt-in — CSRF checks apply', () => {
  it('rejects a cross-origin request and a missing origin, recording nothing', async () => {
    const owner = await tenant('optin-csrf');

    const wrongOrigin = await app.inject({
      method: 'POST',
      url: `/v1/stores/${owner.storeId}/privacy/confirm-india-opt-in`,
      headers: { cookie: owner.cookie, origin: 'https://evil.example' },
      payload: {},
    });
    expect(wrongOrigin.statusCode).toBe(403);
    expect(wrongOrigin.json()).toEqual({ error: 'invalid_origin' });

    const noOrigin = await app.inject({
      method: 'POST',
      url: `/v1/stores/${owner.storeId}/privacy/confirm-india-opt-in`,
      headers: { cookie: owner.cookie },
      payload: {},
    });
    expect(noOrigin.statusCode).toBe(403);

    expect(await auditRows(owner.organizationId)).toHaveLength(0);
  });
});
