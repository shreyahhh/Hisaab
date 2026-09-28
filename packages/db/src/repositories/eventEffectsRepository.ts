import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { assertStoreInScope, type CONSENT_SOURCES, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import {
  consentRecords,
  dsrRequests,
  orders,
  stores,
  suppressedIdentities,
} from '../schema/index.js';
import { insertAuditRow } from './auditLogRepository.js';

// Everything `event-workers` writes to Postgres for one store in one batch, in ONE transaction
// (event-pipeline.md §4.1 step 11): consent evidence, suppression entries, the withdrawal-triggered
// erasure request, and the checkout → visitor link on `orders`. Every statement is idempotent, because
// a batch whose Redis or ClickHouse half failed is redelivered and re-applied:
//   - `consent_records`: `ON CONFLICT (id) DO NOTHING` (id = the source event id);
//   - `suppressed_identities`: the unique (store, type, identifier, reason) index;
//   - `dsr_requests`: the partial unique index on (store, `result_summary.source_ref`), with
//     `source_ref = withdrawal:<event_id>`, so a redelivery finds the same request and BullMQ's
//     `jobId = dsr:<requestId>` then drops the duplicate job;
//   - `orders.visitor_id`: only set while it is still null.
// No identifier here is raw: visitor ids in consent/suppression rows are HMACs (P-4, HLD §8).

export interface ConsentRecordInput {
  /** The source `event_id` (SPEC v0.2), so the insert is naturally idempotent. */
  readonly id: string;
  /** HMAC(visitor_id), write version. */
  readonly visitorHmac: string;
  readonly purposes: readonly string[];
  readonly state: 'granted' | 'withdrawn';
  readonly noticeVersion: string;
  readonly source: (typeof CONSENT_SOURCES)[number];
  readonly occurredAt: Date;
}

/** Consent transitions, applied in the order given (a withdrawal and a later re-grant must end "granted"). */
export type ConsentChange =
  | {
      readonly kind: 'grant';
      /** The visitor's HMAC under every read key version, so an entry written under an older one goes too. */
      readonly visitorHmacs: readonly string[];
    }
  | { readonly kind: 'withdraw'; readonly eventId: string; readonly visitorHmac: string };

export interface ApplyEventEffectsInput {
  readonly storeId: string;
  readonly now: Date;
  readonly consentRecords: readonly ConsentRecordInput[];
  readonly consentChanges: readonly ConsentChange[];
  /** An erased identity seen on a new visitor (collector.md §4 step 10). */
  readonly suppressionHits: readonly {
    readonly visitorHmac: string;
    readonly identityHash: string;
  }[];
  readonly checkoutLinks: readonly {
    readonly externalOrderId: string;
    readonly visitorId: string;
  }[];
  /** `now + 13 months` (SUPPRESSION_TTL_DAYS). */
  readonly suppressionExpiresAt: Date;
  /** `now + 24 h` (privacy-dpdp.md §4.5). */
  readonly withdrawalDueAt: Date;
}

export interface ApplyEventEffectsResult {
  /** One per `withdraw` change: the erasure request to enqueue. */
  readonly withdrawalRequests: readonly {
    readonly eventId: string;
    readonly visitorHmac: string;
    readonly requestId: string;
  }[];
  /**
   * One per suppression hit. `requestId` is the erasure request that suppressed the matched identity, or
   * null if no `erased` identity entry carries this exact hash (possible only across a key rotation).
   */
  readonly suppressionHitRequests: readonly {
    readonly visitorHmac: string;
    readonly requestId: string | null;
    /**
     * The visitor's `erased` suppression row. Its UUID keys the follow-up job (`dsr-followup-<requestId>-<id>`):
     * BullMQ rejects `:` in custom job ids, and an id built from the visitor's HMAC would put an identifier
     * into job ids that are logged.
     */
    readonly suppressionId: string;
  }[];
  /** How many `orders` rows got their `visitor_id` from a `checkout_completed`. */
  readonly ordersLinked: number;
}

export interface EventEffectsRepository {
  applyStoreEffects(scope: Scope, input: ApplyEventEffectsInput): Promise<ApplyEventEffectsResult>;
}

/** The only sanctioned way for `event-workers` to write consent, suppression and the order visitor link (ADR-0016). */
export function createEventEffectsRepository(db: Db): EventEffectsRepository {
  return {
    async applyStoreEffects(scope, input) {
      assertStoreInScope(scope, input.storeId);
      const storeId = input.storeId;

      return db.transaction(async (tx) => {
        if (input.consentRecords.length > 0) {
          await tx
            .insert(consentRecords)
            .values(
              input.consentRecords.map((r) => ({
                id: r.id,
                storeId,
                visitorId: r.visitorHmac,
                purposes: [...r.purposes],
                state: r.state,
                noticeVersion: r.noticeVersion,
                source: r.source,
                occurredAt: r.occurredAt,
              })),
            )
            .onConflictDoNothing({ target: consentRecords.id });
        }

        const withdrawalRequests: { eventId: string; visitorHmac: string; requestId: string }[] =
          [];
        for (const change of input.consentChanges) {
          if (change.kind === 'grant') {
            // Only the `withdrawn` entry: `erased` is never lifted by a consent event (HLD §8).
            await tx
              .delete(suppressedIdentities)
              .where(
                and(
                  eq(suppressedIdentities.storeId, storeId),
                  eq(suppressedIdentities.identifierType, 'visitor_id'),
                  inArray(suppressedIdentities.identifier, [...change.visitorHmacs]),
                  eq(suppressedIdentities.reason, 'withdrawn'),
                ),
              );
            continue;
          }

          const sourceRef = `withdrawal:${change.eventId}`;
          const inserted = await tx
            .insert(dsrRequests)
            .values({
              storeId,
              type: 'erasure',
              identityHash: change.visitorHmac,
              dueAt: input.withdrawalDueAt,
              resultSummary: { trigger: 'consent_withdrawn', source_ref: sourceRef },
            })
            .onConflictDoNothing()
            .returning({ id: dsrRequests.id });
          let requestId = inserted[0]?.id;
          if (requestId !== undefined) {
            // SPEC §5.10 test 8: every DSR is audited. Written in this transaction, and only when the
            // request is new, so a redelivered batch doesn't audit it twice.
            const [store] = await tx
              .select({ organizationId: stores.organizationId })
              .from(stores)
              .where(eq(stores.id, storeId))
              .limit(1);
            if (!store) throw new Error('applyStoreEffects: store not found');
            await insertAuditRow(tx, {
              organizationId: store.organizationId,
              actorUserId: null,
              actorType: 'system',
              action: 'dsr_created',
              targetType: 'dsr_request',
              targetId: requestId,
              metadata: { type: 'erasure', trigger: 'consent_withdrawn' },
            });
          } else {
            const [existing] = await tx
              .select({ id: dsrRequests.id })
              .from(dsrRequests)
              .where(
                and(
                  eq(dsrRequests.storeId, storeId),
                  sql`(${dsrRequests.resultSummary}->>'source_ref') = ${sourceRef}`,
                ),
              )
              .limit(1);
            if (!existing)
              throw new Error('applyStoreEffects: withdrawal request conflicted but was not found');
            requestId = existing.id;
          }

          await tx
            .insert(suppressedIdentities)
            .values({
              storeId,
              identifierType: 'visitor_id',
              identifier: change.visitorHmac,
              reason: 'withdrawn',
              dsrRequestId: requestId,
              expiresAt: input.suppressionExpiresAt,
            })
            .onConflictDoNothing();
          withdrawalRequests.push({
            eventId: change.eventId,
            visitorHmac: change.visitorHmac,
            requestId,
          });
        }

        const suppressionHitRequests: {
          visitorHmac: string;
          requestId: string | null;
          suppressionId: string;
        }[] = [];
        for (const hit of input.suppressionHits) {
          const [matched] = await tx
            .select({ requestId: suppressedIdentities.dsrRequestId })
            .from(suppressedIdentities)
            .where(
              and(
                eq(suppressedIdentities.storeId, storeId),
                eq(suppressedIdentities.identifierType, 'identity_hash_hmac'),
                eq(suppressedIdentities.identifier, hit.identityHash),
                eq(suppressedIdentities.reason, 'erased'),
              ),
            )
            .limit(1);
          const requestId = matched?.requestId ?? null;
          const inserted = await tx
            .insert(suppressedIdentities)
            .values({
              storeId,
              identifierType: 'visitor_id',
              identifier: hit.visitorHmac,
              reason: 'erased',
              dsrRequestId: requestId,
              expiresAt: input.suppressionExpiresAt,
            })
            .onConflictDoNothing()
            .returning({ id: suppressedIdentities.id });
          let suppressionId = inserted[0]?.id;
          if (suppressionId === undefined) {
            const [existing] = await tx
              .select({ id: suppressedIdentities.id })
              .from(suppressedIdentities)
              .where(
                and(
                  eq(suppressedIdentities.storeId, storeId),
                  eq(suppressedIdentities.identifierType, 'visitor_id'),
                  eq(suppressedIdentities.identifier, hit.visitorHmac),
                  eq(suppressedIdentities.reason, 'erased'),
                ),
              )
              .limit(1);
            if (!existing)
              throw new Error('applyStoreEffects: suppression conflicted but was not found');
            suppressionId = existing.id;
          }
          suppressionHitRequests.push({ visitorHmac: hit.visitorHmac, requestId, suppressionId });
        }

        let ordersLinked = 0;
        for (const link of input.checkoutLinks) {
          const updated = await tx
            .update(orders)
            .set({ visitorId: link.visitorId })
            .where(
              and(
                eq(orders.storeId, storeId),
                eq(orders.externalOrderId, link.externalOrderId),
                isNull(orders.visitorId),
              ),
            )
            .returning({ id: orders.id });
          ordersLinked += updated.length;
        }

        return { withdrawalRequests, suppressionHitRequests, ordersLinked };
      });
    },
  };
}
