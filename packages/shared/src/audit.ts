import { z } from 'zod';
import { RoleSchema } from './auth.js';
import { AUDIT_ACTIONS, DSR_TYPES, INTEGRATION_PROVIDERS } from './valueLists.js';

// The audit contract (SPEC S-4, privacy-dpdp.md §2.1): what may be written to `audit_log`, per
// action. The writer (packages/db) validates every entry against these schemas, so metadata is
// "ids, enums and counts only" by construction; the PII scan in packages/privacy is a backstop.

export type AuditActionName = (typeof AUDIT_ACTIONS)[number];
export const AUDIT_ACTOR_TYPES = ['user', 'system', 'shopify_webhook'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

// ---- Platform actions -----------------------------------------------------------------------
// Rows with no owning organization (organization_id null). Everything else is written for an
// organization. `system_scope_used` is deliberately not listed: it is org-scoped when a system
// action targets one organization (org deletion) and is then written through a SystemScope.
export const PLATFORM_AUDIT_ACTIONS = [
  'login_succeeded',
  'login_failed',
  'password_reset_requested',
  'password_reset_completed',
  'retention_run',
  'suppression_rebuilt',
  'webhook_deliveries_pruned',
  'attribution_confidence_backfilled',
  'breach_created',
  'breach_confirmed',
  'breach_notified',
  'breach_closed',
] as const satisfies readonly AuditActionName[];
export type PlatformAuditAction = (typeof PLATFORM_AUDIT_ACTIONS)[number];

export function isPlatformAuditAction(action: string): action is PlatformAuditAction {
  return (PLATFORM_AUDIT_ACTIONS as readonly string[]).includes(action);
}

// ---- Metadata schemas -----------------------------------------------------------------------
const empty = z.object({}).strict();
const count = z.number().int().min(0);
const snake = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/)
  .max(64);
// Names of the settings fields that changed — names only, never values.
const changedFields = z
  .string()
  .max(200)
  .regex(/^[a-z][a-z0-9_]*(,[a-z][a-z0-9_]*)*$/);
const provider = z.enum(INTEGRATION_PROVIDERS);
const dsrType = z.enum(DSR_TYPES);
const dsrTrigger = z.enum([
  'merchant',
  'shopify_webhook',
  'consent_withdrawn',
  'consent_region_remediation',
]);
const isoDateTime = z.string().datetime();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Scalar-only free-form maps, for actions whose keys are per-run (row counts per table).
const counts = z.record(snake, count);
const scalars = z.record(snake, z.union([z.string().max(200), z.number(), z.boolean()]));

// Metadata is a flat object of strings, numbers and booleans. Where a schema is provisional (the
// emitting ticket hasn't landed) its owner in AUDIT_ACTION_OWNERS says so; tighten it there.
export const AUDIT_METADATA_SCHEMAS = {
  dpa_accepted: z.object({ dpa_version: z.string().min(1).max(32) }).strict(),
  privacy_settings_changed: z.object({ changed_fields: changedFields }).strict(),
  attribution_settings_changed: z.object({ changed_fields: changedFields }).strict(),
  channel_rules_changed: z.object({ changed_fields: changedFields }).strict(),
  integration_connected: z.object({ provider }).strict(),
  integration_disconnected: z.object({ provider }).strict(),
  integration_settings_changed: z.object({ provider, changed_fields: changedFields }).strict(),
  login_succeeded: empty,
  // Which account an attempt targeted, never what was typed: no email and no hash of one.
  login_failed: z.union([
    z.object({ target_user_id: z.string().uuid() }).strict(),
    z.object({ unknown_account: z.literal(true) }).strict(),
  ]),
  // Issue #16: target_user_id only, never the email — Better Auth's own `sendResetPassword`/
  // `onPasswordReset` hooks only fire for a real, found user (a request for an unknown email is
  // answered with the same generic message, unaudited, same timing-attack-safe shape as login_failed's
  // unknown_account branch not existing here).
  password_reset_requested: z.object({ target_user_id: z.string().uuid() }).strict(),
  password_reset_completed: z.object({ target_user_id: z.string().uuid() }).strict(),
  member_invited: z.object({ role: RoleSchema }).strict(),
  member_invite_accepted: empty,
  member_role_changed: z.object({ from: RoleSchema, to: RoleSchema }).strict(),
  member_removed: z.object({ role: RoleSchema, self: z.boolean() }).strict(),
  org_deletion_requested: z
    .object({ deletion_scheduled_at: isoDateTime, deletion_due_by: isoDateTime })
    .strict(),
  org_deletion_cancelled: empty,
  org_deleted: z.object({ stores: count }).strict(),
  consent_region_confirmed: empty,
  consent_default_on_warned: z
    .object({ ratio: z.number().min(0).max(1), new_visitors: count })
    .strict(),
  consent_default_on_paused: z
    .object({ ratio: z.number().min(0).max(1), new_visitors: count })
    .strict(),
  consent_default_on_resumed: empty,
  dsr_created: z.object({ type: dsrType, trigger: dsrTrigger }).strict(),
  dsr_completed: z.object({ type: dsrType, trigger: dsrTrigger }).strict(),
  dsr_failed: z.object({ type: dsrType, attempts: count }).strict(),
  dsr_followup_erasure: z.object({ visitor_count: count, rows_deleted: count }).strict(),
  dsr_export_downloaded: empty,
  report_exported: z
    .object({
      level: z.enum(['channel', 'campaign', 'adset', 'ad']),
      from: isoDate,
      to: isoDate,
      model: z.enum([
        'first_click',
        'last_click',
        'last_non_direct',
        'linear',
        'time_decay',
        'position_based',
      ]),
      basis: z.enum(['placed', 'delivered']),
      rows: count,
    })
    .strict(),
  order_journey_viewed: empty,
  audit_log_viewed: empty,
  retention_run: counts,
  system_scope_used: scalars,
  suppression_rebuilt: z.object({ stores: count, entries: count }).strict(),
  webhook_deliveries_pruned: z.object({ deleted: count }).strict(),
  attribution_confidence_backfilled: z.object({ enqueued: count }).strict(),
  breach_created: z.object({ severity: z.enum(['low', 'medium', 'high', 'critical']) }).strict(),
  breach_confirmed: empty,
  breach_notified: z.object({ tenants: count }).strict(),
  breach_closed: empty,
} as const satisfies Record<AuditActionName, z.ZodTypeAny>;

export type AuditMetadataOf<A extends AuditActionName> = z.infer<
  (typeof AUDIT_METADATA_SCHEMAS)[A]
>;

// ---- Entries --------------------------------------------------------------------------------
interface AuditEntryBase<A extends AuditActionName> {
  readonly action: A;
  readonly actorUserId?: string | null;
  readonly actorType: AuditActorType;
  readonly targetType: string;
  readonly targetId: string;
}

// Metadata is optional only where an empty object satisfies the schema.
type MetadataField<A extends AuditActionName> =
  object extends AuditMetadataOf<A>
    ? { readonly metadata?: AuditMetadataOf<A> }
    : { readonly metadata: AuditMetadataOf<A> };

type EntryFor<A extends AuditActionName> = AuditEntryBase<A> & MetadataField<A>;

/** Any audit entry without its organization: `action` selects which `metadata` shape is required. */
export type AuditEntryInput = { [A in AuditActionName]: EntryFor<A> }[AuditActionName];

/** Every action that belongs to an organization, i.e. all but the platform-wide ones. */
export type OrganizationAuditAction = Exclude<AuditActionName, PlatformAuditAction>;

/**
 * An entry for an organization (written under a TenantScope, or a SystemScope acting on one). The
 * platform-wide actions are excluded: they have no organization and go through `writePlatform`.
 */
export type OrganizationAuditEntry = {
  [A in OrganizationAuditAction]: EntryFor<A>;
}[OrganizationAuditAction] & { readonly organizationId: string };

/** A platform-wide entry: only the actions in PLATFORM_AUDIT_ACTIONS, and no organization. */
export type PlatformAuditEntry = { [A in PlatformAuditAction]: EntryFor<A> }[PlatformAuditAction];

// ---- Who emits each action ------------------------------------------------------------------
// SPEC §5.10 test 8: "an audit row exists for every DSR, export and settings change". Most of those
// features land in later tickets, so this registry names, for every catalogue action, the ticket
// that emits it and — once it does — the test that proves a row is written. A test fails if an
// action is missing here, or is `implemented` without evidence, so the catalogue can't grow silently.
export type AuditActionOwner =
  | {
      readonly status: 'implemented';
      readonly ticket: string;
      readonly evidence: readonly string[];
    }
  | { readonly status: 'pending'; readonly ticket: string };

const pending = (ticket: string): AuditActionOwner => ({ status: 'pending', ticket });
const implemented = (ticket: string, ...evidence: string[]): AuditActionOwner => ({
  status: 'implemented',
  ticket,
  evidence,
});

export const AUDIT_ACTION_OWNERS = {
  dpa_accepted: implemented('M0 exit / #7', 'apps/api/src/dpaAccept.test.ts'),
  privacy_settings_changed: pending('M4-2'),
  attribution_settings_changed: pending('M3-3'),
  channel_rules_changed: pending('M3-3'),
  integration_connected: implemented('M1-1', 'apps/api/src/routes/integrations.test.ts'),
  integration_disconnected: implemented(
    'M1-1',
    'apps/api/src/routes/integrations.test.ts',
    'apps/api/src/routes/shopifyWebhooks.test.ts',
  ),
  integration_settings_changed: pending('M1-2 / M2-1'),
  login_succeeded: implemented('M0-4', 'apps/api/src/auditTrail.test.ts'),
  login_failed: implemented('M0-4', 'apps/api/src/loginAudit.test.ts'),
  password_reset_requested: implemented('#16', 'apps/api/src/authBridge.test.ts'),
  password_reset_completed: implemented('#16', 'apps/api/src/authBridge.test.ts'),
  member_invited: implemented('M0-4', 'apps/api/src/auditTrail.test.ts'),
  member_invite_accepted: implemented('M0-4', 'apps/api/src/auditTrail.test.ts'),
  member_role_changed: implemented('M0-4', 'apps/api/src/auditTrail.test.ts'),
  member_removed: implemented('M0-4', 'apps/api/src/auditTrail.test.ts'),
  org_deletion_requested: implemented('#8', 'apps/api/src/routes/orgDeletion.test.ts'),
  org_deletion_cancelled: implemented('#8', 'apps/api/src/routes/orgDeletion.test.ts'),
  // The erasure scheduler (LLD §4.6 steps 4-5) that completes a deletion and writes this row — a
  // follow-up to #8, built once the DSR/store_erasure pipeline (#25) it reuses landed.
  org_deleted: implemented('#84', 'apps/workers/src/orgDeletionScheduler.test.ts'),
  // Reassigned from 'pending M4-2' to M1 (issue #72): HLD §8's "Consent-region gate" layer 1 is a
  // hard onboarding block, not a privacy-settings-page feature — no real store could ever leave
  // consent_region_unconfirmed without it, so M1's own exit criterion (a real store's events flow)
  // was unreachable until this existed. M4-2 still owns the rest of the privacy-settings page.
  consent_region_confirmed: implemented(
    'M1-9 / #72',
    'apps/api/src/routes/privacyDashboard.test.ts',
  ),
  // HLD §8 "Consent-region gate" layer 2 (issue #52). `consent_default_on_resumed` stays pending:
  // resuming is a merchant action (re-confirming the banner is opt-in) with no producer yet.
  consent_default_on_warned: implemented('#52', 'apps/workers/src/defaultOnSignal.test.ts'),
  consent_default_on_paused: implemented('#52', 'apps/workers/src/defaultOnSignal.test.ts'),
  consent_default_on_resumed: pending('M1-6'),
  dsr_created: implemented(
    'M1-1 / M1-2 / M1-6b / M4-2',
    'apps/api/src/routes/shopifyWebhooks.test.ts',
    'packages/db/src/repositories/eventEffectsRepository.test.ts',
  ),
  // Narrowed from 'M1-2 / M4-2' during M1-2 review: fulfilment needs identity-stitching's
  // identity_links (M1-7), ClickHouse events/touchpoints/attribution_results/order_status (no
  // writer exists before M1-6/M3), an S3 export bucket, and the `dsr` BullMQ worker — none of which
  // M1-2 builds. M1-2 only implements the compliance-webhook *receipt* (already done in M1-1).
  // Issue #25 (PR2) builds `erasure` fulfilment (webhook, withdrawal and follow-up scopes);
  // `store_erasure` lands with its third PR, `access`/`correction` still have no producer.
  dsr_completed: implemented('#25', 'apps/workers/src/dsr/dsr.test.ts'),
  dsr_failed: implemented('#25', 'apps/workers/src/dsr/dsr.test.ts'),
  dsr_followup_erasure: implemented('#25', 'apps/workers/src/dsr/dsr.test.ts'),
  dsr_export_downloaded: pending('M4-2'),
  report_exported: pending('M3-3'),
  order_journey_viewed: pending('M3-3'),
  audit_log_viewed: implemented('M0-6', 'apps/api/src/auditTrail.test.ts'),
  retention_run: pending('M4-3'),
  system_scope_used: implemented('M0-4', 'packages/db/src/systemScope.test.ts'),
  suppression_rebuilt: implemented('M1-6c', 'apps/workers/src/suppressionRebuild.test.ts'),
  webhook_deliveries_pruned: implemented('#32', 'apps/workers/src/webhookDeliveryPrune.test.ts'),
  attribution_confidence_backfilled: implemented(
    '#35',
    'apps/workers/src/attributionConfidenceBackfill.test.ts',
  ),
  breach_created: pending('M4-4'),
  breach_confirmed: pending('M4-4'),
  breach_notified: pending('M4-4'),
  breach_closed: pending('M4-4'),
} as const satisfies Record<AuditActionName, AuditActionOwner>;
