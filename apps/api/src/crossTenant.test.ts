import { describe, expect, it } from 'vitest';
import {
  discoverCrossTenantRoutes,
  findStaleExemptions,
  findUncoveredRoutes,
  isExemptRoute,
  substituteRouteParams,
  type RouteExemption,
} from './crossTenant.js';
import type { RouteRegistryEntry } from './routeRegistry.js';

describe('substituteRouteParams', () => {
  it('replaces every param present in the map, leaving unmapped params untouched', () => {
    expect(
      substituteRouteParams('/v1/orgs/:id/members/:userId', { id: 'org-b', userId: 'user-b' }),
    ).toBe('/v1/orgs/org-b/members/user-b');
    expect(substituteRouteParams('/v1/orgs/:id/members/:userId', { id: 'org-b' })).toBe(
      '/v1/orgs/org-b/members/:userId',
    );
  });

  it('is a no-op for a route with no params', () => {
    expect(substituteRouteParams('/healthz', { id: 'org-b' })).toBe('/healthz');
  });
});

describe('discoverCrossTenantRoutes', () => {
  const routes: RouteRegistryEntry[] = [
    { method: 'GET', url: '/healthz' },
    { method: 'GET', url: '/v1/auth/*' },
    { method: 'GET', url: '/v1/orgs' },
    { method: 'GET', url: '/v1/orgs/:id/stores' },
    { method: 'PUT', url: '/v1/orgs/:id/members/:userId' },
    { method: 'POST', url: '/v1/invites/:token/accept' },
  ];

  it('only discovers routes with a tenant-id-shaped param (auth-tenancy.md §8)', () => {
    const discovered = discoverCrossTenantRoutes(routes, { id: 'org-b', userId: 'user-b' });
    expect(discovered.map((d) => d.url)).toEqual([
      '/v1/orgs/:id/stores',
      '/v1/orgs/:id/members/:userId',
    ]);
  });

  it('excludes /healthz, the auth catch-all, and the token-based invite-accept route', () => {
    const discovered = discoverCrossTenantRoutes(routes, { id: 'org-b', userId: 'user-b' });
    expect(discovered.some((d) => d.url === '/healthz')).toBe(false);
    expect(discovered.some((d) => d.url === '/v1/auth/*')).toBe(false);
    expect(discovered.some((d) => d.url === '/v1/invites/:token/accept')).toBe(false);
  });

  it('builds the foreign-tenant URL for each discovered route', () => {
    const discovered = discoverCrossTenantRoutes(routes, { id: 'org-b', userId: 'user-b' });
    expect(discovered).toContainEqual({
      method: 'GET',
      url: '/v1/orgs/:id/stores',
      foreignUrl: '/v1/orgs/org-b/stores',
    });
    expect(discovered).toContainEqual({
      method: 'PUT',
      url: '/v1/orgs/:id/members/:userId',
      foreignUrl: '/v1/orgs/org-b/members/user-b',
    });
  });

  it('honours an allowlist entry (auth-tenancy.md §8: "opting out needs an allowlist entry")', () => {
    const discovered = discoverCrossTenantRoutes(
      routes,
      { id: 'org-b', userId: 'user-b' },
      { allowlist: ['/v1/orgs/:id/stores'] },
    );
    expect(discovered.map((d) => d.url)).toEqual(['/v1/orgs/:id/members/:userId']);
  });

  it('honours a per-route override of the foreignIds map', () => {
    const discovered = discoverCrossTenantRoutes(
      routes,
      { id: 'org-b', userId: 'user-b' },
      { overrides: { '/v1/orgs/:id/members/:userId': { id: 'org-b', userId: 'some-other-user' } } },
    );
    const overridden = discovered.find((d) => d.url === '/v1/orgs/:id/members/:userId');
    expect(overridden?.foreignUrl).toBe('/v1/orgs/org-b/members/some-other-user');
  });
});

describe('exemption registry (coverage completeness — auth-tenancy.md §8)', () => {
  const routes: RouteRegistryEntry[] = [
    { method: 'GET', url: '/healthz' },
    { method: 'GET', url: '/v1/auth/*' },
    { method: 'POST', url: '/v1/auth/*' },
    { method: 'GET', url: '/v1/orgs' },
    { method: 'GET', url: '/v1/orgs/:id/stores' },
  ];
  const exemptions: RouteExemption[] = [
    { method: 'GET', url: '/healthz', reason: 'public health check' },
    { method: '*', url: '/v1/auth/*', reason: "Better Auth's own routes" },
    { method: 'GET', url: '/v1/orgs', reason: "lists only the caller's own orgs" },
  ];

  it('isExemptRoute matches an exact method+url entry', () => {
    expect(isExemptRoute({ method: 'GET', url: '/healthz' }, exemptions)).toBe(true);
    expect(isExemptRoute({ method: 'POST', url: '/healthz' }, exemptions)).toBe(false);
  });

  it("isExemptRoute's '*' method matches any method for that url", () => {
    expect(isExemptRoute({ method: 'GET', url: '/v1/auth/*' }, exemptions)).toBe(true);
    expect(isExemptRoute({ method: 'POST', url: '/v1/auth/*' }, exemptions)).toBe(true);
    expect(isExemptRoute({ method: 'DELETE', url: '/v1/auth/*' }, exemptions)).toBe(true);
  });

  it('findUncoveredRoutes returns only routes that are neither tenant-scoped nor exempt', () => {
    // /v1/orgs/:id/stores is tenant-scoped (has :id) so it's covered without an exemption entry.
    expect(findUncoveredRoutes(routes, exemptions)).toEqual([]);
  });

  it('findUncoveredRoutes catches a route with neither coverage path', () => {
    const withGap: RouteRegistryEntry[] = [...routes, { method: 'GET', url: '/v1/whoami' }];
    expect(findUncoveredRoutes(withGap, exemptions)).toEqual([
      { method: 'GET', url: '/v1/whoami' },
    ]);
  });

  it('findStaleExemptions is empty when every entry matches a real route', () => {
    expect(findStaleExemptions(routes, exemptions)).toEqual([]);
  });

  it('findStaleExemptions flags an entry for a route that no longer exists', () => {
    const withoutOrgsList = routes.filter((r) => !(r.method === 'GET' && r.url === '/v1/orgs'));
    expect(findStaleExemptions(withoutOrgsList, exemptions)).toEqual([
      { method: 'GET', url: '/v1/orgs', reason: "lists only the caller's own orgs" },
    ]);
  });
});
