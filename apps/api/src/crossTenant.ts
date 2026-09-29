import { AUTH_BASE_PATH, EXPOSED_AUTH_ROUTES } from '@truepath/auth';
import { isTenantScopedRoute, type HttpMethod, type RouteRegistryEntry } from './routeRegistry.js';

// Route-side half of the generated cross-tenant check (SPEC §5.10 test 7; auth-tenancy.md §8).
// Pure functions so the discovery/substitution logic is unit-testable without a live app, and
// reused as-is by the integration harness below and by every future ticket that adds routes.

export interface ForeignIdMap {
  readonly id?: string;
  readonly orgId?: string;
  readonly storeId?: string;
  readonly userId?: string;
  readonly orderId?: string;
  readonly rid?: string;
}

/** Replaces every `:paramName` in `url` that has an entry in `foreignIds`; leaves the rest as-is. */
export function substituteRouteParams(url: string, foreignIds: ForeignIdMap): string {
  return url.replace(/:(\w+)/g, (match, name: string) => {
    const value = (foreignIds as Record<string, string | undefined>)[name];
    return value ?? match;
  });
}

export interface DiscoveredCrossTenantRoute {
  readonly method: HttpMethod;
  readonly url: string;
  readonly foreignUrl: string;
}

export interface DiscoverCrossTenantRoutesOptions {
  /** URLs to skip entirely (auth-tenancy.md §8: "opting out needs an allowlist entry"). */
  readonly allowlist?: readonly string[];
  /** Per-URL override of the default foreignIds map, for a route where it doesn't apply. */
  readonly overrides?: Readonly<Record<string, ForeignIdMap>>;
}

/**
 * Discovers every tenant-scoped route (one with an `:id`/`:orgId`/`:storeId`/`:rid`/`:orderId`/
 * `:userId` param — auth-tenancy.md §8) from a built app's `routeRegistry`, and builds the URL a
 * cross-tenant caller would hit by substituting tenant B's ids for those params. New routes are
 * covered the moment they're registered — nothing here is a hand-maintained list of routes.
 */
export function discoverCrossTenantRoutes(
  routes: readonly RouteRegistryEntry[],
  foreignIds: ForeignIdMap,
  options: DiscoverCrossTenantRoutesOptions = {},
): DiscoveredCrossTenantRoute[] {
  const allowlist = new Set(options.allowlist ?? []);
  return routes
    .filter((route) => isTenantScopedRoute(route.url) && !allowlist.has(route.url))
    .map((route) => ({
      method: route.method,
      url: route.url,
      foreignUrl: substituteRouteParams(route.url, options.overrides?.[route.url] ?? foreignIds),
    }));
}

// --- Exemption registry -----------------------------------------------------------------------
//
// A route with no `:id`-shaped param is silently skipped by discoverCrossTenantRoutes above —
// that's right for genuinely tenant-agnostic routes (a health check, "create an org") but wrong if
// a future route just happens not to use one of the recognised param names. So every registered
// route must be either discovered above (tenant-scoped) or listed here with a reason; a route that
// is neither is a coverage gap, and coverageTest.ts below fails the build on one instead of the
// route silently going unchecked. This is the other reason EXEMPT_ROUTES itself can't be a random
// hand-maintained pile: findStaleExemptions() fails if an entry no longer matches a real route, so
// dead exemptions don't linger once the route they described is renamed or removed.

export interface RouteExemption {
  readonly method: HttpMethod | '*';
  readonly url: string;
  readonly reason: string;
}

export const EXEMPT_ROUTES: readonly RouteExemption[] = [
  // Fastify auto-registers a HEAD handler mirroring every GET route (same handler, no body), so
  // each GET exemption below needs a matching HEAD entry too — a tenant-scoped GET's HEAD variant
  // needs no such entry, because isTenantScopedRoute() looks only at the URL, not the method, so
  // discoverCrossTenantRoutes already picks it up and the harness exercises it directly.
  { method: 'GET', url: '/healthz', reason: 'Public health check; carries no tenant data.' },
  {
    method: 'HEAD',
    url: '/healthz',
    reason: 'Fastify-generated HEAD mirror of GET /healthz.',
  },
  // The Better Auth routes we bridge, one entry each (ADR-0022): the reason comes from the allow-list
  // itself, so a route can't be exposed without saying why it needs no tenant scope.
  ...EXPOSED_AUTH_ROUTES.flatMap((route): RouteExemption[] => [
    { method: route.method, url: `${AUTH_BASE_PATH}${route.path}`, reason: route.reason },
    {
      method: 'HEAD',
      url: `${AUTH_BASE_PATH}${route.path}`,
      reason: `Fastify-generated HEAD mirror of GET ${AUTH_BASE_PATH}${route.path}.`,
    },
  ]),
  {
    method: 'OPTIONS',
    url: '*',
    reason: "@fastify/cors's global CORS-preflight responder; not a data-bearing route.",
  },
  {
    method: 'POST',
    url: '/v1/auth/signup',
    reason: 'Public, pre-session — nothing to scope yet.',
  },
  { method: 'POST', url: '/v1/auth/login', reason: 'Public, pre-session — nothing to scope yet.' },
  {
    method: 'POST',
    url: '/v1/auth/logout',
    reason: "Acts on the caller's own session only; no id param.",
  },
  {
    method: 'GET',
    url: '/v1/me',
    reason: "Returns only the caller's own user/memberships; no id param.",
  },
  {
    method: 'HEAD',
    url: '/v1/me',
    reason: 'Fastify-generated HEAD mirror of GET /v1/me.',
  },
  {
    method: 'POST',
    url: '/v1/orgs',
    reason: 'Creates a new organization — no existing tenant resource to leak.',
  },
  {
    method: 'GET',
    url: '/v1/orgs',
    reason: 'Lists only organizations the caller is already a member of; no id param.',
  },
  {
    method: 'HEAD',
    url: '/v1/orgs',
    reason: 'Fastify-generated HEAD mirror of GET /v1/orgs.',
  },
  {
    method: 'POST',
    url: '/v1/invites/:token/accept',
    reason:
      "The :token is a single-use invitation id (a capability), not an enumerable tenant resource id. Redeeming another organization's invitation is governed by Better Auth's invited-email match, not TenantScope, and that property is exercised directly in routeRbac.test.ts rather than by substituting a foreign id here.",
  },
  {
    method: 'POST',
    url: '/webhooks/shopify/:topic',
    reason:
      'Authenticated by Shopify’s per-request HMAC signature over the raw body, not a session — the store is resolved from a verified shop domain inside the handler (ADR-0024, shopify-integration.md §4.2), never from a caller-supplied id. Covered by shopifyWebhooks.test.ts, not the generated harness.',
  },
  {
    method: 'GET',
    url: '/v1/integrations/shopify/callback',
    reason:
      "Deliberately flat, no :id (ADR-0024/ADR-0025): Shopify's redirect_uri must be one fixed, pre-registered URL, so tenant binding comes from the signed single-use state token plus a live-session check, not a path param. Its rejection paths are covered individually in shopifyOAuthCallback.test.ts, not the generated harness.",
  },
  {
    method: 'HEAD',
    url: '/v1/integrations/shopify/callback',
    reason: 'Fastify-generated HEAD mirror of GET /v1/integrations/shopify/callback.',
  },
  {
    method: 'GET',
    url: '/v1/system/status',
    reason:
      'Queue depths and the suppress:ready marker carry no store or shopper identifier — any signed-in user may view it (dashboard System status page).',
  },
  {
    method: 'HEAD',
    url: '/v1/system/status',
    reason: 'Fastify-generated HEAD mirror of GET /v1/system/status.',
  },
];

export function isExemptRoute(
  route: RouteRegistryEntry,
  exemptions: readonly RouteExemption[] = EXEMPT_ROUTES,
): boolean {
  return exemptions.some(
    (e) => e.url === route.url && (e.method === '*' || e.method === route.method),
  );
}

/** Registered routes that are neither tenant-scope-discovered nor exempt — a coverage gap. */
export function findUncoveredRoutes(
  routes: readonly RouteRegistryEntry[],
  exemptions: readonly RouteExemption[] = EXEMPT_ROUTES,
): RouteRegistryEntry[] {
  return routes.filter(
    (route) => !isTenantScopedRoute(route.url) && !isExemptRoute(route, exemptions),
  );
}

/** Exemption entries that no longer match any registered route — dead documentation. */
export function findStaleExemptions(
  routes: readonly RouteRegistryEntry[],
  exemptions: readonly RouteExemption[] = EXEMPT_ROUTES,
): RouteExemption[] {
  return exemptions.filter(
    (e) =>
      !routes.some(
        (route) => route.url === e.url && (e.method === '*' || e.method === route.method),
      ),
  );
}
