import type { FastifyInstance } from 'fastify';
import {
  createDsrRequestRepository,
  createIntegrationRepository,
  createStoreRepository,
  jobScope,
  resolveStoreByShopDomain,
} from '@truepath/db';
import type { ShopifyAdapter } from '@truepath/integrations';
import { storeContext, type IdentityHasher } from '@truepath/privacy';
import type { TenantScope } from '@truepath/shared';
import type { TenantScopeDeps } from '../tenantScope.js';

// POST /webhooks/shopify/:topic (shopify-integration.md §2.2, §2.4, §4.2, §4.8). Only `app/uninstalled`
// and the three compliance topics do real work in this ticket (M1-1); orders/refunds/fulfillments/
// bulk_operations are acknowledged (200) and left for M1-2/M1-3 — see the tracked follow-up issue.
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
        }
        // orders/*, order-hints/*, bulk_operations/finish: acknowledged only — tracked follow-up issue.

        await reply.code(200).send();
      },
    );
  });
}
