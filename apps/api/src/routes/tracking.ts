import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { ch, type ClickHouseClient } from '@truepath/clickhouse';
import { statsCollectorKey } from '@truepath/shared';
import {
  requirePermission,
  requireStoreScope,
  type TenantScopeDeps,
} from '../tenantScope.js';

export interface TrackingRouteDeps {
  readonly clickhouse: ClickHouseClient;
  readonly redis: Redis;
}

const SummaryQuery = z.object({ days: z.coerce.number().int().min(1).max(90).optional() }).strict();

interface EventRow {
  readonly occurred_at: string;
  readonly event_name: string;
  readonly visitor_id: string;
  readonly session_id: string;
}

interface TouchpointRow {
  readonly channel: string;
}

// Bucket a ClickHouse `DateTime64(3, 'Asia/Kolkata')` string ("2026-09-29 12:34:56.789") by its IST
// calendar day, matching apps/collector's istDay() bucketing for the Redis drop counters below —
// the column is already rendered in IST, so no timezone math is needed here, unlike that helper.
function istDayFromClickHouseTimestamp(value: string): string {
  const [datePart] = value.split(' ');
  return (datePart ?? value).replaceAll('-', '');
}

const DROP_REASONS = [
  'no_analytics_consent',
  'stale_event',
  'foreign_page',
  'suppressed_visitor',
  'suppressed_identity',
  'store_inactive',
] as const;

/**
 * `GET /v1/stores/:id/tracking/summary` (dashboard Tracking page — not an SPEC §10 path; HLD §8
 * pending-names entry). Events/sessions per day, touchpoints by channel, and consent accepted vs.
 * dropped over the window. Read-only: no identifiers, only counts and channel labels.
 */
export function registerTrackingRoutes(
  app: FastifyInstance,
  deps: TenantScopeDeps,
  routeDeps: TrackingRouteDeps,
): void {
  app.get<{ Params: { storeId: string }; Querystring: Record<string, unknown> }>(
    '/v1/stores/:storeId/tracking/summary',
    { preHandler: [requireStoreScope(deps), requirePermission('reports.read')] },
    async (request, reply) => {
      const scope = request.scope!;
      const storeId = request.params.storeId;
      const query = SummaryQuery.safeParse(request.query);
      if (!query.success) {
        await reply.code(400).send({ error: 'invalid_query', fields: ['days'] });
        return;
      }
      const days = query.data.days ?? 14;

      const scoped = ch(routeDeps.clickhouse, scope, storeId);
      const events = await scoped.select<EventRow>({
        table: 'events',
        columns: ['occurred_at', 'event_name', 'visitor_id', 'session_id'],
        orderBy: 'occurred_at',
        orderDirection: 'DESC',
        limit: 5000,
      });
      const touchpoints = await scoped.select<TouchpointRow>({
        table: 'touchpoints',
        columns: ['channel'],
        orderBy: 'occurred_at',
        orderDirection: 'DESC',
        limit: 5000,
      });

      const perDay = new Map<string, number>();
      const visitors = new Set<string>();
      const sessions = new Set<string>();
      for (const row of events) {
        const day = istDayFromClickHouseTimestamp(row.occurred_at);
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
        visitors.add(row.visitor_id);
        sessions.add(row.session_id);
      }
      const byChannel = new Map<string, number>();
      for (const row of touchpoints) {
        byChannel.set(row.channel, (byChannel.get(row.channel) ?? 0) + 1);
      }

      // Consent drop counters live only in Redis (apps/collector/src/ingest.ts), bucketed per IST
      // calendar day — read the last `days` days' worth and sum them.
      const dropTotals: Record<string, number> = {};
      const now = Date.now();
      for (let i = 0; i < days; i += 1) {
        const ist = new Date(now - i * 86_400_000 + 5.5 * 60 * 60 * 1000);
        const day = `${ist.getUTCFullYear()}${String(ist.getUTCMonth() + 1).padStart(2, '0')}${String(
          ist.getUTCDate(),
        ).padStart(2, '0')}`;
        const key = statsCollectorKey(scope, storeId, day);
        const hash = await routeDeps.redis.hgetall(key);
        for (const reason of DROP_REASONS) {
          const n = Number(hash[reason] ?? 0);
          if (n > 0) dropTotals[reason] = (dropTotals[reason] ?? 0) + n;
        }
      }
      const dropped = Object.values(dropTotals).reduce((a, b) => a + b, 0);

      await reply.send({
        window_days: days,
        events_total: events.length,
        unique_visitors: visitors.size,
        unique_sessions: sessions.size,
        events_per_day: [...perDay.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([day, count]) => ({ day, count })),
        touchpoints_by_channel: [...byChannel.entries()]
          .sort(([, a], [, b]) => b - a)
          .map(([channel, count]) => ({ channel, count })),
        consent: {
          accepted: events.length,
          dropped,
          drop_reasons: dropTotals,
        },
      });
    },
  );
}
