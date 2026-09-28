import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { collectSigningInput, collectorStoreKey } from '@truepath/shared';
import {
  INGEST_SCRIPT,
  INGEST_SCRIPT_SHA,
  runIngest,
  type IngestArgs,
  type IngestKeys,
} from './ingest.js';
import {
  applyClockRules,
  flattenProperties,
  istDay,
  pageHostAllowed,
  parseUserAgent,
} from './minimise.js';
import { TokenBucketLimiter } from './rateLimit.js';
import { verifySignature } from './signature.js';
import { StoreConfigCache } from './storeConfig.js';

const NOW = Date.parse('2026-09-28T10:00:00.000Z');
const SECRET = 's'.repeat(43);
const sign = (ts: number | string, body: string, secret = SECRET) =>
  createHmac('sha256', secret).update(collectSigningInput(ts, body)).digest('hex');
const config = { signingKeys: [{ kid: 's1', secret: SECRET }] };

describe('verifySignature (collector.md §4 step 3)', () => {
  const ts = String(Math.floor(NOW / 1000));
  it('accepts a correct signature', () => {
    expect(verifySignature(config, { ts, kid: 's1', sig: sign(ts, 'body') }, 'body', NOW)).toEqual({
      ok: true,
    });
  });

  it.each([
    ['a different body', { ts, kid: 's1', sig: sign(ts, 'other') }],
    [
      'a different timestamp in the signed input',
      { ts, kid: 's1', sig: sign(Number(ts) + 1, 'body') },
    ],
    ['an unknown kid', { ts, kid: 's2', sig: sign(ts, 'body') }],
    ['the wrong secret', { ts, kid: 's1', sig: sign(ts, 'body', 'x'.repeat(43)) }],
    ['a short signature', { ts, kid: 's1', sig: 'ab' }],
    ['a non-hex signature', { ts, kid: 's1', sig: 'z'.repeat(64) }],
    ['a missing signature', { ts, kid: 's1', sig: undefined }],
    ['a missing kid', { ts, kid: undefined, sig: sign(ts, 'body') }],
    ['a non-numeric ts', { ts: 'abc', kid: 's1', sig: sign('abc', 'body') }],
    ['an empty ts', { ts: '', kid: 's1', sig: sign('', 'body') }],
  ])('rejects %s as invalid_signature', (_label, input) => {
    expect(verifySignature(config, input, 'body', NOW)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('rejects a timestamp more than 300 s away as stale, in either direction, and accepts 300 s', () => {
    const at = (offset: number) => {
      const t = String(Math.floor(NOW / 1000) + offset);
      return verifySignature(config, { ts: t, kid: 's1', sig: sign(t, 'b') }, 'b', NOW);
    };
    expect(at(-301)).toEqual({ ok: false, reason: 'stale_signature' });
    expect(at(301)).toEqual({ ok: false, reason: 'stale_signature' });
    expect(at(-300)).toEqual({ ok: true });
    expect(at(300)).toEqual({ ok: true });
  });

  it('checks the timestamp before the signature, so a stale replay never reaches the HMAC', () => {
    const t = String(Math.floor(NOW / 1000) - 10_000);
    expect(verifySignature(config, { ts: t, kid: 's1', sig: 'garbage' }, 'b', NOW)).toEqual({
      ok: false,
      reason: 'stale_signature',
    });
  });
});

describe('TokenBucketLimiter (collector.md §7)', () => {
  it('allows a burst, then refuses, then refills at the configured rate', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ ratePerSecond: 2, burst: 3 }, () => now);
    expect([1, 2, 3, 4].map(() => limiter.tryTake('a'))).toEqual([true, true, true, false]);
    now += 500; // +1 token
    expect(limiter.tryTake('a')).toBe(true);
    expect(limiter.tryTake('a')).toBe(false);
    now += 60_000;
    expect([1, 2, 3, 4].map(() => limiter.tryTake('a'))).toEqual([true, true, true, false]); // capped at burst
  });

  it('keeps keys independent', () => {
    const limiter = new TokenBucketLimiter({ ratePerSecond: 1, burst: 1 }, () => 0);
    expect(limiter.tryTake('a')).toBe(true);
    expect(limiter.tryTake('a')).toBe(false);
    expect(limiter.tryTake('b')).toBe(true);
  });

  it('charges a batch by its event count, and never refuses a batch bigger than the burst forever', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ ratePerSecond: 10, burst: 5 }, () => now);
    expect(limiter.tryTake('s', 3)).toBe(true);
    expect(limiter.tryTake('s', 3)).toBe(false); // only 2 left
    now += 10_000;
    expect(limiter.tryTake('s', 25)).toBe(true); // capped at the burst
    expect(limiter.tryTake('s', 1)).toBe(false);
  });

  it('a refused take costs nothing', () => {
    const limiter = new TokenBucketLimiter({ ratePerSecond: 0.0001, burst: 4 }, () => 0);
    expect(limiter.tryTake('a', 5)).toBe(true); // capped to 4
    expect(limiter.tryTake('a', 1)).toBe(false);
  });

  it('fails closed under a flood of distinct keys, and sweeps refilled buckets', () => {
    let now = 0;
    const limiter = new TokenBucketLimiter({ ratePerSecond: 1, burst: 1 }, () => now, 3);
    expect(['a', 'b', 'c', 'd'].map((k) => limiter.tryTake(k))).toEqual([true, true, true, false]);
    expect(limiter.size).toBe(3);
    now += 120_000; // everything has refilled; the next call sweeps
    expect(limiter.tryTake('d')).toBe(true);
    expect(limiter.size).toBe(1);
  });
});

describe('parseUserAgent (collector.md §4 step 9)', () => {
  const cases: Array<[string, string, Partial<ReturnType<typeof parseUserAgent>>]> = [
    [
      'Chrome on Android',
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      { device_type: 'mobile', os: 'Android', browser: 'Chrome', is_in_app_browser: 0 },
    ],
    [
      'Safari on iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      { device_type: 'mobile', os: 'iOS', is_in_app_browser: 0 },
    ],
    [
      'Chrome on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      { device_type: 'desktop', os: 'Windows', browser: 'Chrome', is_in_app_browser: 0 },
    ],
    [
      'Instagram in-app on iPhone',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Instagram 300.0.0.0',
      { device_type: 'mobile', is_in_app_browser: 1 },
    ],
    [
      'Facebook in-app',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/440.0]',
      { is_in_app_browser: 1 },
    ],
    [
      'Android WebView',
      'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36',
      { device_type: 'mobile', is_in_app_browser: 1 },
    ],
  ];
  it.each(cases)('%s', (_name, ua, expected) => {
    expect(parseUserAgent(ua)).toMatchObject(expected);
  });

  it('is `unknown` and empty for a missing or unparseable agent, and never returns the raw string', () => {
    for (const ua of [undefined, '', '???']) {
      expect(parseUserAgent(ua)).toMatchObject({
        device_type: 'unknown',
        os: '',
        browser: '',
        is_in_app_browser: 0,
      });
    }
    expect(JSON.stringify(parseUserAgent('Mozilla/5.0 SecretTag/1'))).not.toContain('SecretTag');
  });
});

describe('minimise helpers', () => {
  it('applyClockRules: stale, fresh, and future-clamped', () => {
    expect(applyClockRules('2026-09-27T09:59:59.000Z', NOW)).toEqual({ kind: 'stale' });
    expect(applyClockRules('2026-09-27T10:00:01.000Z', NOW)).toMatchObject({ kind: 'ok' });
    expect(applyClockRules('2026-09-28T10:04:59.000Z', NOW)).toEqual({
      kind: 'ok',
      occurredAt: '2026-09-28T10:04:59.000Z',
    });
    expect(applyClockRules('2026-09-28T10:05:01.000Z', NOW)).toEqual({
      kind: 'ok',
      occurredAt: '2026-09-28T10:00:00.000Z',
    });
    expect(applyClockRules('2026-09-28T15:30:00.000+05:30', NOW)).toEqual({
      kind: 'ok',
      occurredAt: '2026-09-28T10:00:00.000Z',
    });
    expect(applyClockRules('garbage', NOW)).toEqual({ kind: 'stale' });
  });

  it('istDay buckets by the Indian day, not UTC', () => {
    expect(istDay(Date.parse('2026-09-28T18:29:59Z'))).toBe('20260928');
    expect(istDay(Date.parse('2026-09-28T18:30:00Z'))).toBe('20260929'); // 00:00 IST
    expect(istDay(Date.parse('2026-12-31T20:00:00Z'))).toBe('20270101');
  });

  it('pageHostAllowed compares hosts exactly (no suffix or userinfo tricks)', () => {
    const allowed = ['https://shop.example.com'];
    expect(pageHostAllowed('https://shop.example.com/a?b=1', allowed)).toBe(true);
    expect(pageHostAllowed('https://SHOP.example.com/', allowed)).toBe(true);
    expect(pageHostAllowed('https://shop.example.com.evil.com/', allowed)).toBe(false);
    expect(pageHostAllowed('https://evil.com/shop.example.com', allowed)).toBe(false);
    expect(pageHostAllowed('https://shop.example.com@evil.com/', allowed)).toBe(false);
    expect(pageHostAllowed('not a url', allowed)).toBe(false);
  });

  it('flattenProperties gives paise + currency, and nothing for events without properties', () => {
    const base = { event_id: 'e', occurred_at: 'x', page_url: 'https://a.b/', referrer: '' };
    expect(
      flattenProperties({
        ...base,
        event_name: 'product_added_to_cart',
        properties: {
          product_id: 'p',
          variant_id: 'v',
          quantity: 2,
          line_total: { amount_paise: 5000, currency: 'INR' },
        },
      }),
    ).toEqual({
      product_id: 'p',
      variant_id: 'v',
      quantity: 2,
      line_total_paise: 5000,
      currency: 'INR',
    });
    expect(flattenProperties({ ...base, event_name: 'page_viewed' })).toEqual({});
    expect(flattenProperties({ ...base, event_name: 'consent_withdrawn' })).toEqual({});
  });
});

describe('StoreConfigCache (collector.md §2.5)', () => {
  const key = 'pk_' + 'a'.repeat(24);
  const config = {
    storeId: '2b3fd8c6-2f6c-4b3a-9f0f-0e1a1f1d9c11',
    status: 'active',
    inactiveReason: null,
    allowedOrigins: ['https://shop.example.com'],
    signingKeys: [{ kid: 's1', secret: SECRET }],
    childDirected: false,
    noticeVersion: 'v1',
  };

  it('caches hits for 30 s, then re-reads', async () => {
    let now = 0;
    const get = vi.fn().mockResolvedValue(JSON.stringify(config));
    const cache = new StoreConfigCache({ get }, () => now);
    expect((await cache.get(key))?.storeId).toBe(config.storeId);
    await cache.get(key);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(collectorStoreKey(key));
    now += 30_001;
    await cache.get(key);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('caches misses too, so a flood of unknown keys does not reach Redis', async () => {
    const get = vi.fn().mockResolvedValue(null);
    const cache = new StoreConfigCache({ get }, () => 0);
    for (let i = 0; i < 5; i += 1) expect(await cache.get(key)).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('never looks up a key that cannot be one of ours', async () => {
    const get = vi.fn();
    const cache = new StoreConfigCache({ get }, () => 0);
    for (const bad of ['', 'pk_short', 'sk_' + 'a'.repeat(24), 'pk_' + 'a'.repeat(23) + '-', '*']) {
      expect(await cache.get(bad)).toBeNull();
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('treats a corrupt or schema-invalid value as no config, and a Redis failure as an error (not cached)', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce('{not json')
      .mockResolvedValueOnce(JSON.stringify({ ...config, extra: 1 }));
    const cache = new StoreConfigCache({ get }, () => 0, 0);
    expect(await cache.get(key)).toBeNull();
    expect(await cache.get(key)).toBeNull();

    const failing = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(JSON.stringify(config));
    const cache2 = new StoreConfigCache({ get: failing }, () => 0);
    await expect(cache2.get(key)).rejects.toThrow('down');
    expect((await cache2.get(key))?.status).toBe('active'); // the failure wasn't remembered
  });
});

describe('runIngest (the script loader)', () => {
  const keys: IngestKeys = {
    ready: 'r',
    stream: 's',
    erasedVisitor: 'ev',
    withdrawnVisitor: 'wv',
    erasedIdentity: 'ei',
    stats: 'st',
  };
  const args: IngestArgs = {
    nowSeconds: 1,
    maxlen: 10,
    statsTtl: 10,
    suppressTtl: 10,
    storeId: 'x',
    visitorId: 'v',
    receivedAt: 'now',
    visitorHmacs: [],
    visitorHmacWrite: 'w',
    preDrops: {},
    events: [],
  };

  it('uses EVALSHA, and on NOSCRIPT loads the script with EVAL and continues', async () => {
    const evalsha = vi.fn().mockRejectedValue(new Error('NOSCRIPT No matching script'));
    const evalFn = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ status: 'ok', accepted: 2, drops: {} }));
    const result = await runIngest({ evalsha, eval: evalFn } as never, keys, args);
    expect(result).toEqual({ status: 'ok', accepted: 2, drops: {} });
    expect(evalsha.mock.calls[0]?.[0]).toBe(INGEST_SCRIPT_SHA);
    expect(evalFn.mock.calls[0]?.[0]).toBe(INGEST_SCRIPT);
  });

  it('rethrows any other Redis error, and understands not_ready and an array-shaped empty drops', async () => {
    await expect(
      runIngest(
        { evalsha: vi.fn().mockRejectedValue(new Error('READONLY')), eval: vi.fn() } as never,
        keys,
        args,
      ),
    ).rejects.toThrow('READONLY');
    const notReady = vi.fn().mockResolvedValue(JSON.stringify({ status: 'not_ready' }));
    expect(await runIngest({ evalsha: notReady, eval: vi.fn() } as never, keys, args)).toEqual({
      status: 'not_ready',
    });
    const arrayDrops = vi.fn().mockResolvedValue('{"status":"ok","accepted":0,"drops":[]}');
    expect(await runIngest({ evalsha: arrayDrops, eval: vi.fn() } as never, keys, args)).toEqual({
      status: 'ok',
      accepted: 0,
      drops: {},
    });
  });

  it('passes the six keys, in order, and the arguments as one JSON string', async () => {
    const evalsha = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ status: 'ok', accepted: 0, drops: {} }));
    await runIngest({ evalsha, eval: vi.fn() } as never, keys, args);
    expect(evalsha.mock.calls[0]?.slice(1)).toEqual([
      6,
      'r',
      's',
      'ev',
      'wv',
      'ei',
      'st',
      JSON.stringify(args),
    ]);
  });
});
