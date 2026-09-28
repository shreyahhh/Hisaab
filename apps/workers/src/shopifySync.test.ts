import type { Job } from 'bullmq';
import { cleanupTestTenant, db, seedTestTenant } from '@truepath/db/testing';
import { createIntegrationRepository, jobScope, schema } from '@truepath/db';
import {
  ShopifyUnauthorizedError,
  type ShopifyAdapter,
  type ShopifyBulkOperation,
  type ShopifyBulkOrderLine,
  type ShopifyCredentials,
  type ShopifyOrderSnapshot,
} from '@truepath/integrations';
import { storeContext } from '@truepath/privacy';
import { createTestCredentialsCipher, createTestIdentityHasher } from '@truepath/privacy/testing';
import type { ShopifySyncJob, TenantScope } from '@truepath/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShopifySyncProcessor, type ShopifySyncDeps } from './shopifySync.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function ownerScope(organizationId: string, storeId: string, userId: string): TenantScope {
  return { kind: 'tenant', userId, organizationId, role: 'owner', storeIds: new Set([storeId]) };
}

function job(data: ShopifySyncJob): Job<ShopifySyncJob> {
  return { data } as Job<ShopifySyncJob>;
}

const CREDENTIALS: ShopifyCredentials = {
  accessToken: 'shpat_test',
  accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  refreshToken: 'shprt_test',
  refreshTokenExpiresAt: new Date(Date.now() + 7_776_000_000).toISOString(),
  scope: 'read_orders,write_pixels,read_customer_events',
};

const cipher = createTestCredentialsCipher();
const hasher = createTestIdentityHasher();

interface FakeAdapterOptions {
  readonly startBulkOrders?: ReturnType<typeof vi.fn>;
  readonly refresh?: ReturnType<typeof vi.fn>;
  readonly bulkOperation?: ReturnType<typeof vi.fn>;
  readonly lines?: readonly ShopifyBulkOrderLine[];
}

function fakeAdapter(options: FakeAdapterOptions = {}) {
  const startBulkOrders =
    options.startBulkOrders ?? vi.fn().mockResolvedValue('gid://shopify/BulkOperation/1');
  const refresh = options.refresh ?? vi.fn().mockRejectedValue(new Error('not used'));
  const bulkOperation = options.bulkOperation ?? vi.fn().mockRejectedValue(new Error('not used'));
  const streamBulkOrders = vi.fn(async function* () {
    for (const line of options.lines ?? []) yield line;
  });
  const adapter: ShopifyAdapter = {
    provider: 'shopify',
    authUrl: () => '',
    exchangeCode: () => Promise.reject(new Error('not used')),
    refresh,
    shopInfo: () => Promise.reject(new Error('not used')),
    healthCheck: () => Promise.resolve({ healthy: true }),
    verifyWebhook: () => true,
    fetchOrder: () => Promise.reject(new Error('not used')),
    startBulkOrders,
    bulkOperation,
    streamBulkOrders,
    upsertWebPixel: () => Promise.reject(new Error('not used')),
  };
  return { adapter, startBulkOrders, refresh, bulkOperation, streamBulkOrders };
}

// No shopper is erased and no stitch queue is real unless a test says so.
const noSuppression = { zscore: async () => null };
function depsFor(adapter: ShopifyAdapter, over: Partial<ShopifySyncDeps> = {}): ShopifySyncDeps {
  return {
    db,
    adapter,
    cipher,
    hasher,
    redis: noSuppression,
    identityStitchQueue: {
      addBulk: vi.fn(async () => []),
    } as unknown as ShopifySyncDeps['identityStitchQueue'],
    ...over,
  };
}

async function connectStore(tenant: { organizationId: string; storeId: string; userId: string }) {
  const scope = ownerScope(tenant.organizationId, tenant.storeId, tenant.userId);
  const repo = createIntegrationRepository(db);
  await repo.upsertShopify(scope, {
    storeId: tenant.storeId,
    externalAccountId: 'gid://shopify/Shop/1',
    credentialsJson: JSON.stringify(CREDENTIALS),
    scopes: ['read_orders'],
    cipher,
  });
  return { scope, repo };
}

async function backfillSettings(tenant: {
  organizationId: string;
  storeId: string;
}): Promise<Record<string, unknown>> {
  const row = await createIntegrationRepository(db).getActiveByStore(
    jobScope(tenant.organizationId, tenant.storeId),
    tenant.storeId,
    'shopify',
  );
  return ((row?.settings ?? {}) as { backfill?: Record<string, unknown> }).backfill ?? {};
}

// Filtered in JS rather than with drizzle's `eq`: apps/workers does not depend on drizzle-orm, and a
// new dependency needs approval (CLAUDE.md). These are tiny per-test tenants, so the read is cheap.
async function ordersOf(storeId: string) {
  return (await db.select().from(schema.orders)).filter((o) => o.storeId === storeId);
}

function snapshot(overrides: Partial<ShopifyOrderSnapshot> = {}): ShopifyOrderSnapshot {
  return {
    externalOrderId: '5001',
    createdAtPlatform: '2026-09-20T10:00:00Z',
    updatedAtPlatform: '2026-09-20T10:05:00Z',
    cancelledAt: null,
    currency: 'INR',
    totalPrice: '1299.00',
    totalRefunded: '0.00',
    totalOutstanding: '0.00',
    financialStatus: 'PAID',
    fulfillmentStatus: 'UNFULFILLED',
    paymentGatewayNames: ['razorpay'],
    email: null,
    phone: null,
    shippingAddressZip: '560001',
    landingSite: null,
    referringSite: null,
    noteAttributes: [],
    discountCodes: [],
    ...overrides,
  };
}

const orderLine = (overrides: Partial<ShopifyOrderSnapshot> = {}): ShopifyBulkOrderLine => ({
  kind: 'order',
  snapshot: snapshot(overrides),
});

const COMPLETED: ShopifyBulkOperation = {
  id: 'gid://shopify/BulkOperation/1',
  status: 'COMPLETED',
  errorCode: null,
  rootObjectCount: 2,
  url: 'https://storage.example.com/result.jsonl',
  partialDataUrl: null,
};

describe('shopify-sync processor — mode: backfill (shopify-integration.md §4.7)', () => {
  it('decrypts the store credentials and starts a bulk query for the last N days', async () => {
    const tenant = await seedTestTenant('shopify-sync-backfill');
    try {
      await connectStore(tenant);
      const { adapter, startBulkOrders } = fakeAdapter();
      const before = Date.now();

      await createShopifySyncProcessor(depsFor(adapter))(
        job({ storeId: tenant.storeId, mode: 'backfill', days: 60 }),
      );

      expect(startBulkOrders).toHaveBeenCalledTimes(1);
      const [shop, creds, sinceIso] = startBulkOrders.mock.calls[0]!;
      expect(shop).toMatch(/\.myshopify\.com$/);
      expect(creds).toEqual(CREDENTIALS);
      const sinceMs = new Date(sinceIso as string).getTime();
      const expectedMs = before - 60 * 24 * 60 * 60 * 1000;
      expect(Math.abs(sinceMs - expectedMs)).toBeLessThan(5000);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('defaults to 60 days when the job carries no `days`', async () => {
    const tenant = await seedTestTenant('shopify-sync-backfill-default-days');
    try {
      await connectStore(tenant);
      const { adapter, startBulkOrders } = fakeAdapter();
      const before = Date.now();

      await createShopifySyncProcessor(depsFor(adapter))(
        job({ storeId: tenant.storeId, mode: 'backfill' }),
      );

      const [, , sinceIso] = startBulkOrders.mock.calls[0]!;
      const sinceMs = new Date(sinceIso as string).getTime();
      expect(Math.abs(sinceMs - (before - 60 * 24 * 60 * 60 * 1000))).toBeLessThan(5000);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('is a no-op when the store no longer exists', async () => {
    const { adapter, startBulkOrders } = fakeAdapter();

    await createShopifySyncProcessor(depsFor(adapter))(
      job({ storeId: '00000000-0000-0000-0000-000000000000', mode: 'backfill' }),
    );

    expect(startBulkOrders).not.toHaveBeenCalled();
  });

  it('throws when the store has no active Shopify integration', async () => {
    const tenant = await seedTestTenant('shopify-sync-backfill-no-integration');
    try {
      const { adapter } = fakeAdapter();

      await expect(
        createShopifySyncProcessor(depsFor(adapter))(
          job({ storeId: tenant.storeId, mode: 'backfill' }),
        ),
      ).rejects.toThrow('no active Shopify integration');
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('records settings.backfill as running, with the bulk operation id, so bulk_result can be tied to it', async () => {
    const tenant = await seedTestTenant('shopify-sync-backfill-state');
    try {
      await connectStore(tenant);
      const { adapter } = fakeAdapter();
      await createShopifySyncProcessor(depsFor(adapter))(
        job({ storeId: tenant.storeId, mode: 'backfill', days: 60 }),
      );
      expect(await backfillSettings(tenant)).toMatchObject({
        days: 60,
        status: 'running',
        bulk_operation_id: 'gid://shopify/BulkOperation/1',
      });
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('on a 401 refreshes once, stores the rotated credentials, and retries with them', async () => {
    const tenant = await seedTestTenant('shopify-sync-backfill-refresh');
    try {
      const { repo, scope } = await connectStore(tenant);
      const refreshed: ShopifyCredentials = { ...CREDENTIALS, accessToken: 'shpat_rotated' };
      const startBulkOrders = vi
        .fn()
        .mockRejectedValueOnce(new ShopifyUnauthorizedError())
        .mockResolvedValueOnce('gid://shopify/BulkOperation/7');
      const refresh = vi.fn().mockResolvedValue(refreshed);
      const { adapter } = fakeAdapter({ startBulkOrders, refresh });

      await createShopifySyncProcessor(depsFor(adapter))(
        job({ storeId: tenant.storeId, mode: 'backfill' }),
      );

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(startBulkOrders).toHaveBeenCalledTimes(2);
      expect(startBulkOrders.mock.calls[1]![1]).toEqual(refreshed);
      const stored = await repo.getActiveByStore(scope, tenant.storeId, 'shopify');
      const decrypted = JSON.parse(
        cipher.decrypt({ integrationId: stored!.id }, stored!.encryptedCredentials!),
      ) as ShopifyCredentials;
      expect(decrypted.accessToken).toBe('shpat_rotated');
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('does not treat a non-401 failure as a refresh case', async () => {
    const tenant = await seedTestTenant('shopify-sync-backfill-nonauth-error');
    try {
      await connectStore(tenant);
      const refresh = vi.fn();
      const { adapter } = fakeAdapter({
        startBulkOrders: vi.fn().mockRejectedValue(new Error('boom')),
        refresh,
      });
      await expect(
        createShopifySyncProcessor(depsFor(adapter))(
          job({ storeId: tenant.storeId, mode: 'backfill' }),
        ),
      ).rejects.toThrow('boom');
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      await cleanupTestTenant(tenant);
    }
  });
});

describe('shopify-sync processor — mode: bulk_result (shopify-integration.md §4.7)', () => {
  const bulkJob = (storeId: string) =>
    job({ storeId, mode: 'bulk_result', bulkOperationId: COMPLETED.id });

  it('streams the result into orders, hashing identifiers, and marks the backfill done', async () => {
    const tenant = await seedTestTenant('shopify-sync-bulk-apply');
    try {
      await connectStore(tenant);
      const { adapter, bulkOperation } = fakeAdapter({
        bulkOperation: vi.fn().mockResolvedValue(COMPLETED),
        lines: [
          orderLine({
            externalOrderId: '5001',
            phone: '+918123456709',
            email: 'Shopper@Example.com',
          }),
          orderLine({
            externalOrderId: '5002',
            paymentGatewayNames: ['Cash on Delivery (COD)'],
            totalPrice: '499.50',
          }),
        ],
      });

      await createShopifySyncProcessor(depsFor(adapter))(bulkJob(tenant.storeId));

      expect(bulkOperation).toHaveBeenCalledTimes(1);
      const rows = await ordersOf(tenant.storeId);
      expect(rows.map((r) => r.externalOrderId).sort()).toEqual(['5001', '5002']);
      const first = rows.find((r) => r.externalOrderId === '5001')!;
      expect(first.totalAmountPaise).toBe(129900);
      expect(first.pincodePrefix).toBe('560');
      // Identifiers are stored only as versioned HMACs (SPEC §5.4) — never the raw value.
      expect(first.phoneHashHmac).toMatch(/^k1:[0-9a-f]{64}$/);
      expect(first.emailHashHmac).toMatch(/^k1:[0-9a-f]{64}$/);
      expect(JSON.stringify(rows)).not.toMatch(/8123456709|shopper@example\.com/i);
      const second = rows.find((r) => r.externalOrderId === '5002')!;
      expect(second.totalAmountPaise).toBe(49950);
      expect(second.paymentMethod).toBe('cod');
      expect(await backfillSettings(tenant)).toMatchObject({
        status: 'done',
        orders_applied: 2,
        orders_reported: 2,
        invalid_lines: 0,
      });
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('is idempotent: re-running the same result adds no orders and no event rows', async () => {
    const tenant = await seedTestTenant('shopify-sync-bulk-idempotent');
    try {
      await connectStore(tenant);
      const { adapter } = fakeAdapter({
        bulkOperation: vi.fn().mockResolvedValue(COMPLETED),
        lines: [orderLine({ externalOrderId: '6001' }), orderLine({ externalOrderId: '6002' })],
      });
      const process = createShopifySyncProcessor(depsFor(adapter));

      await process(bulkJob(tenant.storeId));
      await process(bulkJob(tenant.storeId));

      const rows = await ordersOf(tenant.storeId);
      expect(rows).toHaveLength(2);
      const events = (await db.select().from(schema.orderStatusEvents)).filter(
        (e) => e.orderId === rows[0]!.id,
      );
      expect(events).toHaveLength(1);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('skips non-INR orders (no FX handling in the MVP) but still finishes', async () => {
    const tenant = await seedTestTenant('shopify-sync-bulk-non-inr');
    try {
      await connectStore(tenant);
      const { adapter } = fakeAdapter({
        bulkOperation: vi.fn().mockResolvedValue(COMPLETED),
        lines: [
          orderLine({ externalOrderId: '7001', currency: 'USD' }),
          orderLine({ externalOrderId: '7002' }),
        ],
      });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await createShopifySyncProcessor(depsFor(adapter))(bulkJob(tenant.storeId));

      expect((await ordersOf(tenant.storeId)).map((r) => r.externalOrderId)).toEqual(['7002']);
      expect(await backfillSettings(tenant)).toMatchObject({
        status: 'done',
        orders_applied: 1,
      });
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('applies the valid lines, then fails the job and the backfill when any line is unreadable', async () => {
    const tenant = await seedTestTenant('shopify-sync-bulk-invalid-lines');
    try {
      await connectStore(tenant);
      const { adapter } = fakeAdapter({
        bulkOperation: vi.fn().mockResolvedValue(COMPLETED),
        lines: [orderLine({ externalOrderId: '8001' }), { kind: 'invalid' }],
      });

      await expect(
        createShopifySyncProcessor(depsFor(adapter))(bulkJob(tenant.storeId)),
      ).rejects.toThrow('1 unreadable line(s)');

      expect(await ordersOf(tenant.storeId)).toHaveLength(1);
      expect(await backfillSettings(tenant)).toMatchObject({
        status: 'failed',
        error_code: 'invalid_lines',
        orders_applied: 1,
        invalid_lines: 1,
      });
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('finishes with zero orders when the query matched nothing (no result URL)', async () => {
    const tenant = await seedTestTenant('shopify-sync-bulk-empty');
    try {
      await connectStore(tenant);
      const { adapter, streamBulkOrders } = fakeAdapter({
        bulkOperation: vi.fn().mockResolvedValue({ ...COMPLETED, url: null }),
      });
      await createShopifySyncProcessor(depsFor(adapter))(bulkJob(tenant.storeId));
      expect(streamBulkOrders).not.toHaveBeenCalled();
      expect(await backfillSettings(tenant)).toMatchObject({
        status: 'done',
        orders_applied: 0,
      });
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it.each([
    ['FAILED', 'ACCESS_DENIED', 'ACCESS_DENIED'],
    ['CANCELED', null, 'canceled'],
    ['EXPIRED', null, 'expired'],
  ] as const)(
    'marks the backfill failed for a %s operation, without streaming',
    async (status, errorCode, expected) => {
      const tenant = await seedTestTenant(`shopify-sync-bulk-${status.toLowerCase()}`);
      try {
        await connectStore(tenant);
        const { adapter, streamBulkOrders } = fakeAdapter({
          bulkOperation: vi.fn().mockResolvedValue({ ...COMPLETED, status, errorCode }),
        });
        await createShopifySyncProcessor(depsFor(adapter))(bulkJob(tenant.storeId));
        expect(streamBulkOrders).not.toHaveBeenCalled();
        expect(await backfillSettings(tenant)).toMatchObject({
          status: 'failed',
          error_code: expected,
        });
      } finally {
        await cleanupTestTenant(tenant);
      }
    },
  );

  it('throws (so BullMQ retries) while the operation is still running, and does not mark it done', async () => {
    const tenant = await seedTestTenant('shopify-sync-bulk-running');
    try {
      await connectStore(tenant);
      const { adapter, streamBulkOrders } = fakeAdapter({
        bulkOperation: vi.fn().mockResolvedValue({ ...COMPLETED, status: 'RUNNING', url: null }),
      });
      await expect(
        createShopifySyncProcessor(depsFor(adapter))(bulkJob(tenant.storeId)),
      ).rejects.toThrow('RUNNING');
      expect(streamBulkOrders).not.toHaveBeenCalled();
      expect(await backfillSettings(tenant)).toEqual({});
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('marks the backfill failed (and does not retry) when Shopify has no such operation', async () => {
    const tenant = await seedTestTenant('shopify-sync-bulk-unknown-op');
    try {
      await connectStore(tenant);
      const { adapter } = fakeAdapter({ bulkOperation: vi.fn().mockResolvedValue(null) });
      await createShopifySyncProcessor(depsFor(adapter))(bulkJob(tenant.storeId));
      expect(await backfillSettings(tenant)).toMatchObject({
        status: 'failed',
        error_code: 'operation_not_found',
      });
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('refreshes an expired token before reading the operation', async () => {
    const tenant = await seedTestTenant('shopify-sync-bulk-refresh');
    try {
      await connectStore(tenant);
      const refreshed: ShopifyCredentials = { ...CREDENTIALS, accessToken: 'shpat_rotated' };
      const bulkOperation = vi
        .fn()
        .mockRejectedValueOnce(new ShopifyUnauthorizedError())
        .mockResolvedValueOnce({ ...COMPLETED, url: null });
      const { adapter } = fakeAdapter({
        bulkOperation,
        refresh: vi.fn().mockResolvedValue(refreshed),
      });
      await createShopifySyncProcessor(depsFor(adapter))(bulkJob(tenant.storeId));
      expect(bulkOperation.mock.calls[1]![1]).toEqual(refreshed);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('rejects a job with no bulkOperationId, and is a no-op for a deleted store', async () => {
    const { adapter, bulkOperation } = fakeAdapter();
    const process = createShopifySyncProcessor(depsFor(adapter));
    await expect(
      process(job({ storeId: '00000000-0000-0000-0000-000000000000', mode: 'bulk_result' })),
    ).rejects.toThrow('no bulkOperationId');
    await process(bulkJob('00000000-0000-0000-0000-000000000000'));
    expect(bulkOperation).not.toHaveBeenCalled();
  });
});

describe('shopify-sync processor — bulk_result: identity stitching and erased identities (M1-7)', () => {
  const bulkJob = (storeId: string) =>
    job({ storeId, mode: 'bulk_result', bulkOperationId: COMPLETED.id });

  it('enqueues attempt 2 of the stitch chain for every applied order, and none for a skipped non-INR one', async () => {
    const tenant = await seedTestTenant('shopify-sync-bulk-stitch');
    try {
      await connectStore(tenant);
      const { adapter } = fakeAdapter({
        bulkOperation: vi.fn().mockResolvedValue(COMPLETED),
        lines: [
          orderLine({ externalOrderId: '7001' }),
          orderLine({ externalOrderId: '7002', currency: 'USD' }),
          orderLine({ externalOrderId: '7003' }),
        ],
      });
      const addBulk = vi.fn(async (..._a: unknown[]) => [] as never);

      await createShopifySyncProcessor(
        depsFor(adapter, { identityStitchQueue: { addBulk } as never }),
      )(bulkJob(tenant.storeId));

      const rows = await ordersOf(tenant.storeId);
      expect(rows.map((r) => r.externalOrderId).sort()).toEqual(['7001', '7003']);
      expect(addBulk).toHaveBeenCalledTimes(1);
      const jobs = addBulk.mock.calls[0]![0] as Array<{
        name: string;
        data: { storeId: string; orderId: string; attempt: number };
        opts: { jobId: string; attempts: number };
      }>;
      expect(jobs.map((j) => j.data.orderId).sort()).toEqual(rows.map((r) => r.id).sort());
      for (const j of jobs) {
        expect(j.name).toBe('stitch');
        expect(j.data).toMatchObject({ storeId: tenant.storeId, attempt: 2 });
        expect(j.opts).toMatchObject({ jobId: `stitch:${j.data.orderId}:2`, attempts: 5 });
      }
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('a re-run of the same result re-enqueues the same job ids (BullMQ dedupes them)', async () => {
    const tenant = await seedTestTenant('shopify-sync-bulk-stitch-rerun');
    try {
      await connectStore(tenant);
      const { adapter } = fakeAdapter({
        bulkOperation: vi.fn().mockResolvedValue(COMPLETED),
        lines: [orderLine({ externalOrderId: '7101' })],
      });
      const addBulk = vi.fn(async (..._a: unknown[]) => [] as never);
      const process = createShopifySyncProcessor(
        depsFor(adapter, { identityStitchQueue: { addBulk } as never }),
      );
      await process(bulkJob(tenant.storeId));
      await process(bulkJob(tenant.storeId));
      const ids = addBulk.mock.calls.map(
        (c) => (c[0] as Array<{ opts: { jobId: string } }>)[0]!.opts.jobId,
      );
      expect(ids).toHaveLength(2);
      expect(ids[0]).toBe(ids[1]);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('enqueues in chunks of 500', async () => {
    const tenant = await seedTestTenant('shopify-sync-bulk-stitch-chunks');
    try {
      await connectStore(tenant);
      const lines = Array.from({ length: 501 }, (_, i) =>
        orderLine({ externalOrderId: String(20000 + i) }),
      );
      const { adapter } = fakeAdapter({
        bulkOperation: vi.fn().mockResolvedValue(COMPLETED),
        lines,
      });
      const addBulk = vi.fn(async (..._a: unknown[]) => [] as never);
      await createShopifySyncProcessor(
        depsFor(adapter, { identityStitchQueue: { addBulk } as never }),
      )(bulkJob(tenant.storeId));
      expect(addBulk.mock.calls.map((c) => (c[0] as unknown[]).length)).toEqual([500, 1]);
    } finally {
      await cleanupTestTenant(tenant);
    }
    // 501 real Postgres applies: well over the 5 s default when the whole suite runs in parallel.
  }, 60_000);

  it("stores an erased shopper's backfilled order without their hashes, but keeps the sale", async () => {
    const tenant = await seedTestTenant('shopify-sync-bulk-erased');
    try {
      await connectStore(tenant);
      const phone = '+918123456799';
      const erasedHash = hasher.hashPhone(storeContext(tenant.storeId), phone)!;
      const { adapter } = fakeAdapter({
        bulkOperation: vi.fn().mockResolvedValue(COMPLETED),
        lines: [
          orderLine({ externalOrderId: '7201', phone, email: 'gone@example.com' }),
          orderLine({ externalOrderId: '7202', phone: '+918123456798' }),
        ],
      });
      const erasedOnly = {
        zscore: async (key: string, member: string) =>
          key.includes(tenant.storeId) && key.endsWith(':erased:identity') && member === erasedHash
            ? String(Math.floor(Date.now() / 1000) + 10_000)
            : null,
      };

      await createShopifySyncProcessor(depsFor(adapter, { redis: erasedOnly }))(
        bulkJob(tenant.storeId),
      );

      const rows = await ordersOf(tenant.storeId);
      const erased = rows.find((r) => r.externalOrderId === '7201')!;
      expect(erased.phoneHashHmac).toBeNull();
      expect(erased.emailHashHmac).toBeNull();
      expect(erased.totalAmountPaise).toBe(129900);
      expect(rows.find((r) => r.externalOrderId === '7202')!.phoneHashHmac).toMatch(/^k1:/);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });
});

describe('shopify-sync processor — unimplemented modes', () => {
  it.each(['reconcile', 'order_refresh'] as const)(
    'throws a clear error for %s (not built yet)',
    async (mode) => {
      const { adapter } = fakeAdapter();
      await expect(
        createShopifySyncProcessor(depsFor(adapter))(job({ storeId: 'irrelevant', mode })),
      ).rejects.toThrow(`'${mode}' is not implemented yet`);
    },
  );
});
