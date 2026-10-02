import { describe, expect, it } from 'vitest';
import {
  AD_SYNC_META_JOB_NAMES,
  AD_SYNC_META_QUEUE,
  ATTRIBUTION_RUN_QUEUE,
  adSyncMetaJobId,
  META_WARMUP_INTERVAL_MS,
  metaWarmupSchedulerId,
  DSR_JOB_OPTIONS,
  DSR_QUEUE,
  DSR_WITHDRAWAL_DELAY_MS,
  DsrJobSchema,
  STORE_ERASURE_DELAY_MS,
  IDENTITY_STITCH_DELAY_MS,
  IDENTITY_STITCH_QUEUE,
  IdentityStitchJobSchema,
  SHOPIFY_SYNC_MODES,
  SHOPIFY_SYNC_QUEUE,
  SHOPIFY_ORDER_REFRESH_DELAY_MS,
  attributionRunJobId,
  identityStitchJobId,
  normaliseOrderId,
  shopifyOrderRefreshJobId,
} from './jobs.js';

describe('shopify-sync job registry (HLD §8)', () => {
  it('names the queue exactly as HLD §8 registers it', () => {
    expect(SHOPIFY_SYNC_QUEUE).toBe('shopify-sync');
  });

  it('lists every mode shopify-integration.md §4.7 defines, once each', () => {
    expect(SHOPIFY_SYNC_MODES).toEqual(['backfill', 'bulk_result', 'reconcile', 'order_refresh']);
    expect(new Set(SHOPIFY_SYNC_MODES).size).toBe(SHOPIFY_SYNC_MODES.length);
  });
});

// BullMQ 6.x: a custom job id containing ':' must have exactly three parts (Job.validateOptions).
const bullmqAcceptsJobId = (id: string): boolean => !id.includes(':') || id.split(':').length === 3;

describe('shopifyOrderRefreshJobId (shopify-integration.md §2.6)', () => {
  it('builds a three-part job id BullMQ accepts, distinct per store and order', () => {
    const a = shopifyOrderRefreshJobId('store-1', '5001');
    const b = shopifyOrderRefreshJobId('store-1', '5002');
    const c = shopifyOrderRefreshJobId('store-2', '5001');
    expect(a).toBe('shopify-refresh:store-1:5001');
    expect([a, b, c].every(bullmqAcceptsJobId)).toBe(true);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('debounces 30 s, per the LLD', () => {
    expect(SHOPIFY_ORDER_REFRESH_DELAY_MS).toBe(30_000);
  });
});

describe('identity-stitch / attribution-run registry (HLD §8)', () => {
  const orderId = '0192f3a4-7b1c-7c2d-8e3f-4a5b6c7d8e9f';

  it('names the queues exactly as HLD §8 registers them', () => {
    expect(IDENTITY_STITCH_QUEUE).toBe('identity-stitch');
    expect(ATTRIBUTION_RUN_QUEUE).toBe('attribution-run');
  });

  it('builds job ids BullMQ accepts, distinct per attempt', () => {
    const ids = [
      identityStitchJobId(orderId, 0),
      identityStitchJobId(orderId, 1),
      identityStitchJobId(orderId, 2),
      attributionRunJobId(orderId),
    ];
    expect(ids.every(bullmqAcceptsJobId)).toBe(true);
    expect(new Set(ids).size).toBe(4);
    expect(identityStitchJobId(orderId, 0)).toBe(`stitch:${orderId}:0`);
  });

  it('delays attempts 1 and 2 by 5 and 30 minutes', () => {
    expect(IDENTITY_STITCH_DELAY_MS).toEqual({ 1: 300_000, 2: 1_800_000 });
  });

  it('validates the stitch payload strictly', () => {
    const ok = { storeId: orderId, orderId, attempt: 2 };
    expect(IdentityStitchJobSchema.safeParse(ok).success).toBe(true);
    expect(IdentityStitchJobSchema.safeParse({ ...ok, attempt: 3 }).success).toBe(false);
    expect(IdentityStitchJobSchema.safeParse({ ...ok, orderId: '5001' }).success).toBe(false);
    expect(IdentityStitchJobSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});

describe('dsr registry (HLD §8, issue #25)', () => {
  const storeId = '0192f3a4-7b1c-7c2d-8e3f-4a5b6c7d8e9f';
  const requestId = '1192f3a4-7b1c-7c2d-8e3f-4a5b6c7d8e9f';

  it('names the queue exactly as HLD §8 registers it', () => {
    expect(DSR_QUEUE).toBe('dsr');
  });

  it('delays: withdrawal coalescing is 60s, store_erasure is 7 days', () => {
    expect(DSR_WITHDRAWAL_DELAY_MS).toBe(60_000);
    expect(STORE_ERASURE_DELAY_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('5 attempts, exponential backoff from 2s, matching the LLD failure-mode table', () => {
    expect(DSR_JOB_OPTIONS).toMatchObject({
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    });
  });

  it('validates the dsr payload strictly, visitorIds optional', () => {
    const ok = { storeId, type: 'erasure' as const, requestId };
    expect(DsrJobSchema.safeParse(ok).success).toBe(true);
    expect(DsrJobSchema.safeParse({ ...ok, visitorIds: ['v1', 'v2'] }).success).toBe(true);
    expect(DsrJobSchema.safeParse({ ...ok, type: 'made_up' }).success).toBe(false);
    expect(DsrJobSchema.safeParse({ ...ok, storeId: 'not-a-uuid' }).success).toBe(false);
    expect(DsrJobSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(DsrJobSchema.safeParse({ ...ok, visitorIds: [] }).success).toBe(true);
  });
});

describe('normaliseOrderId', () => {
  it.each([
    ['5001', '5001'],
    [' 5001 ', '5001'],
    ['gid://shopify/Order/5001', '5001'],
    ['gid://shopify/OrderIdentity/820982911946154508', '820982911946154508'],
    ['gid://shopify/Order/5001?key=abc', '5001'],
  ])('%s → %s', (raw, expected) => {
    expect(normaliseOrderId(raw)).toBe(expected);
  });

  it.each([
    '',
    'abc',
    '#1001',
    'gid://shopify/Order/',
    'gid://shopify/Order/abc',
    '12 34',
    '1'.repeat(21),
  ])('rejects %j', (raw) => {
    expect(normaliseOrderId(raw)).toBeNull();
  });
});

describe('ad-sync-meta registry (HLD §8)', () => {
  const storeId = '0192f3a4-7b1c-7c2d-8e3f-4a5b6c7d8e9f';
  const now = new Date('2026-09-29T01:14:14.000Z');

  it('names the queue exactly as HLD §8 registers it', () => {
    expect(AD_SYNC_META_QUEUE).toBe('ad-sync-meta');
  });

  it('lists every job name meta-integration.md §2.2 defines, once each', () => {
    expect(AD_SYNC_META_JOB_NAMES).toEqual([
      'meta-daily',
      'meta-intraday',
      'meta-backfill',
      'meta-warmup',
    ]);
    expect(new Set(AD_SYNC_META_JOB_NAMES).size).toBe(AD_SYNC_META_JOB_NAMES.length);
  });

  it('builds a job id BullMQ accepts, stamped to the hour in UTC', () => {
    const id = adSyncMetaJobId(storeId, 'meta-warmup', now);
    expect(bullmqAcceptsJobId(id)).toBe(true);
    expect(id).toBe(`meta-${storeId}-meta-warmup-2026092901`);
  });

  it('differs by name and by hour, so distinct runs never collide', () => {
    expect(adSyncMetaJobId(storeId, 'meta-warmup', now)).not.toBe(
      adSyncMetaJobId(storeId, 'meta-daily', now),
    );
    expect(adSyncMetaJobId(storeId, 'meta-warmup', now)).not.toBe(
      adSyncMetaJobId(storeId, 'meta-warmup', new Date('2026-09-29T02:00:00.000Z')),
    );
  });

  it('runs every 15 minutes, and the scheduler id is stable per store', () => {
    expect(META_WARMUP_INTERVAL_MS).toBe(900_000);
    expect(metaWarmupSchedulerId(storeId)).toBe(`meta-warmup-${storeId}`);
    expect(metaWarmupSchedulerId(storeId)).toBe(metaWarmupSchedulerId(storeId));
  });
});
