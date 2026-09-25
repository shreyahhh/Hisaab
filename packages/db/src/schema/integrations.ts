import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { INTEGRATION_PROVIDERS, INTEGRATION_STATUSES } from '@truepath/shared';
import { bytea, checkOneOf } from './columns.js';
import { stores } from './tenancy.js';

export const integrations = pgTable(
  'integrations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // @truepath/shared INTEGRATION_PROVIDERS
    externalAccountId: text('external_account_id'),
    // KMS envelope-encrypted OAuth tokens (SPEC §5.5 S-2). Never a secret in `settings`.
    encryptedCredentials: bytea('encrypted_credentials'),
    scopes: text('scopes').array(),
    // pending | active | error | needs_reauth | revoked (shopify-integration.md, meta-integration.md)
    status: text('status').notNull().default('pending'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    error: text('error'),
    settings: jsonb('settings').notNull().default({}), // non-secret config only (HLD §8 "Secrets rule")
  },
  (table) => ({
    storeIdx: index('integrations_store_id_idx').on(table.storeId),
    storeProviderIdx: index('integrations_store_id_provider_idx').on(table.storeId, table.provider),
    // NULLS NOT DISTINCT (Postgres 16): external_account_id is null until the OAuth callback
    // completes, and a store should still have only one in-progress connection per provider.
    storeProviderAccountUnique: unique('integrations_store_id_provider_external_account_id_key')
      .on(table.storeId, table.provider, table.externalAccountId)
      .nullsNotDistinct(),
    providerCheck: checkOneOf('integrations_provider_check', table.provider, INTEGRATION_PROVIDERS),
    statusCheck: checkOneOf('integrations_status_check', table.status, INTEGRATION_STATUSES),
  }),
);

export const adAccounts = pgTable(
  'ad_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // @truepath/shared INTEGRATION_PROVIDERS
    externalId: text('external_id').notNull(),
    name: text('name').notNull(),
    currency: text('currency').notNull(),
    timezone: text('timezone').notNull(),
  },
  (table) => ({
    storeIdx: index('ad_accounts_store_id_idx').on(table.storeId),
    storeProviderExternalIdUnique: uniqueIndex('ad_accounts_store_id_provider_external_id_key').on(
      table.storeId,
      table.provider,
      table.externalId,
    ),
    providerCheck: checkOneOf('ad_accounts_provider_check', table.provider, INTEGRATION_PROVIDERS),
  }),
);
