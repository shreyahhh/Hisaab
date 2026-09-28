// Server-side sessionisation rules (event-pipeline.md §4.2, SPEC §7.1). This is the *reference*
// implementation: `session_assign_v1` (Lua, apps/workers) applies the same rules atomically in Redis,
// and a differential test drives both with the same event sequences. Keep them in lock-step.

/** SPEC §7.1: a visitor idle for longer than this starts a new session. */
export const SESSION_GAP_MS = 30 * 60 * 1000;
/** HLD §8: `session:<store_id>:<visitor_id>` expires this long after its last event. */
export const SESSION_STATE_TTL_SECONDS = 7200;

/**
 * The hash at `session:<store_id>:<visitor_id>` (HLD §8 lists `{session_id, last_at, campaign_fp}`;
 * `start_ref` is added because rule 4 needs the referrer host that started the session).
 */
export interface SessionState {
  readonly session_id: string;
  /** Epoch ms of the latest event seen. */
  readonly last_at: number;
  readonly campaign_fp: string;
  /** External referrer host of the event that started the session ('' if none). */
  readonly start_ref: string;
}

export interface SessionEventInput {
  readonly occurred_at_ms: number;
  /** `campaignFingerprint(landing)`; '' when the event carries no campaign params. */
  readonly campaign_fp: string;
  /** `externalReferrerHost(landing, shopHosts)`; '' for no / ignorable referrer. */
  readonly external_referrer_host: string;
  /** `consent_granted` / `consent_withdrawn`: carries no landing semantics, never starts a session. */
  readonly is_consent: boolean;
  /** A fresh UUID v7, used only if this event starts a session. */
  readonly new_session_id: string;
}

export interface SessionAssignment {
  /** '' for a consent event with no session yet. */
  readonly session_id: string;
  readonly started: boolean;
}

/**
 * Applies one event. Events of a visitor must be fed in `occurred_at` order (ties in arrival order).
 * A new session starts when there is no state, or — for an event not older than the latest one seen —
 * the idle gap exceeds 30 min, the campaign fingerprint is present and changed, or an external referrer
 * appears that isn't the one that started the current session. An event older than `last_at` (out of
 * order across consumers) joins the current session and never starts one.
 */
export function assignSession(
  state: SessionState | null,
  e: SessionEventInput,
): { state: SessionState | null; assignment: SessionAssignment } {
  if (e.is_consent) {
    return { state, assignment: { session_id: state?.session_id ?? '', started: false } };
  }

  const start = (): { state: SessionState; assignment: SessionAssignment } => ({
    state: {
      session_id: e.new_session_id,
      last_at: e.occurred_at_ms,
      campaign_fp: e.campaign_fp,
      start_ref: e.external_referrer_host,
    },
    assignment: { session_id: e.new_session_id, started: true },
  });

  if (state === null) return start();

  const inOrder = e.occurred_at_ms >= state.last_at;
  if (
    inOrder &&
    (e.occurred_at_ms - state.last_at > SESSION_GAP_MS ||
      (e.campaign_fp !== '' && e.campaign_fp !== state.campaign_fp) ||
      (e.external_referrer_host !== '' && e.external_referrer_host !== state.start_ref))
  ) {
    return start();
  }

  return {
    state: { ...state, last_at: Math.max(state.last_at, e.occurred_at_ms) },
    assignment: { session_id: state.session_id, started: false },
  };
}
