# 0020. Identity master keys are injected as env vars from Secrets Manager

## Status
Accepted (2026-09-26; refines Accepted ADR-0007 and privacy-dpdp.md §4.1 — no decision there is reversed)

## Context
ADR-0007 and privacy-dpdp.md §4.1 say every service loads its identity master secrets
(`truepath/identity-master/k<N>`) from Secrets Manager at boot. Two ways to do that: call Secrets
Manager from each service with the AWS SDK, or let the platform inject the secrets as environment
variables (ECS task definitions map a Secrets Manager secret to an env var natively).
CLAUDE.md requires new dependencies to be approved, and the AWS SDK is not in SPEC §3's list.

## Decision
- Master secrets arrive as env vars, validated with zod at boot (`identityKeyEnvSchema` in
  `packages/shared`): `IDENTITY_MASTER_K<N>` (base64, ≥ 32 bytes), `IDENTITY_KEY_READ` (e.g. `k1,k2`)
  and `IDENTITY_KEY_WRITE` (one of them). In deployed environments ECS injects them from Secrets
  Manager; locally they come from `.env` (`pnpm gen:identity-key` prints a fresh key).
- **No defaults, in any environment.** A missing or malformed variable fails startup. A service that
  cannot load its keys must not hash under a weaker or empty one.
- `packages/privacy` derives per-context keys by HKDF-SHA256 (salt `truepath-identity`, info
  `k<N>:` + an unambiguous context: `store:<uuid>` for a store, `purpose:<name>` for hashes that
  belong to no tenant). Store and platform-purpose hashes are deliberately unlinkable.
- `IDENTITY_MASTER_*` values are on the log-redaction list.

## Consequences
- No AWS SDK dependency and no boot-time network call to fetch keys.
- Env vars are read once at process start, so **a key rotation (or a new `IDENTITY_KEY_*` value)
  needs a task restart/redeploy**. Rotation is already a staged deploy (privacy-dpdp.md §4.1), so
  this adds no new step.
- Anything able to read a task's environment can read the master keys (ECS exec, a crash dump of
  `process.env`). Redaction covers logs and the error tracker; access to task environments is an
  IAM concern.
- If a later ticket needs runtime key fetch (rotation without restart), add a loader behind the same
  `IdentityKeyConfig` shape; nothing else changes.
