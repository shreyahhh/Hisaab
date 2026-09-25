import { fileURLToPath } from 'node:url';
import {
  collectorPortEnvSchema,
  loadDotEnvIfPresent,
  loadEnv,
  redisDurableEnvSchema,
} from '@truepath/shared';

// Ingest collector (Fastify): POST /v1/collect — validation, consent gate, hashing, suppression
// check, geo, stream write (SPEC §7.2, HLD §5). Stateless, no Postgres connection, depends only on
// durable Redis. The Fastify server and the collect route land in M1-5; M0-2 wires env validation
// at boot only.

const collectorEnvSchema = redisDurableEnvSchema.and(collectorPortEnvSchema);

export function placeholder(): string {
  return 'apps/collector not yet implemented (SPEC §12 M1-5)';
}

function main(): void {
  loadDotEnvIfPresent('../../.env');
  const env = loadEnv(collectorEnvSchema);
  console.log(
    `apps/collector: environment OK (NODE_ENV=${env.NODE_ENV}, PORT=${env.COLLECTOR_PORT})`,
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
