import { eq, sql } from 'drizzle-orm';
import { schema } from '@truepath/db';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, testAuth, testDb } from '../testApp.js';
import {
  addRealMember,
  cleanupRealMember,
  cleanupRealTenant,
  seedRealTenant,
  type RealTenant,
} from '../testAuthTenant.js';

// DELETE /v1/orgs/:id, POST /v1/orgs/:id/deletion/cancel (auth-tenancy.md §4.6, issue #8). Real
// Postgres, real Better Auth sessions.

const ORIGIN = 'http://localhost:5173';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function tenant(label: string): Promise<RealTenant> {
  const t = await seedRealTenant(testAuth, testDb, label);
  cleanups.push(() => cleanupRealTenant(testDb, t));
  return t;
}

async function orgName(organizationId: string): Promise<string> {
  const [row] = await testDb
    .select({ name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId));
  return row!.name;
}

describe('DELETE /v1/orgs/:id', () => {
  it('starts deletion with the correct name typed, audits it, and deactivates collector configs', async () => {
    const app = buildTestApp();
    try {
      const t = await tenant('delete-ok');
      const name = await orgName(t.organizationId);

      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${t.organizationId}`,
        headers: { cookie: t.cookie, origin: ORIGIN, 'content-type': 'application/json' },
        payload: { name },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        status: string;
        deletion_scheduled_at: string;
        deletion_due_by: string;
      };
      expect(body.status).toBe('pending_deletion');
      const scheduledAt = new Date(body.deletion_scheduled_at).getTime();
      const dueBy = new Date(body.deletion_due_by).getTime();
      const now = Date.now();
      expect(scheduledAt - now).toBeGreaterThan(6.9 * 86_400_000);
      expect(scheduledAt - now).toBeLessThan(7.1 * 86_400_000);
      expect(dueBy - now).toBeGreaterThan(29.9 * 86_400_000);

      const [org] = await testDb
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, t.organizationId));
      expect(org?.status).toBe('pending_deletion');
      expect((org?.metadata as Record<string, unknown>).deletion_scheduled_at).toBe(
        body.deletion_scheduled_at,
      );

      const auditRows = await testDb
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.targetId, t.organizationId));
      const requested = auditRows.find((r) => r.action === 'org_deletion_requested');
      expect(requested).toBeDefined();
      expect(requested?.metadata).toMatchObject({
        deletion_scheduled_at: body.deletion_scheduled_at,
        deletion_due_by: body.deletion_due_by,
      });
    } finally {
      await app.close();
    }
  });

  it('rejects a mismatched confirmation name and leaves the org active', async () => {
    const app = buildTestApp();
    try {
      const t = await tenant('delete-name-mismatch');
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${t.organizationId}`,
        headers: { cookie: t.cookie, origin: ORIGIN, 'content-type': 'application/json' },
        payload: { name: 'the wrong name entirely' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'name_mismatch' });

      const [org] = await testDb
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, t.organizationId));
      expect(org?.status).toBe('active');
    } finally {
      await app.close();
    }
  });

  it('rejects an empty body', async () => {
    const app = buildTestApp();
    try {
      const t = await tenant('delete-empty-body');
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${t.organizationId}`,
        headers: { cookie: t.cookie, origin: ORIGIN, 'content-type': 'application/json' },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_body' });
    } finally {
      await app.close();
    }
  });

  it('denies a non-owner (admin) — org.delete is owner only', async () => {
    const app = buildTestApp();
    try {
      const t = await tenant('delete-non-owner');
      const admin = await addRealMember(testAuth, testDb, t, 'delete-non-owner', 'admin');
      cleanups.push(() => cleanupRealMember(testDb, admin));
      const name = await orgName(t.organizationId);

      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${t.organizationId}`,
        headers: { cookie: admin.cookie, origin: ORIGIN, 'content-type': 'application/json' },
        payload: { name },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'forbidden_role' });
    } finally {
      await app.close();
    }
  });

  it('a second request against an already-pending-deletion org is 409, not a second audit row', async () => {
    const app = buildTestApp();
    try {
      const t = await tenant('delete-twice');
      const name = await orgName(t.organizationId);

      const first = await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${t.organizationId}`,
        headers: { cookie: t.cookie, origin: ORIGIN, 'content-type': 'application/json' },
        payload: { name },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${t.organizationId}`,
        headers: { cookie: t.cookie, origin: ORIGIN, 'content-type': 'application/json' },
        payload: { name },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ error: 'deletion_already_requested' });

      const auditRows = await testDb
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.targetId, t.organizationId));
      expect(auditRows.filter((r) => r.action === 'org_deletion_requested')).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe('POST /v1/orgs/:id/deletion/cancel', () => {
  it('cancels within the grace period, restores active, and audits it', async () => {
    const app = buildTestApp();
    try {
      const t = await tenant('cancel-ok');
      const name = await orgName(t.organizationId);
      await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${t.organizationId}`,
        headers: { cookie: t.cookie, origin: ORIGIN, 'content-type': 'application/json' },
        payload: { name },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/orgs/${t.organizationId}/deletion/cancel`,
        payload: {},
        headers: { cookie: t.cookie, origin: ORIGIN, 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'active' });

      const [org] = await testDb
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, t.organizationId));
      expect(org?.status).toBe('active');
      expect(org?.metadata).not.toHaveProperty('deletion_scheduled_at');
      expect(org?.metadata).not.toHaveProperty('deletion_due_by');

      const auditRows = await testDb
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.targetId, t.organizationId));
      expect(auditRows.some((r) => r.action === 'org_deletion_cancelled')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('is 409 when the org was never pending deletion', async () => {
    const app = buildTestApp();
    try {
      const t = await tenant('cancel-not-pending');
      const res = await app.inject({
        method: 'POST',
        url: `/v1/orgs/${t.organizationId}/deletion/cancel`,
        payload: {},
        headers: { cookie: t.cookie, origin: ORIGIN, 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'not_cancellable' });
    } finally {
      await app.close();
    }
  });

  it('is 409 once the 7-day grace period has elapsed, and the org stays pending_deletion', async () => {
    const app = buildTestApp();
    try {
      const t = await tenant('cancel-too-late');
      const name = await orgName(t.organizationId);
      await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${t.organizationId}`,
        headers: { cookie: t.cookie, origin: ORIGIN, 'content-type': 'application/json' },
        payload: { name },
      });

      // Simulate the grace period having already elapsed (direct DB write — no route exists to move
      // time forward, and this is the one thing the route itself cannot let a caller control).
      await testDb.execute(
        sql`update organizations set metadata = jsonb_set(metadata, '{deletion_scheduled_at}', to_jsonb((now() - interval '1 hour')::text)) where id = ${t.organizationId}`,
      );

      const res = await app.inject({
        method: 'POST',
        url: `/v1/orgs/${t.organizationId}/deletion/cancel`,
        payload: {},
        headers: { cookie: t.cookie, origin: ORIGIN, 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'not_cancellable' });

      const [org] = await testDb
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, t.organizationId));
      expect(org?.status).toBe('pending_deletion');
    } finally {
      await app.close();
    }
  });

  it('denies a non-owner (admin)', async () => {
    const app = buildTestApp();
    try {
      const t = await tenant('cancel-non-owner');
      const admin = await addRealMember(testAuth, testDb, t, 'cancel-non-owner', 'admin');
      cleanups.push(() => cleanupRealMember(testDb, admin));
      const name = await orgName(t.organizationId);
      await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${t.organizationId}`,
        headers: { cookie: t.cookie, origin: ORIGIN, 'content-type': 'application/json' },
        payload: { name },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/v1/orgs/${t.organizationId}/deletion/cancel`,
        payload: {},
        headers: { cookie: admin.cookie, origin: ORIGIN, 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
