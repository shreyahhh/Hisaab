import { isIPv4, isIPv6 } from 'node:net';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@truepath/db';

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
