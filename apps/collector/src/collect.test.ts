import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestIdentityHasher } from '@truepath/privacy/testing';
import { findPii, storeContext } from '@truepath/privacy';
import { COLLECT_MAX_BODY_BYTES } from '@truepath/shared';
import {
  UA_ANDROID_CHROME,
  VISITOR,
  batch,
  checkoutCompleted,
  consentGranted,
  consentWithdrawn,
  createHarness,
  pageViewed,
  redis,
  type Harness,
} from './testHarness.js';

// POST /v1/collect end to end through Fastify `inject`, against real Redis and the real Lua script
// (collector.md §8). Only the two global names (readiness marker, stream) are isolated per run.

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
  await h.markReady();
});
afterEach(async () => {
  await h.close();
});
afterAll(async () => {
  redis.disconnect();
});

describe('accepted batches (collector.md §4 steps 8-10)', () => {
  it('appends one stream entry per event, with parsed device fields and sanitised URLs', async () => {
    const f = await h.addStore();
    const res = await h.post(
      f,
      batch([pageViewed(f), consentGranted(f, 'initial_state')], { visitor_new: true }),
    );
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    const entries = await h.stream();
    expect(entries).toHaveLength(2);
    const page = entries.find((e) => e.event_name === 'page_viewed')!;
    expect(page).toMatchObject({
      kind: 'event',
      store_id: f.storeId,
      visitor_id: VISITOR,
      visitor_new: true,
      device_type: 'mobile',
      os: 'Android',
      browser: 'Chrome',
      is_in_app_browser: 0,
      geo_state: '',
      geo_city: '',
      consent_purposes: ['attribution_analytics'],
      identity: {},
      properties: {},
    });
    // Only allow-listed campaign params survive; the unlisted `color` and a raw email param don't.
    expect(page.page_url).toBe(
      `https://${f.shopHost}/products/tee?utm_source=facebook&utm_medium=paid_social`,
    );
    // The referrer keeps origin + path only, never its query.
    expect(page.referrer).toBe('https://l.instagram.com/some/path');
    const consent = entries.find((e) => e.event_name === 'consent_granted')!;
    expect(consent.consent_trigger).toBe('initial_state');
    // consent_records needs the notice version (P-4), so consent events — and only they — carry it.
    expect(consent.notice_version).toBe('v1');
    expect(page.notice_version).toBeUndefined();
  });

  it('hashes phone and email: no raw identifier reaches the stream, only versioned HMACs', async () => {
    const f = await h.addStore();
    await h.post(f, batch([checkoutCompleted(f)]));
    const [entry] = await h.stream();
    expect(entry?.identity).toMatchObject({
      phone_hmac: expect.stringMatching(/^k1:[0-9a-f]{64}$/),
      email_hmac: expect.stringMatching(/^k1:[0-9a-f]{64}$/),
      identity_hash_hmac: expect.stringMatching(/^k1:[0-9a-f]{64}$/),
    });
    // identity_hash_hmac is the phone hash (phone first, SPEC §7.3 rule 3).
    expect((entry?.identity as Record<string, string>).identity_hash_hmac).toBe(
      (entry?.identity as Record<string, string>).phone_hmac,
    );

    const raw = JSON.stringify(entry);
    expect(raw).not.toMatch(/8123456709|shopper@example\.com/i);
    // Scan for raw identifiers with the versioned HMACs (`k<N>:<64 hex>`) removed: they are the intended
    // output, and a random 64-hex string can by chance contain a digit run shaped like a mobile number.
    const withoutHmacs = raw.replace(/k\d+:[0-9a-f]{64}/g, '');
    expect(findPii(withoutHmacs).filter((p) => p.kind === 'email' || p.kind === 'phone')).toEqual(
      [],
    );
    // Money is flattened to paise + currency; the order id survives for stitching.
    expect(entry?.properties).toEqual({
      checkout_token: 'abc123',
      order_id: '5001',
      total_paise: 129900,
      currency: 'INR',
    });
  });

  it('a dummy phone is never hashed (SPEC §5.4) — the email still is', async () => {
    const f = await h.addStore();
    await h.post(f, batch([checkoutCompleted(f, { phone: '9876543210', email: 'a@example.com' })]));
    const [entry] = await h.stream();
    const identity = entry?.identity as Record<string, string>;
    expect(identity.phone_hmac).toBeUndefined();
    expect(identity.email_hmac).toMatch(/^k1:/);
    expect(identity.identity_hash_hmac).toBe(identity.email_hmac);
  });

  it('never stores or forwards the IP or raw user agent, only what was parsed from them', async () => {
    const f = await h.addStore();
    await h.post(f, batch([pageViewed(f)]), {
      ip: '198.51.100.23',
      userAgent: `${UA_ANDROID_CHROME} SecretDeviceTag/9`,
    });
    const raw = JSON.stringify(await h.stream());
    expect(raw).not.toContain('198.51.100.23');
    expect(raw).not.toContain('SecretDeviceTag');
    expect(raw).not.toContain('Mozilla');
  });

  it('flags in-app browsers (Instagram, Facebook, WebView)', async () => {
    const f = await h.addStore();
    for (const marker of [
      'Instagram 300.0',
      'FBAN/FBIOS',
      'FBAV/400',
      'Line/13',
      'Snapchat/12',
      '; wv)',
    ]) {
      await h.post(f, batch([pageViewed(f)]), { userAgent: `${UA_ANDROID_CHROME} ${marker}` });
    }
    const flags = (await h.stream()).map((e) => e.is_in_app_browser);
    expect(flags).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('uses the geo lookup for state/city, without ever storing the IP', async () => {
    let seenIp = '';
    const geoHarness = await createHarness({
      geo: {
        ready: true,
        source: 'test',
        lookup: (ip) => {
          seenIp = ip;
          return { state: 'Karnataka', city: 'Bengaluru' };
        },
      },
    });
    try {
      await geoHarness.markReady();
      const f = await geoHarness.addStore();
      await geoHarness.post(f, batch([pageViewed(f)]), { ip: '198.51.100.99' });
      const [entry] = await geoHarness.stream();
      expect(entry).toMatchObject({ geo_state: 'Karnataka', geo_city: 'Bengaluru' });
      expect(seenIp).toBe('198.51.100.99');
      expect(JSON.stringify(entry)).not.toContain('198.51.100.99');
    } finally {
      await geoHarness.close();
    }
  });

  it('trusts exactly one proxy hop: the client IP is the right-most X-Forwarded-For entry, so a spoofed left part is ignored', async () => {
    let seenIp = '';
    const spy = await createHarness({
      geo: {
        ready: true,
        source: 'test',
        lookup: (ip) => {
          seenIp = ip;
          return { state: '', city: '' };
        },
      },
    });
    try {
      await spy.markReady();
      const f = await spy.addStore();
      // The ALB appends the address it saw (198.51.100.9); a client can only prepend to the left.
      await spy.post(f, batch([pageViewed(f)]), { forwardedFor: '9.9.9.9, 198.51.100.9' });
      expect(seenIp).toBe('198.51.100.9');
    } finally {
      await spy.close();
    }
  });

  it('accepts application/json as well as text/plain', async () => {
    const f = await h.addStore();
    const res = await h.post(f, batch([pageViewed(f)]), { contentType: 'application/json' });
    expect(res.statusCode).toBe(204);
    expect(await h.stream()).toHaveLength(1);
  });

  it('records a batch of every kind in one round trip and preserves event order', async () => {
    const f = await h.addStore();
    const events = [consentGranted(f), pageViewed(f), pageViewed(f), checkoutCompleted(f)];
    await h.post(f, batch(events));
    expect((await h.stream()).map((e) => e.event_id)).toEqual(events.map((e) => e.event_id));
  });
});

describe('consent (SPEC P-1, P-3, P-6; collector.md §4 step 7)', () => {
  it('analytics:false → 204, nothing stored, drop counter incremented (§5.10 test 1)', async () => {
    const f = await h.addStore();
    const res = await h.post(
      f,
      batch([pageViewed(f), pageViewed(f)], {
        consent: { analytics: false, marketing: false, notice_version: 'v1' },
      }),
    );
    expect(res.statusCode).toBe(204);
    expect(await h.stream()).toEqual([]);
    expect((await h.stats(f)).no_analytics_consent).toBe('2');
  });

  it('a withdrawal is forwarded even with analytics:false (P-3), carrying no purposes', async () => {
    const f = await h.addStore();
    await h.post(
      f,
      batch([pageViewed(f), consentWithdrawn(f)], {
        consent: { analytics: false, marketing: false, notice_version: 'v1' },
      }),
    );
    const entries = await h.stream();
    expect(entries.map((e) => e.event_name)).toEqual(['consent_withdrawn']);
    expect(entries[0]?.consent_purposes).toEqual([]);
  });

  it('fbp/fbc only with marketing consent, and never for a child-directed store', async () => {
    const f = await h.addStore();
    const click = { fbp: 'fb.1.1.2', fbc: 'fb.1.1.abc' };
    await h.post(
      f,
      batch([pageViewed(f)], {
        click,
        consent: { analytics: true, marketing: true, notice_version: 'v1' },
      }),
    );
    await h.post(
      f,
      batch([pageViewed(f)], {
        click,
        consent: { analytics: true, marketing: false, notice_version: 'v1' },
      }),
    );
    const [withMarketing, without] = await h.stream();
    expect(withMarketing).toMatchObject({ fbp: click.fbp, fbc: click.fbc });
    expect(withMarketing?.consent_purposes).toEqual([
      'attribution_analytics',
      'ad_platform_measurement',
    ]);
    expect(without).not.toHaveProperty('fbp');

    const kids = await h.addStore({ childDirected: true });
    await h.post(
      kids,
      batch([pageViewed(kids)], {
        click,
        consent: { analytics: true, marketing: true, notice_version: 'v1' },
      }),
    );
    const last = (await h.stream()).at(-1)!;
    expect(last.store_id).toBe(kids.storeId);
    expect(last).not.toHaveProperty('fbp');
    expect(last.consent_purposes).toEqual(['attribution_analytics']);
  });

  it('an inactive store drops everything, before any processing, and counts it', async () => {
    const f = await h.addStore({
      status: 'inactive',
      inactiveReason: 'consent_region_unconfirmed',
    });
    const res = await h.post(f, batch([pageViewed(f), consentGranted(f)]));
    expect(res.statusCode).toBe(204);
    expect(await h.stream()).toEqual([]);
    expect((await h.stats(f)).store_inactive).toBe('2');
  });
});

describe('suppression (HLD §8; collector.md §4 step 10)', () => {
  it('a WITHDRAWN visitor: page events dropped, consent_granted forwarded (re-consent works)', async () => {
    const f = await h.addStore();
    await h.suppress(f, 'withdrawn:visitor', h.visitorHmac(f, VISITOR));
    await h.post(f, batch([pageViewed(f), consentGranted(f), pageViewed(f)]));
    expect((await h.stream()).map((e) => e.event_name)).toEqual(['consent_granted']);
    expect((await h.stats(f)).suppressed_visitor).toBe('2');
  });

  it('an ERASED visitor: everything dropped, consent events included', async () => {
    const f = await h.addStore();
    await h.suppress(f, 'erased:visitor', h.visitorHmac(f, VISITOR));
    const res = await h.post(f, batch([pageViewed(f), consentGranted(f)]));
    expect(res.statusCode).toBe(204);
    expect(await h.stream()).toEqual([]);
    expect((await h.stats(f)).suppressed_visitor).toBe('2');
  });

  it('a suppression entry whose expiry has passed no longer suppresses', async () => {
    const f = await h.addStore();
    await h.suppress(
      f,
      'erased:visitor',
      h.visitorHmac(f, VISITOR),
      Math.floor(h.clock.now / 1000) - 1,
    );
    await h.post(f, batch([pageViewed(f)]));
    expect(await h.stream()).toHaveLength(1);
  });

  it('is per store: the same visitor id is not suppressed in another store (SPEC §7.3 rule 5)', async () => {
    const a = await h.addStore();
    const b = await h.addStore();
    await h.suppress(a, 'erased:visitor', h.visitorHmac(a, VISITOR));
    await h.post(a, batch([pageViewed(a)]));
    await h.post(b, batch([pageViewed(b)]));
    const entries = await h.stream();
    expect(entries.map((e) => e.store_id)).toEqual([b.storeId]);
  });

  it('finds an entry written under an older key version (rotation window)', async () => {
    const rotating = await createHarness({ hasher: createTestIdentityHasher(['k1', 'k2'], 'k2') });
    try {
      await rotating.markReady();
      const f = await rotating.addStore();
      const oldHasher = createTestIdentityHasher(['k1'], 'k1');
      // The master keys are per-hasher random in tests, so seed the OLD-version member using the
      // rotating hasher's own k1 derivation.
      const k1Member = rotating.hasher
        .hmacAll(storeContext(f.storeId), VISITOR)
        .find((m) => m.startsWith('k1:'))!;
      void oldHasher;
      await rotating.suppress(f, 'erased:visitor', k1Member);
      await rotating.post(f, batch([pageViewed(f)]));
      expect(await rotating.stream()).toEqual([]);
    } finally {
      await rotating.close();
    }
  });

  it('an erased IDENTITY on a new device: suppresses the visitor, emits a suppression_hit, drops the WHOLE batch', async () => {
    const f = await h.addStore();
    const first = await h.post(f, batch([pageViewed(f), checkoutCompleted(f)]));
    expect(first.statusCode).toBe(204);
    const [, done] = await h.stream();
    const phoneHmac = (done?.identity as Record<string, string>).phone_hmac!;

    // The shopper is later erased: their identity is suppressed. They return on a NEW device.
    await redis.del(h.keys.stream);
    await h.suppress(f, 'erased:identity', phoneHmac);
    const newVisitor = '0192f3a4-7b1c-7c2d-8e3f-aaaaaaaaaaaa';
    await h.post(f, batch([pageViewed(f), checkoutCompleted(f)], { visitor_id: newVisitor }));

    const entries = await h.stream();
    expect(entries).toHaveLength(1); // the earlier page_viewed in the same batch was dropped too
    expect(entries[0]).toMatchObject({
      kind: 'suppression_hit',
      store_id: f.storeId,
      visitor_id: newVisitor,
      identity_hash_hmac: phoneHmac,
    });
    expect((await h.stats(f)).suppressed_identity).toBe('2');

    // From now on that visitor is in the erased set: its next batch is dropped as a visitor.
    await h.post(f, batch([pageViewed(f)], { visitor_id: newVisitor }));
    expect(await h.stream()).toHaveLength(1);
    expect((await h.stats(f)).suppressed_visitor).toBe('1');
    expect(
      await redis.zscore(`suppress:${f.storeId}:erased:visitor`, h.visitorHmac(f, newVisitor)),
    ).not.toBeNull();
  });

  it('fails closed when suppress:ready is missing: 503, nothing appended, /readyz false', async () => {
    const f = await h.addStore();
    await h.markNotReady();
    const res = await h.post(f, batch([pageViewed(f)]));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'suppression_unavailable' });
    expect(await h.stream()).toEqual([]);

    const ready = await h.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({ status: 'not_ready', redis: true, suppression: false });

    await h.markReady();
    expect((await h.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    expect((await h.post(f, batch([pageViewed(f)]))).statusCode).toBe(204);
  });

  it('an inactive store still fails closed while suppression is unavailable', async () => {
    const f = await h.addStore({ status: 'inactive', inactiveReason: 'dpa_missing' });
    await h.markNotReady();
    expect((await h.post(f, batch([pageViewed(f)]))).statusCode).toBe(503);
  });
});

describe('authentication and validation (collector.md §2.3, §4 steps 1-6)', () => {
  it('401 unknown_store_key for a key with no config, and for a malformed one', async () => {
    const f = await h.addStore();
    const body = batch([pageViewed(f)]);
    const unknown = await h.post(f, body, { k: 'pk_' + 'Z'.repeat(24) });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual({ error: 'unknown_store_key' });
    expect((await h.post(f, body, { k: 'nonsense' })).json()).toEqual({
      error: 'unknown_store_key',
    });
  });

  it('401 invalid_signature for a wrong secret, tampered body, unknown kid or malformed sig', async () => {
    const f = await h.addStore();
    const body = batch([pageViewed(f)]);
    expect((await h.post(f, body, { secret: 'x'.repeat(43) })).json()).toEqual({
      error: 'invalid_signature',
    });
    expect((await h.post(f, body, { kid: 's9' })).json()).toEqual({ error: 'invalid_signature' });
    expect((await h.post(f, body, { sig: 'nothex' })).json()).toEqual({
      error: 'invalid_signature',
    });
    const other = JSON.stringify(batch([pageViewed(f)]));
    const good = await h.post(f, other);
    expect(good.statusCode).toBe(204);
    // Same signature, different body:
    const ts = Math.floor(h.clock.now / 1000);
    const { createHmac } = await import('node:crypto');
    const sig = createHmac('sha256', f.secret).update(`${ts}.${other}`).digest('hex');
    const tampered = other.replace('page_viewed', 'page_viewed ');
    expect((await h.post(f, tampered, { sig, ts })).statusCode).toBe(401);
  });

  it('401 stale_signature outside ±300 s, accepted just inside it', async () => {
    const f = await h.addStore();
    const now = Math.floor(h.clock.now / 1000);
    const body = batch([pageViewed(f)]);
    expect((await h.post(f, body, { ts: now - 301 })).json()).toEqual({ error: 'stale_signature' });
    expect((await h.post(f, body, { ts: now + 301 })).json()).toEqual({ error: 'stale_signature' });
    expect((await h.post(f, body, { ts: now - 299 })).statusCode).toBe(204);
    expect((await h.post(f, body, { ts: now + 299 })).statusCode).toBe(204);
  });

  it('accepts either of two signing keys during a rotation, and rejects a removed one', async () => {
    const f = await h.addStore({
      signingKeys: [
        { kid: 's1', secret: 'a'.repeat(43) },
        { kid: 's2', secret: 'b'.repeat(43) },
      ],
    });
    const body = batch([pageViewed(f)]);
    expect((await h.post(f, body, { kid: 's1', secret: 'a'.repeat(43) })).statusCode).toBe(204);
    expect((await h.post(f, body, { kid: 's2', secret: 'b'.repeat(43) })).statusCode).toBe(204);
    expect((await h.post(f, body, { kid: 's1', secret: 'b'.repeat(43) })).statusCode).toBe(401);
  });

  it('403 for a foreign Origin; `Origin: null` (the pixel sandbox) and the shop origin pass', async () => {
    const f = await h.addStore();
    const body = batch([pageViewed(f)]);
    expect((await h.post(f, body, { origin: 'https://evil.example.com' })).json()).toEqual({
      error: 'origin_not_allowed',
    });
    expect((await h.post(f, body, { origin: 'null' })).statusCode).toBe(204);
    expect((await h.post(f, body, { origin: `https://${f.shopHost}` })).statusCode).toBe(204);
  });

  it('drops events whose page host is not one of the store hosts (foreign_page), still 204', async () => {
    const f = await h.addStore();
    const res = await h.post(
      f,
      batch([
        pageViewed(f, { page_url: 'https://attacker.example.net/products/x' }),
        pageViewed(f),
      ]),
    );
    expect(res.statusCode).toBe(204);
    expect(await h.stream()).toHaveLength(1);
    expect((await h.stats(f)).foreign_page).toBe('1');
  });

  it('413 for a body over 10,240 bytes', async () => {
    const f = await h.addStore();
    const res = await h.post(f, 'x'.repeat(COLLECT_MAX_BODY_BYTES + 1));
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'payload_too_large' });
  });

  it('400 for non-JSON, unknown keys, a wrong type, and an unsupported content type', async () => {
    const f = await h.addStore();
    expect((await h.post(f, 'not json {')).json()).toEqual({ error: 'invalid_payload' });
    expect((await h.post(f, { ...batch([pageViewed(f)]), ip: '1.2.3.4' })).json()).toEqual({
      error: 'invalid_payload',
    });
    expect((await h.post(f, batch([pageViewed(f, { customer_name: 'Asha' })]))).json()).toEqual({
      error: 'invalid_payload',
    });
    expect((await h.post(f, batch([]))).statusCode).toBe(400);
    expect(
      (
        await h.post(f, batch([pageViewed(f)]), {
          contentType: 'application/x-www-form-urlencoded',
        })
      ).statusCode,
    ).toBe(400);
    expect(await h.stream()).toEqual([]);
  });

  it('429 when the per-IP limit is exceeded, without touching the stream', async () => {
    const limited = await createHarness({ ipLimit: { ratePerSecond: 0.001, burst: 2 } });
    try {
      await limited.markReady();
      const f = await limited.addStore();
      const statuses = [];
      for (let i = 0; i < 4; i += 1)
        statuses.push((await limited.post(f, batch([pageViewed(f)]))).statusCode);
      expect(statuses).toEqual([204, 204, 429, 429]);
      expect(await limited.stream()).toHaveLength(2);
    } finally {
      await limited.close();
    }
  });

  it('429 when the per-store limit (counted in events) is exceeded', async () => {
    const limited = await createHarness({ storeLimit: { ratePerSecond: 0.001, burst: 3 } });
    try {
      await limited.markReady();
      const f = await limited.addStore();
      const first = await limited.post(f, batch([pageViewed(f), pageViewed(f), pageViewed(f)]));
      const second = await limited.post(f, batch([pageViewed(f)]));
      expect([first.statusCode, second.statusCode]).toEqual([204, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('the clock (collector.md §4 step 9)', () => {
  it('drops an event older than 24 h (stale_event) and clamps one from the future to the receive time', async () => {
    const f = await h.addStore();
    await h.post(
      f,
      batch([
        pageViewed(f, {}, '2026-09-27T09:00:00.000Z'), // 25 h old
        pageViewed(f, {}, '2026-09-27T11:00:00.000Z'), // 23 h old: kept
        pageViewed(f, {}, '2026-09-28T13:00:00.000Z'), // 3 h ahead: clamped
      ]),
    );
    const entries = await h.stream();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.occurred_at).toBe('2026-09-27T11:00:00.000Z');
    expect(entries[1]?.occurred_at).toBe('2026-09-28T10:00:00.000Z');
    expect((await h.stats(f)).stale_event).toBe('1');
  });
});

describe('HTTP surface', () => {
  it('answers the preflight, and sets HSTS and CORS on every response', async () => {
    const options = await h.app.inject({ method: 'OPTIONS', url: '/v1/collect' });
    expect(options.statusCode).toBe(204);
    expect(options.headers['access-control-allow-origin']).toBe('*');
    expect(options.headers['access-control-allow-methods']).toBe('POST, OPTIONS');
    expect(options.headers['access-control-max-age']).toBe('86400');
    expect(options.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );

    const health = await h.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.json()).toEqual({ status: 'ok' });
    expect(health.headers['strict-transport-security']).toBeDefined();
    expect((await h.app.inject({ method: 'GET', url: '/nope' })).json()).toEqual({
      error: 'not_found',
    });
  });

  it('sets no cookie', async () => {
    const f = await h.addStore();
    const res = await h.post(f, batch([pageViewed(f)]));
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('returns 503 stream_unavailable when Redis fails mid-request, never a 204', async () => {
    const f = await h.addStore();
    const broken = await createHarness();
    try {
      // A Redis whose script calls fail: config lookups still work (they hit the cache path first).
      await broken.markReady();
      const g = await broken.addStore();
      const original = redis.evalsha.bind(redis);
      (redis as unknown as { evalsha: unknown }).evalsha = () =>
        Promise.reject(new Error('connection lost'));
      try {
        const res = await broken.post(g, batch([pageViewed(g)]));
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: 'stream_unavailable' });
      } finally {
        (redis as unknown as { evalsha: unknown }).evalsha = original;
      }
    } finally {
      await broken.close();
    }
    void f;
  });
});

describe('logging and PII (§5.10 test 4; collector.md §6)', () => {
  it('logs store, status and counts only — never the signature, visitor id, IP, UA or body', async () => {
    const f = await h.addStore();
    const res = await h.post(f, batch([pageViewed(f), checkoutCompleted(f)]), {
      ip: '198.51.100.55',
    });
    expect(res.statusCode).toBe(204);
    await h.post(f, batch([pageViewed(f)]), { sig: 'a'.repeat(64) }); // a 401 is logged too

    const output = JSON.stringify(h.logs);
    expect(h.logs.length).toBeGreaterThanOrEqual(2);
    for (const secret of [
      VISITOR,
      '198.51.100.55',
      'Mozilla',
      f.secret,
      'a'.repeat(64),
      '8123456709',
      'shopper@example.com',
      'utm_source',
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(
      findPii(output).filter(
        (p) => p.kind === 'email' || p.kind === 'phone' || p.kind === 'secret',
      ),
    ).toEqual([]);
    expect(h.logs[0]).toMatchObject({
      event: 'collect',
      store_id: f.storeId,
      status: 204,
      accepted: 2,
    });
    expect(h.logs[1]).toMatchObject({ status: 401, reason: 'invalid_signature' });
  });
});
