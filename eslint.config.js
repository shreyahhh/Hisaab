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

// Plain (unsalted) SHA-256 of a shopper's phone/email exists only for Meta's Conversions API, where
// Meta requires it (ADR-0007). It is brute-forceable for a 10-digit mobile, so it must never be
// computed anywhere it could be stored or joined on: only the Meta integration may import it. It
// lives behind its own entry point (`@truepath/privacy/meta-capi`, not the package index), and the
// package's `exports` map blocks deep imports of its files. Everything else uses the tenant HMAC.
const META_CAPI_ENTRY = '@truepath/privacy/meta-capi';
const META_CAPI_ALLOWED = ['packages/integrations/meta', 'packages/integrations/src/meta'];

// no-restricted-imports options for a file, built from which of the three restrictions apply to it.
// Flat config doesn't merge two matching blocks' options for the same rule (the later block simply
// wins), so each file must match exactly ONE block below, and each block asks for exactly the
// restrictions that file needs — this one function keeps the blocks from drifting apart.
function boundaryRule({ dbClients, scopeResolution, metaCapi }) {
  const paths = [];
  if (dbClients) {
    for (const name of DB_CLIENT_PATTERNS) {
      paths.push({
        name,
        message: `${name} may only be imported from ${DB_CLIENT_ALLOWED.join(', ')} (ADR-0016).`,
      });
    }
  }
  if (scopeResolution) {
    paths.push({
      name: '@truepath/db',
      importNames: ['resolveStoreOrganization'],
      message: `resolveStoreOrganization is the ADR-0016 bootstrap primitive for building a TenantScope from a :storeId — only ${SCOPE_RESOLUTION_ALLOWED.join(', ')} may call it.`,
    });
  }
  const patterns = metaCapi
    ? [
        {
          group: [META_CAPI_ENTRY],
          message: `${META_CAPI_ENTRY} (plain SHA-256 of phone/email, for Meta CAPI only) may only be imported from ${META_CAPI_ALLOWED.join(', ')}. Use the tenant HMAC from @truepath/privacy for anything else (ADR-0007).`,
        },
      ]
    : [];
  return { paths, patterns };
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
    // Everyone else: no raw DB clients, and no resolveStoreOrganization.
    files: ['**/*.{ts,tsx}'],
    ignores: [
      ...DB_CLIENT_ALLOWED.map((p) => `${p}/**`),
      ...SCOPE_RESOLUTION_ALLOWED,
      ...META_CAPI_ALLOWED.map((p) => `${p}/**`),
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        boundaryRule({ dbClients: true, scopeResolution: true, metaCapi: true }),
      ],
    },
  },
  {
    // The tenant-scope preHandler: still bound by the DB-client rule, but it is the one sanctioned
    // caller of resolveStoreOrganization.
    files: SCOPE_RESOLUTION_ALLOWED,
    rules: {
      'no-restricted-imports': [
        'error',
        boundaryRule({ dbClients: true, scopeResolution: false, metaCapi: true }),
      ],
    },
  },
  {
    // packages/db, clickhouse and auth may use raw clients — but that does not entitle them to the
    // bootstrap primitive: an "allowed" package importing it from '@truepath/db' would bypass the
    // tenant-scope preHandler just as surely as an app would.
    files: DB_CLIENT_ALLOWED.map((p) => `${p}/**/*.{ts,tsx}`),
    rules: {
      'no-restricted-imports': [
        'error',
        boundaryRule({ dbClients: false, scopeResolution: true, metaCapi: true }),
      ],
    },
  },
  {
    // The Meta integration: the one place allowed to hash for CAPI. Still bound by the other two.
    files: META_CAPI_ALLOWED.map((p) => `${p}/**/*.{ts,tsx}`),
    rules: {
      'no-restricted-imports': [
        'error',
        boundaryRule({ dbClients: true, scopeResolution: true, metaCapi: false }),
      ],
    },
  },
);
