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
  readonly method: 'GET' | 'POST';
  /** Relative to AUTH_BASE_PATH. May carry a `:param` (Fastify route syntax). */
  readonly path: string;
  /**
   * Why it is safe to expose. For a read-only route, why it needs no audit row (goes into the
   * cross-tenant exemption registry too). For a state-changing route, where its audit row actually
   * comes from — Better Auth's HTTP router runs outside our Fastify route handlers, so these can't
   * call `deps.audit.*` directly; they audit via a `databaseHooks`/lifecycle callback in
   * `packages/auth/src/betterAuth.ts` instead (issue #16).
   */
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
  {
    method: 'POST',
    path: '/request-password-reset',
    reason:
      'Audited as password_reset_requested via the sendResetPassword hook (betterAuth.ts), written only when a real user is found — an unknown email gets Better Auth\'s own generic, unaudited "if this email exists" response, so no attempt is ever recorded against an email that was never a real account.',
  },
  {
    method: 'GET',
    path: '/reset-password/:token',
    reason:
      "The emailed link's redirect target: validates the token exists and isn't expired, then 302s to the dashboard's own reset page (or an error page) with it in the query string. Read-only — nothing is consumed or changed — same class as /error.",
  },
  {
    method: 'POST',
    path: '/reset-password',
    reason:
      'Audited as password_reset_completed via the onPasswordReset hook (betterAuth.ts), which only fires after the token is verified, consumed and the password actually changed — an invalid/expired token never reaches it.',
  },
  {
    method: 'POST',
    path: '/send-verification-email',
    reason:
      'Resends the verification email for any syntactically valid address, with a constant-time response so an unknown or already-verified email is indistinguishable from a real, unverified one — same no-enumeration shape as /request-password-reset. No state changes, so nothing to audit here; the completion is audited at /verify-email.',
  },
  {
    method: 'GET',
    path: '/verify-email',
    reason:
      'Audited as email_verified via the afterEmailVerification hook (betterAuth.ts), which only fires once the token is verified and emailVerified is actually set — an invalid/expired token redirects or 401s before reaching it. requireEmailVerification: true means this is also the only way a real signup can ever complete — it could not safely stay disabled.',
  },
  {
    method: 'POST',
    path: '/change-password',
    reason:
      "Audited as password_changed via the generic hooks.after middleware (betterAuth.ts), matched on ctx.path — the only place that sees it, since this runs through Better Auth's own HTTP router (ADR-0022). Unlike the plugin-level callbacks the other routes above use, this hook runs whether or not the endpoint succeeded, so it explicitly skips when ctx.context.returned is an APIError (a wrong currentPassword) before writing anything. revokeOtherSessions is the client-supplied request body flag Better Auth already honours; metadata records only whether it was set, never the password.",
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
  // /request-password-reset, /reset-password (+ /reset-password/:token, which this list can't hold
  // a literal match for), /send-verification-email, /verify-email and /change-password are exposed
  // and audited (issue #16) — see EXPOSED_AUTH_ROUTES.
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
