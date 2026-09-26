import { DUMMY_PHONES } from '@truepath/shared';

// The one place phone and email are normalised (privacy-dpdp.md §4.1 steps 4-5). Everything that
// hashes an identifier goes through these, so the same input gives the same hash everywhere.
// Both return null when the input is not a usable identifier: garbage is never hashed.

const MIN_RUN = 8;

function allSame(digits: string): boolean {
  return digits.length > 1 && [...digits].every((d) => d === digits[0]);
}

function isRepeatedBlock(digits: string): boolean {
  if (digits.length < 4 || digits.length % 2 !== 0) return false;
  const block = digits.slice(0, 2);
  return block.repeat(digits.length / 2) === digits;
}

/** True if the digits contain an ascending or descending run of MIN_RUN or more (e.g. 12345678). */
function hasSequentialRun(digits: string): boolean {
  let up = 1;
  let down = 1;
  for (let i = 1; i < digits.length; i++) {
    const step = Number(digits[i]) - Number(digits[i - 1]);
    up = step === 1 ? up + 1 : 1;
    down = step === -1 ? down + 1 : 1;
    if (up >= MIN_RUN || down >= MIN_RUN) return true;
  }
  return false;
}

// Applied to the national number: the 10 digits after +91, or the last 10 digits of any other
// number (the country code's length varies and a dummy number shows up in the tail).
function isDummyNational(national: string): boolean {
  return (
    allSame(national) ||
    isRepeatedBlock(national) ||
    hasSequentialRun(national) ||
    DUMMY_PHONES.includes(national)
  );
}

/**
 * Normalises a phone number to E.164 (`+919812345678`), or null if it isn't usable — including
 * dummy numbers (SPEC v0.3), which must never be hashed or used for stitching.
 */
export function normalisePhone(raw: string, _defaultCountry: 'IN' = 'IN'): string | null {
  const stripped = raw.replace(/[^\d+]/g, '');
  const plus = stripped.startsWith('+');
  const digits = stripped.replace(/\+/g, '');
  if (stripped.slice(1).includes('+')) return null;

  let e164: string | null = null;
  let national: string;

  if (plus) {
    if (digits.startsWith('91')) {
      if (digits.length !== 12) return null;
      e164 = `+${digits}`;
      national = digits.slice(2);
    } else {
      if (digits.length < 8 || digits.length > 15) return null;
      e164 = `+${digits}`;
      national = digits.slice(-10);
    }
  } else if (digits.length === 12 && digits.startsWith('91')) {
    e164 = `+${digits}`;
    national = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    national = digits.slice(1);
    e164 = `+91${national}`;
  } else if (digits.length === 10 && /^[6-9]/.test(digits)) {
    national = digits;
    e164 = `+91${digits}`;
  } else {
    return null;
  }

  return isDummyNational(national) ? null : e164;
}

/**
 * Trim + lowercase, which is also Meta's own email normalisation. Deliberately lenient about what
 * counts as an address: it must never reject anything Better Auth's sign-up/sign-in accepts, or a
 * real user's attempts would be hashed to "no identifier". No Gmail dot or plus-tag stripping, and no
 * length cap (a cap would reject long addresses Better Auth accepts; body size is bounded upstream).
 */
export function normaliseEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || /\s/.test(email)) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@')) return null;
  const domain = email.slice(at + 1);
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((label) => label.length === 0)) return null;
  return email;
}
