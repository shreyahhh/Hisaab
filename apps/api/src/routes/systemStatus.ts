import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { requireSession, type TenantScopeDeps } from '../tenantScope.js';

export interface SystemStatusRouteDeps {
  readonly redis: Redis;
}

// HLD §8's canonical BullMQ queue names — only the ones actually implemented so far (M1). A queue
// with no worker yet (ad-sync-google-ads, shiprocket-sync, attribution-run's consumer, capi-dispatch,
// order-status-reconcile, retention) has no key to report on, so it's left out rather than reported
// as a permanent zero.
const IMPLEMENTED_QUEUES = ['shopify-sync', 'identity-stitch', 'ad-sync-meta', 'dsr'] as const;

/**
 * `GET /v1/system/status` — not tenant data (queue depths and the suppression-rebuild marker carry
 * no store or shopper identifiers), so any signed-in user can view it; the dashboard's System status
 * page. New, not in SPEC §10 — HLD §8's pending-names table gets an entry.
 */
export function registerSystemStatusRoutes(
  app: FastifyInstance,
  deps: TenantScopeDeps,
  routeDeps: SystemStatusRouteDeps,
): void {
  app.get('/v1/system/status', async (request, reply) => {
    const session = await requireSession(deps, request, reply);
    if (!session) return;

    const redis = routeDeps.redis;
    const [suppressReady, streamLength, streamDeadLength] = await Promise.all([
      redis.get('suppress:ready'),
      redis.xlen('stream:events-raw').catch(() => null),
      redis.xlen('stream:events-dead').catch(() => null),
    ]);

    const queues = await Promise.all(
      IMPLEMENTED_QUEUES.map(async (name) => {
        const [waiting, active, failed] = await Promise.all([
          redis.llen(`bull:${name}:wait`).catch(() => null),
          redis.llen(`bull:${name}:active`).catch(() => null),
          redis.zcard(`bull:${name}:failed`).catch(() => null),
        ]);
        return { name, waiting, active, failed };
      }),
    );

    await reply.send({
      api: 'ok',
      suppress_ready_at: suppressReady ? Number(suppressReady) : null,
      stream_events_raw_length: streamLength,
      stream_events_dead_length: streamDeadLength,
      queues,
    });
  });
}
