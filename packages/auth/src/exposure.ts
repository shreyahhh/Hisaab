// Which of Better Auth's HTTP routes this API exposes (ADR-0022). Better Auth ships ~50 endpoints,
// most of which do something audit-worthy (change a password, revoke a session, delete an
// organization) that only our own routes audit. So exposure is an allow-list: a route is reachable
// only if it is listed in EXPOSED_AUTH_ROUTES, and a route joins that list only in the same change
// that audits it. Everything else is a 404, twice over: the Fastify bridge registers only these
// routes (apps/api/src/authBridge.ts), and Better Auth itself refuses every path in
// DISABLED_AUTH_PATHS.
//
// Our own wrappers (`/v1/auth/signup|login|logout`, `/v1/orgs/...`) call `auth.api.*` directly, which
// never goes through Better Auth's HTTP router, so neither list affects them.

export const AUTH_BASE_PATH = '/v1/auth';

export interface ExposedAuthRoute {
  readonly method: 'GET';
  /** Relative to AUTH_BASE_PATH. */
  readonly path: string;
  /** Why it is safe to expose without an audit row; goes into the cross-tenant exemption registry. */
  readonly reason: string;
}

export const EXPOSED_AUTH_ROUTES = [
  {
    method: 'GET',
    path: '/get-session',
    reason:
      "Reads the caller's own session (null when signed out); read-only, no id param, returns no other tenant's data. Reading your own session is not an S-4 event.",
  },
  {
    method: 'GET',
    path: '/ok',
    reason: "Better Auth's liveness probe; static response, no data.",
  },
  {
    method: 'GET',
    path: '/error',
    reason: "Better Auth's static error page for OAuth redirects; no data, no state change.",
  },
] as const satisfies readonly ExposedAuthRoute[];

/**
 * Better Auth's `disabledPaths` (relative to AUTH_BASE_PATH, exact match): every concrete path we
 * don't use. Defence in depth behind the allow-list, so a bridge mistake still can't reach them.
 * Two paths can't be listed because they carry a parameter and `disabledPaths` matches literally —
 * `/callback/:id` (only `/callback/google` is concrete, and is listed) and `/reset-password/:token`;
 * those are covered by the allow-list alone. authBridge.test.ts fails if Better Auth gains a path
 * that is in neither list, so an upgrade or a new plugin can't add a route silently.
 */
export const DISABLED_AUTH_PATHS = [
  // Sign-in and sign-up: our wrappers (/v1/auth/login, /signup) do these, with our rate limits and audit.
  '/sign-in/email',
  '/sign-in/social',
  '/sign-up/email',
  '/sign-out',
  '/callback/google',
  // Sessions and accounts.
  '/list-sessions',
  '/list-accounts',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/update-session',
  '/account-info',
  '/link-social',
  '/unlink-account',
  '/get-access-token',
  '/refresh-token',
  '/verify-password',
  // Password, email and profile.
  '/change-password',
  '/request-password-reset',
  '/reset-password',
  '/send-verification-email',
  '/verify-email',
  '/change-email',
  '/update-user',
  '/delete-user',
  '/delete-user/callback',
  // Organizations: our /v1/orgs routes do these, audited. Deleting one is issue #8's flow.
  '/organization/create',
  '/organization/update',
  '/organization/delete',
  '/organization/check-slug',
  '/organization/set-active',
  '/organization/list',
  '/organization/get-organization',
  '/organization/get-full-organization',
  '/organization/has-permission',
  '/organization/invite-member',
  '/organization/accept-invitation',
  '/organization/reject-invitation',
  '/organization/cancel-invitation',
  '/organization/get-invitation',
  '/organization/list-invitations',
  '/organization/list-user-invitations',
  '/organization/list-members',
  '/organization/get-active-member',
  '/organization/get-active-member-role',
  '/organization/update-member-role',
  '/organization/remove-member',
  '/organization/leave',
] as const;
