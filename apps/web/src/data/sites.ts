/**
 * 节点站点（caddy-site 应用）完整数据层：
 * 配置规范化（旧 domain/upstream 自动升级）、/state 健康解析、Caddy 服务动作与配置导出。
 */
import { queryOptions } from '@tanstack/react-query';
import { agentEnvelopeSchema, type AgentEnvelope, type AppConfig } from '@khc/contracts';
import { apiRequest } from './client';
import { fetchAppConfig, friendlyAgentError, saveAppConfig } from './apps';
import { fetchHubState } from './hubs';

export const CADDY_SITE_APP = 'caddy-site';

export type SiteKind = 'proxy' | 'static' | 'redirect';
export type TlsMode = 'auto' | 'manual' | 'internal' | 'off';
export type LbPolicy = 'round_robin' | 'random' | 'least_conn' | 'ip_hash';
export type HealthState = 'ok' | 'warn' | 'down' | 'unknown';

export interface CaddyTls {
  mode: TlsMode;
  cert: { $cert: string } | null;
}

export interface CaddyBasicAuth {
  user: string;
  passwordHash: string;
}

export interface CaddyPathRoute {
  path: string;
  upstreams: string[];
}

export interface CaddyLog {
  enabled: boolean;
  path: string;
}

export interface CaddySite {
  name: string;
  kind: SiteKind;
  /** 规范化后始终有值（取 domains[0]），保留旧字段兼容 */
  domain: string;
  domains: string[];
  listenPort: number;
  enabled: boolean;

  /** 规范化后始终有值（取 upstreams[0]），保留旧字段兼容 */
  upstream: string;
  upstreams: string[];
  lbPolicy: LbPolicy;
  healthUri: string;
  pathRoutes: CaddyPathRoute[];

  root: string;
  browse: boolean;
  spa: boolean;
  index: string;
  tryFiles: string[];

  redirectTo: string;
  redirectCode: number;

  tls: CaddyTls;
  forceTls13: boolean;

  basicauth: CaddyBasicAuth | null;
  headers: Record<string, string>;
  hsts: boolean;
  securityHeaders: boolean;
  compression: boolean;
  allowedIps: string[];
  deniedIps: string[];
  maxBodyBytes: number | null;

  log: CaddyLog;
  liveGateway: boolean;

  /**
   * 发布站点时记录的来源 Peer（可选；旧站点没有）。
   * 改 Peer 地址后用它找出需要同步上游的站点，兼容只靠旧 IP 文本匹配的老站点。
   */
  sourcePeer?: string;
  /** 发布站点时的上游端口；用于判断之后是否被手工改过端口（同步时保留现状并提示）。 */
  sourcePort?: number;
}

export interface CaddyConfig {
  sites: CaddySite[];
}

export interface CaddyConfigState {
  config: CaddyConfig;
  rev: number | null;
  appliedRev: number | null;
  exists: boolean;
}

export interface CaddySiteHealth {
  name: string;
  domain: string;
  state: HealthState;
  status: number | null;
  latencyMs: number | null;
  error: string | null;
  upstreams: string[];
}

export interface CaddyStatus {
  /** 适配器未上报时为 null（未知），只有明确 false 才提示未安装 */
  installed: boolean | null;
  running: boolean;
  version: string | null;
  unit: string | null;
  sites: CaddySiteHealth[];
  siteCount: number;
  siteHealth: CaddySiteHealth[];
  validateOk: boolean | null;
  validateMessage: string | null;
  lastReloadAt: string | null;
  lastReloadOk: boolean | null;
  caddyfile: string | null;
  snippet: string | null;
  error: string | null;
}

export interface CaddyRuntime {
  reachable: boolean;
  error: string | null;
  status: CaddyStatus | null;
}

export interface CaddyServiceInfo {
  version: string | null;
  active: boolean | null;
  installed: boolean | null;
  unit: string | null;
  caddyfile: string | null;
  snippet: string | null;
  validateOk: boolean | null;
  validateMessage: string | null;
  lastReloadAt: string | null;
  lastReloadOk: boolean | null;
  lastError: string | null;
}

export interface CaddyConfigExport {
  caddyfile: string;
  snippets: string[];
}

export interface CaddyValidateResult {
  ok: boolean;
  message: string | null;
  rc: number | null;
  details: string | null;
}

export interface CaddyEnvelope extends AgentEnvelope {
  result?: NonNullable<AgentEnvelope['result']> & Record<string, unknown>;
  version?: unknown;
  active?: unknown;
  installed?: unknown;
  unit?: unknown;
  caddyfile?: unknown;
  snippets?: unknown;
  config?: unknown;
  content?: unknown;
  validate?: unknown;
  lastReloadAt?: unknown;
  lastReloadOk?: unknown;
  lastError?: unknown;
  passwordHash?: unknown;
}

export const DEFAULT_TLS_PORT = 443;
export const DEFAULT_REDIRECT_CODE = 301;
export const LB_POLICIES: LbPolicy[] = ['round_robin', 'random', 'least_conn', 'ip_hash'];
export const TLS_MODES: TlsMode[] = ['auto', 'manual', 'internal', 'off'];
export const SITE_KINDS: SiteKind[] = ['proxy', 'static', 'redirect'];

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function asRecordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}

function normalizeKind(value: unknown): SiteKind {
  return value === 'static' || value === 'redirect' ? value : 'proxy';
}

function normalizeTlsMode(value: unknown): TlsMode {
  if (value === 'manual' || value === 'internal' || value === 'off') return value;
  return 'auto';
}

function normalizeLbPolicy(value: unknown): LbPolicy {
  if (value === 'random' || value === 'least_conn' || value === 'ip_hash') return value;
  return 'round_robin';
}

function normalizeHeaders(value: unknown): Record<string, string> {
  const record = asRecord(value);
  const headers: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string') headers[key] = item;
  }
  return headers;
}

function normalizePathRoutes(value: unknown): CaddyPathRoute[] {
  return asRecordList(value)
    .map((item) => ({
      path: asString(item.path),
      upstreams: asStringList(item.upstreams),
    }))
    .filter((route) => route.path.length > 0);
}

function normalizeLog(value: unknown): CaddyLog {
  const log = asRecord(value);
  return {
    enabled: asBoolean(log.enabled),
    path: asString(log.path),
  };
}

export function emptyCaddyConfig(): CaddyConfig {
  return { sites: [] };
}

/** 旧配置（domain/upstream/auto|manual|off）自动规范化，新字段缺失给默认值。 */
export function normalizeCaddySite(raw: unknown): CaddySite | null {
  const site = asRecord(raw);
  const domains = asStringList(site.domains);
  const legacyDomain = asString(site.domain);
  if (domains.length === 0 && legacyDomain) domains.push(legacyDomain);
  const domain = legacyDomain || domains[0] || '';
  if (!domain) return null;

  const upstreams = asStringList(site.upstreams);
  const legacyUpstream = asString(site.upstream);
  if (upstreams.length === 0 && legacyUpstream) upstreams.push(legacyUpstream);

  const tls = asRecord(site.tls);
  const certRecord = asRecord(tls.cert);
  const certId = asString(certRecord.$cert);
  const basic = asRecord(site.basicauth);
  const user = asString(basic.user);
  const passwordHash = asString(basic.passwordHash);
  const index = asString(site.index, 'index.html') || 'index.html';
  const redirectCode = asNumber(site.redirectCode, DEFAULT_REDIRECT_CODE) || DEFAULT_REDIRECT_CODE;

  return {
    name: asString(site.name) || domain,
    kind: normalizeKind(site.kind),
    domain,
    domains,
    listenPort: asNumber(site.listenPort, DEFAULT_TLS_PORT),
    enabled: asBoolean(site.enabled, true),
    upstream: legacyUpstream || upstreams[0] || '',
    upstreams,
    lbPolicy: normalizeLbPolicy(site.lbPolicy),
    healthUri: asString(site.healthUri),
    pathRoutes: normalizePathRoutes(site.pathRoutes),
    root: asString(site.root),
    browse: asBoolean(site.browse),
    spa: asBoolean(site.spa),
    index,
    tryFiles: asStringList(site.tryFiles),
    redirectTo: asString(site.redirectTo),
    redirectCode,
    tls: { mode: normalizeTlsMode(tls.mode), cert: certId ? { $cert: certId } : null },
    forceTls13: asBoolean(site.forceTls13),
    basicauth: user || passwordHash ? { user, passwordHash } : null,
    headers: normalizeHeaders(site.headers),
    hsts: asBoolean(site.hsts),
    securityHeaders: asBoolean(site.securityHeaders),
    compression: asBoolean(site.compression),
    allowedIps: asStringList(site.allowedIps),
    deniedIps: asStringList(site.deniedIps),
    maxBodyBytes: asNullableNumber(site.maxBodyBytes),
    log: normalizeLog(site.log),
    liveGateway: asBoolean(site.liveGateway),
    sourcePeer: asString(site.sourcePeer) || undefined,
    sourcePort: normalizePort(site.sourcePort),
  };
}

function normalizePort(value: unknown): number | undefined {
  const parsed = asNullableNumber(value);
  return parsed !== null && Number.isInteger(parsed) && parsed > 0 && parsed < 65536
    ? parsed
    : undefined;
}

/** 解析单个上游 `host:port`（IPv6 需带方括号）；无端口按 80 处理。 */
export function splitUpstreamHostPort(value: string): { host: string; port: number | null } {
  const item = String(value ?? '').trim();
  const index = item.lastIndexOf(':');
  if (index <= 0) return { host: item, port: null };
  const port = Number(item.slice(index + 1));
  return {
    host: item.slice(0, index),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
  };
}

function peerPrimaryIp(peer: { allowedIps: string[] }): string {
  return (peer.allowedIps[0] ?? '').split('/')[0] ?? '';
}

export interface PeerSiteImpact {
  site: CaddySite;
  /** 上游主机仍指向 Peer 的旧地址 */
  hostMatchesOld: boolean;
  /** 站点记录了来源 Peer 且命中 */
  fromSourcePeer: boolean;
  /** 站点当前端口与发布时记录不一致（被手工改过） */
  portManuallyChanged: boolean;
  currentHost: string;
  currentPort: number | null;
}

/**
 * 改 Peer 地址前列出受影响站点：
 * - 新站点：sourcePeer 命中；
 * - 老站点（无 sourcePeer）：上游主机等于 Peer 旧地址；
 * - 手工改过上游主机的站点也会列出，但同步时跳过并提示。
 */
export function findSitesImpactedByPeer(
  config: CaddyConfig,
  oldPeer: { name: string; allowedIps: string[] },
): PeerSiteImpact[] {
  const oldIp = peerPrimaryIp(oldPeer);
  if (!oldIp) return [];
  const impacts: PeerSiteImpact[] = [];
  for (const site of config.sites) {
    if (site.kind !== 'proxy' || site.upstreams.length === 0) continue;
    const { host, port } = splitUpstreamHostPort(site.upstreams[0] ?? '');
    const fromSourcePeer = site.sourcePeer === oldPeer.name;
    const hostMatchesOld = host === oldIp;
    if (!fromSourcePeer && !hostMatchesOld) continue;
    impacts.push({
      site,
      hostMatchesOld,
      fromSourcePeer,
      portManuallyChanged: site.sourcePort !== undefined && port !== site.sourcePort,
      currentHost: host,
      currentPort: port,
    });
  }
  return impacts;
}

/**
 * 把指向 Peer 旧地址的上游同步到新地址：
 * - 只替换主机，保留各站点当前端口（手工改过端口不会被覆盖）；
 * - 来源 Peer 命中但上游已被手工改到别处的站点跳过，由调用方提示。
 */
export function syncSitesToPeer(
  config: CaddyConfig,
  oldPeer: { name: string; allowedIps: string[] },
  newIp: string,
): { config: CaddyConfig; updated: string[]; skipped: string[] } {
  const oldIp = peerPrimaryIp(oldPeer);
  if (!oldIp || !newIp || oldIp === newIp) {
    return { config, updated: [], skipped: [] };
  }
  const updated: string[] = [];
  const skipped: string[] = [];
  const sites = config.sites.map((site) => {
    if (site.kind !== 'proxy' || site.upstreams.length === 0) return site;
    const fromSourcePeer = site.sourcePeer === oldPeer.name;
    const matchesOld = site.upstreams.some(
      (upstream) => splitUpstreamHostPort(upstream).host === oldIp,
    );
    if (!fromSourcePeer && !matchesOld) return site;
    if (!matchesOld) {
      skipped.push(site.name);
      return site;
    }
    const upstreams = site.upstreams.map((upstream) => {
      const { host, port } = splitUpstreamHostPort(upstream);
      return host === oldIp ? `${newIp}:${port ?? 80}` : upstream;
    });
    updated.push(site.name);
    return { ...site, upstream: upstreams[0] ?? '', upstreams };
  });
  return { config: { ...config, sites }, updated, skipped };
}

export function normalizeCaddyConfig(raw: Record<string, unknown> | null | undefined): CaddyConfig {
  const source = asRecord(raw);
  const sites = Array.isArray(source.sites)
    ? source.sites.map(normalizeCaddySite).filter((site): site is CaddySite => site !== null)
    : [];
  return { sites };
}

function parseHealthState(value: unknown): HealthState {
  return value === 'ok' || value === 'warn' || value === 'down' ? value : 'unknown';
}

function parseSiteHealth(value: unknown): CaddySiteHealth | null {
  const health = asRecord(value);
  const domain = asString(health.domain);
  const name = asString(health.name) || domain;
  if (!name && !domain) return null;
  return {
    name,
    domain,
    state: parseHealthState(health.state),
    status: asNullableNumber(health.status),
    latencyMs: asNullableNumber(health.latencyMs),
    error: typeof health.error === 'string' ? health.error : null,
    upstreams: asStringList(health.upstreams),
  };
}

export function parseCaddyStatus(
  adapters: readonly { name: string; status?: Record<string, unknown> }[] | undefined,
): CaddyStatus | null {
  const adapter = adapters?.find((item) => item.name === CADDY_SITE_APP);
  if (!adapter) return null;
  const status = asRecord(adapter.status);
  const rawSites = status.sites;

  // 兼容旧状态（sites 为 [{active,error}] 数组）；新适配器使用 siteHealth + 站点数
  const legacySites: CaddySiteHealth[] = asRecordList(rawSites).flatMap((item) => {
    const site = asRecord(item);
    const domain = asString(site.domain);
    const name = asString(site.name) || domain;
    if (!name && !domain) return [];
    const error = typeof site.error === 'string' ? site.error : null;
    const active = asBoolean(site.active ?? site.online ?? site.running);
    const health: CaddySiteHealth = {
      name,
      domain,
      state: error ? 'down' : active ? 'ok' : 'unknown',
      status: null,
      latencyMs: null,
      error,
      upstreams: [],
    };
    return [health];
  });

  const siteHealth = Array.isArray(status.siteHealth)
    ? status.siteHealth
        .map(parseSiteHealth)
        .filter((item): item is CaddySiteHealth => item !== null)
    : legacySites;

  const validate = asRecord(status.validate);
  const validateOk = typeof validate.ok === 'boolean' ? validate.ok : null;
  const validateMessage =
    typeof validate.message === 'string' && validate.message.trim() ? validate.message : null;
  const lastReloadOk = typeof status.lastReloadOk === 'boolean' ? status.lastReloadOk : null;
  const lastError = typeof status.lastError === 'string' ? status.lastError : null;
  const running = asBoolean(status.running ?? status.active);
  const installed =
    typeof status.installed === 'boolean'
      ? status.installed
      : running || validateOk === true
        ? true
        : null;
  const siteCount =
    siteHealth.length > 0
      ? siteHealth.length
      : Array.isArray(rawSites)
        ? rawSites.length
        : asNumber(rawSites);
  const lastReloadRaw = status.lastReloadAt;
  const lastReloadAt =
    typeof lastReloadRaw === 'string'
      ? lastReloadRaw
      : typeof lastReloadRaw === 'number'
        ? String(lastReloadRaw)
        : null;

  return {
    installed,
    running,
    version: typeof status.version === 'string' ? status.version : null,
    unit: typeof status.unit === 'string' ? status.unit : null,
    sites: siteHealth,
    siteCount,
    siteHealth,
    validateOk,
    validateMessage,
    lastReloadAt,
    lastReloadOk,
    caddyfile: typeof status.caddyfile === 'string' ? status.caddyfile : null,
    snippet: typeof status.snippet === 'string' ? status.snippet : null,
    error:
      lastReloadOk === false && lastError
        ? lastError
        : validateOk === false
          ? validateMessage
          : null,
  };
}

export function healthForSite(
  status: CaddyStatus | null,
  site: Pick<CaddySite, 'name' | 'domain'>,
): CaddySiteHealth | null {
  if (!status) return null;
  return (
    status.siteHealth.find(
      (item) =>
        (item.name && item.name === site.name) || (item.domain && item.domain === site.domain),
    ) ?? null
  );
}

export const caddyConfigQueryOptions = (hubId: string) =>
  queryOptions({
    queryKey: ['hubs', hubId, 'apps', CADDY_SITE_APP],
    queryFn: () => fetchAppConfig(hubId, CADDY_SITE_APP),
    select: (data: AppConfig | null): CaddyConfigState => ({
      config: normalizeCaddyConfig(data?.config ?? null),
      rev: data?.rev ?? null,
      appliedRev: data?.appliedRev ?? null,
      exists: Boolean(data),
    }),
    staleTime: 5_000,
    enabled: Boolean(hubId),
  });

export async function saveCaddyConfig(hubId: string, config: CaddyConfig): Promise<AppConfig> {
  return saveAppConfig(hubId, CADDY_SITE_APP, config as unknown as Record<string, unknown>);
}

export type CaddyActionName =
  | 'plan'
  | 'apply'
  | 'hash_password'
  | 'caddy_service'
  | 'caddy_validate'
  | 'caddy_reload'
  | 'caddy_start'
  | 'caddy_config'
  | 'caddy_import_scan'
  | 'caddy_import_preview'
  | 'caddy_import_takeover'
  | 'caddy_import_restore'
  | 'install';

export async function runCaddyAction(
  hubId: string,
  action: CaddyActionName,
  params: Record<string, unknown> = {},
): Promise<CaddyEnvelope> {
  const body = await apiRequest(
    `/api/v1/nodes/${encodeURIComponent(hubId)}/apps/${CADDY_SITE_APP}/${action}`,
    { method: 'POST', body: JSON.stringify({ params }) },
  );
  return agentEnvelopeSchema.parse(body) as CaddyEnvelope;
}

/** hash_password 返回 bcrypt 哈希：兼容 result.hash / result.cards[0].value / 顶层。 */
export function extractPasswordHash(envelope: CaddyEnvelope): string | null {
  const result = envelope.result;
  const candidates = [
    result?.passwordHash,
    result?.hash,
    result?.value,
    result?.cards?.[0]?.value,
    envelope.passwordHash,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

export function envelopeErrorText(envelope: CaddyEnvelope): string | null {
  if (envelope.ok) return null;
  const message = envelope.error?.message ?? '';
  const friendly = friendlyAgentError(message);
  // 旧 Agent 能力缺失：只给升级引导，不再把「未知动作: xxx」原始细节摊给用户。
  if (friendly && friendly !== message) return friendly;
  const details = envelope.error?.details;
  if (details && Object.keys(details).length > 0) {
    try {
      return `${message}（${JSON.stringify(details)}）`;
    } catch {
      return message || '应用操作失败';
    }
  }
  return friendly || null;
}

function pickString(
  primary: Record<string, unknown>,
  fallback: Record<string, unknown>,
  key: string,
): string | null {
  const value = primary[key] ?? fallback[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function pickBoolean(
  primary: Record<string, unknown>,
  fallback: Record<string, unknown>,
  key: string,
): boolean | null {
  const value = primary[key] ?? fallback[key];
  return typeof value === 'boolean' ? value : null;
}

/** caddy_service / caddy_validate 结果 → 服务状态（容忍 result / 顶层两种形态）。 */
export function extractCaddyService(
  envelope: CaddyEnvelope,
  validate?: CaddyValidateResult | null,
): CaddyServiceInfo {
  const result = asRecord(envelope.result);
  const top = envelope as unknown as Record<string, unknown>;
  const validateRecord = asRecord(result.validate ?? top.validate);
  const validateOk =
    validate?.ok ??
    (typeof validateRecord.ok === 'boolean'
      ? validateRecord.ok
      : pickBoolean(result, top, 'validateOk'));
  const validateMessage =
    validate?.message ??
    (typeof validateRecord.message === 'string' ? validateRecord.message : null) ??
    pickString(result, top, 'validateMessage');
  return {
    version: pickString(result, top, 'version'),
    active: pickBoolean(result, top, 'active') ?? pickBoolean(result, top, 'running'),
    installed: pickBoolean(result, top, 'installed'),
    unit: pickString(result, top, 'unit'),
    caddyfile: pickString(result, top, 'caddyfile'),
    snippet: pickString(result, top, 'snippet'),
    validateOk: validateOk ?? null,
    validateMessage,
    lastReloadAt: pickString(result, top, 'lastReloadAt'),
    lastReloadOk: pickBoolean(result, top, 'lastReloadOk'),
    lastError: pickString(result, top, 'lastError'),
  };
}

/** caddy_validate 结果 → {ok,message,rc}。 */
export function extractCaddyValidate(envelope: CaddyEnvelope): CaddyValidateResult {
  const result = asRecord(envelope.result);
  const top = envelope as unknown as Record<string, unknown>;
  const validate = asRecord(result.validate ?? top.validate);
  const okValue = validate.ok ?? result.ok ?? envelope.ok;
  const messageValue = validate.message ?? result.message ?? top.error;
  const rcValue = validate.rc ?? result.rc;
  const detailsValue = validate.details ?? result.details ?? asRecord(envelope.error).details;
  let details: string | null = null;
  if (detailsValue !== undefined && detailsValue !== null && detailsValue !== '') {
    details =
      typeof detailsValue === 'string'
        ? detailsValue
        : (() => {
            try {
              return JSON.stringify(detailsValue, null, 2);
            } catch {
              return null;
            }
          })();
  }
  return {
    ok: typeof okValue === 'boolean' ? okValue : false,
    message: typeof messageValue === 'string' && messageValue.trim() ? messageValue : null,
    rc: typeof rcValue === 'number' ? rcValue : null,
    details,
  };
}

/** caddy_config 结果 → 主 Caddyfile + 托管片段。 */
export function extractCaddyConfig(envelope: CaddyEnvelope): CaddyConfigExport {
  const result = asRecord(envelope.result);
  const top = envelope as unknown as Record<string, unknown>;
  const caddyfile =
    pickString(result, top, 'content') ??
    pickString(result, top, 'caddyfile') ??
    pickString(result, top, 'config') ??
    '';
  const rawSnippets = result.snippets ?? top.snippets;
  const snippets = Array.isArray(rawSnippets)
    ? rawSnippets.flatMap((item) => {
        if (typeof item === 'string') return item.trim() ? [item] : [];
        const snippet = asRecord(item);
        const content =
          asString(snippet.content) || asString(snippet.snippet) || asString(snippet.text);
        return content.trim() ? [content] : [];
      })
    : [];
  return { caddyfile, snippets };
}

/** 主 Caddyfile 里已存在、尚未由面板托管的站点块。 */
export interface ExternalSiteBlock {
  id: string;
  hash: string;
  address: string;
  startLine: number;
  endLine: number;
  text: string;
  supported: boolean;
  reason: string | null;
  domains: string[];
  listenPort: number;
  kind: SiteKind;
  upstreams: string[];
  lbPolicy: LbPolicy;
  healthUri: string;
  root: string;
  browse: boolean;
  redirectTo: string;
  redirectCode: number;
  tlsMode: TlsMode;
  headers: Record<string, string>;
  compression: boolean;
  logEnabled: boolean;
  logPath: string;
}

export interface CaddyBackupInfo {
  path: string;
  name: string;
  updatedAt: string;
}

export interface CaddyImportScan {
  exists: boolean;
  caddyfilePath: string;
  caddyfileHash: string | null;
  blocks: ExternalSiteBlock[];
  imports: string[];
  backups: CaddyBackupInfo[];
}

export interface CaddyImportTakeoverResult {
  backupPath: string;
  caddyfilePath: string;
  startLine: number;
  endLine: number;
}

export async function fetchCaddyImportScan(hubId: string): Promise<CaddyImportScan> {
  const envelope = await runCaddyAction(hubId, 'caddy_import_scan');
  const error = envelopeErrorText(envelope);
  if (error) throw new Error(error);
  return extractCaddyImportScan(envelope);
}

export const caddyImportScanQueryOptions = (hubId: string) =>
  queryOptions({
    queryKey: ['hubs', hubId, 'apps', CADDY_SITE_APP, 'import-scan'],
    queryFn: () => fetchCaddyImportScan(hubId),
    staleTime: 10_000,
    enabled: Boolean(hubId),
  });

/** caddy_import_scan 结果 → 外部站点清单（容忍 result / 顶层两种形态）。 */
export function extractCaddyImportScan(envelope: CaddyEnvelope): CaddyImportScan {
  const result = asRecord(envelope.result);
  const top = envelope as unknown as Record<string, unknown>;
  const blocks = (Array.isArray(result.blocks) ? result.blocks : top.blocks);
  return {
    exists: asBoolean(result.exists ?? top.exists, true),
    caddyfilePath: asString(result.caddyfilePath ?? top.caddyfilePath),
    caddyfileHash: pickString(result, top, 'caddyfileHash'),
    imports: asStringList(result.imports ?? top.imports),
    backups: asRecordList(result.backups ?? top.backups).map((item) => ({
      path: asString(item.path),
      name: asString(item.name),
      updatedAt: asString(item.updatedAt),
    })),
    blocks: asRecordList(blocks).map((item) => ({
      id: asString(item.id),
      hash: asString(item.hash),
      address: asString(item.address),
      startLine: asNumber(item.startLine, 0),
      endLine: asNumber(item.endLine, 0),
      text: asString(item.text),
      supported: asBoolean(item.supported),
      reason: typeof item.reason === 'string' ? item.reason : null,
      domains: asStringList(item.domains),
      listenPort: asNumber(item.listenPort, DEFAULT_TLS_PORT),
      kind: normalizeKind(item.kind),
      upstreams: asStringList(item.upstreams),
      lbPolicy: normalizeLbPolicy(item.lbPolicy),
      healthUri: asString(item.healthUri),
      root: asString(item.root),
      browse: asBoolean(item.browse),
      redirectTo: asString(item.redirectTo),
      redirectCode: asNumber(item.redirectCode, DEFAULT_REDIRECT_CODE),
      tlsMode: normalizeTlsMode(item.tlsMode),
      headers: normalizeHeaders(item.headers),
      compression: asBoolean(item.compression),
      logEnabled: asBoolean(item.logEnabled),
      logPath: asString(item.logPath),
    })),
  };
}

export interface CaddyImportPreview {
  hash: string;
  address: string;
  startLine: number;
  endLine: number;
  supported: boolean;
  reason: string | null;
  site: Record<string, unknown> | null;
  snippet: string | null;
  remove: { startLine: number; endLine: number; text: string } | null;
  importInfo: { line: string; present: boolean; willAppend: boolean } | null;
  validate: { ok: boolean; rc: number | null; message: string | null } | null;
  caddyfileHash: string | null;
}

export async function fetchCaddyImportPreview(
  hubId: string,
  hash: string,
): Promise<CaddyImportPreview> {
  const envelope = await runCaddyAction(hubId, 'caddy_import_preview', { hash });
  const error = envelopeErrorText(envelope);
  if (error) throw new Error(error);
  return extractCaddyImportPreview(envelope);
}

export const caddyImportPreviewQueryOptions = (hubId: string, hash: string, enabled: boolean) =>
  queryOptions({
    queryKey: ['hubs', hubId, 'apps', CADDY_SITE_APP, 'import-preview', hash],
    queryFn: () => fetchCaddyImportPreview(hubId, hash),
    staleTime: 0,
    enabled: Boolean(hubId) && Boolean(hash) && enabled,
  });

/** caddy_import_preview 结果 → 影子导入预览（只读，不落盘）。 */
export function extractCaddyImportPreview(envelope: CaddyEnvelope): CaddyImportPreview {
  const result = asRecord(envelope.result);
  const top = envelope as unknown as Record<string, unknown>;
  const source = Object.keys(result).length > 0 ? result : top;
  const remove = asRecord(source.remove);
  const importInfo = asRecord(source.import);
  const validate = asRecord(source.validate);
  const site = asRecord(source.site);
  return {
    hash: asString(source.hash),
    address: asString(source.address),
    startLine: asNumber(source.startLine, 0),
    endLine: asNumber(source.endLine, 0),
    supported: asBoolean(source.supported),
    reason: typeof source.reason === 'string' ? source.reason : null,
    site: Object.keys(site).length > 0 ? site : null,
    snippet: typeof source.snippet === 'string' && source.snippet ? source.snippet : null,
    remove: Object.keys(remove).length > 0
      ? {
          startLine: asNumber(remove.startLine, 0),
          endLine: asNumber(remove.endLine, 0),
          text: asString(remove.text),
        }
      : null,
    importInfo: Object.keys(importInfo).length > 0
      ? {
          line: asString(importInfo.line),
          present: asBoolean(importInfo.present),
          willAppend: asBoolean(importInfo.willAppend),
        }
      : null,
    validate: Object.keys(validate).length > 0
      ? {
          ok: asBoolean(validate.ok),
          rc: typeof validate.rc === 'number' ? validate.rc : null,
          message: typeof validate.message === 'string' ? validate.message : null,
        }
      : null,
    caddyfileHash: pickString(result, top, 'caddyfileHash'),
  };
}

export function uniqueSiteName(config: CaddyConfig, base: string): string {
  const used = new Set(config.sites.map((site) => site.name));
  if (!used.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-imported`;
}

/** 外部站点块 → 面板站点草稿；不可映射时返回 null。 */
export function externalBlockToSite(config: CaddyConfig, block: ExternalSiteBlock): CaddySite | null {
  const domain = block.domains[0] ?? '';
  if (!domain) return null;
  const raw: Record<string, unknown> = {
    name: uniqueSiteName(config, domain),
    kind: block.kind,
    domains: block.domains,
    listenPort: block.listenPort,
    enabled: true,
    upstreams: block.upstreams,
    lbPolicy: block.lbPolicy,
    healthUri: block.healthUri,
    root: block.root,
    browse: block.browse,
    redirectTo: block.redirectTo,
    redirectCode: block.redirectCode,
    tls: { mode: block.tlsMode, cert: null },
    headers: block.headers,
    compression: block.compression,
    log: { enabled: block.logEnabled, path: block.logPath },
  };
  return normalizeCaddySite(raw);
}

/** 与面板现有站点比对域名/端口；返回冲突说明，无冲突返回 null。 */
export function importConflict(
  config: CaddyConfig,
  block: Pick<ExternalSiteBlock, 'domains' | 'listenPort'>,
): string | null {
  const domains = new Set(block.domains.map((item) => item.toLowerCase()));
  for (const site of config.sites) {
    if (!site.enabled) continue;
    const sameDomain = site.domains.some((item) => domains.has(item.toLowerCase()));
    if (sameDomain) return `域名已被面板站点 ${site.name} 使用`;
    if (site.listenPort === block.listenPort && site.domains.length === 0) {
      return `端口 ${block.listenPort} 已被面板站点 ${site.name} 使用`;
    }
  }
  return null;
}

export function upsertSite(config: CaddyConfig, site: CaddySite, previousName?: string): CaddyConfig {
  const target = previousName ?? site.name;
  const index = config.sites.findIndex((item) => item.name === target);
  const sites = [...config.sites];
  if (index >= 0) sites[index] = site;
  else sites.push(site);
  return { ...config, sites };
}

export function removeSite(config: CaddyConfig, name: string): CaddyConfig {
  return { ...config, sites: config.sites.filter((site) => site.name !== name) };
}

export function setSiteEnabled(config: CaddyConfig, name: string, enabled: boolean): CaddyConfig {
  return {
    ...config,
    sites: config.sites.map((site) => (site.name === name ? { ...site, enabled } : site)),
  };
}

export function parseList(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function formatList(values: string[]): string {
  return values.join(', ');
}

export function parseHeadersText(text: string): Record<string, string> {
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求头需要是 JSON 对象');
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new Error('请求头值需要是字符串');
    headers[key] = value;
  }
  return headers;
}

export function formatHeaders(headers: Record<string, string>): string {
  return Object.keys(headers).length > 0 ? JSON.stringify(headers, null, 2) : '';
}

export function tlsModeLabelKey(
  mode: TlsMode,
): 'tlsAuto' | 'tlsManual' | 'tlsInternal' | 'tlsOff' {
  return mode === 'manual'
    ? 'tlsManual'
    : mode === 'internal'
      ? 'tlsInternal'
      : mode === 'off'
        ? 'tlsOff'
        : 'tlsAuto';
}

export function kindLabelKey(kind: SiteKind): 'kindProxy' | 'kindStatic' | 'kindRedirect' {
  return kind === 'static' ? 'kindStatic' : kind === 'redirect' ? 'kindRedirect' : 'kindProxy';
}
