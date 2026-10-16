import type { SystemScope, TenantScope } from '@truepath/shared';
import { describe, expect, it } from 'vitest';
import { createTestCredentialsCipher } from '@truepath/privacy/testing';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '../testing.js';
import { createAdAccountRepository } from './adAccountRepository.js';
import { createIntegrationRepository } from './integrationRepository.js';
import { createMetaWarmupSchedulingRepository } from './metaWarmupSchedulingRepository.js';
import { SystemScopeRequiredError } from './suppressionRebuildRepository.js';

const repo = createMetaWarmupSchedulingRepository(db);
const system: SystemScope = { kind: 'system', reason: 'suppression_rebuild', auditId: 'test' };
const cipher = createTestCredentialsCipher();

function jobScope(t: TestTenant): TenantScope {
  return {
    kind: 'tenant',
    userId: null,
    organizationId: t.organizationId,
    role: 'job',
    storeIds: new Set([t.storeId]),
  };
}

async function registerWarmup(t: TestTenant, accountId: string): Promise<void> {
  const scope = jobScope(t);
  await createIntegrationRepository(db).upsertMeta(scope, {
    storeId: t.storeId,
    externalAccountId: `biz_${t.storeId}`,
    credentialsJson: '{}',
    scopes: [],
    cipher,
  });
  await createAdAccountRepository(db).upsert(scope, {
    storeId: t.storeId,
    provider: 'meta',
    externalId: accountId,
    name: 'x',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
  });
}

describe('MetaWarmupSchedulingRepository.listWarmupStores', () => {
  it('lists a store with both an active Meta integration and a registered ad account', async () => {
    const t = await seedTestTenant('warmup-sched-full');
    try {
      await registerWarmup(t, 'act_1');
      const rows = (await repo.listWarmupStores(system)).filter((r) => r.storeId === t.storeId);
      expect(rows).toEqual([{ storeId: t.storeId, organizationId: t.organizationId }]);
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('lists a store only once even when it has several registered ad accounts', async () => {
    const t = await seedTestTenant('warmup-sched-multi');
    try {
      await registerWarmup(t, 'act_1');
      await createAdAccountRepository(db).upsert(jobScope(t), {
        storeId: t.storeId,
        provider: 'meta',
        externalId: 'act_2',
        name: 'y',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
      });
      const rows = (await repo.listWarmupStores(system)).filter((r) => r.storeId === t.storeId);
      expect(rows).toEqual([{ storeId: t.storeId, organizationId: t.organizationId }]);
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('leaves out a store with an integration but no registered ad account', async () => {
    const t = await seedTestTenant('warmup-sched-no-account');
    try {
      await createIntegrationRepository(db).upsertMeta(jobScope(t), {
        storeId: t.storeId,
        externalAccountId: 'biz_x',
        credentialsJson: '{}',
        scopes: [],
        cipher,
      });
      const rows = (await repo.listWarmupStores(system)).filter((r) => r.storeId === t.storeId);
      expect(rows).toEqual([]);
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('leaves out a store whose only registered ad account is for a different provider', async () => {
    const t = await seedTestTenant('warmup-sched-wrong-provider');
    try {
      await createIntegrationRepository(db).upsertMeta(jobScope(t), {
        storeId: t.storeId,
        externalAccountId: 'biz_x',
        credentialsJson: '{}',
        scopes: [],
        cipher,
      });
      await createAdAccountRepository(db).upsert(jobScope(t), {
        storeId: t.storeId,
        provider: 'google_ads',
        externalId: 'acct_google',
        name: 'y',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
      });
      const rows = (await repo.listWarmupStores(system)).filter((r) => r.storeId === t.storeId);
      expect(rows).toEqual([]);
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('leaves out a revoked integration', async () => {
    const t = await seedTestTenant('warmup-sched-revoked');
    try {
      const scope = jobScope(t);
      await registerWarmup(t, 'act_1');
      const integration = await createIntegrationRepository(db).getActiveByStore(
        scope,
        t.storeId,
        'meta',
      );
      await createIntegrationRepository(db).revokeForOrganization(
        scope,
        t.organizationId,
        integration!.id,
      );

      const rows = (await repo.listWarmupStores(system)).filter((r) => r.storeId === t.storeId);
      expect(rows).toEqual([]);
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('refuses a TenantScope — listing across stores needs an audited SystemScope (ADR-0016)', async () => {
    const t = await seedTestTenant('warmup-sched-scope');
    try {
      await expect(repo.listWarmupStores(jobScope(t))).rejects.toThrow(SystemScopeRequiredError);
    } finally {
      await cleanupTestTenant(t);
    }
  });
});

describe('MetaWarmupSchedulingRepository.listWarmupStates (issue #63)', () => {
  it('reports null warmup for a store with an active integration but no run yet', async () => {
    const t = await seedTestTenant('warmup-state-none');
    try {
      await createIntegrationRepository(db).upsertMeta(jobScope(t), {
        storeId: t.storeId,
        externalAccountId: 'biz_x',
        credentialsJson: '{}',
        scopes: [],
        cipher,
      });
      const rows = (await repo.listWarmupStates(system)).filter((r) => r.storeId === t.storeId);
      expect(rows).toEqual([
        { storeId: t.storeId, organizationId: t.organizationId, warmup: null },
      ]);
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('reports the ledger once patchMetaWarmupState has run, with no registered ad account required', async () => {
    const t = await seedTestTenant('warmup-state-ledger');
    try {
      const scope = jobScope(t);
      await createIntegrationRepository(db).upsertMeta(scope, {
        storeId: t.storeId,
        externalAccountId: 'biz_x',
        credentialsJson: '{}',
        scopes: [],
        cipher,
      });
      await createIntegrationRepository(db).patchMetaWarmupState(scope, t.storeId, {
        calls_total: 10,
        calls_success: 9,
        calls_error: 1,
        last_run_at: '2026-10-16T00:00:00.000Z',
      });
      const rows = (await repo.listWarmupStates(system)).filter((r) => r.storeId === t.storeId);
      expect(rows).toEqual([
        {
          storeId: t.storeId,
          organizationId: t.organizationId,
          warmup: {
            calls_total: 10,
            calls_success: 9,
            calls_error: 1,
            last_run_at: '2026-10-16T00:00:00.000Z',
          },
        },
      ]);
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('leaves out a revoked integration', async () => {
    const t = await seedTestTenant('warmup-state-revoked');
    try {
      const scope = jobScope(t);
      const integration = await createIntegrationRepository(db).upsertMeta(scope, {
        storeId: t.storeId,
        externalAccountId: 'biz_x',
        credentialsJson: '{}',
        scopes: [],
        cipher,
      });
      await createIntegrationRepository(db).revokeForOrganization(
        scope,
        t.organizationId,
        integration.id,
      );
      const rows = (await repo.listWarmupStates(system)).filter((r) => r.storeId === t.storeId);
      expect(rows).toEqual([]);
    } finally {
      await cleanupTestTenant(t);
    }
  });

  it('refuses a TenantScope — listing across stores needs an audited SystemScope (ADR-0016)', async () => {
    const t = await seedTestTenant('warmup-state-scope');
    try {
      await expect(repo.listWarmupStates(jobScope(t))).rejects.toThrow(SystemScopeRequiredError);
    } finally {
      await cleanupTestTenant(t);
    }
  });
});
