import { fileURLToPath } from 'node:url';
import {
  apiPortEnvSchema,
  clickhouseEnvSchema,
  loadDotEnvIfPresent,
  loadEnv,
  postgresEnvSchema,
  redisCacheEnvSchema,
  redisDurableEnvSchema,
} from '@truepath/shared';

// Core API (Fastify): auth, tenants, integrations, reports, DPDP endpoints, webhooks (SPEC §10,
// §4). The Fastify server, zod validation and the auth/tenant middleware land in M0-4 onward.
// M0-2 wires env validation at boot only.

const apiEnvSchema = postgresEnvSchema
  .and(clickhouseEnvSchema)
  .and(redisDurableEnvSchema)
  .and(redisCacheEnvSchema)
  .and(apiPortEnvSchema);

export function placeholder(): string {
  return 'apps/api not yet implemented (SPEC §12 M0-4+)';
}

function main(): void {
  loadDotEnvIfPresent('../../.env');
  const env = loadEnv(apiEnvSchema);
  console.log(`apps/api: environment OK (NODE_ENV=${env.NODE_ENV}, PORT=${env.API_PORT})`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
