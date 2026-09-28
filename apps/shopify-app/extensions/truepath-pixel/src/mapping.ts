import type { PixelEvent } from '@truepath/shared';

// Shopify standard event → our wire event (collector.md §2.2 "Pixel-side rules"). Pure functions of
// one event object. They never throw: anything missing, mistyped or out of bounds returns `null`, so
// one odd event can never break the page's other tracking (and a value that would fail the
// Collector's strict schema is dropped here rather than sending a batch that is rejected whole).
//
// Type-only import above: nothing from `@truepath/shared` ends up in the browser bundle.

export type MappedEvent = PixelEvent;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_URL = 2048;
const MAX_ID = 64;
const MAX_PAISE = 10_000_000_000;

type Bag = Record<string, unknown>;

function isBag(value: unknown): value is Bag {
  return typeof value === 'object' && value !== null;
}

/** `dig(event, 'data', 'checkout', 'token')` — undefined when any step is missing. */
function dig(root: unknown, ...path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isBag(current)) return undefined;
    current = current[key];
  }
  return current;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** An identifier the Collector accepts (≤ 64 chars); anything longer is not ours to truncate. */
function asId(value: unknown): string | undefined {
  const text = asString(value);
  return text !== undefined && text.length <= MAX_ID ? text : undefined;
}

/** MoneyV2 `{amount, currencyCode}` → integer paise (`Math.round(amount * 100)`). */
export function toMoney(value: unknown): { amount_paise: number; currency: string } | undefined {
  const amount = dig(value, 'amount');
  const currency = dig(value, 'currencyCode');
  const numeric = typeof amount === 'string' ? Number(amount) : amount;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric < 0) return undefined;
  if (typeof currency !== 'string' || currency.length !== 3) return undefined;
  const paise = Math.round(numeric * 100);
  return paise <= MAX_PAISE ? { amount_paise: paise, currency } : undefined;
}

/**
 * Keeps a URL within the wire limit. Over-long URLs lose their query string first (the part most
 * likely to be long, and only a handful of params survive server-side sanitising anyway), then are
 * dropped entirely rather than sent as an invalid URL.
 */
function clampUrl(url: string): string | undefined {
  if (url.length <= MAX_URL) return url;
  const bare = url.split('#')[0]?.split('?')[0] ?? '';
  return bare.length <= MAX_URL ? bare : undefined;
}

function isoTimestamp(raw: unknown, fallbackMs: number): string {
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    // Must be an offset-bearing ISO string, which Date.toISOString always is.
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return new Date(raw).toISOString();
  return new Date(fallbackMs).toISOString();
}

interface Common {
  readonly event_id: string;
  readonly occurred_at: string;
  readonly page_url: string;
  readonly referrer: string;
}

/** Fields every event carries. `null` when the page URL is unusable — without it the event is useless. */
function common(event: unknown, nowMs: number, newEventId: () => string): Common | null {
  const href = asString(dig(event, 'context', 'document', 'location', 'href'));
  const pageUrl = href === undefined ? undefined : clampUrl(href);
  if (pageUrl === undefined) return null;
  const referrer = asString(dig(event, 'context', 'document', 'referrer'));
  const id = asString(dig(event, 'id'));
  return {
    // Reuse Shopify's own event id when it is a UUID: a replayed event then keeps one id end to end,
    // which is exactly what downstream de-duplication (ADR-0017) keys on.
    event_id: id !== undefined && UUID.test(id) ? id.toLowerCase() : newEventId(),
    occurred_at: isoTimestamp(dig(event, 'timestamp'), nowMs),
    page_url: pageUrl,
    referrer: referrer === undefined ? '' : (clampUrl(referrer) ?? ''),
  };
}

function contactFrom(checkout: unknown): { email?: string; phone?: string } {
  const email = asString(dig(checkout, 'email'));
  // COD checkouts collect the shipping phone (collector.md §2.2): checkout.phone ?? shippingAddress.phone.
  const phone =
    asString(dig(checkout, 'phone')) ?? asString(dig(checkout, 'shippingAddress', 'phone'));
  return {
    ...(email !== undefined && email.length <= 254 ? { email } : {}),
    ...(phone !== undefined && phone.length <= 32 ? { phone } : {}),
  };
}

export const STANDARD_EVENT_NAMES = [
  'page_viewed',
  'product_viewed',
  'product_added_to_cart',
  'checkout_started',
  'checkout_contact_info_submitted',
  'checkout_completed',
] as const;
export type StandardEventName = (typeof STANDARD_EVENT_NAMES)[number];

export function mapStandardEvent(
  name: StandardEventName,
  event: unknown,
  nowMs: number,
  newEventId: () => string,
): MappedEvent | null {
  const base = common(event, nowMs, newEventId);
  if (base === null) return null;

  switch (name) {
    case 'page_viewed':
      return { event_name: 'page_viewed', ...base };

    case 'product_viewed': {
      const variant = dig(event, 'data', 'productVariant');
      const variantId = asId(dig(variant, 'id'));
      const productId = asId(dig(variant, 'product', 'id'));
      const price = toMoney(dig(variant, 'price'));
      if (!variantId || !productId || !price) return null;
      return {
        event_name: 'product_viewed',
        ...base,
        properties: { product_id: productId, variant_id: variantId, price },
      };
    }

    case 'product_added_to_cart': {
      const line = dig(event, 'data', 'cartLine');
      const variantId = asId(dig(line, 'merchandise', 'id'));
      const productId = asId(dig(line, 'merchandise', 'product', 'id'));
      const quantity = dig(line, 'quantity');
      const lineTotal = toMoney(dig(line, 'cost', 'totalAmount'));
      if (!variantId || !productId || !lineTotal) return null;
      if (
        typeof quantity !== 'number' ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 999
      ) {
        return null;
      }
      return {
        event_name: 'product_added_to_cart',
        ...base,
        properties: {
          product_id: productId,
          variant_id: variantId,
          quantity,
          line_total: lineTotal,
        },
      };
    }

    case 'checkout_started': {
      const checkout = dig(event, 'data', 'checkout');
      const token = asId(dig(checkout, 'token'));
      const total = toMoney(dig(checkout, 'totalPrice'));
      if (!token || !total) return null;
      return {
        event_name: 'checkout_started',
        ...base,
        properties: { checkout_token: token, total },
      };
    }

    case 'checkout_contact_info_submitted': {
      const checkout = dig(event, 'data', 'checkout');
      const token = asId(dig(checkout, 'token'));
      const contact = contactFrom(checkout);
      // Nothing to link without a phone or email (typically Level 2 protected data not yet approved).
      if (!token || (contact.email === undefined && contact.phone === undefined)) return null;
      return {
        event_name: 'checkout_contact_info_submitted',
        ...base,
        properties: { checkout_token: token },
        contact,
      };
    }

    case 'checkout_completed': {
      const checkout = dig(event, 'data', 'checkout');
      const token = asId(dig(checkout, 'token'));
      const orderId = asId(dig(checkout, 'order', 'id'));
      const total = toMoney(dig(checkout, 'totalPrice'));
      // An order id is what links this visit to the order (identity-stitching.md rule 2); the
      // Collector normalises a `gid://` form (open question 4), so it is passed through as given.
      if (!token || !orderId || !total) return null;
      return {
        event_name: 'checkout_completed',
        ...base,
        properties: { checkout_token: token, order_id: orderId, total },
        contact: contactFrom(checkout),
      };
    }
  }
}

/** Consent events carry no payload beyond the common fields (and `trigger` for a grant). */
export function consentEvent(
  kind: 'consent_withdrawn',
  page: { url: string; referrer: string },
  nowMs: number,
  newEventId: () => string,
): MappedEvent | null;
export function consentEvent(
  kind: 'consent_granted',
  page: { url: string; referrer: string },
  nowMs: number,
  newEventId: () => string,
  trigger: 'interaction' | 'initial_state' | 'refresh',
): MappedEvent | null;
export function consentEvent(
  kind: 'consent_granted' | 'consent_withdrawn',
  page: { url: string; referrer: string },
  nowMs: number,
  newEventId: () => string,
  trigger?: 'interaction' | 'initial_state' | 'refresh',
): MappedEvent | null {
  // No usable URL (neither the event nor init.context supplied one): an empty page_url would fail the
  // strict schema and get the whole batch rejected, so the consent event is skipped instead.
  const pageUrl = page.url === '' ? undefined : clampUrl(page.url);
  if (pageUrl === undefined) return null;
  const base = {
    event_id: newEventId(),
    occurred_at: new Date(nowMs).toISOString(),
    page_url: pageUrl,
    referrer: clampUrl(page.referrer) ?? '',
  };
  if (kind === 'consent_withdrawn') return { event_name: 'consent_withdrawn', ...base };
  return { event_name: 'consent_granted', ...base, trigger: trigger ?? 'initial_state' };
}
