# @truepath/privacy

Normalisers, SHA-256/tenant-HMAC hashing, `ConsentProvider`, the suppression-set client, log/URL
redaction, and the audit-log writer. This is the one reviewed implementation of every privacy
primitive in SPEC §5 — no module reimplements hashing, consent checks, or redaction on its own.

Empty scaffold as of M0-1. See `docs/architecture/lld/privacy-dpdp.md`; lands in M0-5/M0-6.
