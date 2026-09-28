import { z } from 'zod';
import type { ShopifyOrderSnapshot } from './types.js';

// Shopify order/refund/fulfillment webhook payload shapes (shopify-integration.md §2.5). Webhook
// payloads are REST-shaped even though the Admin API itself is GraphQL-first (the REST Admin API
// is legacy for *requests* since 2024-10-01, but webhook *deliveries* keep the REST resource shape).
// Only mapped fields survive past this schema — everything else (customer name, line items, full
// addresses, ...) is discarded by `.passthrough()` never being read, not by an allowlist here.

const MoneyString = z.string().regex(/^-?\d+(\.\d{1,2})?$/); // e.g. "1299.00" — never parsed as a float

const Address = z
  .object({ zip: z.string().nullable().optional(), phone: z.string().nullable().optional() })
  .passthrough();

const NoteAttribute = z.object({ name: z.string(), value: z.string().nullable() });

export const ShopifyOrderWebhook = z
  .object({
    id: z.union([z.number().int(), z.string()]),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
    cancelled_at: z.string().datetime({ offset: true }).nullable().optional(),
    currency: z.string().length(3),
    total_price: MoneyString,
    total_outstanding: MoneyString.optional(),
    financial_status: z.string().nullable().optional(),
    fulfillment_status: z.string().nullable().optional(),
    payment_gateway_names: z.array(z.string()).optional(),
    email: z.string().nullable().optional(), // Level 2 (m0-7-external-setup.md item 3)
    phone: z.string().nullable().optional(), // Level 2
    shipping_address: Address.nullable().optional(), // Level 2 (address)
    landing_site: z.string().nullable().optional(),
    referring_site: z.string().nullable().optional(),
    note_attributes: z.array(NoteAttribute).optional(),
    discount_codes: z.array(z.object({ code: z.string() }).passthrough()).optional(),
  })
  .passthrough();
export type ShopifyOrderWebhookPayload = z.infer<typeof ShopifyOrderWebhook>;

/** Just enough to locate the parent order and record a trail event — the real data comes from `fetchOrder`. */
export const ShopifyOrderHintWebhook = z
  .object({
    order_id: z.union([z.number().int(), z.string()]),
    created_at: z.string().datetime({ offset: true }).optional(),
    updated_at: z.string().datetime({ offset: true }).optional(),
  })
  .passthrough();
export type ShopifyOrderHintPayload = z.infer<typeof ShopifyOrderHintWebhook>;

/** Converts a validated REST order webhook payload into the adapter's unified snapshot shape. */
export function snapshotFromOrderWebhook(
  payload: ShopifyOrderWebhookPayload,
): ShopifyOrderSnapshot {
  return {
    externalOrderId: String(payload.id),
    createdAtPlatform: payload.created_at,
    updatedAtPlatform: payload.updated_at,
    cancelledAt: payload.cancelled_at ?? null,
    currency: payload.currency,
    totalPrice: payload.total_price,
    totalRefunded: null, // REST order webhooks don't carry this (LLD §2.5) — order_refresh fills it in
    totalOutstanding: payload.total_outstanding ?? null,
    financialStatus: payload.financial_status ?? null,
    fulfillmentStatus: payload.fulfillment_status ?? null,
    paymentGatewayNames: payload.payment_gateway_names ?? [],
    email: payload.email ?? null,
    phone: payload.phone ?? payload.shipping_address?.phone ?? null,
    shippingAddressZip: payload.shipping_address?.zip ?? null,
    landingSite: payload.landing_site ?? null,
    referringSite: payload.referring_site ?? null,
    noteAttributes: payload.note_attributes ?? [],
    discountCodes: (payload.discount_codes ?? []).map((d) => d.code),
  };
}
