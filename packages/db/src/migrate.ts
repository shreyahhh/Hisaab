import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadDotEnvIfPresent, loadEnv, postgresEnvSchema } from '@truepath/shared';
import { createDb } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  loadDotEnvIfPresent('../../.env');
  const env = loadEnv(postgresEnvSchema);
  const db = createDb(env.DATABASE_URL);
  await migrate(db, { migrationsFolder: path.resolve(__dirname, '../migrations') });
  console.log('packages/db: migrations applied');
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('packages/db: migration failed', error);
      process.exit(1);
    });
}
