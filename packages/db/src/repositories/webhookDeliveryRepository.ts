import { assertStoreInScope, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { shopifyWebhookDeliveries } from '../schema/index.js';

export interface RecordWebhookDeliveryInput {
  readonly storeId: string;
  readonly webhookId: string; // X-Shopify-Webhook-Id
  readonly topic: string; // X-Shopify-Topic
}

export interface WebhookDeliveryRepository {
  /**
   * Records a Shopify webhook delivery exactly once per `(storeId, webhookId)`. Returns `isNew:
   * false` for a replay (a Shopify retry, or a duplicate at-least-once delivery) — the caller must
   * skip dispatching to any topic handler in that case (CLAUDE.md "Webhooks: verify, dedupe").
   */
  recordDelivery(
    scope: Scope,
    input: RecordWebhookDeliveryInput,
  ): Promise<{ readonly isNew: boolean }>;
}

/** The only sanctioned way to write `shopify_webhook_deliveries` (ADR-0016). */
export function createWebhookDeliveryRepository(db: Db): WebhookDeliveryRepository {
  return {
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
