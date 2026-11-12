/**
 * 站点抽屉的表单模型与纯逻辑（B4 抽取）。
 * 站点页与「对外服务」页共用，保证校验、构建与后端文案只有一个来源。
 */
import type {
  CaddyPathRoute,
  CaddySite,
  CaddySiteHealth,
  HealthState,
  LbPolicy,
  SiteKind,
  TlsMode,
} from '../../data/sites';
import { DEFAULT_REDIRECT_CODE, DEFAULT_TLS_PORT, formatList, parseList } from '../../data/sites';
import { classifyBackend, type BackendContext } from '../../data/services';
import type { Tone } from '../../ui';
import { zh } from '../../i18n/zh';

export const DOMAIN_RE = /^[A-Za-z0-9*_.-]+(\.[A-Za-z0-9*_.-]+)*$/;
export const NAME_RE = /^[A-Za-z0-9_.@*-]{1,64}$/;
export const UPSTREAM_RE = /^(https?:\/\/[^\s]+|[A-Za-z0-9_.:[\]-]+:\d{1,5})$/;
export const IP_RE = /^[0-9A-Fa-f:.]+(\/\d{1,3})?$/;
export const PATH_RE = /^\/[^\s]*$/;
export const REDIRECT_CODES = [301, 302, 307, 308];

export function splitUpstream(value: string): { host: string; port: number | null } {
  const item = parseList(value)[0] ?? '';
  const index = item.lastIndexOf(':');
  if (index <= 0) return { host: item, port: null };
  const port = Number(item.slice(index + 1));
  return {
    host: item.slice(0, index),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
  };
}

export function joinUpstream(host: string, port: number | null): string {
  return `${host}:${port ?? 80}`;
}

export type SiteField =
  | 'name'
  | 'domains'
  | 'listenPort'
  | 'upstreams'
  | 'pathRoutes'
  | 'root'
  | 'redirectTo'
  | 'cert'
  | 'headers'
  | 'basic'
  | 'maxBodyBytes'
  | 'ips';
export type SiteErrors = Partial<Record<SiteField, string>>;

export interface PathRouteRow {
  path: string;
  upstreams: string;
}

export interface HeaderRow {
  key: string;
  value: string;
}

export interface SiteFormState {
  mode: 'create' | 'edit';
  originalName?: string;
  name: string;
  kind: SiteKind;
  domains: string;
  listenPort: number | null;
  enabled: boolean;
  upstreams: string;
  lbPolicy: LbPolicy;
  healthUri: string;
  pathRoutes: PathRouteRow[];
  root: string;
  browse: boolean;
  spa: boolean;
  index: string;
  tryFiles: string;
  redirectTo: string;
  redirectCode: number;
  tlsMode: TlsMode;
  certId: string;
  forceTls13: boolean;
  basicUser: string;
  basicPassword: string;
  existingHash: string;
  headers: HeaderRow[];
  hsts: boolean;
  securityHeaders: boolean;
  compression: boolean;
  maxBodyBytes: number | null;
  allowedIps: string;
  deniedIps: string;
  logEnabled: boolean;
  logPath: string;
  liveGateway: boolean;
  /** 来源 Peer + 发布时端口（D-09）；旧站点为空，不阻塞编辑。 */
  sourcePeer: string;
  sourcePort: number | null;
  initial: string;
}

export interface SiteRow {
  site: CaddySite;
  health: CaddySiteHealth | null;
}

export function siteSignature(form: SiteFormState): string {
  return JSON.stringify([
    form.name,
    form.kind,
    form.domains,
    form.listenPort,
    form.enabled,
    form.upstreams,
    form.lbPolicy,
    form.healthUri,
    form.pathRoutes,
    form.root,
    form.browse,
    form.spa,
    form.index,
    form.tryFiles,
    form.redirectTo,
    form.redirectCode,
    form.tlsMode,
    form.certId,
    form.forceTls13,
    form.basicUser,
    form.basicPassword,
    form.headers,
    form.hsts,
    form.securityHeaders,
    form.compression,
    form.maxBodyBytes,
    form.allowedIps,
    form.deniedIps,
    form.logEnabled,
    form.logPath,
    form.liveGateway,
    form.sourcePeer,
    form.sourcePort,
  ]);
}

export function createForm(): SiteFormState {
  const form: SiteFormState = {
    mode: 'create',
    name: '',
    kind: 'proxy',
    domains: '',
    listenPort: DEFAULT_TLS_PORT,
    enabled: true,
    upstreams: '',
    lbPolicy: 'round_robin',
    healthUri: '',
    pathRoutes: [],
    root: '',
    browse: false,
    spa: false,
    index: 'index.html',
    tryFiles: '',
    redirectTo: '',
    redirectCode: DEFAULT_REDIRECT_CODE,
    tlsMode: 'auto',
    certId: '',
    forceTls13: false,
    basicUser: '',
    basicPassword: '',
    existingHash: '',
    headers: [],
    hsts: false,
    securityHeaders: false,
    compression: false,
    maxBodyBytes: null,
    allowedIps: '',
    deniedIps: '',
    logEnabled: false,
    logPath: '',
    liveGateway: false,
    sourcePeer: '',
    sourcePort: null,
    initial: '',
  };
  return { ...form, initial: siteSignature(form) };
}

export function editForm(site: CaddySite): SiteFormState {
  const form: SiteFormState = {
    mode: 'edit',
    originalName: site.name,
    name: site.name,
    kind: site.kind,
    domains: formatList(site.domains),
    listenPort: site.listenPort,
    enabled: site.enabled,
    upstreams: formatList(site.upstreams),
    lbPolicy: site.lbPolicy,
    healthUri: site.healthUri,
    pathRoutes: site.pathRoutes.map((route) => ({
      path: route.path,
      upstreams: formatList(route.upstreams),
    })),
    root: site.root,
    browse: site.browse,
    spa: site.spa,
    index: site.index,
    tryFiles: formatList(site.tryFiles),
    redirectTo: site.redirectTo,
    redirectCode: site.redirectCode,
    tlsMode: site.tls.mode,
    certId: site.tls.cert?.$cert ?? '',
    forceTls13: site.forceTls13,
    basicUser: site.basicauth?.user ?? '',
    basicPassword: '',
    existingHash: site.basicauth?.passwordHash ?? '',
    headers: Object.entries(site.headers).map(([key, value]) => ({ key, value })),
    hsts: site.hsts,
    securityHeaders: site.securityHeaders,
    compression: site.compression,
    maxBodyBytes: site.maxBodyBytes,
    allowedIps: formatList(site.allowedIps),
    deniedIps: formatList(site.deniedIps),
    logEnabled: site.log.enabled,
    logPath: site.log.path,
    liveGateway: site.liveGateway,
    sourcePeer: site.sourcePeer ?? '',
    sourcePort: site.sourcePort ?? null,
    initial: '',
  };
  return { ...form, initial: siteSignature(form) };
}

export function healthBadge(row: SiteRow): { tone: Tone; label: string } {
  if (!row.site.enabled) return { tone: 'neutral', label: zh.sites.statusDisabled };
  const health = row.health;
  if (health) {
    const labels: Record<HealthState, { tone: Tone; label: string }> = {
      ok: { tone: 'ok', label: zh.sites.healthOk },
      warn: { tone: 'warn', label: zh.sites.healthWarn },
      down: { tone: 'danger', label: zh.sites.healthDown },
      unknown: { tone: 'neutral', label: zh.sites.healthUnknown },
    };
    return labels[health.state];
  }
  return { tone: 'neutral', label: zh.sites.healthUnknown };
}

export function siteTarget(site: CaddySite): string {
  if (site.kind === 'static') return site.root || '—';
  if (site.kind === 'redirect') return site.redirectTo || '—';
  return site.upstreams.length > 0 ? site.upstreams.join(', ') : site.upstream || '—';
}

/** 站点表「后端」文案（B3-lite 起窄屏也不丢项）。 */
export function siteBackendText(site: CaddySite, ctx: BackendContext): string {
  if (site.kind !== 'proxy') return '—';
  const upstreams = site.upstreams.length > 0 ? site.upstreams : site.upstream ? [site.upstream] : [];
  const info = classifyBackend(upstreams[0] ?? '', ctx, Math.max(0, upstreams.length - 1));
  const suffix = info.extra > 0 ? ` +${info.extra}` : '';
  switch (info.kind) {
    case 'unix':
      return zh.sites.backendUnix;
    case 'local':
      return `${zh.sites.backendLocal} ${info.target}${suffix}`;
    case 'vm': {
      const peer =
        info.peerOnline === true
          ? zh.sites.backendPeerOnline
          : info.peerOnline === false
            ? zh.sites.backendPeerOffline
            : zh.sites.backendPeerUnknown;
      return `${zh.sites.backendVm} ${info.peerName ?? ''} ${info.target} · ${peer}${suffix}`.replace(/\s+/g, ' ');
    }
    case 'internal':
      return `${zh.sites.backendInternal} ${info.target}${suffix}`;
    default:
      return `${zh.sites.backendExternal} ${info.target}${suffix}`;
  }
}

export interface SiteValidationContext {
  sites: CaddySite[];
  /** 已加载的证书 id 列表 */
  certIds: string[];
  certsLoaded: boolean;
}

export function validateSite(form: SiteFormState, ctx: SiteValidationContext): SiteErrors {
  const next: SiteErrors = {};
  const domains = parseList(form.domains);
  const name = (form.name.trim() || domains[0] || '').trim();
  if (!NAME_RE.test(name)) next.name = zh.sites.invalidName;
  else if (ctx.sites.some((site) => site.name === name && site.name !== form.originalName)) {
    next.name = zh.sites.duplicateName;
  }
  if (domains.length === 0 || domains.some((domain) => !DOMAIN_RE.test(domain))) {
    next.domains = domains.length === 0 ? zh.sites.invalidDomains : zh.sites.invalidDomain;
  } else if (new Set(domains).size !== domains.length) {
    next.domains = zh.sites.invalidDomains;
  }
  if (
    form.listenPort === null ||
    !Number.isInteger(form.listenPort) ||
    form.listenPort < 1 ||
    form.listenPort > 65535
  ) {
    next.listenPort = zh.sites.invalidPort;
  }
  const port = form.listenPort ?? DEFAULT_TLS_PORT;
  if (domains.length > 0) {
    const conflict = ctx.sites.some(
      (site) =>
        site.name !== form.originalName &&
        site.listenPort === port &&
        site.domains.some((domain) => domains.includes(domain)),
    );
    if (conflict) next.domains = zh.sites.duplicateAddress;
  }

  const upstreams = parseList(form.upstreams);
  const pathErrors =
    form.pathRoutes.length > 0 &&
    form.pathRoutes.some((route) => {
      const routeUpstreams = parseList(route.upstreams);
      return (
        !PATH_RE.test(route.path.trim()) ||
        routeUpstreams.length === 0 ||
        routeUpstreams.some((item) => !UPSTREAM_RE.test(item))
      );
    });

  if (form.kind === 'proxy') {
    if (upstreams.length === 0 || upstreams.some((item) => !UPSTREAM_RE.test(item))) {
      next.upstreams = upstreams.length === 0 ? zh.sites.upstreamRequired : zh.sites.invalidUpstreams;
    }
    if (pathErrors) next.pathRoutes = zh.sites.invalidPath;
  } else if (form.kind === 'static') {
    if (!form.root.trim()) next.root = zh.sites.rootRequired;
  } else {
    if (!form.redirectTo.trim()) next.redirectTo = zh.sites.redirectRequired;
    else if (!/^(https?:\/\/|\/)[^\s]*$/.test(form.redirectTo.trim())) {
      next.redirectTo = zh.sites.invalidRedirect;
    }
  }

  if (form.tlsMode === 'manual') {
    if (!form.certId) next.cert = zh.sites.certMissing;
    else if (ctx.certsLoaded && !ctx.certIds.includes(form.certId)) {
      next.cert = zh.sites.certMissing;
    }
  }

  const headerRows = form.headers.filter(
    (row) => row.key.trim().length > 0 || row.value.trim().length > 0,
  );
  if (headerRows.some((row) => !row.key.trim() || !row.value.trim())) {
    next.headers = zh.sites.headersInvalid;
  }

  if (!form.basicUser.trim() && form.basicPassword) {
    next.basic = zh.sites.usernameRequired;
  }
  if (form.basicUser.trim() && !form.basicPassword && !form.existingHash) {
    next.basic = zh.sites.passwordRequired;
  }

  if (
    form.maxBodyBytes !== null &&
    (!Number.isInteger(form.maxBodyBytes) || form.maxBodyBytes < 0)
  ) {
    next.maxBodyBytes = zh.sites.invalidMaxBody;
  }
  const ips = [...parseList(form.allowedIps), ...parseList(form.deniedIps)];
  if (ips.some((item) => !IP_RE.test(item))) next.ips = zh.sites.invalidIp;
  return next;
}

export interface SiteBuildContext {
  /** 节点不可写时的原因（Basic Auth 需要调用 Agent 生成 hash） */
  offlineReason?: string;
  hashPassword: (password: string) => Promise<string>;
}

export async function buildSite(form: SiteFormState, ctx: SiteBuildContext): Promise<CaddySite> {
  let basicauth = null;
  const user = form.basicUser.trim();
  const password = form.basicPassword;
  if (user || password) {
    let hash = form.existingHash;
    if (password) {
      if (ctx.offlineReason) throw new Error(ctx.offlineReason);
      hash = await ctx.hashPassword(password);
    }
    if (!user) throw new Error(zh.sites.usernameRequired);
    if (!hash) throw new Error(zh.sites.passwordRequired);
    basicauth = { user, passwordHash: hash };
  }
  const domains = parseList(form.domains);
  const upstreams = parseList(form.upstreams);
  const headers: Record<string, string> = {};
  for (const row of form.headers) {
    const key = row.key.trim();
    if (key) headers[key] = row.value.trim();
  }
  const pathRoutes: CaddyPathRoute[] = form.pathRoutes
    .filter((route) => route.path.trim())
    .map((route) => ({
      path: route.path.trim(),
      upstreams: parseList(route.upstreams),
    }));
  const isProxy = form.kind === 'proxy';
  const isStatic = form.kind === 'static';
  const isRedirect = form.kind === 'redirect';
  return {
    name: (form.name.trim() || domains[0] || '').trim(),
    kind: form.kind,
    domain: domains[0] ?? '',
    domains,
    listenPort: form.listenPort ?? DEFAULT_TLS_PORT,
    enabled: form.enabled,
    upstream: isProxy ? (upstreams[0] ?? '') : '',
    upstreams: isProxy ? upstreams : [],
    lbPolicy: form.lbPolicy,
    healthUri: isProxy ? form.healthUri.trim() : '',
    pathRoutes: isProxy ? pathRoutes : [],
    root: isStatic ? form.root.trim() : '',
    browse: isStatic ? form.browse : false,
    spa: isStatic ? form.spa : false,
    index: isStatic ? form.index.trim() || 'index.html' : 'index.html',
    tryFiles: isStatic ? parseList(form.tryFiles) : [],
    redirectTo: isRedirect ? form.redirectTo.trim() : '',
    redirectCode: isRedirect ? form.redirectCode : DEFAULT_REDIRECT_CODE,
    tls: {
      mode: form.tlsMode,
      cert: form.tlsMode === 'manual' && form.certId ? { $cert: form.certId } : null,
    },
    forceTls13: form.forceTls13,
    basicauth,
    headers,
    hsts: form.hsts,
    securityHeaders: form.securityHeaders,
    compression: form.compression,
    allowedIps: parseList(form.allowedIps),
    deniedIps: parseList(form.deniedIps),
    maxBodyBytes: form.maxBodyBytes,
    log: { enabled: form.logEnabled, path: form.logPath.trim() },
    liveGateway: form.liveGateway,
    sourcePeer: form.sourcePeer || undefined,
    sourcePort: form.sourcePort ?? undefined,
  };
}
