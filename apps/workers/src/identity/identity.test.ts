import { randomUUID } from 'node:crypto';
import { DelayedError, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ch, createClickHouseClient } from '@truepath/clickhouse';
import { schema, createOrderRepository } from '@truepath/db';
import {
  cleanupTestTenant,
  db,
  seedTestTenant,
  setStoreChildDirected,
  type TestTenant,
} from '@truepath/db/testing';
import { storeContext } from '@truepath/privacy';
import { createTestIdentityHasher } from '@truepath/privacy/testing';
import {
  IDENTITY_GUARD,
  MAX_JOURNEY_VISITORS,
  clickhouseEnvSchema,
  loadDotEnvIfPresent,
  loadEnv,
  storeBoundScope,
  suppressionSetKey,
  type IdentityStitchJob,
  type SuppressionSetKind,
} from '@truepath/shared';
import { SuppressionNotReadyError } from '../eventSuppression.js';
import { findLinkedVisitors, resolveJourneyVisitors, type IdentityDeps } from './journey.js';
import { createIdentityStitchProcessor, stitchOrder, type StitchDeps } from './stitch.js';

// Real Postgres, ClickHouse and durable Redis. Only the readiness marker is a global name and it is
// isolated per run; everything else is namespaced by seeded store ids and removed afterwards.

loadDotEnvIfPresent('../../.env');
const clickhouse = createClickHouseClient(loadEnv(clickhouseEnvSchema));
const redis = new Redis('redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  connectTimeout: 1000,
});
const hasher = createTestIdentityHasher();
const readyKey = `test:${randomUUID()}:suppress:ready`;
const orderRepo = createOrderRepository(db);

const stitchAdd = vi.fn(async (..._a: unknown[]) => ({}) as never);
const attrAdd = vi.fn(async (..._a: unknown[]) => ({}) as never);

let A: TestTenant; // the main store
let B: TestTenant; // a second store (cross-tenant)
let C: TestTenant; // child-directed
const tenants: TestTenant[] = [];

const ORDER_TIME = new Date('2026-09-20T10:00:00.000Z');
const NOW = new Date('2026-09-28T10:00:00.000Z');
const nowSeconds = Math.floor(Date.now() / 1000);

const hash = (t: TestTenant, raw: string): string => hasher.hmac(storeContext(t.storeId), raw);
const PHONE = '+919876500001';

function deps(over: Partial<StitchDeps> = {}): StitchDeps {
  return {
    db,
    redis,
    clickhouse,
    hasher,
    now: () => NOW,
    stitchQueue: { add: stitchAdd } as unknown as StitchDeps['stitchQueue'],
    attributionQueue: { add: attrAdd } as unknown as StitchDeps['attributionQueue'],
    readyKey,
    ...over,
  };
}

let orderCounter = 0;
async function seedOrder(
  t: TestTenant,
  o: {
    phone?: string | null;
    email?: string | null;
    createdAt?: Date;
    visitorId?: string | null;
    externalOrderId?: string;
  } = {},
) {
  orderCounter += 1;
  const externalOrderId = o.externalOrderId ?? `${8000 + orderCounter}`;
  const [row] = await db
    .insert(schema.orders)
    .values({
      storeId: t.storeId,
      externalOrderId,
      createdAtPlatform: o.createdAt ?? ORDER_TIME,
      totalAmountPaise: 100000,
      currency: 'INR',
      paymentMethod: 'cod',
      phoneHashHmac: o.phone === null ? null : hash(t, o.phone ?? PHONE),
      emailHashHmac: o.email === null || o.email === undefined ? null : hash(t, o.email),
      visitorId: o.visitorId ?? null,
    })
    .returning();
  return row!;
}

async function link(
  t: TestTenant,
  visitorId: string,
  rawOrHash: string,
  firstSeen = '2026-09-20T09:00:00.000Z',
) {
  const h = rawOrHash.startsWith('k1:') ? rawOrHash : hash(t, rawOrHash);
  await ch(clickhouse, storeBoundScope(t.storeId), t.storeId).insert('identity_links', [
    {
      store_id: t.storeId,
      visitor_id: visitorId,
      identity_hash_hmac: h,
      first_seen: firstSeen,
      last_seen: firstSeen,
    },
  ]);
}

const stitch = (t: TestTenant, orderId: string, attempt: 0 | 1 | 2 = 0, d: StitchDeps = deps()) =>
  stitchOrder(d, { storeId: t.storeId, orderId, attempt } satisfies IdentityStitchJob);

const suppressSet = (
  t: TestTenant,
  kind: SuppressionSetKind,
  member: string,
  expires = nowSeconds + 10_000,
) => redis.zadd(suppressionSetKey(storeBoundScope(t.storeId), t.storeId, kind), expires, member);

const confidenceOf = async (t: TestTenant, orderId: string) =>
  (await orderRepo.getById(storeBoundScope(t.storeId), t.storeId, orderId))?.attributionConfidence;

const visitorOf = async (t: TestTenant, orderId: string) =>
  (await orderRepo.getById(storeBoundScope(t.storeId), t.storeId, orderId))?.visitorId;

beforeAll(async () => {
  A = await seedTestTenant('identity-a');
  B = await seedTestTenant('identity-b');
  C = await seedTestTenant('identity-c');
  tenants.push(A, B, C);
  await setStoreChildDirected(C.storeId, true);
  await redis.set(readyKey, String(Date.now()));
});

afterAll(async () => {
  for (const t of tenants) {
    await clickhouse.command({
      query: 'ALTER TABLE identity_links DELETE WHERE store_id = {s:UUID}',
      query_params: { s: t.storeId },
    });
    const keys = await redis.keys(`*${t.storeId}*`);
    if (keys.length > 0) await redis.del(...keys);
  }
  await redis.del(readyKey);
  for (const t of tenants) await cleanupTestTenant(t);
  redis.disconnect();
  await clickhouse.close();
});

const reset = () => {
  stitchAdd.mockClear();
  attrAdd.mockClear();
};

describe('stitchOrder — gates', () => {
  it('fails closed without the suppression marker', async () => {
    const o = await seedOrder(A);
    await expect(stitch(A, o.id, 0, deps({ readyKey: `${readyKey}:absent` }))).rejects.toThrow(
      SuppressionNotReadyError,
    );
  });

  it('skips a missing order, and an order id from another store', async () => {
    reset();
    expect((await stitch(A, randomUUID())).outcome).toEqual({
      kind: 'skipped',
      reason: 'order_missing',
    });
    const bOrder = await seedOrder(B);
    // right order id, wrong store: the store-scoped lookup finds nothing
    expect((await stitch(A, bOrder.id)).outcome).toEqual({
      kind: 'skipped',
      reason: 'order_missing',
    });
    expect(attrAdd).not.toHaveBeenCalled();
  });

  it('an anonymised order is still attributed (as Unattributed) but never stitched', async () => {
    reset();
    const o = await seedOrder(A, { phone: null, email: null });
    expect((await stitch(A, o.id)).outcome).toEqual({ kind: 'skipped', reason: 'anonymised' });
    expect(attrAdd).toHaveBeenCalledTimes(1);
    expect(stitchAdd).not.toHaveBeenCalled();
    expect(await confidenceOf(A, o.id)).toBeNull();
  });

  it('an erased identity is skipped: no attribution, no CAPI, nothing written', async () => {
    reset();
    const phone = '+919876500777';
    const o = await seedOrder(A, { phone });
    await link(A, 'v-erased-id', phone);
    await suppressSet(A, 'erased:identity', hash(A, phone));
    expect((await stitch(A, o.id)).outcome).toEqual({ kind: 'skipped', reason: 'suppressed' });
    expect(attrAdd).not.toHaveBeenCalled();
    expect(stitchAdd).not.toHaveBeenCalled();
    expect(await confidenceOf(A, o.id)).toBeNull();
    expect(await visitorOf(A, o.id)).toBeNull();
  });

  it('an erasure that lands between attempts stops the delayed attempt (no UTM fallback either)', async () => {
    reset();
    const phone = '+919876500778';
    const o = await seedOrder(A, { phone });
    expect((await stitch(A, o.id, 1)).outcome.kind).toBe('retry');
    await suppressSet(A, 'erased:identity', hash(A, phone));
    expect((await stitch(A, o.id, 2)).outcome).toEqual({ kind: 'skipped', reason: 'suppressed' });
    expect(await confidenceOf(A, o.id)).toBeNull();
    expect(attrAdd).not.toHaveBeenCalled();
  });
});

describe('stitchOrder — rule 2 (the order’s own visitor)', () => {
  it('matches via orders.visitor_id, marks high confidence, and enqueues one attribution run', async () => {
    reset();
    const o = await seedOrder(A, { visitorId: 'v-primary' });
    expect((await stitch(A, o.id)).outcome).toEqual({ kind: 'matched', via: 'order_id' });
    expect(await confidenceOf(A, o.id)).toBe('high');
    expect(attrAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = attrAdd.mock.calls[0]!;
    expect(name).toBe('incremental');
    expect(data).toEqual({ storeId: A.storeId, mode: 'incremental', orderIds: [o.id] });
    expect(opts).toMatchObject({ jobId: `attr-${o.id}`, attempts: 5 });
  });

  it('matches via the checkout: key (pixel before webhook) and records the visitor on the order', async () => {
    reset();
    const o = await seedOrder(A, { externalOrderId: '9101' });
    await redis.set(`checkout:${A.storeId}:9101`, 'v-checkout');
    expect((await stitch(A, o.id)).outcome).toEqual({ kind: 'matched', via: 'checkout_key' });
    expect(await visitorOf(A, o.id)).toBe('v-checkout');
    expect(await confidenceOf(A, o.id)).toBe('high');
  });

  it('order_id beats the checkout key, which beats the HMAC fallback', async () => {
    reset();
    const o = await seedOrder(A, { externalOrderId: '9102', visitorId: 'v-first' });
    await redis.set(`checkout:${A.storeId}:9102`, 'v-second');
    await link(A, 'v-third', PHONE);
    expect((await stitch(A, o.id)).outcome).toEqual({ kind: 'matched', via: 'order_id' });
    expect(await visitorOf(A, o.id)).toBe('v-first');
  });

  it('a suppressed primary visitor is dropped, and the order falls through to the fallback', async () => {
    reset();
    const o = await seedOrder(A, { visitorId: 'v-erased-primary', phone: '+919876500901' });
    await suppressSet(A, 'erased:visitor', hash(A, 'v-erased-primary'));
    const result = await stitch(A, o.id);
    expect(result.outcome.kind).toBe('retry'); // nothing else to match
    expect(await confidenceOf(A, o.id)).toBeNull();
  });

  it('the webhook before the pixel: attempt 0 has no match, then the pixel event lands and attempt 1 matches', async () => {
    reset();
    const o = await seedOrder(A, { phone: '+919876500902' });
    expect((await stitch(A, o.id, 0)).outcome).toMatchObject({
      kind: 'retry',
      nextAttempt: 1,
      delayMs: 300_000,
    });
    // event-workers processes checkout_completed
    await orderRepo.linkVisitorIfUnset(storeBoundScope(A.storeId), A.storeId, o.id, 'v-late');
    expect((await stitch(A, o.id, 1)).outcome).toEqual({ kind: 'matched', via: 'order_id' });
  });
});

describe('stitchOrder — rule 3 (HMAC fallback)', () => {
  it('matches a visitor linked to the order’s phone, links the other hash too, and leaves visitor_id alone', async () => {
    reset();
    const phone = '+919876500910';
    const email = 'fallback@example.com';
    const o = await seedOrder(A, { phone, email });
    await link(A, 'v-linked', phone);

    const result = await stitch(A, o.id);
    expect(result.outcome).toEqual({ kind: 'matched', via: 'identity_hash' });
    expect(await confidenceOf(A, o.id)).toBe('high');
    expect(await visitorOf(A, o.id)).toBeNull();

    // the email hash now also points at that visitor
    const emailHash = hash(A, email);
    const rows = await ch(clickhouse, storeBoundScope(A.storeId), A.storeId).select<{
      visitor_id: string;
    }>({
      table: 'identity_links',
      columns: ['visitor_id'],
      where: { identity_hash_hmac: { op: 'IN', value: [emailHash], type: 'Array(String)' } },
      final: true,
    });
    expect(rows.map((r) => r.visitor_id)).toEqual(['v-linked']);
  });

  it('is phone first: email links are used only when the phone has none', async () => {
    const phone = '+919876500911';
    const email = 'phonefirst@example.com';
    const o = await seedOrder(A, { phone, email });
    await link(A, 'v-by-phone', phone);
    await link(A, 'v-by-email', email);
    const both = await findLinkedVisitors(deps() as IdentityDeps, o);
    expect(both.visitors.map((v) => v.visitorId)).toEqual(['v-by-phone']);

    const o2 = await seedOrder(A, { phone: '+919876500912', email });
    const emailOnly = await findLinkedVisitors(deps() as IdentityDeps, o2);
    expect(emailOnly.visitors.map((v) => v.visitorId)).toEqual(['v-by-email']);
  });

  it('excludes visitors whose activity started after the order, and suppressed visitors', async () => {
    const phone = '+919876500913';
    const o = await seedOrder(A, { phone });
    await link(A, 'v-before', phone, '2026-09-20T09:59:59.000Z');
    await link(A, 'v-after', phone, '2026-09-20T10:00:01.000Z');
    await link(A, 'v-withdrawn', phone, '2026-09-20T09:00:00.000Z');
    await suppressSet(A, 'withdrawn:visitor', hash(A, 'v-withdrawn'));
    await link(A, 'v-erased', phone, '2026-09-20T09:00:00.000Z');
    await suppressSet(A, 'erased:visitor', hash(A, 'v-erased'));

    const found = await findLinkedVisitors(deps() as IdentityDeps, o);
    expect(found.visitors.map((v) => v.visitorId)).toEqual(['v-before']);
  });

  it('never links across stores: the same phone hashes differently per store', async () => {
    const phone = '+919876500914';
    expect(hash(A, phone)).not.toBe(hash(B, phone));
    await link(B, 'v-other-store', phone);
    const o = await seedOrder(A, { phone });
    const found = await findLinkedVisitors(deps() as IdentityDeps, o);
    expect(found.visitors).toEqual([]);
  });

  it(`ignores a hash linked to more than ${IDENTITY_GUARD.maxVisitorsPerHash} visitors (shared/dummy identifier)`, async () => {
    const phone = '+919876500915';
    const o = await seedOrder(A, { phone });
    for (let i = 0; i < IDENTITY_GUARD.maxVisitorsPerHash; i += 1)
      await link(A, `v-shared-${i}`, phone);
    expect((await findLinkedVisitors(deps() as IdentityDeps, o)).visitors).toHaveLength(
      IDENTITY_GUARD.maxVisitorsPerHash,
    );

    await link(A, 'v-shared-extra', phone); // the 21st
    const tripped = await findLinkedVisitors(deps() as IdentityDeps, o);
    expect(tripped.visitors).toEqual([]);
    expect(tripped.guardRejected).toBe(true);
    // an ignored hash matched nothing: the order goes on to retry, not to a wrong visitor
    expect((await stitch(A, o.id)).outcome.kind).toBe('retry');
  });

  it(`ignores a hash on more than ${IDENTITY_GUARD.maxOrdersPerHash} orders in ${IDENTITY_GUARD.ordersWindowDays} days`, async () => {
    const phone = '+919876500916';
    const recent = new Date(NOW.getTime() - 5 * 86_400_000);
    const first = await seedOrder(A, { phone, createdAt: recent });
    await link(A, 'v-courier', phone, new Date(recent.getTime() - 3600_000).toISOString());
    for (let i = 1; i < IDENTITY_GUARD.maxOrdersPerHash; i += 1)
      await seedOrder(A, { phone, createdAt: recent });
    expect((await findLinkedVisitors(deps() as IdentityDeps, first)).visitors).toHaveLength(1); // exactly 50

    await seedOrder(A, { phone, createdAt: recent }); // the 51st
    const tripped = await findLinkedVisitors(deps() as IdentityDeps, first);
    expect(tripped.visitors).toEqual([]);
    expect(tripped.guardRejected).toBe(true);
  });

  it('a child-directed store skips the HMAC fallback entirely', async () => {
    reset();
    const phone = '+919876500917';
    const o = await seedOrder(C, { phone });
    await link(C, 'v-child', phone);
    expect((await stitch(C, o.id)).outcome.kind).toBe('retry');
    expect(await resolveJourneyVisitors(deps() as IdentityDeps, o)).toEqual({
      visitorIds: [],
      via: 'none',
    });
  });
});

describe('stitchOrder — no match', () => {
  it('retries at +5 min then +30 min, then falls back to UTMs with low confidence and one attribution run', async () => {
    reset();
    const o = await seedOrder(A, { phone: '+919876500920' });

    expect((await stitch(A, o.id, 0)).outcome).toEqual({
      kind: 'retry',
      nextAttempt: 1,
      delayMs: 300_000,
    });
    expect(stitchAdd).toHaveBeenLastCalledWith(
      'stitch',
      { storeId: A.storeId, orderId: o.id, attempt: 1 },
      expect.objectContaining({ jobId: `stitch:${o.id}:1`, delay: 300_000, attempts: 5 }),
    );
    expect((await stitch(A, o.id, 1)).outcome).toEqual({
      kind: 'retry',
      nextAttempt: 2,
      delayMs: 1_800_000,
    });
    expect(stitchAdd).toHaveBeenLastCalledWith(
      'stitch',
      { storeId: A.storeId, orderId: o.id, attempt: 2 },
      expect.objectContaining({ jobId: `stitch:${o.id}:2`, delay: 1_800_000 }),
    );
    expect(attrAdd).not.toHaveBeenCalled(); // nothing downstream while retrying
    expect(await confidenceOf(A, o.id)).toBeNull();

    expect((await stitch(A, o.id, 2)).outcome).toEqual({ kind: 'utm_fallback' });
    expect(await confidenceOf(A, o.id)).toBe('low');
    expect(attrAdd).toHaveBeenCalledTimes(1);
    expect(stitchAdd).toHaveBeenCalledTimes(2); // no attempt 3
  });

  it('never downgrades: a backfill re-run at attempt 2 leaves a high-confidence order high', async () => {
    reset();
    const o = await seedOrder(A, { phone: '+919876500922' });
    await orderRepo.setAttributionConfidence(storeBoundScope(A.storeId), A.storeId, o.id, 'high');
    // the visitor since became unreachable (nothing links to the order), so attempt 2 finds no match
    expect((await stitch(A, o.id, 2)).outcome).toEqual({ kind: 'utm_fallback' });
    expect(await confidenceOf(A, o.id)).toBe('high');
    expect(attrAdd).toHaveBeenCalledTimes(1); // attribution still runs
  });

  it('a later match upgrades a low-confidence order to high', async () => {
    const phone = '+919876500921';
    const o = await seedOrder(A, { phone });
    await stitch(A, o.id, 2);
    expect(await confidenceOf(A, o.id)).toBe('low');
    await link(A, 'v-arrives-late', phone);
    await stitch(A, o.id, 2);
    expect(await confidenceOf(A, o.id)).toBe('high');
  });
});

describe('resolveJourneyVisitors', () => {
  it('cross-device: the primary visitor first, then the visitor linked through the same phone', async () => {
    const phone = '+919876500930';
    const o = await seedOrder(A, { phone, visitorId: 'v-desktop' });
    await link(A, 'v-mobile-inapp', phone);
    await link(A, 'v-desktop', phone);
    const journey = await resolveJourneyVisitors(deps() as IdentityDeps, o);
    expect(journey).toEqual({ visitorIds: ['v-desktop', 'v-mobile-inapp'], via: 'order_id' });
  });

  it('via is identity_hash with only fallback visitors, and none with nothing', async () => {
    const phone = '+919876500931';
    const o = await seedOrder(A, { phone });
    expect(await resolveJourneyVisitors(deps() as IdentityDeps, o)).toEqual({
      visitorIds: [],
      via: 'none',
    });
    await link(A, 'v-only-fallback', phone);
    expect(await resolveJourneyVisitors(deps() as IdentityDeps, o)).toEqual({
      visitorIds: ['v-only-fallback'],
      via: 'identity_hash',
    });
  });

  it(`caps at ${MAX_JOURNEY_VISITORS} visitors: the primary plus the most recently seen`, async () => {
    const phone = '+919876500932';
    const o = await seedOrder(A, { phone, visitorId: 'v-primary-cap' });
    for (let i = 0; i < 15; i += 1) {
      // v-cap-00 is the oldest, v-cap-14 the most recent
      await link(
        A,
        `v-cap-${String(i).padStart(2, '0')}`,
        phone,
        new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
      );
    }
    const journey = await resolveJourneyVisitors(deps() as IdentityDeps, o);
    expect(journey.visitorIds).toHaveLength(MAX_JOURNEY_VISITORS);
    expect(journey.visitorIds[0]).toBe('v-primary-cap');
    expect(journey.visitorIds.slice(1)).toEqual(
      Array.from({ length: 9 }, (_, i) => `v-cap-${String(14 - i).padStart(2, '0')}`),
    );
  });

  it('drops a suppressed primary visitor', async () => {
    const o = await seedOrder(A, { visitorId: 'v-primary-erased', phone: '+919876500933' });
    await suppressSet(A, 'erased:visitor', hash(A, 'v-primary-erased'));
    expect((await resolveJourneyVisitors(deps() as IdentityDeps, o)).visitorIds).toEqual([]);
  });
});

describe('processor', () => {
  const job = (data: IdentityStitchJob) =>
    ({ data, moveToDelayed: vi.fn(async () => undefined) }) as unknown as Job<IdentityStitchJob> & {
      moveToDelayed: ReturnType<typeof vi.fn>;
    };

  it('returns only the outcome kind (no visitor ids in the stored job result) and logs no identifiers', async () => {
    const logs: Record<string, unknown>[] = [];
    const o = await seedOrder(A, { visitorId: 'v-secret-visitor' });
    const process = createIdentityStitchProcessor(deps(), (l) => logs.push(l));
    const result = await process(job({ storeId: A.storeId, orderId: o.id, attempt: 0 }), 'tok');
    expect(result).toEqual({ kind: 'matched' });
    const text = JSON.stringify(logs);
    expect(text).not.toContain('v-secret-visitor');
    expect(text).not.toContain(o.id);
    expect(logs[0]).toMatchObject({
      event: 'identity_stitch',
      outcome: 'matched',
      via: 'order_id',
    });
  });

  it('puts the job back (delayed, not failed) while suppression is unavailable', async () => {
    const o = await seedOrder(A);
    const j = job({ storeId: A.storeId, orderId: o.id, attempt: 0 });
    const process = createIdentityStitchProcessor(
      deps({ readyKey: `${readyKey}:absent` }),
      () => undefined,
    );
    await expect(process(j, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(j.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'tok');
  });

  it('rejects a malformed payload', async () => {
    const process = createIdentityStitchProcessor(deps(), () => undefined);
    await expect(
      process(
        job({ storeId: 'x', orderId: 'y', attempt: 7 } as unknown as IdentityStitchJob),
        'tok',
      ),
    ).rejects.toThrow();
  });
});
