import { and, eq } from 'drizzle-orm';
import { assertStoreInScope, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { shopifyWebhookDeliveries } from '../schema/index.js';

export interface WebhookDeliveryKey {
  readonly storeId: string;
  readonly webhookId: string; // X-Shopify-Webhook-Id
}

export interface RecordWebhookDeliveryInput extends WebhookDeliveryKey {
  readonly topic: string; // X-Shopify-Topic
}

export interface WebhookDeliveryRepository {
  /**
   * True if this `(storeId, webhookId)` was already recorded as successfully processed. Checked
   * *before* dispatching to a topic handler — a hit means "skip, this is a replay of a delivery we
   * already finished."
   */
  wasAlreadyDelivered(scope: Scope, key: WebhookDeliveryKey): Promise<boolean>;
  /**
   * Records a Shopify webhook delivery as done. **Call only after the topic handler has completed
   * successfully** — recording it first (or on a failure path) would let a handler crash on attempt
   * 1 permanently swallow the event, since Shopify's retry of the same webhook id would then see it
   * as already delivered and never run the handler again. Idempotent: a second call for the same key
   * (e.g. a benign race between two concurrent identical deliveries) is a no-op.
   */
  recordDelivery(
    scope: Scope,
    input: RecordWebhookDeliveryInput,
  ): Promise<{ readonly isNew: boolean }>;
}

/** The only sanctioned way to read/write `shopify_webhook_deliveries` (ADR-0016). */
export function createWebhookDeliveryRepository(db: Db): WebhookDeliveryRepository {
  return {
    async wasAlreadyDelivered(scope, key) {
      assertStoreInScope(scope, key.storeId);
      const rows = await db
        .select({ id: shopifyWebhookDeliveries.id })
        .from(shopifyWebhookDeliveries)
        .where(
          and(
            eq(shopifyWebhookDeliveries.storeId, key.storeId),
            eq(shopifyWebhookDeliveries.webhookId, key.webhookId),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async recordDelivery(scope, input) {
      assertStoreInScope(scope, input.storeId);
      const inserted = await db
        .insert(shopifyWebhookDeliveries)
        .values({ storeId: input.storeId, webhookId: input.webhookId, topic: input.topic })
        .onConflictDoNothing()
        .returning({ id: shopifyWebhookDeliveries.id });
      return { isNew: inserted.length > 0 };
    },
  };
}
