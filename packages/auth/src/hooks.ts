import { isIPv4, isIPv6 } from 'node:net';
import { eq } from 'drizzle-orm';
import type { GenericEndpointContext } from 'better-auth';
import { createAuditLogRepository, schema, type Db } from '@truepath/db';

/**
 * Truncates a session IP to /24 (IPv4) or /48 (IPv6) before it is stored (SPEC §5.4,
 * auth-tenancy.md §3) — a full staff IP is never persisted. Anything that isn't a recognisable
 * IPv4/IPv6 literal is dropped entirely rather than stored as-is, since the safe default for an
 * unparseable value is "no identifier", not "store it raw".
 */
export function truncateIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  if (isIPv4(ip)) {
    const octets = ip.split('.');
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }
  if (isIPv6(ip)) {
    const groups = ip
      .split(':')
      .filter((g) => g.length > 0)
      .slice(0, 3);
    return `${groups.join(':')}::/48`;
  }
  return null;
}

/**
 * Nulls out a Google `auth_accounts` row's OAuth tokens right after Better Auth creates it
 * (auth-tenancy.md §3): we only ever request `openid email profile` and don't need the tokens
 * after sign-in, so minimise what's stored. A `databaseHooks.account.create.after` hook, since the
 * row already exists by the time this runs — it updates rather than transforms the insert.
 */
export async function nullGoogleTokensAfterCreate(
  db: Db,
  account: { id: string; providerId: string },
): Promise<void> {
  if (account.providerId !== 'google') return;
  await db
    .update(schema.authAccounts)
    .set({ accessToken: null, refreshToken: null, idToken: null })
    .where(eq(schema.authAccounts.id, account.id));
}

/**
 * Audits a Google sign-in as `login_succeeded` (issue #16). A `databaseHooks.session.create.after`
 * hook, not a generic `hooks.after` middleware: it only runs once Better Auth has actually written
 * the session, so a failed Google sign-in (bad state, no code, no email — all of which redirect via
 * `c.redirect` before session creation) never reaches it and is not audited here (see issue #16's
 * open "callback failures" question — left for a follow-up rather than guessed at).
 *
 * `ctx.path` tells apart the two ways a session is created for Google specifically: the OAuth
 * redirect round-trip finishes at the callback endpoint (`ctx.path` is its route *template*,
 * `/callback/:id` — not the resolved `/callback/google` — so the provider is read from
 * `ctx.params.id` instead, same as Better Auth's own `last-login-method` plugin does it), and a
 * client that already holds a Google ID token (Better Auth's idToken sign-in branch — enabled by
 * default for our Google provider config) completes directly at `/sign-in/social`. Neither path
 * overlaps `/sign-in/email`, which the `/v1/auth/login` wrapper already audits itself — so this can
 * never double-write a login_succeeded row for a password sign-in.
 */
export async function auditGoogleSessionCreate(
  db: Db,
  session: { userId: string },
  ctx: GenericEndpointContext | null,
): Promise<void> {
  if (!ctx) return;
  const isGoogleCallback = ctx.path === '/callback/:id' && ctx.params?.id === 'google';
  const isGoogleIdTokenSignIn = ctx.path === '/sign-in/social';
  if (!isGoogleCallback && !isGoogleIdTokenSignIn) return;
  await createAuditLogRepository(db).writePlatform({
    actorUserId: session.userId,
    actorType: 'user',
    action: 'login_succeeded',
    targetType: 'auth',
    targetId: 'login',
    metadata: { method: 'google' },
  });
}
