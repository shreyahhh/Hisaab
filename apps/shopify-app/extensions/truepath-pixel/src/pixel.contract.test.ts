import { createHmac } from 'node:crypto';
import {
  COLLECT_MAX_BODY_BYTES as SHARED_MAX_BODY,
  COLLECT_MAX_EVENTS_PER_BATCH as SHARED_MAX_EVENTS,
  COLLECT_SIGNATURE_TOLERANCE_SECONDS,
  CONSENT_REFRESH_INTERVAL_DAYS,
  CollectBatch,
  collectSigningInput,
} from '@truepath/shared';
import { describe, expect, it } from 'vitest';
import {
  COLLECT_MAX_BODY_BYTES,
  COLLECT_MAX_EVENTS_PER_BATCH,
  CONSENT_REFRESH_INTERVAL_MS,
  startPixel,
} from './pixel.js';
import {
  GOOD_SETTINGS,
  addedToCart,
  checkoutCompleted,
  harness,
  productViewed,
  shopifyEvent,
} from './testHarness.js';

// The pixel may not import runtime values from `@truepath/shared` (it is bundled for a browser), so it
// carries its own copies of a few constants. These tests pin them, and prove that whatever the pixel
// emits is accepted by the Collector's real strict schema.

describe('pixel ↔ Collector contract', () => {
  it('keeps its own copies of the shared constants in step', () => {
    expect(COLLECT_MAX_BODY_BYTES).toBe(SHARED_MAX_BODY);
    expect(COLLECT_MAX_EVENTS_PER_BATCH).toBe(SHARED_MAX_EVENTS);
    expect(CONSENT_REFRESH_INTERVAL_MS).toBe(CONSENT_REFRESH_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
    expect(COLLECT_SIGNATURE_TOLERANCE_SECONDS).toBeGreaterThanOrEqual(300);
  });

  it('every batch a full session produces passes CollectBatch, including consent events', async () => {
    const h = harness({ marketing: true, cookies: { _fbp: 'fb.1.1.2', _fbc: 'fb.1.1.abc' } });
    await startPixel(h.api, h.deps);
    h.emit('page_viewed', shopifyEvent());
    h.emit('product_viewed', productViewed());
    h.emit('product_added_to_cart', addedToCart());
    h.emit(
      'checkout_started',
      shopifyEvent({
        checkout: { token: 'co_1', totalPrice: { amount: 1299, currencyCode: 'INR' } },
      }),
    );
    h.emit(
      'checkout_contact_info_submitted',
      shopifyEvent({ checkout: { token: 'co_1', email: 'a@example.com', phone: '+918123456709' } }),
    );
    h.emit('checkout_completed', checkoutCompleted());
    h.emit('visitorConsentCollected', {
      customerPrivacy: { analyticsProcessingAllowed: true, marketingAllowed: true },
    });
    await h.advance(2_000);
    h.emit('visitorConsentCollected', {
      customerPrivacy: { analyticsProcessingAllowed: false, marketingAllowed: false },
    });
    await h.settle();

    expect(h.sent.length).toBeGreaterThan(1);
    const kinds = new Set<string>();
    for (const req of h.sent) {
      const result = CollectBatch.safeParse(req.parsed);
      expect(result.success, JSON.stringify(result.success ? '' : result.error.issues)).toBe(true);
      for (const e of req.parsed.events) kinds.add(e.event_name);
    }
    // every wire event kind actually went through the schema
    expect([...kinds].sort()).toEqual(
      [
        'checkout_completed',
        'checkout_contact_info_submitted',
        'checkout_started',
        'consent_granted',
        'consent_withdrawn',
        'page_viewed',
        'product_added_to_cart',
        'product_viewed',
      ].sort(),
    );
  });

  it('signs exactly what the Collector verifies: HMAC-SHA256(secret, collectSigningInput(ts, body)), hex', async () => {
    const h = harness();
    await startPixel(h.api, h.deps);
    h.emit('page_viewed', shopifyEvent());
    await h.advance(2_000);
    const req = h.sent[0]!;
    const ts = req.query.get('ts')!;
    const expected = createHmac('sha256', GOOD_SETTINGS.signingSecret!)
      .update(collectSigningInput(ts, req.body))
      .digest('hex');
    expect(req.query.get('sig')).toBe(expected);
  });

  it('sends no raw identifier anywhere but contact, and only on the two checkout events', async () => {
    const h = harness();
    await startPixel(h.api, h.deps);
    h.emit('page_viewed', shopifyEvent());
    h.emit('checkout_completed', checkoutCompleted());
    await h.advance(2_000);
    for (const req of h.sent) {
      for (const e of req.parsed.events) {
        const allowed = ['checkout_completed', 'checkout_contact_info_submitted'].includes(
          e.event_name,
        );
        expect('contact' in e).toBe(allowed);
      }
    }
    // and the query string (which ends up in access logs) carries no shopper data
    for (const req of h.sent) {
      expect(req.url).not.toMatch(/example\.com\/?\?.*(shopper|8123456709)/);
      expect(req.url).not.toContain('8123456709');
    }
  });
});
