import { describe, expect, it } from 'vitest';
import { shopifyCustomerPrivacyProvider, type ConsentSignal } from './consent.js';

const signal = (analytics: boolean, marketing: boolean): ConsentSignal => ({
  source: 'shopify_customer_privacy',
  analytics,
  marketing,
  noticeVersion: 'v1',
});

describe('shopifyCustomerPrivacyProvider (privacy-dpdp.md §2.1 mapping table)', () => {
  it.each([
    // analytics, marketing, childDirected → purposes, canStore, canSendToAdPlatforms
    [true, false, false, ['attribution_analytics'], true, false],
    [true, true, false, ['attribution_analytics', 'ad_platform_measurement'], true, true],
    [true, true, true, ['attribution_analytics'], true, false], // P-6: child-directed strips ad measurement
    [true, false, true, ['attribution_analytics'], true, false],
    [false, true, false, ['ad_platform_measurement'], false, true], // marketing alone stores nothing
    [false, true, true, [], false, false],
    [false, false, false, [], false, false],
    [false, false, true, [], false, false],
  ] as const)(
    'analytics=%s marketing=%s childDirected=%s → %j (store=%s, ads=%s)',
    (analytics, marketing, childDirected, purposes, canStore, canSendToAdPlatforms) => {
      expect(
        shopifyCustomerPrivacyProvider.evaluate(signal(analytics, marketing), { childDirected }),
      ).toEqual({ purposes, canStore, canSendToAdPlatforms });
    },
  );

  it('identifies itself, so a Consent Manager provider can be told apart later (P-7)', () => {
    expect(shopifyCustomerPrivacyProvider.id).toBe('shopify_customer_privacy');
  });
});
