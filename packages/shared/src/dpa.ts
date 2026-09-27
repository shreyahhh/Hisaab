import { z } from 'zod';

// DPA acceptance (SPEC §5.1, §10; auth-tenancy.md §4.5; privacy-dpdp.md §4.10). The DPA text lives in
// docs/dpdp/dpa-template.md; the version string names which text an owner accepted.

/**
 * A DPA version identifier, e.g. `0.1-draft` or `2026-11-v1`. Restricted to a short, plain token so it
 * is safe to store, to log, and to put in an audit row (where free text is not allowed).
 */
export const DPA_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const DpaVersionSchema = z.string().regex(DPA_VERSION_PATTERN);

/** `POST /v1/orgs/:id/dpa/accept` request body. Strict: no unknown keys. */
export const DpaAcceptBodySchema = z.object({ dpa_version: z.string().min(1).max(32) }).strict();
export type DpaAcceptBody = z.infer<typeof DpaAcceptBodySchema>;

/** `POST /v1/orgs/:id/dpa/accept` success body: `201` when created, `200` when already accepted. */
export interface DpaAcceptResponse {
  readonly id: string;
  readonly dpa_version: string;
  /** ISO 8601, UTC. */
  readonly accepted_at: string;
}
