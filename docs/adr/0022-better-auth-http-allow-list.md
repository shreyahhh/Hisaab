# 0022. Better Auth's HTTP routes are an allow-list; a route joins only in the change that audits it

## Status
Accepted (2026-09-26). Narrows the `/v1/auth/*` line of SPEC §10 and auth-tenancy.md §2.1 for now; nothing in an Accepted ADR is reversed.

## Context
`apps/api` mounted Better Auth's handler as a catch-all under `/v1/auth/*`. Better Auth 1.7.6 with our
config and plugins has 52 HTTP paths (54 method+path pairs), most of which do something audit-worthy: change or
reset a password, revoke sessions, link accounts, delete an organization. Only our own wrapper routes write
audit rows; nothing in Better Auth's routes does. Probing showed what a catch-all exposes:

- `POST /organization/delete` deletes an organization immediately (200, no audit row), bypassing the
  export, 7-day grace and audit flow (auth-tenancy.md §4.6, issue #8).
- `POST /sign-in/email` bypasses our per-email limiter and the login audit.
- Native `accept-invitation` bypasses our inviter re-validation.

Most of this is currently masked by an unrelated bug: the bridge drops JSON request bodies (Fastify
consumes them before Better Auth's raw handler runs), so every native POST with a body fails with a 400. Fixing
that bug, which Google sign-in and password reset need, would have switched all of it on at once.

## Decision
1. **Allow-list, not catch-all.** The bridge registers one Fastify route per entry in `EXPOSED_AUTH_ROUTES`
   (`packages/auth/src/exposure.ts`). Today that is `GET /v1/auth/get-session`, `/ok` and `/error`. Any other
   path is a `404`.
2. **A route joins the allow-list only in the same change that audits it** (catalogue action, metadata schema,
   migration, `AUDIT_ACTION_OWNERS`), or that shows it needs no audit row, with the reason recorded next to the
   entry. The reason feeds the cross-tenant exemption registry, so each bridged route is individually justified.
3. **Defence in depth.** Every concrete Better Auth path not on the list is in `DISABLED_AUTH_PATHS`, passed to
   Better Auth's `disabledPaths`, so it refuses them even if the bridge is mistaken. Paths that carry a parameter
   (`/reset-password/:token`) can't be listed there and rely on the allow-list. `disableOrganizationDeletion: true`
   is set, since deletion is our own audited flow.
4. **A test enumerates Better Auth.** `apps/api/src/authBridge.test.ts` walks every endpoint in `auth.api` and
   asserts that only allow-listed ones are reachable through the app, that every path is exposed or disabled, and
   that Better Auth's own router refuses each disabled one. A Better Auth upgrade or a new plugin that adds an
   endpoint fails it until someone decides.
5. Our own routes (`/v1/auth/signup|login|logout`, `/v1/orgs/...`) call `auth.api.*` directly, which never goes
   through the HTTP router, so neither list affects them.

## Consequences
- Google sign-in, email verification, password reset and change, and session revocation are unavailable until
  the follow-up (#16; each with new catalogue actions, migrations and audit through the fallback path of ADR-0021).
  SPEC §10 lists them; this defers them, it does not drop them.
- The CSRF hook now covers our `/v1/auth` wrappers. Previously an early return for `/v1/auth/` skipped it, on the
  premise that Better Auth enforces its own origin check, but the wrappers call `auth.api` directly and skip that
  check, so a POST to login, signup or logout from another origin was processed.
- Adding or upgrading Better Auth needs a deliberate edit to `exposure.ts` when it adds endpoints.
