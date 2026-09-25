import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { AUDIT_ACTIONS, CONSENT_SOURCES, DSR_STATUSES, DSR_TYPES } from '@truepath/shared';
import {
  auditActorTypeEnum,
  consentStateEnum,
  suppressionIdentifierTypeEnum,
  suppressionReasonEnum,
} from './enums.js';
import { checkOneOf } from './columns.js';
import { users } from './auth.js';
import { stores } from './tenancy.js';

// id = the source event_id (SPEC v0.2) — supplied by event-workers, not auto-generated, so the
// insert can be `ON CONFLICT (id) DO NOTHING` for idempotency (HLD §6a).
export const consentRecords = pgTable(
  'consent_records',
  {
    id: uuid('id').primaryKey(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    visitorId: text('visitor_id').notNull(), // HMAC(visitor_id) (SPEC v0.2 §6.1)
    purposes: text('purposes').array().notNull(),
    state: consentStateEnum('state').notNull(),
    noticeVersion: text('notice_version').notNull(),
    source: text('source').notNull(), // @truepath/shared CONSENT_SOURCES
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    storeVisitorIdx: index('consent_records_store_id_visitor_id_idx').on(
      table.storeId,
      table.visitorId,
    ),
    sourceCheck: checkOneOf('consent_records_source_check', table.source, CONSENT_SOURCES),
  }),
);

export const dsrRequests = pgTable(
  'dsr_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // @truepath/shared DSR_TYPES
    identityHash: text('identity_hash').notNull(),
    status: text('status').notNull().default('pending'), // @truepath/shared DSR_STATUSES
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    resultSummary: jsonb('result_summary'), // { trigger: merchant|shopify_webhook|consent_withdrawn|consent_region_remediation, ... }
  },
  (table) => ({
    storeIdx: index('dsr_requests_store_id_idx').on(table.storeId),
    // Backs GET /v1/stores/:id/privacy/requests?status&type&cursor (privacy-dpdp.md §2.2)
    storeStatusIdx: index('dsr_requests_store_id_status_idx').on(table.storeId, table.status),
    typeCheck: checkOneOf('dsr_requests_type_check', table.type, DSR_TYPES),
    statusCheck: checkOneOf('dsr_requests_status_check', table.status, DSR_STATUSES),
  }),
);

export const suppressedIdentities = pgTable(
  'suppressed_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    identifierType: suppressionIdentifierTypeEnum('identifier_type').notNull(),
    identifier: text('identifier').notNull(), // always an HMAC, k<N>:<hex> (ADR-0007)
    reason: suppressionReasonEnum('reason').notNull(),
    dsrRequestId: uuid('dsr_request_id').references(() => dsrRequests.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(), // created_at + 13 months
  },
  (table) => ({
    uniqueEntry: uniqueIndex('suppressed_identities_unique').on(
      table.storeId,
      table.identifierType,
      table.identifier,
      table.reason,
    ),
  }),
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // No FK to organizations: audit history must outlive (and stay attributable to) the org it
    // audited even if the org row is ever hard-deleted (S-4, "≥ 1 year" retention). Deliberately a
    // plain, indexed uuid rather than ON DELETE SET NULL — SET NULL would erase which org an
    // existing audit row belongs to. Null only for platform-wide system events.
    organizationId: uuid('organization_id'),
    // Same reasoning as organizationId: no FK to users, so a user (and, transitively, the org
    // deletion flow — HLD §10 DELETE /v1/orgs/:id) is never blocked by, and audit history never
    // loses, who performed a past action. Null for actor_type='system'.
    actorUserId: uuid('actor_user_id'),
    actorType: auditActorTypeEnum('actor_type').notNull(),
    action: text('action').notNull(), // @truepath/shared AUDIT_ACTIONS
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    // ids and counts only — never identifiers or hashes (privacy-dpdp.md §2.1 AuditLogger contract).
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index('audit_log_organization_id_idx').on(table.organizationId),
    // Backs GET /v1/orgs/:id/audit-log?from&to&action&cursor (auth-tenancy.md §2.1)
    orgCreatedAtIdx: index('audit_log_organization_id_created_at_idx').on(
      table.organizationId,
      table.createdAt,
    ),
    actorUserIdx: index('audit_log_actor_user_id_idx').on(table.actorUserId),
    actionCheck: checkOneOf('audit_log_action_check', table.action, AUDIT_ACTIONS),
  }),
);

// Cross-tenant by nature (`affected_tenants`) — no single store_id/organization_id scope column;
// lives under SystemScope only (HLD §8).
export const breachIncidents = pgTable('breach_incidents', {
  id: uuid('id').primaryKey().defaultRandom(),
  detectedAt: timestamp('detected_at', { withTimezone: true }).notNull(),
  severity: text('severity').notNull(),
  description: text('description').notNull(),
  affectedTenants: uuid('affected_tenants').array().notNull().default([]),
  status: text('status').notNull().default('open'),
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});
