import type { Redis } from 'ioredis';
import { EVENT_WORKERS_GROUP, STREAM_EVENTS_DEAD, STREAM_EVENTS_RAW } from '@truepath/shared';
import type { BatchResult, SessionMemo } from './eventBatch.js';
import { SuppressionNotReadyError } from './eventSuppression.js';
import { toRawEntry, type RawStreamEntry } from './streamEntries.js';

// The `event-workers` consumer loop (event-pipeline.md §4.1 steps 1–2 and 14–15, §4.5, §5): it reads
// `stream:events-raw` through the consumer group, hands batches to `processEventBatch`, XACKs only what
// that returns, and every 30 s reclaims entries a crashed consumer left pending and dead-letters ones
// that keep failing. It logs counts and error *names* only — never an entry, a visitor id, a hash or an
// error message (which can carry SQL parameters).

export interface EventConsumerOptions {
  readonly consumer: string;
  readonly stream?: string;
  readonly group?: string;
  readonly deadStream?: string;
  readonly batchSize?: number;
  readonly flushMs?: number;
  readonly readCount?: number;
  readonly blockMs?: number;
  readonly reclaimEveryMs?: number;
  readonly minIdleMs?: number;
  readonly poisonDeliveries?: number;
  readonly retryBackoffMs?: readonly number[];
  readonly notReadyPollMs?: number;
  readonly deadMaxLen?: number;
  readonly idleConsumerMs?: number;
}

export interface EventConsumerDeps {
  /** Dedicated to XREADGROUP BLOCK — a blocked connection can't run anything else. */
  readonly reader: Redis;
  /** Everything else (acks, reclaim, dead-letter). */
  readonly redis: Redis;
  readonly process: (raw: readonly RawStreamEntry[], memo: SessionMemo) => Promise<BatchResult>;
  readonly log: (line: Record<string, unknown>) => void;
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

type StreamReply = [string, [string, string[]][]][] | null;

const DEFAULTS = {
  batchSize: 1000,
  flushMs: 1500,
  readCount: 500,
  blockMs: 500,
  reclaimEveryMs: 30_000,
  minIdleMs: 60_000,
  poisonDeliveries: 5,
  retryBackoffMs: [1000, 2000, 4000, 8000, 16_000, 30_000],
  notReadyPollMs: 1000,
  deadMaxLen: 100_000,
  idleConsumerMs: 3_600_000,
} as const;

export class EventConsumer {
  private stopped = false;
  private readonly inFlight = new Set<string>();
  private readonly o: Required<EventConsumerOptions>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly deps: EventConsumerDeps,
    options: EventConsumerOptions,
  ) {
    this.o = {
      ...DEFAULTS,
      stream: STREAM_EVENTS_RAW,
      group: EVENT_WORKERS_GROUP,
      deadStream: STREAM_EVENTS_DEAD,
      ...options,
    } as Required<EventConsumerOptions>;
    this.now = deps.nowMs ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  stop(): void {
    this.stopped = true;
  }

  /** Creates the group at the start of the stream, so entries appended before it existed are not missed. */
  async ensureGroup(): Promise<void> {
    try {
      await this.deps.redis.xgroup('CREATE', this.o.stream, this.o.group, '0', 'MKSTREAM');
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error;
    }
  }

  async run(): Promise<void> {
    await this.ensureGroup();
    let batch: RawStreamEntry[] = [];
    let batchStartedAt = 0;
    let nextReclaimAt = this.now() + this.o.reclaimEveryMs;
    let nextCleanupAt = this.now() + this.o.idleConsumerMs;

    const add = (entries: readonly RawStreamEntry[]): void => {
      const have = new Set(batch.map((e) => e.id));
      const fresh = entries.filter((e) => !have.has(e.id));
      if (fresh.length === 0) return;
      if (batch.length === 0) batchStartedAt = this.now();
      batch.push(...fresh);
    };

    while (!this.stopped) {
      if (this.now() >= nextReclaimAt) {
        nextReclaimAt = this.now() + this.o.reclaimEveryMs;
        add(await this.reclaim());
        if (this.now() >= nextCleanupAt) {
          nextCleanupAt = this.now() + this.o.idleConsumerMs;
          await this.removeIdleConsumers();
        }
      }

      const reply = (await this.deps.reader.xreadgroup(
        'GROUP',
        this.o.group,
        this.o.consumer,
        'COUNT',
        this.o.readCount,
        'BLOCK',
        this.o.blockMs,
        'STREAMS',
        this.o.stream,
        '>',
      )) as StreamReply;
      if (reply) {
        for (const [, entries] of reply) add(entries.map(([id, flat]) => toRawEntry(id, flat)));
      }

      const bySize = batch.length >= this.o.batchSize;
      const byTime = batch.length > 0 && this.now() - batchStartedAt >= this.o.flushMs;
      if (bySize || byTime) {
        const toFlush = batch;
        batch = [];
        await this.flush(toFlush, bySize ? 'size' : 'time');
      }
    }
    if (batch.length > 0) await this.flush(batch, 'shutdown');
  }

  /** Processes one batch until it succeeds (or the consumer is stopped), then XACKs. */
  async flush(batch: readonly RawStreamEntry[], reason: string): Promise<void> {
    const startedAt = this.now();
    for (const e of batch) this.inFlight.add(e.id);
    const memo: SessionMemo = new Map();
    let failures = 0;
    try {
      for (;;) {
        try {
          const result = await this.deps.process(batch, memo);
          if (result.ackIds.length > 0) await this.ack(result.ackIds);
          this.deps.log({
            event: 'event_batch',
            flush_reason: reason,
            duration_ms: this.now() - startedAt,
            ...result.counts,
          });
          return;
        } catch (error) {
          if (this.stopped) return; // entries stay pending; the next consumer reclaims them
          if (error instanceof SuppressionNotReadyError) {
            // Fail closed (HLD §8): no reads, no writes, until the sets are rebuilt.
            this.deps.log({ event: 'event_pipeline_paused', reason: 'suppression_not_ready' });
            await this.sleep(this.o.notReadyPollMs);
            continue;
          }
          const wait =
            this.o.retryBackoffMs[Math.min(failures, this.o.retryBackoffMs.length - 1)] ?? 30_000;
          failures += 1;
          this.deps.log({
            event: 'event_batch_failed',
            attempt: failures,
            stalled_ms: this.now() - startedAt,
            error_name: error instanceof Error ? error.name : 'unknown',
            error_code:
              typeof (error as { code?: unknown })?.code === 'string'
                ? (error as { code: string }).code
                : undefined,
            // Alert threshold from event-pipeline.md §5: ClickHouse down for more than 5 minutes.
            alert: this.now() - startedAt > 300_000 ? 'clickhouse_unavailable' : undefined,
          });
          await this.sleep(wait);
        }
      }
    } finally {
      for (const e of batch) this.inFlight.delete(e.id);
    }
  }

  private async ack(ids: readonly string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 1000) {
      await this.deps.redis.xack(this.o.stream, this.o.group, ...ids.slice(i, i + 1000));
    }
  }

  /**
   * §4.5: claims entries idle for `minIdleMs` (left by a crashed consumer, or never acked because they
   * failed validation), dead-letters the ones delivered `poisonDeliveries` times, returns the rest for
   * reprocessing. Entries this consumer is working on right now are left alone.
   */
  async reclaim(): Promise<RawStreamEntry[]> {
    const { redis } = this.deps;
    const claimedReply = (await redis.xautoclaim(
      this.o.stream,
      this.o.group,
      this.o.consumer,
      this.o.minIdleMs,
      '0-0',
      'COUNT',
      500,
    )) as [string, ([string, string[]] | null)[], string[]?];
    const claimed = new Map<string, RawStreamEntry>();
    for (const item of claimedReply[1] ?? []) {
      if (item && !this.inFlight.has(item[0])) claimed.set(item[0], toRawEntry(item[0], item[1]));
    }

    const pending = (await redis.xpending(this.o.stream, this.o.group, '-', '+', 500)) as [
      string,
      string,
      number,
      number,
    ][];
    let deadLettered = 0;
    for (const [id, , , deliveries] of pending) {
      if (deliveries < this.o.poisonDeliveries || this.inFlight.has(id)) continue;
      const entry = claimed.get(id) ?? (await this.readEntry(id));
      if (entry) {
        const payload = entry.fields['payload'] ?? JSON.stringify(entry.fields);
        await redis.xadd(
          this.o.deadStream,
          'MAXLEN',
          '~',
          this.o.deadMaxLen,
          '*',
          'reason',
          'delivery_limit',
          'source_id',
          id,
          ...(entry.fields['store_id'] ? ['store_id', entry.fields['store_id']] : []),
          'payload',
          payload,
        );
      }
      await redis.xack(this.o.stream, this.o.group, id);
      claimed.delete(id);
      deadLettered += 1;
    }

    if (deadLettered > 0) {
      this.deps.log({
        event: 'event_pipeline_poison',
        alert: 'event_pipeline_poison',
        dead_lettered: deadLettered,
      });
    }
    return [...claimed.values()];
  }

  private async readEntry(id: string): Promise<RawStreamEntry | null> {
    const rows = await this.deps.redis.xrange(this.o.stream, id, id);
    const row = rows[0];
    return row ? toRawEntry(row[0], row[1]) : null;
  }

  /** §4.5 step 3: consumers idle for more than an hour with nothing pending are removed. */
  private async removeIdleConsumers(): Promise<void> {
    const { redis } = this.deps;
    const consumers = (await redis.xinfo('CONSUMERS', this.o.stream, this.o.group)) as unknown[][];
    for (const flat of consumers) {
      const info: Record<string, unknown> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) info[String(flat[i])] = flat[i + 1];
      const name = String(info['name']);
      if (name === this.o.consumer) continue;
      if (Number(info['pending']) === 0 && Number(info['idle']) > this.o.idleConsumerMs) {
        await redis.xgroup('DELCONSUMER', this.o.stream, this.o.group, name);
      }
    }
  }
}
