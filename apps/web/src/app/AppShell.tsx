import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useRouterState } from '@tanstack/react-router';
import type { IconName } from '../ui/icons';
import {
  CommandPalette,
  HubBar,
  Sidebar,
  ToastContextProvider,
  ToastHost,
  Topbar,
  type Crumb,
  type SidebarHub,
  type SidebarNavItem,
  type ToastState,
} from '../ui';
import {
  hubsQueryOptions,
  hubQueryOptions,
  meQueryOptions,
} from '../data/queries';
import { logout } from '../data/auth';
import { getAppMeta } from '../apps/registry';
import {
  matchHubPath,
  paths,
  sectionTitleKey,
} from '../registry/routes';
import { zh, fmt } from '../i18n/zh';
import { useTheme } from './theme';
import { HubChannelsProvider, HubReadOnlyNotice, HubSnapshotNotice } from './HubChannelsProvider';
import { TaskCenter } from './TaskCenter';

/** 全局外壳：左侧固定控制台 + 节点直达列表；右侧单行清爽工作区。 */
export default function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const theme = useTheme();
  const me = useQuery(meQueryOptions());
  const hubsQuery = useQuery({ ...hubsQueryOptions(), enabled: Boolean(me.data) });

  const match = matchHubPath(pathname);
  const hubId = match?.hubId ?? '';
  const hubQuery = useQuery({ ...hubQueryOptions(hubId), enabled: Boolean(hubId) });

  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const hubs = hubsQuery.data ?? [];
  const sidebarHubs: SidebarHub[] = hubs.map((hub) => ({
    id: hub.id,
    name: hub.name,
    status: hub.status,
    meta: zh.status[hub.status],
  }));
  const activeHub: SidebarHub | null = match
    ? hubQuery.data
      ? {
          id: hubQuery.data.id,
          name: hubQuery.data.name,
          status: hubQuery.data.status,
          meta: zh.status[hubQuery.data.status],
        }
      : (sidebarHubs.find((hub) => hub.id === hubId) ?? null)
    : null;

  // 全局侧栏导航（3 项）：概览 / 节点 / 设置；节点直达列表在下方
  const globalItems: SidebarNavItem[] = [
    {
      key: 'overview',
      label: zh.nav.overview,
      href: paths.overview,
      icon: 'home',
      active: !match && pathname === paths.overview,
    },
    {
      key: 'hubs',
      label: zh.nav.hubs,
      href: paths.hubs,
      icon: 'server',
      active: pathname === paths.hubs,
    },
    {
      key: 'settings',
      label: zh.nav.settings,
      href: paths.settings,
      icon: 'settings',
      active: pathname === paths.settings,
    },
  ];

  // 节点层一级导航（压平，无二级胶囊）。未配置/未安装的按需模块不出现入口：
  // WireGuard（内网穿透）只在 D1 summary 有 Peer 计数或模式为 wg 时显示；
  // 判定只用 D1 summary（离线可见），summary 未到达时先显示，避免入口闪烁。
  const hubSummary = hubQuery.data?.summary;
  const showWireGuard = !hubSummary || hubSummary.peers !== null || hubSummary.mode === 'wg';
  const hubPrimaryTabs: SidebarNavItem[] = useMemo(() => {
    if (!hubId) return [];
    const section = match?.section ?? null;
    return [
      {
        key: 'hubOverview',
        label: zh.nav.hubOverview,
        href: paths.hub(hubId),
        icon: 'home',
        active: Boolean(match) && !section && !match?.app,
      },
      {
        key: 'services',
        label: zh.nav.services,
        href: paths.hubSection(hubId, 'services'),
        icon: 'activity',
        active: section === 'services',
      },
      {
        key: 'sites',
        label: zh.nav.sites,
        href: paths.hubSection(hubId, 'sites'),
        icon: 'globe',
        active: section === 'sites' || Boolean(match?.app),
      },
      ...(showWireGuard
        ? [
            {
              key: 'wireguard',
              label: zh.nav.wireguard,
              href: paths.hubSection(hubId, 'wireguard'),
              icon: 'users' as const,
              active: section === 'wireguard',
            },
          ]
        : []),
      {
        key: 'ops',
        label: zh.nav.ops,
        href: paths.hubSection(hubId, 'ops'),
        icon: 'terminal',
        active: section === 'ops',
      },
      {
        key: 'hubSettings',
        label: zh.nav.hubSettings,
        href: paths.hubSection(hubId, 'settings'),
        icon: 'settings',
        active: section === 'settings',
      },
    ];
  }, [hubId, match, showWireGuard]);

  const crumbs: Crumb[] = useMemo(() => {
    if (match) {
      const nodeName = hubQuery.data?.name ?? match.hubId;
      const base: Crumb[] = [
        { label: zh.nav.console, href: paths.overview },
        { label: nodeName, href: paths.hub(match.hubId) },
      ];
      if (match.app) {
        const meta = getAppMeta(match.app);
        return [...base, { label: meta.title ?? match.app }];
      }
      if (match.section) {
        return [...base, { label: zh.nav[sectionTitleKey[match.section]] }];
      }
      return [...base, { label: zh.nav.hubOverview }];
    }
    if (pathname === paths.hubs) return [{ label: zh.nav.console, href: paths.overview }, { label: zh.nav.hubs }];
    if (pathname === paths.settings) return [{ label: zh.nav.console, href: paths.overview }, { label: zh.nav.settings }];
    return [{ label: zh.nav.console }];
  }, [hubQuery.data?.name, match, pathname]);

  const paletteGroups = useMemo(
    () => [
      {
        title: zh.nav.hubs,
        items: hubs.slice(0, 8).map((hub) => ({
          id: `hub:${hub.id}`,
          label: hub.name,
          scope: zh.nav.hubs,
          icon: 'server' as IconName,
        })),
      },
      {
        title: zh.nav.overview,
        items: [
          { id: `nav:${paths.overview}`, label: zh.nav.overview, icon: 'home' as IconName },
          { id: `nav:${paths.hubs}`, label: zh.nav.hubs, icon: 'server' as IconName },
          { id: `nav:${paths.settings}`, label: zh.nav.settings, icon: 'settings' as IconName },
        ],
      },
      {
        title: zh.nav.hubs,
        items: [
          {
            id: 'action:hub.create',
            label: zh.actions['hub.create'],
            scope: zh.nav.hubs,
            icon: 'plus' as IconName,
          },
          {
            id: 'action:cert.create',
            label: zh.actions['cert.create'],
            scope: zh.nav.certs,
            icon: 'plus' as IconName,
          },
        ],
      },
    ],
    [hubs],
  );

  async function handleLogout() {
    try {
      await logout();
    } finally {
      queryClient.clear();
      await router.navigate({ href: paths.login });
    }
  }

  const handleSelectHub = useCallback(
    (nextHubId: string) => {
      if (match?.section) {
        void router.navigate({ href: paths.hubSection(nextHubId, match.section) });
        return;
      }
      void router.navigate({ href: paths.hub(nextHubId) });
    },
    [match?.section, router],
  );

  const toastApi = useMemo(
    () => ({
      show: (next: ToastState) => setToast(next),
    }),
    [],
  );

  // 顶栏任务入口只在节点上下文渲染：全局页没有节点就没有数据源，隐藏而不是留一个禁用死按钮。
  const topbar = (taskEntry?: ReactNode) => (
    <Topbar
      crumbs={crumbs}
      onOpenPalette={() => setPaletteOpen(true)}
      theme={theme.mode}
      onThemeChange={theme.setMode}
      userName={me.data?.user.name}
      onLogout={() => void handleLogout()}
      onOpenMenu={() => setMobileOpen(true)}
      taskEntry={taskEntry}
    />
  );

  return (
    <ToastContextProvider value={toastApi}>
      <div className="ui-shell">
        <Sidebar
          variant="global"
          brand={zh.app.name}
          nav={globalItems}
          hubs={sidebarHubs}
          activeHub={activeHub}
          hubsHref={paths.overview}
          allHubsLabel={fmt(zh.nav.allHubs, { count: hubs.length })}
          backLabel={zh.nav.backToConsole}
          groupLabel={zh.nav.groupHubs}
          footerLabel={me.data ? zh.app.controlPlaneConnected : zh.app.controlPlaneOffline}
          footerTone={me.data ? 'ok' : 'neutral'}
          onSelectHub={handleSelectHub}
          onCreateHub={() => void router.navigate({ href: '/hubs?create=1' })}
          mobileOpen={mobileOpen}
          onCloseMobile={() => setMobileOpen(false)}
        />
        <div className="ui-main">
          {match ? (
            <HubChannelsProvider hubId={hubId} liveEndpoint={hubQuery.data?.liveEndpoint}>
              {topbar(<TaskCenter />)}
              <HubBar
                activeHub={activeHub}
                hubs={sidebarHubs}
                items={hubPrimaryTabs}
                endpoint={hubQuery.data?.endpoint}
                onSelectHub={handleSelectHub}
              />
              <div className="ui-content ui-hub-content">
                <HubReadOnlyNotice />
                <HubSnapshotNotice />
                {children}
              </div>
            </HubChannelsProvider>
          ) : (
            <>
              {topbar()}
              <main className="ui-content">{children}</main>
            </>
          )}
        </div>
        <CommandPalette
          open={paletteOpen}
          groups={paletteGroups}
          onClose={() => setPaletteOpen(false)}
          onSelect={(id) => {
            if (id.startsWith('hub:')) {
              void router.navigate({ href: paths.hub(id.slice(4)) });
              return;
            }
            if (id.startsWith('nav:')) {
              void router.navigate({ href: id.slice(4) });
              return;
            }
            if (id === 'action:hub.create') {
              void router.navigate({ href: '/hubs?create=1' });
              return;
            }
            if (id === 'action:cert.create') {
              void router.navigate({ href: '/settings?tab=certs&drawer=issue' });
            }
          }}
        />
      </div>
      <ToastHost toast={toast} onDismiss={dismissToast} />
    </ToastContextProvider>
  );
}
