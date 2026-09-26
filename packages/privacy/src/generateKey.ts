import { randomBytes } from 'node:crypto';

// Kept free of workspace imports so the root `pnpm gen:identity-key` script can load it directly,
// without a build.

/** A fresh 32-byte master secret, standard base64 — the format of `IDENTITY_MASTER_K<N>`. */
export function generateIdentityMasterKey(): string {
  return randomBytes(32).toString('base64');
}
