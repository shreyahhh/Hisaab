import type { Redis } from 'ioredis';
import {
  createAuditLogRepository,
  createOrganizationRepository,
  createStoreRepository,
  jobScope,
  publishCollectorConfig,
  type CollectorConfigSink,
  type Db,
} from '@truepath/db';
import type { CredentialsCipher } from '@truepath/privacy';
import {
  COLLECTOR_STATS_TTL_SECONDS,
  istDay,
  statsCollectorKey,
  storeBoundScope,
  type StreamEntry,
} from '@truepath/shared';

// HLD §8 "Consent-region gate" layer 2 (event-pipeline.md §4.4, issue #52): detects a store whose
// Shopify consent banner (or consent app) treats India as default-on — tracking fires without any
// shopper interaction — even though the merchant confirmed otherwise at onboarding (layer 1).
//
// Three pieces: counting (pure, per batch), evaluating (reads the last 2 days' Redis counters,
// pure once the hashes are in hand) and acting (writes consent_health, and — only when
// `consentPauseEnabled` — deactivates the collector config, emails owners/admins, and audits it).

/** Per store, how many of this batch's *distinct* new visitors to add to each counter. */
export interface DefaultOnCounts {
  readonly newVisitors: number;
  readonly newVisitorsInitialOnly: number;
}

interface VisitorFlags {
  newVisitor: boolean;
  analyticsAllowed: boolean;
  interactionGrant: boolean;
}

/**
 * `visitor_new` can be set on more than one stream entry in a visitor's very first network
 * request (e.g. `page_viewed` and `consent_granted` in the same pixel batch), so this counts each
 * distinct new visitor once per store, not once per event. A visitor counts toward
 * `new_visitors_initial_only` when analytics was allowed but nothing in this batch shows the
 * shopper actually interacting with a consent banner (`consent_granted` with `trigger='interaction'`)
 * — the shape a default-on region produces, where Shopify runs the pixel callback unconditionally.
 */
export function countDefaultOnSignal(
  entries: readonly { readonly storeId: string; readonly entry: StreamEntry }[],
): Map<string, DefaultOnCounts> {
  const byStore = new Map<string, Map<string, VisitorFlags>>();
  for (const { storeId, entry } of entries) {
    if (entry.kind !== 'event') continue; // suppression_hit carries no visitor_new/consent info
    let visitors = byStore.get(storeId);
    if (!visitors) {
      visitors = new Map();
      byStore.set(storeId, visitors);
    }
    let flags = visitors.get(entry.visitor_id);
    if (!flags) {
      flags = { newVisitor: false, analyticsAllowed: false, interactionGrant: false };
      visitors.set(entry.visitor_id, flags);
    }
    if (entry.visitor_new) flags.newVisitor = true;
    if (entry.consent_purposes.includes('attribution_analytics')) flags.analyticsAllowed = true;
    if (entry.event_name === 'consent_granted' && entry.consent_trigger === 'interaction') {
      flags.interactionGrant = true;
    }
  }

  const result = new Map<string, DefaultOnCounts>();
  for (const [storeId, visitors] of byStore) {
    let newVisitors = 0;
    let newVisitorsInitialOnly = 0;
    for (const flags of visitors.values()) {
      if (!flags.newVisitor) continue;
      newVisitors += 1;
      if (flags.analyticsAllowed && !flags.interactionGrant) newVisitorsInitialOnly += 1;
    }
    if (newVisitors > 0) result.set(storeId, { newVisitors, newVisitorsInitialOnly });
  }
  return result;
}

/** `HINCRBY`s today's `stats:collector:<store_id>:<yyyymmdd>` hash and refreshes its TTL. */
export async function incrementDefaultOnStats(
  redis: Pick<Redis, 'pipeline'>,
  counts: ReadonlyMap<string, DefaultOnCounts>,
  nowMs: number,
): Promise<void> {
  if (counts.size === 0) return;
  const day = istDay(nowMs);
  const pipeline = redis.pipeline();
  for (const [storeId, c] of counts) {
    const key = statsCollectorKey(storeBoundScope(storeId), storeId, day);
    if (c.newVisitors > 0) pipeline.hincrby(key, 'new_visitors', c.newVisitors);
    if (c.newVisitorsInitialOnly > 0) {
      pipeline.hincrby(key, 'new_visitors_initial_only', c.newVisitorsInitialOnly);
    }
    pipeline.expire(key, COLLECTOR_STATS_TTL_SECONDS);
  }
  const results = await pipeline.exec();
  for (const [error] of results ?? []) if (error) throw error;
}

export type ConsentHealthStatus = 'ok' | 'warn' | 'paused';

export interface ConsentHealthEvaluation {
  readonly storeId: string;
  readonly status: ConsentHealthStatus;
  /** The ratio behind `status` — 24h's for `ok`/`warn`, 48h's for `paused`. */
  readonly ratio: number;
  readonly newVisitors24h: number;
  readonly newVisitorsInitialOnly24h: number;
  readonly newVisitors48h: number;
  readonly newVisitorsInitialOnly48h: number;
}

// event-pipeline.md §4.4's thresholds.
const WARN_RATIO = 0.2;
const WARN_MIN_VISITORS_24H = 50;
const PAUSE_RATIO = 0.5;
const PAUSE_MIN_VISITORS_48H = 100;

function ratioOf(initialOnly: number, total: number): number {
  return total === 0 ? 0 : initialOnly / total;
}

function statNumber(stats: Record<string, string>, field: string): number {
  const value = Number(stats[field] ?? 0);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Reads the last 2 days' `stats:collector:<store_id>:<yyyymmdd>` hashes (today + yesterday, IST) —
 * the LLD's own data source for both checks. "24h" uses today's hash alone; "48h" sums both days.
 * Pause (48h, the longer window) is checked first: a store already past the pause bar doesn't also
 * need to clear the warn bar on the shorter window first.
 */
export async function evaluateDefaultOnSignal(
  redis: Pick<Redis, 'hgetall'>,
  storeId: string,
  nowMs: number,
): Promise<ConsentHealthEvaluation> {
  const scope = storeBoundScope(storeId);
  const [today, yesterday] = await Promise.all([
    redis.hgetall(statsCollectorKey(scope, storeId, istDay(nowMs))),
    redis.hgetall(statsCollectorKey(scope, storeId, istDay(nowMs - 24 * 60 * 60 * 1000))),
  ]);

  const newVisitors24h = statNumber(today, 'new_visitors');
  const newVisitorsInitialOnly24h = statNumber(today, 'new_visitors_initial_only');
  const newVisitors48h = newVisitors24h + statNumber(yesterday, 'new_visitors');
  const newVisitorsInitialOnly48h =
    newVisitorsInitialOnly24h + statNumber(yesterday, 'new_visitors_initial_only');

  const ratio48h = ratioOf(newVisitorsInitialOnly48h, newVisitors48h);
  const ratio24h = ratioOf(newVisitorsInitialOnly24h, newVisitors24h);

  let status: ConsentHealthStatus = 'ok';
  let ratio = ratio24h;
  if (ratio48h >= PAUSE_RATIO && newVisitors48h >= PAUSE_MIN_VISITORS_48H) {
    status = 'paused';
    ratio = ratio48h;
  } else if (ratio24h >= WARN_RATIO && newVisitors24h >= WARN_MIN_VISITORS_24H) {
    status = 'warn';
  }

  return {
    storeId,
    status,
    ratio,
    newVisitors24h,
    newVisitorsInitialOnly24h,
    newVisitors48h,
    newVisitorsInitialOnly48h,
  };
}

export interface ConsentHealthEmailSender {
  sendDefaultOnPaused(params: {
    readonly to: readonly string[];
    readonly storeId: string;
    readonly ratio: number;
  }): Promise<void>;
}

/** Default until SES is wired (issue #6): logs instead of throwing or silently doing nothing. */
export const noopConsentHealthEmailSender: ConsentHealthEmailSender = {
  async sendDefaultOnPaused({ to, storeId }) {
    console.debug(
      `[event-pipeline] sendDefaultOnPaused: SES not yet wired, skipped for store ${storeId} (${to.length} recipient(s))`,
    );
  },
};

export interface ApplyConsentHealthDeps {
  readonly db: Db;
  readonly redis: CollectorConfigSink;
  readonly cipher: CredentialsCipher;
  readonly dpaVersion: string;
  /**
   * event-pipeline.md §4.4's last line: enforcement (actually deactivating the collector config)
   * stays off until a dev-store test confirms the signal separates opt-in from default-on stores.
   * `false` still writes `consent_health` and audits a would-be pause, so the data and the signal
   * are both real before enforcement is ever turned on.
   */
  readonly consentPauseEnabled: boolean;
  readonly emailSender?: ConsentHealthEmailSender;
  readonly now: () => Date;
  readonly log: (line: Record<string, unknown>) => void;
}

/**
 * Applies one store's evaluation. A store already `paused` is left alone entirely — resuming is a
 * merchant action (re-confirming the banner is now opt-in), not something a later tick should ever
 * undo on its own, and there's nothing useful to re-measure while tracking stays off. Otherwise,
 * `consent_health` is written on every call (keeps the ratio/measured_at the dashboard shows
 * current); the two audit actions (`consent_default_on_warned` / `consent_default_on_paused`) only
 * fire on a genuine status *transition*, so a store stuck at `warn` for hours doesn't spam the
 * trail every ≤10 minutes. A transition to `paused` additionally republishes the collector config
 * (inactive only when `consentPauseEnabled`) and emails the organization's owners/admins.
 */
export async function applyConsentHealthEvaluation(
  deps: ApplyConsentHealthDeps,
  evaluation: ConsentHealthEvaluation,
): Promise<void> {
  const scope = storeBoundScope(evaluation.storeId);
  const stores = createStoreRepository(deps.db);
  const store = await stores.getById(scope, evaluation.storeId);
  if (!store) return;

  const previousStatus = (
    store.privacyConfig as { consent_health?: { status?: ConsentHealthStatus } } | null
  )?.consent_health?.status;
  if (previousStatus === 'paused') return;

  const now = deps.now();
  await stores.updateConsentHealth(scope, evaluation.storeId, {
    status: evaluation.status,
    ratio: evaluation.ratio,
    measuredAt: now,
    ...(evaluation.status === 'paused' ? { pausedAt: now } : {}),
  });

  if (evaluation.status === previousStatus) return; // same status as last tick — no audit

  const orgScope = jobScope(store.organizationId, evaluation.storeId);
  const audit = createAuditLogRepository(deps.db);

  if (evaluation.status === 'warn') {
    await audit.write(orgScope, {
      organizationId: store.organizationId,
      actorUserId: null,
      actorType: 'system',
      action: 'consent_default_on_warned',
      targetType: 'store',
      targetId: evaluation.storeId,
      metadata: { ratio: evaluation.ratio, new_visitors: evaluation.newVisitors24h },
    });
    return;
  }

  if (evaluation.status === 'ok') return; // a recovery from warn needs no audit of its own

  // status === 'paused'
  await audit.write(orgScope, {
    organizationId: store.organizationId,
    actorUserId: null,
    actorType: 'system',
    action: 'consent_default_on_paused',
    targetType: 'store',
    targetId: evaluation.storeId,
    metadata: { ratio: evaluation.ratio, new_visitors: evaluation.newVisitors48h },
  });

  if (deps.consentPauseEnabled) {
    await publishCollectorConfig(
      {
        db: deps.db,
        cipher: deps.cipher,
        sink: deps.redis,
        dpaVersion: deps.dpaVersion,
        consentPauseEnabled: true,
      },
      orgScope,
      evaluation.storeId,
    );
  }

  const recipients = await createOrganizationRepository(deps.db).listOwnerAndAdminEmails(
    orgScope,
    store.organizationId,
  );
  const emailSender = deps.emailSender ?? noopConsentHealthEmailSender;
  await emailSender.sendDefaultOnPaused({
    to: recipients,
    storeId: evaluation.storeId,
    ratio: evaluation.ratio,
  });

  deps.log({
    event: 'consent_default_on_paused',
    store_id: evaluation.storeId,
    ratio: evaluation.ratio,
    enforced: deps.consentPauseEnabled,
  });
}
