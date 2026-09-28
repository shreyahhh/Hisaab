import {
  hashContact,
  sanitiseReferrer,
  sanitiseUrl,
  type IdentityHasher,
  type VersionedHmac,
} from '@truepath/privacy';
import { PAYMENT_METHODS } from '@truepath/shared';
import type { ShopifyOrderSnapshot } from './types.js';

type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// Pure mapping/parsing functions (shopify-integration.md §4.5/§4.6). No I/O — no fetch, no DB
// query — so these get the same fast, exhaustive unit-test treatment as packages/attribution.
// (`hashContact` does CPU-bound HMAC work, not network/DB access, so it belongs here too.)

const MONEY_PATTERN = /^-?\d+(\.\d{1,2})?$/;

/** Decimal string ("1299.00", "1299", "0.01") → integer paise. Never goes through a float. */
export function parseMoneyToPaise(value: string): number {
  if (!MONEY_PATTERN.test(value)) {
    throw new Error(`parseMoneyToPaise: not a decimal money string: ${JSON.stringify(value)}`);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [wholePart, fractionPart = ''] = unsigned.split('.');
  const paddedFraction = `${fractionPart}00`.slice(0, 2);
  const paise = Number.parseInt(`${wholePart}${paddedFraction}`, 10);
  if (!Number.isSafeInteger(paise)) {
    throw new Error(`parseMoneyToPaise: value out of safe integer range: ${value}`);
  }
  return negative ? -paise : paise;
}

// shopify-integration.md §7: "Order money sanity bound: ≤ ₹1,00,00,000 per order; larger → flagged"
// (flagged, not rejected — the order is still stored; the caller decides how to surface the flag).
export const ORDER_MONEY_SANITY_BOUND_PAISE = 1_000_000_000; // ₹1,00,00,000

export function exceedsMoneySanityBound(paise: number): boolean {
  return Math.abs(paise) > ORDER_MONEY_SANITY_BOUND_PAISE;
}

export interface CodMapping {
  readonly cod: readonly string[];
  readonly partial_cod: readonly string[];
  readonly prepaid: readonly string[];
}

// shopify-integration.md §4.6 defaults — gateway names need design-partner data; these are a
// starting point, editable per store once PUT /v1/integrations/:id/settings exists (follow-up issue).
export const DEFAULT_COD_MAPPING: CodMapping = {
  cod: ['cash on delivery', 'cod', 'cash_on_delivery'],
  partial_cod: ['partial cod', 'partial_cod'],
  prepaid: [
    'shopify_payments',
    'razorpay',
    'payu',
    'cashfree',
    'phonepe',
    'paytm',
    'ccavenue',
    'gokwik',
    'snapmint',
    'simpl',
  ],
};

// "cod" alone must match as a whole token (avoids an accidental substring hit inside an unrelated
// gateway name); every other pattern is a plain substring match, both already lowercased.
function gatewayNameMatches(nameLower: string, pattern: string): boolean {
  if (pattern === 'cod') return /\bcod\b/.test(nameLower);
  return nameLower.includes(pattern);
}

function matchesAnyGateway(namesLower: readonly string[], patterns: readonly string[]): boolean {
  return namesLower.some((name) => patterns.some((pattern) => gatewayNameMatches(name, pattern)));
}

/**
 * shopify-integration.md §4.6, evaluated in order: any partial_cod gateway wins outright; a cod
 * gateway alongside a prepaid one, or a cod gateway with a partial outstanding balance, is also
 * partial_cod; otherwise cod or prepaid by whichever matched; unmapped falls back to the order's
 * own financial_status.
 */
export function detectPaymentMethod(
  gatewayNames: readonly string[],
  totalOutstandingPaise: number | null,
  totalPricePaise: number,
  financialStatus: string | null,
  mapping: CodMapping = DEFAULT_COD_MAPPING,
): PaymentMethod {
  const namesLower = gatewayNames.map((name) => name.toLowerCase());
  if (matchesAnyGateway(namesLower, mapping.partial_cod)) return 'partial_cod';

  const hasCod = matchesAnyGateway(namesLower, mapping.cod);
  const hasPrepaid = matchesAnyGateway(namesLower, mapping.prepaid);
  if (hasCod && hasPrepaid) return 'partial_cod';
  if (
    hasCod &&
    totalOutstandingPaise !== null &&
    totalOutstandingPaise > 0 &&
    totalOutstandingPaise < totalPricePaise
  ) {
    return 'partial_cod';
  }
  if (hasCod) return 'cod';
  if (hasPrepaid) return 'prepaid';
  return financialStatus === 'pending' ? 'cod' : 'prepaid';
}

const ALLOWED_NOTE_ATTRIBUTE_KEYS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
]);

export interface NoteAttribute {
  readonly name: string;
  readonly value: string | null;
}

/** Keeps only campaign-attribution keys (shopify-integration.md §4.5) — everything else is dropped. */
export function filterNoteAttributes(attributes: readonly NoteAttribute[]): NoteAttribute[] {
  return attributes.filter((attribute) => ALLOWED_NOTE_ATTRIBUTE_KEYS.has(attribute.name));
}

/** Digits only; the first 3 of a 6-digit Indian PIN code, else null (SPEC §5.4 — never the full PIN). */
export function pincodePrefixFromZip(zip: string | null): string | null {
  if (!zip) return null;
  const digits = zip.replace(/\D/g, '');
  return digits.length === 6 ? digits.slice(0, 3) : null;
}

export interface MappedOrderFields {
  readonly totalAmountPaise: number;
  /** null: the source snapshot didn't carry this (a REST order webhook) — the caller must leave
   * the existing stored value untouched rather than overwrite it with 0. */
  readonly refundedAmountPaise: number | null;
  readonly currency: string;
  readonly paymentMethod: PaymentMethod;
  readonly financialStatus: string | null;
  readonly fulfilmentStatus: string;
  readonly pincodePrefix: string | null;
  readonly phoneHashHmac: VersionedHmac | null;
  readonly emailHashHmac: VersionedHmac | null;
  /**
   * The phone and email HMACs under every read key version — what an erased-identity lookup must try
   * (HLD §8, privacy-dpdp.md §4.1: a suppression entry may have been written under an older version).
   * Never stored: the write-version hashes above are.
   */
  readonly identityLookup: readonly VersionedHmac[];
  readonly landingSite: string | null;
  readonly referringSite: string | null;
  readonly noteAttributes: NoteAttribute[];
  readonly discountCodes: readonly string[];
  readonly cancelledAt: Date | null;
  readonly createdAtPlatform: Date;
  readonly moneySanityExceeded: boolean;
}

/**
 * The full field mapping (shopify-integration.md §4.5), for a snapshot already confirmed to be in
 * INR by the caller — this function never sees a non-INR snapshot (the webhook route rejects those
 * before mapping is ever attempted, so a currency bug here can't silently mis-price a foreign-
 * currency order). Hashing and URL sanitising are pure CPU work, not I/O, so they belong here
 * alongside the rest of the field mapping rather than in the (I/O-bound) repository layer.
 */
export function mapOrderSnapshot(
  snapshot: ShopifyOrderSnapshot,
  storeId: string,
  hasher: IdentityHasher,
  codMapping: CodMapping = DEFAULT_COD_MAPPING,
): MappedOrderFields {
  const totalAmountPaise = parseMoneyToPaise(snapshot.totalPrice);
  const totalOutstandingPaise =
    snapshot.totalOutstanding !== null ? parseMoneyToPaise(snapshot.totalOutstanding) : null;
  const refundedAmountPaise =
    snapshot.totalRefunded !== null ? parseMoneyToPaise(snapshot.totalRefunded) : null;

  const identity = hashContact(hasher, storeId, {
    phone: snapshot.phone ?? undefined,
    email: snapshot.email ?? undefined,
  });

  return {
    totalAmountPaise,
    refundedAmountPaise,
    currency: snapshot.currency,
    paymentMethod: detectPaymentMethod(
      snapshot.paymentGatewayNames,
      totalOutstandingPaise,
      totalAmountPaise,
      snapshot.financialStatus,
      codMapping,
    ),
    financialStatus: snapshot.financialStatus ? snapshot.financialStatus.toLowerCase() : null,
    fulfilmentStatus: snapshot.fulfillmentStatus
      ? snapshot.fulfillmentStatus.toLowerCase()
      : 'unfulfilled',
    pincodePrefix: pincodePrefixFromZip(snapshot.shippingAddressZip),
    phoneHashHmac: identity.phoneHmac ?? null,
    emailHashHmac: identity.emailHmac ?? null,
    identityLookup: identity.lookup,
    landingSite: snapshot.landingSite ? sanitiseUrl(snapshot.landingSite) : null,
    referringSite: snapshot.referringSite ? sanitiseReferrer(snapshot.referringSite) : null,
    noteAttributes: filterNoteAttributes(snapshot.noteAttributes),
    discountCodes: snapshot.discountCodes,
    cancelledAt: snapshot.cancelledAt ? new Date(snapshot.cancelledAt) : null,
    createdAtPlatform: new Date(snapshot.createdAtPlatform),
    moneySanityExceeded: exceedsMoneySanityBound(totalAmountPaise),
  };
}
