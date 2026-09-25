# 0007. PII hashing strategy

## Status
Accepted (fixed in SPEC §5.4; key versioning and blocklist added in v0.2/v0.3)

## Context
Phone and email are needed to stitch identities (SPEC §7.3), to match DSR requests, and for Meta CAPI (plain SHA-256). They must never be stored raw (SPEC §5.4). An unsalted SHA-256 of a 10-digit Indian mobile can be brute-forced quickly, so it is close to storing the number. COD checkouts often contain dummy numbers.

## Decision
- **Normalise** (`packages/privacy`):
  - phone → E.164;
  - email → trim and lowercase (matches Meta's rule);
  - a **dummy-phone blocklist** (repeated digits, repeated two-digit blocks, ascending/descending runs, platform list) yields *no identifier*.
- **Internal joins**: `HMAC-SHA256` with a **per-tenant key** derived by HKDF from a KMS-protected master secret. Stored as **`k<N>:<hex>`** so the master can be rotated; lookups check every active key version. The rotation procedure is in privacy-dpdp §4.1.
- **Meta CAPI**: plain SHA-256 is computed **in memory at send time** from a Shopify re-fetch of the order, and is **never stored**. If the fetch fails, the event is skipped.
- Visitor ids stored outside the event tables (`consent_records`, suppression) are HMAC'd too.
- Raw values exist only inside the hashing call; they are never logged (redaction hook plus log-scan test).

## Consequences
- No reversible identifiers at rest; cross-tenant joins are impossible because hashes differ per tenant.
- Phone/email HMACs can't be re-keyed on rotation (no raw values); they age out with retention (≤ 25 months).
- CAPI depends on Shopify protected-customer-data access (Level 2, M0-7) and on the send-time fetch succeeding.
