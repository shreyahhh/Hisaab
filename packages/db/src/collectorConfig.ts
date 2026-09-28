import type { CredentialsCipher } from '@truepath/privacy';
import {
  CollectorStoreConfig,
  STORE_KEY_PATTERN,
  collectorStoreKey,
  type CollectorInactiveReason,
  type Scope,
} from '@truepath/shared';
import type { Db } from './client.js';
import { createDpaAcceptanceRepository } from './repositories/dpaAcceptanceRepository.js';
import { createIntegrationRepository } from './repositories/integrationRepository.js';
import { createStoreRepository } from './repositories/storeRepository.js';

// The Collector's per-store config, `collector:store:<store_key>` (HLD §8; collector.md §2.5), built from
// what Postgres holds. Two callers: Core API rewrites it whenever a gate changes (OAuth connect, DPA
// acceptance, privacy settings), and the suppression rebuild rewrites every store's after durable Redis
// was lost (M1-6c/#56). One implementation, so the two can't drift apart on what "active" means.
//
// It lives here rather than in a Redis-aware package because it needs only Postgres and the credentials
// cipher; Redis is a structural `{ set }` sink, so this package still has no Redis dependency.

const NOTICE_VERSION_DEFAULT = 'v1'; // until the merchant sets one (privacy settings, SPEC §10)

export interface CollectorConfigSink {
  set(key: string, value: string): Promise<unknown>;
}

export interface CollectorConfigDeps {
  readonly db: Db;
  /** ADR-0023 envelope encryption: the pixel signing keys live inside `encrypted_credentials`. */
  readonly cipher: CredentialsCipher;
  readonly sink: CollectorConfigSink;
  /** The DPA version organizations must have accepted (env DPA_VERSION). */
  readonly dpaVersion: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** `stores.privacy_config.notice_version`, or the default. Unknown keys and bad values are tolerated. */
export function noticeVersionOf(privacyConfig: unknown): string {
  const version = asRecord(privacyConfig)['notice_version'];
  return typeof version === 'string' && version.length >= 1 && version.length <= 32
    ? version
    : NOTICE_VERSION_DEFAULT;
}

function indiaOptInConfirmed(privacyConfig: unknown): boolean {
  const checklist = asRecord(asRecord(privacyConfig)['checklist']);
  const at = checklist['india_opt_in_confirmed_at'];
  return typeof at === 'string' && at !== '';
}

function signingKeysOf(credentialsJson: string): { kid: string; secret: string }[] {
  const parsed = asRecord(JSON.parse(credentialsJson));
  const keys = parsed['pixelSigningKeys'];
  if (!Array.isArray(keys)) return [];
  return keys.flatMap((k) => {
    const key = asRecord(k);
    return typeof key['kid'] === 'string' && typeof key['secret'] === 'string'
      ? [{ kid: key['kid'], secret: key['secret'] }]
      : [];
  });
}

/**
 * Builds and writes `collector:store:<store_key>` from the store's current state (HLD §8): `active` only
 * with the org's DPA accepted at the current version AND the merchant's India opt-in confirmation on
 * record (privacy-dpdp §4.10 / SPEC v0.6 P-1) — until both, the Collector drops everything for the
 * store. Idempotent, so it can be re-run whenever a gate changes (issue #22) or after a Redis loss.
 *
 * `scope` must cover the store (ADR-0016; callers use a one-store scope, ADR-0026). Returns the config it
 * wrote, or null if the store has no active Shopify integration or no keys yet (nothing to publish).
 */
export async function publishCollectorConfig(
  deps: CollectorConfigDeps,
  scope: Scope,
  storeId: string,
): Promise<CollectorStoreConfig | null> {
  const store = await createStoreRepository(deps.db).getById(scope, storeId);
  const integration = await createIntegrationRepository(deps.db).getActiveByStore(
    scope,
    storeId,
    'shopify',
  );
  if (!store || !integration?.encryptedCredentials) return null;

  const storeKey = asRecord(integration.settings)['store_key'];
  const signingKeys = signingKeysOf(
    deps.cipher.decrypt({ integrationId: integration.id }, integration.encryptedCredentials),
  );
  if (
    typeof storeKey !== 'string' ||
    !STORE_KEY_PATTERN.test(storeKey) ||
    signingKeys.length === 0
  ) {
    return null;
  }

  const dpa = await createDpaAcceptanceRepository(deps.db).findForVersion(
    scope,
    store.organizationId,
    deps.dpaVersion,
  );

  let inactiveReason: CollectorInactiveReason | null = null;
  if (store.status !== 'active') inactiveReason = 'uninstalled';
  else if (!dpa) inactiveReason = 'dpa_missing';
  else if (!indiaOptInConfirmed(store.privacyConfig)) inactiveReason = 'consent_region_unconfirmed';

  const config = CollectorStoreConfig.parse({
    storeId: store.id,
    status: inactiveReason === null ? 'active' : 'inactive',
    inactiveReason,
    // The shop's own myshopify domain; custom domains are added by the daily Shopify reconcile
    // (§4.7, deferred with the rest of `reconcile`, issue #41).
    allowedOrigins: [`https://${store.shopDomain}`],
    signingKeys,
    childDirected: store.childDirected,
    noticeVersion: noticeVersionOf(store.privacyConfig),
  });
  await deps.sink.set(collectorStoreKey(storeKey), JSON.stringify(config));
  return config;
}
