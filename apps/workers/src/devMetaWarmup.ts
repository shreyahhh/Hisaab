import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import {
  createAdAccountRepository,
  createDb,
  createIntegrationRepository,
  createStoreRepository,
  createSystemScope,
  jobScope,
} from '@truepath/db';
import { createCredentialsCipher } from '@truepath/privacy';
import {
  AD_SYNC_META_QUEUE,
  credentialsKeyEnvSchema,
  loadDotEnvIfPresent,
  loadEnv,
  META_WARMUP_INTERVAL_MS,
  metaWarmupSchedulerId,
  postgresEnvSchema,
  redisDurableEnvSchema,
  type AdSyncMetaJob,
} from '@truepath/shared';

// Local-development operator tool for the Meta App Review warm-up slice (M1-8, meta-integration.md
// §2.2 `meta-warmup`). There is no Meta OAuth connect flow yet (that's M2-1) — the warm-up needs an ad
// account and a long-lived Business Integration System User token *before* it, so this registers them
// by hand, the same way `devShopifyBackfill.ts` fills the gap for the backfill's webhook-only trigger.
//
//   pnpm --filter @truepath/workers dev:meta-warmup register <storeId> <adAccountId> <name> <currency> <timezone>
//     (reads the access token from stdin — one line, EOF or newline terminates — never argv, so it
//      never lands in shell history or `ps`)
//   pnpm --filter @truepath/workers dev:meta-warmup start  <storeId>   # registers the repeatable job (idempotent)
//   pnpm --filter @truepath/workers dev:meta-warmup run    <storeId>   # enqueues one immediate run
//   pnpm --filter @truepath/workers dev:meta-warmup status <storeId>   # prints non-secret state only
//
// It prints only non-secret state (ad account ids, the warm-up ledger) and holds no credentials itself
// once `register` returns: they are encrypted before this process's variable holding them goes out of
// scope, and the Workers process decrypts them again when it runs.

const devEnvSchema = postgresEnvSchema.and(redisDurableEnvSchema).and(credentialsKeyEnvSchema);
const COMMANDS = ['register', 'start', 'run', 'status'] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string | undefined): value is Command {
  return (COMMANDS as readonly string[]).includes(value ?? '');
}

/** Reads one line from stdin (the access token), without ever accepting it as a CLI argument. */
function readLineFromStdin(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin });
    console.error(prompt);
    rl.once('line', (line) => {
      rl.close();
      resolve(line.trim());
    });
    rl.once('close', () => reject(new Error('no token was provided on stdin')));
  });
}

async function main(): Promise<void> {
  const [command, storeId, ...rest] = process.argv.slice(2);
  if (!isCommand(command) || !storeId) {
    console.error(
      'usage: dev:meta-warmup <register|start|run|status> <storeId> [adAccountId name currency timezone]',
    );
    process.exitCode = 2;
    return;
  }

  loadDotEnvIfPresent('../../.env');
  const env = loadEnv(devEnvSchema);
  const db = createDb(env.DATABASE_URL);
  const cipher = createCredentialsCipher(env.credentialsKeys);

  // A SystemScope, audited, ONLY to resolve which organization the store belongs to — this CLI has no
  // signed-in user, so there is no TenantScope yet to bootstrap from (same shape as
  // `devShopifyBackfill.ts`). Everything else below uses a one-store `jobScope`, not this SystemScope
  // (ADR-0026): a single store's reads/writes should still fail loudly if they ever target another.
  const bootScope = await createSystemScope(db, 'scheduler_fanout', {
    metadata: { store_id: storeId, mode: `dev_meta_warmup_${command}` },
  });
  const store = await createStoreRepository(db).getById(bootScope, storeId);
  if (!store) {
    console.error(`no store with id ${storeId}`);
    process.exitCode = 1;
    return;
  }
  const scope = jobScope(store.organizationId, storeId);
  const integrations = createIntegrationRepository(db);
  const adAccounts = createAdAccountRepository(db);

  if (command === 'status') {
    const integration = await integrations.getActiveByStore(scope, storeId, 'meta');
    const accounts = await adAccounts.listByStore(scope, storeId, 'meta');
    console.log(
      JSON.stringify(
        {
          connected: integration !== null,
          settings: integration?.settings ?? null,
          accounts: accounts.map((a) => ({
            externalId: a.externalId,
            name: a.name,
            timezone: a.timezone,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === 'register') {
    const [adAccountId, name, currency, timezone] = rest;
    if (!adAccountId || !name || !currency || !timezone) {
      console.error(
        'usage: dev:meta-warmup register <storeId> <adAccountId> <name> <currency> <timezone>',
      );
      process.exitCode = 2;
      return;
    }
    const accessToken = await readLineFromStdin('Meta access token (stdin, one line): ');
    if (!accessToken) {
      console.error('empty token');
      process.exitCode = 1;
      return;
    }

    // One integration row per store, however many ad accounts it registers (settings.ad_account_ids
    // holds the list) — `externalAccountId` must therefore be stable per store, not per ad account.
    // There is no OAuth yet (M2-1) to supply a real Meta business id, so this is a deterministic
    // placeholder; `upsertMeta`'s (storeId, provider, externalAccountId) uniqueness is what makes a
    // second `register` call for the same store update the same row instead of creating another.
    const integration = await integrations.upsertMeta(scope, {
      storeId,
      externalAccountId: `warmup-${storeId}`,
      credentialsJson: JSON.stringify({ accessToken }),
      scopes: ['ads_read'],
      cipher,
    });
    await adAccounts.upsert(scope, {
      storeId,
      provider: 'meta',
      externalId: adAccountId,
      name,
      currency,
      timezone,
    });
    const existingIds = Array.isArray(
      (integration.settings as { ad_account_ids?: unknown })?.ad_account_ids,
    )
      ? ((integration.settings as { ad_account_ids: string[] }).ad_account_ids ?? [])
      : [];
    await integrations.patchMetaSettings(scope, storeId, {
      ad_account_ids: [...new Set([...existingIds, adAccountId])],
    });
    console.log(`registered ${adAccountId} for store ${storeId}`);
    return;
  }

  const connection = new Redis(env.REDIS_DURABLE_URL, { maxRetriesPerRequest: null });
  const queue = new Queue<AdSyncMetaJob>(AD_SYNC_META_QUEUE, { connection });
  try {
    if (command === 'start') {
      await queue.upsertJobScheduler(
        metaWarmupSchedulerId(storeId),
        { every: META_WARMUP_INTERVAL_MS },
        { name: 'meta-warmup', data: { storeId } },
      );
      console.log(`scheduled meta-warmup every 15 min for ${storeId}`);
      return;
    }
    // run
    await queue.add(
      'meta-warmup',
      { storeId },
      { jobId: `dev-meta-warmup-${storeId}-${Date.now()}` },
    );
    console.log(`enqueued one meta-warmup run for ${storeId}`);
  } finally {
    await queue.close();
    connection.disconnect();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'dev:meta-warmup failed');
      process.exitCode = 1;
    })
    .finally(() => {
      // The postgres pool would otherwise hold the process open.
      process.exit();
    });
}
