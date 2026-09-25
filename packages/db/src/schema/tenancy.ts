import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { STORE_PLATFORMS, STORE_STATUSES } from '@truepath/shared';
import { checkOneOf } from './columns.js';
import { organizations, users } from './auth.js';

export const stores = pgTable(
  'stores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull().default('shopify'), // @truepath/shared STORE_PLATFORMS
    shopDomain: text('shop_domain').notNull().unique(),
    currency: text('currency').notNull().default('INR'),
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    installedAt: timestamp('installed_at', { withTimezone: true }),
    // active | inactive | uninstalled | deleted (privacy-dpdp.md §4.7, §4.10) — @truepath/shared STORE_STATUSES
    status: text('status').notNull().default('active'),
    childDirected: boolean('child_directed').notNull().default(false),
    retentionMonths: integer('retention_months').notNull().default(13),
    // Only notice_version, grievance_contact, checklist, consent_health live here (HLD §8) —
    // child_directed and retention_months stay as their own columns (one home per setting).
    privacyConfig: jsonb('privacy_config').notNull().default({}),
  },
  (table) => ({
    orgIdx: index('stores_organization_id_idx').on(table.organizationId),
    platformCheck: checkOneOf('stores_platform_check', table.platform, STORE_PLATFORMS),
    statusCheck: checkOneOf('stores_status_check', table.status, STORE_STATUSES),
  }),
);

export const dpaAcceptances = pgTable(
  'dpa_acceptances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    dpaVersion: text('dpa_version').notNull(),
    acceptedByUserId: uuid('accepted_by_user_id')
      .notNull()
      .references(() => users.id),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
    ipTruncated: text('ip_truncated'),
  },
  (table) => ({
    orgIdx: index('dpa_acceptances_organization_id_idx').on(table.organizationId),
  }),
);
