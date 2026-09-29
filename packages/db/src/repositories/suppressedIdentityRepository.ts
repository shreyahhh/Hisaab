import { eq, sql } from 'drizzle-orm';
import { assertStoreInScope, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { suppressedIdentities } from '../schema/index.js';

export interface SuppressedIdentityRepository {
  /** How many identities are currently suppressed for the store (erasure + withdrawal) — Privacy page. */
  countByStore(scope: Scope, storeId: string): Promise<number>;
}

/** The only sanctioned way to read `suppressed_identities` (ADR-0016). */
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
  };
}
