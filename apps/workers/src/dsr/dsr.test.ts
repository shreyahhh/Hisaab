import { randomUUID } from 'node:crypto';
import { DelayedError } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ch, createClickHouseClient } from '@truepath/clickhouse';
import {
  createDsrRequestRepository,
  createSuppressedIdentityRepository,
  schema,
} from '@truepath/db';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '@truepath/db/testing';
import { storeContext } from '@truepath/privacy';
import { createTestIdentityHasher } from '@truepath/privacy/testing';
import {
  IDENTITY_GUARD,
  clickhouseEnvSchema,
  loadDotEnvIfPresent,
  loadEnv,
  storeBoundScope,
  suppressionSetKey,
  type DsrJob,
} from '@truepath/shared';
import { resolveErasureScope } from './resolveErasureScope.js';
import {
  DsrTypeNotImplementedError,
  createDsrFailureHandler,
  createDsrProcessor,
  processDsr,
  type DsrWorkerDeps,
} from './worker.js';

// Real Postgres, ClickHouse and durable Redis (same convention as identity.test.ts / eventPipeline.test.ts).

loadDotEnvIfPresent('../../.env');
const clickhouse = createClickHouseClient(loadEnv(clickhouseEnvSchema));
const redis = new Redis('redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  connectTimeout: 1000,
});
const hasher = createTestIdentityHasher();
const readyKey = `test:${randomUUID()}:suppress:ready`;
const dsrRequests = createDsrRequestRepository(db);
const suppressed = createSuppressedIdentityRepository(db);

const attrAdd = vi.fn(async (..._a: unknown[]) => ({}) as never);

let A: TestTenant;
let B: TestTenant;
const tenants: TestTenant[] = [];

const NOW = new Date('2026-10-01T10:00:00.000Z');

const hash = (t: TestTenant, raw: string): string => hasher.hmac(storeContext(t.storeId), raw);
const visitorHmac = (t: TestTenant, v: string): string => hash(t, v);

function deps(): DsrWorkerDeps {
  return {
    db,
    clickhouse,
    redis,
    hasher,
    attributionQueue: { add: attrAdd } as unknown as DsrWorkerDeps['attributionQueue'],
    now: () => NOW,
    readyKey,
  };
}

let orderCounter = 0;
async function seedOrder(
  t: TestTenant,
  o: { phone?: string | null; visitorId?: string | null } = {},
) {
  orderCounter += 1;
  const externalOrderId = `${9000 + orderCounter}`;
  const [row] = await db
    .insert(schema.orders)
    .values({
      storeId: t.storeId,
      externalOrderId,
      createdAtPlatform: NOW,
      totalAmountPaise: 150000,
      currency: 'INR',
      paymentMethod: 'cod',
      phoneHashHmac: o.phone === null ? null : hash(t, o.phone ?? '+919876500001'),
      visitorId: o.visitorId ?? null,
    })
    .returning();
  return row!;
}

async function link(t: TestTenant, visitorId: string, phone: string) {
  await ch(clickhouse, storeBoundScope(t.storeId), t.storeId).insert('identity_links', [
    {
      store_id: t.storeId,
      visitor_id: visitorId,
      identity_hash_hmac: hash(t, phone),
      first_seen: NOW.toISOString(),
      last_seen: NOW.toISOString(),
    },
  ]);
}

async function seedVisitorRows(t: TestTenant, visitorId: string, orderId: string) {
  const scoped = ch(clickhouse, storeBoundScope(t.storeId), t.storeId);
  await scoped.insert('events', [
    {
      store_id: t.storeId,
      event_id: randomUUID(),
      event_name: 'page_viewed',
      occurred_at: NOW.toISOString(),
      received_at: NOW.toISOString(),
      visitor_id: visitorId,
      session_id: randomUUID(),
    },
  ]);
  await scoped.insert('touchpoints', [
    {
      store_id: t.storeId,
      visitor_id: visitorId,
      session_id: randomUUID(),
      occurred_at: NOW.toISOString(),
      channel: 'direct',
      is_direct: 1,
      event_id: randomUUID(),
    },
  ]);
  await scoped.insert('attribution_results', [
    {
      store_id: t.storeId,
      order_id: orderId,
      model: 'last_click',
      touchpoint_rank: 0,
      channel: 'direct',
      credit: 1,
      computed_at: NOW.toISOString(),
    },
  ]);
  await scoped.insert('order_status', [
    {
      store_id: t.storeId,
      order_id: orderId,
      delivery_status: 'pending',
      total_amount_paise: 150000,
      source_updated_at: NOW.toISOString(),
    },
  ]);
}

async function seedConsentRecord(t: TestTenant, visitorId: string) {
  await db.insert(schema.consentRecords).values({
    id: randomUUID(),
    storeId: t.storeId,
    visitorId: visitorHmac(t, visitorId),
    purposes: ['attribution_analytics'],
    state: 'granted',
    noticeVersion: 'v1',
    source: 'pixel_initial_state',
    occurredAt: NOW,
  });
}

async function countCh(
  t: TestTenant,
  table: 'events' | 'touchpoints' | 'identity_links',
  visitorId: string,
) {
  const [row] = await ch(clickhouse, storeBoundScope(t.storeId), t.storeId).select<{ n: string }>({
    table,
    columns: [],
    aggregates: [{ fn: 'count', as: 'n' }],
    where: { visitor_id: { op: '=', value: visitorId, type: 'String' } },
  });
  return Number(row?.n ?? 0);
}

async function countChByOrder(
  t: TestTenant,
  table: 'attribution_results' | 'order_status',
  orderId: string,
) {
  const [row] = await ch(clickhouse, storeBoundScope(t.storeId), t.storeId).select<{ n: string }>({
    table,
    columns: [],
    aggregates: [{ fn: 'count', as: 'n' }],
    where: { order_id: { op: '=', value: orderId, type: 'String' } },
  });
  return Number(row?.n ?? 0);
}

async function createWithdrawalRequest(t: TestTenant) {
  const [row] = await db
    .insert(schema.dsrRequests)
    .values({
      storeId: t.storeId,
      type: 'erasure',
      identityHash: null,
      dueAt: new Date(NOW.getTime() + 86_400_000),
      resultSummary: { trigger: 'consent_withdrawn' },
    })
    .returning();
  return row!;
}

async function auditCountFor(requestId: string, action: string) {
  const rows = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.targetId, requestId));
  return rows.filter((r) => r.action === action).length;
}

beforeAll(async () => {
  A = await seedTestTenant('dsr-worker-a');
  B = await seedTestTenant('dsr-worker-b');
  tenants.push(A, B);
  await redis.set(readyKey, String(Date.now()));
});

afterAll(async () => {
  for (const t of tenants) {
    for (const table of [
      'events',
      'touchpoints',
      'identity_links',
      'attribution_results',
      'order_status',
    ]) {
      await clickhouse.command({
        query: `ALTER TABLE ${table} DELETE WHERE store_id = {s:UUID}`,
        query_params: { s: t.storeId },
      });
    }
    const keys = await redis.keys(`*${t.storeId}*`);
    if (keys.length > 0) await redis.del(...keys);
  }
  await redis.del(readyKey);
  for (const t of tenants) await cleanupTestTenant(t);
  redis.disconnect();
  await clickhouse.close();
});

describe('resolveErasureScope — identity guard (issue #25 decision 3)', () => {
  it('ignores a hash shared across too many visitors, so it cannot cascade-delete them', async () => {
    const t = await seedTestTenant('dsr-guard');
    try {
      const sharedPhone = '+919876511111';
      const order = await seedOrder(t, { phone: sharedPhone });
      for (let i = 0; i < IDENTITY_GUARD.maxVisitorsPerHash + 1; i += 1) {
        await link(t, `guard-visitor-${i}`, sharedPhone);
      }
      const scope = await resolveErasureScope(
        { db, clickhouse, now: () => NOW },
        t.storeId,
        hash(t, sharedPhone),
      );
      expect(scope.guardRejectedHashes).toEqual([hash(t, sharedPhone)]);
      expect(scope.visitorIds).toEqual([]);
      expect(scope.orderIds).toEqual([order.id]); // the order itself is still found by hash
    } finally {
      await clickhouse.command({
        query: 'ALTER TABLE identity_links DELETE WHERE store_id = {s:UUID}',
        query_params: { s: t.storeId },
      });
      await cleanupTestTenant(t);
    }
  });
});

describe('processDsr — webhook erasure (§4.3/§4.4)', () => {
  it('resolves H/V/O, suppresses first, deletes ClickHouse rows, anonymises the order, and completes', async () => {
    const phone = '+919876522222';
    const visitorId = 'visitor-webhook-1';
    const order = await seedOrder(A, { phone });
    await link(A, visitorId, phone);
    await seedVisitorRows(A, visitorId, order.id);
    await seedConsentRecord(A, visitorId);

    const { row } = await dsrRequests.createFromWebhook(storeBoundScope(A.storeId), {
      storeId: A.storeId,
      type: 'erasure',
      identityHash: hash(A, phone),
      dueAt: new Date(NOW.getTime() + 7 * 86_400_000),
      sourceRef: 'wh-erasure-1',
    });

    const outcome = await processDsr(
      deps(),
      { storeId: A.storeId, type: 'erasure', requestId: row.id },
      'job-1',
    );
    expect(outcome).toMatchObject({ kind: 'webhook', visitorsScoped: 1, ordersAffected: 1 });

    expect(await countCh(A, 'events', visitorId)).toBe(0);
    expect(await countCh(A, 'touchpoints', visitorId)).toBe(0);
    expect(await countCh(A, 'identity_links', visitorId)).toBe(0);
    expect(await countChByOrder(A, 'attribution_results', order.id)).toBe(0);
    expect(await countChByOrder(A, 'order_status', order.id)).toBe(0);

    const [anonymised] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    expect(anonymised).toMatchObject({ phoneHashHmac: null, visitorId: null });

    const consent = await db
      .select()
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.visitorId, visitorHmac(A, visitorId)));
    expect(consent).toEqual([]);

    const suppressionRows = await db
      .select()
      .from(schema.suppressedIdentities)
      .where(eq(schema.suppressedIdentities.dsrRequestId, row.id));
    expect(suppressionRows).toMatchObject(
      expect.arrayContaining([
        expect.objectContaining({ identifierType: 'identity_hash_hmac', reason: 'erased' }),
        expect.objectContaining({ identifierType: 'visitor_id', reason: 'erased' }),
      ]),
    );
    expect(
      Number(
        await redis.zscore(
          suppressionSetKey(storeBoundScope(A.storeId), A.storeId, 'erased:identity'),
          hash(A, phone),
        ),
      ),
    ).toBeGreaterThan(0);
    expect(
      Number(
        await redis.zscore(
          suppressionSetKey(storeBoundScope(A.storeId), A.storeId, 'erased:visitor'),
          visitorHmac(A, visitorId),
        ),
      ),
    ).toBeGreaterThan(0);

    const [completed] = await dsrRequests.listRecentByStore(
      storeBoundScope(A.storeId),
      A.storeId,
      1,
    );
    expect(completed).toMatchObject({ status: 'completed' });
    expect(completed?.resultSummary).toMatchObject({ visitors_scoped: 1, orders_affected: 1 });
    expect(await auditCountFor(row.id, 'dsr_completed')).toBe(1);

    // Redelivery is a no-op, not a second run or a second audit row.
    const redelivered = await processDsr(
      deps(),
      { storeId: A.storeId, type: 'erasure', requestId: row.id },
      'job-1-retry',
    );
    expect(redelivered).toEqual({ kind: 'already_completed' });
    expect(await auditCountFor(row.id, 'dsr_completed')).toBe(1);
  }, 20_000);

  it("never touches another store's rows for the same raw visitor id", async () => {
    const phone = '+919876533333';
    const visitorId = 'visitor-cross-tenant';
    const orderA = await seedOrder(A, { phone });
    const orderB = await seedOrder(B, { phone: '+919876544444' });
    await link(A, visitorId, phone);
    await seedVisitorRows(A, visitorId, orderA.id);
    // Store B seeds the SAME raw visitor id under its own (differently-keyed) tenant.
    await seedVisitorRows(B, visitorId, orderB.id);

    const { row } = await dsrRequests.createFromWebhook(storeBoundScope(A.storeId), {
      storeId: A.storeId,
      type: 'erasure',
      identityHash: hash(A, phone),
      dueAt: new Date(NOW.getTime() + 7 * 86_400_000),
      sourceRef: 'wh-erasure-cross-tenant',
    });
    await processDsr(deps(), { storeId: A.storeId, type: 'erasure', requestId: row.id }, 'job-2');

    expect(await countCh(A, 'events', visitorId)).toBe(0);
    expect(await countCh(B, 'events', visitorId)).toBe(1); // untouched
  }, 20_000);
});

describe('processDsr — withdrawal-triggered erasure (§4.5, narrow scope)', () => {
  it('unlinks the visitor but keeps the order and its phone hash, and re-attributes', async () => {
    attrAdd.mockClear();
    const phone = '+919876555555';
    const visitorId = 'visitor-withdraw-1';
    const order = await seedOrder(A, { phone, visitorId });
    await seedVisitorRows(A, visitorId, order.id);
    await seedConsentRecord(A, visitorId);

    const request = await createWithdrawalRequest(A);
    const outcome = await processDsr(
      deps(),
      { storeId: A.storeId, type: 'erasure', requestId: request.id, visitorIds: [visitorId] },
      'job-3',
    );
    expect(outcome).toMatchObject({ kind: 'withdrawal', visitorsScoped: 1, ordersAffected: 1 });

    expect(await countCh(A, 'events', visitorId)).toBe(0);
    expect(await countCh(A, 'identity_links', visitorId)).toBe(0);
    expect(await countChByOrder(A, 'attribution_results', order.id)).toBe(0);
    expect(await countChByOrder(A, 'order_status', order.id)).toBe(1); // KEPT — the order isn't erased

    const [kept] = await db.select().from(schema.orders).where(eq(schema.orders.id, order.id));
    expect(kept).toMatchObject({ visitorId: null, phoneHashHmac: hash(A, phone) }); // hash KEPT

    expect(attrAdd).toHaveBeenCalledWith(
      'incremental',
      { storeId: A.storeId, mode: 'incremental', orderIds: [order.id] },
      expect.objectContaining({ jobId: `attr-${order.id}` }),
    );

    const [completed] = await dsrRequests.listRecentByStore(
      storeBoundScope(A.storeId),
      A.storeId,
      1,
    );
    expect(completed).toMatchObject({ id: request.id, status: 'completed' });
    expect(await auditCountFor(request.id, 'dsr_completed')).toBe(1);
  }, 20_000);
});

describe('processDsr — follow-up erasure after a suppression_hit (§4.4 step 9)', () => {
  // Three full erasure runs against real Postgres/ClickHouse in one test.
  it('purges only the new visitor, appends to followups[], and does not disturb the original request', async () => {
    const phone = '+919876566666';
    const originalVisitor = 'visitor-followup-original';
    const originalOrder = await seedOrder(A, { phone });
    await link(A, originalVisitor, phone);
    await seedVisitorRows(A, originalVisitor, originalOrder.id);
    const { row: original } = await dsrRequests.createFromWebhook(storeBoundScope(A.storeId), {
      storeId: A.storeId,
      type: 'erasure',
      identityHash: hash(A, phone),
      dueAt: new Date(NOW.getTime() + 7 * 86_400_000),
      sourceRef: 'wh-erasure-followup-origin',
    });
    await processDsr(
      deps(),
      { storeId: A.storeId, type: 'erasure', requestId: original.id },
      'job-origin',
    );

    // A new device, same erased identity, with its own purchase.
    const newVisitor = 'visitor-followup-new-device';
    const newOrder = await seedOrder(A, { visitorId: newVisitor });
    await seedVisitorRows(A, newVisitor, newOrder.id);
    await suppressed.add(storeBoundScope(A.storeId), A.storeId, {
      identifierType: 'visitor_id',
      identifier: visitorHmac(A, newVisitor),
      reason: 'erased',
      dsrRequestId: original.id,
      expiresAt: new Date(NOW.getTime() + 400 * 86_400_000),
    });

    const outcome = await processDsr(
      deps(),
      { storeId: A.storeId, type: 'erasure', requestId: original.id, visitorIds: [newVisitor] },
      'job-followup-1',
    );
    expect(outcome).toMatchObject({ kind: 'followup', visitorsScoped: 1, ordersAffected: 1 });

    expect(await countCh(A, 'events', newVisitor)).toBe(0);
    const [newOrderRow] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, newOrder.id));
    expect(newOrderRow).toMatchObject({ visitorId: null });

    const [after] = await dsrRequests.listRecentByStore(storeBoundScope(A.storeId), A.storeId, 1);
    expect(after).toMatchObject({ id: original.id, status: 'completed' }); // untouched
    expect(after?.resultSummary).toMatchObject({
      followups: [expect.objectContaining({ followup_key: 'job-followup-1', visitor_count: 1 })],
    });
    expect(await auditCountFor(original.id, 'dsr_followup_erasure')).toBe(1);

    // Redelivery with the same jobId is idempotent: no second followups[] entry.
    await processDsr(
      deps(),
      { storeId: A.storeId, type: 'erasure', requestId: original.id, visitorIds: [newVisitor] },
      'job-followup-1',
    );
    const [againRow] = await dsrRequests.listRecentByStore(
      storeBoundScope(A.storeId),
      A.storeId,
      1,
    );
    const followups =
      (againRow?.resultSummary as { followups?: unknown[] } | null)?.followups ?? [];
    expect(followups).toHaveLength(1);
  }, 20_000);
});

describe('processDsr — unimplemented types', () => {
  it.each(['access', 'correction', 'store_erasure'] as const)('rejects type %s', async (type) => {
    await expect(
      processDsr(deps(), { storeId: A.storeId, type, requestId: randomUUID() }, 'job-x'),
    ).rejects.toThrow(DsrTypeNotImplementedError);
  });
});

describe('createDsrProcessor — fail-closed on suppression unavailable', () => {
  it('delays the job rather than failing it', async () => {
    const job = {
      id: 'job-delay-1',
      data: { storeId: A.storeId, type: 'erasure', requestId: randomUUID() } satisfies DsrJob,
      moveToDelayed: vi.fn(async () => undefined),
    };
    const processor = createDsrProcessor(
      { ...deps(), readyKey: `${readyKey}:absent` },
      () => undefined,
    );
    await expect(processor(job as never, 'token-1')).rejects.toThrow(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
  });
});

describe('createDsrFailureHandler', () => {
  it('marks a pending request failed once retries are exhausted, and audits it', async () => {
    const { row } = await dsrRequests.createFromWebhook(storeBoundScope(A.storeId), {
      storeId: A.storeId,
      type: 'erasure',
      identityHash: 'k1:' + 'f'.repeat(64),
      dueAt: new Date(NOW.getTime() + 7 * 86_400_000),
      sourceRef: 'wh-failure-1',
    });
    const job = {
      data: { storeId: A.storeId, type: 'erasure', requestId: row.id } satisfies DsrJob,
      opts: { attempts: 5 },
      attemptsMade: 5,
    };
    const handler = createDsrFailureHandler({ db });
    await handler(job as never);

    const [failed] = await dsrRequests.listRecentByStore(storeBoundScope(A.storeId), A.storeId, 1);
    expect(failed).toMatchObject({ id: row.id, status: 'failed' });
    expect(await auditCountFor(row.id, 'dsr_failed')).toBe(1);
  });

  it('never downgrades an already-completed request', async () => {
    const { row } = await dsrRequests.createFromWebhook(storeBoundScope(A.storeId), {
      storeId: A.storeId,
      type: 'erasure',
      identityHash: 'k1:' + 'e'.repeat(64),
      dueAt: new Date(NOW.getTime() + 7 * 86_400_000),
      sourceRef: 'wh-failure-2',
    });
    await dsrRequests.complete(storeBoundScope(A.storeId), A.storeId, row.id, {
      resultSummaryPatch: {},
      completedAt: NOW,
    });
    const job = {
      data: { storeId: A.storeId, type: 'erasure', requestId: row.id } satisfies DsrJob,
      opts: { attempts: 5 },
      attemptsMade: 5,
    };
    await createDsrFailureHandler({ db })(job as never);

    const [stillCompleted] = await dsrRequests.listRecentByStore(
      storeBoundScope(A.storeId),
      A.storeId,
      1,
    );
    expect(stillCompleted).toMatchObject({ id: row.id, status: 'completed' });
  });

  it('does nothing while attempts remain', async () => {
    const job = {
      data: { storeId: A.storeId, type: 'erasure', requestId: randomUUID() } satisfies DsrJob,
      opts: { attempts: 5 },
      attemptsMade: 2,
    };
    await expect(createDsrFailureHandler({ db })(job as never)).resolves.toBeUndefined();
  });
});
