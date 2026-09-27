import type { TenantScope } from '@truepath/shared';
import { describe, expect, it } from 'vitest';
import { createDsrRequestRepository } from './dsrRequestRepository.js';
import { cleanupTestTenant, db, seedTestTenant } from '../testing.js';

function jobScope(organizationId: string, storeId: string): TenantScope {
  return {
    kind: 'tenant',
    userId: null,
    organizationId,
    role: 'job',
    storeIds: new Set([storeId]),
  };
}

describe('DsrRequestRepository (shopify-integration.md §4.3)', () => {
  it('creates a receipt row for a compliance webhook', async () => {
    const tenant = await seedTestTenant('dsr-repo');
    try {
      const repo = createDsrRequestRepository(db);
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      const { row, created } = await repo.createFromWebhook(scope, {
        storeId: tenant.storeId,
        type: 'erasure',
        identityHash: 'k1:' + 'a'.repeat(64),
        dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        sourceRef: 'webhook-id-1',
      });
      expect(created).toBe(true);
      expect(row.type).toBe('erasure');
      expect(row.status).toBe('pending');
      expect((row.resultSummary as Record<string, unknown>).trigger).toBe('shopify_webhook');
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('allows a null identity_hash for store_erasure (shop/redact has no shopper identity)', async () => {
    const tenant = await seedTestTenant('dsr-repo-store-erasure');
    try {
      const repo = createDsrRequestRepository(db);
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      const { row } = await repo.createFromWebhook(scope, {
        storeId: tenant.storeId,
        type: 'store_erasure',
        identityHash: null,
        dueAt: new Date(),
        sourceRef: 'webhook-id-2',
      });
      expect(row.identityHash).toBeNull();
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('is idempotent: a retried webhook with the same source_ref does not create a second row', async () => {
    const tenant = await seedTestTenant('dsr-repo-dedupe');
    try {
      const repo = createDsrRequestRepository(db);
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      const input = {
        storeId: tenant.storeId,
        type: 'access' as const,
        identityHash: 'k1:' + 'b'.repeat(64),
        dueAt: new Date(),
        sourceRef: 'webhook-id-3',
      };
      const first = await repo.createFromWebhook(scope, input);
      const retry = await repo.createFromWebhook(scope, input);

      expect(first.created).toBe(true);
      expect(retry.created).toBe(false);
      expect(retry.row.id).toBe(first.row.id);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('the same source_ref in a different store does not collide (dedupe is per-store)', async () => {
    const tenantA = await seedTestTenant('dsr-repo-a');
    const tenantB = await seedTestTenant('dsr-repo-b');
    try {
      const repo = createDsrRequestRepository(db);
      const sharedRef = 'shared-webhook-id';
      const a = await repo.createFromWebhook(jobScope(tenantA.organizationId, tenantA.storeId), {
        storeId: tenantA.storeId,
        type: 'access',
        identityHash: null,
        dueAt: new Date(),
        sourceRef: sharedRef,
      });
      const b = await repo.createFromWebhook(jobScope(tenantB.organizationId, tenantB.storeId), {
        storeId: tenantB.storeId,
        type: 'access',
        identityHash: null,
        dueAt: new Date(),
        sourceRef: sharedRef,
      });
      expect(a.created).toBe(true);
      expect(b.created).toBe(true);
      expect(a.row.id).not.toBe(b.row.id);
    } finally {
      await cleanupTestTenant(tenantA);
      await cleanupTestTenant(tenantB);
    }
  });
});
