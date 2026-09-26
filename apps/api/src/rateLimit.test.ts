import { randomUUID } from 'node:crypto';
import { and, eq, gte } from 'drizzle-orm';
import { schema } from '@truepath/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS } from './rateLimit.js';
import { buildTestApp, testDb, testRedis } from './testApp.js';

// Our own routes call `auth.api.*` directly, which skips Better Auth's rate limiter (verified in
// packages/auth: 15 direct signInEmail calls never returned 429) — so they carry their own,
// on the durable Redis. Every test uses a fresh random IP/email: counters live for a minute in a
// shared Redis, so reusing values would make runs depend on each other.

const app = buildTestApp();
const startedAt = new Date();
const HEADERS = { origin: 'http://localhost:5173' };

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  // The login route audits every attempt (login_failed, org-less); drop what this run wrote.
  await testDb
    .delete(schema.auditLog)
    .where(
      and(eq(schema.auditLog.action, 'login_failed'), gte(schema.auditLog.createdAt, startedAt)),
    );
});

function randomIp(): string {
  const o = () => Math.floor(Math.random() * 254) + 1;
  return `10.${o()}.${o()}.${o()}`;
}

function uniqueEmail(): string {
  return `rl-${randomUUID()}@example.invalid`;
}

function post(url: string, remoteAddress: string, payload: unknown) {
  return app.inject({
    method: 'POST',
    url,
    headers: HEADERS,
    remoteAddress,
    payload: payload as object,
  });
}

async function hammer(count: number, send: (i: number) => Promise<{ statusCode: number }>) {
  const codes: number[] = [];
  for (let i = 0; i < count; i += 1) codes.push((await send(i)).statusCode);
  return codes;
}

describe('POST /v1/auth/signup — per-IP limit', () => {
  it('returns 429 once the IP exceeds the limit, and other IPs are unaffected', async () => {
    const ip = randomIp();
    const { max } = LIMITS.signup.ip;
    // A too-short password is rejected with 400 — still counts against the limit, creates no user.
    const codes = await hammer(max + 1, () =>
      post('/v1/auth/signup', ip, { email: uniqueEmail(), password: 'short', name: 'RL' }),
    );
    expect(codes.slice(0, max).every((c) => c !== 429)).toBe(true);
    expect(codes[max]).toBe(429);

    const other = await post('/v1/auth/signup', randomIp(), {
      email: uniqueEmail(),
      password: 'short',
      name: 'RL',
    });
    expect(other.statusCode).not.toBe(429);
  });

  it('the 429 says how long to wait', async () => {
    const ip = randomIp();
    const { max } = LIMITS.signup.ip;
    await hammer(max, () =>
      post('/v1/auth/signup', ip, { email: uniqueEmail(), password: 'x', name: 'RL' }),
    );
    const res = await post('/v1/auth/signup', ip, {
      email: uniqueEmail(),
      password: 'x',
      name: 'RL',
    });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ error: 'rate_limited' });
    expect(res.json().retryAfterSeconds).toBeGreaterThan(0);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('POST /v1/auth/login — per-IP and per-account limits', () => {
  it('limits by IP across different emails', async () => {
    const ip = randomIp();
    const { max } = LIMITS.login.ip;
    const codes = await hammer(max + 1, () =>
      post('/v1/auth/login', ip, { email: uniqueEmail(), password: 'wrong-password-long-enough' }),
    );
    expect(codes.slice(0, max).every((c) => c !== 429)).toBe(true);
    expect(codes[max]).toBe(429);
  });

  it('limits by email across different IPs, case-insensitively, without touching other emails', async () => {
    const email = uniqueEmail();
    const { max } = LIMITS.login.email;
    // A different IP each time: the per-IP limit never trips, only the per-account one can.
    const codes = await hammer(max + 1, (i) =>
      post('/v1/auth/login', randomIp(), {
        email: i % 2 === 0 ? email : email.toUpperCase(),
        password: 'wrong-password-long-enough',
      }),
    );
    expect(codes.slice(0, max).every((c) => c !== 429)).toBe(true);
    expect(codes[max]).toBe(429);

    const otherEmail = await post('/v1/auth/login', randomIp(), {
      email: uniqueEmail(),
      password: 'wrong-password-long-enough',
    });
    expect(otherEmail.statusCode).not.toBe(429);
  });
});

describe('POST /v1/invites/:token/accept — per-IP limit', () => {
  it('returns 429 once the IP exceeds the limit', async () => {
    const ip = randomIp();
    const { max } = LIMITS.inviteAccept.ip;
    // No session cookie: each is a 401, but the limiter runs before the session check.
    const codes = await hammer(max + 1, () => post(`/v1/invites/${randomUUID()}/accept`, ip, {}));
    expect(codes.slice(0, max).every((c) => c === 401)).toBe(true);
    expect(codes[max]).toBe(429);
  });
});

describe('rate-limit keys on the durable Redis', () => {
  it('hold a pseudonym, never the raw IP or email, and always expire', async () => {
    const ip = randomIp();
    const email = uniqueEmail();
    await post('/v1/auth/login', ip, { email, password: 'wrong-password-long-enough' });

    const keys = await testRedis.keys('rl:*');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.some((k) => k.includes(ip) || k.includes(email))).toBe(false);

    const loginKeys = keys.filter((k) => k.includes('login:'));
    expect(loginKeys.length).toBeGreaterThan(0);
    for (const key of loginKeys.slice(0, 5)) {
      expect(await testRedis.ttl(key)).toBeGreaterThan(0);
    }
  });
});
