# 0023. Integration credentials are envelope-encrypted with an env-injected master key, not live KMS calls

## Status
Accepted (2026-09-27; extends Accepted ADR-0020's reasoning from identity-hash keys to secrets-at-rest — no decision in either is reversed)

## Context
SPEC §5.5 S-2 and HLD's "Secrets rule" require `integrations.encrypted_credentials` (OAuth access/refresh
tokens, pixel signing keys) to be "envelope-encrypted with KMS." M1-1 is the first ticket to actually write
to that column (the Shopify OAuth callback). ADR-0020 already faced the identical wording for identity-hash
master keys and chose env-injected secrets (ECS maps a Secrets Manager secret to an env var) over calling
the AWS KMS API directly, specifically to avoid adding the AWS SDK as a dependency not listed in SPEC §3.
The same trade-off applies here, and there is no AWS SDK dependency anywhere in the repo yet.

## Decision
- A new key family, independent of the identity-hashing keys (`IDENTITY_MASTER_*`): `CREDENTIALS_MASTER_K<N>`
  (base64, ≥ 32 bytes), `CREDENTIALS_KEY_READ` (e.g. `k1,k2`), `CREDENTIALS_KEY_WRITE` — same shape and
  validation as `identityKeyEnvSchema`, in a sibling `credentialsKeyEnvSchema` (`packages/shared`). No
  defaults in any environment; a service that can't load these keys must not start.
- Encryption is AES-256-GCM, done locally in `packages/privacy` (a new module, not the hasher — encryption
  is reversible and must stay a distinct concern from one-way hashing): a random 12-byte nonce per
  encryption, and **additional authenticated data (AAD) binding the integration id and the key version**.
  A ciphertext copied into another row's `encrypted_credentials` (e.g. by a bug, a bad migration, or a
  restored backup applied to the wrong row) fails to decrypt, because the AAD it was sealed under no
  longer matches. This is stronger than ADR-0007/ADR-0020's HKDF-per-context derivation alone would give,
  because GCM's AAD check is a hard authentication failure, not a silent wrong-key derivation.
- The per-key-version data-encryption key is itself derived from the matching `CREDENTIALS_MASTER_K<N>` via
  HKDF-SHA256 (same primitive as ADR-0007's hasher, distinct salt: `truepath-credentials`), so there is one
  master secret per version, not one raw AES key floating in env vars directly.
- `CREDENTIALS_MASTER_*` is added to the log-redaction list (`packages/privacy`'s redaction module),
  alongside `IDENTITY_MASTER_*`.

## Consequences
- No AWS SDK dependency and no boot-time network call, same as ADR-0020.
- Ciphertext is not portable across rows or key versions by construction; a legitimate key rotation must
  decrypt under the old version and re-encrypt under the new one row by row (a future rotation job), not a
  bulk re-key.
- Env vars are read once at boot: a `CREDENTIALS_MASTER_*` rotation needs a task restart, matching
  ADR-0020's identity-key rotation story.
- This still isn't literal "KMS" (S-2's wording) — flagged as future work, same gap ADR-0020 already
  accepted for identity keys. A real AWS KMS integration is a separate, later decision if the env-injected
  approach turns out to be insufficient (e.g. for a customer's compliance requirement naming KMS by name).
