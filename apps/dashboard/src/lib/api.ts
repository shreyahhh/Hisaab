import { z } from 'zod';
import { RoleSchema } from '@truepath/shared';

// One fetch wrapper for every Core API call (dashboard.md §2.2): credentials included, JSON only,
// zod-parsed responses so a contract drift fails loudly instead of rendering wrong numbers. Tokens
// are never read or stored here — the session lives entirely in the httpOnly `tp_session` cookie
// (auth-tenancy.md §4.1); this file never touches localStorage/sessionStorage for anything but the
// caller's own non-sensitive UI preferences (handled elsewhere, not here).

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly fields?: readonly string[],
    readonly data?: Readonly<Record<string, unknown>>,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

/** True once for a 401 — callers redirect to /login rather than rendering a 401 error state. */
export class UnauthenticatedError extends ApiError {
  constructor() {
    super(401, 'unauthenticated');
    this.name = 'UnauthenticatedError';
  }
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly query?: Record<string, string | number | undefined>;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(path, API_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/**
 * Raw request: real CSRF-relevant headers on every state-changing call (Origin comes from the
 * browser itself, never set manually — app.ts's CSRF hook checks the browser's own Origin header).
 * A body-less state-changing request (e.g. logout) still sends `{}` with an explicit JSON
 * Content-Type, matching what the API's CSRF check requires (auth-tenancy.md §4.1).
 */
async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const method = options.method ?? 'GET';
  const hasBody = method !== 'GET';
  return fetch(buildUrl(path, options.query), {
    method,
    credentials: 'include',
    headers: hasBody ? { 'content-type': 'application/json' } : {},
    body: hasBody ? JSON.stringify(options.body ?? {}) : undefined,
  });
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  if (response.status === 401) return new UnauthenticatedError();
  let code = response.status === 404 ? 'not_found' : 'unknown_error';
  let fields: readonly string[] | undefined;
  let data: Record<string, unknown> | undefined;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object') {
      data = body as Record<string, unknown>;
      if ('error' in body && typeof body.error === 'string') code = body.error;
      if ('fields' in body && Array.isArray((body as { fields: unknown }).fields)) {
        fields = (body as { fields: string[] }).fields;
      }
    }
  } catch {
    // Non-JSON error body (e.g. a proxy's own HTML error page) — the status code alone still
    // distinguishes forbidden/not-found/rate-limited from a generic failure.
  }
  return new ApiError(response.status, code, fields, data);
}

/** Parses a JSON response with `schema`; throws {@link ApiError} on any non-2xx or a schema mismatch. */
async function fetchAndParse<T>(
  path: string,
  schema: z.ZodType<T>,
  options?: RequestOptions,
): Promise<T> {
  const response = await request(path, options);
  if (!response.ok) throw await errorFromResponse(response);
  const json: unknown = await response.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`apiFetch: response for ${path} did not match the expected shape`);
  }
  return parsed.data;
}

/** Same as {@link fetchAndParse} but for endpoints with no useful response body (204, or ignored). */
async function fetchVoid(path: string, options?: RequestOptions): Promise<void> {
  const response = await request(path, options);
  if (!response.ok) throw await errorFromResponse(response);
}

// ---- Schemas (dashboard.md §2.2: parsed with zod so a contract drift fails loudly) -------------

const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean().optional(),
  image: z.string().nullable().optional(),
});
export type User = z.infer<typeof UserSchema>;

const MembershipSchema = z.object({ organizationId: z.string(), role: RoleSchema });
export type Membership = z.infer<typeof MembershipSchema>;

const MeSchema = z.object({
  user: UserSchema,
  memberships: z.array(MembershipSchema),
});
export type Me = z.infer<typeof MeSchema>;

const OrganizationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string().nullable().optional(),
    plan: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
  })
  .passthrough();
export type Organization = z.infer<typeof OrganizationSchema>;

const StoreSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  platform: z.string(),
  shopDomain: z.string(),
  currency: z.string(),
  timezone: z.string(),
  installedAt: z.string().nullable(),
  status: z.string(),
  childDirected: z.boolean(),
  retentionMonths: z.number(),
});
export type Store = z.infer<typeof StoreSchema>;

const IntegrationSchema = z.object({
  id: z.string(),
  provider: z.string(),
  status: z.string(),
  external_account_id: z.string().nullable(),
  scopes: z.array(z.string()),
  last_synced_at: z.string().nullable(),
  error: z.string().nullable(),
});
export type Integration = z.infer<typeof IntegrationSchema>;

const AuditEntrySchema = z.object({
  id: z.string(),
  action: z.string(),
  actor_type: z.string(),
  actor_user_id: z.string().nullable(),
  target_type: z.string(),
  target_id: z.string(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

const AuditLogPageSchema = z.object({
  items: z.array(AuditEntrySchema),
  next_cursor: z.string().nullable(),
});
export type AuditLogPage = z.infer<typeof AuditLogPageSchema>;

const InviteSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: RoleSchema,
  status: z.string().optional(),
});
export type Invite = z.infer<typeof InviteSchema>;

const MemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: RoleSchema,
});
export type OrgMember = z.infer<typeof MemberSchema>;

const AcceptInviteResultSchema = z.object({
  invitation: z.object({ id: z.string(), organizationId: z.string() }).passthrough(),
});

const DpaAcceptResponseSchema = z.object({
  id: z.string(),
  dpa_version: z.string(),
  accepted_at: z.string(),
});
export type DpaAcceptResponse = z.infer<typeof DpaAcceptResponseSchema>;

// ---- Calls ---------------------------------------------------------------------------------

export const api = {
  me: () => fetchAndParse('/v1/me', MeSchema),

  signup: (body: { email: string; password: string; name: string }) =>
    fetchVoid('/v1/auth/signup', { method: 'POST', body }),

  login: (body: { email: string; password: string }) =>
    fetchVoid('/v1/auth/login', { method: 'POST', body }),

  logout: () => fetchVoid('/v1/auth/logout', { method: 'POST', body: {} }),

  listOrgs: () =>
    fetchAndParse('/v1/orgs', z.object({ organizations: z.array(OrganizationSchema) })),

  createOrg: (body: { name: string; slug: string }) =>
    fetchAndParse('/v1/orgs', OrganizationSchema, { method: 'POST', body }),

  listStores: (orgId: string) =>
    fetchAndParse(`/v1/orgs/${orgId}/stores`, z.object({ stores: z.array(StoreSchema) })),

  listStoreIntegrations: (storeId: string) =>
    fetchAndParse(
      `/v1/stores/${storeId}/integrations`,
      z.object({ integrations: z.array(IntegrationSchema) }),
    ),

  disconnectIntegration: (orgId: string, integrationId: string) =>
    fetchVoid(`/v1/orgs/${orgId}/integrations/${integrationId}`, { method: 'DELETE' }),

  shopifyConnectUrl: (orgId: string, shop: string) =>
    buildUrl(`/v1/orgs/${orgId}/integrations/shopify/connect`, { shop }),

  listAuditLog: (
    orgId: string,
    query: { from?: string; to?: string; action?: string; cursor?: string; limit?: number } = {},
  ) => fetchAndParse(`/v1/orgs/${orgId}/audit-log`, AuditLogPageSchema, { query }),

  acceptDpa: (orgId: string, dpaVersion: string) =>
    fetchAndParse(`/v1/orgs/${orgId}/dpa/accept`, DpaAcceptResponseSchema, {
      method: 'POST',
      body: { dpa_version: dpaVersion },
    }),

  listMembers: (orgId: string) =>
    fetchAndParse(`/v1/orgs/${orgId}/members`, z.object({ members: z.array(MemberSchema) })),

  createInvite: (orgId: string, body: { email: string; role: string }) =>
    fetchAndParse(`/v1/orgs/${orgId}/invites`, InviteSchema, { method: 'POST', body }),

  acceptInvite: (token: string) =>
    fetchAndParse(`/v1/invites/${token}/accept`, AcceptInviteResultSchema, { method: 'POST' }),

  updateMemberRole: (orgId: string, userId: string, role: string) =>
    fetchVoid(`/v1/orgs/${orgId}/members/${userId}`, { method: 'PUT', body: { role } }),

  removeMember: (orgId: string, userId: string) =>
    fetchVoid(`/v1/orgs/${orgId}/members/${userId}`, { method: 'DELETE' }),
};
