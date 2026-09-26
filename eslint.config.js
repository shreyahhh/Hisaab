// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

// Packages allowed to import DB / ClickHouse clients directly (ADR-0016, auth-tenancy.md §4.4).
// All other packages must go through packages/db or packages/clickhouse.
const DB_CLIENT_PATTERNS = ['pg', 'postgres', 'drizzle-orm/node-postgres', '@clickhouse/client'];
const DB_CLIENT_ALLOWED = ['packages/db', 'packages/clickhouse', 'packages/auth'];

// resolveStoreOrganization is the one bootstrap primitive outside the scoped repository layer
// (ADR-0016, tenantScope.ts): it maps a :storeId to its organization *before* any TenantScope
// exists, so a :storeId route's identical-404 guarantee (a non-existent store vs. a foreign one)
// depends on nobody else calling it ad hoc. Its only sanctioned caller is the tenant-scope
// preHandler.
const SCOPE_RESOLUTION_ALLOWED = ['apps/api/src/tenantScope.ts'];

// no-restricted-imports "paths" entries shared by both boundary rules below; `withScopeResolution`
// adds the resolveStoreOrganization restriction for every file except SCOPE_RESOLUTION_ALLOWED —
// kept as one function so the two blocks below can't drift out of sync with each other.
function dbClientBoundaryPaths(withScopeResolution) {
  const paths = DB_CLIENT_PATTERNS.map((name) => ({
    name,
    message: `${name} may only be imported from ${DB_CLIENT_ALLOWED.join(', ')} (ADR-0016).`,
  }));
  if (withScopeResolution) {
    paths.push({
      name: '@truepath/db',
      importNames: ['resolveStoreOrganization'],
      message: `resolveStoreOrganization is the ADR-0016 bootstrap primitive for building a TenantScope from a :storeId — only ${SCOPE_RESOLUTION_ALLOWED.join(', ')} may call it.`,
    });
  }
  return paths;
}

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.turbo/**', '**/coverage/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // No `any` without a comment explaining why (CLAUDE.md rule 4). `no-explicit-any` catches
      // the case; the "explaining comment" half is enforced by review, not lint.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['apps/dashboard/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    // Data-access boundary rule (ADR-0016), plus the resolveStoreOrganization restriction for
    // every file except the one allowed caller (kept as a separate block below, so the two
    // `no-restricted-imports` configs never both match the same file — flat config doesn't merge
    // two matching blocks' options for the same rule, the later one simply wins outright).
    files: ['**/*.{ts,tsx}'],
    ignores: [...DB_CLIENT_ALLOWED.map((p) => `${p}/**`), ...SCOPE_RESOLUTION_ALLOWED],
    rules: {
      'no-restricted-imports': ['error', { paths: dbClientBoundaryPaths(true) }],
    },
  },
  {
    // The tenant-scope preHandler: still bound by the DB-client boundary rule, but exempt from
    // the resolveStoreOrganization restriction — it's the function's one sanctioned caller.
    files: SCOPE_RESOLUTION_ALLOWED,
    rules: {
      'no-restricted-imports': ['error', { paths: dbClientBoundaryPaths(false) }],
    },
  },
);
