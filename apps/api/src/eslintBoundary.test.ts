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

describe('@truepath/privacy/meta-capi (plain SHA-256 for Meta) is importable only by the Meta integration', () => {
  const NAMED = `import { sha256ForMetaCapi } from '@truepath/privacy/meta-capi';\nvoid sha256ForMetaCapi;\n`;
  const mentionsIt = (messages: string[]) => messages.some((m) => m.includes('meta-capi'));

  it.each([
    ['the Meta integration', 'packages/integrations/meta/probe.ts'],
    ['the Meta integration under src/', 'packages/integrations/src/meta/probe.ts'],
  ])('is allowed in %s', async (_label, relPath) => {
    expect(mentionsIt(await restrictedImports(NAMED, relPath))).toBe(false);
  });

  it.each([
    ['apps/api', 'apps/api/src/routes/probe.ts'],
    ['apps/api tests', 'apps/api/src/probe.test.ts'],
    ['apps/workers', 'apps/workers/src/probe.ts'],
    ['apps/collector', 'apps/collector/src/probe.ts'],
    ['another integration', 'packages/integrations/google-ads/probe.ts'],
    ['the integrations package root', 'packages/integrations/src/probe.ts'],
    ['packages/privacy itself', 'packages/privacy/src/probe.ts'],
    ['packages/auth', 'packages/auth/src/probe.ts'],
    ['packages/db', 'packages/db/src/probe.ts'],
    ['the tenant-scope preHandler', 'apps/api/src/tenantScope.ts'],
  ])('is blocked in %s', async (_label, relPath) => {
    expect(mentionsIt(await restrictedImports(NAMED, relPath))).toBe(true);
  });

  it.each([
    [
      'an aliased import',
      `import { sha256ForMetaCapi as h } from '@truepath/privacy/meta-capi';\nvoid h;\n`,
    ],
    ['a namespace import', `import * as meta from '@truepath/privacy/meta-capi';\nvoid meta;\n`],
    ['a re-export', `export { hashContactForMetaCapi } from '@truepath/privacy/meta-capi';\n`],
    ['a side-effect import', `import '@truepath/privacy/meta-capi';\n`],
  ])('cannot be sidestepped with %s', async (_label, code) => {
    expect(mentionsIt(await restrictedImports(code, 'apps/api/src/routes/probe.ts'))).toBe(true);
  });

  it('does not over-block the rest of @truepath/privacy', async () => {
    const code = `import { createIdentityHasher } from '@truepath/privacy';\nimport { createTestIdentityHasher } from '@truepath/privacy/testing';\nvoid createIdentityHasher;\nvoid createTestIdentityHasher;\n`;
    for (const relPath of ['apps/api/src/routes/probe.ts', 'apps/workers/src/probe.ts']) {
      expect(await restrictedImports(code, relPath)).toEqual([]);
    }
  });

  it('keeps the Meta integration bound by the DB-client and scope-resolution rules', async () => {
    const raw = `import { Pool } from 'pg';\nvoid Pool;\n`;
    expect(
      (await restrictedImports(raw, 'packages/integrations/meta/probe.ts')).some((m) =>
        m.includes('pg'),
      ),
    ).toBe(true);
    const scope = `import { resolveStoreOrganization } from '@truepath/db';\nvoid resolveStoreOrganization;\n`;
    expect(
      (await restrictedImports(scope, 'packages/integrations/meta/probe.ts')).some((m) =>
        m.includes('resolveStoreOrganization'),
      ),
    ).toBe(true);
  });
});

// exposeAllPathsForTests re-exposes every Better Auth route the API disables (ADR-0022): only tests
// and test helpers may pass it. A syntax rule in eslint.config.js, checked here through the real config.
describe('exposeAllPathsForTests (re-exposes every disabled Better Auth route) is test-only', () => {
  async function restrictedSyntax(code: string, relPath: string): Promise<string[]> {
    const filePath = path.join(ROOT, relPath);
    expect(await eslint.isPathIgnored(filePath), `${relPath} must not be ignored`).toBe(false);
    const [result] = await eslint.lintText(code, { filePath });
    return (result?.messages ?? [])
      .filter((m) => m.ruleId === 'no-restricted-syntax')
      .map((m) => m.message);
  }
  const mentionsIt = (messages: string[]) =>
    messages.some((m) => m.includes('exposeAllPathsForTests'));
  const PASS = `import { createAuth } from '@truepath/auth';\nexport const a = createAuth({ exposeAllPathsForTests: true } as never);\n`;

  it.each([
    ['a test file in packages/auth', 'packages/auth/src/betterAuth.test.ts'],
    ['a test file in apps/api', 'apps/api/src/probe.test.ts'],
    ['a tsx test file', 'apps/dashboard/src/probe.test.tsx'],
    ['a test file anywhere', 'apps/workers/src/deep/probe.test.ts'],
    ['the db testing helper', 'packages/db/src/testing.ts'],
    ['the API test app helper', 'apps/api/src/testApp.ts'],
    ['the API tenant-seeding test helper', 'apps/api/src/testAuthTenant.ts'],
  ])('is allowed in %s', async (_label, relPath) => {
    expect(mentionsIt(await restrictedSyntax(PASS, relPath))).toBe(false);
  });

  it.each([
    ['application code in apps/api', 'apps/api/src/app.ts'],
    ['a route in apps/api', 'apps/api/src/routes/probe.ts'],
    ['apps/workers', 'apps/workers/src/probe.ts'],
    ['apps/collector', 'apps/collector/src/probe.ts'],
    ['packages/auth production code', 'packages/auth/src/probe.ts'],
    ['a file that only looks like a test helper', 'apps/api/src/testimony.ts'],
    ['a helper named like a test but not on the list', 'apps/api/src/testUtils.ts'],
    ['testing.ts outside a package src (not the helper)', 'apps/api/src/testing/probe.ts'],
    ['a .test.ts in a directory named tests but not a test file', 'apps/api/src/tests/probe.ts'],
  ])('is blocked in %s', async (_label, relPath) => {
    expect(mentionsIt(await restrictedSyntax(PASS, relPath))).toBe(true);
  });

  it.each([
    ['a value of false', `export const a = { exposeAllPathsForTests: false };\n`],
    [
      'the shorthand',
      `const exposeAllPathsForTests = true;\nexport const a = { exposeAllPathsForTests };\n`,
    ],
    ['a quoted key', `export const a = { 'exposeAllPathsForTests': true };\n`],
    [
      'a nested options object',
      `export const a = { auth: { deep: { exposeAllPathsForTests: true } } };\n`,
    ],
    [
      'a spread-in alongside other options',
      `export const a = { ...{}, exposeAllPathsForTests: true, other: 1 };\n`,
    ],
  ])('cannot be sidestepped with %s', async (_label, code) => {
    expect(mentionsIt(await restrictedSyntax(code, 'apps/api/src/routes/probe.ts'))).toBe(true);
  });

  it('does not over-block: other properties, and reading the option, are fine everywhere', async () => {
    const code = `export const a = { allowInsecureCookies: true };\nexport const b = (o: { exposeAllPathsForTests?: boolean }) => o.exposeAllPathsForTests;\n`;
    for (const relPath of ['apps/api/src/routes/probe.ts', 'packages/auth/src/probe.ts']) {
      expect(await restrictedSyntax(code, relPath)).toEqual([]);
    }
  });

  it('leaves the real createAuth (which declares and reads the option) and the real test files clean', async () => {
    const results = await eslint.lintFiles([
      path.join(ROOT, 'packages/auth/src/betterAuth.ts'),
      path.join(ROOT, 'packages/auth/src/betterAuth.test.ts'),
      path.join(ROOT, 'apps/api/src/testApp.ts'),
    ]);
    const offending = results.flatMap((r) =>
      r.messages.filter((m) => m.ruleId === 'no-restricted-syntax').map(() => r.filePath),
    );
    expect(offending).toEqual([]);
  });

  it('is actually used by the real test that needs it (so the rule is not vacuous)', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(path.join(ROOT, 'packages/auth/src/betterAuth.test.ts'), 'utf8')).toContain(
      'exposeAllPathsForTests: true',
    );
  });
});
