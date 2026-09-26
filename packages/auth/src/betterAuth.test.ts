import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@truepath/db';
import { db } from '@truepath/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth, type Auth } from './betterAuth.js';
import type { AuthEmailSender } from './email.js';

const sentEmails: Array<{ kind: string; to: string; url: string }> = [];
const testEmailSender: AuthEmailSender = {
  async sendVerificationEmail({ to, url }: { to: string; url: string }) {
    sentEmails.push({ kind: 'verify', to, url });
  },
  async sendPasswordReset({ to, url }: { to: string; url: string }) {
    sentEmails.push({ kind: 'reset', to, url });
  },
  async sendInvitation({ to, url }: { to: string; url: string; organizationName: string }) {
    sentEmails.push({ kind: 'invite', to, url });
  },
};

let auth: Auth;
const createdUserEmails: string[] = [];
const createdOrgSlugs: string[] = [];

beforeAll(() => {
  auth = createAuth({
    db,
    env: {
      BETTER_AUTH_SECRET: 'a'.repeat(32),
      BETTER_AUTH_URL: 'http://localhost:3000',
      DASHBOARD_URL: 'http://localhost:5173',
      GOOGLE_CLIENT_ID: 'test-google-client-id',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    },
    redisDurableUrl: 'redis://localhost:6379',
    allowInsecureCookies: true,
    emailSender: testEmailSender,
  });
});

afterAll(async () => {
  // Organizations first: cascades invites/memberships, which otherwise FK-block deleting a user
  // who sent an invite (invites.inviter_id has no cascade, by design — auth-tenancy.md §3).
  for (const slug of createdOrgSlugs) {
    const [org] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, slug));
    if (org) await db.delete(schema.organizations).where(eq(schema.organizations.id, org.id));
  }
  for (const email of createdUserEmails) {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    if (user) {
      await db.delete(schema.memberships).where(eq(schema.memberships.userId, user.id));
      await db.delete(schema.authAccounts).where(eq(schema.authAccounts.userId, user.id));
      await db.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));
      await db.delete(schema.users).where(eq(schema.users.id, user.id));
    }
  }
});

function uniqueEmail(label: string): string {
  const email = `auth-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
  createdUserEmails.push(email);
  return email;
}

describe('createAuth — signup/verification (auth-tenancy.md §4.2)', () => {
  it('signs up a user and account, but issues no session before email verification', async () => {
    const email = uniqueEmail('signup');
    const response = await auth.api.signUpEmail({
      body: { email, password: 'a-very-long-password-123', name: 'Signup Test' },
      asResponse: true,
    });

    expect(response.headers.get('set-cookie')).toBeNull();

    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    expect(user?.emailVerified).toBe(false);

    const [account] = await db
      .select()
      .from(schema.authAccounts)
      .where(eq(schema.authAccounts.userId, user!.id));
    expect(account?.providerId).toBe('credential');

    expect(sentEmails.some((e) => e.kind === 'verify' && e.to === email)).toBe(true);
  });
});

describe('createAuth — organization plugin (auth-tenancy.md §4.2)', () => {
  it('creates an organization with the creator as owner', async () => {
    const email = uniqueEmail('org-owner');
    const signUpResponse = await auth.api.signUpEmail({
      body: { email, password: 'a-very-long-password-123', name: 'Org Owner' },
      asResponse: true,
    });
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    await db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, user!.id));

    const signInResponse = await auth.api.signInEmail({
      body: { email, password: 'a-very-long-password-123' },
      asResponse: true,
    });
    const cookie = signInResponse.headers.get('set-cookie');
    expect(cookie).toBeTruthy();
    void signUpResponse;

    const slug = `test-org-${randomUUID()}`;
    createdOrgSlugs.push(slug);
    const org = await auth.api.createOrganization({
      body: { name: 'Test Org', slug },
      headers: new Headers({ cookie: cookie! }),
    });
    expect(org?.id).toBeTruthy();

    const [membership] = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, user!.id));
    expect(membership?.role).toBe('owner');
    expect(membership?.organizationId).toBe(org!.id);
  });

  it('invites a member with a custom role, and accepting it creates the membership', async () => {
    const ownerEmail = uniqueEmail('invite-owner');
    await auth.api.signUpEmail({
      body: { email: ownerEmail, password: 'a-very-long-password-123', name: 'Invite Owner' },
    });
    const [owner] = await db.select().from(schema.users).where(eq(schema.users.email, ownerEmail));
    await db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, owner!.id));
    const ownerSignIn = await auth.api.signInEmail({
      body: { email: ownerEmail, password: 'a-very-long-password-123' },
      asResponse: true,
    });
    const ownerCookie = ownerSignIn.headers.get('set-cookie')!;

    const slug = `test-org-invite-${randomUUID()}`;
    createdOrgSlugs.push(slug);
    const org = await auth.api.createOrganization({
      body: { name: 'Invite Org', slug },
      headers: new Headers({ cookie: ownerCookie }),
    });

    const inviteeEmail = uniqueEmail('invite-invitee');
    const invitation = await auth.api.createInvitation({
      body: { email: inviteeEmail, role: 'analyst', organizationId: org!.id },
      headers: new Headers({ cookie: ownerCookie }),
    });
    expect(sentEmails.some((e) => e.kind === 'invite' && e.to === inviteeEmail)).toBe(true);

    await auth.api.signUpEmail({
      body: { email: inviteeEmail, password: 'a-very-long-password-123', name: 'Invitee' },
    });
    const [invitee] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, inviteeEmail));
    await db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, invitee!.id));
    const inviteeSignIn = await auth.api.signInEmail({
      body: { email: inviteeEmail, password: 'a-very-long-password-123' },
      asResponse: true,
    });
    const inviteeCookie = inviteeSignIn.headers.get('set-cookie')!;

    await auth.api.acceptInvitation({
      body: { invitationId: invitation!.id },
      headers: new Headers({ cookie: inviteeCookie }),
    });

    const [membership] = await db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, invitee!.id));
    expect(membership?.role).toBe('analyst');
    expect(membership?.organizationId).toBe(org!.id);
  });
});

describe('createAuth — session cookie attributes (auth-tenancy.md §4.1)', () => {
  const secureEnv = {
    BETTER_AUTH_SECRET: 'a'.repeat(32),
    BETTER_AUTH_URL: 'https://api.example.invalid',
    DASHBOARD_URL: 'https://app.example.invalid',
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  };

  async function verifiedUser(label: string): Promise<string> {
    const email = uniqueEmail(label);
    await auth.api.signUpEmail({
      body: { email, password: 'a-very-long-password-123', name: 'Cookie Test' },
    });
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    await db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, user!.id));
    return email;
  }

  it('is HttpOnly, SameSite=Lax and Secure by default — nothing to wire, nothing to forget', async () => {
    const email = await verifiedUser('cookie-default');
    const defaultAuth = createAuth({
      db,
      env: secureEnv,
      redisDurableUrl: 'redis://localhost:6379',
      emailSender: testEmailSender,
    });
    const response = await defaultAuth.api.signInEmail({
      body: { email, password: 'a-very-long-password-123' },
      asResponse: true,
    });
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
  });

  it('drops Secure only with the explicit local-dev opt-out (allowInsecureCookies)', async () => {
    const email = await verifiedUser('cookie-optout');
    const response = await auth.api.signInEmail({
      body: { email, password: 'a-very-long-password-123' },
      asResponse: true,
    });
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    // A browser refuses to send a Secure cookie back over plain HTTP, hence the opt-out.
    expect(cookie).not.toContain('Secure');
  });

  it('refuses the local-dev opt-out under NODE_ENV=production', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() =>
        createAuth({
          db,
          env: secureEnv,
          redisDurableUrl: 'redis://localhost:6379',
          allowInsecureCookies: true,
        }),
      ).toThrow(/local-dev only/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe('createAuth — trustedOrigins is limited to the dashboard origin (auth-tenancy.md §4.1 CSRF)', () => {
  // Better Auth otherwise disables this check whenever NODE_ENV==='test' (@better-auth/core's
  // isTest(), cached at module load — see betterAuth.ts's disableOriginCheck: false comment for
  // why that default is overridden). These tests are exactly what proves that override works;
  // without it, both would report success regardless of Origin, silently.
  it('rejects a request whose Origin is not the configured dashboard origin', async () => {
    const email = uniqueEmail('origin-bad');
    await auth.api.signUpEmail({
      body: { email, password: 'a-very-long-password-123', name: 'Origin Test' },
    });
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    await db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, user!.id));

    const response = await auth.handler(
      new Request('http://localhost:3000/v1/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ email, password: 'a-very-long-password-123' }),
      }),
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe('INVALID_ORIGIN');
  });

  it('accepts a request whose Origin is the configured dashboard origin', async () => {
    const email = uniqueEmail('origin-good');
    await auth.api.signUpEmail({
      body: { email, password: 'a-very-long-password-123', name: 'Origin Test' },
    });
    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
    await db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, user!.id));

    const response = await auth.handler(
      new Request('http://localhost:3000/v1/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
        body: JSON.stringify({ email, password: 'a-very-long-password-123' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeTruthy();
  });
});

describe('createAuth — rate limiting (auth-tenancy.md §5; ADR-0019, durable Redis prefix ba:)', () => {
  it('returns 429 after exceeding the sign-in rate limit', async () => {
    // Rate limiting wraps auth.handler's own request pipeline, not the auth.api.* server helpers
    // (verified: 15 direct auth.api.signInEmail calls never triggered it) — so this test drives
    // the same path our real Fastify bridge (apps/api's authBridge.ts) uses.
    const email = uniqueEmail('rate-limit');
    let sawRateLimited = false;
    for (let i = 0; i < 15; i += 1) {
      const response = await auth.handler(
        new Request('http://localhost:3000/v1/auth/sign-in/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: 'wrong-password-but-long-enough' }),
        }),
      );
      if (response.status === 429) {
        sawRateLimited = true;
        break;
      }
    }
    expect(sawRateLimited).toBe(true);
  });
});
