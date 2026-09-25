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
    // Data-access boundary rule (ADR-0016). No packages import DB clients yet, so this is a
    // no-op today; it starts enforcing the moment M0-3/M0-4 add real client imports.
    files: ['**/*.{ts,tsx}'],
    ignores: DB_CLIENT_ALLOWED.map((p) => `${p}/**`),
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: DB_CLIENT_PATTERNS.map((name) => ({
            name,
            message: `${name} may only be imported from ${DB_CLIENT_ALLOWED.join(', ')} (ADR-0016).`,
          })),
        },
      ],
    },
  },
);
