import type { TenantScope } from '@truepath/shared';

/**
 * Builds a `TenantScope` for a background/webhook action on one store, with no signed-in user
 * (auth.ts's `role: 'job'`: `can()` treats it as authorized by construction, and the repository
 * layer's normal `assertStoreInScope`/`assertOrganizationInScope` checks still apply — this is not
 * a SystemScope bypass, just a scope with no human role to check permissions against). The Shopify
 * webhook route uses this after resolving the store from a verified shop domain
 * (`resolveStoreByShopDomain`), since a webhook is authenticated by HMAC, not a session.
 */
export function jobScope(organizationId: string, storeId: string): TenantScope {
  return {
    kind: 'tenant',
    userId: null,
    organizationId,
    role: 'job',
    storeIds: new Set([storeId]),
  };
}
