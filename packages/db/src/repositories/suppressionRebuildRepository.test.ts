import { randomUUID } from 'node:crypto';
import type { SystemScope, TenantScope } from '@truepath/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestTenant, db, seedTestTenant, type TestTenant } from '../testing.js';
import { suppressedIdentities } from '../schema/index.js';
import {
  createSuppressionRebuildRepository,
  SystemScopeRequiredError,
} from './suppressionRebuildRepository.js';

const repo = createSuppressionRebuildRepository(db);
const system: SystemScope = { kind: 'system', reason: 'suppression_rebuild', auditId: 'test' };
const HMAC = (n: number): string => `k1:${n.toString(16).padStart(64, '0')}`;
const NOW = new Date('2026-09-28T10:00:00.000Z');
const FUTURE = new Date('2027-10-28T10:00:00.000Z');
const PAST = new Date('2026-09-01T00:00:00.000Z');

let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  a = await seedTestTenant('rebuild-a');
  b = await seedTestTenant('rebuild-b');
  await db.insert(suppressedIdentities).values([
    {
      storeId: a.storeId,
      identifierType: 'visitor_id',
      identifier: HMAC(1),
      reason: 'erased',
      expiresAt: FUTURE,
    },
    {
      storeId: a.storeId,
      identifierType: 'visitor_id',
      identifier: HMAC(2),
      reason: 'withdrawn',
      expiresAt: FUTURE,
    },
    {
      storeId: a.storeId,
      identifierType: 'identity_hash_hmac',
      identifier: HMAC(3),
      reason: 'erased',
      expiresAt: FUTURE,
    },
    {
      storeId: a.storeId,
      identifierType: 'visitor_id',
      identifier: HMAC(4),
      reason: 'erased',
      expiresAt: PAST,
    },
    {
      storeId: b.storeId,
      identifierType: 'visitor_id',
      identifier: HMAC(5),
      reason: 'erased',
      expiresAt: FUTURE,
    },
  ]);
});

afterAll(async () => {
  await cleanupTestTenant(a);
  await cleanupTestTenant(b);
});

async function all(storeIds: string[], limit = 2) {
  const out = [];
  let afterId: string | null = null;
  for (;;) {
    const page = await repo.listActivePage(system, { afterId, limit, now: NOW, storeIds });
    out.push(...page);
    if (page.length < limit) return out;
    afterId = page[page.length - 1]!.id;
  }
}

describe('SuppressionRebuildRepository.listActivePage', () => {
  it('pages through every active entry of the requested stores, in id order, without repeats', async () => {
    const rows = await all([a.storeId, b.storeId], 2);
    expect(rows.map((r) => r.identifier).sort()).toEqual(
      [HMAC(1), HMAC(2), HMAC(3), HMAC(5)].sort(),
    );
    expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort());
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it('leaves out expired entries', async () => {
    const rows = await all([a.storeId]);
    expect(rows.map((r) => r.identifier)).not.toContain(HMAC(4));
  });

  it('honours the store filter, and an empty filter returns nothing', async () => {
    expect((await all([b.storeId])).map((r) => r.identifier)).toEqual([HMAC(5)]);
    expect(
      await repo.listActivePage(system, { afterId: null, limit: 10, now: NOW, storeIds: [] }),
    ).toEqual([]);
    expect(await all([randomUUID()])).toEqual([]);
  });

  it('returns typed columns', async () => {
    const [row] = (await all([b.storeId]))!;
    expect(row).toMatchObject({
      storeId: b.storeId,
      identifierType: 'visitor_id',
      reason: 'erased',
    });
    expect(row!.expiresAt.toISOString()).toBe(FUTURE.toISOString());
  });

  it('refuses a TenantScope — cross-tenant reads need an audited SystemScope (ADR-0016)', async () => {
    const tenant: TenantScope = {
      kind: 'tenant',
      userId: a.userId,
      organizationId: a.organizationId,
      role: 'owner',
      storeIds: new Set([a.storeId]),
    };
    await expect(
      repo.listActivePage(tenant, { afterId: null, limit: 10, now: NOW }),
    ).rejects.toThrow(SystemScopeRequiredError);
  });
});
