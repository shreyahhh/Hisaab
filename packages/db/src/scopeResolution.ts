import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { stores } from './schema/index.js';

/**
 * Resolves which organization a store belongs to, given only the store's id — no scope. This is
 * the one bootstrap primitive outside the scoped repository layer (ADR-0016): the Fastify
 * tenant-scope preHandler needs it to build a TenantScope for a `:storeId` route
 * (auth-tenancy.md §4.3 step 2) *before* any membership/authorization check can run — there is no
 * scope yet at that point for a repository method to require. It returns nothing but an id
 * mapping, never business data, and its only sanctioned caller is that preHandler.
 */
export async function resolveStoreOrganization(db: Db, storeId: string): Promise<string | null> {
  const rows = await db
    .select({ organizationId: stores.organizationId })
    .from(stores)
    .where(eq(stores.id, storeId))
    .limit(1);
  return rows[0]?.organizationId ?? null;
}

export interface ResolvedStore {
  readonly id: string;
  readonly organizationId: string;
}

/**
 * Resolves a store by its (verified) Shopify shop domain — no scope. The second bootstrap primitive
 * outside the scoped repository layer (ADR-0016): a Shopify webhook authenticates by HMAC signature
 * plus `X-Shopify-Shop-Domain`, never a session, so there is no TenantScope yet when the handler
 * needs to know which store the payload belongs to. Its only sanctioned caller is the Shopify
 * webhook route (eslint.config.js). Returns nothing but an id mapping, never business data.
 */
export async function resolveStoreByShopDomain(
  db: Db,
  shopDomain: string,
): Promise<ResolvedStore | null> {
  const rows = await db
    .select({ id: stores.id, organizationId: stores.organizationId })
    .from(stores)
    .where(eq(stores.shopDomain, shopDomain))
    .limit(1);
  return rows[0] ?? null;
}
