import type { Redis } from 'ioredis';
import { z } from 'zod';
import {
  createIntegrationRepository,
  createStoreRepository,
  noticeVersionOf,
  publishCollectorConfig as publishConfig,
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
import { CollectorStoreConfig, STORE_KEY_PATTERN, type Scope } from '@truepath/shared';

// Pixel install and the Collector's per-store config (shopify-integration.md §4.1 steps 5–7, issue
// #28; collector.md §2.5). Three separable steps, in the order the OAuth callback runs them:
//
//   1. resolvePixelKeys  — the store key and signing key(s): reuse the ones already stored, else make
//                          new ones. Must run BEFORE the credentials are written, because a reconnect
//                          returns fresh OAuth tokens that don't carry the signing keys.
//   2. installWebPixel   — best-effort `webPixelCreate`/`Update`. Never throws: the extension may not be
//                          deployed yet, and that must not fail a merchant's connect.
//   3. publishCollectorConfig — writes `collector:store:<store_key>` with the store's current gates.

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

/**
 * Builds and writes `collector:store:<store_key>` from the store's current state (HLD §8) — see
 * `publishCollectorConfig` in @truepath/db, which the suppression rebuild shares so "active" means
 * the same thing in both places. This keeps the API's call sites and signature unchanged.
 */
export async function publishCollectorConfig(
  deps: Pick<PixelDeps, 'db' | 'cipher' | 'redis' | 'dpaVersion'>,
  scope: Scope,
  storeId: string,
): Promise<CollectorStoreConfig | null> {
  return publishConfig(
    { db: deps.db, cipher: deps.cipher, sink: deps.redis, dpaVersion: deps.dpaVersion },
    scope,
    storeId,
  );
}
