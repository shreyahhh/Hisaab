// Better Auth configuration (ADR-0012), organization plugin (orgs/memberships/invites), and the
// TenantScope-building membership lookup every route handler relies on (ADR-0016). Better Auth is
// the one allowed exception to "Postgres only through packages/db": this package reads/writes
// Better Auth's own identity tables directly via its Drizzle adapter.
// See docs/architecture/lld/auth-tenancy.md.

export const PACKAGE_NAME = '@truepath/auth';

export { createAuth, type Auth, type AuthEnv, type CreateAuthOptions } from './betterAuth.js';
export { ac, ownerRole, adminRole, analystRole, viewerRole } from './accessControl.js';
export { truncateIp, nullGoogleTokensAfterCreate } from './hooks.js';
export {
  resolveMembership,
  resolveMembershipsForUser,
  resolveMembersForOrganization,
  findUserIdByEmail,
  getInvitation,
  type InvitationInfo,
  type MemberSummary,
  type MembershipInfo,
  type OrganizationMembership,
} from './scope.js';
export {
  AUTH_BASE_PATH,
  DISABLED_AUTH_PATHS,
  EXPOSED_AUTH_ROUTES,
  type ExposedAuthRoute,
} from './exposure.js';
export { noopEmailSender, type AuthEmailSender } from './email.js';
