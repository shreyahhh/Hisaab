import type { Redis } from 'ioredis';
import {
  createAuditLogRepository,
  createCollectorConfigRepository,
  createSuppressionRebuildRepository,
  createSystemScope,
  jobScope,
  publishCollectorConfig,
  type ActiveSuppressionRow,
  type Db,
} from '@truepath/db';
import type { CredentialsCipher } from '@truepath/privacy';
import { SUPPRESS_READY_KEY, suppressionSetKey, type SuppressionSetKind } from '@truepath/shared';
import { isSuppressionReady } from './eventSuppression.js';

// Rebuilding the suppression sets and the readiness marker (HLD §8 "Suppression set"; privacy-dpdp.md
// §4.9). `suppress:ready` is written only after a full rebuild; while it is absent the Collector answers
// 503 and every worker pauses (fail closed), so this is what turns them back on after durable Redis was
// restarted empty. Postgres (`suppressed_identities`) is the source of truth; Redis is a hot copy.

export const REBUILD_PAGE_SIZE = 10_000;
const ZADD_CHUNK = 5_000;

export interface RebuildDeps {
  readonly db: Db;
  readonly redis: Redis;
  /** The readiness marker; only tests override the default (`suppress:ready`). */
  readonly readyKey?: string;
  readonly now?: () => Date;
  readonly pageSize?: number;
  /** Limit the rebuild to these stores (a targeted rebuild, or a test). Omitted = every store. */
  readonly storeIds?: readonly string[];
  /**
   * When given, every store's `collector:store:<store_key>` config is republished too (#56, HLD §8): after
   * durable Redis is lost those keys are gone, and without them the Collector rejects the pixel of
   * every store until each is re-saved. Omitted only by tests that don't seed integrations.
   */
  readonly configs?: {
    readonly cipher: CredentialsCipher;
    readonly dpaVersion: string;
    /** Issue #52: whether a `paused` consent_health actually deactivates the config. */
    readonly consentPauseEnabled?: boolean;
  };
  /** Counts and error names only. */
  readonly log?: (line: Record<string, unknown>) => void;
}

export interface RebuildResult {
  readonly stores: number;
  readonly entries: number;
  /** Present when configs were republished. Logged, not audited: the audit schema is counts of sets only. */
  readonly configs?: ConfigRepublishResult;
}

export interface ConfigRepublishResult {
  /** Written to Redis (active or inactive: the Collector needs the key either way). */
  readonly published: number;
  /** Nothing to publish yet (no keys). */
  readonly skipped: number;
  /** Threw (for example undecryptable credentials); the rebuild carries on without it. */
  readonly failed: number;
}

function setKind(row: ActiveSuppressionRow): SuppressionSetKind | null {
  if (row.identifierType === 'visitor_id') {
    return row.reason === 'erased' ? 'erased:visitor' : 'withdrawn:visitor';
  }
  // Only an erased *identity* is ever suppressed; a `withdrawn` identity row is not a defined state.
  return row.reason === 'erased' ? 'erased:identity' : null;
}

/**
 * Reloads every store's active suppression entries into Redis, then sets the readiness marker.
 *
 * - Runs under an audited `SystemScope` (reason `suppression_rebuild`, ADR-0016).
 * - Replace-safe: each set is replaced in one MULTI (`DEL` + `ZADD`), so re-running it, or running two at
 *   once, ends in the same state and never leaves a set half-built.
 * - Order matters: sets first, then (when `configs` is given) every store's collector config, then the
 *   `suppression_rebuilt` audit row, then the marker. The marker is
 *   the last thing written, so nothing is ever "ready" without its sets or its audit trail. (A failure
 *   after the sets leaves the marker unset and the whole rebuild is retried.)
 */
export async function rebuildSuppression(deps: RebuildDeps): Promise<RebuildResult> {
  const now = (deps.now ?? (() => new Date()))();
  const scope = await createSystemScope(deps.db, 'suppression_rebuild');
  const repo = createSuppressionRebuildRepository(deps.db);
  const pageSize = deps.pageSize ?? REBUILD_PAGE_SIZE;

  const sets = new Map<string, Map<string, number>>();
  const stores = new Set<string>();
  let entries = 0;
  let afterId: string | null = null;
  for (;;) {
    const page = await repo.listActivePage(scope, {
      afterId,
      limit: pageSize,
      now,
      ...(deps.storeIds !== undefined ? { storeIds: deps.storeIds } : {}),
    });
    for (const row of page) {
      const kind = setKind(row);
      if (kind === null) continue;
      const key = suppressionSetKey(scope, row.storeId, kind);
      let members = sets.get(key);
      if (!members) sets.set(key, (members = new Map()));
      members.set(row.identifier, Math.floor(row.expiresAt.getTime() / 1000));
      stores.add(row.storeId);
      entries += 1;
    }
    if (page.length < pageSize) break;
    afterId = page[page.length - 1]!.id;
  }

  for (const [key, members] of sets) {
    const multi = deps.redis.multi();
    multi.del(key);
    const flat = [...members].flatMap(([member, score]) => [score, member]);
    for (let i = 0; i < flat.length; i += ZADD_CHUNK * 2) {
      multi.zadd(key, ...flat.slice(i, i + ZADD_CHUNK * 2));
    }
    for (const [error] of (await multi.exec()) ?? []) if (error) throw error;
  }

  // Configs go in before the marker, like the sets: when the Collector turns ready its stores are there.
  // One store failing must not keep every other store (and the whole pipeline) waiting: a missing config
  // fails safe — the Collector rejects that pixel — whereas an absent marker stops everything.
  const configs = deps.configs ? await republishConfigs(deps, deps.configs, scope) : undefined;

  const counts = { stores: stores.size, entries };
  const result: RebuildResult = configs ? { ...counts, configs } : counts;
  await createAuditLogRepository(deps.db).writePlatform({
    action: 'suppression_rebuilt',
    actorType: 'system',
    targetType: 'suppression_sets',
    targetId: 'all',
    metadata: counts,
  });
  await deps.redis.set(deps.readyKey ?? SUPPRESS_READY_KEY, String(now.getTime()));
  return result;
}

async function republishConfigs(
  deps: RebuildDeps,
  configs: NonNullable<RebuildDeps['configs']>,
  systemScope: Parameters<
    ReturnType<typeof createCollectorConfigRepository>['listActiveShopifyStores']
  >[0],
): Promise<ConfigRepublishResult> {
  const listed = await createCollectorConfigRepository(deps.db).listActiveShopifyStores(
    systemScope,
    deps.storeIds !== undefined ? { storeIds: deps.storeIds } : {},
  );
  let published = 0;
  let skipped = 0;
  let failed = 0;
  for (const { storeId, organizationId } of listed) {
    try {
      // One-store scope per publish (ADR-0026): only the listing above needed the SystemScope.
      const config = await publishCollectorConfig(
        {
          db: deps.db,
          cipher: configs.cipher,
          sink: deps.redis,
          dpaVersion: configs.dpaVersion,
          consentPauseEnabled: configs.consentPauseEnabled,
        },
        jobScope(organizationId, storeId),
        storeId,
      );
      if (config) published += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      deps.log?.({
        event: 'collector_config_publish_failed',
        store_id: storeId,
        error_name: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
  return { published, skipped, failed };
}

export interface SuppressionRebuilderDeps extends RebuildDeps {
  readonly log: (line: Record<string, unknown>) => void;
  /** The marker went missing (or Redis is unreachable): pause what acts on shoppers. */
  readonly onUnavailable?: () => void | Promise<void>;
  /** The marker is back after having been missing: resume. */
  readonly onReady?: () => void | Promise<void>;
  readonly nowMs?: () => number;
  readonly intervalMs?: number;
  /** HLD §8: alert once the marker has been missing this long. */
  readonly alertAfterMs?: number;
}

export type TickOutcome = 'ready' | 'rebuilt' | 'failed';

/**
 * Keeps `suppress:ready` present: on start, and every `intervalMs` after, it checks the marker and
 * rebuilds when it is missing (HLD §8: "on Workers-service startup, and whenever the marker is found
 * missing"). Logs counts and error names only. Several Workers tasks may do this at once — a rebuild is
 * replace-safe.
 */
export class SuppressionRebuilder {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<TickOutcome> | null = null;
  private missingSince: number | null = null;
  private alerted = false;

  constructor(private readonly deps: SuppressionRebuilderDeps) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 10_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One check; overlapping calls share the same run. */
  tick(): Promise<TickOutcome> {
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<TickOutcome> {
    const { log } = this.deps;
    const nowMs = (this.deps.nowMs ?? Date.now)();

    let ready: boolean;
    try {
      ready = await isSuppressionReady(this.deps.redis, this.deps.readyKey);
    } catch (error) {
      log({ event: 'suppression_check_failed', error_name: nameOf(error) });
      await this.markMissing(nowMs);
      return 'failed';
    }

    if (ready) {
      if (this.missingSince !== null) {
        this.missingSince = null;
        this.alerted = false;
        await this.deps.onReady?.();
      }
      return 'ready';
    }

    await this.markMissing(nowMs);
    try {
      const result = await rebuildSuppression(this.deps);
      log({ event: 'suppression_rebuilt', ...result });
      this.missingSince = null;
      this.alerted = false;
      await this.deps.onReady?.();
      return 'rebuilt';
    } catch (error) {
      log({ event: 'suppression_rebuild_failed', error_name: nameOf(error) });
      return 'failed';
    }
  }

  private async markMissing(nowMs: number): Promise<void> {
    if (this.missingSince === null) {
      this.missingSince = nowMs;
      await this.deps.onUnavailable?.();
    }
    const missingMs = nowMs - this.missingSince;
    if (!this.alerted && missingMs > (this.deps.alertAfterMs ?? 60_000)) {
      this.alerted = true;
      this.deps.log({
        event: 'suppression_unavailable',
        alert: 'suppression_unavailable',
        missing_ms: missingMs,
      });
    }
  }
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
