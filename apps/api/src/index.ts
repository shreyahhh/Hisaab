import { fileURLToPath } from 'node:url';
import { createIdentityHasher } from '@truepath/privacy';
import {
  apiPortEnvSchema,
  clickhouseEnvSchema,
  credentialsKeyEnvSchema,
  dpaEnvSchema,
  identityKeyEnvSchema,
  loadDotEnvIfPresent,
  loadEnv,
  postgresEnvSchema,
  redisCacheEnvSchema,
  redisDurableEnvSchema,
  shopifyEnvSchema,
} from '@truepath/shared';

// Core API (Fastify): auth, tenants, integrations, reports, DPDP endpoints, webhooks (SPEC §10,
// §4). The Fastify server, zod validation and the auth/tenant middleware land in M0-4 onward.
// M0-2 wires env validation at boot only. Building the real running server (buildApp + listen(),
// Better Auth config, the Shopify adapter/cipher instances) is a deploy-prerequisite tracked
// separately (issues #2-#5) — this file validates the full env shape the real entrypoint will need.

// The identity/credentials keys and DPA_VERSION have no default: without them the API refuses to
// start (privacy-dpdp.md §4.1, §4.10; ADR-0023).
export const apiEnvSchema = postgresEnvSchema
  .and(clickhouseEnvSchema)
  .and(redisDurableEnvSchema)
  .and(redisCacheEnvSchema)
  .and(apiPortEnvSchema)
  .and(identityKeyEnvSchema)
  .and(credentialsKeyEnvSchema)
  .and(dpaEnvSchema)
  .and(shopifyEnvSchema);

export function placeholder(): string {
  return 'apps/api not yet implemented (SPEC §12 M0-4+)';
}

function main(): void {
  loadDotEnvIfPresent('../../.env');
  const env = loadEnv(apiEnvSchema);
  const hasher = createIdentityHasher(env.identityKeys);
  console.log(
    `apps/api: environment OK (NODE_ENV=${env.NODE_ENV}, PORT=${env.API_PORT}, identity keys write=${hasher.writeVersion} read=${hasher.readVersions.join(',')})`,
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
