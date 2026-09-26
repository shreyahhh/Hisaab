import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createStoreRepository, resolveStoreOrganization, type Db } from '@truepath/db';
import { resolveMembership, type Auth } from '@truepath/auth';
import { can, type Permission, type TenantScope } from '@truepath/shared';
import { authCall } from './authCall.js';

declare module 'fastify' {
  interface FastifyRequest {
    scope?: TenantScope;
    userId?: string;
  }
}

export interface TenantScopeDeps {
  readonly auth: Auth;
  readonly db: Db;
}

export type Session = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>;

/**
 * `auth.api.getSession(headers)` → `request.userId`, or a `401` (auth-tenancy.md §4.3 step 1).
 * Returns the full session (`{ user, session }`), or `undefined` after already sending the 401.
 */
export async function requireSession(
  deps: TenantScopeDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Session | undefined> {
  const session = await authCall(() =>
    deps.auth.api.getSession({ headers: fromNodeHeaders(request.headers) }),
  );
  if (!session) {
    await reply.code(401).send({ error: 'unauthenticated' });
    return undefined;
  }
  request.userId = session.user.id;
  return session;
}

/**
 * Builds `request.scope` for a `:id`-as-organizationId route (auth-tenancy.md §4.3 steps 1–3): no
 * membership for `(user, org)` → `404`, never `403` — cross-tenant existence is never disclosed
 * (SPEC §5.10 test 7). `storeIds` is populated from every store under the organization via the
 * scoped repository, using a scope that already carries the right `organizationId` (the
 * repository only asserts `organizationId`, so this is not a bootstrap exception).
 */
export function requireOrgScope(deps: TenantScopeDeps) {
  return async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const session = await requireSession(deps, request, reply);
    if (!session) return;
    const userId = session.user.id;

    const organizationId = request.params.id;
    const membership = await resolveMembership(deps.db, userId, organizationId);
    if (!membership) {
      await reply.code(404).send({ error: 'not_found' });
      return;
    }

    const stores = await createStoreRepository(deps.db).listByOrganization(
      { kind: 'tenant', userId, organizationId, role: membership.role, storeIds: new Set() },
      organizationId,
    );
    request.scope = {
      kind: 'tenant',
      userId,
      organizationId,
      role: membership.role,
      storeIds: new Set(stores.map((s) => s.id)),
    };
  };
}

// A store id that can never match a real membership row — used so the "store doesn't exist" and
// "store exists, but in an organization the caller isn't a member of" branches below run the exact
// same query pattern and can't be told apart by response, status, or (roughly) timing.
const NEVER_MATCHES_ORGANIZATION_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Builds `request.scope` for a `:storeId` route (auth-tenancy.md §4.3 step 2b). Uses the one
 * bootstrap primitive outside the scoped repository layer, `resolveStoreOrganization` (ADR-0016)
 * — lint-restricted (eslint.config.js) to this file alone — to map the store to its organization
 * before any scope exists, then checks membership exactly as `requireOrgScope` does.
 *
 * Both `resolveStoreOrganization` returning `null` (no such store) and it returning a real
 * organization the caller has no membership in always run the *same two queries* and produce the
 * *same* `404 {error: 'not_found'}` — a non-existent store id is indistinguishable from a foreign
 * one, by design (SPEC §5.10 test 7: cross-tenant existence is never disclosed).
 */
export function requireStoreScope(deps: TenantScopeDeps) {
  return async (
    request: FastifyRequest<{ Params: { storeId: string } }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const session = await requireSession(deps, request, reply);
    if (!session) return;
    const userId = session.user.id;

    const organizationId = await resolveStoreOrganization(deps.db, request.params.storeId);
    const membership = await resolveMembership(
      deps.db,
      userId,
      organizationId ?? NEVER_MATCHES_ORGANIZATION_ID,
    );

    if (!organizationId || !membership) {
      await reply.code(404).send({ error: 'not_found' });
      return;
    }

    request.scope = {
      kind: 'tenant',
      userId,
      organizationId,
      role: membership.role,
      storeIds: new Set([request.params.storeId]),
    };
  };
}

/** `can(request.scope, permission)` → `403`. Must run after a scope-building preHandler. */
export function requirePermission(permission: Permission) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const scope = request.scope;
    if (!scope) {
      await reply.code(500).send({ error: 'scope_not_built' });
      return;
    }
    if (!can(scope, permission)) {
      await reply.code(403).send({ error: 'forbidden_role' });
    }
  };
}
