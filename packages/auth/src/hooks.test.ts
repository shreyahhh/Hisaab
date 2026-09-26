import { eq } from 'drizzle-orm';
import { schema } from '@truepath/db';
import { db } from '@truepath/db/testing';
import { describe, expect, it } from 'vitest';
import { nullGoogleTokensAfterCreate, truncateIp } from './hooks.js';

describe('truncateIp (SPEC §5.4, auth-tenancy.md §3 — never store a full staff IP)', () => {
  it('truncates an IPv4 address to /24', () => {
    expect(truncateIp('203.0.113.42')).toBe('203.0.113.0/24');
  });

  it('truncates an IPv6 address to /48', () => {
    expect(truncateIp('2001:db8:abcd:1234::1')).toBe('2001:db8:abcd::/48');
  });

  it('returns null for null/undefined/empty input', () => {
    expect(truncateIp(null)).toBeNull();
    expect(truncateIp(undefined)).toBeNull();
    expect(truncateIp('')).toBeNull();
  });

  it('returns null (never stores it raw) for an unrecognisable value', () => {
    expect(truncateIp('not-an-ip')).toBeNull();
  });
});

describe('nullGoogleTokensAfterCreate (auth-tenancy.md §3)', () => {
  it('nulls access/refresh/id tokens for a google account row', async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ email: `hooks-test-${Date.now()}@example.invalid`, name: 'Hooks Test' })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('setup: user insert failed');
    const [account] = await db
      .insert(schema.authAccounts)
      .values({
        userId: user.id,
        providerId: 'google',
        accountId: 'google-account-1',
        accessToken: 'secret-access-token',
        refreshToken: 'secret-refresh-token',
        idToken: 'secret-id-token',
      })
      .returning({ id: schema.authAccounts.id, providerId: schema.authAccounts.providerId });
    if (!account) throw new Error('setup: account insert failed');

    try {
      await nullGoogleTokensAfterCreate(db, account);

      const [row] = await db
        .select()
        .from(schema.authAccounts)
        .where(eq(schema.authAccounts.id, account.id));
      expect(row?.accessToken).toBeNull();
      expect(row?.refreshToken).toBeNull();
      expect(row?.idToken).toBeNull();
    } finally {
      await db.delete(schema.authAccounts).where(eq(schema.authAccounts.id, account.id));
      await db.delete(schema.users).where(eq(schema.users.id, user.id));
    }
  });

  it('leaves a credential (non-google) account untouched', async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ email: `hooks-test-${Date.now()}-cred@example.invalid`, name: 'Hooks Test' })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('setup: user insert failed');
    const [account] = await db
      .insert(schema.authAccounts)
      .values({
        userId: user.id,
        providerId: 'credential',
        accountId: user.id,
        password: 'hashed-password',
      })
      .returning({ id: schema.authAccounts.id, providerId: schema.authAccounts.providerId });
    if (!account) throw new Error('setup: account insert failed');

    try {
      await nullGoogleTokensAfterCreate(db, account);
      const [row] = await db
        .select()
        .from(schema.authAccounts)
        .where(eq(schema.authAccounts.id, account.id));
      expect(row?.password).toBe('hashed-password');
    } finally {
      await db.delete(schema.authAccounts).where(eq(schema.authAccounts.id, account.id));
      await db.delete(schema.users).where(eq(schema.users.id, user.id));
    }
  });
});
