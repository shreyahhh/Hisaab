import { eq } from 'drizzle-orm';
import { assertOrganizationInScope, assertStoreInScope, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { stores } from '../schema/index.js';

export type StoreRow = typeof stores.$inferSelect;

export interface StoreRepository {
  listByOrganization(scope: Scope, organizationId: string): Promise<StoreRow[]>;
  getById(scope: Scope, storeId: string): Promise<StoreRow | null>;
}

/** The only sanctioned way to read `stores` (ADR-0016) — every method requires a Scope. */
export function createStoreRepository(db: Db): StoreRepository {
  return {
    async listByOrganization(scope, organizationId) {
      assertOrganizationInScope(scope, organizationId);
      return db.select().from(stores).where(eq(stores.organizationId, organizationId));
    },
    async getById(scope, storeId) {
      assertStoreInScope(scope, storeId);
      const rows = await db.select().from(stores).where(eq(stores.id, storeId)).limit(1);
      return rows[0] ?? null;
    },
  };
}
