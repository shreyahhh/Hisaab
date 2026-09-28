import { createTestIdentityHasher } from '@truepath/privacy/testing';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COD_MAPPING,
  detectPaymentMethod,
  exceedsMoneySanityBound,
  filterNoteAttributes,
  mapOrderSnapshot,
  ORDER_MONEY_SANITY_BOUND_PAISE,
  parseMoneyToPaise,
  pincodePrefixFromZip,
} from './mapper.js';
import type { ShopifyOrderSnapshot } from './types.js';

describe('parseMoneyToPaise', () => {
  it.each([
    ['1299.00', 129900],
    ['1299', 129900],
    ['1299.5', 129950],
    ['0.01', 1],
    ['0', 0],
    ['0.1', 10],
    ['-50.00', -5000],
  ])('parses %s to %i paise', (input, expected) => {
    expect(parseMoneyToPaise(input)).toBe(expected);
  });

  it('never produces a float artifact (e.g. the classic 0.1 + 0.2 case)', () => {
    // If this ever went through parseFloat/Number arithmetic on the decimal itself, values like
    // this are exactly where float imprecision would show up. String-based parsing never touches it.
    expect(parseMoneyToPaise('19.99')).toBe(1999);
    expect(parseMoneyToPaise('100.10')).toBe(10010);
  });

  it.each(['abc', '1,299.00', '1299.999', '', '1299.', '.50'])(
    'rejects the malformed money string %j',
    (value) => {
      expect(() => parseMoneyToPaise(value)).toThrow();
    },
  );
});

describe('exceedsMoneySanityBound', () => {
  it('is false at and under the bound', () => {
    expect(exceedsMoneySanityBound(ORDER_MONEY_SANITY_BOUND_PAISE)).toBe(false);
    expect(exceedsMoneySanityBound(100)).toBe(false);
  });

  it('is true over the bound, in either direction', () => {
    expect(exceedsMoneySanityBound(ORDER_MONEY_SANITY_BOUND_PAISE + 1)).toBe(true);
    expect(exceedsMoneySanityBound(-(ORDER_MONEY_SANITY_BOUND_PAISE + 1))).toBe(true);
  });
});

describe('detectPaymentMethod (shopify-integration.md §4.6)', () => {
  it('maps a plain COD gateway to cod', () => {
    expect(detectPaymentMethod(['Cash on Delivery (COD)'], null, 100000, 'pending')).toBe('cod');
  });

  it('maps a known prepaid gateway to prepaid', () => {
    expect(detectPaymentMethod(['razorpay'], null, 100000, 'paid')).toBe('prepaid');
  });

  it('an explicit partial_cod gateway wins outright', () => {
    expect(detectPaymentMethod(['Partial COD'], null, 100000, 'partially_paid')).toBe(
      'partial_cod',
    );
  });

  it('cod + prepaid gateways together is partial_cod', () => {
    expect(detectPaymentMethod(['cod', 'razorpay'], null, 100000, 'partially_paid')).toBe(
      'partial_cod',
    );
  });

  it('cod with a partial outstanding balance is partial_cod', () => {
    expect(detectPaymentMethod(['cod'], 50000, 100000, 'partially_paid')).toBe('partial_cod');
  });

  it('cod with the full amount outstanding is plain cod, not partial', () => {
    expect(detectPaymentMethod(['cod'], 100000, 100000, 'pending')).toBe('cod');
  });

  it('cod with zero outstanding is plain cod', () => {
    expect(detectPaymentMethod(['cod'], 0, 100000, 'paid')).toBe('cod');
  });

  it('unmapped gateway + pending financial status falls back to cod', () => {
    expect(detectPaymentMethod(['some-unknown-gateway'], null, 100000, 'pending')).toBe('cod');
  });

  it('unmapped gateway + non-pending financial status falls back to prepaid', () => {
    expect(detectPaymentMethod(['some-unknown-gateway'], null, 100000, 'paid')).toBe('prepaid');
  });

  it("matches 'cod' as a whole token, not as a substring of an unrelated word", () => {
    expect(detectPaymentMethod(['encoded-payments'], null, 100000, 'paid')).toBe('prepaid');
  });

  it('is case-insensitive', () => {
    expect(detectPaymentMethod(['RAZORPAY'], null, 100000, 'paid')).toBe('prepaid');
  });

  it('respects a custom mapping over the defaults', () => {
    const custom = { ...DEFAULT_COD_MAPPING, prepaid: ['my-custom-gateway'] };
    expect(detectPaymentMethod(['my-custom-gateway'], null, 100000, 'paid', custom)).toBe(
      'prepaid',
    );
    expect(detectPaymentMethod(['razorpay'], null, 100000, 'paid', custom)).toBe('prepaid'); // now unmapped -> financial_status fallback
  });
});

describe('filterNoteAttributes', () => {
  it('keeps only the allowlisted UTM/click-id keys', () => {
    const filtered = filterNoteAttributes([
      { name: 'utm_source', value: 'facebook' },
      { name: 'gclid', value: 'abc123' },
      { name: 'customer_note', value: 'leave at the door' },
      { name: 'internal_ref', value: '12345' },
    ]);
    expect(filtered).toEqual([
      { name: 'utm_source', value: 'facebook' },
      { name: 'gclid', value: 'abc123' },
    ]);
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterNoteAttributes([{ name: 'random_key', value: 'x' }])).toEqual([]);
  });
});

describe('pincodePrefixFromZip', () => {
  it('takes the first 3 digits of a 6-digit PIN', () => {
    expect(pincodePrefixFromZip('560034')).toBe('560');
  });

  it('strips non-digit characters before checking length', () => {
    expect(pincodePrefixFromZip('560 034')).toBe('560');
  });

  it('returns null for anything not exactly 6 digits', () => {
    expect(pincodePrefixFromZip('12345')).toBeNull();
    expect(pincodePrefixFromZip('1234567')).toBeNull();
  });

  it('returns null for null/empty input', () => {
    expect(pincodePrefixFromZip(null)).toBeNull();
    expect(pincodePrefixFromZip('')).toBeNull();
  });
});

describe('mapOrderSnapshot', () => {
  const hasher = createTestIdentityHasher();
  const storeId = '11111111-1111-1111-1111-111111111111';

  function snapshot(overrides: Partial<ShopifyOrderSnapshot> = {}): ShopifyOrderSnapshot {
    return {
      externalOrderId: '1001',
      createdAtPlatform: '2026-09-01T10:00:00Z',
      updatedAtPlatform: '2026-09-01T10:00:00Z',
      cancelledAt: null,
      currency: 'INR',
      totalPrice: '1299.00',
      totalRefunded: null,
      totalOutstanding: null,
      financialStatus: 'paid',
      fulfillmentStatus: null,
      paymentGatewayNames: ['razorpay'],
      email: 'shopper@example.com',
      phone: '+919812345670',
      shippingAddressZip: '560034',
      landingSite: 'https://store.example.com/products/x?utm_source=facebook&utm_medium=cpc',
      referringSite: 'https://facebook.com/some/path',
      noteAttributes: [{ name: 'utm_source', value: 'facebook' }],
      discountCodes: ['RAHUL10'],
      ...overrides,
    };
  }

  it('maps money, payment method, pincode, hashes and sanitised URLs', () => {
    const fields = mapOrderSnapshot(snapshot(), storeId, hasher);
    expect(fields.totalAmountPaise).toBe(129900);
    expect(fields.paymentMethod).toBe('prepaid');
    expect(fields.pincodePrefix).toBe('560');
    expect(fields.phoneHashHmac).toMatch(/^k\d+:[0-9a-f]{64}$/);
    expect(fields.emailHashHmac).toMatch(/^k\d+:[0-9a-f]{64}$/);
    expect(fields.landingSite).toContain('utm_source=facebook');
    expect(fields.landingSite).toBe(
      'https://store.example.com/products/x?utm_source=facebook&utm_medium=cpc',
    );
    expect(fields.discountCodes).toEqual(['RAHUL10']);
    expect(fields.moneySanityExceeded).toBe(false);
  });

  it('never puts the raw phone or email in any mapped field', () => {
    const fields = mapOrderSnapshot(snapshot(), storeId, hasher);
    const serialised = JSON.stringify(fields);
    expect(serialised).not.toContain('shopper@example.com');
    expect(serialised).not.toContain('9812345670');
  });

  it('defaults fulfilment status to unfulfilled when absent', () => {
    const fields = mapOrderSnapshot(snapshot({ fulfillmentStatus: null }), storeId, hasher);
    expect(fields.fulfilmentStatus).toBe('unfulfilled');
  });

  it('leaves refundedAmountPaise null when the snapshot has no totalRefunded (a REST order webhook)', () => {
    const fields = mapOrderSnapshot(snapshot({ totalRefunded: null }), storeId, hasher);
    expect(fields.refundedAmountPaise).toBeNull();
  });

  it('parses refundedAmountPaise when present (a GraphQL snapshot from fetchOrder)', () => {
    const fields = mapOrderSnapshot(snapshot({ totalRefunded: '100.00' }), storeId, hasher);
    expect(fields.refundedAmountPaise).toBe(10000);
  });

  it('handles a dummy/blocklisted phone by not hashing it (packages/privacy §4.1)', () => {
    const fields = mapOrderSnapshot(
      snapshot({ phone: '9000000000', email: undefined }),
      storeId,
      hasher,
    );
    expect(fields.phoneHashHmac).toBeNull();
  });

  it('degrades gracefully when protected customer data fields are absent (unapproved production app)', () => {
    const fields = mapOrderSnapshot(
      snapshot({ email: null, phone: null, shippingAddressZip: null }),
      storeId,
      hasher,
    );
    expect(fields.phoneHashHmac).toBeNull();
    expect(fields.emailHashHmac).toBeNull();
    expect(fields.pincodePrefix).toBeNull();
  });

  it('flags an order over the money sanity bound without throwing', () => {
    const fields = mapOrderSnapshot(snapshot({ totalPrice: '99999999.00' }), storeId, hasher);
    expect(fields.moneySanityExceeded).toBe(true);
  });
});
