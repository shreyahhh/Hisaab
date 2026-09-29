import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ch, type ClickHouseClient } from '@truepath/clickhouse';
import { createOrderRepository } from '@truepath/db';
import {
  requirePermission,
  requireStoreScope,
  type TenantScopeDeps,
} from '../tenantScope.js';

export interface OrderRouteDeps {
  readonly clickhouse: ClickHouseClient;
}

const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }).strict();

interface TouchpointRow {
  readonly occurred_at: string;
  readonly channel: string;
  readonly sub_channel: string;
  readonly platform: string;
  readonly campaign_id: string;
  readonly adset_id: string;
  readonly ad_id: string;
  readonly click_id_type: string;
  readonly is_direct: number;
}

/**
 * `GET /v1/stores/:id/orders` (dashboard Orders page — a plain list endpoint SPEC §10 doesn't
 * itself name; SPEC's own `/orders/:orderId/journey` implies the same `/orders` namespace, so this
 * follows it rather than inventing a new prefix. HLD §8's pending-names table gets an entry).
 * `GET /v1/stores/:id/orders/:orderId/journey` (SPEC §10, exact path): the matched touchpoints for
 * the order's stitched visitor, chronological. Never returns raw phone/email — only whether a hash
 * is present (CLAUDE.md: no raw identifiers over the wire).
 */
export function registerOrderRoutes(
  app: FastifyInstance,
  deps: TenantScopeDeps,
  routeDeps: OrderRouteDeps,
): void {
  app.get<{ Params: { storeId: string }; Querystring: Record<string, unknown> }>(
    '/v1/stores/:storeId/orders',
    { preHandler: [requireStoreScope(deps), requirePermission('reports.read')] },
    async (request, reply) => {
      const scope = request.scope!;
      const query = ListQuery.safeParse(request.query);
      if (!query.success) {
        await reply.code(400).send({ error: 'invalid_query', fields: ['limit'] });
        return;
      }
      const rows = await createOrderRepository(deps.db).listRecentByStore(
        scope,
        request.params.storeId,
        query.data.limit ?? 20,
      );
      await reply.send({
        orders: rows.map((row) => ({
          id: row.id,
          external_order_id: row.externalOrderId,
          created_at_platform: row.createdAtPlatform.toISOString(),
          total_amount_paise: row.totalAmountPaise,
          currency: row.currency,
          payment_method: row.paymentMethod,
          delivery_status: row.deliveryStatus,
          attribution_confidence: row.attributionConfidence,
          visitor_matched: row.visitorId !== null,
          phone_hash_present: row.phoneHashHmac !== null,
          email_hash_present: row.emailHashHmac !== null,
        })),
      });
    },
  );

  app.get<{ Params: { storeId: string; orderId: string } }>(
    '/v1/stores/:storeId/orders/:orderId/journey',
    { preHandler: [requireStoreScope(deps), requirePermission('journey.read')] },
    async (request, reply) => {
      const scope = request.scope!;
      const { storeId, orderId } = request.params;
      const order = await createOrderRepository(deps.db).getById(scope, storeId, orderId);
      if (!order) {
        await reply.code(404).send({ error: 'not_found' });
        return;
      }
      if (!order.visitorId) {
        await reply.send({ order_id: orderId, visitor_matched: false, touchpoints: [] });
        return;
      }

      const rows = await ch(routeDeps.clickhouse, scope, storeId).select<TouchpointRow>({
        table: 'touchpoints',
        columns: [
          'occurred_at',
          'channel',
          'sub_channel',
          'platform',
          'campaign_id',
          'adset_id',
          'ad_id',
          'click_id_type',
          'is_direct',
        ],
        where: { visitor_id: { op: '=', value: order.visitorId, type: 'String' } },
        orderBy: 'occurred_at',
        limit: 200,
      });

      await reply.send({
        order_id: orderId,
        visitor_matched: true,
        touchpoints: rows.map((row) => ({
          occurred_at: row.occurred_at,
          channel: row.channel,
          sub_channel: row.sub_channel,
          platform: row.platform || null,
          campaign_id: row.campaign_id || null,
          adset_id: row.adset_id || null,
          ad_id: row.ad_id || null,
          click_id_type: row.click_id_type || null,
          is_direct: row.is_direct === 1,
        })),
      });
    },
  );
}
