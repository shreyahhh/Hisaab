import { describe, expect, it } from 'vitest';
import { createCredentialsCipher } from './credentialsCipher.js';
import { createTestCredentialsCipher, createTestCredentialsKeyConfig } from './testing.js';

describe('CredentialsCipher (ADR-0023)', () => {
  it('round-trips a plaintext under the same context', () => {
    const cipher = createTestCredentialsCipher();
    const context = { integrationId: 'integration-a' };
    const envelope = cipher.encrypt(context, 'super-secret-token');
    expect(cipher.decrypt(context, envelope)).toBe('super-secret-token');
  });

  it('produces a different envelope each time (random nonce)', () => {
    const cipher = createTestCredentialsCipher();
    const context = { integrationId: 'integration-a' };
    const a = cipher.encrypt(context, 'same-plaintext');
    const b = cipher.encrypt(context, 'same-plaintext');
    expect(a.equals(b)).toBe(false);
  });

  it('never contains the plaintext as a substring', () => {
    const cipher = createTestCredentialsCipher();
    const envelope = cipher.encrypt({ integrationId: 'integration-a' }, 'super-secret-token');
    expect(envelope.toString('latin1')).not.toContain('super-secret-token');
    expect(envelope.toString('utf8')).not.toContain('super-secret-token');
  });

  it('fails to decrypt when the envelope is moved to a different integration id (AAD mismatch)', () => {
    const cipher = createTestCredentialsCipher();
    const envelope = cipher.encrypt({ integrationId: 'integration-a' }, 'super-secret-token');
    expect(() => cipher.decrypt({ integrationId: 'integration-b' }, envelope)).toThrow();
  });

  it('fails to decrypt with a bit-flipped ciphertext (auth tag check)', () => {
    const cipher = createTestCredentialsCipher();
    const context = { integrationId: 'integration-a' };
    const envelope = cipher.encrypt(context, 'super-secret-token');
    const tampered = Buffer.from(envelope);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    expect(() => cipher.decrypt(context, tampered)).toThrow();
  });

  it('fails to decrypt under a cipher that does not hold the write version as a read version', () => {
    const config = createTestCredentialsKeyConfig(['k1']);
    const writer = createCredentialsCipher(config);
    const context = { integrationId: 'integration-a' };
    const envelope = writer.encrypt(context, 'super-secret-token');

    const otherCipher = createTestCredentialsCipher(['k2']);
    expect(() => otherCipher.decrypt(context, envelope)).toThrow();
  });

  it('supports a rotation window: k2 can still read a k1 envelope', () => {
    const config = createTestCredentialsKeyConfig(['k1']);
    const writerK1 = createCredentialsCipher(config);
    const context = { integrationId: 'integration-a' };
    const envelope = writerK1.encrypt(context, 'super-secret-token');

    const rotated = createCredentialsCipher({
      writeVersion: 'k2',
      readVersions: ['k1', 'k2'],
      masterKeys: { ...config.masterKeys, k2: new Uint8Array(32) },
    });
    expect(rotated.decrypt(context, envelope)).toBe('super-secret-token');
  });

  it('rejects a truncated envelope instead of throwing an unrelated error', () => {
    const cipher = createTestCredentialsCipher();
    expect(() =>
      cipher.decrypt({ integrationId: 'integration-a' }, Buffer.from([2, 107, 49])),
    ).toThrow('truncated');
  });

  it('rejects an empty envelope', () => {
    const cipher = createTestCredentialsCipher();
    expect(() => cipher.decrypt({ integrationId: 'integration-a' }, Buffer.alloc(0))).toThrow(
      'too short',
    );
  });
});
