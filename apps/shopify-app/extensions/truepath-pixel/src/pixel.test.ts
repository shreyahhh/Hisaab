import { describe, expect, it } from 'vitest';
import {
  COLLECT_MAX_BODY_BYTES,
  CONSENT_REFRESH_INTERVAL_MS,
  CONSENT_STORAGE_KEY,
  VISITOR_STORAGE_KEY,
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
import { UUID_V7_PATTERN } from './uuid.js';

async function started(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  const pixel = await startPixel(h.api, h.deps);
  await h.settle();
  return { h, pixel };
}

const names = (req: { parsed: { events: Array<{ event_name: string }> } }) =>
  req.parsed.events.map((e) => e.event_name);

describe('configuration', () => {
  it.each([
    ['no store key', { ...GOOD_SETTINGS, storeKey: undefined }],
    ['no collector url', { ...GOOD_SETTINGS, collectorUrl: undefined }],
    ['no signing secret', { ...GOOD_SETTINGS, signingSecret: undefined }],
    [
      'a plain-http remote collector',
      { ...GOOD_SETTINGS, collectorUrl: 'http://collect.example.com' },
    ],
    [
      'a look-alike localhost host',
      { ...GOOD_SETTINGS, collectorUrl: 'http://localhost.evil.com' },
    ],
    ['a notice version over 32 chars', { ...GOOD_SETTINGS, noticeVersion: 'v'.repeat(33) }],
  ])('does nothing at all with %s', async (_label, settings) => {
    const h = harness({ settings });
    expect(await startPixel(h.api, h.deps)).toBeNull();
    expect(h.handlers.size).toBe(0); // it never even subscribed
    await h.advance(10_000);
    expect(h.sent).toHaveLength(0);
  });

  it('accepts http://localhost for local development, and trims a trailing slash', async () => {
    const { h } = await started({
      settings: { ...GOOD_SETTINGS, collectorUrl: 'http://localhost:3001/' },
    });
    h.emit('page_viewed', shopifyEvent());
    await h.advance(2_000);
    expect(h.sent[0]?.url.startsWith('http://localhost:3001/v1/collect?')).toBe(true);
  });
});

describe('visitor id and the first batch', () => {
  it('creates and persists a UUID v7 on first sight, and marks only the first batch visitor_new', async () => {
    const { h } = await started();
    const stored = h.storage.get(VISITOR_STORAGE_KEY);
    expect(stored).toMatch(UUID_V7_PATTERN);

    h.emit('page_viewed', shopifyEvent());
    await h.advance(2_000);
    h.emit('page_viewed', shopifyEvent());
    await h.advance(2_000);

    expect(h.sent).toHaveLength(2);
    expect(h.sent.map((r) => r.parsed.visitor_id)).toEqual([stored, stored]);
    expect(h.sent.map((r) => r.parsed.visitor_new)).toEqual([true, false]);
  });

  it('reuses a stored visitor id and is not new', async () => {
    const id = '0192f3a4-7b1c-7c2d-8e3f-4a5b6c7d8e9f';
    const { h } = await started({
      storage: {
        [VISITOR_STORAGE_KEY]: id,
        [CONSENT_STORAGE_KEY]: JSON.stringify({
          at: Date.parse('2026-09-28T09:00:00Z'),
          analytics: true,
          marketing: false,
        }),
      },
    });
    h.emit('page_viewed', shopifyEvent());
    await h.advance(2_000);
    expect(h.sent[0]?.parsed.visitor_id).toBe(id);
    expect(h.sent[0]?.parsed.visitor_new).toBe(false);
  });

  it('replaces a stored id that is not a UUID v7 (a tampered or legacy value)', async () => {
    const { h } = await started({ storage: { [VISITOR_STORAGE_KEY]: 'not-a-uuid' } });
    expect(h.storage.get(VISITOR_STORAGE_KEY)).toMatch(UUID_V7_PATTERN);
  });

  it('still works, with an in-memory id, when storage is unavailable', async () => {
    const { h } = await started({ failStorage: true });
    h.emit('page_viewed', shopifyEvent());
    await h.advance(2_000);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.parsed.visitor_id).toMatch(UUID_V7_PATTERN);
  });
});

describe('consent gate (SPEC P-1, P-3)', () => {
  it('sends nothing while analytics is not allowed, however many events fire', async () => {
    const { h } = await started({ analytics: false });
    for (let i = 0; i < 30; i += 1) h.emit('page_viewed', shopifyEvent());
    h.emit('checkout_completed', checkoutCompleted());
    await h.advance(60_000);
    expect(h.sent).toHaveLength(0);
    expect(h.pendingTimers()).toBe(0);
    expect(h.storage.has(CONSENT_STORAGE_KEY)).toBe(false); // it didn't even record a grant
  });

  it("reports the load-time state as consent_granted 'initial_state' for a new visitor", async () => {
    const { h } = await started();
    await h.advance(2_000);
    const first = h.sent[0]!;
    expect(names(first)).toEqual(['consent_granted']);
    expect(first.parsed.events[0]).toMatchObject({ trigger: 'initial_state' });
    expect(first.parsed.consent).toEqual({
      analytics: true,
      marketing: false,
      notice_version: 'v1',
    });
    expect(first.parsed.visitor_new).toBe(true);
  });

  it("reports a banner interaction as consent_granted 'interaction' — even when nothing changed", async () => {
    const { h } = await started();
    await h.advance(2_000);
    h.emit('visitorConsentCollected', {
      customerPrivacy: { analyticsProcessingAllowed: true, marketingAllowed: false },
    });
    await h.advance(2_000);
    expect(h.sent.at(-1)?.parsed.events[0]).toMatchObject({
      event_name: 'consent_granted',
      trigger: 'interaction',
    });
  });

  it('on withdrawal drops what is buffered, sends consent_withdrawn at once, then stays silent', async () => {
    const { h } = await started();
    await h.advance(2_000); // initial consent batch goes out
    h.emit('page_viewed', shopifyEvent());
    h.emit('product_viewed', productViewed());
    // Withdraw before the 2 s flush timer fires.
    h.emit('visitorConsentCollected', {
      customerPrivacy: { analyticsProcessingAllowed: false, marketingAllowed: false },
    });
    await h.settle();

    const withdrawal = h.sent.at(-1)!;
    expect(names(withdrawal)).toEqual(['consent_withdrawn']); // the buffered page/product events are gone
    expect(withdrawal.parsed.consent.analytics).toBe(false);
    expect(h.sent.flatMap(names)).not.toContain('product_viewed');

    const before = h.sent.length;
    h.emit('page_viewed', shopifyEvent());
    h.emit('checkout_completed', checkoutCompleted());
    await h.advance(10_000);
    expect(h.sent).toHaveLength(before);
  });

  it('resumes after a later re-grant', async () => {
    const { h } = await started();
    await h.advance(2_000);
    h.emit('visitorConsentCollected', {
      customerPrivacy: { analyticsProcessingAllowed: false, marketingAllowed: false },
    });
    await h.settle();
    h.emit('visitorConsentCollected', {
      customerPrivacy: { analyticsProcessingAllowed: true, marketingAllowed: true },
    });
    h.emit('page_viewed', shopifyEvent());
    await h.advance(2_000);
    const last = h.sent.at(-1)!;
    expect(names(last)).toEqual(['consent_granted', 'page_viewed']);
    expect(last.parsed.consent.marketing).toBe(true);
  });

  it('ignores a malformed visitorConsentCollected event', async () => {
    const { h } = await started();
    await h.advance(2_000);
    const before = h.sent.length;
    h.emit('visitorConsentCollected', null);
    h.emit('visitorConsentCollected', { customerPrivacy: 'yes' });
    h.emit('visitorConsentCollected', {});
    h.emit('page_viewed', shopifyEvent());
    await h.advance(2_000);
    expect(names(h.sent[before]!)).toEqual(['page_viewed']); // consent state was untouched
  });

  it('records a withdrawal if it loads with analytics off after having recorded a grant', async () => {
    const { h } = await started({
      analytics: false,
      storage: {
        [VISITOR_STORAGE_KEY]: '0192f3a4-7b1c-7c2d-8e3f-4a5b6c7d8e9f',
        [CONSENT_STORAGE_KEY]: JSON.stringify({ at: 1, analytics: true, marketing: false }),
      },
    });
    expect(h.sent.map(names)).toEqual([['consent_withdrawn']]);
  });
});

describe('consent refresh (SPEC v0.6 §7.1)', () => {
  const visitor = '0192f3a4-7b1c-7c2d-8e3f-4a5b6c7d8e9f';
  const startMs = Date.parse('2026-09-28T10:00:00.000Z');
  const recordedAgo = (ms: number, marketing = false) => ({
    [VISITOR_STORAGE_KEY]: visitor,
    [CONSENT_STORAGE_KEY]: JSON.stringify({ at: startMs - ms, analytics: true, marketing }),
  });

  it('sends nothing for a returning visitor whose consent was recorded recently', async () => {
    const { h } = await started({ startMs, storage: recordedAgo(CONSENT_REFRESH_INTERVAL_MS - 1) });
    await h.advance(5_000);
    expect(h.sent).toHaveLength(0);
  });

  it("re-asserts a still-granted consent older than 30 days as 'refresh'", async () => {
    const { h } = await started({ startMs, storage: recordedAgo(CONSENT_REFRESH_INTERVAL_MS + 1) });
    await h.advance(2_000);
    expect(h.sent[0]?.parsed.events[0]).toMatchObject({ trigger: 'refresh' });
    expect(h.sent[0]?.parsed.visitor_new).toBe(false);
  });

  it("reports marketing consent that changed while it wasn't watching as 'refresh'", async () => {
    const { h } = await started({ startMs, marketing: true, storage: recordedAgo(1000, false) });
    await h.advance(2_000);
    expect(h.sent[0]?.parsed.events[0]).toMatchObject({ trigger: 'refresh' });
    expect(h.sent[0]?.parsed.consent.marketing).toBe(true);
  });

  it("treats an earlier recorded withdrawal followed by a load with analytics on as 'initial_state'", async () => {
    const { h } = await started({
      startMs,
      storage: {
        [VISITOR_STORAGE_KEY]: visitor,
        [CONSENT_STORAGE_KEY]: JSON.stringify({
          at: startMs - 1000,
          analytics: false,
          marketing: false,
        }),
      },
    });
    await h.advance(2_000);
    expect(h.sent[0]?.parsed.events[0]).toMatchObject({ trigger: 'initial_state' });
  });
});

describe('click ids (fbp / fbc)', () => {
  const cookies = { _fbp: 'fb.1.1700000000000.123', _fbc: 'fb.1.1700000000000.abc' };

  it('are included only with marketing consent', async () => {
    const withMarketing = await started({ marketing: true, cookies });
    withMarketing.h.emit('page_viewed', shopifyEvent());
    await withMarketing.h.advance(2_000);
    expect(withMarketing.h.sent[0]?.parsed.click).toEqual({
      fbp: cookies._fbp,
      fbc: cookies._fbc,
    });

    const without = await started({ marketing: false, cookies });
    without.h.emit('page_viewed', shopifyEvent());
    await without.h.advance(2_000);
    expect(without.h.sent[0]?.parsed).not.toHaveProperty('click');
  });

  it('are omitted when the cookies are absent or oversized', async () => {
    const { h } = await started({ marketing: true, cookies: { _fbp: 'x'.repeat(200) } });
    h.emit('page_viewed', shopifyEvent());
    await h.advance(2_000);
    expect(h.sent[0]?.parsed).not.toHaveProperty('click');
  });
});

describe('batching and limits', () => {
  it('flushes at 25 events without waiting for the timer', async () => {
    const { h } = await started({ storage: freshVisitor() });
    for (let i = 0; i < 25; i += 1) h.emit('page_viewed', shopifyEvent());
    await h.settle();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.parsed.events).toHaveLength(25);
  });

  it('splits more than 25 events across requests, in order, none lost', async () => {
    const { h } = await started({ storage: freshVisitor() });
    for (let i = 0; i < 60; i += 1) {
      h.emit(
        'page_viewed',
        shopifyEvent({}, { timestamp: new Date(1_800_000_000_000 + i * 1000).toISOString() }),
      );
    }
    await h.advance(2_000);
    const events = h.sent.flatMap((r) => r.parsed.events);
    expect(events).toHaveLength(60);
    expect(h.sent.every((r) => r.parsed.events.length <= 25)).toBe(true);
    expect(events.map((e) => e.occurred_at)).toEqual([...events.map((e) => e.occurred_at)].sort());
  });

  it('never sends a body over 10,240 bytes: shrinks the batch, and drops a single event that cannot fit', async () => {
    const { h } = await started({ storage: freshVisitor() });
    const longQuery = 'a'.repeat(1900);
    for (let i = 0; i < 20; i += 1) {
      h.emit(
        'page_viewed',
        shopifyEvent(
          {},
          {
            context: {
              document: {
                location: { href: `https://shop.example.com/p?${longQuery}` },
                referrer: `https://ref.example.com/?${longQuery}`,
              },
            },
          },
        ),
      );
    }
    await h.advance(2_000);
    expect(h.sent.length).toBeGreaterThan(1);
    for (const req of h.sent) {
      expect(Buffer.byteLength(req.body, 'utf8')).toBeLessThanOrEqual(COLLECT_MAX_BODY_BYTES);
    }
    expect(h.sent.flatMap((r) => r.parsed.events)).toHaveLength(20);
  });

  it('flushes an order confirmation immediately — the page may unload right after', async () => {
    const { h } = await started({ storage: freshVisitor() });
    h.emit('checkout_completed', checkoutCompleted());
    await h.settle();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.parsed.events[0]).toMatchObject({
      event_name: 'checkout_completed',
      properties: { order_id: '5001', checkout_token: 'co_123' },
      // phone falls back to the shipping-address phone (COD)
      contact: { email: 'shopper@example.com', phone: '+918123456709' },
    });
  });

  it('bounds memory: while the network is stuck, only the newest 200 events are kept', async () => {
    const { h } = await started({ storage: freshVisitor() });
    const realPost = h.deps.post;
    let release: () => void = () => undefined;
    h.deps.post = () => new Promise<void>((resolve) => (release = resolve)); // the first send hangs

    h.emit('page_viewed', shopifyEvent());
    await h.advance(2_000); // starts the (stuck) send
    for (let i = 0; i < 500; i += 1) {
      h.emit(
        'page_viewed',
        shopifyEvent({}, { timestamp: new Date(1_800_000_000_000 + i).toISOString() }),
      );
    }
    h.deps.post = realPost;
    release();
    await h.advance(2_000);

    const events = h.sent.flatMap((r) => r.parsed.events);
    expect(events).toHaveLength(200);
    // the newest survive: the last event emitted is the last one sent
    expect(events.at(-1)?.occurred_at).toBe(new Date(1_800_000_000_000 + 499).toISOString());
  });
});

describe('request signing (collector.md §4 step 3)', () => {
  it('puts store key, timestamp, key id and a verifiable HMAC in the query string', async () => {
    const { createHmac } = await import('node:crypto');
    const { h } = await started({ storage: freshVisitor() });
    h.emit('page_viewed', shopifyEvent());
    await h.advance(2_000);

    const req = h.sent[0]!;
    expect(req.query.get('k')).toBe(GOOD_SETTINGS.storeKey);
    expect(req.query.get('kid')).toBe('s1');
    const ts = req.query.get('ts')!;
    expect(Number(ts)).toBe(Math.floor(Date.parse('2026-09-28T10:00:02.000Z') / 1000));
    const expected = createHmac('sha256', GOOD_SETTINGS.signingSecret!)
      .update(`${ts}.${req.body}`)
      .digest('hex');
    expect(req.query.get('sig')).toBe(expected);
    expect(req.url).not.toContain(GOOD_SETTINGS.signingSecret);
  });
});

describe('never disturbs the page', () => {
  it('a failed send is swallowed and not retried', async () => {
    const { h } = await started({ storage: freshVisitor(), failPost: true });
    h.emit('page_viewed', shopifyEvent());
    await h.advance(2_000);
    await h.advance(60_000);
    expect(h.sent).toHaveLength(0);
    expect(h.pendingTimers()).toBe(0); // no retry timer
  });

  it('a signing failure is swallowed (no unhandled rejection)', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const { h } = await started({ storage: freshVisitor(), failHmac: true });
      h.emit('page_viewed', shopifyEvent());
      await h.advance(2_000);
      expect(h.sent).toHaveLength(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('garbage events are ignored, never thrown', async () => {
    const { h } = await started({ storage: freshVisitor() });
    for (const name of [
      'page_viewed',
      'product_viewed',
      'product_added_to_cart',
      'checkout_started',
      'checkout_contact_info_submitted',
      'checkout_completed',
    ]) {
      expect(() => h.emit(name, undefined)).not.toThrow();
      expect(() => h.emit(name, null)).not.toThrow();
      expect(() => h.emit(name, { data: 'x', context: 5 })).not.toThrow();
    }
    await h.advance(5_000);
    expect(h.sent).toHaveLength(0);
  });

  it('maps a full shopping session in order', async () => {
    const { h } = await started({ storage: freshVisitor() });
    h.emit('page_viewed', shopifyEvent());
    h.emit('product_viewed', productViewed());
    h.emit('product_added_to_cart', addedToCart());
    await h.advance(2_000);
    const events = h.sent[0]!.parsed.events;
    expect(events.map((e) => e.event_name)).toEqual([
      'page_viewed',
      'product_viewed',
      'product_added_to_cart',
    ]);
    expect(events[2]).toMatchObject({
      properties: { quantity: 2, line_total: { amount_paise: 259850, currency: 'INR' } },
    });
  });
});

/** A returning visitor with a fresh consent record, so a test sees no consent event mixed into its batches. */
function freshVisitor(): Record<string, string> {
  return {
    [VISITOR_STORAGE_KEY]: '0192f3a4-7b1c-7c2d-8e3f-4a5b6c7d8e9f',
    [CONSENT_STORAGE_KEY]: JSON.stringify({
      at: Date.parse('2026-09-28T09:59:00Z'),
      analytics: true,
      marketing: false,
    }),
  };
}
