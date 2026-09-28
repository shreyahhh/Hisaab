import type { Redis } from 'ioredis';
import {
  createAuditLogRepository,
  createSuppressionRebuildRepository,
  createSystemScope,
  type ActiveSuppressionRow,
  type Db,
} from '@truepath/db';
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
}

export interface RebuildResult {
  readonly stores: number;
  readonly entries: number;
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
 * - Order matters: sets first, then the `suppression_rebuilt` audit row, then the marker. The marker is
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

  const result: RebuildResult = { stores: stores.size, entries };
  await createAuditLogRepository(deps.db).writePlatform({
    action: 'suppression_rebuilt',
    actorType: 'system',
    targetType: 'suppression_sets',
    targetId: 'all',
    metadata: result,
  });
  await deps.redis.set(deps.readyKey ?? SUPPRESS_READY_KEY, String(now.getTime()));
  return result;
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
