import { createHash } from 'node:crypto';
import { normaliseEmail, normalisePhone } from './normalise.js';

// Plain (unsalted) SHA-256 of phone/email, for Meta's Conversions API ONLY — Meta requires it, and
// it is brute-forceable for a 10-digit mobile, which is why it must never be stored (ADR-0007).
// It is computed in memory at send time from a Shopify re-fetch and discarded with the request.
//
// This is a separate entry point (`@truepath/privacy/meta-capi`), not part of the package index, and
// eslint.config.js only lets the Meta integration import it. Everything else keys with the
// tenant HMAC in ./hasher.ts.

export type MetaCapiField = 'ph' | 'em';

/**
 * Meta's documented normalisation, then SHA-256 hex. Returns null if the value isn't usable (which
 * includes dummy phone numbers), so nothing meaningless is sent.
 * - `em`: trim and lowercase.
 * - `ph`: digits only, with country code, no `+`, no leading zeros (i.e. E.164 without the plus).
 * https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
 */
export function sha256ForMetaCapi(field: MetaCapiField, raw: string): string | null {
  const normalised =
    field === 'em' ? normaliseEmail(raw) : (normalisePhone(raw)?.replace(/^\+/, '') ?? null);
  if (normalised === null) return null;
  return createHash('sha256').update(normalised).digest('hex');
}

/** The `user_data` hashes for one order's contact details. Absent or unusable values are omitted. */
export function hashContactForMetaCapi(contact: {
  phone?: string | undefined;
  email?: string | undefined;
}): {
  ph?: string;
  em?: string;
} {
  const ph = contact.phone ? sha256ForMetaCapi('ph', contact.phone) : null;
  const em = contact.email ? sha256ForMetaCapi('em', contact.email) : null;
  return { ...(ph ? { ph } : {}), ...(em ? { em } : {}) };
}
