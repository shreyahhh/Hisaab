import { createHmac, randomInt, randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { Redis } from 'ioredis';
import {
  shopifyCustomerPrivacyProvider,
  storeContext,
  type IdentityHasher,
} from '@truepath/privacy';
import { createTestIdentityHasher } from '@truepath/privacy/testing';
import {
  collectSigningInput,
  collectorStoreKey,
  type CollectorStoreConfig,
} from '@truepath/shared';
import { buildCollectorApp, type CollectorAppDeps } from './app.js';
import { nullGeo, type GeoLookup } from './geo.js';
import { TokenBucketLimiter, type BucketConfig } from './rateLimit.js';
import { StoreConfigCache } from './storeConfig.js';

// Integration harness for the Collector: real Redis (the local durable instance, like every other
// integration test in this repo), but the two GLOBAL names — the readiness marker and the raw event
// stream — are isolated per test run, so a test can never write to, or delete the marker of, a
// developer's real local pipeline. Per-store keys are namespaced by a random store id and cleaned up.

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const REDIS_URL = 'redis://localhost:6379';

export const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1000 });

export interface Fixture {
  readonly storeId: string;
  readonly storeKey: string;
  readonly kid: string;
  readonly secret: string;
  readonly shopHost: string;
  readonly config: CollectorStoreConfig;
}

export function newStoreKey(): string {
  let key = 'pk_';
  for (let i = 0; i < 24; i += 1) key += BASE62[randomInt(BASE62.length)];
  return key;
}

export interface Harness {
  readonly app: ReturnType<typeof buildCollectorApp>;
  readonly hasher: IdentityHasher;
  readonly keys: { ready: string; stream: string };
  readonly logs: Array<Record<string, unknown>>;
  readonly clock: { now: number };
  readonly storeConfigs: StoreConfigCache;
  /** Registers a store (writes its config to Redis) and returns what a pixel would hold. */
  addStore(overrides?: Partial<CollectorStoreConfig>): Promise<Fixture>;
  markReady(): Promise<void>;
  markNotReady(): Promise<void>;
  /** Signs and injects a `POST /v1/collect`. */
  post(
    fixture: Fixture,
    body: unknown | string,
    options?: PostOptions,
  ): Promise<LightMyRequestResponse>;
  stream(): Promise<Array<Record<string, unknown>>>;
  stats(fixture: Fixture): Promise<Record<string, string>>;
  suppress(
    fixture: Fixture,
    kind: 'erased:visitor' | 'erased:identity' | 'withdrawn:visitor',
    member: string,
    expiresAtSeconds?: number,
  ): Promise<void>;
  visitorHmac(fixture: Fixture, visitorId: string): string;
  close(): Promise<void>;
}

export interface PostOptions {
  readonly ts?: number;
  readonly kid?: string;
  readonly secret?: string;
  readonly sig?: string;
  readonly k?: string;
  readonly origin?: string;
  readonly ip?: string;
  readonly userAgent?: string;
  readonly contentType?: string;
  /** The X-Forwarded-For header, as the ALB would have set it. */
  readonly forwardedFor?: string;
}

export const UA_ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

export interface HarnessOptions {
  readonly ipLimit?: BucketConfig;
  readonly storeLimit?: BucketConfig;
  readonly geo?: GeoLookup;
  readonly hasher?: IdentityHasher;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const runId = randomUUID();
  const keys = { ready: `test:${runId}:suppress:ready`, stream: `test:${runId}:stream` };
  const clock = { now: Date.parse('2026-09-28T10:00:00.000Z') };
  const hasher = options.hasher ?? createTestIdentityHasher();
  const logs: Array<Record<string, unknown>> = [];
  const created: Fixture[] = [];
  const storeConfigs = new StoreConfigCache(redis, () => clock.now, 30_000);

  const deps: CollectorAppDeps = {
    redis,
    storeConfigs,
    hasher,
    consent: shopifyCustomerPrivacyProvider,
    geo: options.geo ?? nullGeo,
    ipLimiter: new TokenBucketLimiter(
      options.ipLimit ?? { ratePerSecond: 1000, burst: 100_000 },
      () => clock.now,
    ),
    storeLimiter: new TokenBucketLimiter(
      options.storeLimit ?? { ratePerSecond: 1000, burst: 100_000 },
      () => clock.now,
    ),
    now: () => clock.now,
    redisKeys: keys,
    log: (line) => logs.push(line),
  };
  const app = buildCollectorApp(deps);
  await app.ready();

  const harness: Harness = {
    app,
    hasher,
    keys,
    logs,
    clock,
    storeConfigs,

    async addStore(overrides = {}) {
      const storeId = randomUUID();
      const storeKey = newStoreKey();
      const kid = 's1';
      const secret = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
      const shopHost = `shop-${storeId.slice(0, 8)}.myshopify.com`;
      const config: CollectorStoreConfig = {
        storeId,
        status: 'active',
        inactiveReason: null,
        allowedOrigins: [`https://${shopHost}`],
        signingKeys: [{ kid, secret }],
        childDirected: false,
        noticeVersion: 'v1',
        ...overrides,
      };
      await redis.set(collectorStoreKey(storeKey), JSON.stringify(config));
      const fixture: Fixture = { storeId, storeKey, kid, secret, shopHost, config };
      created.push(fixture);
      return fixture;
    },

    markReady: async () => void (await redis.set(keys.ready, String(clock.now))),
    markNotReady: async () => void (await redis.del(keys.ready)),

    post(fixture, body, opts = {}) {
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      const ts = opts.ts ?? Math.floor(clock.now / 1000);
      const secret = opts.secret ?? fixture.secret;
      const sig =
        opts.sig ?? createHmac('sha256', secret).update(collectSigningInput(ts, raw)).digest('hex');
      const query = new URLSearchParams({
        k: opts.k ?? fixture.storeKey,
        ts: String(ts),
        kid: opts.kid ?? fixture.kid,
        sig,
      });
      return app.inject({
        method: 'POST',
        url: `/v1/collect?${query.toString()}`,
        payload: raw,
        remoteAddress: opts.ip ?? '203.0.113.7',
        headers: {
          'content-type': opts.contentType ?? 'text/plain;charset=UTF-8',
          'user-agent': opts.userAgent ?? UA_ANDROID_CHROME,
          ...(opts.origin ? { origin: opts.origin } : {}),
          ...(opts.forwardedFor ? { 'x-forwarded-for': opts.forwardedFor } : {}),
        },
      });
    },

    async stream() {
      const entries = await redis.xrange(keys.stream, '-', '+');
      return entries.map(([, fields]) => {
        const map: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) map[fields[i]!] = fields[i + 1]!;
        return {
          store_id: map.store_id,
          ...(JSON.parse(map.payload ?? '{}') as Record<string, unknown>),
        };
      });
    },

    async stats(fixture) {
      const day = new Date(clock.now + 5.5 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
      return redis.hgetall(`stats:collector:${fixture.storeId}:${day}`);
    },

    async suppress(fixture, kind, member, expiresAtSeconds) {
      await redis.zadd(
        `suppress:${fixture.storeId}:${kind}`,
        expiresAtSeconds ?? Math.floor(clock.now / 1000) + 10_000,
        member,
      );
    },

    visitorHmac: (fixture, visitorId) => hasher.hmac(storeContext(fixture.storeId), visitorId),

    async close() {
      await app.close();
      const pipeline = redis.pipeline();
      pipeline.del(keys.ready, keys.stream);
      for (const f of created) {
        pipeline.del(collectorStoreKey(f.storeKey));
        for (const kind of ['erased:visitor', 'erased:identity', 'withdrawn:visitor']) {
          pipeline.del(`suppress:${f.storeId}:${kind}`);
        }
        for (const offset of [-1, 0, 1]) {
          const day = new Date(clock.now + offset * 86_400_000 + 5.5 * 3600_000)
            .toISOString()
            .slice(0, 10)
            .replace(/-/g, '');
          pipeline.del(`stats:collector:${f.storeId}:${day}`);
        }
      }
      await pipeline.exec();
    },
  };
  return harness;
}

// --- batch builders --------------------------------------------------------------------------------

export const VISITOR = '0192f3a4-7b1c-7c2d-8e3f-4a5b6c7d8e9f';
let eventCounter = 0;
export function eventId(): string {
  eventCounter += 1;
  return `0192f3a4-7b1c-7c2d-8e3f-${String(eventCounter).padStart(12, '0')}`;
}

export function pageViewed(fixture: Fixture, overrides: Record<string, unknown> = {}, at?: string) {
  return {
    event_name: 'page_viewed',
    event_id: eventId(),
    occurred_at: at ?? '2026-09-28T09:59:58.000Z',
    page_url: `https://${fixture.shopHost}/products/tee?utm_source=facebook&utm_medium=paid_social&color=red&email=a@example.com`,
    referrer: 'https://l.instagram.com/some/path?token=secret',
    ...overrides,
  };
}

export function checkoutCompleted(
  fixture: Fixture,
  contact: Record<string, string> = { phone: '+918123456709', email: 'shopper@example.com' },
) {
  return {
    event_name: 'checkout_completed',
    event_id: eventId(),
    occurred_at: '2026-09-28T09:59:59.000Z',
    page_url: `https://${fixture.shopHost}/checkouts/cn/abc123/thank-you`,
    referrer: '',
    properties: {
      checkout_token: 'abc123',
      order_id: '5001',
      total: { amount_paise: 129900, currency: 'INR' },
    },
    contact,
  };
}

export function consentGranted(fixture: Fixture, trigger = 'interaction') {
  return {
    event_name: 'consent_granted',
    event_id: eventId(),
    occurred_at: '2026-09-28T09:59:57.000Z',
    page_url: `https://${fixture.shopHost}/`,
    referrer: '',
    trigger,
  };
}

export function consentWithdrawn(fixture: Fixture) {
  return {
    event_name: 'consent_withdrawn',
    event_id: eventId(),
    occurred_at: '2026-09-28T09:59:59.500Z',
    page_url: `https://${fixture.shopHost}/`,
    referrer: '',
  };
}

export function batch(events: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    visitor_id: VISITOR,
    visitor_new: false,
    sent_at: '2026-09-28T10:00:00.000Z',
    consent: { analytics: true, marketing: false, notice_version: 'v1' },
    events,
    ...overrides,
  };
}
