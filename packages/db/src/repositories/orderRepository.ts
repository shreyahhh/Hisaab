import { and, eq, or, sql } from 'drizzle-orm';
import { assertStoreInScope, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { orders, orderStatusEvents } from '../schema/index.js';

export type OrderRow = typeof orders.$inferSelect;

/**
 * Everything needed to apply one webhook delivery's worth of order state — already fully resolved
 * by the caller (either straight from a REST `orders/*` webhook, or via a `fetchOrder` GraphQL call
 * for a `refunds/*`/`fulfillments/*` hint). Deliberately **not** `@truepath/integrations`'s
 * `MappedOrderFields` type: this file has no dependency on that package at all, which is what makes
 * it structurally impossible for `applySnapshot` to reach out to Shopify from inside its
 * transaction (M1-2 review item 1) — there's nothing here it could even call.
 */
export interface ApplyOrderSnapshotInput {
  readonly storeId: string;
  readonly externalOrderId: string;
  readonly createdAtPlatform: Date;
  /** Already confirmed INR by the caller — this repository never converts currency (review item 5). */
  readonly totalAmountPaise: number;
  readonly currency: string;
  readonly paymentMethod: 'cod' | 'prepaid' | 'partial_cod';
  /** null: the source snapshot didn't carry this — leave the stored value untouched. */
  readonly refundedAmountPaise: number | null;
  readonly financialStatus: string | null;
  readonly fulfilmentStatus: string;
  readonly cancelledAt: Date | null;
  readonly pincodePrefix: string | null;
  readonly phoneHashHmac: string | null;
  readonly emailHashHmac: string | null;
  readonly landingSite: string | null;
  readonly referringSite: string | null;
  readonly noteAttributes: readonly { readonly name: string; readonly value: string | null }[];
  readonly discountCodes: readonly string[];
  /** The event trail / out-of-order guard (HLD "Delivery-status precedence"). */
  readonly sourceTimestamp: Date;
  readonly eventStatus: 'created' | 'updated' | 'cancelled' | 'refund' | 'fulfillment';
  /** X-Shopify-Webhook-Id — the idempotency key (issue #26). */
  readonly rawRef: string;
}

export interface ApplyOrderSnapshotResult {
  readonly orderId: string;
  /** False when the snapshot was older than what's already stored (stale) — the event row is still
   * recorded either way, but order fields are left untouched. */
  readonly applied: boolean;
  /** False when this exact (order, source, raw_ref) was already recorded — a duplicate delivery,
   * including two genuinely concurrent copies of the same delivery (issue #26). */
  readonly isNewEvent: boolean;
}

export interface OrderRepository {
  /**
   * shopify-integration.md §4.4. Concurrency (issue #26, M1-2 review item 3): guarantees the row
   * exists via `INSERT ... ON CONFLICT DO NOTHING` first, *then* takes a row lock
   * (`SELECT ... FOR UPDATE`) — never the reverse, which would race two concurrent first-ever
   * deliveries for the same new order into two competing inserts. The lock serializes everything
   * after it; the `order_status_events` unique constraint is what actually decides duplicate vs.
   * new once serialized.
   */
  applySnapshot(scope: Scope, input: ApplyOrderSnapshotInput): Promise<ApplyOrderSnapshotResult>;
}

/** The only sanctioned way to read/write `orders`/`order_status_events` (ADR-0016). */
export function createOrderRepository(db: Db): OrderRepository {
  return {
    async applySnapshot(scope, input) {
      assertStoreInScope(scope, input.storeId);

      return db.transaction(async (tx) => {
        // is_first_order (shopify-integration.md §4.5's fallback path — M1-2 always uses it, per
        // the M1-2 plan's Conflict 3: customerJourneySummary isn't queried in this ticket). Computed
        // before the insert attempt; a race between two *different* new orders for the same shopper
        // arriving at the same instant could both see "no earlier order" and both set true — an
        // accepted imprecision already flagged in shopify-integration.md's own Open Question 3.
        let isFirstOrder = true;
        if (input.phoneHashHmac || input.emailHashHmac) {
          const identityMatch = [
            input.phoneHashHmac ? eq(orders.phoneHashHmac, input.phoneHashHmac) : undefined,
            input.emailHashHmac ? eq(orders.emailHashHmac, input.emailHashHmac) : undefined,
          ].filter((c): c is NonNullable<typeof c> => c !== undefined);
          const [earlierOrder] = await tx
            .select({ id: orders.id })
            .from(orders)
            .where(and(eq(orders.storeId, input.storeId), or(...identityMatch)))
            .limit(1);
          isFirstOrder = !earlierOrder;
        }

        // 1. Guarantee the row exists. Two concurrent first-ever deliveries for the same new order
        // both reach this statement; exactly one inserts, the other no-ops here and picks up the
        // winner's row at step 2 — never two competing INSERTs racing each other directly.
        await tx
          .insert(orders)
          .values({
            storeId: input.storeId,
            externalOrderId: input.externalOrderId,
            createdAtPlatform: input.createdAtPlatform,
            totalAmountPaise: input.totalAmountPaise,
            currency: input.currency,
            paymentMethod: input.paymentMethod,
            refundedAmountPaise: input.refundedAmountPaise ?? 0,
            financialStatus: input.financialStatus,
            fulfilmentStatus: input.fulfilmentStatus,
            deliveryStatus: 'pending',
            pincodePrefix: input.pincodePrefix,
            phoneHashHmac: input.phoneHashHmac,
            emailHashHmac: input.emailHashHmac,
            landingSite: input.landingSite,
            referringSite: input.referringSite,
            noteAttributes: input.noteAttributes,
            discountCodes: [...input.discountCodes],
            isFirstOrder,
            // attributionConfidence deliberately omitted — stays null (schema default) until
            // identity-stitching (M1-7) actually computes it.
          })
          .onConflictDoNothing({ target: [orders.storeId, orders.externalOrderId] });

        // 2. Lock the row — whichever transaction created it, or found it already there. Every
        // concurrent delivery for this order serializes here, one at a time, from this point on.
        const [existing] = await tx
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.storeId, input.storeId),
              eq(orders.externalOrderId, input.externalOrderId),
            ),
          )
          .for('update');
        if (!existing) {
          throw new Error(
            'applySnapshot: order row missing immediately after insert (unreachable)',
          );
        }

        // 3. Out-of-order guard (HLD "Delivery-status precedence"): compare against the latest
        // Shopify-sourced event already recorded for this order.
        const [latest] = await tx
          .select({ occurredAt: orderStatusEvents.occurredAt })
          .from(orderStatusEvents)
          .where(
            and(
              eq(orderStatusEvents.orderId, existing.id),
              eq(orderStatusEvents.source, 'shopify'),
            ),
          )
          .orderBy(sql`${orderStatusEvents.occurredAt} DESC`)
          .limit(1);
        const isStale = latest ? input.sourceTimestamp < latest.occurredAt : false;

        let applied = false;
        if (!isStale) {
          // HLD precedence: cancelled_at set *and* still pending -> cancelled. Shiprocket-owned
          // fields/statuses (in_transit/delivered/rto, delivered_at, rto_at, visitor_id) are never
          // touched here.
          const nextDeliveryStatus =
            input.cancelledAt && existing.deliveryStatus === 'pending'
              ? 'cancelled'
              : existing.deliveryStatus;

          await tx
            .update(orders)
            .set({
              totalAmountPaise: input.totalAmountPaise,
              currency: input.currency,
              paymentMethod: input.paymentMethod,
              refundedAmountPaise: input.refundedAmountPaise ?? existing.refundedAmountPaise,
              financialStatus: input.financialStatus,
              fulfilmentStatus: input.fulfilmentStatus,
              deliveryStatus: nextDeliveryStatus,
              pincodePrefix: input.pincodePrefix,
              phoneHashHmac: input.phoneHashHmac,
              emailHashHmac: input.emailHashHmac,
              landingSite: input.landingSite,
              referringSite: input.referringSite,
              noteAttributes: input.noteAttributes,
              discountCodes: [...input.discountCodes],
            })
            .where(eq(orders.id, existing.id));
          applied = true;
        }

        // 4. The trail event, and the actual idempotency decision (issue #26): ON CONFLICT DO
        // NOTHING on (order_id, source, raw_ref) means a duplicate delivery — even a genuinely
        // concurrent one, now serialized by the lock above — inserts zero rows here. Recorded even
        // when stale, per shopify-integration.md §4.4 ("record the event row only").
        const insertedEvent = await tx
          .insert(orderStatusEvents)
          .values({
            orderId: existing.id,
            source: 'shopify',
            status: input.eventStatus,
            occurredAt: input.sourceTimestamp,
            rawRef: input.rawRef,
          })
          .onConflictDoNothing({
            target: [orderStatusEvents.orderId, orderStatusEvents.source, orderStatusEvents.rawRef],
          })
          .returning({ id: orderStatusEvents.id });

        return { orderId: existing.id, applied, isNewEvent: insertedEvent.length > 0 };
      });
    },
  };
}
