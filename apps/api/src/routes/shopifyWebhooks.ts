import type { FastifyInstance } from 'fastify';
import type { Queue } from 'bullmq';
import { z, type ZodError } from 'zod';
import {
  createDsrRequestRepository,
  createIntegrationRepository,
  createOrderRepository,
  createStoreRepository,
  createWebhookDeliveryRepository,
  jobScope,
  resolveStoreByShopDomain,
} from '@truepath/db';
import {
  mapOrderSnapshot,
  snapshotFromOrderWebhook,
  ShopifyOrderHintWebhook,
  ShopifyOrderWebhook,
  type ShopifyAdapter,
  type ShopifyOrderSnapshot,
} from '@truepath/integrations';
import {
  isIdentityErased,
  storeContext,
  type CredentialsCipher,
  type IdentityHasher,
  type SuppressionReader,
} from '@truepath/privacy';
import {
  IDENTITY_STITCH_JOB_OPTIONS,
  identityStitchJobId,
  type IdentityStitchJob,
  type ShopifySyncJob,
  type TenantScope,
} from '@truepath/shared';
import { fetchOrderWithTokenRefresh } from '../shopifyOrderCredentials.js';
import type { TenantScopeDeps } from '../tenantScope.js';

// POST /webhooks/shopify/:topic (shopify-integration.md §2.2, §2.4, §4.2-§4.8). M1-1 built
// app/uninstalled and the three compliance topics; M1-2 adds orders/refunds/fulfillments; M1-3b adds
// bulk_operations/finish (enqueues the backfill's `bulk_result` job).
//
// HLD §8 exception: this file is the one sanctioned caller of `resolveStoreByShopDomain`
// (eslint.config.js) — a webhook authenticates by HMAC + shop domain, never a session, so there is
// no TenantScope until the store is resolved here.

const ORDERS_TOPICS = ['orders/create', 'orders/updated', 'orders/cancelled'] as const;
const ORDER_HINTS_TOPICS = [
  'refunds/create',
  'fulfillments/create',
  'fulfillments/update',
] as const;
const APP_TOPICS = ['app/uninstalled', 'bulk_operations/finish'] as const;
const COMPLIANCE_TOPICS = ['customers/data_request', 'customers/redact', 'shop/redact'] as const;

const TOPIC_GROUPS: Readonly<Record<string, readonly string[]>> = {
  orders: ORDERS_TOPICS,
  'order-hints': ORDER_HINTS_TOPICS,
  app: APP_TOPICS,
  compliance: COMPLIANCE_TOPICS,
};

type ComplianceDsrType = 'access' | 'erasure' | 'store_erasure';

const DSR_TYPE_BY_COMPLIANCE_TOPIC: Readonly<
  Record<(typeof COMPLIANCE_TOPICS)[number], ComplianceDsrType>
> = {
  'customers/data_request': 'access',
  'customers/redact': 'erasure',
  'shop/redact': 'store_erasure',
};

// Ours, not Shopify's 30-day deadline (shopify-integration.md §4.8).
const DSR_SLA_MS = 7 * 24 * 60 * 60 * 1000;

export interface ShopifyWebhookDeps {
  readonly adapter: ShopifyAdapter;
  readonly hasher: IdentityHasher;
  readonly cipher: CredentialsCipher;
  readonly shopifySyncQueue: Queue<ShopifySyncJob>;
  /** Durable Redis: read for the erased-identity list when an order is stored (HLD §6b). */
  readonly redis: SuppressionReader;
  /** HLD §8 `identity-stitch`: an applied order enqueues attempt 0 (identity-stitching.md §2.1). */
  readonly identityStitchQueue: Pick<Queue<IdentityStitchJob>, 'add'>;
}

/** What applying an order needs beyond the database: the suppression check and the stitch queue. */
type OrderApplyDeps = Pick<ShopifyWebhookDeps, 'redis' | 'identityStitchQueue'>;

/** Logs a structured, redacted line — field paths only, never the received value (M1-2 review item 6). */
function reportValidationFailure(event: string, topic: string, fields: readonly string[]): void {
  console.error(JSON.stringify({ event, alert: event, topic, fields }));
}

function zodIssuePaths(error: ZodError): string[] {
  return [...new Set(error.issues.map((issue) => issue.path.join('.') || '(root)'))];
}

async function handleAppUninstalled(
  deps: TenantScopeDeps,
  scope: TenantScope,
  storeId: string,
): Promise<void> {
  const store = await createStoreRepository(deps.db).markUninstalled(scope, storeId);
  const integration = await createIntegrationRepository(deps.db).markUninstalled(scope, storeId);
  if (!store) return; // already uninstalled — Shopify's retries make this idempotent, not an error
  await deps.audit.log.write(scope, {
    organizationId: scope.organizationId,
    actorUserId: null,
    actorType: 'shopify_webhook',
    action: 'integration_disconnected',
    targetType: 'integration',
    targetId: integration?.id ?? storeId,
    metadata: { provider: 'shopify' },
  });
}

/**
 * `customers/data_request` | `customers/redact` | `shop/redact` → a durable `dsr_requests` receipt
 * (shopify-integration.md §2.3, §4.3; privacy-dpdp.md line 196). This only records the request; it
 * does not fulfil it — see the tracked, launch-blocking follow-up issue for the DSR pipeline.
 */
async function handleComplianceWebhook(
  deps: TenantScopeDeps & { hasher: IdentityHasher },
  scope: TenantScope,
  storeId: string,
  topic: (typeof COMPLIANCE_TOPICS)[number],
  webhookId: string,
  rawBody: Buffer,
): Promise<void> {
  const type = DSR_TYPE_BY_COMPLIANCE_TOPIC[topic];

  // Hashed in memory and discarded immediately; the raw payload is never persisted or logged
  // (SPEC §5.4, shopify-integration.md §4.2 step 5). `shop/redact` carries no customer — store_erasure
  // is store-wide, per privacy-dpdp.md's explicit `identity_hash=null` for this type.
  let identityHash: string | null = null;
  if (type !== 'store_erasure') {
    let customer: { email?: unknown; phone?: unknown } = {};
    try {
      const payload = JSON.parse(rawBody.toString('utf8')) as { customer?: typeof customer };
      customer = payload.customer ?? {};
    } catch {
      customer = {};
    }
    const context = storeContext(storeId);
    const phoneHash =
      typeof customer.phone === 'string' ? deps.hasher.hashPhone(context, customer.phone) : null;
    const emailHash =
      typeof customer.email === 'string' ? deps.hasher.hashEmail(context, customer.email) : null;
    identityHash = phoneHash ?? emailHash;
  }

  const { row, created } = await createDsrRequestRepository(deps.db).createFromWebhook(scope, {
    storeId,
    type,
    identityHash,
    dueAt: new Date(Date.now() + DSR_SLA_MS),
    sourceRef: webhookId,
  });
  if (!created) return; // duplicate delivery of a webhook already receipted (CLAUDE.md: dedupe)
  await deps.audit.log.write(scope, {
    organizationId: scope.organizationId,
    actorUserId: null,
    actorType: 'shopify_webhook',
    action: 'dsr_created',
    targetType: 'dsr_request',
    targetId: row.id,
    metadata: { type, trigger: 'shopify_webhook' },
  });
}

/**
 * Applies a fully-resolved order snapshot (shopify-integration.md §4.4/§4.5), regardless of whether
 * it came straight from a REST `orders/*` webhook or from a GraphQL `fetchOrder` call. Currency is
 * checked *before* any money parsing (M1-2 review item 5): this codebase has no per-row FX handling
 * anywhere downstream, so a non-INR order is skipped rather than stored with a paise value that
 * would be silently wrong wherever it's later summed alongside real INR orders. This is a
 * deliberate MVP limitation (parallel to SPEC §2's non-INR ad-account rejection), not a bug.
 */
async function applyOrderSnapshot(
  deps: TenantScopeDeps,
  scope: TenantScope,
  storeId: string,
  hasher: IdentityHasher,
  identity: OrderApplyDeps,
  snapshot: ShopifyOrderSnapshot,
  eventStatus: 'created' | 'updated' | 'cancelled' | 'refund' | 'fulfillment',
  rawRef: string,
): Promise<void> {
  if (snapshot.currency !== 'INR') {
    console.error(
      JSON.stringify({
        event: 'shopify_order_non_inr_skipped',
        store_id: storeId,
        currency: snapshot.currency,
      }),
    );
    return;
  }

  const fields = mapOrderSnapshot(snapshot, storeId, hasher);
  if (fields.moneySanityExceeded) {
    // Flagged, not rejected (shopify-integration.md §7) — logged so it surfaces in ops, still stored.
    console.error(
      JSON.stringify({ event: 'shopify_order_money_sanity_exceeded', store_id: storeId }),
    );
  }

  // HLD §6b: an erased shopper's order is stored without their hashes (and so is never stitched to a
  // visitor); the revenue still counts, as Unattributed. The check tries every key version's hash.
  const erased = await isIdentityErased(
    identity.redis,
    storeId,
    fields.identityLookup,
    Math.floor(Date.now() / 1000),
  );

  const applied = await createOrderRepository(deps.db).applySnapshot(scope, {
    storeId,
    externalOrderId: snapshot.externalOrderId,
    createdAtPlatform: fields.createdAtPlatform,
    totalAmountPaise: fields.totalAmountPaise,
    currency: fields.currency,
    paymentMethod: fields.paymentMethod,
    refundedAmountPaise: fields.refundedAmountPaise,
    financialStatus: fields.financialStatus,
    fulfilmentStatus: fields.fulfilmentStatus,
    cancelledAt: fields.cancelledAt,
    pincodePrefix: fields.pincodePrefix,
    phoneHashHmac: erased ? null : fields.phoneHashHmac,
    emailHashHmac: erased ? null : fields.emailHashHmac,
    landingSite: fields.landingSite,
    referringSite: fields.referringSite,
    noteAttributes: fields.noteAttributes,
    discountCodes: fields.discountCodes,
    sourceTimestamp: new Date(snapshot.updatedAtPlatform),
    eventStatus,
    rawRef,
  });

  // Stitch the order to its visitor (identity-stitching.md §2.1). Enqueued on every apply, not only a
  // new event: a crash between the apply and this call would otherwise lose the job for good, and the
  // job id dedupes the repeats (a completed job is kept 30 days).
  await identity.identityStitchQueue.add(
    'stitch',
    { storeId, orderId: applied.orderId, attempt: 0 },
    { jobId: identityStitchJobId(applied.orderId, 0), ...IDENTITY_STITCH_JOB_OPTIONS },
  );
}

const ORDER_EVENT_STATUS_BY_TOPIC: Readonly<
  Record<(typeof ORDERS_TOPICS)[number], 'created' | 'updated' | 'cancelled'>
> = {
  'orders/create': 'created',
  'orders/updated': 'updated',
  'orders/cancelled': 'cancelled',
};

/** `orders/create` | `orders/updated` | `orders/cancelled` — a full snapshot, straight from the payload. */
async function handleOrderWebhook(
  deps: TenantScopeDeps,
  scope: TenantScope,
  storeId: string,
  hasher: IdentityHasher,
  identity: OrderApplyDeps,
  shopifyTopic: (typeof ORDERS_TOPICS)[number],
  rawBody: Buffer,
  webhookId: string,
): Promise<void> {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    reportValidationFailure('shopify_order_webhook_malformed_json', shopifyTopic, []);
    return;
  }
  const parsed = ShopifyOrderWebhook.safeParse(json);
  if (!parsed.success) {
    reportValidationFailure(
      'shopify_order_webhook_validation_failed',
      shopifyTopic,
      zodIssuePaths(parsed.error),
    );
    return; // ack — retrying a payload that will never parse doesn't help
  }
  const snapshot = snapshotFromOrderWebhook(parsed.data);
  await applyOrderSnapshot(
    deps,
    scope,
    storeId,
    hasher,
    identity,
    snapshot,
    ORDER_EVENT_STATUS_BY_TOPIC[shopifyTopic],
    webhookId,
  );
}

/**
 * `refunds/create` | `fulfillments/create` | `fulfillments/update` — a partial hint. Always
 * refetches the full order via GraphQL (M1-2 review item 1: this network call happens here, before
 * `applyOrderSnapshot` ever opens a transaction) — this also transparently handles the order not
 * existing locally yet (an out-of-order delivery), since `fetchOrder` returns the full snapshot
 * regardless of whether we've seen this order before.
 */
async function handleOrderHintWebhook(
  deps: TenantScopeDeps,
  scope: TenantScope,
  storeId: string,
  shop: string,
  hasher: IdentityHasher,
  identity: OrderApplyDeps,
  credentialsDeps: { readonly adapter: ShopifyAdapter; readonly cipher: CredentialsCipher },
  shopifyTopic: (typeof ORDER_HINTS_TOPICS)[number],
  rawBody: Buffer,
  webhookId: string,
): Promise<void> {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    reportValidationFailure('shopify_order_hint_webhook_malformed_json', shopifyTopic, []);
    return;
  }
  const parsed = ShopifyOrderHintWebhook.safeParse(json);
  if (!parsed.success) {
    reportValidationFailure(
      'shopify_order_hint_webhook_validation_failed',
      shopifyTopic,
      zodIssuePaths(parsed.error),
    );
    return;
  }

  const snapshot = await fetchOrderWithTokenRefresh(
    { db: deps.db, adapter: credentialsDeps.adapter, cipher: credentialsDeps.cipher },
    scope,
    storeId,
    shop,
    String(parsed.data.order_id),
  );
  if (!snapshot) {
    // Shopify has no such order — shouldn't happen for a refund/fulfillment hint in practice; ack
    // and skip rather than retry forever (there is nothing to create the row from).
    console.error(
      JSON.stringify({
        event: 'shopify_order_hint_order_not_found',
        store_id: storeId,
        topic: shopifyTopic,
      }),
    );
    return;
  }

  const eventStatus = shopifyTopic === 'refunds/create' ? 'refund' : 'fulfillment';
  await applyOrderSnapshot(
    deps,
    scope,
    storeId,
    hasher,
    identity,
    snapshot,
    eventStatus,
    webhookId,
  );
}

/**
 * Shopify's `bulk_operations/finish` payload. Only the fields we act on; `admin_graphql_api_id` is
 * the operation GID, `type` is `query` (our backfill) or `mutation`. No customer data is in it.
 */
const BulkOperationFinishWebhook = z.object({
  admin_graphql_api_id: z.string().min(1),
  type: z.string(),
  status: z.string(),
});

/**
 * `bulk_operations/finish` — the backfill query has ended (any terminal status). Enqueues
 * `bulk_result` and does nothing else: the worker re-reads the operation from Shopify and decides
 * (apply the result, or record the failure), so this handler needn't trust the webhook's own
 * `status` and there is a single code path for success and failure. Mutation-type operations are
 * not ours and are ignored. `jobId` dedupes a redelivered webhook into the one job; it is
 * `bulk-result-<n>` rather than the LLD's `shopify-bulk:<id>` because BullMQ custom job ids can't
 * contain ':' (same constraint as the backfill job id in routes/integrations.ts).
 */
async function handleBulkOperationFinish(
  webhook: ShopifyWebhookDeps,
  storeId: string,
  shopifyTopic: string,
  rawBody: Buffer,
): Promise<void> {
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    reportValidationFailure('shopify_bulk_operation_webhook_malformed_json', shopifyTopic, []);
    return;
  }
  const parsed = BulkOperationFinishWebhook.safeParse(json);
  if (!parsed.success) {
    reportValidationFailure(
      'shopify_bulk_operation_webhook_validation_failed',
      shopifyTopic,
      zodIssuePaths(parsed.error),
    );
    return; // ack — retrying a payload that will never parse doesn't help
  }
  if (parsed.data.type !== 'query') return;

  const bulkOperationId = parsed.data.admin_graphql_api_id;
  await webhook.shopifySyncQueue.add(
    'bulk_result',
    { storeId, mode: 'bulk_result', bulkOperationId },
    { jobId: `bulk-result-${bulkOperationId.split('/').pop() ?? bulkOperationId}` },
  );
}

export function registerShopifyWebhookRoutes(
  app: FastifyInstance,
  deps: TenantScopeDeps,
  webhook: ShopifyWebhookDeps,
): void {
  // Raw-body parsing is scoped to this plugin instance only (Fastify's content-type parsers are
  // encapsulated per registration), so no other route in the app is affected — the ADR-0022 bridge
  // bug (Fastify consuming JSON bodies before a raw handler can see them) doesn't recur here.
  app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scope.post<{ Params: { topic: string } }>(
      '/webhooks/shopify/:topic',
      async (request, reply) => {
        const rawBody = request.body as Buffer;
        const hmacHeader = request.headers['x-shopify-hmac-sha256'];
        if (typeof hmacHeader !== 'string' || !webhook.adapter.verifyWebhook(rawBody, hmacHeader)) {
          await reply.code(401).send({ error: 'invalid_hmac' });
          return;
        }

        const shopDomainHeader = request.headers['x-shopify-shop-domain'];
        const shopifyTopic = request.headers['x-shopify-topic'];
        const webhookId = request.headers['x-shopify-webhook-id'];
        if (
          typeof shopDomainHeader !== 'string' ||
          typeof shopifyTopic !== 'string' ||
          typeof webhookId !== 'string'
        ) {
          await reply.code(400).send({ error: 'missing_headers' });
          return;
        }

        const allowedTopics = TOPIC_GROUPS[request.params.topic];
        if (!allowedTopics?.includes(shopifyTopic)) {
          // X-Shopify-Topic doesn't belong to this :topic group (or :topic is unknown) — 200, no-op,
          // never a signal a caller could use to probe topic routing (shopify-integration.md §2.1).
          await reply.code(200).send();
          return;
        }

        const resolved = await resolveStoreByShopDomain(deps.db, shopDomainHeader.toLowerCase());
        if (!resolved) {
          // Unknown or deleted store — 200 and drop (shopify-integration.md §4.2 step 3). Compliance
          // topics for an already-uninstalled store still need handling; that store is NOT unknown
          // here (its row persists until `shop/redact`), so this branch is genuinely "never heard of it".
          await reply.code(200).send();
          return;
        }
        const scope = jobScope(resolved.organizationId, resolved.id);
        const deliveries = createWebhookDeliveryRepository(deps.db);

        // Checked *before* dispatching to a handler — uniformly across every topic, not just the
        // compliance ones (CLAUDE.md "Webhooks: verify, dedupe"). The matching write happens only
        // *after* the handler below succeeds (see the comment there): recording the delivery here,
        // before processing, would let a handler crash on attempt 1 permanently swallow the event —
        // Shopify's retry of the same webhook id would then see it as already delivered and skip it
        // forever, exactly the failure mode ADR-0017 rejected for the pixel event stream.
        if (await deliveries.wasAlreadyDelivered(scope, { storeId: resolved.id, webhookId })) {
          await reply.code(200).send();
          return;
        }

        if (shopifyTopic === 'app/uninstalled') {
          await handleAppUninstalled(deps, scope, resolved.id);
        } else if (
          shopifyTopic === 'customers/data_request' ||
          shopifyTopic === 'customers/redact' ||
          shopifyTopic === 'shop/redact'
        ) {
          await handleComplianceWebhook(
            { ...deps, hasher: webhook.hasher },
            scope,
            resolved.id,
            shopifyTopic,
            webhookId,
            rawBody,
          );
        } else if (
          shopifyTopic === 'orders/create' ||
          shopifyTopic === 'orders/updated' ||
          shopifyTopic === 'orders/cancelled'
        ) {
          await handleOrderWebhook(
            deps,
            scope,
            resolved.id,
            webhook.hasher,
            webhook,
            shopifyTopic,
            rawBody,
            webhookId,
          );
        } else if (
          shopifyTopic === 'refunds/create' ||
          shopifyTopic === 'fulfillments/create' ||
          shopifyTopic === 'fulfillments/update'
        ) {
          await handleOrderHintWebhook(
            deps,
            scope,
            resolved.id,
            shopDomainHeader.toLowerCase(),
            webhook.hasher,
            webhook,
            { adapter: webhook.adapter, cipher: webhook.cipher },
            shopifyTopic,
            rawBody,
            webhookId,
          );
        } else if (shopifyTopic === 'bulk_operations/finish') {
          await handleBulkOperationFinish(webhook, resolved.id, shopifyTopic, rawBody);
        }

        // Only reached once the handler above (if any) has completed without throwing — an error
        // propagates past this point instead, so the delivery is never marked done and Shopify's
        // retry re-runs the handler from scratch.
        await deliveries.recordDelivery(scope, {
          storeId: resolved.id,
          webhookId,
          topic: shopifyTopic,
        });
        await reply.code(200).send();
      },
    );
  });
}
