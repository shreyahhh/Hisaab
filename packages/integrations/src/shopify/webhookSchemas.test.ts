import { describe, expect, it } from 'vitest';
import {
  ShopifyOrderHintWebhook,
  ShopifyOrderWebhook,
  snapshotFromOrderWebhook,
} from './webhookSchemas.js';

function orderPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    created_at: '2026-09-01T10:00:00+05:30',
    updated_at: '2026-09-01T10:05:00+05:30',
    cancelled_at: null,
    currency: 'INR',
    total_price: '1299.00',
    total_outstanding: '0.00',
    financial_status: 'paid',
    fulfillment_status: null,
    payment_gateway_names: ['razorpay'],
    email: 'shopper@example.com',
    phone: '+919812345670',
    shipping_address: { zip: '560034', phone: '+919812345670' },
    landing_site: 'https://store.example.com/?utm_source=facebook',
    referring_site: 'https://facebook.com/',
    note_attributes: [{ name: 'utm_source', value: 'facebook' }],
    discount_codes: [{ code: 'RAHUL10' }],
    // Fields the mapper never reads — presence must not break parsing (.passthrough()).
    customer: { id: 1, first_name: 'Rahul', last_name: 'Sharma', email: 'shopper@example.com' },
    line_items: [{ id: 1, title: 'Widget' }],
    ...overrides,
  };
}

describe('ShopifyOrderWebhook', () => {
  it('accepts a realistic full payload', () => {
    expect(ShopifyOrderWebhook.safeParse(orderPayload()).success).toBe(true);
  });

  it('accepts a numeric or string id', () => {
    expect(ShopifyOrderWebhook.safeParse(orderPayload({ id: '1001' })).success).toBe(true);
    expect(ShopifyOrderWebhook.safeParse(orderPayload({ id: 1001 })).success).toBe(true);
  });

  it('accepts protected fields being absent (unapproved production app)', () => {
    const result = ShopifyOrderWebhook.safeParse(
      orderPayload({ email: null, phone: null, shipping_address: null }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a malformed total_price (not a decimal money string)', () => {
    expect(ShopifyOrderWebhook.safeParse(orderPayload({ total_price: 'free' })).success).toBe(
      false,
    );
  });

  it('rejects a missing required field', () => {
    const payload: Record<string, unknown> = orderPayload();
    delete payload.currency;
    expect(ShopifyOrderWebhook.safeParse(payload).success).toBe(false);
  });
});

describe('ShopifyOrderHintWebhook', () => {
  it('accepts a minimal refund/fulfillment hint payload', () => {
    expect(
      ShopifyOrderHintWebhook.safeParse({ order_id: 1001, created_at: '2026-09-01T10:00:00Z' })
        .success,
    ).toBe(true);
  });

  it('rejects a payload with no order_id', () => {
    expect(ShopifyOrderHintWebhook.safeParse({ created_at: '2026-09-01T10:00:00Z' }).success).toBe(
      false,
    );
  });
});

describe('snapshotFromOrderWebhook', () => {
  it('maps every field the mapper needs', () => {
    const parsed = ShopifyOrderWebhook.parse(orderPayload());
    const snapshot = snapshotFromOrderWebhook(parsed);
    expect(snapshot).toEqual({
      externalOrderId: '1001',
      createdAtPlatform: '2026-09-01T10:00:00+05:30',
      updatedAtPlatform: '2026-09-01T10:05:00+05:30',
      cancelledAt: null,
      currency: 'INR',
      totalPrice: '1299.00',
      totalRefunded: null,
      totalOutstanding: '0.00',
      financialStatus: 'paid',
      fulfillmentStatus: null,
      paymentGatewayNames: ['razorpay'],
      email: 'shopper@example.com',
      phone: '+919812345670',
      shippingAddressZip: '560034',
      landingSite: 'https://store.example.com/?utm_source=facebook',
      referringSite: 'https://facebook.com/',
      noteAttributes: [{ name: 'utm_source', value: 'facebook' }],
      discountCodes: ['RAHUL10'],
    });
  });

  it('falls back to shipping_address.phone when the top-level phone is absent', () => {
    const parsed = ShopifyOrderWebhook.parse(
      orderPayload({ phone: null, shipping_address: { zip: '560034', phone: '+919812345670' } }),
    );
    expect(snapshotFromOrderWebhook(parsed).phone).toBe('+919812345670');
  });

  it('never reads customer name or line items into the snapshot', () => {
    const parsed = ShopifyOrderWebhook.parse(orderPayload());
    const snapshot = snapshotFromOrderWebhook(parsed);
    expect(JSON.stringify(snapshot)).not.toContain('Rahul');
    expect(JSON.stringify(snapshot)).not.toContain('Widget');
  });

  it('numeric id becomes a string externalOrderId', () => {
    const parsed = ShopifyOrderWebhook.parse(orderPayload({ id: 42 }));
    expect(snapshotFromOrderWebhook(parsed).externalOrderId).toBe('42');
  });
});
