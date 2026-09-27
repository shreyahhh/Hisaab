import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { DELIVERY_STATUSES, ORDER_STATUS_SOURCES, PAYMENT_METHODS } from '@truepath/shared';
import { attributionConfidenceEnum, deliveryRateFallbackLevelEnum } from './enums.js';
import { checkOneOf } from './columns.js';
import { stores } from './tenancy.js';

// Money is integer paise (ADR-0006). `mode: 'number'` maps Postgres bigint to a JS number: safe
// because Number.MAX_SAFE_INTEGER (9,007,199,254,740,991) is ~₹90,000 crore in paise — orders of
// magnitude beyond SPEC's target store size (₹10L–₹5Cr monthly GMV, §1) or any plausible sum of
// them — and far simpler than BigInt for the arithmetic elsewhere (attribution credits, refunds).
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    externalOrderId: text('external_order_id').notNull(),
    externalOrderName: text('external_order_name'), // v0.4, conditional: only if Shiprocket matches by order name
    createdAtPlatform: timestamp('created_at_platform', { withTimezone: true }).notNull(),
    totalAmountPaise: bigint('total_amount_paise', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    paymentMethod: text('payment_method').notNull(), // @truepath/shared PAYMENT_METHODS
    refundedAmountPaise: bigint('refunded_amount_paise', { mode: 'number' }).notNull().default(0),
    financialStatus: text('financial_status'), // Shopify's own evolving enum — stored verbatim (CLAUDE.md rule 8)
    fulfilmentStatus: text('fulfilment_status'),
    deliveryStatus: text('delivery_status').notNull().default('pending'), // @truepath/shared DELIVERY_STATUSES
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    rtoAt: timestamp('rto_at', { withTimezone: true }),
    pincodePrefix: text('pincode_prefix'), // first 3 digits only (SPEC §5.4)
    phoneHashHmac: text('phone_hash_hmac'), // k<N>:<hex> (ADR-0007)
    emailHashHmac: text('email_hash_hmac'),
    visitorId: text('visitor_id'),
    landingSite: text('landing_site'),
    referringSite: text('referring_site'),
    noteAttributes: jsonb('note_attributes'),
    discountCodes: text('discount_codes').array(),
    isFirstOrder: boolean('is_first_order'),
    // Nullable (M1-2): null means "identity-stitching hasn't run yet", distinct from either real
    // value. Defaulting this to 'high' would assert a confidence level nothing has actually
    // computed — identity-stitching (M1-7) is the only thing that ever sets 'high' or 'low', by
    // resolving (or failing to resolve, and falling back to UTM) the order's visitor journey.
    attributionConfidence: attributionConfidenceEnum('attribution_confidence'),
  },
  (table) => ({
    storeIdx: index('orders_store_id_idx').on(table.storeId),
    // Backs the retention job's C_ord cutoff scan and the nightly 45-day attribution recompute
    // (attribution-engine.md §4.5), both "orders for this store created/older than a cutoff".
    storeCreatedAtIdx: index('orders_store_id_created_at_platform_idx').on(
      table.storeId,
      table.createdAtPlatform,
    ),
    storeExternalOrderUnique: uniqueIndex('orders_store_id_external_order_id_key').on(
      table.storeId,
      table.externalOrderId,
    ),
    paymentMethodCheck: checkOneOf(
      'orders_payment_method_check',
      table.paymentMethod,
      PAYMENT_METHODS,
    ),
    deliveryStatusCheck: checkOneOf(
      'orders_delivery_status_check',
      table.deliveryStatus,
      DELIVERY_STATUSES,
    ),
  }),
);

export const orderStatusEvents = pgTable(
  'order_status_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    source: text('source').notNull(), // @truepath/shared ORDER_STATUS_SOURCES
    status: text('status').notNull(), // varies per source; no fixed enum in SPEC
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    rawRef: text('raw_ref'), // e.g. X-Shopify-Webhook-Id — never the raw webhook payload itself
  },
  (table) => ({
    // Backs the out-of-order guard (HLD "Delivery-status precedence"): the latest occurred_at for
    // this order from the same source.
    orderSourceOccurredIdx: index('order_status_events_order_id_source_occurred_at_idx').on(
      table.orderId,
      table.source,
      table.occurredAt,
    ),
    // M1-2: the actual idempotency mechanism (shopify-integration.md §4.3) —
    // `INSERT ... ON CONFLICT (order_id, source, raw_ref) DO NOTHING` is what decides duplicate vs.
    // new at the database level; the webhook route's own delivery-dedup table is a fast-path only
    // (issue #26). Plain (not NULLS NOT DISTINCT): every row this ticket inserts always sets
    // raw_ref, but a future source without one shouldn't have its NULLs collide with each other.
    orderSourceRawRefUnique: uniqueIndex('order_status_events_order_id_source_raw_ref_uniq').on(
      table.orderId,
      table.source,
      table.rawRef,
    ),
    sourceCheck: checkOneOf('order_status_events_source_check', table.source, ORDER_STATUS_SOURCES),
  }),
);

// One row per (store, payment_method); payment_method = null is the store-wide fallback row
// (SPEC §6.1 fallback chain). NULLS NOT DISTINCT (Postgres 16) so the single store-wide row is
// actually enforced, not just a convention — the earlier plain-unique version let NULL rows
// duplicate freely.
export const storeDeliveryRates = pgTable(
  'store_delivery_rates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    paymentMethod: text('payment_method'), // @truepath/shared PAYMENT_METHODS, nullable
    windowDays: integer('window_days').notNull().default(90),
    deliveryRate: numeric('delivery_rate', { precision: 5, scale: 4 }).notNull(),
    resolvedOrders: integer('resolved_orders').notNull(),
    fallbackLevel: deliveryRateFallbackLevelEnum('fallback_level').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    storeIdx: index('store_delivery_rates_store_id_idx').on(table.storeId),
    storePaymentMethodUnique: unique('store_delivery_rates_store_id_payment_method_key')
      .on(table.storeId, table.paymentMethod)
      .nullsNotDistinct(),
    paymentMethodCheck: checkOneOf(
      'store_delivery_rates_payment_method_check',
      table.paymentMethod,
      PAYMENT_METHODS,
    ),
  }),
);
