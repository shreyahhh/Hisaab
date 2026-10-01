import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins/organization';
import { redisStorage } from '@better-auth/redis-storage';
import { Redis } from 'ioredis';
import { createAuditLogRepository, schema, type Db } from '@truepath/db';
import type { AuthEnv } from '@truepath/shared';
import { ac, adminRole, analystRole, ownerRole, viewerRole } from './accessControl.js';
import { noopEmailSender, type AuthEmailSender } from './email.js';
import { AUTH_BASE_PATH, DISABLED_AUTH_PATHS } from './exposure.js';
import { nullGoogleTokensAfterCreate, truncateIp } from './hooks.js';

export type { AuthEnv };

// The Drizzle adapter looks up `config.schema[modelName]` by exact key (verified against
// @better-auth/drizzle-adapter@1.7.6's implementation), so this must be keyed by the snake_case
// modelName strings configured below (auth-tenancy.md §2.2/§3), not packages/db's camelCase export
// names.
const authDrizzleSchema = {
  users: schema.users,
  auth_accounts: schema.authAccounts,
  sessions: schema.sessions,
  auth_tokens: schema.authTokens,
  organizations: schema.organizations,
  memberships: schema.memberships,
  invites: schema.invites,
};

export interface CreateAuthOptions {
  readonly db: Db;
  readonly env: AuthEnv;
  /**
   * Rate-limit counters live on the **durable** Redis, not the cache instance (ADR-0019,
   * superseding ADR-0012's original "cache Redis" placement): the cache instance is
   * `allkeys-lru` and can evict a counter under memory pressure, silently disabling rate
   * limiting for that key. The durable instance is `noeviction`, so a counter is never evicted
   * — it only ever goes away via the TTL `@better-auth/redis-storage` sets on every key
   * (`EXPIRE`/`SETEX`), which still bounds its lifetime to the rate-limit window.
   */
  readonly redisDurableUrl: string;
  /**
   * Session cookies are `Secure` unless this is set — so a deployment that forgets to wire
   * anything fails closed (cookies over HTTPS only) rather than open. Local dev over plain HTTP
   * is the only reason to set it, and `createAuth` refuses to when NODE_ENV is "production".
   */
  readonly allowInsecureCookies?: boolean;
  /**
   * Turns Better Auth's `disabledPaths` off so a test can drive its HTTP handler (origin check, rate
   * limiter) through paths the API doesn't expose (ADR-0022). Test-only: like `allowInsecureCookies`,
   * `createAuth` refuses it when NODE_ENV is "production".
   */
  readonly exposeAllPathsForTests?: boolean;
  /** Set only once a real registrable domain exists, to enable crossSubDomainCookies (app.<d>/api.<d>). */
  readonly cookieDomain?: string;
  /** SES wiring lands in a later ticket; defaults to a logging no-op (email.ts). */
  readonly emailSender?: AuthEmailSender;
}

/** Builds the Better Auth instance (ADR-0012, auth-tenancy.md §2.2). */
export function createAuth(options: CreateAuthOptions) {
  const { db, env } = options;
  if (options.allowInsecureCookies && process.env.NODE_ENV === 'production') {
    throw new Error(
      'createAuth: allowInsecureCookies is local-dev only and cannot be set in production',
    );
  }
  if (options.exposeAllPathsForTests && process.env.NODE_ENV === 'production') {
    throw new Error(
      'createAuth: exposeAllPathsForTests is test-only and cannot be set in production',
    );
  }
  const emailSender = options.emailSender ?? noopEmailSender;
  const redis = new Redis(options.redisDurableUrl);

  return betterAuth({
    database: drizzleAdapter(db, { provider: 'pg', schema: authDrizzleSchema }),
    basePath: AUTH_BASE_PATH,
    // Defence in depth behind the bridge's allow-list (exposure.ts, ADR-0022). Only affects Better
    // Auth's HTTP router: the `auth.api.*` calls our own routes make are unaffected.
    disabledPaths: options.exposeAllPathsForTests ? [] : [...DISABLED_AUTH_PATHS],
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    advanced: {
      database: { generateId: 'uuid' },
      // Behind one ALB hop (HLD §7); used only for Better Auth's own rate limiting.
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
      useSecureCookies: !options.allowInsecureCookies,
      // Better Auth otherwise disables its own origin/CSRF check whenever it detects a test
      // environment (`isTest()`: NODE_ENV==='test' — @better-auth/core's env-impl.ts, cached at
      // module load, so it can't be toggled per-instance at runtime). trustedOrigins is a real
      // security boundary (auth-tenancy.md §4.1); it must never be silently off just because
      // NODE_ENV happens to read "test" somewhere, so this is set explicitly rather than left to
      // that default.
      disableOriginCheck: false,
      ...(options.cookieDomain
        ? { crossSubDomainCookies: { enabled: true, domain: options.cookieDomain } }
        : {}),
    },
    trustedOrigins: [env.DASHBOARD_URL],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      requireEmailVerification: true,
      // Issue #16: audited here, not in a Fastify route — /request-password-reset and
      // /reset-password are bridged straight to Better Auth's own HTTP router (ADR-0022), which
      // runs outside our route handlers entirely, so these lifecycle callbacks are the only place
      // that sees a real, found user. Better Auth calls sendResetPassword only when the email
      // matches an account (an unknown email gets its own generic, unaudited response), and
      // onPasswordReset only after the token is verified, consumed and the password actually
      // changed — so there is nothing to additionally gate here, and metadata is target_user_id
      // only (never the email, privacy-dpdp.md's audit rule).
      sendResetPassword: async ({ user, url }) => {
        await emailSender.sendPasswordReset({ to: user.email, url });
        await createAuditLogRepository(db).writePlatform({
          actorType: 'user',
          action: 'password_reset_requested',
          targetType: 'auth',
          targetId: 'password_reset',
          metadata: { target_user_id: user.id },
        });
      },
      onPasswordReset: async ({ user }) => {
        await createAuditLogRepository(db).writePlatform({
          actorUserId: user.id,
          actorType: 'user',
          action: 'password_reset_completed',
          targetType: 'auth',
          targetId: 'password_reset',
          metadata: { target_user_id: user.id },
        });
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) =>
        emailSender.sendVerificationEmail({ to: user.email, url }),
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        scope: ['openid', 'email', 'profile'],
      },
    },
    session: {
      modelName: 'sessions',
      expiresIn: 60 * 60 * 24 * 14, // 14-day sliding
      updateAge: 60 * 60 * 24,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 10,
      storage: 'secondary-storage',
    },
    secondaryStorage: redisStorage({ client: redis, keyPrefix: 'ba:' }),
    user: { modelName: 'users' },
    account: { modelName: 'auth_accounts' },
    verification: { modelName: 'auth_tokens' },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => ({
            data: { ...session, ipAddress: truncateIp(session.ipAddress) },
          }),
        },
      },
      account: {
        create: {
          after: async (account) => nullGoogleTokensAfterCreate(db, account),
        },
      },
    },
    plugins: [
      organization({
        schema: {
          organization: { modelName: 'organizations' },
          member: { modelName: 'memberships' },
          invitation: { modelName: 'invites' },
        },
        ac,
        roles: { owner: ownerRole, admin: adminRole, analyst: analystRole, viewer: viewerRole },
        invitationExpiresIn: 60 * 60 * 24 * 7, // 7 days (plugin default is 48h)
        sendInvitationEmail: async (data) =>
          emailSender.sendInvitation({
            to: data.email,
            url: `${env.DASHBOARD_URL}/invite/${data.id}`,
            organizationName: data.organization.name,
          }),
        allowUserToCreateOrganization: true,
        // Deleting an organization is our own audited, 7-day-grace flow (DELETE /v1/orgs/:id, issue #8),
        // never Better Auth's immediate one.
        disableOrganizationDeletion: true,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
