import { pgEnum } from 'drizzle-orm/pg-core';
import { ROLES } from '@truepath/shared';

// Native pgEnum reserved for value sets that are stable and fully code-controlled — SPEC-defined
// constants, not external-facing categories (contrast packages/shared valueLists.ts, whose lists
// back `text` + CHECK columns instead because they're proven or expected to grow: provider,
// platform, delivery_status, payment_method, channel slugs, dsr type, audit action, capi event
// names, order_status_events.source, consent_records.source).

export const attributionConfidenceEnum = pgEnum('attribution_confidence', ['high', 'low']);

export const consentStateEnum = pgEnum('consent_state', ['granted', 'withdrawn']);

export const deliveryRateFallbackLevelEnum = pgEnum('delivery_rate_fallback_level', [
  'store_payment_method',
  'store',
  'platform_default',
]);

export const suppressionIdentifierTypeEnum = pgEnum('suppression_identifier_type', [
  'visitor_id',
  'identity_hash_hmac',
]);

export const suppressionReasonEnum = pgEnum('suppression_reason', ['erased', 'withdrawn']);

export const auditActorTypeEnum = pgEnum('audit_actor_type', ['user', 'system', 'shopify_webhook']);

// SPEC §9 — the 6 attribution models are a fixed part of the attribution engine's contract;
// changing this set means rewriting packages/attribution, not a business-data change.
export const attributionModelEnum = pgEnum('attribution_model', [
  'first_click',
  'last_click',
  'last_non_direct',
  'linear',
  'time_decay',
  'position_based',
]);

export const revenueBasisEnum = pgEnum('revenue_basis', ['placed', 'delivered']);

// owner | admin | analyst | viewer (auth-tenancy.md §2.4) — fully code-controlled by the can()
// permission matrix in @truepath/shared, so a native pgEnum rather than valueLists.ts's
// text+CHECK pattern (see this file's header comment).
export const roleEnum = pgEnum('role', ROLES);
