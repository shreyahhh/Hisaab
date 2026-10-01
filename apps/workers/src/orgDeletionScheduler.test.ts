import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ch, createClickHouseClient } from '@truepath/clickhouse';
import { schema } from '@truepath/db';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '@truepath/db/testing';
import {
  clickhouseEnvSchema,
  collectorStoreKey,
  loadDotEnvIfPresent,
  loadEnv,
  storeBoundScope,
} from '@truepath/shared';
import { runOrgDeletionScheduler, type OrgDeletionSchedulerDeps } from './orgDeletionScheduler.js';

// Real Postgres, ClickHouse and durable Redis (same convention as apps/workers/src/dsr/dsr.test.ts).

loadDotEnvIfPresent('../../.env');
const clickhouse = createClickHouseClient(loadEnv(clickhouseEnvSchema));
const redis = new Redis('redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  connectTimeout: 1000,
});

const NOW = new Date('2026-10-08T10:00:00.000Z');

function deps(): OrgDeletionSchedulerDeps {
  return { db, clickhouse, redis, now: () => NOW, log: () => undefined };
}

const tenants: TestTenant[] = [];

async function setPendingDeletion(organizationId: string, scheduledAt: Date, dueBy: Date) {
  await db
    .update(schema.organizations)
    .set({
      status: 'pending_deletion',
      metadata: {
        deletion_scheduled_at: scheduledAt.toISOString(),
        deletion_due_by: dueBy.toISOString(),
      },
    })
    .where(eq(schema.organizations.id, organizationId));
}

const PAST_GRACE = new Date(NOW.getTime() - 1000);
const FUTURE_DUE = new Date(NOW.getTime() + 29 * 86_400_000);

async function seedOneEvent(storeId: string, visitorId: string) {
  await ch(clickhouse, storeBoundScope(storeId), storeId).insert('events', [
    {
      store_id: storeId,
      event_id: randomUUID(),
      event_name: 'page_viewed',
      occurred_at: NOW.toISOString(),
      received_at: NOW.toISOString(),
      visitor_id: visitorId,
      session_id: randomUUID(),
    },
  ]);
}

async function countEvents(storeId: string): Promise<number> {
  const [row] = await ch(clickhouse, storeBoundScope(storeId), storeId).select<{ n: string }>({
    table: 'events',
    columns: [],
    aggregates: [{ fn: 'count', as: 'n' }],
  });
  return Number(row?.n ?? 0);
}

afterAll(async () => {
  for (const t of tenants) {
    await clickhouse.command({
      query: 'ALTER TABLE events DELETE WHERE store_id = {s:UUID}',
      query_params: { s: t.storeId },
    });
  }
  for (const t of tenants) await cleanupTestTenant(t).catch(() => undefined);
  redis.disconnect();
  await clickhouse.close();
});

describe('runOrgDeletionScheduler (issue #84, auth-tenancy.md §4.6 steps 4-5)', () => {
  it('erases every store, memberships/invites/orphaned user, tombstones the org, and audits it', async () => {
    const tenant = await seedTestTenant('org-sched-happy');
    tenants.push(tenant);
    await setPendingDeletion(tenant.organizationId, PAST_GRACE, FUTURE_DUE);

    const storeKey = 'pk_' + 'd'.repeat(24);
    await db.insert(schema.integrations).values({
      storeId: tenant.storeId,
      provider: 'shopify',
      status: 'revoked',
      settings: { store_key: storeKey },
    });
    await redis.set(collectorStoreKey(storeKey), '{}');
    await seedOneEvent(tenant.storeId, 'visitor-org-sched');

    const result = await runOrgDeletionScheduler(deps());
    expect(result).toMatchObject({ organizationsErased: 1, organizationsFailed: 0 });

    expect(await countEvents(tenant.storeId)).toBe(0);
    expect(await redis.exists(collectorStoreKey(storeKey))).toBe(0);
    expect(
      await db
        .select()
        .from(schema.integrations)
        .where(eq(schema.integrations.storeId, tenant.storeId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.memberships)
        .where(eq(schema.memberships.organizationId, tenant.organizationId)),
    ).toEqual([]);
    expect(await db.select().from(schema.users).where(eq(schema.users.id, tenant.userId))).toEqual(
      [],
    );

    const [org] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, tenant.organizationId));
    expect(org).toMatchObject({
      status: 'deleted',
      name: `deleted-${tenant.organizationId}`,
      metadata: {},
    });

    const auditRows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, tenant.organizationId));
    expect(auditRows.filter((r) => r.action === 'org_deleted')).toMatchObject([
      { metadata: { stores: 1 } },
    ]);
  }, 20_000);

  it('keeps a user who still belongs to another active organization', async () => {
    const tenant = await seedTestTenant('org-sched-keep-user-a');
    const otherOrg = await seedTestTenant('org-sched-keep-user-b');
    tenants.push(otherOrg);
    await setPendingDeletion(tenant.organizationId, PAST_GRACE, FUTURE_DUE);
    await db
      .insert(schema.memberships)
      .values({ organizationId: otherOrg.organizationId, userId: tenant.userId, role: 'viewer' });

    await runOrgDeletionScheduler(deps());

    expect(
      await db.select().from(schema.users).where(eq(schema.users.id, tenant.userId)),
    ).toHaveLength(1);

    await db.delete(schema.memberships).where(eq(schema.memberships.userId, tenant.userId));
    await db.delete(schema.organizations).where(eq(schema.organizations.id, tenant.organizationId));
    await db.delete(schema.users).where(eq(schema.users.id, tenant.userId));
  }, 20_000);

  it('leaves an org untouched before its grace period elapses', async () => {
    const tenant = await seedTestTenant('org-sched-not-ready');
    tenants.push(tenant);
    await setPendingDeletion(tenant.organizationId, new Date(NOW.getTime() + 1000), FUTURE_DUE);

    await runOrgDeletionScheduler(deps());

    const [org] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, tenant.organizationId));
    expect(org?.status).toBe('pending_deletion');
  }, 20_000);

  it('a second sweep is a no-op: an already-tombstoned org is not reprocessed', async () => {
    const tenant = await seedTestTenant('org-sched-idempotent');
    tenants.push(tenant);
    await setPendingDeletion(tenant.organizationId, PAST_GRACE, FUTURE_DUE);

    const first = await runOrgDeletionScheduler(deps());
    expect(first.organizationsErased).toBe(1);
    const second = await runOrgDeletionScheduler(deps());
    expect(second.organizationsErased).toBe(0);
  }, 20_000);

  it('logs an overdue org without blocking the sweep', async () => {
    const overdueOrg = await seedTestTenant('org-sched-overdue');
    tenants.push(overdueOrg);
    // Deliberately not yet ready (scheduled_at in the future) but past due_by — an inconsistent state
    // only reachable if something upstream stalled; exercises the overdue log independent of readiness.
    await setPendingDeletion(
      overdueOrg.organizationId,
      new Date(NOW.getTime() + 1000),
      new Date(NOW.getTime() - 1000),
    );

    const log = vi.fn();
    const result = await runOrgDeletionScheduler({ ...deps(), log });
    expect(result.overdueCount).toBeGreaterThanOrEqual(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'org_deletion_overdue',
        organization_id: overdueOrg.organizationId,
      }),
    );
  }, 20_000);

  it("one organization's erasure failure does not block another's in the same sweep", async () => {
    const good = await seedTestTenant('org-sched-resilience-good');
    const bad = await seedTestTenant('org-sched-resilience-bad');
    tenants.push(good, bad);
    await setPendingDeletion(good.organizationId, PAST_GRACE, FUTURE_DUE);
    await setPendingDeletion(bad.organizationId, PAST_GRACE, FUTURE_DUE);

    // A store row with no matching organization id anywhere real wouldn't normally happen; instead,
    // force a failure by deleting `bad`'s store out from under the scheduler mid-flight isn't
    // reachable from the public API, so we simulate "one org throws" by breaking eraseStoreData's
    // path for `bad` via a store with no rows at all (still succeeds) is not a real failure case —
    // use a clickhouse client that throws for `bad`'s store id specifically.
    const flakyClickhouse = new Proxy(clickhouse, {
      get(target, prop, receiver) {
        if (prop === 'command') {
          return async (...args: Parameters<typeof clickhouse.command>) => {
            const [opts] = args;
            const params = opts?.query_params as Record<string, unknown> | undefined;
            if (params?.['store_id'] === bad.storeId) {
              throw new Error('simulated failure');
            }
            return Reflect.get(target, prop, receiver).apply(target, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const log = vi.fn();
    const result = await runOrgDeletionScheduler({ ...deps(), clickhouse: flakyClickhouse, log });
    expect(result.organizationsErased).toBe(1);
    expect(result.organizationsFailed).toBe(1);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'org_deletion_failed',
        organization_id: bad.organizationId,
      }),
    );

    const [goodOrg] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, good.organizationId));
    expect(goodOrg?.status).toBe('deleted');
    const [badOrg] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, bad.organizationId));
    expect(badOrg?.status).toBe('pending_deletion'); // untouched — not partially tombstoned
  }, 20_000);
});
