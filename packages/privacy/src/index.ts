// Phone/email normalisers, SHA-256 + tenant-HMAC hashing, ConsentProvider, suppression-set
// client, log/URL redaction and the audit-log writer (SPEC §5, HLD §8 "Privacy / DPDP"). Every
// other module imports these rather than reimplementing them (CLAUDE.md rule 3).
// See docs/architecture/lld/privacy-dpdp.md. Empty scaffold as of M0-1 — hashing and redaction
// land in M0-5.

export const PACKAGE_NAME = '@truepath/privacy';
