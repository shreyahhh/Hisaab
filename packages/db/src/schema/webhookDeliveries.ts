import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { stores } from './tenancy.js';

// Cross-topic webhook delivery dedup (shopify-integration.md §4.2/§4.3, CLAUDE.md "Webhooks: verify,
// dedupe"). One row per (store, webhook id), checked *before* dispatching to any topic handler — so
// `app/uninstalled` and future order/refund/fulfillment topics get the same replay protection the
// compliance topics already had via `dsr_requests`' own dedupe. Not store_id-prefixed-key Redis (HLD
// §8's dedup pattern is for the pixel event stream); a Postgres table survives Shopify's retries over
// hours without needing a TTL policy decision up front. Old rows are pruned by
// `apps/workers/src/webhookDeliveryPrune.ts` (issue #32), invoked via `dev:prune-webhook-deliveries`
// until a scheduled-job runner exists to call it automatically.
export const shopifyWebhookDeliveries = pgTable(
  'shopify_webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    webhookId: text('webhook_id').notNull(), // X-Shopify-Webhook-Id
    topic: text('topic').notNull(), // X-Shopify-Topic, for debugging only — not part of the dedup key
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    storeWebhookIdUniq: uniqueIndex('shopify_webhook_deliveries_store_id_webhook_id_uniq').on(
      table.storeId,
      table.webhookId,
    ),
    receivedAtIdx: index('shopify_webhook_deliveries_received_at_idx').on(table.receivedAt),
  }),
);
