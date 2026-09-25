// Better Auth configuration (ADR-0012), organization plugin (orgs/memberships/invites), and the
// TenantScope/SystemScope + can() RBAC primitives every route handler and job builds on
// (ADR-0016). The one allowed exception to "Postgres only through packages/db": this package
// reads/writes Better Auth's own identity tables directly via its Drizzle adapter.
// See docs/architecture/lld/auth-tenancy.md. Empty scaffold as of M0-1 — lands in M0-4.

export const PACKAGE_NAME = '@truepath/auth';
