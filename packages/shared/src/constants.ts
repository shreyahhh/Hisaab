// Platform-wide constants. Kept as plain data so packages/privacy and future tooling share one list.

// National (10-digit) phone numbers that carry no identity: COD checkouts often contain them
// (SPEC v0.3, privacy-dpdp.md §4.1 step 4). The repeated-digit, repeated-block and run rules are
// structural and live in packages/privacy; this is the explicit list, to be extended with known
// test numbers found during design-partner onboarding.
export const DUMMY_PHONES: readonly string[] = ['9000000000'];
