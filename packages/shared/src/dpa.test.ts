import { describe, expect, it } from 'vitest';
import { dpaEnvSchema, parseEnv } from './env.js';
import { DPA_VERSION_PATTERN, DpaAcceptBodySchema, DpaVersionSchema } from './dpa.js';

describe('DpaAcceptBodySchema', () => {
  it('accepts exactly { dpa_version }', () => {
    expect(DpaAcceptBodySchema.parse({ dpa_version: '0.1-draft' })).toEqual({
      dpa_version: '0.1-draft',
    });
  });

  it.each([
    ['missing version', {}],
    ['empty version', { dpa_version: '' }],
    ['non-string version', { dpa_version: 1 }],
    ['over-long version', { dpa_version: 'x'.repeat(33) }],
    ['an unknown key', { dpa_version: 'v1', accepted_by: 'someone-else' }],
    ['null body', null],
  ])('rejects %s', (_label, body) => {
    expect(DpaAcceptBodySchema.safeParse(body).success).toBe(false);
  });
});

describe('DPA version format', () => {
  it.each(['0.1-draft', '2026-11-v1', 'v1', 'A', 'a'.repeat(32)])('accepts %s', (version) => {
    expect(DPA_VERSION_PATTERN.test(version)).toBe(true);
    expect(DpaVersionSchema.safeParse(version).success).toBe(true);
  });

  it.each(['', '-v1', '.v1', 'v 1', 'v1\n', 'v1;drop', 'a'.repeat(33), 'दो'])(
    'rejects %j',
    (version) => {
      expect(DPA_VERSION_PATTERN.test(version)).toBe(false);
    },
  );
});

describe('dpaEnvSchema', () => {
  it('accepts a valid DPA_VERSION', () => {
    const result = parseEnv(dpaEnvSchema, { DPA_VERSION: '0.1-draft' });
    expect(result.success).toBe(true);
  });

  it('has no default: a missing DPA_VERSION is an error in every NODE_ENV', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      expect(parseEnv(dpaEnvSchema, { NODE_ENV }).success, NODE_ENV).toBe(false);
    }
  });

  it('rejects a malformed DPA_VERSION', () => {
    expect(parseEnv(dpaEnvSchema, { DPA_VERSION: 'has space' }).success).toBe(false);
    expect(parseEnv(dpaEnvSchema, { DPA_VERSION: '' }).success).toBe(false);
  });
});
