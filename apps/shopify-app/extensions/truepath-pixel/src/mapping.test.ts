import { PixelEvent } from '@truepath/shared';
import { describe, expect, it } from 'vitest';
import { consentEvent, mapStandardEvent, toMoney } from './mapping.js';
import { UUID_V7_PATTERN, uuidV7 } from './uuid.js';
import { checkoutCompleted, money, productViewed, shopifyEvent } from './testHarness.js';

const NOW = Date.parse('2026-09-28T10:00:00.000Z');
const newId = () => '0192f3a4-7b1c-7c2d-8e3f-000000000000';

describe('toMoney', () => {
  it.each([
    [{ amount: 1299, currencyCode: 'INR' }, 129900],
    [{ amount: '1299.00', currencyCode: 'INR' }, 129900],
    [{ amount: 0.29, currencyCode: 'INR' }, 29], // 0.29 * 100 = 28.999999999999996 → rounds, not truncates
    [{ amount: 19.99, currencyCode: 'INR' }, 1999],
    [{ amount: 0, currencyCode: 'INR' }, 0],
  ])('%j → %d paise', (input, paise) => {
    expect(toMoney(input)?.amount_paise).toBe(paise);
  });

  it.each([
    [{ amount: -1, currencyCode: 'INR' }],
    [{ amount: 'abc', currencyCode: 'INR' }],
    [{ amount: NaN, currencyCode: 'INR' }],
    [{ amount: 100, currencyCode: 'RS' }],
    [{ amount: 100_000_000_000, currencyCode: 'INR' }],
    [{ amount: 1 }],
    [null],
    ['12'],
  ])('rejects %j', (input) => {
    expect(toMoney(input)).toBeUndefined();
  });
});

describe('mapStandardEvent', () => {
  it('reuses a UUID event id from Shopify (so a replay keeps one id) and generates one otherwise', () => {
    const withUuid = mapStandardEvent(
      'page_viewed',
      shopifyEvent({}, { id: '0192F3A4-7B1C-7C2D-8E3F-ABCDEFABCDEF' }),
      NOW,
      newId,
    );
    expect(withUuid?.event_id).toBe('0192f3a4-7b1c-7c2d-8e3f-abcdefabcdef');
    const withoutUuid = mapStandardEvent(
      'page_viewed',
      shopifyEvent({}, { id: 'sh-123' }),
      NOW,
      newId,
    );
    expect(withoutUuid?.event_id).toBe(newId());
  });

  it("keeps the event's own timestamp, falling back to now when it is missing or invalid", () => {
    expect(
      mapStandardEvent(
        'page_viewed',
        shopifyEvent({}, { timestamp: '2026-09-01T00:00:00Z' }),
        NOW,
        newId,
      )?.occurred_at,
    ).toBe('2026-09-01T00:00:00.000Z');
    expect(
      mapStandardEvent('page_viewed', shopifyEvent({}, { timestamp: 'garbage' }), NOW, newId)
        ?.occurred_at,
    ).toBe('2026-09-28T10:00:00.000Z');
    expect(
      mapStandardEvent('page_viewed', shopifyEvent({}, { timestamp: undefined }), NOW, newId)
        ?.occurred_at,
    ).toBe('2026-09-28T10:00:00.000Z');
  });

  it('drops an event with no page URL, and trims an over-long one to its bare path', () => {
    expect(mapStandardEvent('page_viewed', { id: 'x', context: {} }, NOW, newId)).toBeNull();
    const long = mapStandardEvent(
      'page_viewed',
      shopifyEvent(
        {},
        {
          context: {
            document: {
              location: { href: `https://shop.example.com/p?${'a'.repeat(3000)}` },
              referrer: '',
            },
          },
        },
      ),
      NOW,
      newId,
    );
    expect(long?.page_url).toBe('https://shop.example.com/p');
  });

  it('numeric ids from Shopify are stringified; ids over 64 chars drop the event', () => {
    const numeric = mapStandardEvent(
      'product_viewed',
      shopifyEvent({ productVariant: { id: 4401, price: money(10), product: { id: 901 } } }),
      NOW,
      newId,
    );
    expect(numeric).toMatchObject({ properties: { variant_id: '4401', product_id: '901' } });
    const tooLong = mapStandardEvent(
      'product_viewed',
      shopifyEvent({
        productVariant: { id: 'x'.repeat(65), price: money(10), product: { id: '9' } },
      }),
      NOW,
      newId,
    );
    expect(tooLong).toBeNull();
  });

  it.each([0, -1, 1.5, 1000, '2'])('rejects a cart quantity of %j', (quantity) => {
    const event = shopifyEvent({
      cartLine: {
        quantity,
        cost: { totalAmount: money(10) },
        merchandise: { id: '1', product: { id: '2' } },
      },
    });
    expect(mapStandardEvent('product_added_to_cart', event, NOW, newId)).toBeNull();
  });

  it('checkout_contact_info_submitted needs a phone or an email — otherwise there is nothing to link', () => {
    const noContact = shopifyEvent({ checkout: { token: 't', email: null, phone: null } });
    expect(mapStandardEvent('checkout_contact_info_submitted', noContact, NOW, newId)).toBeNull();
    const emailOnly = shopifyEvent({ checkout: { token: 't', email: 'a@example.com' } });
    expect(
      mapStandardEvent('checkout_contact_info_submitted', emailOnly, NOW, newId),
    ).toMatchObject({
      contact: { email: 'a@example.com' },
    });
  });

  it('prefers checkout.phone over the shipping phone', () => {
    const event = checkoutCompleted({ phone: '+919812345670' });
    expect(mapStandardEvent('checkout_completed', event, NOW, newId)).toMatchObject({
      contact: { phone: '+919812345670' },
    });
  });

  it('checkout_completed without an order id is dropped, and passes a gid:// order id through unchanged', () => {
    expect(
      mapStandardEvent('checkout_completed', checkoutCompleted({ order: null }), NOW, newId),
    ).toBeNull();
    expect(
      mapStandardEvent(
        'checkout_completed',
        checkoutCompleted({ order: { id: 'gid://shopify/Order/5001' } }),
        NOW,
        newId,
      ),
    ).toMatchObject({ properties: { order_id: 'gid://shopify/Order/5001' } });
  });

  it('checkout_completed with no contact at all (unapproved protected data) still goes, with an empty contact', () => {
    const event = checkoutCompleted({ email: null, phone: null, shippingAddress: null });
    expect(mapStandardEvent('checkout_completed', event, NOW, newId)).toMatchObject({
      contact: {},
    });
  });

  it('everything it returns satisfies the strict wire schema', () => {
    const events = [
      mapStandardEvent('page_viewed', shopifyEvent(), NOW, newId),
      mapStandardEvent('product_viewed', productViewed(), NOW, newId),
      mapStandardEvent('checkout_completed', checkoutCompleted(), NOW, newId),
      consentEvent(
        'consent_granted',
        { url: 'https://shop.example.com/', referrer: '' },
        NOW,
        newId,
        'refresh',
      ),
      consentEvent(
        'consent_withdrawn',
        { url: 'https://shop.example.com/', referrer: '' },
        NOW,
        newId,
      ),
    ];
    for (const e of events) expect(PixelEvent.safeParse(e).success).toBe(true);
  });
});

describe('consentEvent', () => {
  it('returns null without a usable page URL, rather than emit an event the schema would reject', () => {
    expect(consentEvent('consent_withdrawn', { url: '', referrer: '' }, NOW, newId)).toBeNull();
    expect(
      consentEvent('consent_granted', { url: '', referrer: '' }, NOW, newId, 'refresh'),
    ).toBeNull();
  });
});

describe('uuidV7', () => {
  it('is a valid v7 with the timestamp in the first 48 bits, and is sortable by time', () => {
    const rand = new Uint8Array(16).fill(0xff);
    const a = uuidV7(NOW, rand);
    const b = uuidV7(NOW + 1, rand);
    expect(a).toMatch(UUID_V7_PATTERN);
    expect(parseInt(a.replace(/-/g, '').slice(0, 12), 16)).toBe(NOW);
    expect(a < b).toBe(true);
  });

  it('forces the version and variant bits whatever the random bytes are', () => {
    for (const fill of [0x00, 0xff, 0x5a]) {
      expect(uuidV7(NOW, new Uint8Array(16).fill(fill))).toMatch(UUID_V7_PATTERN);
    }
  });

  it('handles timestamps beyond 32 bits', () => {
    expect(uuidV7(2 ** 47, new Uint8Array(16))).toMatch(/^8000/);
  });
});
