import { randomUUID } from 'node:crypto';
import type { SystemScope, TenantScope } from '@truepath/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestCredentialsCipher } from '@truepath/privacy/testing';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '../testing.js';
import { jobScope } from '../jobScope.js';
import { createCollectorConfigRepository } from './collectorConfigRepository.js';
import { createIntegrationRepository } from './integrationRepository.js';
import { SystemScopeRequiredError } from './suppressionRebuildRepository.js';

const repo = createCollectorConfigRepository(db);
const system: SystemScope = { kind: 'system', reason: 'suppression_rebuild', auditId: 'test' };
const cipher = createTestCredentialsCipher();

let connected: TestTenant;
let disconnected: TestTenant;
let never: TestTenant;

async function connect(t: TestTenant): Promise<void> {
  await createIntegrationRepository(db).upsertShopify(jobScope(t.organizationId, t.storeId), {
    storeId: t.storeId,
    externalAccountId: 'gid://shopify/Shop/1',
    credentialsJson: '{}',
    scopes: [],
    cipher,
  });
}

beforeAll(async () => {
  connected = await seedTestTenant('cfg-repo-connected');
  disconnected = await seedTestTenant('cfg-repo-disconnected');
  never = await seedTestTenant('cfg-repo-never');
  await connect(connected);
  await connect(disconnected);
  await createIntegrationRepository(db).markUninstalled(
    jobScope(disconnected.organizationId, disconnected.storeId),
    disconnected.storeId,
  );
});

afterAll(async () => {
  for (const t of [connected, disconnected, never]) await cleanupTestTenant(t);
});

describe('CollectorConfigRepository.listActiveShopifyStores', () => {
  const all = () => [connected.storeId, disconnected.storeId, never.storeId];

  it('lists only stores with an active Shopify integration, with their organization', async () => {
    const rows = await repo.listActiveShopifyStores(system, { storeIds: all() });
    expect(rows).toEqual([
      { storeId: connected.storeId, organizationId: connected.organizationId },
    ]);
  });

  it('honours the store filter, and an empty filter lists nothing', async () => {
    expect(await repo.listActiveShopifyStores(system, { storeIds: [never.storeId] })).toEqual([]);
    expect(await repo.listActiveShopifyStores(system, { storeIds: [] })).toEqual([]);
    expect(await repo.listActiveShopifyStores(system, { storeIds: [randomUUID()] })).toEqual([]);
  });

  it('without a filter it includes every active store', async () => {
    const rows = await repo.listActiveShopifyStores(system);
    expect(rows.map((r) => r.storeId)).toContain(connected.storeId);
    expect(rows.map((r) => r.storeId)).not.toContain(disconnected.storeId);
  });

  it('refuses a TenantScope — listing across stores needs an audited SystemScope (ADR-0016)', async () => {
    const tenant: TenantScope = {
      kind: 'tenant',
      userId: connected.userId,
      organizationId: connected.organizationId,
      role: 'owner',
      storeIds: new Set([connected.storeId]),
    };
    await expect(repo.listActiveShopifyStores(tenant)).rejects.toThrow(SystemScopeRequiredError);
  });
});
