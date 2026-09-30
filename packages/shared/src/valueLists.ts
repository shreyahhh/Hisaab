import { z } from 'zod';

// Closed value lists for Postgres `text` + CHECK columns (packages/db) — single source of truth,
// also used here to build zod validators for the application layer. Not native pgEnum: these are
// external-facing or proven-to-evolve categories (Phase 2 platforms/providers, HLD's channel slug
// list already grew once in v0.6, audit actions grow with every module). Extending one of these is
// a one-line CHECK-constraint migration; extending a pgEnum needs `ALTER TYPE ... ADD VALUE`, which
// can't run inside a transaction with other DDL. Columns whose value set is stable and fully
// code-controlled (SPEC §9 attribution models, consent state, suppression reason, etc.) stay native
// pgEnum in packages/db/src/schema/enums.ts instead.

export const STORE_PLATFORMS = ['shopify'] as const; // SPEC §2: "keep platform as enums/adapters so Phase 2 integrations slot in"
export const StorePlatform = z.enum(STORE_PLATFORMS);

export const INTEGRATION_PROVIDERS = ['shopify', 'meta', 'google_ads', 'shiprocket'] as const;
export const IntegrationProvider = z.enum(INTEGRATION_PROVIDERS);

export const DELIVERY_STATUSES = [
  'pending',
  'in_transit',
  'delivered',
  'rto',
  'cancelled',
] as const;
export const DeliveryStatus = z.enum(DELIVERY_STATUSES);

export const PAYMENT_METHODS = ['cod', 'prepaid', 'partial_cod'] as const;
export const PaymentMethod = z.enum(PAYMENT_METHODS);

// Touchpoint channel slugs (HLD §8); 'unattributed' is attribution_results-only, never a rule target.
export const CHANNEL_SLUGS = [
  'meta_ads',
  'google_ads',
  'organic_search',
  'email',
  'whatsapp',
  'influencer_affiliate',
  'organic_social',
  'direct',
  'referral',
  'other_campaign',
] as const;
export const ChannelSlug = z.enum(CHANNEL_SLUGS);

export const DSR_TYPES = ['access', 'erasure', 'correction', 'store_erasure'] as const;
export const DsrType = z.enum(DSR_TYPES);

// Full catalogue from privacy-dpdp.md §2.1 AuditAction.
export const AUDIT_ACTIONS = [
  'dpa_accepted',
  'privacy_settings_changed',
  'attribution_settings_changed',
  'channel_rules_changed',
  'integration_connected',
  'integration_disconnected',
  'integration_settings_changed',
  'login_succeeded',
  'login_failed',
  'member_invited',
  'member_invite_accepted',
  'member_role_changed',
  'member_removed',
  'org_deletion_requested',
  'org_deletion_cancelled',
  'org_deleted',
  'consent_region_confirmed',
  'consent_default_on_warned',
  'consent_default_on_paused',
  'consent_default_on_resumed',
  'dsr_created',
  'dsr_completed',
  'dsr_failed',
  'dsr_followup_erasure',
  'dsr_export_downloaded',
  'report_exported',
  'order_journey_viewed',
  'audit_log_viewed',
  'retention_run',
  'system_scope_used',
  'suppression_rebuilt',
  'webhook_deliveries_pruned',
  'breach_created',
  'breach_confirmed',
  'breach_notified',
  'breach_closed',
] as const;
export const AuditAction = z.enum(AUDIT_ACTIONS);

export const CAPI_EVENT_NAMES = ['Purchase', 'DeliveredPurchase', 'RTO'] as const;
export const CapiEventName = z.enum(CAPI_EVENT_NAMES);

export const ORDER_STATUS_SOURCES = ['shopify', 'shiprocket'] as const;
export const OrderStatusSource = z.enum(ORDER_STATUS_SOURCES);

// SPEC v0.6 consent_records.source; grows if a Consent Manager (P-7) is plugged in later.
export const CONSENT_SOURCES = [
  'pixel_interaction',
  'pixel_initial_state',
  'pixel_refresh',
] as const;
export const ConsentSource = z.enum(CONSENT_SOURCES);

// Status-style text columns, grounded in explicit values used across the LLDs (not invented) —
// see each field's own comment in packages/db/src/schema for the source.
export const STORE_STATUSES = ['active', 'inactive', 'uninstalled', 'deleted'] as const; // privacy-dpdp.md §4.7, §4.10
export const StoreStatus = z.enum(STORE_STATUSES);

export const ORGANIZATION_STATUSES = ['active', 'pending_deletion', 'deleted'] as const; // auth-tenancy.md §4.6
export const OrganizationStatus = z.enum(ORGANIZATION_STATUSES);

export const INTEGRATION_STATUSES = [
  'pending',
  'active',
  'error',
  'needs_reauth',
  'revoked',
] as const; // shopify-integration.md, meta-integration.md
export const IntegrationStatus = z.enum(INTEGRATION_STATUSES);

export const DSR_STATUSES = ['pending', 'in_progress', 'completed', 'failed'] as const; // privacy-dpdp.md §3, §4.3
export const DsrStatus = z.enum(DSR_STATUSES);

export const CAPI_DISPATCH_STATUSES = ['queued', 'sent', 'skipped', 'failed'] as const; // meta-integration.md §4.7
export const CapiDispatchStatus = z.enum(CAPI_DISPATCH_STATUSES);

// Better Auth's organization plugin owns invites.status (auth-tenancy.md §3); this list is its
// value set, confirmed against @better-auth/organization@1.7.6's own crud-invites route source
// (not guessed) — 'pending' | 'accepted' | 'rejected' | 'canceled'.
export const INVITE_STATUSES = ['pending', 'accepted', 'rejected', 'canceled'] as const;
export const InviteStatus = z.enum(INVITE_STATUSES);
