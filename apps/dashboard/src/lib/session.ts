import { useQuery } from '@tanstack/react-query';
import type { Role } from '@truepath/shared';
import { api, type Me } from './api';

export const meQueryKey = ['me'] as const;

export function useMe() {
  return useQuery<Me>({ queryKey: meQueryKey, queryFn: api.me });
}

/** The signed-in user's role in `organizationId`, or undefined if they aren't a member. */
export function useRoleInOrg(
  me: Me | undefined,
  organizationId: string | undefined,
): Role | undefined {
  if (!me || !organizationId) return undefined;
  return me.memberships.find((m) => m.organizationId === organizationId)?.role;
}

// UI convenience only (dashboard.md §3): remembers the last-viewed org so a returning visit lands
// somewhere useful. Never a source of truth for authorization — every route still re-derives the
// role from `useMe()` server data.
const LAST_ORG_KEY = 'truepath:last-org-id';

export function rememberLastOrg(organizationId: string): void {
  try {
    localStorage.setItem(LAST_ORG_KEY, organizationId);
  } catch {
    // Private browsing / storage disabled — losing this preference is harmless.
  }
}

export function lastRememberedOrg(): string | null {
  try {
    return localStorage.getItem(LAST_ORG_KEY);
  } catch {
    return null;
  }
}
