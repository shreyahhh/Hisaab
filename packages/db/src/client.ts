import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index.js';

// The one place `pg`/drizzle-orm's Postgres driver is instantiated (ADR-0016 data-access
// boundary). Callers (repositories, M0-4+) take a TenantScope/SystemScope, never this pool
// directly.
export function createDb(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;
