import { and, eq, ne } from 'drizzle-orm';
import { assertOrganizationInScope, assertStoreInScope, type Scope } from '@truepath/shared';
import type { Db } from '../client.js';
import { stores } from '../schema/index.js';

export type StoreRow = typeof stores.$inferSelect;

export interface UpsertStoreByShopDomainInput {
  readonly organizationId: string;
  readonly shopDomain: string;
  readonly currency?: string;
}

/**
 * Thrown when `shopDomain` already belongs to a different organization (shopify-integration.md
 * §4.1 step 4: "A shop linked to another org → `409 shop_linked_elsewhere`"). Never carries the
 * other organization's id — routes turn this into a bare 409, not a resource-existence disclosure.
 */
export class ShopLinkedToAnotherOrganizationError extends Error {
  constructor(shopDomain: string) {
    super(`${shopDomain} is already connected to another organization`);
    this.name = 'ShopLinkedToAnotherOrganizationError';
  }
}

export interface StoreRepository {
  listByOrganization(scope: Scope, organizationId: string): Promise<StoreRow[]>;
  getById(scope: Scope, storeId: string): Promise<StoreRow | null>;
  /**
   * Creates the store on first connect, or reactivates it on a re-auth for the same org
   * (shopify-integration.md §4.1 step 4). Throws {@link ShopLinkedToAnotherOrganizationError} if the
   * shop domain is already owned by a different organization.
   */
  upsertByShopDomain(scope: Scope, input: UpsertStoreByShopDomainInput): Promise<StoreRow>;
  /** `app/uninstalled` webhook (shopify-integration.md §4.8). Idempotent: returns null if already uninstalled. */
  markUninstalled(scope: Scope, storeId: string): Promise<StoreRow | null>;
}

/** The only sanctioned way to read/write `stores` (ADR-0016) — every method requires a Scope. */
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
    async upsertByShopDomain(scope, input) {
      assertOrganizationInScope(scope, input.organizationId);
      return db.transaction(async (tx) => {
        const existingRows = await tx
          .select()
          .from(stores)
          .where(eq(stores.shopDomain, input.shopDomain))
          .limit(1);
        const existing = existingRows[0];

        if (existing) {
          if (existing.organizationId !== input.organizationId) {
            throw new ShopLinkedToAnotherOrganizationError(input.shopDomain);
          }
          const [updated] = await tx
            .update(stores)
            .set({
              status: 'active',
              currency: input.currency ?? existing.currency,
              installedAt: existing.installedAt ?? new Date(),
            })
            .where(eq(stores.id, existing.id))
            .returning();
          if (!updated) throw new Error('upsertByShopDomain: update did not return a row');
          return updated;
        }

        const [inserted] = await tx
          .insert(stores)
          .values({
            organizationId: input.organizationId,
            shopDomain: input.shopDomain,
            currency: input.currency ?? 'INR',
            installedAt: new Date(),
            status: 'active',
          })
          .returning();
        if (!inserted) throw new Error('upsertByShopDomain: insert did not return a row');
        return inserted;
      });
    },
    async markUninstalled(scope, storeId) {
      assertStoreInScope(scope, storeId);
      // The `status != 'uninstalled'` guard makes a retried webhook a genuine no-op (returns null)
      // rather than re-writing an already-uninstalled row — Shopify retries this webhook up to 8x/4h.
      const rows = await db
        .update(stores)
        .set({ status: 'uninstalled' })
        .where(and(eq(stores.id, storeId), ne(stores.status, 'uninstalled')))
        .returning();
      return rows[0] ?? null;
    },
  };
}
