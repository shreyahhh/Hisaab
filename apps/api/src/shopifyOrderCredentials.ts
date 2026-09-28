import { createIntegrationRepository, type Db } from '@truepath/db';
import {
  ShopifyUnauthorizedError,
  type ShopifyAdapter,
  type ShopifyCredentials,
} from '@truepath/integrations';
import type { CredentialsCipher } from '@truepath/privacy';
import type { TenantScope } from '@truepath/shared';

// Resolves a store's decrypted Shopify credentials for the order-hint webhook handler's
// `fetchOrder` call (M1-2), refreshing once if Shopify reports the access token expired. M1-1
// deferred this entirely ("nothing in M1-1 reads [stored credentials] back"); this is the first
// ticket that actually needs to.

export interface ShopifyCredentialsDeps {
  readonly db: Db;
  readonly adapter: ShopifyAdapter;
  readonly cipher: CredentialsCipher;
}

function decryptCredentials(
  cipher: CredentialsCipher,
  integrationId: string,
  encrypted: Buffer,
): ShopifyCredentials {
  return JSON.parse(cipher.decrypt({ integrationId }, encrypted)) as ShopifyCredentials;
}

/**
 * Fetches one order snapshot, decrypting the store's stored token and refreshing it (once) on a
 * 401. The refresh is a plain network call with no transaction or lock held around it — the same
 * rule `fetchOrder` itself must follow (M1-2 review item 1) applies here too, and this function
 * never opens a `db.transaction` at all, only short-lived repository reads/writes.
 *
 * A benign race is accepted, not solved: two order-hint webhooks for the same store arriving at the
 * exact same instant, both finding the token already expired, could both call Shopify's refresh
 * endpoint with the same (about-to-rotate) refresh token. `upsertShopify`'s own advisory lock still
 * makes the *storage* of whichever response arrives safe; if the *other* refresh call is rejected by
 * Shopify, `fetchOrder` for that one webhook throws, and it succeeds on Shopify's next retry once
 * the winner's refreshed token is already stored — self-healing, not a silent failure.
 */
export async function fetchOrderWithTokenRefresh(
  deps: ShopifyCredentialsDeps,
  scope: TenantScope,
  storeId: string,
  shop: string,
  externalOrderId: string,
) {
  const integrationRepo = createIntegrationRepository(deps.db);
  const integration = await integrationRepo.getActiveByStore(scope, storeId, 'shopify');
  if (!integration?.encryptedCredentials) {
    throw new Error('fetchOrderWithTokenRefresh: no active Shopify integration for this store');
  }
  const creds = decryptCredentials(deps.cipher, integration.id, integration.encryptedCredentials);

  try {
    return await deps.adapter.fetchOrder(shop, creds, externalOrderId);
  } catch (error) {
    if (!(error instanceof ShopifyUnauthorizedError)) throw error;
    const refreshed = await deps.adapter.refresh(shop, creds);
    await integrationRepo.upsertShopify(scope, {
      storeId,
      externalAccountId: integration.externalAccountId ?? '',
      credentialsJson: JSON.stringify(refreshed),
      scopes: integration.scopes ?? [],
      cipher: deps.cipher,
    });
    return deps.adapter.fetchOrder(shop, refreshed, externalOrderId);
  }
}
