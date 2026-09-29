import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';
import {
  HomeRedirect,
  IntegrationsPage,
  JourneysPage,
  LoginPage,
  OrdersPage,
  PrivacyPage,
  SettingsPage,
  SystemPage,
  TrackingPage,
} from './pages';

const rootRoute = createRootRoute({ component: () => <Outlet /> });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomeRedirect,
});
const systemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/system',
  component: SystemPage,
});

const integrationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/stores/$storeId/integrations',
  component: IntegrationsPage,
});
const ordersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/stores/$storeId/orders',
  component: OrdersPage,
});
const trackingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/stores/$storeId/tracking',
  component: TrackingPage,
});
const journeysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/stores/$storeId/journeys',
  component: JourneysPage,
});
const privacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/stores/$storeId/privacy',
  component: PrivacyPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/stores/$storeId/settings',
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  systemRoute,
  integrationsRoute,
  ordersRoute,
  trackingRoute,
  journeysRoute,
  privacyRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
