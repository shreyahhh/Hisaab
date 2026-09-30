import { randomUUID } from 'node:crypto';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { createAuditLogRepository, schema, type AuditLogRepository } from '@truepath/db';
import type { OrganizationAuditEntry, PlatformAuditEntry } from '@truepath/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createAuditService, type AuditFailureReport } from './audit.js';
import { buildTestApp, testAuth, testDb } from './testApp.js';
import {
  addRealMember,
  cleanupRealMember,
  cleanupRealTenant,
  cleanupRealUser,
  seedRealTenant,
  seedRealUser,
  type RealTenant,
  type RealUser,
} from './testAuthTenant.js';

// Audit rows for every implemented action (SPEC §5.10 test 8), the audit-log endpoint's contract,
// and what happens when an audit write fails: after Better Auth has committed, the client still
// gets the real response (ADR-0021); for our own reads the request fails instead.

const ORIGIN = 'http://localhost:5173';
const cleanups: Array<() => Promise<void>> = [];
const PASSWORD = 'a-very-long-password-123';

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const asHeaders = (t: { cookie: string }) => ({ cookie: t.cookie, origin: ORIGIN });

async function tenant(label: string) {
  const t = await seedRealTenant(testAuth, testDb, label);
  cleanups.push(() => cleanupRealTenant(testDb, t));
  return t;
}
async function member(owner: RealTenant, label: string, role: 'admin' | 'analyst' | 'viewer') {
  const m = await addRealMember(testAuth, testDb, owner, label, role);
  cleanups.push(() => cleanupRealMember(testDb, m));
  return m;
}
async function user(label: string) {
  const u = await seedRealUser(testAuth, testDb, label);
  cleanups.push(() => cleanupRealUser(testDb, u));
  return u;
}

const rowsFor = (organizationId: string) =>
  testDb.select().from(schema.auditLog).where(eq(schema.auditLog.organizationId, organizationId));

function randomIp() {
  const o = () => Math.floor(Math.random() * 254) + 1;
  return `10.${o()}.${o()}.${o()}`;
}

// ---- A repository whose writes fail on demand ------------------------------------------------
function flakyAudit(failures: number) {
  const inner = createAuditLogRepository(testDb);
  const state = { calls: 0, remaining: failures };
  const gate = () => {
    state.calls += 1;
    if (state.remaining > 0) {
      state.remaining -= 1;
      throw new Error('audit database is down');
    }
  };
  const log: AuditLogRepository = {
    ...inner,
    write: async (scope, entry) => {
      gate();
      return inner.write(scope, entry);
    },
    writePlatform: async (entry) => {
      gate();
      return inner.writePlatform(entry);
    },
  };
  const reports: AuditFailureReport[] = [];
  const audit = createAuditService(log, { report: (r) => reports.push(r), retryDelayMs: 0 });
  return { audit, reports, state, app: buildTestApp({ audit }) };
}

// ---- Scenarios: one per Better Auth action that is audited ------------------------------------
interface Scenario {
  readonly response: { readonly status: number };
  /** Sends the request. */
  readonly send: (
    app: ReturnType<typeof buildTestApp>,
  ) => Promise<{ statusCode: number; body: string }>;
  /** The row the request should have produced, or its absence. */
  readonly expected: { action: string; organizationId: string | null; metadata: unknown };
  /** True once the change Better Auth was asked for has actually happened. */
  readonly changed: () => Promise<boolean>;
  readonly find: () => Promise<
    Array<{ action: string; metadata: unknown; organizationId: string | null }>
  >;
}

const scenarios: Array<[string, () => Promise<Scenario>]> = [
  [
    'member_invited (createInvitation)',
    async () => {
      const owner = await tenant('trail-invite');
      const email = `newcomer-${randomUUID()}@example.invalid`;
      return {
        response: { status: 201 },
        send: (app) =>
          app.inject({
            method: 'POST',
            url: `/v1/orgs/${owner.organizationId}/invites`,
            headers: asHeaders(owner),
            payload: { email, role: 'viewer' },
          }),
        expected: {
          action: 'member_invited',
          organizationId: owner.organizationId,
          metadata: { role: 'viewer' },
        },
        changed: async () =>
          (await testDb.select().from(schema.invites).where(eq(schema.invites.email, email)))
            .length === 1,
        find: () => rowsFor(owner.organizationId),
      };
    },
  ],
  [
    'member_role_changed (updateMemberRole)',
    async () => {
      const owner = await tenant('trail-role');
      const viewer = await member(owner, 'trail-role-viewer', 'viewer');
      return {
        response: { status: 200 },
        send: (app) =>
          app.inject({
            method: 'PUT',
            url: `/v1/orgs/${owner.organizationId}/members/${viewer.userId}`,
            headers: asHeaders(owner),
            payload: { role: 'analyst' },
          }),
        expected: {
          action: 'member_role_changed',
          organizationId: owner.organizationId,
          metadata: { from: 'viewer', to: 'analyst' },
        },
        changed: async () => {
          const [m] = await testDb
            .select()
            .from(schema.memberships)
            .where(eq(schema.memberships.userId, viewer.userId));
          return m?.role === 'analyst';
        },
        find: () => rowsFor(owner.organizationId),
      };
    },
  ],
  [
    'member_removed (removeMember)',
    async () => {
      const owner = await tenant('trail-remove');
      const viewer = await member(owner, 'trail-remove-viewer', 'viewer');
      return {
        response: { status: 200 },
        send: (app) =>
          app.inject({
            method: 'DELETE',
            url: `/v1/orgs/${owner.organizationId}/members/${viewer.userId}`,
            headers: asHeaders(owner),
          }),
        expected: {
          action: 'member_removed',
          organizationId: owner.organizationId,
          metadata: { role: 'viewer', self: false },
        },
        changed: async () =>
          (
            await testDb
              .select()
              .from(schema.memberships)
              .where(eq(schema.memberships.userId, viewer.userId))
          ).length === 0,
        find: () => rowsFor(owner.organizationId),
      };
    },
  ],
  [
    'member_removed (leaveOrganization)',
    async () => {
      const owner = await tenant('trail-leave');
      const viewer = await member(owner, 'trail-leave-viewer', 'viewer');
      return {
        response: { status: 200 },
        send: (app) =>
          app.inject({
            method: 'DELETE',
            url: `/v1/orgs/${owner.organizationId}/members/${viewer.userId}`,
            headers: asHeaders(viewer),
          }),
        expected: {
          action: 'member_removed',
          organizationId: owner.organizationId,
          metadata: { role: 'viewer', self: true },
        },
        changed: async () =>
          (
            await testDb
              .select()
              .from(schema.memberships)
              .where(eq(schema.memberships.userId, viewer.userId))
          ).length === 0,
        find: () => rowsFor(owner.organizationId),
      };
    },
  ],
  [
    'member_invite_accepted (acceptInvitation)',
    async () => {
      const owner = await tenant('trail-accept');
      const invitee = await user('trail-accept-user');
      const invitation = await testAuth.api.createInvitation({
        body: { email: invitee.email, role: 'viewer', organizationId: owner.organizationId },
        headers: new Headers({ cookie: owner.cookie }),
      });
      return {
        response: { status: 200 },
        send: (app) =>
          app.inject({
            method: 'POST',
            url: `/v1/invites/${invitation!.id}/accept`,
            headers: asHeaders(invitee),
            remoteAddress: randomIp(),
            payload: {},
          }),
        expected: {
          action: 'member_invite_accepted',
          organizationId: owner.organizationId,
          metadata: {},
        },
        changed: async () =>
          (
            await testDb
              .select()
              .from(schema.memberships)
              .where(eq(schema.memberships.userId, invitee.userId))
          ).length === 1,
        find: () => rowsFor(owner.organizationId),
      };
    },
  ],
];

// Login outcomes are platform-wide rows, so they are found by time and content, not by organization.
// issue #57: another suite running in parallel can write a platform row for the same action in the
// same window, so "exactly one since T" is not reliable on its own — each scenario below also pins
// down something unique to its own request (login_succeeded's actorUserId; login_failed's
// target_user_id, already in its metadata) so a concurrent suite's row can never be mistaken for it.
interface PlatformScenario {
  readonly name: string;
  readonly prepare: () => Promise<{
    send: (app: ReturnType<typeof buildTestApp>) => Promise<{ statusCode: number; body: string }>;
    status: number;
    expected: { action: string; metadata: unknown; actorUserId?: string | null };
  }>;
}
const platformScenarios: PlatformScenario[] = [
  {
    name: 'login_succeeded (signInEmail)',
    prepare: async () => {
      const u: RealUser = await user('trail-login-ok');
      return {
        status: 200,
        expected: { action: 'login_succeeded', metadata: {}, actorUserId: u.userId },
        send: (app) =>
          app.inject({
            method: 'POST',
            url: '/v1/auth/login',
            headers: { origin: ORIGIN },
            remoteAddress: randomIp(),
            payload: { email: u.email, password: PASSWORD },
          }),
      };
    },
  },
  {
    name: 'login_failed (signInEmail)',
    prepare: async () => {
      const u: RealUser = await user('trail-login-bad');
      return {
        status: 401,
        expected: { action: 'login_failed', metadata: { target_user_id: u.userId } },
        send: (app) =>
          app.inject({
            method: 'POST',
            url: '/v1/auth/login',
            headers: { origin: ORIGIN },
            remoteAddress: randomIp(),
            payload: { email: u.email, password: 'wrong-password-long-enough' },
          }),
      };
    },
  },
];

async function platformRows(since: Date, action: string) {
  return testDb
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.action, action),
        gte(schema.auditLog.createdAt, since),
        sql`${schema.auditLog.organizationId} is null`,
      ),
    );
}

describe('an audit row is written for each implemented action', () => {
  for (const [name, make] of scenarios) {
    it(`${name}`, async () => {
      const scenario = await make();
      const app = buildTestApp();
      await app.ready();
      try {
        const res = await scenario.send(app);
        expect(res.statusCode).toBe(scenario.response.status);
        const rows = (await scenario.find()).filter((r) => r.action === scenario.expected.action);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          metadata: scenario.expected.metadata,
          organizationId: scenario.expected.organizationId,
        });
      } finally {
        await app.close();
      }
    });
  }

  for (const scenario of platformScenarios) {
    it(scenario.name, async () => {
      const prepared = await scenario.prepare();
      const app = buildTestApp();
      await app.ready();
      const since = new Date();
      let mine: string[] = [];
      try {
        const res = await prepared.send(app);
        expect(res.statusCode).toBe(prepared.status);
        const rows = await platformRows(since, prepared.expected.action);
        const matching = rows.filter(
          (r) =>
            JSON.stringify(r.metadata) === JSON.stringify(prepared.expected.metadata) &&
            (prepared.expected.actorUserId === undefined ||
              r.actorUserId === prepared.expected.actorUserId),
        );
        mine = matching.map((r) => r.id);
        expect(matching).toHaveLength(1);
      } finally {
        await app.close();
        // Only the rows this test made: other suites write platform rows to the same table.
        if (mine.length > 0) {
          await testDb.delete(schema.auditLog).where(inArray(schema.auditLog.id, mine));
        }
      }
    });
  }
});

describe('when the audit write fails after Better Auth has committed (ADR-0021)', () => {
  for (const [name, make] of scenarios) {
    it(`${name}: a transient failure is retried once, and the client sees the real response`, async () => {
      const scenario = await make();
      const { app, reports, state } = flakyAudit(1);
      await app.ready();
      try {
        const res = await scenario.send(app);
        expect(res.statusCode).toBe(scenario.response.status);
        expect(state.calls).toBe(2);
        expect(reports).toEqual([]);
        expect(
          (await scenario.find()).filter((r) => r.action === scenario.expected.action),
        ).toHaveLength(1);
      } finally {
        await app.close();
      }
    });

    it(`${name}: a persistent failure still returns the real response, and reports the full entry`, async () => {
      const scenario = await make();
      const { app, reports, state } = flakyAudit(Infinity);
      await app.ready();
      try {
        const res = await scenario.send(app);
        expect(res.statusCode, res.body).toBe(scenario.response.status);
        expect(await scenario.changed()).toBe(true);
        expect(state.calls).toBe(2);
        expect(
          (await scenario.find()).filter((r) => r.action === scenario.expected.action),
        ).toEqual([]);

        expect(reports).toHaveLength(1);
        const report = reports[0]!;
        expect(report).toMatchObject({
          event: 'audit_write_failed',
          alert: 'audit_write_failed',
          attempts: 2,
          action: scenario.expected.action,
          organizationId: scenario.expected.organizationId,
        });
        expect(report.entry).toMatchObject({ action: scenario.expected.action });
        // An entry with no metadata field means empty metadata.
        expect((report.entry as { metadata?: unknown }).metadata ?? {}).toEqual(
          scenario.expected.metadata,
        );
        expect((report.entry as OrganizationAuditEntry).targetId).toEqual(expect.any(String));
        expect(report.error.message).toBe('audit database is down');
      } finally {
        await app.close();
      }
    });
  }

  for (const scenario of platformScenarios) {
    it(`${scenario.name}: a persistent failure keeps the real response and reports the entry`, async () => {
      const prepared = await scenario.prepare();
      const { app, reports } = flakyAudit(Infinity);
      await app.ready();
      try {
        const res = await prepared.send(app);
        expect(res.statusCode, res.body).toBe(prepared.status);
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({
          alert: 'audit_write_failed',
          attempts: 2,
          organizationId: null,
          action: prepared.expected.action,
        });
        expect((reports[0]!.entry as PlatformAuditEntry).metadata ?? {}).toEqual(
          prepared.expected.metadata,
        );
      } finally {
        await app.close();
      }
    });
  }

  it('a broken reporter cannot fail the request either', async () => {
    const owner = await tenant('trail-reporter');
    const viewer = await member(owner, 'trail-reporter-viewer', 'viewer');
    const inner = createAuditLogRepository(testDb);
    const audit = createAuditService(
      {
        ...inner,
        write: async () => {
          throw new Error('down');
        },
      },
      {
        report: () => {
          throw new Error('reporter down');
        },
        retryDelayMs: 0,
      },
    );
    const app = buildTestApp({ audit });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${owner.organizationId}/members/${viewer.userId}`,
        headers: asHeaders(owner),
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('does not retry, or log the metadata of, an entry that fails validation', async () => {
    const owner = await tenant('trail-invalid');
    const reports: AuditFailureReport[] = [];
    let calls = 0;
    const inner = createAuditLogRepository(testDb);
    const audit = createAuditService(
      {
        ...inner,
        write: async (scope, entry) => {
          calls += 1;
          return inner.write(scope, {
            ...entry,
            metadata: { email: 'someone@example.com' },
          } as never);
        },
      },
      { report: (r) => reports.push(r), retryDelayMs: 0 },
    );
    await audit.afterCommit(
      {
        kind: 'tenant',
        userId: owner.userId,
        organizationId: owner.organizationId,
        role: 'owner',
        storeIds: new Set(),
      },
      {
        organizationId: owner.organizationId,
        actorType: 'user',
        action: 'member_invited',
        targetType: 'invite',
        targetId: 'x',
        metadata: { role: 'viewer' },
      },
    );
    expect(calls).toBe(1);
    expect(reports).toHaveLength(1);
    expect(reports[0]).not.toHaveProperty('entry');
    expect(JSON.stringify(reports[0])).not.toContain('someone@example.com');
  });

  it('for our own read (viewing the audit log) the write is required: the request fails and returns no data', async () => {
    const owner = await tenant('trail-strict');
    const { app } = flakyAudit(Infinity);
    await app.ready();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${owner.organizationId}/audit-log`,
        headers: asHeaders(owner),
      });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('items');
    } finally {
      await app.close();
    }
  });
});

describe('GET /v1/orgs/:id/audit-log', () => {
  const app = buildTestApp();
  afterAll(async () => {
    await app.close();
  });

  async function seedRows(organizationId: string) {
    const stamps = [
      '2026-01-01T00:00:03.500000Z',
      '2026-01-01T00:00:03.500000Z',
      '2026-01-01T00:00:03.400000Z',
      '2026-01-01T00:00:02.000000Z',
      '2026-01-01T00:00:01.000000Z',
    ];
    for (const [i, stamp] of stamps.entries()) {
      await testDb.insert(schema.auditLog).values({
        organizationId,
        actorType: 'user',
        action: i === 4 ? 'member_removed' : 'member_role_changed',
        targetType: 'user',
        targetId: `seed-${i}`,
        metadata: i === 4 ? { role: 'viewer', self: false } : { from: 'viewer', to: 'analyst' },
        createdAt: sql`${stamp}::timestamptz`,
      });
    }
  }
  const get = (t: RealTenant, query = '') =>
    app.inject({
      method: 'GET',
      url: `/v1/orgs/${t.organizationId}/audit-log${query}`,
      headers: asHeaders(t),
    });

  it('returns { items, next_cursor } newest first, with snake_case items and no organization id', async () => {
    const owner = await tenant('endpoint-shape');
    await seedRows(owner.organizationId);
    const res = await get(owner, '?limit=2');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['items', 'next_cursor']);
    expect(body.items).toHaveLength(2);
    expect(Object.keys(body.items[0]).sort()).toEqual([
      'action',
      'actor_type',
      'actor_user_id',
      'created_at',
      'id',
      'metadata',
      'target_id',
      'target_type',
    ]);
    expect(body.items[0].created_at).toBe('2026-01-01T00:00:03.500Z');
    expect(typeof body.next_cursor).toBe('string');
  });

  it('pages through every row once, and audits the view once (first page only)', async () => {
    const owner = await tenant('endpoint-pages');
    await seedRows(owner.organizationId);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(
        owner,
        `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(res.statusCode).toBe(200);
      seen.push(...res.json().items.map((i: { target_id: string }) => i.target_id));
      cursor = res.json().next_cursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen.filter((t) => t.startsWith('seed-')).sort()).toEqual([
      'seed-0',
      'seed-1',
      'seed-2',
      'seed-3',
      'seed-4',
    ]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(
      (await rowsFor(owner.organizationId)).filter((r) => r.action === 'audit_log_viewed'),
    ).toHaveLength(1);
  });

  it('filters by action and by time range', async () => {
    const owner = await tenant('endpoint-filter');
    await seedRows(owner.organizationId);
    const byAction = await get(owner, '?action=member_removed');
    expect(byAction.json().items.map((i: { target_id: string }) => i.target_id)).toEqual([
      'seed-4',
    ]);
    const byTime = await get(
      owner,
      `?from=${encodeURIComponent('2026-01-01T00:00:02.000Z')}&to=${encodeURIComponent('2026-01-01T00:00:03.450Z')}&action=member_role_changed`,
    );
    expect(byTime.json().items.map((i: { target_id: string }) => i.target_id)).toEqual([
      'seed-2',
      'seed-3',
    ]);
  });

  it.each([
    ['limit above the maximum', '?limit=201', ['limit']],
    ['limit of zero', '?limit=0', ['limit']],
    ['a non-numeric limit', '?limit=abc', ['limit']],
    ['an action outside the catalogue', '?action=made_up', ['action']],
    ['a malformed date', '?from=yesterday', ['from']],
    ['from after to', '?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z', ['from', 'to']],
    ['an unknown parameter', '?unexpected=1', ['']],
    ['a malformed cursor', '?cursor=not-a-cursor', ['cursor']],
  ])(
    'rejects %s with 400 invalid_query, and writes no audit_log_viewed row',
    async (_label, query, fields) => {
      const owner = await tenant('endpoint-invalid');
      const res = await get(owner, query);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_query', fields });
      expect(
        (await rowsFor(owner.organizationId)).filter((r) => r.action === 'audit_log_viewed'),
      ).toEqual([]);
    },
  );

  it('accepts a limit of exactly the maximum', async () => {
    const owner = await tenant('endpoint-max');
    expect((await get(owner, '?limit=200')).statusCode).toBe(200);
  });

  it('answers 404 for another organization, whatever the query, before any validation', async () => {
    const a = await tenant('endpoint-a');
    const b = await tenant('endpoint-b');
    for (const query of ['', '?limit=999', '?action=made_up', '?cursor=junk']) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${b.organizationId}/audit-log${query}`,
        headers: asHeaders(a),
      });
      expect(res.statusCode, query).toBe(404);
    }
    expect(
      (await rowsFor(b.organizationId)).filter((r) => r.action === 'audit_log_viewed'),
    ).toEqual([]);
  });

  // The organization a query reads comes from the authenticated scope alone. A cursor holds only a
  // position (a timestamp and a row id), so replaying one organization's cursor against another's
  // endpoint can at most move the window within the *caller's own* log.
  describe('a cursor never changes which organization is read', () => {
    async function seedOther(organizationId: string, stamps: string[]) {
      const ids: string[] = [];
      for (const [i, stamp] of stamps.entries()) {
        const [row] = await testDb
          .insert(schema.auditLog)
          .values({
            organizationId,
            actorType: 'user',
            action: 'member_role_changed',
            targetType: 'user',
            targetId: `other-${i}`,
            metadata: { from: 'viewer', to: 'analyst' },
            createdAt: sql`${stamp}::timestamptz`,
          })
          .returning({ id: schema.auditLog.id });
        ids.push(row!.id);
      }
      return ids;
    }

    async function setup() {
      const a = await tenant('cursor-a');
      const b = await tenant('cursor-b');
      await seedRows(a.organizationId);
      // B's rows straddle the position of A's cursor (A's first page ends at 03.500000).
      const bIds = await seedOther(b.organizationId, [
        '2026-01-01T00:00:04.000000Z', // newer than the cursor: must not appear
        '2026-01-01T00:00:03.450000Z',
        '2026-01-01T00:00:02.500000Z',
        '2026-01-01T00:00:01.500000Z',
      ]);
      const first = await get(a, '?limit=2');
      const cursor: string = first.json().next_cursor;
      expect(cursor).toEqual(expect.any(String));
      const aIds: string[] = (
        await testDb
          .select({ id: schema.auditLog.id })
          .from(schema.auditLog)
          .where(eq(schema.auditLog.organizationId, a.organizationId))
      ).map((r) => r.id);
      return { a, b, bIds, aIds, cursor };
    }

    const idsOf = (res: { json: () => { items: Array<{ id: string }> } }) =>
      res.json().items.map((i) => i.id);

    it("returns only the caller's rows when B replays A's cursor", async () => {
      const { b, bIds, aIds, cursor } = await setup();
      const res = await get(b, `?cursor=${encodeURIComponent(cursor)}`);
      expect(res.statusCode).toBe(200);
      const ids = idsOf(res);
      expect(ids.filter((id) => aIds.includes(id))).toEqual([]);
      // Exactly B's rows older than the cursor position, newest first (bIds[0] is newer and excluded).
      expect(ids.filter((id) => bIds.includes(id))).toEqual([bIds[1], bIds[2], bIds[3]]);
    });

    it('ignores an organization id smuggled into the cursor', async () => {
      const { a, b, bIds, aIds, cursor } = await setup();
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      const forged = Buffer.from(
        JSON.stringify({
          ...decoded,
          o: a.organizationId,
          org: a.organizationId,
          organizationId: a.organizationId,
        }),
      ).toString('base64url');
      const res = await get(b, `?cursor=${encodeURIComponent(forged)}`);
      // Either refused, or answered from B's own log only.
      expect([200, 400]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        const ids = idsOf(res);
        expect(ids.filter((id) => aIds.includes(id))).toEqual([]);
        expect(ids.filter((id) => bIds.includes(id))).toEqual([bIds[1], bIds[2], bIds[3]]);
      }
    });

    it('does not let a cursor smuggle in SQL: only a well-formed position is accepted', async () => {
      const { b } = await setup();
      for (const payload of [
        { v: 1, t: "2026-01-01T00:00:03.500000Z'; select 1; --", i: randomUUID() },
        { v: 1, t: '2026-01-01T00:00:03.500000Z', i: "' or true --" },
        { v: 1, t: '2026-01-01T00:00:03.500000Z', i: randomUUID(), extra: 'x' },
      ]) {
        const cursor = Buffer.from(JSON.stringify(payload)).toString('base64url');
        const res = await get(b, `?cursor=${encodeURIComponent(cursor)}`);
        expect([200, 400]).toContain(res.statusCode);
        if (res.statusCode === 200) {
          expect(
            res
              .json()
              .items.every(
                (i: { target_id: string }) =>
                  i.target_id.startsWith('other-') || i.target_id === b.organizationId,
              ),
          ).toBe(true);
        }
      }
    });

    it("still answers 404 when a member of B replays A's cursor against A's endpoint", async () => {
      const { a, b, cursor } = await setup();
      const res = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${a.organizationId}/audit-log?cursor=${encodeURIComponent(cursor)}`,
        headers: asHeaders(b),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  it('is still discovered by the generated cross-tenant harness', async () => {
    const harnessApp = buildTestApp();
    await harnessApp.ready();
    try {
      expect(harnessApp.routeRegistry).toContainEqual({
        method: 'GET',
        url: '/v1/orgs/:id/audit-log',
      });
    } finally {
      await harnessApp.close();
    }
  });
});
