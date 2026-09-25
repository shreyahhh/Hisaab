import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { CAPI_EVENT_NAMES, CAPI_DISPATCH_STATUSES, CHANNEL_SLUGS } from '@truepath/shared';
import { attributionModelEnum, revenueBasisEnum } from './enums.js';
import { checkOneOf } from './columns.js';
import { stores } from './tenancy.js';
import { orders } from './orders.js';

export const channelRules = pgTable(
  'channel_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    priority: integer('priority').notNull(),
    match: jsonb('match').notNull(),
    channel: text('channel').notNull(), // @truepath/shared CHANNEL_SLUGS
    subChannel: text('sub_channel'),
  },
  (table) => ({
    storeIdx: index('channel_rules_store_id_idx').on(table.storeId),
    channelCheck: checkOneOf('channel_rules_channel_check', table.channel, CHANNEL_SLUGS),
  }),
);

// One row per store (SPEC §6.1 shows no separate id column). defaultModel has no default in SPEC
// text, so it's required rather than guessed.
export const attributionSettings = pgTable('attribution_settings', {
  storeId: uuid('store_id')
    .primaryKey()
    .references(() => stores.id, { onDelete: 'cascade' }),
  defaultModel: attributionModelEnum('default_model').notNull(),
  lookbackDays: integer('lookback_days').notNull().default(30),
  revenueBasis: revenueBasisEnum('revenue_basis').notNull().default('delivered'),
});

export const capiDispatchLog = pgTable(
  'capi_dispatch_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    eventName: text('event_name').notNull(), // @truepath/shared CAPI_EVENT_NAMES
    eventId: text('event_id').notNull(), // order_<id> | delivered_<id> | rto_<id> (HLD §8)
    status: text('status').notNull(), // @truepath/shared CAPI_DISPATCH_STATUSES
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => ({
    storeIdx: index('capi_dispatch_log_store_id_idx').on(table.storeId),
    // Tenant-scoped uniqueness (ADR-0016), not a bare global one — event_id already embeds an
    // order UUID so a cross-tenant collision is effectively impossible, but this is the correct
    // shape regardless.
    storeEventIdUnique: uniqueIndex('capi_dispatch_log_store_id_event_id_key').on(
      table.storeId,
      table.eventId,
    ),
    eventNameCheck: checkOneOf(
      'capi_dispatch_log_event_name_check',
      table.eventName,
      CAPI_EVENT_NAMES,
    ),
    statusCheck: checkOneOf('capi_dispatch_log_status_check', table.status, CAPI_DISPATCH_STATUSES),
  }),
);
