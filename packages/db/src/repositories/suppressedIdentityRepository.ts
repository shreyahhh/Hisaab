import { and, eq, sql } from 'drizzle-orm';
import { assertStoreInScope, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { suppressedIdentities } from '../schema/index.js';

export interface AddSuppressionInput {
  readonly identifierType: 'visitor_id' | 'identity_hash_hmac';
  /** Always an HMAC, `k<N>:<hex>` (ADR-0007) — never a raw visitor id or identity value. */
  readonly identifier: string;
  readonly reason: 'erased' | 'withdrawn';
  readonly dsrRequestId?: string;
  /** Computed by the caller (`now + SUPPRESSION_TTL_DAYS`, `@truepath/shared`) — this repository has
   * no retention-policy knowledge of its own, matching `eventEffectsRepository`'s existing inserts. */
  readonly expiresAt: Date;
}

export interface SuppressedIdentityRepository {
  /** How many identities are currently suppressed for the store (erasure + withdrawal) — Privacy page. */
  countByStore(scope: Scope, storeId: string): Promise<number>;
  /**
   * Issue #25: the DSR worker's "suppress first" primitive (privacy-dpdp.md §4.4 step 2) — add
   * *before* any ClickHouse/Postgres delete runs, so a job that dies partway through still leaves the
   * identity suppressed. Idempotent on the existing `(storeId, identifierType, identifier, reason)`
   * unique index: a retried job's repeat call is a no-op, returning the existing row's id.
   */
  add(
    scope: Scope,
    storeId: string,
    input: AddSuppressionInput,
  ): Promise<{ readonly id: string; readonly created: boolean }>;
}

/** The only sanctioned way to read/write `suppressed_identities` (ADR-0016). */
export function createSuppressedIdentityRepository(db: Db): SuppressedIdentityRepository {
  return {
    async countByStore(scope, storeId) {
      assertStoreInScope(scope, storeId);
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(suppressedIdentities)
        .where(eq(suppressedIdentities.storeId, storeId));
      return row?.n ?? 0;
    },

    async add(scope, storeId, input) {
      assertStoreInScope(scope, storeId);
      const inserted = await db
        .insert(suppressedIdentities)
        .values({
          storeId,
          identifierType: input.identifierType,
          identifier: input.identifier,
          reason: input.reason,
          dsrRequestId: input.dsrRequestId ?? null,
          expiresAt: input.expiresAt,
        })
        .onConflictDoNothing()
        .returning({ id: suppressedIdentities.id });
      const created = inserted[0];
      if (created) return { id: created.id, created: true };

      const [existing] = await db
        .select({ id: suppressedIdentities.id })
        .from(suppressedIdentities)
        .where(
          and(
            eq(suppressedIdentities.storeId, storeId),
            eq(suppressedIdentities.identifierType, input.identifierType),
            eq(suppressedIdentities.identifier, input.identifier),
            eq(suppressedIdentities.reason, input.reason),
          ),
        )
        .limit(1);
      if (!existing) throw new Error('add: conflicted but no row was found');
      return { id: existing.id, created: false };
    },
  };
}
