import { createHmac } from 'node:crypto';
import type { PixelApi, PixelDeps, PixelSettings } from './types.js';

// A fake Web Pixel sandbox for tests: in-memory storage and cookies, a controllable clock and timer
// queue, a recording network, and Shopify-shaped event fixtures. Real HMAC (Node's) so a test can
// verify a signature independently of the code that produced it.

export const SECRET = 's'.repeat(43);

export const GOOD_SETTINGS: PixelSettings = {
  storeKey: 'pk_abcdefghijklmnopqrstuvwx',
  collectorUrl: 'https://collect.truepath.example',
  signingKid: 's1',
  signingSecret: SECRET,
  noticeVersion: 'v1',
};

export interface HarnessOptions {
  readonly analytics?: boolean;
  readonly marketing?: boolean;
  readonly settings?: PixelSettings;
  readonly storage?: Record<string, string>;
  readonly cookies?: Record<string, string>;
  readonly startMs?: number;
  readonly failStorage?: boolean;
  readonly failPost?: boolean;
  readonly failHmac?: boolean;
}

export interface SentRequest {
  readonly url: string;
  readonly body: string;
  readonly parsed: {
    v: number;
    visitor_id: string;
    visitor_new: boolean;
    sent_at: string;
    consent: { analytics: boolean; marketing: boolean; notice_version: string };
    click?: { fbp?: string; fbc?: string };
    events: Array<Record<string, unknown> & { event_name: string }>;
  };
  readonly query: URLSearchParams;
}

export function harness(options: HarnessOptions = {}) {
  const storage = new Map(Object.entries(options.storage ?? {}));
  const cookies = new Map(Object.entries(options.cookies ?? {}));
  let nowMs = options.startMs ?? Date.parse('2026-09-28T10:00:00.000Z');
  let randomCounter = 0;
  const sent: SentRequest[] = [];
  const timers: Array<{ callback: () => void; at: number; cancelled: boolean }> = [];
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  const state = { analytics: options.analytics ?? true, marketing: options.marketing ?? false };

  const api: PixelApi = {
    analytics: {
      subscribe: (name, handler) => {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    },
    browser: {
      cookie: { get: async (name) => cookies.get(name) },
      localStorage: {
        getItem: async (key) => {
          if (options.failStorage) throw new Error('storage unavailable');
          return storage.get(key) ?? null;
        },
        setItem: async (key, value) => {
          if (options.failStorage) throw new Error('storage unavailable');
          storage.set(key, value);
        },
      },
    },
    init: {
      customerPrivacy: {
        analyticsProcessingAllowed: state.analytics,
        marketingAllowed: state.marketing,
      },
      context: {
        document: {
          location: { href: 'https://shop.example.com/?utm_source=facebook' },
          referrer: '',
        },
      },
    },
    settings: options.settings ?? GOOD_SETTINGS,
  };

  const deps: PixelDeps = {
    now: () => nowMs,
    randomBytes: () => {
      randomCounter += 1;
      const bytes = new Uint8Array(16);
      for (let i = 0; i < 16; i += 1) bytes[i] = (randomCounter * 31 + i * 7) & 0xff;
      return bytes;
    },
    hmacSha256Hex: async (secret, message) => {
      if (options.failHmac) throw new Error('crypto unavailable');
      return createHmac('sha256', secret).update(message).digest('hex');
    },
    post: async (url, body) => {
      if (options.failPost) throw new Error('network down');
      const query = new URL(url).searchParams;
      sent.push({ url, body, parsed: JSON.parse(body) as SentRequest['parsed'], query });
    },
    schedule: (callback, delayMs) => {
      const timer = { callback, at: nowMs + delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    byteLength: (text) => Buffer.byteLength(text, 'utf8'),
  };

  /** Deliver a Shopify event to whoever subscribed to `name`. */
  function emit(name: string, event: unknown): void {
    for (const handler of handlers.get(name) ?? []) handler(event);
  }

  /** Advance the clock, firing timers that come due. */
  async function advance(ms: number): Promise<void> {
    nowMs += ms;
    for (const timer of timers) {
      if (!timer.cancelled && timer.at <= nowMs) {
        timer.cancelled = true;
        timer.callback();
      }
    }
    await settle();
  }

  /** Let pending microtasks (async handlers, chained flushes) finish. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }

  return {
    api,
    deps,
    sent,
    storage,
    cookies,
    handlers,
    emit,
    advance,
    settle,
    setNow: (ms: number) => {
      nowMs = ms;
    },
    pendingTimers: () => timers.filter((t) => !t.cancelled).length,
  };
}

// --- Shopify-shaped events -------------------------------------------------------------------------

let eventCounter = 0;
export function shopifyEvent(data: unknown = {}, overrides: Record<string, unknown> = {}) {
  eventCounter += 1;
  return {
    id: `0192f3a4-7b1c-7c2d-8e3f-${String(eventCounter).padStart(12, '0')}`,
    timestamp: '2026-09-28T09:59:58.000Z',
    context: {
      document: {
        location: { href: 'https://shop.example.com/products/tee?utm_source=facebook&fbclid=abc' },
        referrer: 'https://l.instagram.com/',
      },
    },
    data,
    ...overrides,
  };
}

export const money = (amount: number | string, currencyCode = 'INR') => ({ amount, currencyCode });

export const productViewed = () =>
  shopifyEvent({
    productVariant: { id: '4401', price: money(1299), product: { id: '901' } },
  });

export const addedToCart = () =>
  shopifyEvent({
    cartLine: {
      quantity: 2,
      cost: { totalAmount: money(2598.5) },
      merchandise: { id: '4401', product: { id: '901' } },
    },
  });

export const checkoutCompleted = (extra: Record<string, unknown> = {}) =>
  shopifyEvent({
    checkout: {
      token: 'co_123',
      totalPrice: money(1299),
      email: 'shopper@example.com',
      phone: null,
      shippingAddress: { phone: '+918123456709' },
      order: { id: '5001' },
      ...extra,
    },
  });
