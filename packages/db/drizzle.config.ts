import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` only needs `schema`/`out` (no live DB); dbCredentials is used by
// `push`/`studio`, not by the generate step this package's db:generate script runs.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://truepath:truepath@localhost:5432/truepath',
  },
});
