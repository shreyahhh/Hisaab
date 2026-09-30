import {
  createAuditLogRepository,
  createSystemScope,
  createWebhookDeliveryRepository,
  type Db,
} from '@truepath/db';
import { SHOPIFY_WEBHOOK_DELIVERY_RETENTION_DAYS } from '@truepath/shared';

// Issue #32: `shopify_webhook_deliveries` is a cross-topic dedup gate (shopify-integration.md
// §4.2/§4.3) with nothing deleting old rows, so it grows without bound. Nothing needs to remember a
// delivery once Shopify's retry window (8 attempts over 4 hours) has passed; the default retention
// is a wide margin over that (HLD §8 comment on `SHOPIFY_WEBHOOK_DELIVERY_RETENTION_DAYS`).
//
// This is a single cross-tenant sweep, not a per-store job, so it runs under an audited SystemScope
// rather than the `retention` BullMQ queue (which is DPDP per-tenant retention, M4-3, out of scope
// here) or a new canonical queue name (HLD §8 requires those to be added to its pending table and
// signed off, not invented unilaterally). It is invoked by `dev:prune-webhook-deliveries`
// (apps/workers/src/devWebhookDeliveryPrune.ts); wiring an actual nightly trigger (ops cron / systemd
// timer / a scheduled workflow with production DB access) is a deploy step this run may not take
// (CLAUDE.md: no cloud resource changes, no touching secrets).

export interface PruneWebhookDeliveriesDeps {
  readonly db: Db;
  readonly now?: () => Date;
  readonly retentionDays?: number;
  /** Limit the sweep to these stores (a targeted prune, or a test). Omitted = every store. */
  readonly storeIds?: readonly string[];
  /** Counts only. */
  readonly log?: (line: Record<string, unknown>) => void;
}

export interface PruneWebhookDeliveriesResult {
  readonly deleted: number;
  readonly retentionDays: number;
  readonly cutoff: Date;
}

export async function pruneWebhookDeliveries(
  deps: PruneWebhookDeliveriesDeps,
): Promise<PruneWebhookDeliveriesResult> {
  const now = (deps.now ?? (() => new Date()))();
  const retentionDays = deps.retentionDays ?? SHOPIFY_WEBHOOK_DELIVERY_RETENTION_DAYS;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const scope = await createSystemScope(deps.db, 'webhook_delivery_prune', {
    metadata: { retention_days: retentionDays },
  });
  const { deleted } = await createWebhookDeliveryRepository(deps.db).pruneOlderThan(
    scope,
    cutoff,
    deps.storeIds,
  );

  await createAuditLogRepository(deps.db).writePlatform({
    action: 'webhook_deliveries_pruned',
    actorType: 'system',
    targetType: 'shopify_webhook_deliveries',
    targetId: 'all',
    metadata: { deleted },
  });

  deps.log?.({ event: 'webhook_deliveries_pruned', deleted, retention_days: retentionDays });
  return { deleted, retentionDays, cutoff };
}
