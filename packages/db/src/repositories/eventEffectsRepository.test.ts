import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { TenantScopeViolationError, type TenantScope } from '@truepath/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '../testing.js';
import {
  auditLog,
  consentRecords,
  dsrRequests,
  orders,
  suppressedIdentities,
} from '../schema/index.js';
import { jobScope } from '../jobScope.js';
import {
  createEventEffectsRepository,
  type ApplyEventEffectsInput,
} from './eventEffectsRepository.js';

const repo = createEventEffectsRepository(db);
const HMAC = (n: number): string => `k1:${n.toString(16).padStart(64, '0')}`;
const NOW = new Date('2026-09-28T10:00:00.000Z');
const EXPIRES = new Date('2027-10-28T10:00:00.000Z');
const DUE = new Date('2026-09-29T10:00:00.000Z');

let tenant: TestTenant;
let other: TestTenant;
let scope: TenantScope;

beforeAll(async () => {
  tenant = await seedTestTenant('effects');
  other = await seedTestTenant('effects-other');
  scope = jobScope(tenant.organizationId, tenant.storeId);
});

afterAll(async () => {
  await cleanupTestTenant(tenant);
  await cleanupTestTenant(other);
});

function input(overrides: Partial<ApplyEventEffectsInput> = {}): ApplyEventEffectsInput {
  return {
    storeId: tenant.storeId,
    now: NOW,
    consentRecords: [],
    consentChanges: [],
    suppressionHits: [],
    checkoutLinks: [],
    suppressionExpiresAt: EXPIRES,
    withdrawalDueAt: DUE,
    ...overrides,
  };
}

const suppressionRows = (identifier: string) =>
  db
    .select()
    .from(suppressedIdentities)
    .where(
      and(
        eq(suppressedIdentities.storeId, tenant.storeId),
        eq(suppressedIdentities.identifier, identifier),
      ),
    );

describe('EventEffectsRepository.applyStoreEffects', () => {
  it('inserts consent records idempotently (ON CONFLICT (id) DO NOTHING)', async () => {
    const id = randomUUID();
    const record = {
      id,
      visitorHmac: HMAC(1),
      purposes: ['attribution_analytics'],
      state: 'granted' as const,
      noticeVersion: 'v1',
      source: 'pixel_interaction' as const,
      occurredAt: NOW,
    };
    await repo.applyStoreEffects(scope, input({ consentRecords: [record] }));
    await repo.applyStoreEffects(scope, input({ consentRecords: [record] }));

    const rows = await db.select().from(consentRecords).where(eq(consentRecords.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      storeId: tenant.storeId,
      visitorId: HMAC(1),
      purposes: ['attribution_analytics'],
      state: 'granted',
      noticeVersion: 'v1',
      source: 'pixel_interaction',
    });
  });

  it('a withdrawal creates the withdrawn suppression, the erasure request and its audit row — once, even if redelivered', async () => {
    const eventId = randomUUID();
    const change = { kind: 'withdraw' as const, eventId, visitorHmac: HMAC(2) };

    const first = await repo.applyStoreEffects(scope, input({ consentChanges: [change] }));
    const again = await repo.applyStoreEffects(scope, input({ consentChanges: [change] }));

    expect(first.withdrawalRequests).toHaveLength(1);
    expect(again.withdrawalRequests[0]!.requestId).toBe(first.withdrawalRequests[0]!.requestId);
    const requestId = first.withdrawalRequests[0]!.requestId;

    const [request] = await db.select().from(dsrRequests).where(eq(dsrRequests.id, requestId));
    expect(request).toMatchObject({
      storeId: tenant.storeId,
      type: 'erasure',
      identityHash: HMAC(2),
      status: 'pending',
      requestedByUserId: null,
      resultSummary: { trigger: 'consent_withdrawn', source_ref: `withdrawal:${eventId}` },
    });
    expect(request!.dueAt.toISOString()).toBe(DUE.toISOString());

    const suppression = await suppressionRows(HMAC(2));
    expect(suppression).toHaveLength(1);
    expect(suppression[0]).toMatchObject({
      identifierType: 'visitor_id',
      reason: 'withdrawn',
      dsrRequestId: requestId,
    });
    expect(suppression[0]!.expiresAt.toISOString()).toBe(EXPIRES.toISOString());

    const audits = (
      await db.select().from(auditLog).where(eq(auditLog.organizationId, tenant.organizationId))
    ).filter((a) => a.targetId === requestId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'dsr_created',
      actorType: 'system',
      metadata: { type: 'erasure', trigger: 'consent_withdrawn' },
    });
  });

  it('applies consent changes in order: withdraw then re-grant leaves no withdrawn entry; grant never lifts erased', async () => {
    const visitor = HMAC(3);
    await db.insert(suppressedIdentities).values({
      storeId: tenant.storeId,
      identifierType: 'visitor_id',
      identifier: HMAC(4),
      reason: 'erased',
      expiresAt: EXPIRES,
    });

    await repo.applyStoreEffects(
      scope,
      input({
        consentChanges: [
          { kind: 'withdraw', eventId: randomUUID(), visitorHmac: visitor },
          { kind: 'grant', visitorHmacs: [visitor] },
          { kind: 'grant', visitorHmacs: [HMAC(4)] },
        ],
      }),
    );

    expect(await suppressionRows(visitor)).toHaveLength(0);
    expect(await suppressionRows(HMAC(4))).toMatchObject([{ reason: 'erased' }]);
  });

  it('a grant removes a withdrawn entry stored under any listed key version', async () => {
    const old = `k1:${'a'.repeat(64)}`; // written under an older key version than HMAC(99)
    await db.insert(suppressedIdentities).values({
      storeId: tenant.storeId,
      identifierType: 'visitor_id',
      identifier: old,
      reason: 'withdrawn',
      expiresAt: EXPIRES,
    });
    await repo.applyStoreEffects(
      scope,
      input({ consentChanges: [{ kind: 'grant', visitorHmacs: [HMAC(99), old] }] }),
    );
    expect(await suppressionRows(old)).toHaveLength(0);
  });

  it('a suppression hit erases the new visitor and points at the erasure request of the matched identity', async () => {
    const [erasure] = await db
      .insert(dsrRequests)
      .values({ storeId: tenant.storeId, type: 'erasure', identityHash: HMAC(5), dueAt: DUE })
      .returning({ id: dsrRequests.id });
    await db.insert(suppressedIdentities).values({
      storeId: tenant.storeId,
      identifierType: 'identity_hash_hmac',
      identifier: HMAC(5),
      reason: 'erased',
      dsrRequestId: erasure!.id,
      expiresAt: EXPIRES,
    });

    const result = await repo.applyStoreEffects(
      scope,
      input({
        suppressionHits: [
          { visitorHmac: HMAC(6), identityHash: HMAC(5) },
          { visitorHmac: HMAC(7), identityHash: HMAC(8) }, // no matching identity entry
        ],
      }),
    );

    const [row6] = await suppressionRows(HMAC(6));
    expect(result.suppressionHitRequests).toEqual([
      { visitorHmac: HMAC(6), requestId: erasure!.id, suppressionId: row6!.id },
      {
        visitorHmac: HMAC(7),
        requestId: null,
        suppressionId: (await suppressionRows(HMAC(7)))[0]!.id,
      },
    ]);
    expect(row6).toMatchObject({
      identifierType: 'visitor_id',
      reason: 'erased',
      dsrRequestId: erasure!.id,
    });
    expect(await suppressionRows(HMAC(7))).toMatchObject([
      { reason: 'erased', dsrRequestId: null },
    ]);

    // redelivery inserts nothing new and reports the same suppression row (so the job id is stable)
    const again = await repo.applyStoreEffects(
      scope,
      input({ suppressionHits: [{ visitorHmac: HMAC(6), identityHash: HMAC(5) }] }),
    );
    expect(await suppressionRows(HMAC(6))).toHaveLength(1);
    expect(again.suppressionHitRequests[0]!.suppressionId).toBe(row6!.id);
  });

  it('links a checkout_completed to its order only while orders.visitor_id is still null', async () => {
    const insertOrder = (externalOrderId: string, visitorId: string | null) =>
      db.insert(orders).values({
        storeId: tenant.storeId,
        externalOrderId,
        createdAtPlatform: NOW,
        totalAmountPaise: 100,
        currency: 'INR',
        paymentMethod: 'prepaid',
        visitorId,
      });
    await insertOrder('9001', null);
    await insertOrder('9002', 'existing-visitor');

    const result = await repo.applyStoreEffects(
      scope,
      input({
        checkoutLinks: [
          { externalOrderId: '9001', visitorId: 'v-new' },
          { externalOrderId: '9002', visitorId: 'v-new' },
          { externalOrderId: '9003', visitorId: 'v-new' }, // the order webhook hasn't arrived yet
        ],
      }),
    );

    expect(result.ordersLinked).toBe(1);
    const visitorOf = async (id: string) =>
      (
        await db
          .select({ v: orders.visitorId })
          .from(orders)
          .where(and(eq(orders.storeId, tenant.storeId), eq(orders.externalOrderId, id)))
      )[0]?.v;
    expect(await visitorOf('9001')).toBe('v-new');
    expect(await visitorOf('9002')).toBe('existing-visitor');
  });

  it('rolls the whole batch back if any statement fails (nothing half-applied)', async () => {
    const id = randomUUID();
    await expect(
      repo.applyStoreEffects(
        scope,
        input({
          consentRecords: [
            {
              id,
              visitorHmac: HMAC(10),
              purposes: [],
              state: 'granted',
              noticeVersion: 'v1',
              source: 'pixel_interaction',
              occurredAt: NOW,
            },
          ],
          // A hit is fine, but an audit-invalid state can't be forced here, so break the store lookup:
          consentChanges: [{ kind: 'withdraw', eventId: randomUUID(), visitorHmac: HMAC(11) }],
          suppressionExpiresAt: new Date('invalid'),
        }),
      ),
    ).rejects.toThrow();
    expect(await db.select().from(consentRecords).where(eq(consentRecords.id, id))).toHaveLength(0);
    expect(await suppressionRows(HMAC(11))).toHaveLength(0);
  });

  it("refuses a scope that doesn't cover the store (ADR-0016)", async () => {
    await expect(
      repo.applyStoreEffects(jobScope(other.organizationId, other.storeId), input()),
    ).rejects.toThrow(TenantScopeViolationError);
  });
});
