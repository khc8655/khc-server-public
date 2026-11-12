/**
 * WireGuard 应用数据层：配置读写、动作调用、/state 运行时状态解析。
 * 页面只能通过这里访问 API；私钥只在导出/换钥流程中短暂展示，不进入列表状态。
 */
import { queryOptions } from '@tanstack/react-query';
import {
  agentEnvelopeSchema,
  type AgentEnvelope,
  type AppConfig,
  type ResultCard,
} from '@khc/contracts';
import { apiRequest } from './client';
import { fetchAppConfig, saveAppConfig } from './apps';
import { fetchHubState } from './hubs';

export const WIREGUARD_APP = 'wireguard';

export interface WgInterface {
  name: string;
  address: string;
  listenPort: number;
  privateKey: string;
  publicKey: string;
  mtu: number;
  extIface: string;
  publicEndpoint: string;
  postUp: string;
  postDown: string;
}

export interface WgPeer {
  name: string;
  publicKey: string;
  privateKey: string;
  allowedIps: string[];
  keepalive: number;
  endpoint: string | null;
  enabled: boolean;
}

export interface WgConfig {
  interface: WgInterface;
  peers: WgPeer[];
}

export interface WgPeerRuntime {
  name: string;
  publicKey: string;
  allowedIps: string[];
  enabled: boolean;
  endpoint: string | null;
  latestHandshake: number;
  online: boolean;
  rx: number;
  tx: number;
  keepalive: number;
}

export interface WgRotation {
  peer: string;
  interface: string;
  state: 'pending' | 'cutover' | 'expired' | string;
  oldPublicKey: string;
  newPublicKey: string;
  allowedIps: string[];
  startedAt: number;
  cutoverAt: number | null;
  graceUntil: number | null;
  expiredAt: number | null;
  expiresAt: number;
  latestHandshake: number;
  online: boolean;
}

export interface WgStatus {
  installed: boolean;
  running: boolean;
  interface: string | null;
  peers: WgPeerRuntime[];
  rotations: WgRotation[];
}

export interface WgConfigState {
  config: WgConfig;
  rev: number | null;
  appliedRev: number | null;
  exists: boolean;
  /** 期望模式（与后端 desiredMode 同口径）：无 wireguard 配置行→null，禁用→caddy */
  mode: 'wg' | 'caddy' | null;
}

export interface WgRuntime {
  reachable: boolean;
  error: string | null;
  status: WgStatus | null;
}

export type WgActionName =
  | 'plan'
  | 'apply'
  | 'client_config'
  | 'peer_install_script'
  | 'peer_uninstall_script'
  | 'rotate_peer'
  | 'confirm_rotation'
  | 'cancel_rotation'
  | 'install';

export interface WgEnvelope extends AgentEnvelope {
  /** 兼容 Agent 顶层 cards；生产环境 Worker 已归一化到 result.cards */
  cards?: ResultCard[];
  rotation?: WgRotation;
  state?: string;
  peer?: string;
  /** 只读/换钥动作返回的客户端私钥（U4：面板可重复查看，仅管理员可见） */
  client?: { privateKey?: string };
}

export const DEFAULT_WG_INTERFACE: WgInterface = {
  name: 'khc0',
  address: '10.99.0.1/24',
  listenPort: 51820,
  privateKey: '',
  publicKey: '',
  mtu: 1420,
  extIface: '',
  publicEndpoint: '',
  postUp: '',
  postDown: '',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
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

/** D1 里的原始 config → 稳定结构；缺失字段落回适配器默认值。 */
export function normalizeWgConfig(raw: Record<string, unknown> | null | undefined): WgConfig {
  const source = asRecord(raw);
  const iface = asRecord(source.interface);
  const interfaceConfig: WgInterface = {
    name: asString(iface.name, DEFAULT_WG_INTERFACE.name) || DEFAULT_WG_INTERFACE.name,
    address: asString(iface.address, DEFAULT_WG_INTERFACE.address) || DEFAULT_WG_INTERFACE.address,
    listenPort: asNumber(iface.listenPort, DEFAULT_WG_INTERFACE.listenPort),
    privateKey: asString(iface.privateKey),
    publicKey: asString(iface.publicKey),
    mtu: asNumber(iface.mtu, DEFAULT_WG_INTERFACE.mtu),
    extIface: asString(iface.extIface, DEFAULT_WG_INTERFACE.extIface),
    publicEndpoint: asString(iface.publicEndpoint),
    postUp: asString(iface.postUp),
    postDown: asString(iface.postDown),
  };

  const peers = Array.isArray(source.peers)
    ? source.peers
        .map((item) => {
          const peer = asRecord(item);
          return {
            name: asString(peer.name),
            publicKey: asString(peer.publicKey),
            privateKey: asString(peer.privateKey),
            allowedIps: asStringList(peer.allowedIps),
            keepalive: asNumber(peer.keepalive, 25),
            endpoint: typeof peer.endpoint === 'string' ? peer.endpoint : null,
            enabled: asBoolean(peer.enabled, true),
          } satisfies WgPeer;
        })
        .filter((peer) => peer.name.length > 0)
    : [];

  return { interface: interfaceConfig, peers };
}

function parsePeerRuntime(value: unknown): WgPeerRuntime | null {
  const peer = asRecord(value);
  const name = asString(peer.name);
  if (!name) return null;
  return {
    name,
    publicKey: asString(peer.publicKey),
    allowedIps: asStringList(peer.allowedIps),
    enabled: asBoolean(peer.enabled, true),
    endpoint: typeof peer.endpoint === 'string' ? peer.endpoint : null,
    latestHandshake: asNumber(peer.latestHandshake),
    online: asBoolean(peer.online),
    rx: asNumber(peer.rx),
    tx: asNumber(peer.tx),
    keepalive: asNumber(peer.keepalive),
  };
}

function parseRotation(value: unknown): WgRotation | null {
  const rotation = asRecord(value);
  const peer = asString(rotation.peer);
  if (!peer) return null;
  return {
    peer,
    interface: asString(rotation.interface),
    state: asString(rotation.state, 'pending'),
    oldPublicKey: asString(rotation.oldPublicKey),
    newPublicKey: asString(rotation.newPublicKey),
    allowedIps: asStringList(rotation.allowedIps),
    startedAt: asNumber(rotation.startedAt),
    cutoverAt: asNullableNumber(rotation.cutoverAt),
    graceUntil: asNullableNumber(rotation.graceUntil),
    expiredAt: asNullableNumber(rotation.expiredAt),
    expiresAt: asNumber(rotation.expiresAt),
    latestHandshake: asNumber(rotation.latestHandshake),
    online: asBoolean(rotation.online),
  };
}

/** 从 /state 的 adapters[] 中取 wireguard 的 status；未上报时返回 null。 */
export function parseWireGuardStatus(
  adapters: readonly { name: string; status?: Record<string, unknown> }[] | undefined,
): WgStatus | null {
  const adapter = adapters?.find((item) => item.name === WIREGUARD_APP);
  if (!adapter) return null;
  const status = asRecord(adapter.status);
  const peers = Array.isArray(status.peers)
    ? status.peers.map(parsePeerRuntime).filter((peer): peer is WgPeerRuntime => peer !== null)
    : [];
  const rotations = Array.isArray(status.rotations)
    ? status.rotations.map(parseRotation).filter((item): item is WgRotation => item !== null)
    : [];
  return {
    installed: asBoolean(status.installed),
    running: asBoolean(status.running),
    interface: typeof status.interface === 'string' ? status.interface : null,
    peers,
    rotations,
  };
}

/* ---------------------------------------------------------------- queries */

/** 与 AppPage 共用缓存键，select 出 WireGuard 专用结构（含 rev/appliedRev）。 */
export const wireGuardConfigQueryOptions = (hubId: string) =>
  queryOptions({
    queryKey: ['hubs', hubId, 'apps', WIREGUARD_APP],
    queryFn: () => fetchAppConfig(hubId, WIREGUARD_APP),
    select: (data: AppConfig | null): WgConfigState => ({
      config: normalizeWgConfig(data?.config ?? null),
      rev: data?.rev ?? null,
      appliedRev: data?.appliedRev ?? null,
      exists: Boolean(data),
      mode: data ? (data.config.enabled === false ? 'caddy' : 'wg') : null,
    }),
    staleTime: 5_000,
    enabled: Boolean(hubId),
  });

/* ---------------------------------------------------------------- queries */

export async function saveWireGuardConfig(hubId: string, config: WgConfig): Promise<AppConfig> {
  return saveAppConfig(
    hubId,
    WIREGUARD_APP,
    config as unknown as Record<string, unknown>,
  );
}

export async function runWireGuardAction(
  hubId: string,
  action: WgActionName,
  params: Record<string, unknown> = {},
): Promise<WgEnvelope> {
  const body = await apiRequest(
    `/api/v1/nodes/${encodeURIComponent(hubId)}/apps/${WIREGUARD_APP}/${action}`,
    { method: 'POST', body: JSON.stringify({ params }) },
  );
  return agentEnvelopeSchema.parse(body) as WgEnvelope;
}

export function clientConfigText(envelope: WgEnvelope): string {
  return envelope.result?.cards?.[0]?.value ?? envelope.cards?.[0]?.value ?? '';
}

export function clientPrivateKey(envelope: WgEnvelope): string {
  return envelope.client?.privateKey ?? '';
}

/* ---------------------------------------------------------------- helpers */

/** 更新或插入一个 peer（按 previousName 匹配原位置，名称可改）。 */
export function upsertPeer(config: WgConfig, peer: WgPeer, previousName?: string): WgConfig {
  const target = previousName ?? peer.name;
  const index = config.peers.findIndex((item) => item.name === target);
  const peers = [...config.peers];
  if (index >= 0) {
    peers[index] = peer;
  } else {
    peers.push(peer);
  }
  return { ...config, peers };
}

export function removePeer(config: WgConfig, name: string): WgConfig {
  return { ...config, peers: config.peers.filter((peer) => peer.name !== name) };
}

export function setPeerEnabled(config: WgConfig, name: string, enabled: boolean): WgConfig {
  return {
    ...config,
    peers: config.peers.map((peer) => (peer.name === name ? { ...peer, enabled } : peer)),
  };
}

/** 目标节点里可用的 Peer 名称：重名时追加 -2、-3…（保持 32 字符上限）。 */
export function uniquePeerName(config: WgConfig, name: string): string {
  const used = new Set(config.peers.map((peer) => peer.name));
  if (!used.has(name)) return name;
  const base = name.slice(0, 28);
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-copy`;
}

/**
 * 跨节点迁移：在目标节点生成一个新的 Peer 条目。
 * 密钥留空（由目标节点 apply 时现场生成），地址从目标网段重新分配，不复用源节点密钥。
 */
export function migrationPeer(config: WgConfig, source: WgPeer): WgPeer {
  return {
    name: uniquePeerName(config, source.name),
    publicKey: '',
    privateKey: '',
    allowedIps: [nextPeerAddress(config)],
    keepalive: source.keepalive,
    endpoint: null,
    enabled: source.enabled,
  };
}

/** 下一个可用的客户端 /32 地址（从接口网段顺序分配）。 */
export function nextPeerAddress(config: WgConfig): string {
  const base = config.interface.address.split(',')[0]?.trim() ?? '';
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/\d{1,2}$/.exec(base);
  if (!match) return '10.99.0.2/32';
  const [, a, b, c, d] = match;
  const prefix = `${a}.${b}.${c}`;
  const used = new Set<number>();
  for (const peer of config.peers) {
    for (const ip of peer.allowedIps) {
      const peerMatch = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})/.exec(ip.trim());
      if (peerMatch && peerMatch[1] === prefix) {
        used.add(Number(peerMatch[2]));
      }
    }
  }
  let candidate = Number(d) + 1;
  while (used.has(candidate) && candidate < 254) candidate += 1;
  if (candidate >= 254) {
    candidate = 2;
    while (used.has(candidate) && candidate < 254) candidate += 1;
  }
  return `${prefix}.${candidate}/32`;
}

/** 流量显示：B/KB/MB/GB，1 位小数（ui-spec §5.8）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function splitAllowedIps(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isIpv4Address(value: string): boolean {
  const parts = value.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

function isIpv6Address(value: string): boolean {
  if (!value.includes(':')) return false;
  try {
    // URL 解析器对 IPv6 做完整的结构校验（::、缩写、嵌入 IPv4 都覆盖）。
    return new URL(`http://[${value}]/`).hostname.startsWith('[');
  } catch {
    return false;
  }
}

/** IPv4/IPv6 地址或 CIDR：只做结构与前缀范围校验，不判断网段是否有意义。 */
export function isValidCidr(value: string): boolean {
  const parts = value.split('/');
  if (parts.length > 2) return false;
  const address = parts[0] ?? '';
  const prefix = parts[1];
  if (!address) return false;
  const isV6 = address.includes(':');
  if (!isIpv4Address(address) && !isIpv6Address(address)) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (isV6 ? 128 : 32);
}
