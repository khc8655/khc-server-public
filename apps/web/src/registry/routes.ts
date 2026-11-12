/**
 * 路由清单（ui-spec §7.4 / §1.3）：每条路由声明作用域、模板与唯一主操作。
 * 页面与导航只引用这里的路径与标题键。
 */
import type { zh } from '../i18n/zh';
import type { ActionId } from './actions';

export type RouteScope = 'global' | 'hub';
export type PageTemplate = 'T1' | 'T2' | 'T3' | 'T4' | 'T5';

export interface RouteMeta {
  path: string;
  scope: RouteScope;
  template: PageTemplate;
  /** i18n 字典中的页面标题键 */
  title: keyof typeof zh.nav;
  /** 该页唯一的页头主操作 */
  primary?: ActionId;
}

export const routes = [
  { path: '/login', scope: 'global', template: 'T5', title: 'overview' },
  { path: '/', scope: 'global', template: 'T1', title: 'overview' },
  { path: '/hubs', scope: 'global', template: 'T2', title: 'hubs', primary: 'hub.create' },
  { path: '/hubs/:hubId', scope: 'hub', template: 'T1', title: 'hubOverview' },
  { path: '/hubs/:hubId/services', scope: 'hub', template: 'T2', title: 'services' },
  { path: '/hubs/:hubId/wireguard', scope: 'hub', template: 'T2', title: 'wireguard', primary: 'peer.create' },
  { path: '/hubs/:hubId/ops', scope: 'hub', template: 'T2', title: 'ops' },
  { path: '/hubs/:hubId/sites', scope: 'hub', template: 'T2', title: 'sites' },
  { path: '/hubs/:hubId/apps/:app', scope: 'hub', template: 'T3', title: 'apps' },
  { path: '/hubs/:hubId/settings', scope: 'hub', template: 'T4', title: 'hubSettings' },
  { path: '/settings', scope: 'global', template: 'T4', title: 'settings' },
] as const;

export type HubSection =
  | 'services'
  | 'wireguard'
  | 'ops'
  | 'sites'
  | 'settings';

export const hubSections: readonly HubSection[] = [
  'services',
  'wireguard',
  'ops',
  'sites',
  'settings',
];

export const sectionTitleKey: Record<HubSection, keyof typeof zh.nav> = {
  services: 'services',
  wireguard: 'wireguard',
  ops: 'ops',
  sites: 'sites',
  settings: 'hubSettings',
};

export const paths = {
  login: '/login',
  overview: '/',
  hubs: '/hubs',
  settings: '/settings',
  gallery: '/dev/gallery',
  hub(hubId: string): string {
    return `/hubs/${encodeURIComponent(hubId)}`;
  },
  hubSection(hubId: string, section: HubSection): string {
    return `/hubs/${encodeURIComponent(hubId)}/${section}`;
  },
  hubApp(hubId: string, app: string): string {
    return `/hubs/${encodeURIComponent(hubId)}/apps/${encodeURIComponent(app)}`;
  },
} as const;

export interface HubPathMatch {
  hubId: string;
  section: HubSection | null;
  app: string | null;
}

/** 解析 /hubs/:hubId、/hubs/:hubId/:section、/hubs/:hubId/apps/:app。 */
export function matchHubPath(pathname: string): HubPathMatch | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'hubs' || parts.length < 2) return null;
  const rawHubId = parts[1];
  if (!rawHubId) return null;
  let hubId: string;
  try {
    hubId = decodeURIComponent(rawHubId);
  } catch {
    return null;
  }
  if (parts.length === 2) return { hubId, section: null, app: null };
  if (parts[2] === 'apps') {
    const rawApp = parts[3];
    // /hubs/:hubId/apps 已并入站点页「扩展应用」分段（ui-redesign ⑤），
    // 过渡期让站点导航保持高亮，直到 302 重定向完成。
    if (!rawApp) return { hubId, section: 'sites', app: null };
    try {
      return { hubId, section: null, app: decodeURIComponent(rawApp) };
    } catch {
      return null;
    }
  }
  const section = parts[2];
  if (section && (hubSections as readonly string[]).includes(section)) {
    return { hubId, section: section as HubSection, app: null };
  }
  return null;
}

/** 全局导航（侧栏 3 项）：概览 / 节点 / 设置。证书库与系统变量在 /settings 分段。 */
export const globalNav = [
  { key: 'overview', path: '/', icon: 'home' },
  { key: 'hubs', path: '/hubs', icon: 'server' },
  { key: 'settings', path: '/settings', icon: 'settings' },
] as const;

/** 节点层一级导航（压平，无二级）：概况 / 对外服务 / 站点 / 内网穿透 / 主机运维 / 节点设置。 */
export const hubNav = [
  { key: 'hubOverview', section: null, icon: 'home' },
  { key: 'services', section: 'services', icon: 'activity' },
  { key: 'sites', section: 'sites', icon: 'globe' },
  { key: 'wireguard', section: 'wireguard', icon: 'users' },
  { key: 'ops', section: 'ops', icon: 'terminal' },
  { key: 'hubSettings', section: 'settings', icon: 'settings' },
] as const;
