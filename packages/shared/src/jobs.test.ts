import { describe, expect, it } from 'vitest';
import { SHOPIFY_SYNC_MODES, SHOPIFY_SYNC_QUEUE } from './jobs.js';

describe('shopify-sync job registry (HLD §8)', () => {
  it('names the queue exactly as HLD §8 registers it', () => {
    expect(SHOPIFY_SYNC_QUEUE).toBe('shopify-sync');
  });

  it('lists every mode shopify-integration.md §4.7 defines, once each', () => {
    expect(SHOPIFY_SYNC_MODES).toEqual(['backfill', 'bulk_result', 'reconcile', 'order_refresh']);
    expect(new Set(SHOPIFY_SYNC_MODES).size).toBe(SHOPIFY_SYNC_MODES.length);
  });
});
