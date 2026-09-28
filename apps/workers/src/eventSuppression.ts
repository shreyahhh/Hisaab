import type { ChainableCommander, Redis } from 'ioredis';
import {
  SUPPRESS_READY_KEY,
  storeBoundScope,
  suppressionSetKey,
  type SuppressionSetKind,
} from '@truepath/shared';

// The Redis half of suppression for `event-workers` (HLD §8 "Suppression set"; event-pipeline.md §4.1
// steps 3 and 5, §4.4). The sets are sorted sets per store — member = HMAC, score = expiry (epoch
// seconds) — and an entry counts only while its score is in the future. Postgres
// (`suppressed_identities`) is the source of truth; these functions only read the hot copy and mirror
// changes the Postgres transaction has already committed.

/** `suppress:ready` is missing: the worker must not act on a shopper it can't check (fail closed). */
export class SuppressionNotReadyError extends Error {
  constructor() {
    super('suppress:ready is absent — suppression sets are not available');
    this.name = 'SuppressionNotReadyError';
  }
}

export async function isSuppressionReady(
  redis: Pick<Redis, 'exists'>,
  readyKey: string = SUPPRESS_READY_KEY,
): Promise<boolean> {
  return (await redis.exists(readyKey)) === 1;
}

export interface SuppressionProbe {
  readonly storeId: string;
  /** HMAC(visitor_id) under every read key version. */
  readonly visitorHmacs: readonly string[];
  /** The event's phone/email/identity hashes (empty when it carries none). */
  readonly identityHashes: readonly string[];
  /** False for `consent_*` events, which skip the withdrawn check so re-consent can happen. */
  readonly checkWithdrawn: boolean;
}

export type SuppressionVerdict = 'erased_visitor' | 'erased_identity' | 'withdrawn' | null;

const PRIORITY: Record<Exclude<SuppressionVerdict, null>, number> = {
  erased_visitor: 3,
  erased_identity: 2,
  withdrawn: 1,
};

/** One pipelined round trip for the whole batch. Verdicts line up with `probes`. */
export async function checkSuppression(
  redis: Pick<Redis, 'pipeline'>,
  probes: readonly SuppressionProbe[],
  nowSeconds: number,
): Promise<SuppressionVerdict[]> {
  const pipeline = redis.pipeline();
  const commands: { probe: number; verdict: Exclude<SuppressionVerdict, null> }[] = [];
  probes.forEach((probe, index) => {
    const scope = storeBoundScope(probe.storeId);
    const key = (kind: SuppressionSetKind): string => suppressionSetKey(scope, probe.storeId, kind);
    for (const member of probe.visitorHmacs) {
      pipeline.zscore(key('erased:visitor'), member);
      commands.push({ probe: index, verdict: 'erased_visitor' });
      if (probe.checkWithdrawn) {
        pipeline.zscore(key('withdrawn:visitor'), member);
        commands.push({ probe: index, verdict: 'withdrawn' });
      }
    }
    for (const member of probe.identityHashes) {
      pipeline.zscore(key('erased:identity'), member);
      commands.push({ probe: index, verdict: 'erased_identity' });
    }
  });

  const results = commands.length === 0 ? [] : ((await pipeline.exec()) ?? []);
  const verdicts: SuppressionVerdict[] = probes.map(() => null);
  results.forEach(([error, score], position) => {
    if (error) throw error;
    const command = commands[position]!;
    if (score === null || !(Number(score) > nowSeconds)) return;
    const current = verdicts[command.probe];
    if (
      current === null ||
      current === undefined ||
      PRIORITY[command.verdict] > PRIORITY[current]
    ) {
      verdicts[command.probe] = command.verdict;
    }
  });
  return verdicts;
}

export type SuppressionMirrorOp =
  | {
      readonly op: 'add';
      readonly storeId: string;
      readonly kind: SuppressionSetKind;
      readonly member: string;
      readonly expiresAtSeconds: number;
    }
  | {
      readonly op: 'remove';
      readonly storeId: string;
      readonly kind: SuppressionSetKind;
      readonly members: readonly string[];
    };

/** Queues the Redis mirror of committed Postgres changes onto `pipeline`, in the order given. */
export function queueSuppressionMirror(
  pipeline: ChainableCommander,
  ops: readonly SuppressionMirrorOp[],
): void {
  for (const op of ops) {
    const key = suppressionSetKey(storeBoundScope(op.storeId), op.storeId, op.kind);
    if (op.op === 'add') pipeline.zadd(key, op.expiresAtSeconds, op.member);
    else if (op.members.length > 0) pipeline.zrem(key, ...op.members);
  }
}
