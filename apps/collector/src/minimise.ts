import UAParser from 'ua-parser-js';
import type { PixelEvent } from '@truepath/shared';

// Data minimisation for one event (collector.md §4 step 9, SPEC §5.4): what is kept from the user
// agent, how properties are flattened to the allowlisted stream shape, the clock rules and the IST
// day used for drop counters. Pure functions: no I/O, no shopper identifier is ever returned that the
// caller didn't pass in.

export type DeviceType = 'mobile' | 'tablet' | 'desktop' | 'unknown';

export interface ParsedUserAgent {
  readonly device_type: DeviceType;
  readonly os: string;
  readonly browser: string;
  readonly is_in_app_browser: 0 | 1;
}

// collector.md §4 step 9. `wv)` is the Android WebView marker; `Line/` includes the trailing slash so
// it doesn't match ordinary words.
const IN_APP_MARKERS = ['FBAN', 'FBAV', 'Instagram', 'Line/', 'Snapchat', 'wv)'] as const;

/**
 * Parses a user agent into the four fields we keep. The raw string is not returned and must not be
 * stored or logged by the caller (SPEC v0.5). Unparseable or missing → `unknown` with empty names.
 */
export function parseUserAgent(userAgent: string | undefined): ParsedUserAgent {
  if (!userAgent) return { device_type: 'unknown', os: '', browser: '', is_in_app_browser: 0 };
  let result;
  try {
    result = new UAParser(userAgent).getResult();
  } catch {
    return { device_type: 'unknown', os: '', browser: '', is_in_app_browser: 0 };
  }
  const os = (result.os.name ?? '').slice(0, 64);
  const browser = (result.browser.name ?? '').slice(0, 64);
  const type = result.device.type;
  let device_type: DeviceType;
  if (type === 'mobile' || type === 'tablet') device_type = type;
  else if (type !== undefined)
    device_type = 'unknown'; // smarttv, console, wearable, embedded
  else if (browser !== '' || os !== '') device_type = 'desktop';
  else device_type = 'unknown';
  return {
    device_type,
    os,
    browser,
    is_in_app_browser: IN_APP_MARKERS.some((marker) => userAgent.includes(marker)) ? 1 : 0,
  };
}

/**
 * The event's allowlisted properties as a flat record of strings and integers: money becomes
 * `<name>_paise` + `currency` (collector.md §2.4). The schemas are `.strict()`, so nothing outside the
 * known shape can reach here; this only flattens it.
 */
export function flattenProperties(event: PixelEvent): Record<string, string | number> {
  switch (event.event_name) {
    case 'product_viewed':
      return {
        product_id: event.properties.product_id,
        variant_id: event.properties.variant_id,
        price_paise: event.properties.price.amount_paise,
        currency: event.properties.price.currency,
      };
    case 'product_added_to_cart':
      return {
        product_id: event.properties.product_id,
        variant_id: event.properties.variant_id,
        quantity: event.properties.quantity,
        line_total_paise: event.properties.line_total.amount_paise,
        currency: event.properties.line_total.currency,
      };
    case 'checkout_started':
      return {
        checkout_token: event.properties.checkout_token,
        total_paise: event.properties.total.amount_paise,
        currency: event.properties.total.currency,
      };
    case 'checkout_contact_info_submitted':
      return { checkout_token: event.properties.checkout_token };
    case 'checkout_completed':
      return {
        checkout_token: event.properties.checkout_token,
        order_id: event.properties.order_id,
        total_paise: event.properties.total.amount_paise,
        currency: event.properties.total.currency,
      };
    case 'page_viewed':
    case 'consent_granted':
    case 'consent_withdrawn':
      return {};
  }
}

const STALE_EVENT_MS = 24 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export type ClockDecision =
  { readonly kind: 'ok'; readonly occurredAt: string } | { readonly kind: 'stale' };

/**
 * collector.md §4 step 9: an event older than 24 h is dropped (`stale_event`); one more than 5 min in
 * the future is clamped to the receive time (a wrong device clock must not place an event in the
 * future). Returns the timestamp to store, normalised to UTC ISO with milliseconds.
 */
export function applyClockRules(occurredAtIso: string, receivedAtMs: number): ClockDecision {
  const occurred = Date.parse(occurredAtIso);
  if (Number.isNaN(occurred) || occurred < receivedAtMs - STALE_EVENT_MS) return { kind: 'stale' };
  const clamped = occurred > receivedAtMs + FUTURE_TOLERANCE_MS ? receivedAtMs : occurred;
  return { kind: 'ok', occurredAt: new Date(clamped).toISOString() };
}

/** `yyyymmdd` of an instant in IST — the day drop counters and the default-on signal are bucketed by (HLD §8). */
export function istDay(nowMs: number): string {
  const ist = new Date(nowMs + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** Whether a page URL's host is one of the store's own hosts (collector.md §4 step 4). */
export function pageHostAllowed(pageUrl: string, allowedOrigins: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(pageUrl).host.toLowerCase();
  } catch {
    return false;
  }
  return allowedOrigins.some((origin) => {
    try {
      return new URL(origin).host.toLowerCase() === host;
    } catch {
      return false;
    }
  });
}
