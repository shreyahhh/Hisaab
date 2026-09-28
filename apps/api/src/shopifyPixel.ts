import type { Redis } from 'ioredis';
import { z } from 'zod';
import {
  createDpaAcceptanceRepository,
  createIntegrationRepository,
  createStoreRepository,
  type Db,
} from '@truepath/db';
import {
  generateSigningKey,
  generateStoreKey,
  ShopifyPixelError,
  type PixelSigningKey,
  type ShopifyAdapter,
  type ShopifyCredentials,
} from '@truepath/integrations';
import type { CredentialsCipher } from '@truepath/privacy';
import {
  collectorStoreKey,
  CollectorStoreConfig,
  STORE_KEY_PATTERN,
  type CollectorInactiveReason,
  type Scope,
} from '@truepath/shared';

// Pixel install and the Collector's per-store config (shopify-integration.md §4.1 steps 5–7, issue
// #28; collector.md §2.5). Three separable steps, in the order the OAuth callback runs them:
//
//   1. resolvePixelKeys  — the store key and signing key(s): reuse the ones already stored, else make
//                          new ones. Must run BEFORE the credentials are written, because a reconnect
//                          returns fresh OAuth tokens that don't carry the signing keys.
//   2. installWebPixel   — best-effort `webPixelCreate`/`Update`. Never throws: the extension may not be
//                          deployed yet, and that must not fail a merchant's connect.
//   3. publishCollectorConfig — writes `collector:store:<store_key>` with the store's current gates.

const NOTICE_VERSION_DEFAULT = 'v1'; // until the merchant sets one (privacy settings, SPEC §10)

/** The slice of `stores.privacy_config` (SPEC §6.1) this module reads. Unknown keys are tolerated. */
const PrivacyConfigSlice = z
  .object({
    notice_version: z.string().min(1).max(32).optional(),
    checklist: z
      .object({ india_opt_in_confirmed_at: z.string().nullish() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const SettingsSlice = z
  .object({ store_key: z.string().regex(STORE_KEY_PATTERN).optional() })
  .passthrough();

export interface PixelDeps {
  readonly db: Db;
  readonly adapter: ShopifyAdapter;
  readonly cipher: CredentialsCipher;
  /** Durable Redis: `collector:store:*` lives there (HLD §8). */
  readonly redis: Redis;
  /** Public base URL of the Collector. Unset until a Collector is deployed → the pixel isn't installed. */
  readonly collectorUrl: string | undefined;
  /** The DPA version organizations must accept (env DPA_VERSION). */
  readonly dpaVersion: string;
}

export interface PixelKeys {
  readonly storeKey: string;
  readonly signingKeys: readonly PixelSigningKey[];
}

function decrypt(
  cipher: CredentialsCipher,
  integrationId: string,
  encrypted: Buffer,
): ShopifyCredentials {
  return JSON.parse(cipher.decrypt({ integrationId }, encrypted)) as ShopifyCredentials;
}

/**
 * The store's pixel keys: whatever is already stored (so a re-auth doesn't change the store key the
 * live pixel was built with, or invalidate its signing secret), else a fresh pair (`kid` `s1`).
 * Reads only; the caller writes them, together with the new tokens, in one credentials upsert.
 */
export async function resolvePixelKeys(
  deps: Pick<PixelDeps, 'db' | 'cipher'>,
  scope: Scope,
  storeId: string,
): Promise<PixelKeys> {
  const existing = await createIntegrationRepository(deps.db).getActiveByStore(
    scope,
    storeId,
    'shopify',
  );
  if (existing?.encryptedCredentials) {
    const settings = SettingsSlice.safeParse(existing.settings);
    const stored = decrypt(deps.cipher, existing.id, existing.encryptedCredentials);
    if (settings.success && settings.data.store_key && stored.pixelSigningKeys?.length) {
      return { storeKey: settings.data.store_key, signingKeys: stored.pixelSigningKeys };
    }
  }
  return { storeKey: generateStoreKey(), signingKeys: [generateSigningKey('s1')] };
}

export type PixelInstallOutcome = 'installed' | 'failed' | 'not_configured';

/**
 * `webPixelCreate`/`Update` with the store's settings, recording the outcome in
 * `integrations.settings` (`pixel_status`, `pixel_id`, and Shopify's error *codes* on failure). Never
 * throws — the callback continues either way, and the health screen reads `pixel_status`.
 */
export async function installWebPixel(
  deps: PixelDeps,
  scope: Scope,
  input: { storeId: string; shopDomain: string; keys: PixelKeys; credentials: ShopifyCredentials },
): Promise<PixelInstallOutcome> {
  const repo = createIntegrationRepository(deps.db);
  const store = await createStoreRepository(deps.db).getById(scope, input.storeId);
  const primary = input.keys.signingKeys[0];
  if (!deps.collectorUrl || !primary || !store) {
    await repo.patchShopifySettings(scope, input.storeId, { pixel_status: 'not_configured' });
    return 'not_configured';
  }

  try {
    const { pixelId } = await deps.adapter.upsertWebPixel(input.shopDomain, input.credentials, {
      storeKey: input.keys.storeKey,
      collectorUrl: deps.collectorUrl,
      signingKid: primary.kid,
      signingSecret: primary.secret,
      noticeVersion: noticeVersionOf(store.privacyConfig),
    });
    await repo.patchShopifySettings(scope, input.storeId, {
      pixel_status: 'installed',
      pixel_id: pixelId,
      pixel_error_codes: '',
    });
    return 'installed';
  } catch (error) {
    // Codes only: a Shopify message can echo the submitted settings, i.e. the signing secret.
    const codes = error instanceof ShopifyPixelError ? error.codes.join(',') : 'request_failed';
    console.error(
      JSON.stringify({
        event: 'shopify_pixel_install_failed',
        store_id: input.storeId,
        codes,
      }),
    );
    await repo.patchShopifySettings(scope, input.storeId, {
      pixel_status: 'failed',
      pixel_error_codes: codes,
    });
    return 'failed';
  }
}

function noticeVersionOf(privacyConfig: unknown): string {
  const parsed = PrivacyConfigSlice.safeParse(privacyConfig);
  return (parsed.success && parsed.data.notice_version) || NOTICE_VERSION_DEFAULT;
}

/**
 * Builds and writes `collector:store:<store_key>` from the store's current state (HLD §8):
 * `active` only with the org's DPA accepted at the current version AND the merchant's India opt-in
 * confirmation on record (privacy-dpdp §4.10 / SPEC v0.6 P-1) — until both, the Collector drops
 * everything for the store. Idempotent, so it can be re-run whenever a gate changes (issue #22).
 *
 * Returns the config it wrote, or null if the store has no keys yet (nothing to publish).
 */
export async function publishCollectorConfig(
  deps: Pick<PixelDeps, 'db' | 'cipher' | 'redis' | 'dpaVersion'>,
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

  const settings = SettingsSlice.safeParse(integration.settings);
  const credentials = decrypt(deps.cipher, integration.id, integration.encryptedCredentials);
  const storeKey = settings.success ? settings.data.store_key : undefined;
  if (!storeKey || !credentials.pixelSigningKeys?.length) return null;

  const dpa = await createDpaAcceptanceRepository(deps.db).findForVersion(
    scope,
    store.organizationId,
    deps.dpaVersion,
  );
  const privacy = PrivacyConfigSlice.safeParse(store.privacyConfig);
  const optInConfirmed =
    privacy.success && Boolean(privacy.data.checklist?.india_opt_in_confirmed_at);

  let inactiveReason: CollectorInactiveReason | null = null;
  if (store.status !== 'active') inactiveReason = 'uninstalled';
  else if (!dpa) inactiveReason = 'dpa_missing';
  else if (!optInConfirmed) inactiveReason = 'consent_region_unconfirmed';

  const config = CollectorStoreConfig.parse({
    storeId: store.id,
    status: inactiveReason === null ? 'active' : 'inactive',
    inactiveReason,
    // The shop's own myshopify domain; custom domains are added by the daily Shopify reconcile
    // (§4.7, deferred with the rest of `reconcile`, issue #41).
    allowedOrigins: [`https://${store.shopDomain}`],
    signingKeys: credentials.pixelSigningKeys.map(({ kid, secret }) => ({ kid, secret })),
    childDirected: store.childDirected,
    noticeVersion: noticeVersionOf(store.privacyConfig),
  });
  await deps.redis.set(collectorStoreKey(storeKey), JSON.stringify(config));
  return config;
}
