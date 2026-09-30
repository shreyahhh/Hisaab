import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import { createDb, createSystemScope } from '@truepath/db';
import { createShopifyAdapter } from '@truepath/integrations';
import { createCredentialsCipher } from '@truepath/privacy';
import {
  credentialsKeyEnvSchema,
  dpaEnvSchema,
  loadDotEnvIfPresent,
  loadEnv,
  postgresEnvSchema,
  redisDurableEnvSchema,
  SHOPIFY_OAUTH_SCOPES,
  shopifyEnvSchema,
} from '@truepath/shared';
import { completeKeyRotation, rotateSigningKey } from './shopifyPixel.js';

// Local operator tool for the Web Pixel signing-key rotation procedure (S-6, issue #45). Not part of
// the deployed API. Two steps, run by hand with a gap between them for the pixel rollout window
// (privacy-dpdp.md §4.1's rotation procedure — no scheduler exists yet to automate the gap):
//
//   pnpm --filter @truepath/api dev:key-rotation start    <storeId>   # adds a new key, pushes it live
//   pnpm --filter @truepath/api dev:key-rotation complete <storeId>   # drops every key but the newest
//
// Prints only kids (never secrets) and holds decrypted credentials only in memory, the same as the
// real OAuth callback and workers processes.

const devEnvSchema = postgresEnvSchema
  .and(redisDurableEnvSchema)
  .and(credentialsKeyEnvSchema)
  .and(shopifyEnvSchema)
  .and(dpaEnvSchema);
const COMMANDS = ['start', 'complete'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string | undefined): value is Command {
  return (COMMANDS as readonly string[]).includes(value ?? '');
}

async function main(): Promise<void> {
  const [command, storeId] = process.argv.slice(2);
  if (!isCommand(command) || !storeId) {
    console.error('usage: dev:key-rotation <start|complete> <storeId>');
    process.exitCode = 2;
    return;
  }

  loadDotEnvIfPresent('../../.env');
  const env = loadEnv(devEnvSchema);
  const db = createDb(env.DATABASE_URL);
  const cipher = createCredentialsCipher(env.credentialsKeys);
  const redis = new Redis(env.REDIS_DURABLE_URL);
  const adapter = createShopifyAdapter({
    clientId: env.SHOPIFY_CLIENT_ID,
    clientSecret: env.SHOPIFY_CLIENT_SECRET,
    clientSecretPrevious: env.SHOPIFY_CLIENT_SECRET_PREVIOUS,
    scopes: SHOPIFY_OAUTH_SCOPES,
  });
  // No collector URL flag here on purpose: rotation must push the new key to the live pixel and
  // republish the config in the same run as a real deploy would, not silently skip the Shopify push.
  const collectorUrl = process.env.COLLECTOR_PUBLIC_URL;
  const scope = await createSystemScope(db, 'shopify_reconcile', {
    metadata: { store_id: storeId, mode: `dev_key_rotation_${command}` },
  });
  const pixelDeps = { db, adapter, cipher, redis, collectorUrl, dpaVersion: env.DPA_VERSION };

  try {
    if (command === 'start') {
      const result = await rotateSigningKey(pixelDeps, scope, storeId);
      if (!result) {
        console.error(`no active Shopify integration for store ${storeId}`);
        process.exitCode = 1;
        return;
      }
      console.log(
        `rotation started: new key ${result.newKid} is live; both keys accepted during rollout`,
      );
      console.log('run `complete` for this store once the rollout window has passed');
      return;
    }
    await completeKeyRotation(pixelDeps, scope, storeId);
    console.log(`rotation completed for ${storeId}: only the newest key is now accepted`);
  } finally {
    redis.disconnect();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'dev:key-rotation failed');
      process.exitCode = 1;
    })
    .finally(() => {
      // The postgres pool would otherwise hold the process open.
      process.exit();
    });
}
