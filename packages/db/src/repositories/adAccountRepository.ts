import { and, eq } from 'drizzle-orm';
import { assertStoreInScope, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { adAccounts } from '../schema/index.js';

export type AdAccountRow = typeof adAccounts.$inferSelect;

export interface UpsertAdAccountInput {
  readonly storeId: string;
  readonly provider: 'meta' | 'google_ads';
  readonly externalId: string;
  readonly name: string;
  readonly currency: string;
  readonly timezone: string;
}

export interface AdAccountRepository {
  upsert(scope: Scope, input: UpsertAdAccountInput): Promise<AdAccountRow>;
  listByStore(scope: Scope, storeId: string, provider: string): Promise<AdAccountRow[]>;
}

/** The only sanctioned way to read/write `ad_accounts` (ADR-0016). */
export function createAdAccountRepository(db: Db): AdAccountRepository {
  return {
    async upsert(scope, input) {
      assertStoreInScope(scope, input.storeId);
      const [row] = await db
        .insert(adAccounts)
        .values(input)
        .onConflictDoUpdate({
          target: [adAccounts.storeId, adAccounts.provider, adAccounts.externalId],
          set: { name: input.name, currency: input.currency, timezone: input.timezone },
        })
        .returning();
      if (!row) throw new Error('upsert: insert/update did not return a row');
      return row;
    },

    async listByStore(scope, storeId, provider) {
      assertStoreInScope(scope, storeId);
      return db
        .select()
        .from(adAccounts)
        .where(and(eq(adAccounts.storeId, storeId), eq(adAccounts.provider, provider)));
    },
  };
}
