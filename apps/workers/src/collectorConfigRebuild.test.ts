import { randomInt, randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDpaAcceptanceRepository,
  createIntegrationRepository,
  jobScope,
  schema,
} from '@truepath/db';
import {
  cleanupTestTenant,
  confirmIndiaOptIn,
  db,
  seedTestTenant,
  type TestTenant,
} from '@truepath/db/testing';
import { createTestCredentialsCipher } from '@truepath/privacy/testing';
import {
  CollectorStoreConfig,
  STORE_KEY_PATTERN,
  collectorStoreKey,
  type TenantScope,
} from '@truepath/shared';
import { rebuildSuppression } from './suppressionRebuild.js';

// #56: the suppression rebuild also republishes every store's `collector:store:<store_key>` config, so the
// Collector accepts pixels again after durable Redis was lost. Real Postgres and Redis; the readiness
// marker is isolated per run and every rebuild is limited to the stores seeded here.

const redis = new Redis('redis://localhost:6379', {
  maxRetriesPerRequest: 1,
  connectTimeout: 1000,
});
const readyKey = `test:${randomUUID()}:suppress:ready`;
const cipher = createTestCredentialsCipher();
const otherCipher = createTestCredentialsCipher(); // different keys: what it seals, `cipher` can't open
const DPA_VERSION = 'v1';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const newStoreKey = (): string =>
  'pk_' + Array.from({ length: 24 }, () => BASE62[randomInt(BASE62.length)]).join('');
const startedAt = new Date();

interface Seeded {
  readonly tenant: TestTenant;
  readonly storeKey: string;
  readonly secret: string;
}
const tenants: TestTenant[] = [];

async function seedStore(
  label: string,
  o: { dpa?: boolean; optIn?: boolean; sealWith?: typeof cipher; connected?: boolean } = {},
): Promise<Seeded> {
  const tenant = await seedTestTenant(label);
  tenants.push(tenant);
  const scope = jobScope(tenant.organizationId, tenant.storeId);
  const storeKey = newStoreKey();
  const secret = 's'.repeat(40);
  if (o.connected !== false) {
    const repo = createIntegrationRepository(db);
    await repo.upsertShopify(scope, {
      storeId: tenant.storeId,
      externalAccountId: 'gid://shopify/Shop/1',
      credentialsJson: JSON.stringify({
        accessToken: 'shpat_test',
        pixelSigningKeys: [{ kid: 's1', secret }],
      }),
      scopes: ['read_orders'],
      cipher: o.sealWith ?? cipher,
    });
    await repo.patchShopifySettings(scope, tenant.storeId, { store_key: storeKey });
  }
  if (o.dpa !== false) {
    // A DPA is accepted by the signed-in owner, in their own scope (not a job scope).
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
  }
  if (o.optIn !== false) await confirmIndiaOptIn(tenant.storeId);
  return { tenant, storeKey, secret };
}

const configOf = async (s: Seeded) => {
  const raw = await redis.get(collectorStoreKey(s.storeKey));
  return raw === null ? null : CollectorStoreConfig.parse(JSON.parse(raw));
};

const rebuild = (stores: Seeded[], over: Record<string, unknown> = {}) =>
  rebuildSuppression({
    db,
    redis,
    readyKey,
    storeIds: stores.map((s) => s.tenant.storeId),
    configs: { cipher, dpaVersion: DPA_VERSION },
    ...over,
  });

beforeAll(() => {
  expect(newStoreKey()).toMatch(STORE_KEY_PATTERN);
});

afterAll(async () => {
  await redis.del(readyKey);
  for (const t of tenants) {
    const keys = await redis.keys(`*${t.storeId}*`);
    if (keys.length > 0) await redis.del(...keys);
  }
  for (const t of tenants) await cleanupTestTenant(t);
  redis.disconnect();
});

describe('rebuildSuppression — republishing collector configs (#56)', () => {
  it('after a Redis loss, an active store gets its config back exactly as the API would write it', async () => {
    const s = await seedStore('cfg-active');
    await redis.del(collectorStoreKey(s.storeKey)); // durable Redis was restarted empty
    expect(await configOf(s)).toBeNull();

    const result = await rebuild([s]);

    expect(result.configs).toEqual({ published: 1, skipped: 0, failed: 0 });
    const shop = (await db.select().from(schema.stores)).find((x) => x.id === s.tenant.storeId)!;
    expect(await configOf(s)).toEqual({
      storeId: s.tenant.storeId,
      status: 'active',
      inactiveReason: null,
      allowedOrigins: [`https://${shop.shopDomain}`],
      signingKeys: [{ kid: 's1', secret: s.secret }],
      childDirected: false,
      noticeVersion: 'v1',
    });
  });

  it('keeps the gates: no DPA → inactive dpa_missing; DPA but no India opt-in → inactive consent_region_unconfirmed', async () => {
    const noDpa = await seedStore('cfg-no-dpa', { dpa: false });
    const noOptIn = await seedStore('cfg-no-optin', { optIn: false });
    const result = await rebuild([noDpa, noOptIn]);

    expect(result.configs).toMatchObject({ published: 2, failed: 0 });
    expect(await configOf(noDpa)).toMatchObject({
      status: 'inactive',
      inactiveReason: 'dpa_missing',
    });
    expect(await configOf(noOptIn)).toMatchObject({
      status: 'inactive',
      inactiveReason: 'consent_region_unconfirmed',
    });
  });

  it('a DPA accepted at another version does not open the gate', async () => {
    const s = await seedStore('cfg-old-dpa');
    const result = await rebuildSuppression({
      db,
      redis,
      readyKey,
      storeIds: [s.tenant.storeId],
      configs: { cipher, dpaVersion: 'v2' },
    });
    expect(result.configs?.published).toBe(1);
    expect(await configOf(s)).toMatchObject({ status: 'inactive', inactiveReason: 'dpa_missing' });
  });

  it('leaves out a store with no Shopify integration, and one that was disconnected', async () => {
    const never = await seedStore('cfg-never-connected', { connected: false });
    const gone = await seedStore('cfg-disconnected');
    await createIntegrationRepository(db).markUninstalled(
      jobScope(gone.tenant.organizationId, gone.tenant.storeId),
      gone.tenant.storeId,
    );
    await redis.del(collectorStoreKey(gone.storeKey));

    const result = await rebuild([never, gone]);
    expect(result.configs).toEqual({ published: 0, skipped: 0, failed: 0 });
    expect(await configOf(never)).toBeNull();
    expect(await configOf(gone)).toBeNull(); // no keys any more: the Collector rejects that pixel (#44)
  });

  it('one store with undecryptable credentials is counted and logged, and does not stop the others or the marker', async () => {
    const broken = await seedStore('cfg-broken', { sealWith: otherCipher });
    const fine = await seedStore('cfg-fine');
    await redis.del(readyKey, collectorStoreKey(fine.storeKey));
    const logs: Record<string, unknown>[] = [];

    const result = await rebuild([broken, fine], {
      log: (l: Record<string, unknown>) => logs.push(l),
    });

    expect(result.configs).toEqual({ published: 1, skipped: 0, failed: 1 });
    expect(await configOf(fine)).toMatchObject({ status: 'active' });
    expect(await configOf(broken)).toBeNull();
    expect(await redis.exists(readyKey)).toBe(1); // a missing config fails safe; an absent marker stops everything
    const failure = logs.find((l) => l.event === 'collector_config_publish_failed');
    expect(failure).toMatchObject({ store_id: broken.tenant.storeId });
    expect(JSON.stringify(logs)).not.toContain(broken.secret);
    expect(JSON.stringify(logs)).not.toContain(broken.storeKey);
  });

  it('writes every config BEFORE the readiness marker', async () => {
    const s = await seedStore('cfg-before-marker');
    await redis.del(readyKey, collectorStoreKey(s.storeKey));
    // Every write of the marker is checked: one early write is enough to break "ready implies configs".
    const markerWrites: number[] = [];
    const observing = new Proxy(redis, {
      get(target, prop) {
        if (prop === 'set') {
          return async (key: string, ...rest: unknown[]) => {
            if (key === readyKey) {
              markerWrites.push(await target.exists(collectorStoreKey(s.storeKey)));
            }
            return (target.set as (...a: unknown[]) => Promise<unknown>).call(target, key, ...rest);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await rebuild([s], { redis: observing });
    expect(markerWrites.length).toBeGreaterThan(0);
    expect(markerWrites.every((present) => present === 1)).toBe(true);
  });

  it('is repeatable, and the audit row still carries counts of sets only (no config data)', async () => {
    const s = await seedStore('cfg-idempotent');
    await rebuild([s]);
    const first = await configOf(s);
    await rebuild([s]);
    expect(await configOf(s)).toEqual(first);

    const rows = (await db.select().from(schema.auditLog)).filter(
      (r) => r.action === 'suppression_rebuilt' && r.createdAt >= startedAt,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows)
      expect(Object.keys(row.metadata as object).sort()).toEqual(['entries', 'stores']);
  });

  it('without `configs` the rebuild does not touch collector configs (existing behaviour)', async () => {
    const s = await seedStore('cfg-not-requested');
    await redis.del(collectorStoreKey(s.storeKey));
    const result = await rebuild([s], { configs: undefined });
    expect(result.configs).toBeUndefined();
    expect(await configOf(s)).toBeNull();
  });

  it("only the requested stores are republished; another store's config is left as it was", async () => {
    const a = await seedStore('cfg-scope-a');
    const b = await seedStore('cfg-scope-b');
    await redis.del(collectorStoreKey(a.storeKey), collectorStoreKey(b.storeKey));
    await rebuild([a]);
    expect(await configOf(a)).not.toBeNull();
    expect(await configOf(b)).toBeNull();
  });
});
