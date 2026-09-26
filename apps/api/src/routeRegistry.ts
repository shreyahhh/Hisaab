import type { FastifyInstance } from 'fastify';

// Fastify's own HTTPMethods type is intentionally widened (`Autocomplete<...>`, effectively `|
// string`) for its route-declaration API, which doesn't structurally match light-my-request's
// plainer method union used by `app.inject()`. Every route in this codebase is registered with an
// explicit uppercase method, so a plain literal union here is both accurate and inject()-compatible.
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

// Populated automatically from Fastify's own `onRoute` lifecycle hook — never hand-maintained —
// so the generated cross-tenant test (SPEC §5.10 test 7) discovers every registered route,
// including ones added by later tickets, without anyone remembering to list it (auth-tenancy.md §8).
export interface RouteRegistryEntry {
  readonly method: HttpMethod;
  readonly url: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    routeRegistry: RouteRegistryEntry[];
  }
}

export function registerRouteRegistry(app: FastifyInstance): void {
  const routes: RouteRegistryEntry[] = [];
  app.decorate('routeRegistry', routes);
  app.addHook('onRoute', (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    for (const method of methods) {
      routes.push({ method: method as HttpMethod, url: routeOptions.url });
    }
  });
}

/** Route params that identify a tenant resource (auth-tenancy.md §8 test plan). */
const TENANT_ID_PARAMS = [':id', ':orgId', ':storeId', ':rid', ':orderId', ':userId'];

export function isTenantScopedRoute(url: string): boolean {
  return TENANT_ID_PARAMS.some((param) => url.includes(param));
}
