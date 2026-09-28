import { assertStoreInScope, type Scope, type TenantScope } from './auth.js';

// Tenant-prefixed Redis keys and S3 paths (HLD §8, ADR-0016 "Keys and paths"). These are the only
// sanctioned way to build a store-scoped key/path: every helper takes the caller's Scope and
// asserts it actually covers `storeId` before building the string, so a key can never be built
// from a bare, unchecked id.

/**
 * The scope the Collector builds for a request, from the store its verified config names. The
 * Collector has no Postgres connection, so it holds no organization id: the scope covers exactly one
 * store and is only meaningful to the key builders below. Its `organizationId` is empty, so any
 * organization assertion against it fails closed rather than matching a real one.
 */
export function storeBoundScope(storeId: string): TenantScope {
  return {
    kind: 'tenant',
    userId: null,
    organizationId: '',
    role: 'job',
    storeIds: new Set([storeId]),
  };
}

export function reportCacheKey(
  scope: Scope,
  storeId: string,
  endpoint: string,
  paramsHash: string,
): string {
  assertStoreInScope(scope, storeId);
  return `report:${storeId}:${endpoint}:${paramsHash}`;
}

export function dsrExportKey(scope: Scope, storeId: string, requestId: string): string {
  assertStoreInScope(scope, storeId);
  return `dsr-exports/${storeId}/${requestId}.json`;
}

export function dedupeKey(scope: Scope, storeId: string, eventId: string): string {
  assertStoreInScope(scope, storeId);
  return `dedupe:${storeId}:${eventId}`;
}

export const SUPPRESSION_SET_KINDS = [
  'erased:visitor',
  'erased:identity',
  'withdrawn:visitor',
] as const;
export type SuppressionSetKind = (typeof SUPPRESSION_SET_KINDS)[number];

export function suppressionSetKey(scope: Scope, storeId: string, kind: SuppressionSetKind): string {
  assertStoreInScope(scope, storeId);
  return `suppress:${storeId}:${kind}`;
}

export function sessionKey(scope: Scope, storeId: string, visitorId: string): string {
  assertStoreInScope(scope, storeId);
  return `session:${storeId}:${visitorId}`;
}

export function checkoutKey(scope: Scope, storeId: string, orderId: string): string {
  assertStoreInScope(scope, storeId);
  return `checkout:${storeId}:${orderId}`;
}

export function statsCollectorKey(scope: Scope, storeId: string, yyyymmdd: string): string {
  assertStoreInScope(scope, storeId);
  return `stats:collector:${storeId}:${yyyymmdd}`;
}
