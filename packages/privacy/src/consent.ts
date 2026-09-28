import type { Purpose } from '@truepath/shared';

// Consent evaluation (privacy-dpdp.md §2.1; SPEC §5.3 P-1, P-5, P-6, P-7). The Collector maps what the
// pixel reports to the purposes an event may be used for; every later stage checks those purposes
// rather than re-deriving them. It sits behind an interface so a registered Consent Manager (DPDP,
// from Nov 2026) can replace Shopify's Customer Privacy API without touching a caller (P-7).

export type ConsentSignal = {
  readonly source: 'shopify_customer_privacy';
  /** `analyticsProcessingAllowed` */
  readonly analytics: boolean;
  /** `marketingAllowed` */
  readonly marketing: boolean;
  readonly noticeVersion: string;
};

export type ConsentDecision = {
  /** Stamped on the event as `consent_purposes`. */
  readonly purposes: readonly Purpose[];
  /** `purposes` includes `attribution_analytics` — whether the event may be stored at all. */
  readonly canStore: boolean;
  /** `purposes` includes `ad_platform_measurement` — whether it may ever feed Meta CAPI. */
  readonly canSendToAdPlatforms: boolean;
};

export interface ConsentProvider {
  readonly id: ConsentSignal['source'];
  evaluate(signal: ConsentSignal, store: { readonly childDirected: boolean }): ConsentDecision;
}

/**
 * Shopify's Customer Privacy API → purposes:
 *   analytics = true                           → `attribution_analytics`
 *   marketing = true, store not child-directed → `ad_platform_measurement`
 *   marketing = true, store child-directed     → nothing extra (P-6)
 * `preferencesProcessingAllowed` and `saleOfDataAllowed` map to no MVP purpose.
 *
 * The two purposes are independent on purpose: a shopper who allows analytics but not marketing is
 * measured for attribution but never sent to an ad platform, and marketing alone stores nothing.
 */
export const shopifyCustomerPrivacyProvider: ConsentProvider = {
  id: 'shopify_customer_privacy',
  evaluate(signal, store) {
    const purposes: Purpose[] = [];
    if (signal.analytics) purposes.push('attribution_analytics');
    if (signal.marketing && !store.childDirected) purposes.push('ad_platform_measurement');
    return {
      purposes,
      canStore: signal.analytics,
      canSendToAdPlatforms: purposes.includes('ad_platform_measurement'),
    };
  },
};
