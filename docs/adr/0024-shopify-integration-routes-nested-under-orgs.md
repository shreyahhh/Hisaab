# 0024. Shopify connect/disconnect routes are nested under `/v1/orgs/:id/integrations`

## Status
Accepted (2026-09-27). Narrows SPEC §10's flat `/v1/integrations/shopify/connect?orgId=&shop=` and
`DELETE /v1/integrations/:id` for now, the same way ADR-0022 narrowed `/v1/auth/*`; nothing in an
Accepted ADR is reversed.

## Context
SPEC §10 lists the Shopify connect endpoint as a top-level `/v1/integrations/shopify/connect?orgId=&shop=`
and `DELETE /v1/integrations/:id`, with the organization identified only by a query parameter. Every other
tenant-scoped route in this codebase (`/v1/orgs/:id/stores`, `/v1/orgs/:id/audit-log`,
`/v1/orgs/:id/members/:userId`, …) identifies its organization from a path param and is scoped by the
`requireOrgScope` preHandler, which the generated cross-tenant harness (`crossTenant.ts`,
`crossTenantHarness.test.ts`) discovers automatically from `routeRegistry` by recognising `:id` in the URL.
A bare `/v1/integrations/shopify/connect?orgId=` route would need its own bespoke membership check
(`orgId` isn't a path param the harness's `isTenantScopedRoute`/`discoverCrossTenantRoutes` recognise), and
`DELETE /v1/integrations/:id` would need a new bootstrap primitive (`resolveIntegrationStoreOrganization`,
mirroring `resolveStoreOrganization`) purely to get from an integration id back to its organization before
a scope exists.

## Decision
- **`GET /v1/orgs/:id/integrations/shopify/connect?shop=`** replaces the flat connect path. `orgId` moves
  from a query param to the existing `:id` path param, reusing `requireOrgScope` +
  `requirePermission('integrations.manage')` exactly as every other org-scoped route does. This route is
  one **we** call (the dashboard hits our own API to start the flow), so it is not subject to Shopify's own
  URL constraints.
- **`GET /v1/integrations/shopify/callback` stays a flat, fixed path — it is *not* nested under
  `/v1/orgs/:id`.** Shopify requires the `redirect_uri` sent to `/admin/oauth/authorize` to exactly match
  one pre-registered URL in the app's configuration, on the same host as the app's own Application URL —
  there is no wildcard or templated path, so it cannot carry a per-organization segment (an org id we don't
  and can't know in advance, since we don't control which orgs will exist). The callback's tenant binding
  comes entirely from ADR-0025's signed state token (`userId`, `organizationId`, `shop`, single-use nonce)
  plus a live session check that the signed-in user matches — which is a **stronger** binding than a path
  param would give, since it also catches a session/state mismatch a bare `:id` route could not. This one
  endpoint is therefore unchanged from SPEC §10's flat shape (`GET /v1/integrations/shopify/callback`,
  minus the `?orgId=` query param, which the state token replaces).
- **`DELETE /v1/orgs/:id/integrations/:integrationId`** replaces `DELETE /v1/integrations/:id`. This route
  is caller-initiated (the dashboard), not a Shopify redirect target, so the same reasoning as `connect`
  applies. The handler looks the integration up **within** the already-established org scope (`WHERE
  organization_id = ? AND id = ?`, scoped through `stores`), so a foreign integration id under the caller's
  own org id is a same-shape 404 as a foreign org id — no new bootstrap primitive, no
  `resolveIntegrationStoreOrganization`.
- The generated cross-tenant harness covers `connect` and `DELETE` with **no override**: `isTenantScopedRoute`
  matches on `:id` alone, `discoverCrossTenantRoutes` substitutes tenant B's organization id for it, and
  `requireOrgScope`'s membership check 404s before the handler ever looks at `:integrationId` — the same
  property that already lets `/v1/orgs/:id/members/:userId` go uncovered by a per-route override. `callback`
  has no `:id`-shaped param at all, so it needs its own dedicated rejection tests (ADR-0025) rather than the
  generated harness; it is listed in `EXEMPT_ROUTES` with that reason.

## Consequences
- Deviates from SPEC §10's literal path shape only for `connect` and `DELETE`. `callback` keeps its SPEC
  §10 shape (query param dropped, replaced by the state token's contents). `PUT
  /v1/integrations/:id/settings` (M1-2+) is unaffected by this ADR.
- `docs/architecture/lld/shopify-integration.md` §2.1's endpoint table is updated to match, referencing
  this ADR, rather than left to drift silently (CLAUDE.md: "if reality disagrees, raise it rather than
  drifting").
- A future SPEC revision can fold this into §10's canonical list; until then this ADR is the record of the
  deviation and its reasoning.
