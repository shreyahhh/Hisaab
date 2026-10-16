import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import {
  createMetaWarmupSchedulingRepository,
  createSystemScope,
  type WarmupState,
} from '@truepath/db';
import { requireSession, type TenantScopeDeps } from '../tenantScope.js';

export interface SystemStatusRouteDeps {
  readonly redis: Redis;
}

export interface MetaWarmupSummary {
  readonly store_id: string;
  readonly calls_total: number;
  readonly calls_success: number;
  readonly calls_error: number;
  /** `null` until at least one call has run (avoids a misleading 0% on a fresh ledger). */
  readonly error_rate: number | null;
  readonly last_run_at: string | null;
  readonly last_error_code: string | null;
  /** The Advanced Access bar from meta-integration.md §2.2: ≥ 1,500 calls, < 15% errors. */
  readonly meets_advanced_access_bar: boolean;
}

function summarise(state: WarmupState): MetaWarmupSummary {
  const w = state.warmup;
  const callsTotal = w?.calls_total ?? 0;
  const callsSuccess = w?.calls_success ?? 0;
  const callsError = w?.calls_error ?? 0;
  const errorRate = callsTotal > 0 ? callsError / callsTotal : null;
  return {
    store_id: state.storeId,
    calls_total: callsTotal,
    calls_success: callsSuccess,
    calls_error: callsError,
    error_rate: errorRate,
    last_run_at: w?.last_run_at ?? null,
    last_error_code: w?.last_error_code ?? null,
    meets_advanced_access_bar: callsTotal >= 1500 && errorRate !== null && errorRate < 0.15,
  };
}

// issue #63: the dashboard polls this route every 10s (apps/dashboard SystemPage), but the Meta
// warm-up read is cross-tenant and so needs its own audited SystemScope (ADR-0016) on every use —
// creating one per poll would write a system_scope_used row every 10s per open tab, for a value
// that changes at most once per warm-up run (every 15 min). A short in-process cache bounds that to
// at most one SystemScope (and one cross-store query) per TTL window, independent of poll rate.
// Per-instance (not shared across ECS tasks): acceptable for an internal diagnostics read, not a
// correctness concern — flagged as a decision, not silently assumed.
const META_WARMUP_CACHE_TTL_MS = 30_000;
let metaWarmupCache: { readonly at: number; readonly rows: readonly MetaWarmupSummary[] } | null =
  null;

async function getMetaWarmupSummaries(deps: TenantScopeDeps): Promise<MetaWarmupSummary[]> {
  const now = Date.now();
  if (metaWarmupCache && now - metaWarmupCache.at < META_WARMUP_CACHE_TTL_MS) {
    return [...metaWarmupCache.rows];
  }
  const scope = await createSystemScope(deps.db, 'meta_warmup_status_read');
  const states = await createMetaWarmupSchedulingRepository(deps.db).listWarmupStates(scope);
  const rows = states.map(summarise);
  metaWarmupCache = { at: now, rows };
  return rows;
}

/** Test-only: the cache above is module-level (by design — see the comment on it), so a test that
 * seeds a store after an earlier request already populated it needs a way to force a fresh read. */
export function resetMetaWarmupCacheForTests(): void {
  metaWarmupCache = null;
}

// HLD §8's canonical BullMQ queue names — only the ones actually implemented so far (M1). A queue
// with no worker yet (ad-sync-google-ads, shiprocket-sync, attribution-run's consumer, capi-dispatch,
// order-status-reconcile, retention) has no key to report on, so it's left out rather than reported
// as a permanent zero.
const IMPLEMENTED_QUEUES = ['shopify-sync', 'identity-stitch', 'ad-sync-meta', 'dsr'] as const;

/**
 * `GET /v1/system/status` — not tenant data (queue depths, the suppression-rebuild marker, and
 * per-store Meta warm-up call counts carry no shopper identifiers, and `store_id` alone is not
 * tenant-sensitive here — the same reasoning HLD §8 already gives this route), so any signed-in
 * user can view it; the dashboard's System status page. New, not in SPEC §10 — HLD §8's
 * pending-names table gets an entry. `meta_warmup` (issue #63, meta-integration.md §2.2) replaces
 * `pnpm --filter @truepath/workers dev:meta-warmup status <storeId>` as the way to check the
 * ≥ 1,500-calls / < 15%-errors Advanced Access bar without a terminal.
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

    const metaWarmup = await getMetaWarmupSummaries(deps);

    await reply.send({
      api: 'ok',
      suppress_ready_at: suppressReady ? Number(suppressReady) : null,
      stream_events_raw_length: streamLength,
      stream_events_dead_length: streamDeadLength,
      queues,
      meta_warmup: metaWarmup,
    });
  });
}
