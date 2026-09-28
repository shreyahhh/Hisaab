import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { z } from 'zod';
import { Toaster } from '@/components/ui/sonner';
import { UnauthenticatedError, type Me } from '@/lib/api';
import { queryClient } from '@/lib/queryClient';
import { lastRememberedOrg, meQueryKey } from '@/lib/session';
import { api } from '@/lib/api';
import { LoginPage } from '@/pages/login';
import { SignupPage } from '@/pages/signup';
import { InviteAcceptPage } from '@/pages/invite-accept';
import { NewOrgPage } from '@/pages/new-org';
import { StoreConnectedPage } from '@/pages/store-connected';
import { OrgLayout } from '@/pages/org-layout';
import { OverviewPage } from '@/pages/overview';
import { TeamPage } from '@/pages/team';
import { IntegrationsPage } from '@/pages/integrations';
import { AuditLogPage } from '@/pages/audit-log';
import { DpaPage } from '@/pages/dpa';
import {
  AnalyticsPlaceholderPage,
  AttributionPlaceholderPage,
  OrdersPlaceholderPage,
} from '@/pages/placeholders';

const rootRoute = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <Toaster />
    </>
  ),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'login',
  validateSearch: z.object({ redirect: z.string().optional() }),
  component: LoginPage,
});

const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'signup',
  component: SignupPage,
});

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'invite/$token',
  component: () => <InviteAcceptPage token={inviteRoute.useParams().token} />,
});

/** Every route under here requires a session (dashboard.md §5: 401 → login, keeping the intended route). */
const authedRoute = createRoute({
  id: 'authed',
  getParentRoute: () => rootRoute,
  beforeLoad: async ({ location }) => {
    try {
      await queryClient.ensureQueryData<Me>({ queryKey: meQueryKey, queryFn: api.me });
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        throw redirect({ to: '/login', search: { redirect: location.href } });
      }
      throw error;
    }
  },
  component: Outlet,
});

const indexRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/',
  beforeLoad: async () => {
    const me = await queryClient.ensureQueryData<Me>({ queryKey: meQueryKey, queryFn: api.me });
    if (me.memberships.length === 0) {
      throw redirect({ to: '/orgs/new' });
    }
    const remembered = lastRememberedOrg();
    const orgId =
      remembered && me.memberships.some((m) => m.organizationId === remembered)
        ? remembered
        : me.memberships[0]!.organizationId;
    throw redirect({ to: '/o/$orgId', params: { orgId } });
  },
});

const newOrgRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: 'orgs/new',
  component: NewOrgPage,
});

const storeConnectedRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: 'stores/$storeId/connected',
  component: () => <StoreConnectedPage storeId={storeConnectedRoute.useParams().storeId} />,
});

const orgRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: 'o/$orgId',
  component: () => <OrgLayout orgId={orgRoute.useParams().orgId} />,
});

const orgIndexRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: '/',
  component: () => <OverviewPage orgId={orgRoute.useParams().orgId} />,
});

const teamRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'team',
  component: () => <TeamPage orgId={orgRoute.useParams().orgId} />,
});

const integrationsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'integrations',
  component: () => <IntegrationsPage orgId={orgRoute.useParams().orgId} />,
});

const auditLogRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'audit-log',
  component: () => <AuditLogPage orgId={orgRoute.useParams().orgId} />,
});

const dpaRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'dpa',
  component: () => <DpaPage orgId={orgRoute.useParams().orgId} />,
});

const analyticsRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'analytics',
  component: AnalyticsPlaceholderPage,
});

const attributionRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'attribution',
  component: AttributionPlaceholderPage,
});

const ordersRoute = createRoute({
  getParentRoute: () => orgRoute,
  path: 'orders',
  component: OrdersPlaceholderPage,
});

const orgRouteWithChildren = orgRoute.addChildren([
  orgIndexRoute,
  teamRoute,
  integrationsRoute,
  auditLogRoute,
  dpaRoute,
  analyticsRoute,
  attributionRoute,
  ordersRoute,
]);

const authedRouteWithChildren = authedRoute.addChildren([
  indexRoute,
  newOrgRoute,
  storeConnectedRoute,
  orgRouteWithChildren,
]);

const routeTree = rootRoute.addChildren([
  loginRoute,
  signupRoute,
  inviteRoute,
  authedRouteWithChildren,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
