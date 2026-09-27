import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { resolveMembership } from '@truepath/auth';
import {
  createIntegrationRepository,
  createStoreRepository,
  ShopLinkedToAnotherOrganizationError,
} from '@truepath/db';
import type { ShopifyAdapter } from '@truepath/integrations';
import type { CredentialsCipher } from '@truepath/privacy';
import {
  IntegrationProvider,
  isShopifyShopDomain,
  roleCan,
  type TenantScope,
} from '@truepath/shared';
import { consumeShopifyOAuthState, issueShopifyOAuthState } from '../shopifyOAuthState.js';
import {
  requireOrgScope,
  requirePermission,
  requireSession,
  type TenantScopeDeps,
} from '../tenantScope.js';

/**
 * `GET /v1/orgs/:id/integrations/shopify/connect`, `GET /v1/integrations/shopify/callback` and
 * `DELETE /v1/orgs/:id/integrations/:integrationId` (ADR-0024, shopify-integration.md §2.1, §4.1).
 * The `DELETE` route is provider-agnostic (it will serve Meta/Google Ads integrations too, from
 * M2); `connect`/`callback` are Shopify-specific for now.
 */
export interface ShopifyIntegrationDeps {
  readonly adapter: ShopifyAdapter;
  readonly cipher: CredentialsCipher;
  /** Durable Redis (ADR-0025's single-use nonce store) — the same connection rateLimit.ts uses. */
  readonly redis: Redis;
  readonly oauthStateSecret: string;
  /** Our own base URL — builds the one fixed, pre-registered OAuth redirect_uri (ADR-0024). */
  readonly appUrl: string;
  /** Where the merchant's browser lands after a successful connect. */
  readonly dashboardUrl: string;
}

function callbackRedirectUri(appUrl: string): string {
  return `${appUrl}/v1/integrations/shopify/callback`;
}

export function registerIntegrationRoutes(
  app: FastifyInstance,
  deps: TenantScopeDeps,
  shopify: ShopifyIntegrationDeps,
): void {
  app.get<{ Params: { id: string }; Querystring: { shop?: string } }>(
    '/v1/orgs/:id/integrations/shopify/connect',
    { preHandler: [requireOrgScope(deps), requirePermission('integrations.manage')] },
    async (request, reply) => {
      const scope = request.scope!;
      const shop = (request.query.shop ?? '').toLowerCase();
      if (!isShopifyShopDomain(shop)) {
        await reply.code(400).send({ error: 'invalid_shop_domain' });
        return;
      }

      const state = await issueShopifyOAuthState(
        { redis: shopify.redis, secret: shopify.oauthStateSecret },
        { userId: scope.userId!, organizationId: scope.organizationId, shop },
      );
      const authorizeUrl = shopify.adapter.authUrl(
        shop,
        state,
        callbackRedirectUri(shopify.appUrl),
      );
      await reply.redirect(authorizeUrl);
    },
  );

  // No requireOrgScope/requireStoreScope: Shopify's redirect_uri must be one fixed, pre-registered
  // URL with no dynamic path segment (ADR-0024), so this route carries no :id at all. Tenant binding
  // comes entirely from the signed, single-use state token (ADR-0025) plus this live session check.
  app.get<{ Querystring: { shop?: string; code?: string; state?: string } }>(
    '/v1/integrations/shopify/callback',
    async (request, reply) => {
      const session = await requireSession(deps, request, reply);
      if (!session) return;

      const { shop, code, state } = request.query;
      if (!shop || !code || !state) {
        await reply.code(400).send({ error: 'invalid_callback_request' });
        return;
      }
      const normalizedShop = shop.toLowerCase();

      // Every check below fails with the same generic response — a caller must not be able to tell
      // "bad signature" from "reused nonce" from "lost permission" (ADR-0025).
      const invalidState = async () => {
        await reply.code(403).send({ error: 'invalid_oauth_state' });
      };

      const consumed = await consumeShopifyOAuthState(
        { redis: shopify.redis, secret: shopify.oauthStateSecret },
        state,
      );
      if (!consumed.ok) {
        await invalidState();
        return;
      }
      if (consumed.claims.userId !== session.user.id) {
        await invalidState();
        return;
      }
      if (consumed.claims.shop !== normalizedShop) {
        await invalidState();
        return;
      }

      const membership = await resolveMembership(
        deps.db,
        session.user.id,
        consumed.claims.organizationId,
      );
      if (!membership || !roleCan(membership.role, 'integrations.manage')) {
        await invalidState();
        return;
      }

      const orgScope: TenantScope = {
        kind: 'tenant',
        userId: session.user.id,
        organizationId: consumed.claims.organizationId,
        role: membership.role,
        storeIds: new Set(),
      };

      let credentials;
      try {
        credentials = await shopify.adapter.exchangeCode(normalizedShop, code);
      } catch {
        await reply.code(502).send({ error: 'shopify_token_exchange_failed' });
        return;
      }

      let info;
      try {
        info = await shopify.adapter.shopInfo(normalizedShop, credentials);
      } catch {
        await reply.code(502).send({ error: 'shopify_shop_info_failed' });
        return;
      }

      let store;
      try {
        store = await createStoreRepository(deps.db).upsertByShopDomain(orgScope, {
          organizationId: consumed.claims.organizationId,
          shopDomain: normalizedShop,
          currency: info.currency,
        });
      } catch (error) {
        if (error instanceof ShopLinkedToAnotherOrganizationError) {
          await reply.code(409).send({ error: 'shop_linked_elsewhere' });
          return;
        }
        throw error;
      }

      const storeScope: TenantScope = { ...orgScope, storeIds: new Set([store.id]) };
      const integration = await createIntegrationRepository(deps.db).upsertShopify(storeScope, {
        storeId: store.id,
        externalAccountId: info.gid,
        credentialsJson: JSON.stringify(credentials),
        scopes: credentials.scope.split(','),
        cipher: shopify.cipher,
      });

      await deps.audit.log.write(storeScope, {
        organizationId: consumed.claims.organizationId,
        actorUserId: session.user.id,
        actorType: 'user',
        action: 'integration_connected',
        targetType: 'integration',
        targetId: integration.id,
        metadata: { provider: 'shopify' },
      });

      await reply.redirect(`${shopify.dashboardUrl}/stores/${store.id}/connected`);
    },
  );

  app.delete<{ Params: { id: string; integrationId: string } }>(
    '/v1/orgs/:id/integrations/:integrationId',
    { preHandler: [requireOrgScope(deps), requirePermission('integrations.manage')] },
    async (request, reply) => {
      const scope = request.scope!;
      const revoked = await createIntegrationRepository(deps.db).revokeForOrganization(
        scope,
        scope.organizationId,
        request.params.integrationId,
      );
      if (!revoked) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      await deps.audit.log.write(scope, {
        organizationId: scope.organizationId,
        actorUserId: scope.userId,
        actorType: 'user',
        action: 'integration_disconnected',
        targetType: 'integration',
        targetId: revoked.id,
        metadata: { provider: IntegrationProvider.parse(revoked.provider) },
      });
      await reply.code(204).send();
    },
  );
}
