// Thin fetch wrapper for the Core API (SPEC §10). Always sends the session cookie
// (`credentials: 'include'`) — the API's CORS config (apps/api/src/app.ts) trusts exactly this
// dashboard origin with credentials. POST/PUT/PATCH also need `content-type: application/json` for
// the API's CSRF check (app.ts's onRequest hook) to treat them as same-origin.

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`API ${status}`);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
};

// ---- Response shapes (only the fields the dashboard reads) ------------------------------------

export interface Me {
  user: { id: string; email: string; name: string };
  memberships: { organizationId: string; role: string }[];
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
}

export interface Store {
  id: string;
  organizationId: string;
  shopDomain: string;
  status: string;
  currency: string;
  installedAt: string | null;
}

export interface IntegrationRow {
  id: string;
  provider: string;
  status: string;
  scopes: string[];
  connected_at: string | null;
  error: string | null;
  settings: Record<string, unknown>;
}

export interface OrderRow {
  id: string;
  external_order_id: string;
  created_at_platform: string;
  total_amount_paise: number;
  currency: string;
  payment_method: string;
  delivery_status: string;
  attribution_confidence: string | null;
  visitor_matched: boolean;
  phone_hash_present: boolean;
  email_hash_present: boolean;
}

export interface Touchpoint {
  occurred_at: string;
  channel: string;
  sub_channel: string;
  platform: string | null;
  campaign_id: string | null;
  adset_id: string | null;
  ad_id: string | null;
  click_id_type: string | null;
  is_direct: boolean;
}

export interface JourneyResponse {
  order_id: string;
  visitor_matched: boolean;
  touchpoints: Touchpoint[];
}

export interface TrackingSummary {
  window_days: number;
  events_total: number;
  unique_visitors: number;
  unique_sessions: number;
  events_per_day: { day: string; count: number }[];
  touchpoints_by_channel: { channel: string; count: number }[];
  consent: { accepted: number; dropped: number; drop_reasons: Record<string, number> };
}

export interface ConsentStats {
  suppressed_identities_count: number;
  consent_records_recent: {
    state: string;
    purposes: string[];
    source: string;
    notice_version: string;
    occurred_at: string;
  }[];
}

export interface DsrRequestsResponse {
  requests: {
    id: string;
    type: string;
    status: string;
    created_at: string;
    due_at: string;
    completed_at: string | null;
    trigger: string | null;
  }[];
  note: string;
}

export interface ChannelRule {
  id: string;
  priority: number;
  match: unknown;
  channel: string;
  sub_channel: string | null;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  actor_type: string;
  actor_user_id: string | null;
  target_type: string;
  target_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SystemStatus {
  api: string;
  suppress_ready_at: number | null;
  stream_events_raw_length: number | null;
  stream_events_dead_length: number | null;
  queues: { name: string; waiting: number | null; active: number | null; failed: number | null }[];
}
