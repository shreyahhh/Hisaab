import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

// resolveStoreOrganization is the ADR-0016 bootstrap primitive: only tenantScope.ts may call it,
// and that is enforced by eslint.config.js alone. A rule nobody tests is a rule that can be
// deleted or loosened without anyone noticing, so this lints synthetic files through the *real*
// repo config and fails if the restriction disappears or stops covering a place it should.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: ROOT });
});

/** no-restricted-imports messages for `code` linted as if it lived at `relPath` under the repo root. */
async function restrictedImports(code: string, relPath: string): Promise<string[]> {
  const filePath = path.join(ROOT, relPath);
  // A file that eslint ignores would "pass" every case below for the wrong reason.
  expect(await eslint.isPathIgnored(filePath), `${relPath} must not be ignored`).toBe(false);
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-imports')
    .map((m) => m.message);
}

const NAMED = `import { resolveStoreOrganization } from '@truepath/db';\nvoid resolveStoreOrganization;\n`;
const mentionsIt = (messages: string[]) =>
  messages.some((m) => m.includes('resolveStoreOrganization'));

describe('resolveStoreOrganization is importable only by apps/api/src/tenantScope.ts', () => {
  it('is allowed in tenantScope.ts', async () => {
    expect(mentionsIt(await restrictedImports(NAMED, 'apps/api/src/tenantScope.ts'))).toBe(false);
  });

  it.each([
    ['another file in apps/api', 'apps/api/src/routes/probe.ts'],
    ['a test file in apps/api', 'apps/api/src/probe.test.ts'],
    ['apps/workers', 'apps/workers/src/probe.ts'],
    ['apps/collector', 'apps/collector/src/probe.ts'],
    ['packages/auth (allowed raw DB clients, but not this)', 'packages/auth/src/probe.ts'],
    ['packages/db (via the package specifier)', 'packages/db/src/probe.ts'],
    ['packages/clickhouse', 'packages/clickhouse/src/probe.ts'],
  ])('is blocked in %s', async (_label, relPath) => {
    expect(mentionsIt(await restrictedImports(NAMED, relPath))).toBe(true);
  });

  it.each([
    [
      'an aliased import',
      `import { resolveStoreOrganization as resolve } from '@truepath/db';\nvoid resolve;\n`,
    ],
    ['a namespace import', `import * as db from '@truepath/db';\nvoid db;\n`],
    ['a re-export', `export { resolveStoreOrganization } from '@truepath/db';\n`],
  ])('cannot be sidestepped with %s', async (_label, code) => {
    expect(mentionsIt(await restrictedImports(code, 'apps/api/src/routes/probe.ts'))).toBe(true);
  });

  it('does not over-block: other @truepath/db exports are fine everywhere', async () => {
    const code = `import { createStoreRepository } from '@truepath/db';\nvoid createStoreRepository;\n`;
    for (const relPath of ['apps/api/src/routes/probe.ts', 'packages/auth/src/probe.ts']) {
      expect(await restrictedImports(code, relPath)).toEqual([]);
    }
  });
});

describe('the DB-client boundary (same rule block) is intact', () => {
  const RAW = `import { Pool } from 'pg';\nvoid Pool;\n`;

  it('blocks raw pg in apps/api, including tenantScope.ts', async () => {
    for (const relPath of ['apps/api/src/routes/probe.ts', 'apps/api/src/tenantScope.ts']) {
      const messages = await restrictedImports(RAW, relPath);
      expect(messages.some((m) => m.includes('pg'))).toBe(true);
    }
  });

  it('still allows raw pg in packages/db, packages/auth and packages/clickhouse', async () => {
    for (const relPath of [
      'packages/db/src/probe.ts',
      'packages/auth/src/probe.ts',
      'packages/clickhouse/src/probe.ts',
    ]) {
      expect(await restrictedImports(RAW, relPath)).toEqual([]);
    }
  });
});
