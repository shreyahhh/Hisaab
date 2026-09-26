import { randomBytes } from 'node:crypto';
import type { IdentityKeyConfig, KeyVersion } from '@truepath/shared';
import { createIdentityHasher, type IdentityHasher } from './hasher.js';

// Test-only helpers (`@truepath/privacy/testing`). Master keys are random per call and live only in
// memory, so no key material is ever written to a file or shared between runs.

export function createTestKeyConfig(
  readVersions: readonly KeyVersion[] = ['k1'],
  writeVersion: KeyVersion = readVersions[readVersions.length - 1] ?? 'k1',
): IdentityKeyConfig {
  const masterKeys = {} as Record<KeyVersion, Uint8Array>;
  for (const version of readVersions) masterKeys[version] = new Uint8Array(randomBytes(32));
  return { writeVersion, readVersions, masterKeys };
}

export function createTestIdentityHasher(
  readVersions: readonly KeyVersion[] = ['k1'],
  writeVersion?: KeyVersion,
): IdentityHasher {
  return createIdentityHasher(createTestKeyConfig(readVersions, writeVersion));
}
