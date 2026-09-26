import { randomUUID } from 'node:crypto';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { schema } from '@truepath/db';
import { findPii } from '@truepath/privacy';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTestApp, testAuth, testDb, testRedis } from './testApp.js';
import { cleanupRealUser, seedRealUser, type RealUser } from './testAuthTenant.js';

// login_failed says which account an attempt targeted (target_user_id, or unknown_account) and
// nothing else: no email, and no hash of one (issue #9, privacy-dpdp.md: audit metadata is ids and
// counts only). These tests read audit rows straight after each attempt, because other test files
// also write and clean up login_failed rows.

const app = buildTestApp();
const startedAt = new Date();
const HEADERS = { origin: 'http://localhost:5173' };
const WRONG_PASSWORD = 'not-the-password-123';

let user: RealUser;
const seenRowIds: string[] = [];

beforeAll(async () => {
  await app.ready();
  user = await seedRealUser(
    testAuth,
    testDb,
    'audit',
    `audit.target+${randomUUID().slice(0, 8)}@example.invalid`,
  );
});

afterAll(async () => {
  await resetInvalidEmailBucket();
  await app.close();
  if (seenRowIds.length > 0) {
    await testDb.delete(schema.auditLog).where(inArray(schema.auditLog.id, seenRowIds));
  }
  if (user) await cleanupRealUser(testDb, user);
});

function randomIp(): string {
  const o = () => Math.floor(Math.random() * 254) + 1;
  return `10.${o()}.${o()}.${o()}`;
}

// Every unusable email shares one rate-limit bucket (5/min, 20/h) that outlives a test run, so clear
// it before each attempt; files run one at a time (vitest.config.ts), so nothing else is counting.
async function resetInvalidEmailBucket() {
  const keys = await testRedis.keys('rl:*:email:invalid');
  if (keys.length > 0) await testRedis.del(...keys);
}

async function login(payload: unknown) {
  await resetInvalidEmailBucket();
  const before = new Date();
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: HEADERS,
    remoteAddress: randomIp(),
    payload: payload as object,
  });
  const rows = await testDb
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, 'login_failed'), gte(schema.auditLog.createdAt, before)));
  seenRowIds.push(...rows.map((r) => r.id));
  return { res, rows };
}

describe('POST /v1/auth/login: login_failed audit metadata', () => {
  it('records target_user_id when the attempted email belongs to a user', async () => {
    const { res, rows } = await login({ email: user.email, password: WRONG_PASSWORD });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const mine = rows.filter(
      (r) => (r.metadata as { target_user_id?: string }).target_user_id === user.userId,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      action: 'login_failed',
      organizationId: null,
      actorUserId: null,
      metadata: { target_user_id: user.userId },
    });
  });

  it('matches the account however the attempt spells the email', async () => {
    for (const email of [user.email.toUpperCase(), user.email.toLowerCase(), `  ${user.email}  `]) {
      const { rows } = await login({ email, password: WRONG_PASSWORD });
      const hit = rows.some(
        (r) => (r.metadata as { target_user_id?: string }).target_user_id === user.userId,
      );
      expect(hit, JSON.stringify(email)).toBe(true);
    }
  });

  it('records unknown_account: true when no user has that email, or the email is unusable', async () => {
    for (const email of [
      `nobody-${randomUUID()}@example.invalid`,
      'not-an-email',
      '',
      12345,
      null,
      { nested: 'x' },
    ]) {
      const { res, rows } = await login({ email, password: WRONG_PASSWORD });
      expect(res.statusCode, JSON.stringify(email)).toBeLessThan(500);
      expect(
        rows.some((r) => JSON.stringify(r.metadata) === JSON.stringify({ unknown_account: true })),
        JSON.stringify(email),
      ).toBe(true);
    }
  });

  it('does not write login_failed for a successful login', async () => {
    const { res, rows } = await login({ email: user.email, password: 'a-very-long-password-123' });
    expect(res.statusCode).toBe(200);
    expect(
      rows.some((r) => (r.metadata as { target_user_id?: string }).target_user_id === user.userId),
    ).toBe(false);
  });
});

describe('no raw email and no hash in any audit_log row, and none in the logs', () => {
  it('holds across every kind of attempt, success included', async () => {
    const attempted = [
      user.email,
      user.email.toUpperCase(),
      `stranger-${randomUUID()}@example.invalid`,
      'malformed-address',
    ];

    const captured: string[] = [];
    const capture = (chunk: unknown) => {
      captured.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    };
    const spies = [
      vi.spyOn(process.stdout, 'write').mockImplementation(capture),
      vi.spyOn(process.stderr, 'write').mockImplementation(capture),
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          captured.push(args.map(String).join(' '));
        }),
      ),
    ];
    try {
      for (const email of attempted) await login({ email, password: WRONG_PASSWORD });
      await login({ email: user.email, password: 'a-very-long-password-123' });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    const rows = await testDb
      .select()
      .from(schema.auditLog)
      .where(gte(schema.auditLog.createdAt, startedAt));
    expect(rows.length).toBeGreaterThan(0);

    // Row ids and user ids are UUIDs; their digit runs are not what this scan is about.
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    for (const row of rows) {
      const text = JSON.stringify({
        organizationId: row.organizationId,
        actorUserId: row.actorUserId,
        actorType: row.actorType,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        metadata: row.metadata,
      }).replace(UUID, '<id>');
      expect(findPii(text), `audit row ${row.action}`).toEqual([]);
      for (const email of [...attempted, user.email]) {
        expect(text.toLowerCase(), `audit row ${row.action}`).not.toContain(
          email.trim().toLowerCase(),
        );
      }
      expect(text).not.toMatch(/[0-9a-f]{64}/i);
      expect(text).not.toMatch(/\bk\d+:/);
    }

    const output = captured.join('\n');
    expect(findPii(output.replace(UUID, '<id>'))).toEqual([]);
    for (const email of attempted) expect(output.toLowerCase()).not.toContain(email.toLowerCase());
  });
});
