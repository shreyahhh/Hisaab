# @truepath/privacy

The one reviewed implementation of the privacy primitives in SPEC §5: phone/email normalisation,
the keyed-hash helper, and log/URL redaction. No module reimplements hashing or redaction on its
own (CLAUDE.md rule 3). Design: `docs/architecture/lld/privacy-dpdp.md` §2.1, §4.1, §6; ADR-0007;
ADR-0020.

Not here yet: `ConsentProvider` and the suppression client (M1-5, with the collector), the audit
writer (M0-6).

## Public API

```ts
import {
  createIdentityHasher, storeContext, purposeContext, hashContact,
  normalisePhone, normaliseEmail, redactLogValue, findPii, sanitiseUrl, sanitiseReferrer,
} from '@truepath/privacy';
```

| Export | What it does |
|---|---|
| `normaliseEmail(raw)` | trim + lowercase (Meta's rule too); `null` if not an address. Deliberately lenient: it accepts everything Better Auth's sign-in accepts (plus-tags, subdomains, long TLDs, no length cap). No Gmail dot/plus stripping. |
| `normalisePhone(raw)` | E.164 (`+919753124680`) per LLD §4.1 step 4; `null` if unusable **or a dummy number** (one repeated digit, a repeated two-digit block, an ascending/descending run of 8+ digits, or `DUMMY_PHONES`). |
| `createIdentityHasher(config)` | the keyed-hash helper (below). |
| `hashContact(hasher, storeId, {phone?, email?})` | store-scoped `phoneHmac`, `emailHmac`, `identityHashHmac` (phone first) and `lookup` (both, under every read version). Raw values never leave the call. |
| `redactLogValue(value)` | a copy with emails, phones, 64-hex hashes and `IDENTITY_MASTER_*` assignments replaced by `[redacted]`, and sensitive keys blanked. For the logger hook and Sentry `beforeSend`. |
| `findPii(text)` | offsets and kinds of anything redaction would remove; the log-scan tests use it (SPEC §5.10 test 4). |
| `sanitiseUrl(url)` / `sanitiseReferrer(url)` | collector.md §4 step 9: allow-listed query params only, no fragment/userinfo, everything after `/checkouts/`, `/orders/`, `/account/`, `/cart/c/` masked as one `:token`. |
| `generateIdentityMasterKey()` | 32 random bytes as base64. |

Separate entry points: `@truepath/privacy/testing` (random-key hashers for tests) and
`@truepath/privacy/meta-capi` (below).

### The hasher: one helper, contexts, versions

```ts
const hasher = createIdentityHasher(env.identityKeys);        // throws if the config is unusable
hasher.hmac(storeContext(storeId), '+919753124680');           // 'k1:<64 hex>' under the write version
hasher.hmacAll(storeContext(storeId), '+919753124680');        // one per read version, for lookups
hasher.hashEmail(purposeContext('rate_limit_email'), raw);     // normalise, then hash; null if unusable
```

- **Normalise, then hash, in one place.** `hashEmail`/`hashPhone` call the normalisers above, so the
  same input gives the same hash whichever caller it came from. `hmac` is for values the caller
  has already normalised (visitor ids, IPs).
- **Contexts pick the key.** The HKDF `info` is `k<N>:` + `store:<uuid>` or `purpose:<name>`. Store
  ids must be UUIDs and purposes come from a closed list (`HASH_PURPOSES`), neither containing `:`,
  so no store id can spell a purpose or the reverse (tested).
- **Platform hashes and store hashes are deliberately unlinkable.** Hashes made under a purpose
  (`rate_limit_ip`, `rate_limit_email`) use keys unrelated to any store's, and one store's hashes
  are unrelated to another's, so none of them can be joined to any other (SPEC §7.3 rule 5). Add a
  purpose per distinct use; never reuse one.
- **Write vs read versions.** Writes use `IDENTITY_KEY_WRITE` only. Lookups that hold the raw value
  use `hmacAll`. Short-lived keys (the rate limiter) use the write version only: after a rotation
  their counters start fresh, which resets a client's window once, at most an hour.

## Keys: where they come from and how they rotate

Master secrets are env vars, validated at boot by `identityKeyEnvSchema` (`packages/shared`), with
**no defaults** — a missing or malformed one fails startup (ADR-0020):

| Variable | Meaning |
|---|---|
| `IDENTITY_MASTER_K<N>` | base64, ≥ 32 bytes, one per version |
| `IDENTITY_KEY_READ` | versions this process can read, e.g. `k1,k2` |
| `IDENTITY_KEY_WRITE` | the version new hashes use; must be in `IDENTITY_KEY_READ` |

- **Deployed:** ECS injects each `IDENTITY_MASTER_K<N>` from the Secrets Manager secret
  `truepath/identity-master/k<N>`.
- **Local:** `IDENTITY_MASTER_K1=$(pnpm -s gen:identity-key)` in your `.env`, with
  `IDENTITY_KEY_READ=k1` and `IDENTITY_KEY_WRITE=k1`. The script only prints a key; it writes nothing.
- **Tests** use `@truepath/privacy/testing`, which generates random keys in memory per run; no key
  is ever written to a file.
- **Rotation requires a task restart.** The environment is read once at process start, so adding
  `k2`, switching `IDENTITY_KEY_WRITE`, or retiring `k1` each takes a redeploy. The staged procedure
  (read `k2`, then write `k2`, re-key what can be recomputed, retire `k1` after 25 months) is
  privacy-dpdp.md §4.1. Phone/email HMACs cannot be re-keyed (no raw values); they age out.
- Error messages and redaction never include key material; `IDENTITY_MASTER_*` keys and
  `IDENTITY_MASTER_*=…` text are redacted.

## Plain SHA-256 is for Meta CAPI only

`@truepath/privacy/meta-capi` exports `sha256ForMetaCapi(field, raw)` and `hashContactForMetaCapi`.
Meta requires unsalted SHA-256, which is brute-forceable for a 10-digit mobile, so it is computed in
memory at send time and never stored. It follows Meta's normalisation (`em`: trim + lowercase; `ph`:
digits with country code, no `+`, no leading zeros) and returns `null` for dummy numbers. It is not
exported from the package index, and an ESLint rule (`eslint.config.js`, tested in
`apps/api/src/eslintBoundary.test.ts`) lets only `packages/integrations/meta` (or `…/src/meta`)
import it. Everything else uses the tenant HMAC.

## Known limits

- **Redaction false positives** are accepted (LLD §6): a 10-digit order number starting 6–9 is
  redacted like a phone number.
- **The blocklist blocks the LLD's own example** `98123 45678`, which contains the run `12345678`.
  The rule (8+ sequential digits, SPEC v0.3) wins; fixtures use other numbers.
- No logger or Sentry client is wired to `redactLogValue` yet — they arrive with the services that
  use them. Until then the API's tests scan captured console/stdout output for PII.

## Audit writer contract

`AuditLogger` (`write(scope, entry)` for an organization, `writePlatform(entry)` for the platform-wide
actions) and `validateAuditMetadata`. The catalogue, the per-action metadata schemas and the entry
types are in `packages/shared/src/audit.ts`: metadata is a strict, flat object of strings, numbers and
booleans whose shape depends on the action (`login_failed` takes `{target_user_id}` or
`{unknown_account: true}`, never an email or a hash of one). The schema is the check; a scan for
emails, phones, hashes and sensitive key names over string values is only a backstop for the two
free-form maps. `AuditMetadataError` names the action and the offending paths, never the values.
The Postgres implementation is `createAuditLogRepository` in `@truepath/db`, which the collector
(no Postgres connection) never imports.
