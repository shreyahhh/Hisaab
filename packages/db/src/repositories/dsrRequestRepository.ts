import { and, desc, eq, sql } from 'drizzle-orm';
import { assertStoreInScope, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { dsrRequests } from '../schema/index.js';

export type DsrRequestRow = typeof dsrRequests.$inferSelect;

export interface CreateDsrRequestFromWebhookInput {
  readonly storeId: string;
  readonly type: 'access' | 'erasure' | 'store_erasure';
  /** null for `store_erasure` — it is store-wide, not tied to one shopper (privacy-dpdp.md line 196). */
  readonly identityHash: string | null;
  readonly dueAt: Date;
  /** Dedupe key (shopify-integration.md §4.3): `X-Shopify-Webhook-Id` for this delivery. */
  readonly sourceRef: string;
}

export interface DsrRequestRepository {
  /**
   * Records receipt of a Shopify compliance webhook (`customers/data_request` | `customers/redact` |
   * `shop/redact`) durably, exactly once per `(storeId, sourceRef)` — a Shopify retry of the same
   * webhook delivery creates no second row (CLAUDE.md "Webhooks: verify, dedupe"). This is the
   * *receipt*, not fulfilment: turning the row into an actual export/erasure is a separate, later
   * pipeline (privacy-dpdp.md).
   */
  createFromWebhook(
    scope: Scope,
    input: CreateDsrRequestFromWebhookInput,
  ): Promise<{ readonly row: DsrRequestRow; readonly created: boolean }>;

  /** The store's most recent DSR requests, newest first — SPEC §10 `GET /v1/stores/:id/privacy/requests`. */
  listRecentByStore(scope: Scope, storeId: string, limit: number): Promise<DsrRequestRow[]>;
}

/** The only sanctioned way to write `dsr_requests` from a webhook (ADR-0016). */
export function createDsrRequestRepository(db: Db): DsrRequestRepository {
  return {
    async createFromWebhook(scope, input) {
      assertStoreInScope(scope, input.storeId);

      const inserted = await db
        .insert(dsrRequests)
        .values({
          storeId: input.storeId,
          type: input.type,
          identityHash: input.identityHash,
          dueAt: input.dueAt,
          resultSummary: { trigger: 'shopify_webhook', source_ref: input.sourceRef },
        })
        // No explicit target: dsr_requests has exactly one meaningful unique constraint besides its
        // primary key (the partial source_ref index), so a plain ON CONFLICT DO NOTHING is
        // unambiguous and needs no expression-index target syntax.
        .onConflictDoNothing()
        .returning();
      const created = inserted[0];
      if (created) return { row: created, created: true };

      const existingRows = await db
        .select()
        .from(dsrRequests)
        .where(
          and(
            eq(dsrRequests.storeId, input.storeId),
            sql`(${dsrRequests.resultSummary}->>'source_ref') = ${input.sourceRef}`,
          ),
        )
        .limit(1);
      const existing = existingRows[0];
      if (!existing) throw new Error('createFromWebhook: conflicted but no row was found');
      return { row: existing, created: false };
    },

    async listRecentByStore(scope, storeId, limit) {
      assertStoreInScope(scope, storeId);
      return db
        .select()
        .from(dsrRequests)
        .where(eq(dsrRequests.storeId, storeId))
        .orderBy(desc(dsrRequests.createdAt))
        .limit(limit);
    },
  };
}
