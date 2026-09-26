import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { INVITE_STATUSES, ORGANIZATION_STATUSES } from '@truepath/shared';
import { checkOneOf } from './columns.js';
import { roleEnum } from './enums.js';

// Better Auth's own identity tables (Accepted ADR-0012). Schema only, matching auth-tenancy.md §3
// column-for-column so Better Auth's Drizzle adapter can point at these tables via `modelName`
// without a follow-up migration. Better Auth's server config, the organization plugin, RBAC and
// TenantScope/SystemScope land in M0-4 — this file has no runtime auth logic.

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(), // 'credential' | 'google'
    accountId: text('account_id').notNull(),
    password: text('password'), // credential provider only — Better Auth's own hasher
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Not explicitly required by auth-tenancy.md, but a Better Auth/OAuth schema correctness
    // necessity: without it, the same Google account could be linked to two different users.
    providerAccountUnique: uniqueIndex('auth_accounts_provider_id_account_id_key').on(
      table.providerId,
      table.accountId,
    ),
  }),
);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  token: text('token').notNull().unique(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  // Truncated to /24 (IPv4) / /48 (IPv6) by a Better Auth databaseHook before insert
  // (auth-tenancy.md §3) — never a full staff IP at rest.
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  activeOrganizationId: uuid('active_organization_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authTokens = pgTable('auth_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const organizations = pgTable(
  'organizations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    logo: text('logo'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Ours, not Better Auth's (SPEC §6.1)
    plan: text('plan'),
    status: text('status').notNull().default('active'), // @truepath/shared ORGANIZATION_STATUSES
  },
  (table) => ({
    statusCheck: checkOneOf('organizations_status_check', table.status, ORGANIZATION_STATUSES),
  }),
);

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(), // owner | admin | analyst | viewer (auth-tenancy.md §2.4)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Backs the tenant-scope-building membership lookup (auth-tenancy.md §4.3) — a hot path with
    // a < 10 ms p95 target (auth-tenancy.md §7).
    orgUserIdx: index('memberships_organization_id_user_id_idx').on(
      table.organizationId,
      table.userId,
    ),
  }),
);

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: roleEnum('role').notNull(),
    // Better Auth's organization plugin owns this field's lifecycle; value set confirmed against
    // its crud-invites route source (M0-4) — see @truepath/shared INVITE_STATUSES.
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => users.id),
    // Not in SPEC's column list; required by Better Auth's own `invitation` model — its Drizzle
    // schema check (M0-4) fails without it. Additive and harmless (metadata only).
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusCheck: checkOneOf('invites_status_check', table.status, INVITE_STATUSES),
  }),
);
