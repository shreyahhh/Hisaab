import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { clickhouseEnvSchema, loadDotEnvIfPresent, loadEnv } from '@truepath/shared';
import { createClickHouseClient } from './client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

async function main(): Promise<void> {
  loadDotEnvIfPresent('../../.env');
  const env = loadEnv(clickhouseEnvSchema);
  const client = createClickHouseClient(env);

  await client.command({
    query: `
      CREATE TABLE IF NOT EXISTS schema_migrations
      (
          name String,
          applied_at DateTime64(3) DEFAULT now64(3)
      )
      ENGINE = MergeTree
      ORDER BY name
    `,
  });

  const appliedResult = await client.query({
    query: 'SELECT name FROM schema_migrations',
    format: 'JSONEachRow',
  });
  const appliedRows = await appliedResult.json<{ name: string }>();
  const applied = new Set(appliedRows.map((row) => row.name));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await client.command({ query: sql });
    await client.insert({
      table: 'schema_migrations',
      values: [{ name: file }],
      format: 'JSONEachRow',
    });
    console.log(`packages/clickhouse: applied ${file}`);
  }

  await client.close();
  console.log('packages/clickhouse: migrations applied');
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('packages/clickhouse: migration failed', error);
      process.exit(1);
    });
}
