/**
 * 对外服务 · 后端识别（page-specs §2.2a / ADR-0017）。
 *
 * **纯函数，不发请求、不读时钟、不依赖 React。** 输入只有站点的上游地址与
 * `/state` 里 WireGuard 的运行态（已由页面拉取），输出「后端是谁、通不通」。
 *
 * 边界：
 * - 端口转发**不参与**判定：它只是把端口映射出去，不代表站点后端；
 * - WireGuard 未安装（`installed === false`）时，10.x 等私网地址一律归「外部」；
 * - 只有拿不到 WireGuard 状态（`undefined`）时，私网地址才归「内网（未登记）」，
 *   不猜测 Peer；
 * - 多上游只识别第一个，其余以 `extra` 计数。
 */

export type BackendKind = 'local' | 'vm' | 'internal' | 'external' | 'unix';

export interface BackendPeerInput {
  name: string;
  allowedIps: readonly string[];
  online?: boolean | null;
}

export interface BackendContext {
  /** `/state` 的 wireguard 适配器；`undefined` = 状态未读取。 */
  wireguard?: { installed: boolean; peers: readonly BackendPeerInput[] } | null;
}

export interface BackendInfo {
  kind: BackendKind;
  /** 去 scheme/路径后的 `host:port`（unix 套接字为原值）。 */
  target: string;
  host: string;
  port: string | null;
  peerName?: string;
  peerOnline?: boolean | null;
  /** 同站点其它上游的数量（pathRoutes / 多 upstreams）。 */
  extra: number;
}

/** 本机回环（含 IPv6 方括号）。 */
function isLoopback(host: string): boolean {
  const value = host.toLowerCase();
  return (
    value === 'localhost' ||
    value === '::1' ||
    value === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
  );
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  const [a, b, c, d] = nums;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** IPv4 是否在 `addr/prefix` 内；非 IPv4 或非法 CIDR 返回 false。 */
export function ipv4InCidr(ip: string, cidr: string): boolean {
  const parts = cidr.trim().split('/');
  const base = parts[0] ?? '';
  const prefix = parts[1] === undefined ? 32 : Number(parts[1]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const value = ipv4ToInt(ip);
  const start = ipv4ToInt(base);
  if (value === null || start === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (start & mask) >>> 0;
}

/** RFC1918 + IPv6 ULA（fc00::/7）。 */
function isPrivate(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^fc|^fd/.test(value) && value.includes(':')) return true;
  return (
    ipv4InCidr(value, '10.0.0.0/8') ||
    ipv4InCidr(value, '172.16.0.0/12') ||
    ipv4InCidr(value, '192.168.0.0/16')
  );
}

function parseUpstream(raw: string): { unix: boolean; target: string; host: string; port: string | null } {
  let value = raw.trim();
  if (value.startsWith('unix//') || value.startsWith('unix:')) {
    return { unix: true, target: value, host: '', port: null };
  }
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const slash = value.indexOf('/');
  if (slash >= 0) value = value.slice(0, slash);

  // [IPv6]:port
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (v6) return { unix: false, target: value, host: v6[1] ?? '', port: v6[2] ?? null };

  const idx = value.lastIndexOf(':');
  // 裸 IPv6（无方括号）没有端口概念：冒号多于 1 个时整串当 host。
  if (idx > 0 && value.indexOf(':') === idx) {
    return { unix: false, target: value, host: value.slice(0, idx), port: value.slice(idx + 1) };
  }
  return { unix: false, target: value, host: value, port: null };
}

function matchPeer(host: string, peers: readonly BackendPeerInput[]): BackendPeerInput | undefined {
  const value = host.toLowerCase();
  return peers.find((peer) =>
    peer.allowedIps.some((cidr) => {
      const parts = cidr.trim().split('/');
      const base = (parts[0] ?? '').toLowerCase();
      const prefix = parts[1];
      if (prefix === undefined || prefix === '32' || prefix === '128') {
        return base === value;
      }
      return ipv4InCidr(value, cidr);
    }),
  );
}

/**
 * 识别站点后端的归属。
 *
 * @param raw 站点的第一个上游（`host:port` / `scheme://host:port` / `unix//path`）
 * @param ctx `undefined` 或 `wireguard` 缺失 = 状态未读取；`installed === false` = 未安装
 * @param extra 额外上游/pathRoutes 数量
 */
export function classifyBackend(raw: string, ctx: BackendContext, extra = 0): BackendInfo {
  const parsed = parseUpstream(raw);
  const base = { target: parsed.target, host: parsed.host, port: parsed.port, extra };
  if (parsed.unix) return { ...base, kind: 'unix' };
  if (isLoopback(parsed.host)) return { ...base, kind: 'local' };

  const wg = ctx.wireguard;
  if (!wg) {
    // 状态未读取：只能按地址形态给出中性判断，不猜 Peer。
    return { ...base, kind: isPrivate(parsed.host) ? 'internal' : 'external' };
  }
  if (!wg.installed) {
    // WireGuard 未安装：私网地址没有可达路径，按「外部」显示。
    return { ...base, kind: 'external' };
  }
  const peer = matchPeer(parsed.host, wg.peers);
  if (peer) {
    return { ...base, kind: 'vm', peerName: peer.name, peerOnline: peer.online ?? null };
  }
  return { ...base, kind: isPrivate(parsed.host) ? 'internal' : 'external' };
}

/* --------------------------------------------- 本机监听端口（T-C，批次 3） */

/**
 * `/state.ops.network.listening.items[]` 的前端本地类型。契约里 `network` 是
 * `record(string, unknown)`，旧 Agent 不上报该键；这里只做安全解析，不改契约、
 * 不进诊断目录。
 */
export interface ListeningPort {
  proto: string;
  address: string;
  port: number;
  /** 新 Agent 上报的 socket 归属进程名；旧 Agent 不上报时保持 undefined。 */
  process?: string;
}

/** 判定「本机端口是否已发布」时只需要站点的上游文本与对外监听端口。 */
export interface SiteUpstreamView {
  upstream?: string;
  upstreams?: readonly string[];
  pathRoutes?: readonly { upstreams?: readonly string[] }[];
  listenPort?: number;
}

/** 端口转发自身占用的监听端口，同样不能作为站点上游。 */
export interface ForwardListenView {
  listenPort?: number | null;
}

/** 系统端口（<1024）一律不提供「发布为站点」。 */
export const MIN_PUBLISH_PORT = 1024;

/** 面板自身、Caddy 管理口等高位保留端口，不提供「发布为站点」。 */
export const RESERVED_PUBLISH_PORTS = new Set([22, 80, 443, 2019, 8880, 8899]);

/** 本机/回环监听地址：通配 0.0.0.0 / :: 也算（进程监听在本机所有网卡）。 */
export function isLocalListenAddress(address: string): boolean {
  const value = address.trim().toLowerCase();
  return value === '0.0.0.0' || value === '::' || value === '[::]' || isLoopback(value);
}

function parseListeningItems(ops: unknown): ListeningPort[] {
  if (!ops || typeof ops !== 'object') return [];
  const network = (ops as { network?: unknown }).network;
  if (!network || typeof network !== 'object') return [];
  const listening = (network as { listening?: unknown }).listening;
  if (!listening || typeof listening !== 'object') return [];
  const items = (listening as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const result: ListeningPort[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as { proto?: unknown; address?: unknown; port?: unknown; process?: unknown };
    if (
      typeof item.port !== 'number' ||
      !Number.isInteger(item.port) ||
      item.port < 1 ||
      item.port > 65535
    ) {
      continue;
    }
    const parsed: ListeningPort = {
      proto: typeof item.proto === 'string' ? item.proto : '',
      address: typeof item.address === 'string' ? item.address : '',
      port: item.port,
    };
    if (typeof item.process === 'string' && item.process.trim()) {
      parsed.process = item.process.trim().slice(0, 64);
    }
    result.push(parsed);
  }
  return result;
}

/** 已被发布为本机站点的端口：遍历 upstreams 与 pathRoutes，只统计本机/回环上游并去重。 */
export function publishedLocalPorts(sites: readonly SiteUpstreamView[]): number[] {
  const ports = new Set<number>();
  const add = (raw: string) => {
    const parsed = parseUpstream(raw);
    if (parsed.unix || parsed.port === null || !isLocalListenAddress(parsed.host)) return;
    const port = Number(parsed.port);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
  };
  for (const site of sites) {
    if (site.upstream) add(site.upstream);
    for (const raw of site.upstreams ?? []) add(raw);
    for (const route of site.pathRoutes ?? []) {
      for (const raw of route.upstreams ?? []) add(raw);
    }
  }
  return [...ports];
}

function isPortNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * 点击端口预填的上游地址：IPv6 具体地址（如 `::1`）必须带方括号，否则
 * 只监听 `::1` 的程序发布后会 502；通配地址与 IPv4 回环统一走 `127.0.0.1`。
 */
export function listeningUpstream(row: ListeningPort): string {
  const address = row.address.trim();
  if (address.includes(':') && address !== '::' && address !== '[::]') {
    const host = address.startsWith('[') ? address : `[${address}]`;
    return `${host}:${row.port}`;
  }
  return `127.0.0.1:${row.port}`;
}

/**
 * 尚未发布为本机站点的监听端口：只收 TCP LISTEN，排除系统端口、Caddy 管理口、
 * 站点与转发的对外监听端口、非本机地址、已发布端口，并按端口去重。
 */
export function unpublishedListeningPorts(
  ops: unknown,
  sites: readonly SiteUpstreamView[],
  forwards: readonly ForwardListenView[] = [],
): ListeningPort[] {
  const occupied = new Set<number>(publishedLocalPorts(sites));
  for (const site of sites) {
    if (isPortNumber(site.listenPort)) occupied.add(site.listenPort);
  }
  for (const forward of forwards) {
    if (isPortNumber(forward.listenPort)) occupied.add(forward.listenPort);
  }
  const seen = new Set<number>();
  const result: ListeningPort[] = [];
  for (const item of parseListeningItems(ops)) {
    if (item.proto !== 'tcp' && item.proto !== 'tcp6') continue;
    if (item.port < MIN_PUBLISH_PORT || RESERVED_PUBLISH_PORTS.has(item.port)) continue;
    if (!isLocalListenAddress(item.address)) continue;
    if (occupied.has(item.port) || seen.has(item.port)) continue;
    seen.add(item.port);
    result.push(item);
  }
  return result.sort((a, b) => a.port - b.port);
}
