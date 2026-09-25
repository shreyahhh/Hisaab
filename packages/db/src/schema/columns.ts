import { sql } from 'drizzle-orm';
import { check, customType, type AnyPgColumn } from 'drizzle-orm/pg-core';

// drizzle-orm/pg-core has no built-in bytea column type; this is the documented way to add one.
// Used for integrations.encrypted_credentials (KMS envelope-encrypted OAuth tokens, SPEC §5.5 S-2).
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

// Builds a `CHECK (column IN ('a', 'b', ...))` constraint from one of packages/shared's value-list
// arrays (@truepath/shared valueLists.ts) — the same array a zod validator is built from, so the DB
// constraint and the application-layer check never drift. `values` are our own hardcoded constants,
// never external input, so inlining them as SQL literal text here is safe.
export function checkOneOf(constraintName: string, column: AnyPgColumn, values: readonly string[]) {
  const quotedList = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(', ');
  return check(constraintName, sql`${column} IN (${sql.raw(quotedList)})`);
}
