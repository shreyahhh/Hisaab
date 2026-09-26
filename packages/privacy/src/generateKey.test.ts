import { describe, expect, it } from 'vitest';
import { identityKeyEnvSchema, MIN_MASTER_KEY_BYTES } from '@truepath/shared';
import { generateIdentityMasterKey } from './generateKey.js';

describe('generateIdentityMasterKey', () => {
  it('returns standard base64 of a key the env schema accepts', () => {
    const key = generateIdentityMasterKey();
    expect(key).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(key, 'base64').length).toBeGreaterThanOrEqual(MIN_MASTER_KEY_BYTES);
    const parsed = identityKeyEnvSchema.safeParse({
      IDENTITY_KEY_READ: 'k1',
      IDENTITY_KEY_WRITE: 'k1',
      IDENTITY_MASTER_K1: key,
    });
    expect(parsed.success).toBe(true);
  });

  it('is different every time', () => {
    const keys = new Set(Array.from({ length: 20 }, () => generateIdentityMasterKey()));
    expect(keys.size).toBe(20);
  });
});
