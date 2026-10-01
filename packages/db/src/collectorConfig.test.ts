import { randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestCredentialsCipher } from '@truepath/privacy/testing';
import type { TenantScope } from '@truepath/shared';
import {
  deleteCollectorConfig,
  publishCollectorConfig,
  type CollectorConfigSink,
} from './collectorConfig.js';
import { createDpaAcceptanceRepository } from './repositories/dpaAcceptanceRepository.js';
import { createIntegrationRepository } from './repositories/integrationRepository.js';
import { createOrganizationRepository } from './repositories/organizationRepository.js';
import {
  cleanupTestTenant,
  confirmIndiaOptIn,
  db,
  seedTestTenant,
  type TestTenant,
} from './testing.js';

// publishCollectorConfig (HLD §8; issue #8): `active` requires the org's DPA accepted, India opt-in
// confirmed, AND (since #8) the organization not `pending_deletion`. A sink that just records calls —
// no real Redis needed to test the config it builds.

const cipher = createTestCredentialsCipher();
const DPA_VERSION = 'v1';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const newStoreKey = (): string =>
  'pk_' + Array.from({ length: 24 }, () => BASE62[randomInt(BASE62.length)]).join('');

function jobScope(organizationId: string, storeId: string): TenantScope {
  return {
    kind: 'tenant',
    userId: null,
    organizationId,
    role: 'job',
    storeIds: new Set([storeId]),
  };
}

function recordingSink(): CollectorConfigSink & { readonly calls: Map<string, string> } {
  const calls = new Map<string, string>();
  return {
    calls,
    async set(key, value) {
      calls.set(key, value);
    },
  };
}

async function seedFullyGatedStore(
  label: string,
): Promise<{ tenant: TestTenant; storeKey: string }> {
  const tenant = await seedTestTenant(label);
  const scope = jobScope(tenant.organizationId, tenant.storeId);
  const storeKey = newStoreKey();
  const repo = createIntegrationRepository(db);
  await repo.upsertShopify(scope, {
    storeId: tenant.storeId,
    externalAccountId: 'gid://shopify/Shop/1',
    credentialsJson: JSON.stringify({
      accessToken: 'shpat_test',
      pixelSigningKeys: [{ kid: 's1', secret: 's'.repeat(40) }],
    }),
    scopes: ['read_orders'],
    cipher,
  });
  await repo.patchShopifySettings(scope, tenant.storeId, { store_key: storeKey });

  const owner: TenantScope = {
    kind: 'tenant',
    userId: tenant.userId,
    organizationId: tenant.organizationId,
    role: 'owner',
    storeIds: new Set([tenant.storeId]),
  };
  await createDpaAcceptanceRepository(db).record(owner, {
    organizationId: tenant.organizationId,
    dpaVersion: DPA_VERSION,
    acceptedByUserId: tenant.userId,
    ipTruncated: null,
  });
  await confirmIndiaOptIn(tenant.storeId);
  return { tenant, storeKey };
}

describe('publishCollectorConfig — organization status (issue #8)', () => {
  it('is active when every gate (DPA, opt-in, org active) is met', async () => {
    const { tenant, storeKey } = await seedFullyGatedStore('collector-config-active');
    try {
      const sink = recordingSink();
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      const config = await publishCollectorConfig(
        { db, cipher, sink, dpaVersion: DPA_VERSION },
        scope,
        tenant.storeId,
      );
      expect(config).toMatchObject({ status: 'active', inactiveReason: null });
      expect(sink.calls.has(`collector:store:${storeKey}`)).toBe(true);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('becomes inactive with org_deletion once the organization is pending_deletion, even with every other gate met', async () => {
    const { tenant, storeKey } = await seedFullyGatedStore('collector-config-org-deletion');
    try {
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      await createOrganizationRepository(db).requestDeletion(scope, tenant.organizationId, {
        now: new Date(),
      });

      const sink = recordingSink();
      const config = await publishCollectorConfig(
        { db, cipher, sink, dpaVersion: DPA_VERSION },
        scope,
        tenant.storeId,
      );
      expect(config).toMatchObject({ status: 'inactive', inactiveReason: 'org_deletion' });
      const written = JSON.parse(sink.calls.get(`collector:store:${storeKey}`)!) as {
        status: string;
        inactiveReason: string;
      };
      expect(written).toMatchObject({ status: 'inactive', inactiveReason: 'org_deletion' });
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('reports org_deletion rather than dpa_missing when both are true (deletion checked first)', async () => {
    const tenant = await seedTestTenant('collector-config-org-deletion-priority');
    try {
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      const storeKey = newStoreKey();
      const repo = createIntegrationRepository(db);
      await repo.upsertShopify(scope, {
        storeId: tenant.storeId,
        externalAccountId: 'gid://shopify/Shop/1',
        credentialsJson: JSON.stringify({
          accessToken: 'shpat_test',
          pixelSigningKeys: [{ kid: 's1', secret: 's'.repeat(40) }],
        }),
        scopes: ['read_orders'],
        cipher,
      });
      await repo.patchShopifySettings(scope, tenant.storeId, { store_key: storeKey });
      // Deliberately no DPA acceptance and no India opt-in confirmation.
      await createOrganizationRepository(db).requestDeletion(scope, tenant.organizationId, {
        now: new Date(),
      });

      const sink = recordingSink();
      const config = await publishCollectorConfig(
        { db, cipher, sink, dpaVersion: DPA_VERSION },
        scope,
        tenant.storeId,
      );
      expect(config?.inactiveReason).toBe('org_deletion');
    } finally {
      await cleanupTestTenant(tenant);
    }
  });

  it('goes back to active once deletion is cancelled', async () => {
    const { tenant, storeKey } = await seedFullyGatedStore(
      'collector-config-org-deletion-cancelled',
    );
    try {
      const scope = jobScope(tenant.organizationId, tenant.storeId);
      const orgs = createOrganizationRepository(db);
      const now = new Date();
      await orgs.requestDeletion(scope, tenant.organizationId, { now });
      await orgs.cancelDeletion(scope, tenant.organizationId, { now });

      const sink = recordingSink();
      const config = await publishCollectorConfig(
        { db, cipher, sink, dpaVersion: DPA_VERSION },
        scope,
        tenant.storeId,
      );
      expect(config).toMatchObject({ status: 'active', inactiveReason: null });
      expect(sink.calls.has(`collector:store:${storeKey}`)).toBe(true);
    } finally {
      await cleanupTestTenant(tenant);
    }
  });
});

describe('deleteCollectorConfig (issue #44/#25)', () => {
  it('deletes the key for the store_key carried in settings', async () => {
    const deleted: string[] = [];
    const sink = { del: async (key: string) => void deleted.push(key) };
    await deleteCollectorConfig(sink, { store_key: 'pk_' + '0'.repeat(24) });
    expect(deleted).toEqual([`collector:store:pk_${'0'.repeat(24)}`]);
  });

  it('is a no-op when settings carries no store_key', async () => {
    const deleted: string[] = [];
    const sink = { del: async (key: string) => void deleted.push(key) };
    await deleteCollectorConfig(sink, {});
    await deleteCollectorConfig(sink, null);
    await deleteCollectorConfig(sink, { store_key: 'not-a-valid-pattern' });
    expect(deleted).toEqual([]);
  });
});
