import { describe, expect, it } from 'vitest';
import { storeBoundScope, statsCollectorKey, suppressionSetKey } from './keys.js';
import { TenantScopeViolationError } from './auth.js';
import {
  COLLECTOR_DROP_REASONS,
  StreamEntry,
  StreamEventEntry,
  StreamSuppressionHit,
} from './stream.js';

const HMAC = `k1:${'a'.repeat(64)}`;
const STORE = '2b3fd8c6-2f6c-4b3a-9f0f-0e1a1f1d9c11';

const event = {
  kind: 'event',
  store_id: STORE,
  event_id: '0192f3a4-7b1c-7c2d-8e3f-4a5b6c7d8ea0',
  event_name: 'checkout_completed',
  occurred_at: '2026-09-28T10:00:00.000+05:30',
  received_at: '2026-09-28T04:30:01.000Z',
  visitor_id: '0192f3a4-7b1c-7c2d-8e3f-4a5b6c7d8e9f',
  visitor_new: false,
  page_url: 'https://shop.example.com/checkouts/:token',
  referrer: '',
  device_type: 'mobile',
  os: 'Android',
  browser: 'Chrome',
  is_in_app_browser: 0,
  geo_state: '',
  geo_city: '',
  consent_purposes: ['attribution_analytics'],
  identity: { phone_hmac: HMAC, identity_hash_hmac: HMAC },
  properties: { order_id: '5001', total_paise: 129900, currency: 'INR' },
};

describe('stream contract', () => {
  it('accepts a full event entry and a suppression hit, and discriminates on kind', () => {
    expect(StreamEventEntry.safeParse(event).success).toBe(true);
    const hit = {
      kind: 'suppression_hit',
      store_id: STORE,
      visitor_id: 'v',
      identity_hash_hmac: HMAC,
      received_at: '2026-09-28T04:30:01.000Z',
    };
    expect(StreamSuppressionHit.safeParse(hit).success).toBe(true);
    expect(StreamEntry.parse(hit).kind).toBe('suppression_hit');
    expect(StreamEntry.parse(event).kind).toBe('event');
  });

  it('rejects an unhashed identifier in `identity` — only versioned HMACs can be carried', () => {
    for (const bad of ['+918123456709', 'a@example.com', 'a'.repeat(64), `sha:${'a'.repeat(64)}`]) {
      expect(StreamEventEntry.safeParse({ ...event, identity: { phone_hmac: bad } }).success).toBe(
        false,
      );
    }
  });

  it('rejects unknown keys, so a raw IP or user agent cannot ride along', () => {
    expect(StreamEventEntry.safeParse({ ...event, ip: '1.2.3.4' }).success).toBe(false);
    expect(StreamEventEntry.safeParse({ ...event, user_agent: 'Mozilla' }).success).toBe(false);
    expect(
      StreamEventEntry.safeParse({ ...event, identity: { ...event.identity, phone: '+91' } })
        .success,
    ).toBe(false);
  });

  it('allows only flat string/integer properties (no nested objects, no floats)', () => {
    expect(StreamEventEntry.safeParse({ ...event, properties: { a: { b: 1 } } }).success).toBe(
      false,
    );
    expect(StreamEventEntry.safeParse({ ...event, properties: { a: 1.5 } }).success).toBe(false);
    expect(StreamEventEntry.safeParse({ ...event, properties: {} }).success).toBe(true);
  });

  it('requires a known device type, consent purposes and in-app flag value', () => {
    expect(StreamEventEntry.safeParse({ ...event, device_type: 'tv' }).success).toBe(false);
    expect(StreamEventEntry.safeParse({ ...event, consent_purposes: ['everything'] }).success).toBe(
      false,
    );
    expect(StreamEventEntry.safeParse({ ...event, is_in_app_browser: 2 }).success).toBe(false);
  });
});

describe('Redis names (HLD §8)', () => {
  it('a store-bound scope builds keys for its own store, and refuses any other (ADR-0016)', () => {
    const scope = storeBoundScope(STORE);
    expect(suppressionSetKey(scope, STORE, 'erased:visitor')).toBe(
      `suppress:${STORE}:erased:visitor`,
    );
    expect(statsCollectorKey(scope, STORE, '20260928')).toBe(`stats:collector:${STORE}:20260928`);
    const other = '9b3fd8c6-2f6c-4b3a-9f0f-0e1a1f1d9c99';
    expect(() => suppressionSetKey(scope, other, 'erased:visitor')).toThrow(
      TenantScopeViolationError,
    );
    expect(() => statsCollectorKey(scope, other, '20260928')).toThrow(TenantScopeViolationError);
  });

  it('lists exactly the drop reasons the LLD names', () => {
    expect([...COLLECTOR_DROP_REASONS].sort()).toEqual(
      [
        'foreign_page',
        'no_analytics_consent',
        'stale_event',
        'store_inactive',
        'suppressed_identity',
        'suppressed_visitor',
      ].sort(),
    );
  });
});
