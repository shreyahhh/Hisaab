import { describe, expect, it } from 'vitest';
import {
  COLLECT_MAX_EVENTS_PER_BATCH,
  CollectBatch,
  CollectorStoreConfig,
  PIXEL_EVENT_NAMES,
  PixelEvent,
  STORE_KEY_PATTERN,
  collectSigningInput,
  collectorStoreKey,
} from './collector.js';

const VISITOR = '0192f3a4-7b1c-7c2d-8e3f-4a5b6c7d8e9f';
const EVENT_ID = '0192f3a4-7b1c-7c2d-8e3f-4a5b6c7d8ea0';
const NOW = '2026-09-28T10:00:00.000Z';
const money = { amount_paise: 129900, currency: 'INR' };

function base(extra: Record<string, unknown> = {}) {
  return {
    event_id: EVENT_ID,
    occurred_at: NOW,
    page_url: 'https://shop.example.com/products/tee?utm_source=facebook',
    referrer: 'https://l.instagram.com/',
    ...extra,
  };
}

// One valid example of every event name, so a new name can't be added without a fixture.
const VALID: Record<(typeof PIXEL_EVENT_NAMES)[number], Record<string, unknown>> = {
  page_viewed: base({ event_name: 'page_viewed' }),
  product_viewed: base({
    event_name: 'product_viewed',
    properties: { product_id: '11', variant_id: '22', price: money },
  }),
  product_added_to_cart: base({
    event_name: 'product_added_to_cart',
    properties: { product_id: '11', variant_id: '22', quantity: 2, line_total: money },
  }),
  checkout_started: base({
    event_name: 'checkout_started',
    properties: { checkout_token: 'abc', total: money },
  }),
  checkout_contact_info_submitted: base({
    event_name: 'checkout_contact_info_submitted',
    properties: { checkout_token: 'abc' },
    contact: { phone: '+918123456709' },
  }),
  checkout_completed: base({
    event_name: 'checkout_completed',
    properties: { checkout_token: 'abc', order_id: '5001', total: money },
    contact: { email: 'a@example.com', phone: '+918123456709' },
  }),
  consent_granted: base({ event_name: 'consent_granted', trigger: 'interaction' }),
  consent_withdrawn: base({ event_name: 'consent_withdrawn' }),
};

function batch(events: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    visitor_id: VISITOR,
    visitor_new: false,
    sent_at: NOW,
    consent: { analytics: true, marketing: false, notice_version: 'v1' },
    events,
    ...overrides,
  };
}

describe('PixelEvent (collector.md §2.2)', () => {
  it.each(PIXEL_EVENT_NAMES)('accepts a valid %s', (name) => {
    expect(PixelEvent.safeParse(VALID[name]).success).toBe(true);
  });

  it.each(PIXEL_EVENT_NAMES)('rejects an unknown key on %s (the PII-smuggling guard)', (name) => {
    expect(PixelEvent.safeParse({ ...VALID[name], customer_name: 'Asha' }).success).toBe(false);
  });

  it('rejects an unknown key inside properties and inside contact', () => {
    expect(
      PixelEvent.safeParse({
        ...VALID.checkout_completed,
        properties: { checkout_token: 'abc', order_id: '5001', total: money, note: 'x' },
      }).success,
    ).toBe(false);
    expect(
      PixelEvent.safeParse({
        ...VALID.checkout_completed,
        contact: { phone: '+918123456709', name: 'Asha' },
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown event name', () => {
    expect(PixelEvent.safeParse({ ...VALID.page_viewed, event_name: 'purchase' }).success).toBe(
      false,
    );
  });

  it('bounds money: no floats, no negatives, no absurd amounts', () => {
    const withTotal = (total: unknown) =>
      PixelEvent.safeParse({
        ...VALID.checkout_started,
        properties: { checkout_token: 'abc', total },
      }).success;
    expect(withTotal({ amount_paise: 100.5, currency: 'INR' })).toBe(false);
    expect(withTotal({ amount_paise: -1, currency: 'INR' })).toBe(false);
    expect(withTotal({ amount_paise: 10_000_000_001, currency: 'INR' })).toBe(false);
    expect(withTotal({ amount_paise: 100, currency: 'INRR' })).toBe(false);
    expect(withTotal({ amount_paise: 10_000_000_000, currency: 'INR' })).toBe(true);
  });

  it('requires a trigger on consent_granted and only the three known values', () => {
    const noTrigger = { ...VALID.consent_granted, trigger: undefined };
    expect(PixelEvent.safeParse(noTrigger).success).toBe(false);
    expect(PixelEvent.safeParse({ ...VALID.consent_granted, trigger: 'auto' }).success).toBe(false);
    for (const trigger of ['interaction', 'initial_state', 'refresh']) {
      expect(PixelEvent.safeParse({ ...VALID.consent_granted, trigger }).success).toBe(true);
    }
  });

  it('defaults a missing referrer to the empty string', () => {
    const noReferrer = { ...VALID.page_viewed, referrer: undefined };
    expect(PixelEvent.parse(noReferrer).referrer).toBe('');
  });

  it('rejects an offset-less timestamp and an over-long URL', () => {
    expect(
      PixelEvent.safeParse({ ...VALID.page_viewed, occurred_at: '2026-09-28T10:00:00' }).success,
    ).toBe(false);
    expect(
      PixelEvent.safeParse({
        ...VALID.page_viewed,
        page_url: `https://shop.example.com/${'a'.repeat(2100)}`,
      }).success,
    ).toBe(false);
  });
});

describe('CollectBatch (collector.md §2.2)', () => {
  it('accepts a batch of every event kind', () => {
    expect(CollectBatch.safeParse(batch(Object.values(VALID))).success).toBe(true);
  });

  it('requires a UUID v7 visitor id', () => {
    const v4 = '0192f3a4-7b1c-4c2d-8e3f-4a5b6c7d8e9f';
    expect(CollectBatch.safeParse(batch([VALID.page_viewed], { visitor_id: v4 })).success).toBe(
      false,
    );
    expect(CollectBatch.safeParse(batch([VALID.page_viewed], { visitor_id: 'nope' })).success).toBe(
      false,
    );
  });

  it('needs at least one event and at most 25', () => {
    expect(CollectBatch.safeParse(batch([])).success).toBe(false);
    const many = Array.from({ length: COLLECT_MAX_EVENTS_PER_BATCH + 1 }, () => VALID.page_viewed);
    expect(CollectBatch.safeParse(batch(many)).success).toBe(false);
    expect(CollectBatch.safeParse(batch(many.slice(0, COLLECT_MAX_EVENTS_PER_BATCH))).success).toBe(
      true,
    );
  });

  it('rejects unknown batch-level keys and a wrong version', () => {
    expect(CollectBatch.safeParse(batch([VALID.page_viewed], { ip: '1.2.3.4' })).success).toBe(
      false,
    );
    expect(CollectBatch.safeParse(batch([VALID.page_viewed], { v: 2 })).success).toBe(false);
    expect(
      CollectBatch.safeParse(
        batch([VALID.page_viewed], {
          consent: { analytics: true, marketing: false, notice_version: 'v1', ua: 'x' },
        }),
      ).success,
    ).toBe(false);
  });

  it('accepts click ids but rejects other keys inside click', () => {
    expect(
      CollectBatch.safeParse(
        batch([VALID.page_viewed], { click: { fbp: 'fb.1.1.2', fbc: 'fb.1.1.abc' } }),
      ).success,
    ).toBe(true);
    expect(
      CollectBatch.safeParse(batch([VALID.page_viewed], { click: { fbp: 'x', gclid: 'y' } }))
        .success,
    ).toBe(false);
  });
});

describe('CollectorStoreConfig (collector.md §2.5)', () => {
  const active = {
    storeId: '2b3fd8c6-2f6c-4b3a-9f0f-0e1a1f1d9c11',
    status: 'active',
    inactiveReason: null,
    allowedOrigins: ['https://shop.example.com'],
    signingKeys: [{ kid: 's1', secret: 'a'.repeat(43) }],
    childDirected: false,
    noticeVersion: 'v1',
  };

  it('accepts an active config and an inactive one with a reason', () => {
    expect(CollectorStoreConfig.safeParse(active).success).toBe(true);
    expect(
      CollectorStoreConfig.safeParse({
        ...active,
        status: 'inactive',
        inactiveReason: 'dpa_missing',
      }).success,
    ).toBe(true);
  });

  it('rejects an inactive config with no reason, and an active one with a stale reason', () => {
    expect(CollectorStoreConfig.safeParse({ ...active, status: 'inactive' }).success).toBe(false);
    expect(
      CollectorStoreConfig.safeParse({ ...active, inactiveReason: 'dpa_missing' }).success,
    ).toBe(false);
  });

  it('rejects short secrets, zero or three signing keys, and unknown keys', () => {
    expect(
      CollectorStoreConfig.safeParse({ ...active, signingKeys: [{ kid: 's1', secret: 'short' }] })
        .success,
    ).toBe(false);
    expect(CollectorStoreConfig.safeParse({ ...active, signingKeys: [] }).success).toBe(false);
    const key = (kid: string) => ({ kid, secret: 'a'.repeat(43) });
    expect(
      CollectorStoreConfig.safeParse({ ...active, signingKeys: [key('a'), key('b'), key('c')] })
        .success,
    ).toBe(false);
    expect(CollectorStoreConfig.safeParse({ ...active, extra: 1 }).success).toBe(false);
  });
});

describe('helpers', () => {
  it('signs `${ts}.${body}` and names the Redis key per HLD §8', () => {
    expect(collectSigningInput(1700000000, '{"a":1}')).toBe('1700000000.{"a":1}');
    expect(collectSigningInput('1700000000', 'x')).toBe('1700000000.x');
    expect(collectorStoreKey('pk_abc')).toBe('collector:store:pk_abc');
  });

  it('recognises the pk_ + 24 base62 store key shape', () => {
    expect(STORE_KEY_PATTERN.test(`pk_${'aZ09'.repeat(6)}`)).toBe(true);
    expect(STORE_KEY_PATTERN.test('pk_short')).toBe(false);
    expect(STORE_KEY_PATTERN.test(`sk_${'a'.repeat(24)}`)).toBe(false);
    expect(STORE_KEY_PATTERN.test(`pk_${'a'.repeat(23)}-`)).toBe(false);
  });
});
