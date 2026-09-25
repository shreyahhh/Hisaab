# 0012. Authentication: Better Auth, self-hosted

## Status
Accepted (2026-09-24; SPEC §15 item 2; SPEC v0.5 §3)

## Context
Merchant staff need email + password and Google sign-in, sessions, organisations with roles (`owner|admin|analyst|viewer`), and invites (SPEC §3, §10, S-3). We are the Data Fiduciary for staff data (SPEC §5.1), and all personal data should stay in India (SPEC §5.9). SPEC §3 suggested "Lucia/Auth.js or Clerk". Lucia is deprecated.

## Options considered
- **Better Auth (self-hosted)**:
  - a TypeScript auth library that runs inside Core API on our Postgres;
  - email/password with verification and reset, social providers (Google), sessions, rate limiting;
  - an **organization plugin** with members, invitations and custom access-control roles;
  - configurable table names and UUID ids;
  - adapters for Drizzle, Prisma and Kysely ([database](https://www.better-auth.com/docs/concepts/database), [organization plugin](https://www.better-auth.com/docs/plugins/organization), [options](https://www.better-auth.com/docs/reference/options)).
- **Clerk (managed)**:
  - fastest to integrate, with hosted UI and MFA;
  - but a **US-hosted sub-processor** holding staff personal data outside India;
  - adds a vendor dependency to login availability and its own organisation model to reconcile with ours.
- **Auth.js**: mature for OAuth, but weaker for email/password and has no built-in organisation or invite model; more to build.
- **Lucia**: deprecated; not an option.

## Decision
Use **Better Auth, self-hosted on our Postgres in ap-south-1**, with the organization plugin. Configuration is in `lld/auth-tenancy.md` §2.2:
- Models are mapped onto SPEC tables: `users`, `auth_accounts`, `sessions`, `auth_tokens`, `organizations`, `memberships`, `invites`.
- UUID ids; custom roles (`owner`, `admin`, `analyst`, `viewer`); 7-day invitations.
- Email verification required; minimum password length 12.
- 14-day sliding sessions with session IPs truncated; Google tokens nulled after sign-in.
- Rate-limit counters on the cache Redis (prefix `ba:`).
- Mounted under `/v1/auth/*`, with SPEC's named auth routes as thin wrappers.

Clerk is recorded as the **rejected alternative** (a US sub-processor for staff personal data).

## Consequences
- No auth sub-processor; staff data stays in Mumbai (`docs/dpdp/subprocessors.md`).
- Better Auth is the **one allowed exception** to "all Postgres access through the scoped repository". It touches only its identity tables (ADR-0016, HLD §8).
- We own security operations for auth: secret rotation, patching the library, monitoring login abuse. MFA (Better Auth two-factor plugin) is an open question before GA (auth-tenancy Q2).
- SPEC's `users.password_hash` / `sso_provider` move to `auth_accounts` (SPEC v0.5 §6.1).
- The ORM choice (ADR-0011) determines which Better Auth adapter is used; both candidates are supported.
