/**
 * 节点概览与首页探测同源投影（编排/知识层，2026-11-20）。
 *
 * 输入为 D1 配置、D1 证书、控制面 TLS 实测与可选的 Agent `/state`：
 * 不连节点、不写库、不依赖 Hono；合法性缺损字段一律安全降级，不抛异常、不伪造状态。
 */
import type {
  AgentState,
  Certificate,
  ExpiringCertSummary,
  NodeAccessCert,
  NodeAppIssue,
  NodeAppsProjection,
  NodeAppVerdict,
  NodeCertsProjection,
  NodeForwardsProjection,
  NodeOverviewData,
  NodePeersProjection,
  NodeProbeProjection,
  OverviewAppItem,
  OverviewForwardItem,
  OverviewHostInfo,
  OverviewManagedService,
  OverviewPeerItem,
  TlsProbe,
} from '@khc/contracts';
import type { StoredNode } from '../domain/repos';
import type { AppConfigLike } from './node-summary';

/** 证书与节点临期进入「需要处理」的天数阈值（含已过期）。 */
export const EXPIRY_TODO_DAYS = 14;

const ISSUE_HTTP_STATUSES = new Set([502, 503, 504]);
const DAY_SECONDS = 86_400;

interface ParsedSiteHealth {
  name: string;
  domain: string;
  state: string;
  status: number | null;
  error: string | null;
  upstreams: string[];
}

interface ParsedRuntimePeer {
  name: string;
  enabled: boolean;
  online: boolean | null;
  latestHandshake: number | null;
}

interface ParsedRuntimeForward {
  name: string;
  listenPort: number | null;
  targetHost: string;
  targetPort: number;
  protocol: 'tcp' | 'udp';
  enabled: boolean;
  active: boolean | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringList(value: unknown): string[] {
  return asArray(value)
    .map((item) => asString(item))
    .filter(Boolean);
}

function nullableString(value: unknown): string | null {
  const text = asString(value);
  return text || null;
}

function nullableInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null;
}

function nullableNonNegNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function validPort(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= 1 && value <= 65535 ? value : null;
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function extractHostname(endpoint: string): string | null {
  try {
    const host = new URL(endpoint).hostname.trim().toLowerCase().replace(/\.$/, '');
    return host || null;
  } catch {
    return null;
  }
}

function findAdapter(
  state: AgentState | null | undefined,
  name: string,
): Record<string, unknown> | null {
  if (!state || !Array.isArray(state.adapters)) return null;
  const hit = state.adapters.find((adapter) => adapter && adapter.name === name);
  return asRecord(hit);
}

/**
 * 按提案 §2.1 与 P-8 判定单条反代应用的在线结论。
 *
 * 优先级硬约束：先判 `down`，再判 `warn` 下的 502/503/504，最后才放行自签证书与其它 warn。
 * 因为 `caddy_site._probe_url` 在自签证书站点上游挂掉回 502 时，会返回
 * `{ state: 'warn', status: 502, error: 'TLS 证书校验失败（自签/internal 证书）' }`，
 * 若先按 error 文案当作自签放行，就会把 502 吞掉。
 */
export function classifySiteHealth(health: unknown): NodeAppVerdict {
  const record = asRecord(health);
  if (!record) return 'unknown';
  const state = asString(record.state);
  if (state === 'down') return 'issue';
  if (state === 'warn') {
    const status = typeof record.status === 'number' && Number.isFinite(record.status)
      ? Math.trunc(record.status)
      : null;
    if (status !== null && ISSUE_HTTP_STATUSES.has(status)) return 'issue';
    return 'online';
  }
  if (state === 'ok') return 'online';
  return 'unknown';
}

/**
 * 证书域名列表是否覆盖目标域名（大小写不敏感、忽略末尾 `.`，支持单层通配 `*.example.com`）。
 * 与 `agent/adapters/caddy_site.py:cert_covers_domain` 口径一致。
 */
export function certCoversDomain(domain: string, certDomains: readonly string[]): boolean {
  const target = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!target || !Array.isArray(certDomains)) return false;
  const targetDots = target.split('.').length - 1;
  for (const raw of certDomains) {
    if (typeof raw !== 'string') continue;
    const candidate = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!candidate) continue;
    if (candidate === target) return true;
    if (candidate.startsWith('*.')) {
      const suffix = candidate.slice(1); // ".example.com"
      const suffixDots = suffix.split('.').length - 1;
      if (
        target.length > suffix.length &&
        !target.startsWith('.') &&
        target.endsWith(suffix) &&
        targetDots === suffixDots
      ) {
        return true;
      }
    }
  }
  return false;
}

/** 计算距到期日的整天数（向上取整，负数为已过期天数，消除 -0）。 */
export function daysLeftFromNotAfter(notAfterSec: number, nowSec: number): number {
  return normalizeZero(Math.ceil((notAfterSec - nowSec) / DAY_SECONDS));
}

/** 收集全部临期（≤14 天）与已过期证书，按剩余天数升序、名称升序排列。 */
export function collectExpiringCerts(
  certs: readonly Certificate[],
  nowSec: number,
  thresholdDays = EXPIRY_TODO_DAYS,
): ExpiringCertSummary[] {
  const expiring: ExpiringCertSummary[] = [];
  for (const cert of certs) {
    if (typeof cert.notAfter !== 'number' || !Number.isFinite(cert.notAfter)) continue;
    const daysLeft = daysLeftFromNotAfter(cert.notAfter, nowSec);
    if (daysLeft <= thresholdDays) {
      expiring.push({
        id: cert.id,
        name: cert.name,
        daysLeft,
        nodeId: cert.sourceNodeId ?? null,
      });
    }
  }
  return expiring.sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name));
}

function parseSiteHealthList(caddyAdapter: Record<string, unknown> | null): ParsedSiteHealth[] {
  const status = asRecord(caddyAdapter?.status);
  if (!status || !Array.isArray(status.siteHealth)) return [];
  const items: ParsedSiteHealth[] = [];
  for (const raw of status.siteHealth) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const domain = asString(entry.domain);
    const name = asString(entry.name) || domain;
    if (!name && !domain) continue;
    items.push({
      name,
      domain,
      state: asString(entry.state),
      status: nullableInt(entry.status),
      error: nullableString(entry.error),
      upstreams: asStringList(entry.upstreams),
    });
  }
  return items;
}

function projectApps(
  caddyRow: AppConfigLike | undefined,
  state: AgentState | null,
): NodeAppsProjection & { items: OverviewAppItem[] } {
  const caddyAdapter = findAdapter(state, 'caddy-site');
  const hasRuntime = state !== null && caddyAdapter !== null;
  const siteHealthList = hasRuntime ? parseSiteHealthList(caddyAdapter) : [];

  const items: OverviewAppItem[] = [];
  const issues: NodeAppIssue[] = [];
  let staticCount = 0;
  let redirectCount = 0;

  if (caddyRow) {
    for (const rawSite of asArray(caddyRow.config.sites)) {
      const site = asRecord(rawSite);
      if (!site || site.enabled === false) continue;
      const kind = asString(site.kind) || 'proxy';
      if (kind === 'static') {
        staticCount += 1;
        continue;
      }
      if (kind === 'redirect') {
        redirectCount += 1;
        continue;
      }
      const domains = asStringList(site.domains);
      const firstDomain = domains[0] || asString(site.domain);
      const name = asString(site.name) || firstDomain;
      if (!name) continue;
      const upstreams = asStringList(site.upstreams);
      const upstream = upstreams[0] || asString(site.upstream);

      const matched = hasRuntime
        ? (siteHealthList.find((h) => h.name && h.name === name) ??
          (firstDomain ? siteHealthList.find((h) => h.domain && h.domain === firstDomain) : undefined))
        : undefined;
      const verdict: NodeAppVerdict = matched ? classifySiteHealth(matched) : 'unknown';
      const status = matched?.status ?? null;
      items.push({
        name,
        domain: firstDomain,
        upstream,
        verdict,
        status,
        error: matched?.error ?? null,
      });
      if (verdict === 'issue') {
        issues.push({
          name,
          domain: firstDomain,
          state: matched?.state === 'down' ? 'down' : 'warn',
          status,
        });
      }
    }
  } else if (hasRuntime) {
    for (const health of siteHealthList) {
      if (health.upstreams.length === 0) continue;
      const name = health.name || health.domain;
      if (!name) continue;
      const verdict = classifySiteHealth(health);
      items.push({
        name,
        domain: health.domain,
        upstream: health.upstreams[0] ?? '',
        verdict,
        status: health.status,
        error: health.error,
      });
      if (verdict === 'issue') {
        issues.push({
          name,
          domain: health.domain,
          state: health.state === 'down' ? 'down' : 'warn',
          status: health.status,
        });
      }
    }
  }

  const total = items.length;
  const online = !hasRuntime
    ? null
    : total === 0
      ? 0
      : items.every((item) => item.verdict === 'unknown')
        ? null
        : items.filter((item) => item.verdict === 'online').length;

  return { online, total, issues, staticCount, redirectCount, items };
}

function parseRuntimePeers(wgStatus: Record<string, unknown> | null): ParsedRuntimePeer[] {
  if (!wgStatus || !Array.isArray(wgStatus.peers)) return [];
  const peers: ParsedRuntimePeer[] = [];
  for (const raw of wgStatus.peers) {
    const peer = asRecord(raw);
    if (!peer) continue;
    const name = asString(peer.name);
    if (!name) continue;
    peers.push({
      name,
      enabled: peer.enabled !== false,
      online: typeof peer.online === 'boolean' ? peer.online : null,
      latestHandshake: nullableInt(peer.latestHandshake) !== null && (nullableInt(peer.latestHandshake) ?? -1) >= 0
        ? nullableInt(peer.latestHandshake)
        : null,
    });
  }
  return peers;
}

function projectPeers(
  wgRow: AppConfigLike | undefined,
  state: AgentState | null,
): NodePeersProjection & { items: OverviewPeerItem[] } {
  const wgAdapter = findAdapter(state, 'wireguard');
  const wgStatus = asRecord(wgAdapter?.status);
  const hasRuntime = state !== null && Array.isArray(wgStatus?.peers);
  const runtimePeers = hasRuntime ? parseRuntimePeers(wgStatus) : [];

  if (wgRow) {
    if (wgRow.config.enabled === false) {
      return {
        enabled: false,
        total: 0,
        online: null,
        offline: [],
        interfaceName: null,
        listenPort: null,
        items: [],
      };
    }
    const iface = asRecord(wgRow.config.interface);
    const interfaceName = nullableString(iface?.name) ?? nullableString(wgStatus?.interface);
    const listenPort = validPort(iface?.listenPort) ?? validPort(wgStatus?.listenPort);
    const items: OverviewPeerItem[] = [];
    for (const rawPeer of asArray(wgRow.config.peers)) {
      const peer = asRecord(rawPeer);
      if (!peer || peer.enabled === false) continue;
      const name = asString(peer.name);
      if (!name) continue;
      const runtime = hasRuntime ? runtimePeers.find((item) => item.name === name) : undefined;
      const online = !hasRuntime ? null : runtime?.online === true;
      items.push({
        name,
        online,
        latestHandshake: runtime?.latestHandshake ?? null,
      });
    }
    const total = items.length;
    const online = hasRuntime ? items.filter((item) => item.online === true).length : null;
    const offline = hasRuntime
      ? items.filter((item) => item.online !== true).map((item) => item.name)
      : [];
    return {
      enabled: true,
      total,
      online,
      offline,
      interfaceName,
      listenPort,
      items,
    };
  }

  if (hasRuntime && wgStatus?.enabled === true) {
    const items: OverviewPeerItem[] = runtimePeers
      .filter((peer) => peer.enabled)
      .map((peer) => ({
        name: peer.name,
        online: peer.online === true,
        latestHandshake: peer.latestHandshake,
      }));
    return {
      enabled: true,
      total: items.length,
      online: items.filter((item) => item.online === true).length,
      offline: items.filter((item) => item.online !== true).map((item) => item.name),
      interfaceName: nullableString(wgStatus?.interface),
      listenPort: validPort(wgStatus?.listenPort),
      items,
    };
  }

  return {
    enabled: false,
    total: 0,
    online: null,
    offline: [],
    interfaceName: null,
    listenPort: null,
    items: [],
  };
}

function parseRuntimeForwards(pfStatus: Record<string, unknown> | null): ParsedRuntimeForward[] {
  if (!pfStatus || !Array.isArray(pfStatus.forwards)) return [];
  const items: ParsedRuntimeForward[] = [];
  for (const raw of pfStatus.forwards) {
    const rule = asRecord(raw);
    if (!rule) continue;
    const name = asString(rule.name);
    const listenPort = validPort(rule.listenPort);
    if (!name || listenPort === null) continue;
    const rawTargetPort = nullableInt(rule.targetPort);
    const targetPort =
      rawTargetPort !== null && rawTargetPort >= 0 && rawTargetPort <= 65535 ? rawTargetPort : 0;
    items.push({
      name,
      listenPort,
      targetHost: asString(rule.targetHost),
      targetPort,
      protocol: asString(rule.protocol) === 'udp' ? 'udp' : 'tcp',
      enabled: rule.enabled !== false,
      active: typeof rule.active === 'boolean' ? rule.active : null,
    });
  }
  return items;
}

function projectForwards(
  pfRow: AppConfigLike | undefined,
  state: AgentState | null,
): NodeForwardsProjection & { items: OverviewForwardItem[] } {
  const pfAdapter = findAdapter(state, 'port-forward');
  const pfStatus = asRecord(pfAdapter?.status);
  const hasRuntime = state !== null && Array.isArray(pfStatus?.forwards);
  const runtimeForwards = hasRuntime ? parseRuntimeForwards(pfStatus) : [];

  const items: OverviewForwardItem[] = [];
  if (pfRow) {
    for (const rawRule of asArray(pfRow.config.forwards)) {
      const rule = asRecord(rawRule);
      if (!rule || rule.enabled === false) continue;
      const name = asString(rule.name);
      const listenPort = validPort(rule.listenPort);
      if (!name || listenPort === null) continue;
      const rawTargetPort = nullableInt(rule.targetPort);
      const targetPort =
        rawTargetPort !== null && rawTargetPort >= 0 && rawTargetPort <= 65535 ? rawTargetPort : 0;
      const protocol: 'tcp' | 'udp' = asString(rule.protocol) === 'udp' ? 'udp' : 'tcp';
      const runtime = hasRuntime ? runtimeForwards.find((item) => item.name === name) : undefined;
      items.push({
        name,
        listenPort,
        targetHost: asString(rule.targetHost),
        targetPort,
        protocol,
        active: hasRuntime ? (runtime ? runtime.active === true : null) : null,
      });
    }
  } else if (hasRuntime) {
    for (const rule of runtimeForwards) {
      if (!rule.enabled || rule.listenPort === null) continue;
      items.push({
        name: rule.name,
        listenPort: rule.listenPort,
        targetHost: rule.targetHost,
        targetPort: rule.targetPort,
        protocol: rule.protocol,
        active: rule.active,
      });
    }
  }

  let tcpCount = 0;
  let udpCount = 0;
  for (const item of items) {
    if (item.protocol === 'udp') udpCount += 1;
    else tcpCount += 1;
  }

  return { total: items.length, tcpCount, udpCount, items };
}

function projectCerts(
  node: Pick<StoredNode, 'id' | 'domain'>,
  caddyRow: AppConfigLike | undefined,
  certs: readonly Certificate[],
  nowSec: number,
): NodeCertsProjection {
  const boundCertIds = new Set<string>();
  const manualSiteDomains: string[] = [];

  if (caddyRow) {
    for (const rawSite of asArray(caddyRow.config.sites)) {
      const site = asRecord(rawSite);
      if (!site) continue;
      const tls = asRecord(site.tls);
      const certRef = asRecord(tls?.cert);
      const certId = asString(certRef?.$cert);
      if (certId) boundCertIds.add(certId);

      if (site.enabled !== false && asString(tls?.mode) === 'manual') {
        for (const domain of asStringList(site.domains)) manualSiteDomains.push(domain);
        const legacyDomain = asString(site.domain);
        if (legacyDomain) manualSiteDomains.push(legacyDomain);
      }
    }
  }

  const matched = certs.filter((cert) => {
    if (cert.sourceNodeId === node.id) return true;
    if (node.domain && certCoversDomain(node.domain, cert.domains)) return true;
    if (boundCertIds.has(cert.id)) return true;
    return manualSiteDomains.some((domain) => certCoversDomain(domain, cert.domains));
  });

  const datedDays: number[] = [];
  for (const cert of matched) {
    if (typeof cert.notAfter === 'number' && Number.isFinite(cert.notAfter)) {
      datedDays.push(daysLeftFromNotAfter(cert.notAfter, nowSec));
    }
  }
  const soonestDaysLeft = datedDays.length > 0 ? Math.min(...datedDays) : null;
  const expiring = collectExpiringCerts(matched, nowSec, EXPIRY_TODO_DAYS).map((item) => ({
    ...item,
    nodeId: node.id,
  }));

  return {
    count: matched.length,
    soonestDaysLeft,
    expiring,
  };
}

function projectAccessCert(
  node: Pick<StoredNode, 'domain' | 'endpoint' | 'accessMode'>,
  certs: readonly Certificate[],
  state: AgentState | null,
  tls: TlsProbe | null,
  nowSec: number,
): NodeAccessCert {
  const tlsState = tls?.state ?? (node.accessMode === 'ip' ? 'none' : 'unknown');
  if (node.accessMode !== 'domain') {
    return { daysLeft: null, tlsState };
  }

  // 1. Agent 自身 --tls-cert 上报的到期时间
  if (state?.agent?.tls?.enabled === true && typeof state.agent.tls.notAfter === 'number') {
    return {
      daysLeft: daysLeftFromNotAfter(state.agent.tls.notAfter, nowSec),
      tlsState,
    };
  }

  // 2. certificates 适配器磁盘上的控制通道证书
  const certsAdapter = findAdapter(state, 'certificates');
  const certsStatus = asRecord(certsAdapter?.status);
  const adapterTls = asRecord(certsStatus?.tls);
  if (adapterTls?.present === true) {
    if (typeof adapterTls.daysLeft === 'number' && Number.isFinite(adapterTls.daysLeft)) {
      return {
        daysLeft: normalizeZero(Math.trunc(adapterTls.daysLeft)),
        tlsState,
      };
    }
    if (typeof adapterTls.notAfter === 'string' && adapterTls.notAfter.trim()) {
      const parsedMs = Date.parse(adapterTls.notAfter);
      if (Number.isFinite(parsedMs)) {
        return {
          daysLeft: daysLeftFromNotAfter(Math.floor(parsedMs / 1000), nowSec),
          tlsState,
        };
      }
    }
    if (typeof adapterTls.notAfter === 'number' && Number.isFinite(adapterTls.notAfter)) {
      return {
        daysLeft: daysLeftFromNotAfter(adapterTls.notAfter, nowSec),
        tlsState,
      };
    }
  }

  // 3. D1 证书库中覆盖接入域名的证书
  const accessDomain = nullableString(node.domain) ?? extractHostname(node.endpoint);
  if (accessDomain) {
    const coveringDays: number[] = [];
    for (const cert of certs) {
      if (typeof cert.notAfter !== 'number' || !Number.isFinite(cert.notAfter)) continue;
      if (certCoversDomain(accessDomain, cert.domains)) {
        coveringDays.push(daysLeftFromNotAfter(cert.notAfter, nowSec));
      }
    }
    if (coveringDays.length > 0) {
      return { daysLeft: Math.min(...coveringDays), tlsState };
    }
  }

  return { daysLeft: null, tlsState };
}

function projectHost(state: AgentState | null): OverviewHostInfo | null {
  if (state === null) return null;
  const host = asRecord(state.host);
  const agent = asRecord(state.agent);
  return {
    hostname: nullableString(host?.hostname),
    os: nullableString(host?.os),
    kernel: nullableString(host?.kernel),
    uptime: nullableNonNegNumber(host?.uptime),
    agentVersion: nullableString(agent?.version),
  };
}

function projectManagedServices(state: AgentState | null): OverviewManagedService[] {
  if (state === null) return [];
  const ops = asRecord(state.ops);
  const services = asRecord(ops?.services);
  if (!services || !Array.isArray(services.services)) return [];
  const items: OverviewManagedService[] = [];
  for (const raw of services.services) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const name = asString(entry.name);
    const serviceState = asString(entry.state);
    if (!name || !serviceState) continue;
    items.push({ name, state: serviceState });
  }
  return items;
}

function projectFailedUnits(state: AgentState | null): string[] | null {
  if (state === null) return null;
  const ops = asRecord(state.ops);
  if (!ops) return null;
  if (Array.isArray(ops.failedUnits)) {
    return asStringList(ops.failedUnits);
  }
  const services = asRecord(ops.services);
  if (services && Array.isArray(services.failedUnits)) {
    return asStringList(services.failedUnits);
  }
  return null;
}

/**
 * 计算固定公历到期日期（YYYY-MM-DD）相对当前 UTC 日期的剩余天数：
 * - `> 0`：未到期（1 表示明天到期）
 * - `0`：今日到期（normalizeZero 防 -0）
 * - `< 0`：已逾期 N 天
 */
export function daysLeftFromCalendarDate(
  expiresAt: string | null | undefined,
  nowSec = Math.floor(Date.now() / 1000),
): number | null {
  if (!expiresAt) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiresAt);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  const nowDate = new Date(nowSec * 1000);
  const todayUtcMs = Date.UTC(
    nowDate.getUTCFullYear(),
    nowDate.getUTCMonth(),
    nowDate.getUTCDate(),
  );
  return normalizeZero(Math.round((dt.getTime() - todayUtcMs) / (DAY_SECONDS * 1000)));
}

export interface NodeProjectionInput {
  node: Pick<StoredNode, 'id' | 'domain' | 'endpoint' | 'accessMode'> &
    Partial<Pick<StoredNode, 'expiresAt'>>;
  configs: readonly AppConfigLike[];
  certs: readonly Certificate[];
  state: AgentState | null;
  tls: TlsProbe | null;
  now?: number;
}

/** 节点详情概况与首页探测共用的完整投影（不写库、不抛异常）。 */
export function projectNodeOverview(input: NodeProjectionInput): NodeOverviewData {
  const nowSec = input.now ?? Math.floor(Date.now() / 1000);
  const expiresAt = input.node.expiresAt ?? null;
  const expiresDaysLeft = daysLeftFromCalendarDate(expiresAt, nowSec);
  const byApp = new Map(input.configs.map((item) => [item.app, item]));
  const caddyRow = byApp.get('caddy-site');
  const wgRow = byApp.get('wireguard');
  const pfRow = byApp.get('port-forward');

  return {
    apps: projectApps(caddyRow, input.state),
    peers: projectPeers(wgRow, input.state),
    forwards: projectForwards(pfRow, input.state),
    certs: projectCerts(input.node, caddyRow, input.certs, nowSec),
    accessCert: projectAccessCert(input.node, input.certs, input.state, input.tls, nowSec),
    expiresAt,
    expiresDaysLeft,
    host: projectHost(input.state),
    managedServices: projectManagedServices(input.state),
    failedUnits: projectFailedUnits(input.state),
  };
}

/** 首页批量探针使用的精简投影（与 VM 概况严格同源）。 */
export function projectNodeProbe(input: NodeProjectionInput): NodeProbeProjection {
  const full = projectNodeOverview(input);
  return {
    apps: {
      online: full.apps.online,
      total: full.apps.total,
      issues: full.apps.issues,
      staticCount: full.apps.staticCount,
      redirectCount: full.apps.redirectCount,
    },
    peers: {
      online: full.peers.online,
      total: full.peers.total,
      enabled: full.peers.enabled,
      offline: full.peers.offline,
      interfaceName: full.peers.interfaceName,
      listenPort: full.peers.listenPort,
    },
    forwards: {
      total: full.forwards.total,
      tcpCount: full.forwards.tcpCount,
      udpCount: full.forwards.udpCount,
    },
    certs: full.certs,
    accessCert: full.accessCert,
    expiresAt: full.expiresAt,
    expiresDaysLeft: full.expiresDaysLeft,
  };
}
