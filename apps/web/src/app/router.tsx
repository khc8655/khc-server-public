import type { QueryClient } from '@tanstack/react-query';
import {
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  useRouterState,
  type RouterHistory,
} from '@tanstack/react-router';
import { meQueryOptions } from '../data/queries';
import AppShell from './AppShell';
import LoginPage from '../pages/LoginPage';
import OverviewPage from '../pages/OverviewPage';
import HubsPage from '../pages/HubsPage';
import HubOverviewPage from '../pages/HubOverviewPage';
import HubOpsPage from '../pages/HubOpsPage';
import AppPage from '../pages/AppPage';
import WireGuardPage from '../apps/wireguard/page';
import SitesPage from '../apps/caddy/page';
import SettingsPage from '../pages/SettingsPage';
import HubSettingsPage from '../apps/node-settings/page';
import { NotFoundPage } from '../pages/GlobalPages';
import GalleryPage from '../dev/gallery/GalleryPage';

export interface RouterContext {
  queryClient: QueryClient;
}

/** 登录页与组件样例页不套外壳；其余页面统一使用 AppShell。 */
function RootLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  if (pathname === '/login' || pathname.startsWith('/dev/gallery')) return <Outlet />;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

async function requireSession({ context }: { context: RouterContext }) {
  try {
    await context.queryClient.ensureQueryData(meQueryOptions());
  } catch {
    throw redirect({ to: '/login' });
  }
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: OverviewPage,
  beforeLoad: requireSession,
});

const hubsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/hubs',
  component: HubsPage,
  beforeLoad: requireSession,
  validateSearch: (search: Record<string, unknown>): { create?: boolean } => ({
    create: search.create === true || search.create === '1' || search.create === 'true' ? true : undefined,
  }),
});

const hubOverviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/hubs/$hubId',
  component: HubOverviewPage,
  beforeLoad: requireSession,
});

// 暗路由过渡（ui-redesign ⑤）：应用列表已并入站点页「扩展应用」分段。
// 采用 302 重定向而非直接删除，避免书签/外链 404；确认无引用后可在后续版本移除。
const hubAppsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/hubs/$hubId/apps',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/hubs/$hubId/sites', params });
  },
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/hubs/$hubId/apps/$app',
  component: AppPage,
  beforeLoad: requireSession,
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
});

const hubWireguardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/hubs/$hubId/wireguard',
  component: WireGuardPage,
  beforeLoad: requireSession,
  validateSearch: (search: Record<string, unknown>): { drawer?: string } => ({
    drawer: typeof search.drawer === 'string' ? search.drawer : undefined,
  }),
});

// 暗路由过渡（ui-redesign ④）：/peers、/forwards 已并入内网穿透页。
// 采用 302 重定向而非直接删除，避免书签/外链 404；确认无引用后可在后续版本移除。
const hubPeersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/hubs/$hubId/peers',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/hubs/$hubId/wireguard', params });
  },
});

const hubOpsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/hubs/$hubId/ops',
  component: HubOpsPage,
  beforeLoad: requireSession,
});

const hubSitesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/hubs/$hubId/sites',
  component: SitesPage,
  beforeLoad: requireSession,
  validateSearch: (search: Record<string, unknown>): {
    drawer?: string;
    upstream?: string;
    peer?: string;
    tab?: string;
  } => ({
    drawer: typeof search.drawer === 'string' ? search.drawer : undefined,
    upstream: typeof search.upstream === 'string' ? search.upstream : undefined,
    peer: typeof search.peer === 'string' ? search.peer : undefined,
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
});

const hubForwardsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/hubs/$hubId/forwards',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/hubs/$hubId/wireguard', params });
  },
});

// 暗路由过渡（ui-redesign ⑤）：节点证书页已并入站点页「证书」只读分段。
// 采用 302 重定向而非直接删除，避免书签/外链 404；确认无引用后可在后续版本移除。
const hubCertsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/hubs/$hubId/certs',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/hubs/$hubId/sites', params });
  },
});

const hubSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/hubs/$hubId/settings',
  component: HubSettingsPage,
  beforeLoad: requireSession,
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
  beforeLoad: requireSession,
  validateSearch: (search: Record<string, unknown>): { tab?: string; drawer?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
    drawer: typeof search.drawer === 'string' ? search.drawer : undefined,
  }),
});

// 暗路由过渡（ui-redesign 路由总表 #6）：全局证书页已并入设置页「证书」Tab。
// 采用 302 重定向而非直接删除，避免书签/外链 404；确认无引用后可在后续版本移除。
const certsRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/certs',
  beforeLoad: () => {
    throw redirect({ to: '/settings', search: { tab: 'certs' } });
  },
});

const galleryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dev/gallery',
  component: GalleryPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  indexRoute,
  hubsRoute,
  hubOverviewRoute,
  hubAppsRoute,
  appRoute,
  hubWireguardRoute,
  hubPeersRoute,
  hubOpsRoute,
  hubSitesRoute,
  hubForwardsRoute,
  hubCertsRoute,
  hubSettingsRoute,
  settingsRoute,
  certsRedirectRoute,
  galleryRoute,
]);

export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    ...(history ? { history } : {}),
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
