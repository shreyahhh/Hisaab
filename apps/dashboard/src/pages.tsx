import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import {
  api,
  ApiError,
  type AuditLogEntry,
  type ChannelRule,
  type ConsentStats,
  type DsrRequestsResponse,
  type IntegrationRow,
  type JourneyResponse,
  type Me,
  type OrderRow,
  type Organization,
  type Store,
  type SystemStatus,
  type TrackingSummary,
} from './api';

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
function money(paise: number): string {
  return inr.format(paise / 100);
}

/** "20260929" (the tracking summary's IST day bucket) -> "2026-09-29". */
function formatDay(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

// ---- Shared bits --------------------------------------------------------------------------

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="empty">{children}</p>;
}

function useMe() {
  return useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get('/v1/me'),
    retry: false,
  });
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

// ---- Login / signup ------------------------------------------------------------------------

export function LoginPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('demo@truepath.local');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: async () => {
      if (mode === 'signup') {
        await api.post('/v1/auth/signup', { email, password, name });
      } else {
        await api.post('/v1/auth/login', { email, password });
      }
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['me'] });
      await navigate({ to: '/' });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? `${mode} failed (${err.status})` : String(err));
    },
  });

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>TruePath</h1>
        <p className="muted">
          Sign in to see delivered ROAS and everything the pipeline has captured.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            submit.mutate();
          }}
        >
          <label>
            Email
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
          </label>
          <label>
            Password
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              required
              minLength={8}
            />
          </label>
          {mode === 'signup' && (
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
          )}
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={submit.isPending}>
            {mode === 'login' ? 'Log in' : 'Sign up'}
          </button>
        </form>
        <button className="link" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
          {mode === 'login' ? 'Need an account? Sign up' : 'Have an account? Log in'}
        </button>
        <p className="muted small">
          Demo credentials (after running <code>pnpm dev:seed</code>): demo@truepath.local
        </p>
      </div>
    </div>
  );
}

// ---- Layout: guards the session, resolves org + store, renders nav --------------------------

const NAV = [
  { label: 'Integrations', path: 'integrations' },
  { label: 'Orders', path: 'orders' },
  { label: 'Tracking', path: 'tracking' },
  { label: 'Journeys', path: 'journeys' },
  { label: 'Privacy', path: 'privacy' },
  { label: 'Settings', path: 'settings' },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const me = useMe();
  const params = useParams({ strict: false }) as { storeId?: string };

  const orgs = useQuery<{ organizations: Organization[] }>({
    queryKey: ['orgs'],
    queryFn: () => api.get('/v1/orgs'),
    enabled: !!me.data,
  });
  const organizationId = orgs.data?.organizations[0]?.id;

  const stores = useQuery<{ stores: Store[] }>({
    queryKey: ['stores', organizationId],
    queryFn: () => api.get(`/v1/orgs/${organizationId}/stores`),
    enabled: !!organizationId,
  });
  const store = stores.data?.stores[0];

  const logout = useMutation({
    mutationFn: () => api.post('/v1/auth/logout'),
    onSuccess: () => navigate({ to: '/login' }),
  });

  if (me.isLoading) return <p className="page-loading">Loading…</p>;
  if (me.isError) {
    if (isUnauthorized(me.error)) {
      if (typeof window !== 'undefined') void navigate({ to: '/login' });
      return null;
    }
    return <Empty>Could not reach the API at the configured VITE_API_URL — is it running?</Empty>;
  }

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">TruePath</span>
        <span className="muted">{me.data?.user.email}</span>
        <button className="link" onClick={() => logout.mutate()}>
          Log out
        </button>
      </header>
      <div className="body">
        <nav className="sidenav">
          <a
            className={!params.storeId ? 'active' : ''}
            href="/system"
            onClick={(e) => {
              e.preventDefault();
              void navigate({ to: '/system' });
            }}
          >
            System status
          </a>
          {!organizationId && orgs.isSuccess && (
            <p className="empty small">
              No organization yet — there's no onboarding wizard UI until M3-4; run{' '}
              <code>pnpm dev:seed</code> for a demo one, or create it directly via{' '}
              <code>POST /v1/orgs</code>.
            </p>
          )}
          {organizationId && !store && stores.isSuccess && (
            <p className="empty small">
              No store connected yet. Live Shopify install needs a public tunnel + approved Partner
              app (see BLOCKERS.md #1). Run <code>pnpm dev:seed</code> for a demo store.
            </p>
          )}
          {store &&
            NAV.map((item) => {
              const href = `/stores/${store.id}/${item.path}`;
              const active = typeof window !== 'undefined' && window.location.pathname === href;
              return (
                <a
                  key={item.path}
                  className={active ? 'active' : ''}
                  href={href}
                  onClick={(e) => {
                    e.preventDefault();
                    void navigate({ to: href });
                  }}
                >
                  {item.label}
                </a>
              );
            })}
        </nav>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

export function HomeRedirect() {
  const navigate = useNavigate();
  const me = useMe();
  const orgs = useQuery<{ organizations: Organization[] }>({
    queryKey: ['orgs'],
    queryFn: () => api.get('/v1/orgs'),
    enabled: !!me.data,
  });
  const organizationId = orgs.data?.organizations[0]?.id;
  const stores = useQuery<{ stores: Store[] }>({
    queryKey: ['stores', organizationId],
    queryFn: () => api.get(`/v1/orgs/${organizationId}/stores`),
    enabled: !!organizationId,
  });
  const store = stores.data?.stores[0];

  if (me.isError && isUnauthorized(me.error)) {
    void navigate({ to: '/login' });
    return null;
  }
  if (store) {
    void navigate({ to: `/stores/${store.id}/integrations` });
    return null;
  }
  if (stores.isSuccess || (orgs.isSuccess && !organizationId)) {
    return (
      <AppShell>
        <Empty>{organizationId ? 'No store connected yet.' : 'No organization yet.'}</Empty>
      </AppShell>
    );
  }
  return <p className="page-loading">Loading…</p>;
}

// ---- Integrations --------------------------------------------------------------------------

export function IntegrationsPage() {
  const { storeId } = useParams({ from: '/stores/$storeId/integrations' });
  const q = useQuery<{ integrations: IntegrationRow[] }>({
    queryKey: ['integrations', storeId],
    queryFn: () => api.get(`/v1/stores/${storeId}/integrations`),
  });

  return (
    <AppShell>
      <h1>Integrations</h1>
      {q.isLoading && <p>Loading…</p>}
      {q.isError && <Empty>Could not load integrations ({(q.error as ApiError).status}).</Empty>}
      {q.data && (
        <>
          {['shopify', 'meta', 'shiprocket'].map((provider) => {
            const row = q.data!.integrations.find((i) => i.provider === provider);
            return (
              <section key={provider} className="card">
                <h2>
                  {provider === 'shopify' ? 'Shopify' : provider === 'meta' ? 'Meta' : 'Shiprocket'}
                </h2>
                {!row && provider === 'shiprocket' && <Empty>Coming in M2 — not built yet.</Empty>}
                {!row && provider === 'meta' && (
                  <Empty>
                    Not connected. Only the M1-8 warm-up slice exists so far (a CLI-registered
                    read-only insights pull), no OAuth connect UI yet.
                  </Empty>
                )}
                {!row && provider === 'shopify' && (
                  <Empty>
                    Not connected. Live install needs a public tunnel + approved Partner app
                    (BLOCKERS.md #1/#2) — run <code>pnpm dev:seed</code> for a demo connection.
                  </Empty>
                )}
                {row && (
                  <dl>
                    <dt>Status</dt>
                    <dd>{row.status}</dd>
                    <dt>Scopes</dt>
                    <dd>{row.scopes.join(', ') || '—'}</dd>
                    <dt>Connected</dt>
                    <dd>
                      {row.connected_at ? new Date(row.connected_at).toLocaleString('en-IN') : '—'}
                    </dd>
                    {row.error && (
                      <>
                        <dt>Error</dt>
                        <dd className="error">{row.error}</dd>
                      </>
                    )}
                    {provider === 'shopify' && typeof row.settings['backfill'] === 'object' && (
                      <>
                        <dt>Backfill</dt>
                        <dd>{JSON.stringify(row.settings['backfill'])}</dd>
                      </>
                    )}
                    {provider === 'meta' && typeof row.settings['warmup'] === 'object' && (
                      <>
                        <dt>Warm-up ledger</dt>
                        <dd>{JSON.stringify(row.settings['warmup'])}</dd>
                      </>
                    )}
                  </dl>
                )}
              </section>
            );
          })}
        </>
      )}
    </AppShell>
  );
}

// ---- Orders --------------------------------------------------------------------------------

export function OrdersPage() {
  const { storeId } = useParams({ from: '/stores/$storeId/orders' });
  const navigate = useNavigate();
  const q = useQuery<{ orders: OrderRow[] }>({
    queryKey: ['orders', storeId],
    queryFn: () => api.get(`/v1/stores/${storeId}/orders`),
  });

  return (
    <AppShell>
      <h1>Orders</h1>
      {q.isLoading && <p>Loading…</p>}
      {q.data && q.data.orders.length === 0 && (
        <Empty>
          No orders yet for this store — connect Shopify, or run `pnpm dev:seed` for demo orders.
        </Empty>
      )}
      {q.data && q.data.orders.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Placed</th>
              <th>Total</th>
              <th>Payment</th>
              <th>Delivery</th>
              <th>Matched?</th>
              <th>Phone/email hash</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {q.data.orders.map((o) => (
              <tr key={o.id}>
                <td>{o.external_order_id}</td>
                <td>{new Date(o.created_at_platform).toLocaleString('en-IN')}</td>
                <td>{money(o.total_amount_paise)}</td>
                <td>{o.payment_method}</td>
                <td>{o.delivery_status}</td>
                <td>{o.visitor_matched ? `yes (${o.attribution_confidence ?? '—'})` : 'no'}</td>
                <td>
                  {o.phone_hash_present ? 'phone ' : ''}
                  {o.email_hash_present ? 'email' : ''}
                  {!o.phone_hash_present && !o.email_hash_present ? '—' : ''}
                </td>
                <td>
                  <button
                    className="link"
                    onClick={() =>
                      navigate({
                        to: `/stores/${storeId}/journeys`,
                        search: { orderId: o.id } as never,
                      })
                    }
                  >
                    View journey
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </AppShell>
  );
}

// ---- Tracking ------------------------------------------------------------------------------

export function TrackingPage() {
  const { storeId } = useParams({ from: '/stores/$storeId/tracking' });
  const q = useQuery<TrackingSummary>({
    queryKey: ['tracking', storeId],
    queryFn: () => api.get(`/v1/stores/${storeId}/tracking/summary?days=14`),
  });

  return (
    <AppShell>
      <h1>Tracking</h1>
      {q.isLoading && <p>Loading…</p>}
      {q.data && (
        <>
          <section className="card-row">
            <div className="stat">
              <span className="stat-value">{q.data.events_total}</span>
              <span className="stat-label">events (last {q.data.window_days}d)</span>
            </div>
            <div className="stat">
              <span className="stat-value">{q.data.unique_visitors}</span>
              <span className="stat-label">unique visitors</span>
            </div>
            <div className="stat">
              <span className="stat-value">{q.data.unique_sessions}</span>
              <span className="stat-label">sessions</span>
            </div>
            <div className="stat">
              <span className="stat-value">{q.data.consent.accepted}</span>
              <span className="stat-label">consent accepted</span>
            </div>
            <div className="stat">
              <span className="stat-value">{q.data.consent.dropped}</span>
              <span className="stat-label">dropped (no consent, etc.)</span>
            </div>
          </section>

          <section className="card">
            <h2>Events per day</h2>
            {q.data.events_per_day.length === 0 ? (
              <Empty>
                No events yet — the pixel isn't deployed live (issue #43); run `pnpm dev:seed`.
              </Empty>
            ) : (
              <div className="bars">
                {q.data.events_per_day.map((d) => (
                  <div key={d.day} className="bar-row">
                    <span className="bar-label">{formatDay(d.day)}</span>
                    <div className="bar-track">
                      <div
                        className="bar-fill"
                        style={{
                          width: `${Math.max(4, (d.count / Math.max(...q.data!.events_per_day.map((x) => x.count))) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="bar-value">{d.count}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card">
            <h2>Touchpoints by channel</h2>
            {q.data.touchpoints_by_channel.length === 0 ? (
              <Empty>No touchpoints yet.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th>Touchpoints</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.touchpoints_by_channel.map((c) => (
                    <tr key={c.channel}>
                      <td>{c.channel}</td>
                      <td>{c.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {q.data.consent.dropped > 0 && (
            <section className="card">
              <h2>Drop reasons</h2>
              <table>
                <tbody>
                  {Object.entries(q.data.consent.drop_reasons).map(([reason, n]) => (
                    <tr key={reason}>
                      <td>{reason}</td>
                      <td>{n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </AppShell>
  );
}

// ---- Journeys ------------------------------------------------------------------------------

export function JourneysPage() {
  const { storeId } = useParams({ from: '/stores/$storeId/journeys' });
  const [orderId, setOrderId] = useState('');
  const orders = useQuery<{ orders: OrderRow[] }>({
    queryKey: ['orders', storeId],
    queryFn: () => api.get(`/v1/stores/${storeId}/orders`),
  });
  const journey = useQuery<JourneyResponse>({
    queryKey: ['journey', storeId, orderId],
    queryFn: () => api.get(`/v1/stores/${storeId}/orders/${orderId}/journey`),
    enabled: !!orderId,
  });

  return (
    <AppShell>
      <h1>Journeys</h1>
      {orders.data && orders.data.orders.length === 0 && <Empty>No orders yet to look up.</Empty>}
      {orders.data && orders.data.orders.length > 0 && (
        <label>
          Order
          <select value={orderId} onChange={(e) => setOrderId(e.target.value)}>
            <option value="">Select an order…</option>
            {orders.data.orders.map((o) => (
              <option key={o.id} value={o.id}>
                {o.external_order_id} {o.visitor_matched ? '(matched)' : '(unmatched)'}
              </option>
            ))}
          </select>
        </label>
      )}
      {orderId && journey.isError && (
        <Empty>
          {journey.error instanceof ApiError && journey.error.status === 403
            ? 'Journey view needs the analyst role or above.'
            : 'Could not load this journey.'}
        </Empty>
      )}
      {journey.data && !journey.data.visitor_matched && (
        <Empty>
          This order has no matched visitor — no pixel touchpoints to show (identity-stitch never
          linked it, or it fell back to a UTM-only match).
        </Empty>
      )}
      {journey.data && journey.data.visitor_matched && journey.data.touchpoints.length === 0 && (
        <Empty>Matched to a visitor, but no touchpoints exist for them yet.</Empty>
      )}
      {journey.data && journey.data.touchpoints.length > 0 && (
        <ol className="journey">
          {journey.data.touchpoints.map((tp, i) => (
            <li key={i}>
              <span className="journey-time">
                {new Date(tp.occurred_at).toLocaleString('en-IN')}
              </span>
              <span className="journey-channel">{tp.channel}</span>
              {tp.platform && <span className="muted"> · {tp.platform}</span>}
              {tp.campaign_id && <span className="muted"> · campaign {tp.campaign_id}</span>}
              {tp.is_direct && tp.channel !== 'direct' && <span className="muted"> · direct</span>}
            </li>
          ))}
        </ol>
      )}
    </AppShell>
  );
}

// ---- Privacy -------------------------------------------------------------------------------

export function PrivacyPage() {
  const { storeId } = useParams({ from: '/stores/$storeId/privacy' });
  const stats = useQuery<ConsentStats>({
    queryKey: ['consent-stats', storeId],
    queryFn: () => api.get(`/v1/stores/${storeId}/privacy/consent-stats`),
  });
  const requests = useQuery<DsrRequestsResponse>({
    queryKey: ['dsr-requests', storeId],
    queryFn: () => api.get(`/v1/stores/${storeId}/privacy/requests`),
  });

  const forbidden =
    (stats.error instanceof ApiError && stats.error.status === 403) ||
    (requests.error instanceof ApiError && requests.error.status === 403);
  if (forbidden) {
    return (
      <AppShell>
        <h1>Privacy</h1>
        <Empty>Privacy data needs the admin or owner role.</Empty>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <h1>Privacy</h1>
      <section className="card">
        <h2>Consent</h2>
        {stats.isLoading && <p>Loading…</p>}
        {stats.data && (
          <>
            <p>Suppressed identities: {stats.data.suppressed_identities_count}</p>
            {stats.data.consent_records_recent.length === 0 ? (
              <Empty>No consent events recorded yet.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>State</th>
                    <th>Purposes</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.data.consent_records_recent.map((r, i) => (
                    <tr key={i}>
                      <td>{new Date(r.occurred_at).toLocaleString('en-IN')}</td>
                      <td>{r.state}</td>
                      <td>{r.purposes.join(', ') || '—'}</td>
                      <td>{r.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>
      <section className="card">
        <h2>Data subject requests</h2>
        {requests.data && (
          <>
            <p className="muted small">{requests.data.note}</p>
            {requests.data.requests.length === 0 ? (
              <Empty>No DSR requests queued.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Due</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.data.requests.map((r) => (
                    <tr key={r.id}>
                      <td>{r.type}</td>
                      <td>{r.status}</td>
                      <td>{new Date(r.created_at).toLocaleString('en-IN')}</td>
                      <td>{new Date(r.due_at).toLocaleString('en-IN')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </section>
    </AppShell>
  );
}

// ---- Settings ------------------------------------------------------------------------------

export function SettingsPage() {
  const { storeId } = useParams({ from: '/stores/$storeId/settings' });
  const me = useMe();
  const orgs = useQuery<{ organizations: Organization[] }>({
    queryKey: ['orgs'],
    queryFn: () => api.get('/v1/orgs'),
    enabled: !!me.data,
  });
  const organizationId = orgs.data?.organizations[0]?.id;
  const rules = useQuery<{ channel_rules: ChannelRule[] }>({
    queryKey: ['channel-rules', storeId],
    queryFn: () => api.get(`/v1/stores/${storeId}/channel-rules`),
  });
  const audit = useQuery<{ items: AuditLogEntry[] }>({
    queryKey: ['audit-log', organizationId],
    queryFn: () => api.get(`/v1/orgs/${organizationId}/audit-log?limit=20`),
    enabled: !!organizationId,
  });

  return (
    <AppShell>
      <h1>Settings</h1>
      <section className="card">
        <h2>Channel rules</h2>
        {rules.data && rules.data.channel_rules.length === 0 && (
          <Empty>
            No custom channel rules configured — using the built-in default classification (SPEC
            §7.4).
          </Empty>
        )}
        {rules.data && rules.data.channel_rules.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Priority</th>
                <th>Channel</th>
                <th>Sub-channel</th>
              </tr>
            </thead>
            <tbody>
              {rules.data.channel_rules.map((r) => (
                <tr key={r.id}>
                  <td>{r.priority}</td>
                  <td>{r.channel}</td>
                  <td>{r.sub_channel ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card">
        <h2>Audit log (latest 20)</h2>
        {audit.isError && <Empty>Needs the admin or owner role to view.</Empty>}
        {audit.data && audit.data.items.length === 0 && <Empty>No audited actions yet.</Empty>}
        {audit.data && audit.data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.items.map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.created_at).toLocaleString('en-IN')}</td>
                  <td>{e.action}</td>
                  <td>
                    {e.target_type}:{e.target_id}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </AppShell>
  );
}

// ---- System status --------------------------------------------------------------------------

export function SystemPage() {
  const q = useQuery<SystemStatus>({
    queryKey: ['system-status'],
    queryFn: () => api.get('/v1/system/status'),
    refetchInterval: 10_000,
  });

  return (
    <AppShell>
      <h1>System status</h1>
      {q.isLoading && <p>Loading…</p>}
      {q.data && (
        <>
          <section className="card-row">
            <div className="stat">
              <span className="stat-value">{q.data.api}</span>
              <span className="stat-label">API</span>
            </div>
            <div className="stat">
              <span className="stat-value">
                {q.data.suppress_ready_at
                  ? new Date(q.data.suppress_ready_at).toLocaleTimeString('en-IN')
                  : 'not ready'}
              </span>
              <span className="stat-label">suppress:ready</span>
            </div>
            <div className="stat">
              <span className="stat-value">{q.data.stream_events_raw_length ?? '—'}</span>
              <span className="stat-label">stream:events-raw length</span>
            </div>
            <div className="stat">
              <span className="stat-value">{q.data.stream_events_dead_length ?? '—'}</span>
              <span className="stat-label">stream:events-dead length</span>
            </div>
          </section>
          <section className="card">
            <h2>Queues</h2>
            <table>
              <thead>
                <tr>
                  <th>Queue</th>
                  <th>Waiting</th>
                  <th>Active</th>
                  <th>Failed</th>
                </tr>
              </thead>
              <tbody>
                {q.data.queues.map((qu) => (
                  <tr key={qu.name}>
                    <td>{qu.name}</td>
                    <td>{qu.waiting ?? '—'}</td>
                    <td>{qu.active ?? '—'}</td>
                    <td>{qu.failed ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <p className="muted small">
            Not shown, no worker yet: ad-sync-google-ads, shiprocket-sync, attribution-run's
            consumer, capi-dispatch, order-status-reconcile, retention (M2+).
          </p>
        </>
      )}
    </AppShell>
  );
}
