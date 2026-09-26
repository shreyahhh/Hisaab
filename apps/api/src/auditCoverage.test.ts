import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIT_ACTION_OWNERS, AUDIT_ACTIONS } from '@truepath/shared';
import { describe, expect, it } from 'vitest';

// SPEC §5.10 test 8: "an audit row exists for every DSR, export and settings change". Most of those
// features land in later tickets, so AUDIT_ACTION_OWNERS (packages/shared/src/audit.ts) says, for
// each action in the catalogue, which ticket emits it and — once it does — which test proves a row
// is written. This test keeps that registry honest in both directions.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === 'node_modules' || name === 'dist') return [];
    if (statSync(full).isDirectory()) return sources(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

const packageSources = [
  ...['apps', 'packages'].flatMap((group) =>
    readdirSync(path.join(ROOT, group)).flatMap((name) =>
      sources(path.join(ROOT, group, name, 'src')),
    ),
  ),
]
  // The catalogue and its schemas mention every action by design; they are not emitters.
  .filter((file) => !/packages[\\/]shared[\\/]src[\\/](audit|valueLists)\.ts$/.test(file));

const emitted = (name: string) => new RegExp(String.raw`action:\s*'${name}'`);

describe('audit action ownership', () => {
  it('names an owner ticket for every action in the catalogue, and no others', () => {
    expect(Object.keys(AUDIT_ACTION_OWNERS).sort()).toEqual([...AUDIT_ACTIONS].sort());
    for (const action of AUDIT_ACTIONS) {
      expect(AUDIT_ACTION_OWNERS[action].ticket.length, action).toBeGreaterThan(0);
    }
  });

  it('gives every implemented action a test that mentions it, and code that emits it', () => {
    for (const action of AUDIT_ACTIONS) {
      const owner: (typeof AUDIT_ACTION_OWNERS)[typeof action] = AUDIT_ACTION_OWNERS[action];
      if (owner.status !== 'implemented') continue;
      expect(owner.evidence.length, `${action} needs evidence`).toBeGreaterThan(0);
      for (const file of owner.evidence) {
        const full = path.join(ROOT, file);
        expect(existsSync(full), `${action}: ${file} exists`).toBe(true);
        expect(readFileSync(full, 'utf8'), `${action}: ${file} mentions it`).toContain(
          `'${action}'`,
        );
      }
      const emitters = packageSources.filter((file) =>
        emitted(action).test(readFileSync(file, 'utf8')),
      );
      expect(
        emitters.length,
        `${action} is marked implemented but no code emits it`,
      ).toBeGreaterThan(0);
    }
  });

  it('has no action emitted by code that the registry still calls pending', () => {
    const stillPending: string[] = [];
    for (const action of AUDIT_ACTIONS) {
      if (AUDIT_ACTION_OWNERS[action].status === 'implemented') continue;
      const emitters = packageSources.filter((file) =>
        emitted(action).test(readFileSync(file, 'utf8')),
      );
      if (emitters.length > 0) {
        stillPending.push(`${action} (${emitters.map((f) => path.relative(ROOT, f)).join(', ')})`);
      }
    }
    expect(
      stillPending,
      'mark these implemented in AUDIT_ACTION_OWNERS, with a test as evidence',
    ).toEqual([]);
  });
});
