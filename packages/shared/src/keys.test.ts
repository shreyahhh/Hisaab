import { describe, expect, it } from 'vitest';
import { TenantScopeViolationError, type SystemScope, type TenantScope } from './auth.js';
import {
  checkoutKey,
  dedupeKey,
  dsrExportKey,
  reportCacheKey,
  sessionKey,
  statsCollectorKey,
  suppressionSetKey,
} from './keys.js';

const scope: TenantScope = {
  kind: 'tenant',
  userId: 'user-a',
  organizationId: 'org-a',
  role: 'owner',
  storeIds: new Set(['store-a']),
};

const systemScope: SystemScope = { kind: 'system', reason: 'retention', auditId: 'audit-1' };

describe('tenant-prefixed key/path helpers (HLD §8, ADR-0016)', () => {
  it('builds every key/path store_id-prefixed exactly as HLD §8 names them', () => {
    expect(reportCacheKey(scope, 'store-a', 'overview', 'hash1')).toBe(
      'report:store-a:overview:hash1',
    );
    expect(dsrExportKey(scope, 'store-a', 'req-1')).toBe('dsr-exports/store-a/req-1.json');
    expect(dedupeKey(scope, 'store-a', 'evt-1')).toBe('dedupe:store-a:evt-1');
    expect(suppressionSetKey(scope, 'store-a', 'erased:visitor')).toBe(
      'suppress:store-a:erased:visitor',
    );
    expect(sessionKey(scope, 'store-a', 'visitor-1')).toBe('session:store-a:visitor-1');
    expect(checkoutKey(scope, 'store-a', 'order-1')).toBe('checkout:store-a:order-1');
    expect(statsCollectorKey(scope, 'store-a', '20260925')).toBe(
      'stats:collector:store-a:20260925',
    );
  });

  it('refuses to build a key for a store outside the caller scope', () => {
    expect(() => reportCacheKey(scope, 'store-b', 'overview', 'hash1')).toThrow(
      TenantScopeViolationError,
    );
    expect(() => dsrExportKey(scope, 'store-b', 'req-1')).toThrow(TenantScopeViolationError);
  });

  it('allows a SystemScope to build a key for any store (audited at scope creation)', () => {
    expect(() => reportCacheKey(systemScope, 'store-anything', 'overview', 'h')).not.toThrow();
  });
});
