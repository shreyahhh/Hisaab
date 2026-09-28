import { describe, expect, it } from 'vitest';
import {
  AD_SYNC_META_JOB_NAMES,
  AD_SYNC_META_QUEUE,
  ATTRIBUTION_RUN_QUEUE,
  adSyncMetaJobId,
  META_WARMUP_INTERVAL_MS,
  metaWarmupSchedulerId,
  IDENTITY_STITCH_DELAY_MS,
  IDENTITY_STITCH_QUEUE,
  IdentityStitchJobSchema,
  SHOPIFY_SYNC_MODES,
  SHOPIFY_SYNC_QUEUE,
  attributionRunJobId,
  identityStitchJobId,
  normaliseOrderId,
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
