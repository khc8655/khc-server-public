/**
 * 10 秒快照轮询（取代原 SSE `/_live/` 观测通道）。
 *
 * - 打开页面先拉一次；仅页面可见时每 10 秒一次；
 * - `visibilitychange` 隐藏立即停表；切回按剩余间隔恢复，不会叠加第二个循环；
 * - 硬上限：10 分钟或 60 次请求（二者等价），到顶停表并显示「已停止自动刷新 · 数据截至 xx:xx」；
 * - 有可信 HTTPS 域名：浏览器直连 Agent `/_live/snapshot?ticket=`（snap 票 15 分钟可复用，
 *   响应带 `Access-Control-Max-Age`）；无域名：经 Worker `/nodes/:id/snapshot` 转发（2s 去重）；
 * - 直连模式同源多标签经 BroadcastChannel 共享一个 10s 计时器与最近快照：只有 leader 发请求，
 *   其余读广播；leader 关闭后由最早加入的存活标签接管；任一标签可见才继续。
 * - 图表数据只进本地环形缓冲，不落任何中间存储。
 */
import { useEffect, useRef, useState } from 'react';
import {
  agentSnapshotSchema,
  liveTicketResponseSchema,
  type AgentSnapshot,
  type NodeSnapshotResponse,
} from '@khc/contracts';
import { apiRequest } from './client';

export const SNAPSHOT_POLL_MS = 10_000;
export const SNAPSHOT_MAX_POLLS = 60;
export const SNAPSHOT_MAX_SESSION_MS = 10 * 60 * 1000;
export const SNAPSHOT_RING_SIZE = 120;
export const SNAPSHOT_PATH = '/_live/snapshot';
/** 单次请求硬超时：网络中断时不让 fetch 悬挂阻塞后续 10s 轮询。 */
export const SNAPSHOT_TIMEOUT_MS = 8_000;

export type SnapshotMode = 'direct' | 'forward' | 'none';
export type SnapshotStatus = 'disabled' | 'live' | 'stopped' | 'fallback';

export interface SnapshotPoint {
  at: number;
  cpu: number | null;
  mem: number | null;
  disk: number | null;
}

export interface SnapshotState {
  status: SnapshotStatus;
  mode: SnapshotMode;
  snapshot: AgentSnapshot | null;
  /** 最近一次成功采集（本地时钟） */
  receivedAt: number | null;
  /** 最近一次请求尝试（成功或失败） */
  lastAt: number | null;
  error: string | null;
  pollCount: number;
  capped: boolean;
  history: SnapshotPoint[];
}

export interface SnapshotObservation extends SnapshotState {
  /** 手动刷新：只补一次请求，不重启自动刷新（到顶后仍可用）。 */
  refresh: () => void;
  /** 兼容旧字段名（页面上的「重新连接」按钮）。 */
  reconnect: () => void;
  /** 显式读取一次控制面快照（仅用户点击；绝不作为自动回退）。 */
  readForward: () => void;
}

const INITIAL_STATE: SnapshotState = {
  status: 'disabled',
  mode: 'none',
  snapshot: null,
  receivedAt: null,
  lastAt: null,
  error: null,
  pollCount: 0,
  capped: false,
  history: [],
};

function pointFrom(snapshot: AgentSnapshot, at: number): SnapshotPoint {
  const ops = snapshot.ops;
  return {
    at,
    cpu: ops?.cpu?.usagePercent ?? null,
    mem: ops?.mem?.percent ?? null,
    disk: ops?.disks?.[0]?.percent ?? null,
  };
}

export interface SnapshotLoopOptions {
  fetchSnapshot: () => Promise<AgentSnapshot>;
  /** 显式读取控制面快照（不受自动轮询使用）。 */
  fetchForward?: () => Promise<AgentSnapshot>;
  onUpdate: (state: SnapshotState) => void;
  mode: SnapshotMode;
  intervalMs?: number;
  maxPolls?: number;
  maxSessionMs?: number;
  ringSize?: number;
  now?: () => number;
  initiallyVisible?: boolean;
  /** 直连模式的多标签共享；转发模式不启用（去重由 Worker 尽力而为）。 */
  shared?: SharedSnapshotOptions;
}

/** 与 DOM `BroadcastChannel` 同形的最小接口，便于单测注入假通道。 */
export interface SnapshotChannelLike {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
}

export interface SharedSnapshotOptions {
  /** 同一节点一个频道，避免不同节点的标签页串数据。 */
  hubId: string;
  /** 单测可固定标签 id；默认随机。 */
  tabId?: string;
  /** 单测注入假通道；默认 `BroadcastChannel`。 */
  createChannel?: (name: string) => SnapshotChannelLike;
}

const SHARED_HEARTBEAT_MS = 2_000;
/** 超过该时间没收到心跳即视为标签已关闭/崩溃。 */
const SHARED_PEER_TTL_MS = 6_000;
/** 启动后等一小会儿 hello 互通，避免新标签抢在旧 leader 之前多发一次请求。 */
const SHARED_SETTLE_MS = 100;

interface SharedPeer {
  id: string;
  joinedAt: number;
  visible: boolean;
  /** 最近一次收到该标签消息的本地时间 */
  at: number;
}

type SharedMessage =
  | {
      type: 'hello' | 'visibility';
      id: string;
      joinedAt: number;
      visible: boolean;
      startedAt: number;
      polls: number;
    }
  | {
      type: 'state';
      id: string;
      joinedAt: number;
      at: number;
      startedAt: number;
      polls: number;
      snapshot: AgentSnapshot | null;
      error: string | null;
      status: SnapshotStatus;
      capped: boolean;
    }
  | { type: 'bye'; id: string }
  | { type: 'refresh'; id: string; joinedAt: number };

/**
 * 与 React 解耦的轮询状态机（单测可直接驱动）。
 * 保证任意时刻最多一个 setTimeout；隐藏/停止/卸载都会清理。
 */
export class SnapshotLoop {
  private readonly fetchSnapshot: () => Promise<AgentSnapshot>;
  private readonly fetchForward: (() => Promise<AgentSnapshot>) | null;
  private readonly onUpdate: (state: SnapshotState) => void;
  private readonly intervalMs: number;
  private readonly maxPolls: number;
  private readonly maxSessionMs: number;
  private readonly ringSize: number;
  private readonly now: () => number;

  private state: SnapshotState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 启动 settle 计时器；独立于轮询 timer，避免被可见性/暂停逻辑清掉后永远不 ready。 */
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private visible: boolean;
  private running = false;
  private fetching = false;
  private startedAt: number | null = null;

  private readonly shared: SharedSnapshotOptions | null;
  private channel: SnapshotChannelLike | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly tabId: string;
  private joinedAt = 0;
  private peers = new Map<string, SharedPeer>();
  private leader: boolean;
  private ready: boolean;

  constructor(options: SnapshotLoopOptions) {
    this.fetchSnapshot = options.fetchSnapshot;
    this.fetchForward = options.fetchForward ?? null;
    this.onUpdate = options.onUpdate;
    this.intervalMs = options.intervalMs ?? SNAPSHOT_POLL_MS;
    this.maxPolls = options.maxPolls ?? SNAPSHOT_MAX_POLLS;
    this.maxSessionMs = options.maxSessionMs ?? SNAPSHOT_MAX_SESSION_MS;
    this.ringSize = options.ringSize ?? SNAPSHOT_RING_SIZE;
    this.now = options.now ?? Date.now;
    this.visible = options.initiallyVisible ?? true;
    this.shared = options.shared ?? null;
    this.tabId = options.shared?.tabId ?? Math.random().toString(36).slice(2);
    this.leader = this.shared === null;
    this.ready = this.shared === null;
    this.state = { ...INITIAL_STATE, mode: options.mode };
  }

  getState(): SnapshotState {
    return this.state;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.now();
    this.joinedAt = this.now();
    if (this.shared === null) {
      void this.tick();
      return;
    }
    if (!this.openChannel()) return;
    this.post({
      type: 'hello',
      id: this.tabId,
      joinedAt: this.joinedAt,
      visible: this.visible,
      startedAt: this.startedAt,
      polls: 0,
    });
    // 先让同源其它标签回 hello/visibility，再决定是否首发；避免新标签抢跑多一次请求。
    this.clearTimer();
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      // 即使当前是 follower 也要标记 settled，后续接管 leader 时才有资格排程。
      this.ready = true;
      this.leader = this.computeLeader();
      if (!this.running || !this.leader) return;
      if (this.anyVisible()) void this.tick();
    }, SHARED_SETTLE_MS);
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.channel !== null) {
      this.post({ type: 'bye', id: this.tabId });
      this.channel.removeEventListener('message', this.handleMessage);
      this.channel.close();
      this.channel = null;
    }
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.peers.clear();
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (this.shared !== null) {
      this.post({
        type: 'visibility',
        id: this.tabId,
        joinedAt: this.joinedAt,
        visible,
        startedAt: this.startedAt ?? this.now(),
        polls: this.state.pollCount,
      });
      this.recomputeLeadership();
      return;
    }
    if (!visible) {
      this.clearTimer();
      return;
    }
    this.ensure();
  }

  /** 手动刷新一次；不受自动上限影响，但不会重启自动循环。 */
  refresh(): void {
    if (this.fetching) return;
    if (this.shared !== null && !this.leader) {
      this.post({ type: 'refresh', id: this.tabId, joinedAt: this.joinedAt });
      return;
    }
    void this.tick({ manual: true });
  }

  /**
   * 显式读取一次控制面快照（用户在「实时观测不可用」时手动点击）。
   * 不改变 mode/status，也不重启自动循环，避免变成隐式自动回退。
   */
  readForward(): void {
    if (this.fetching || this.fetchForward === null) return;
    this.fetching = true;
    this.commit({ lastAt: this.now() });
    void this.fetchForward()
      .then((snapshot) => {
        const at = this.now();
        this.commit({
          snapshot,
          receivedAt: at,
          history: [...this.state.history, pointFrom(snapshot, at)].slice(-this.ringSize),
        });
      })
      .catch((error) => {
        this.commit({ error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        this.fetching = false;
        this.postState();
      });
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private anyVisible(): boolean {
    if (this.shared === null) return this.visible;
    if (this.visible) return true;
    const now = this.now();
    for (const peer of this.peers.values()) {
      if (peer.visible && now - peer.at <= SHARED_PEER_TTL_MS) return true;
    }
    return false;
  }

  /** leader 且 ready：按剩余间隔排一次；已有计时器/无可见标签/到顶时不重复排。 */
  private ensure(): void {
    if (!this.running || !this.leader || !this.ready || this.state.capped) return;
    if (!this.anyVisible()) {
      this.clearTimer();
      return;
    }
    if (this.timer !== null) return;
    const wait =
      this.state.lastAt === null ? 0 : Math.max(0, this.intervalMs - (this.now() - this.state.lastAt));
    this.schedule(wait);
  }

  private openChannel(): boolean {
    let create = this.shared?.createChannel;
    if (create === undefined) {
      if (typeof BroadcastChannel === 'undefined') {
        this.leader = true;
        this.ready = true;
        return false;
      }
      create = (name) => new BroadcastChannel(name) as unknown as SnapshotChannelLike;
    }
    try {
      this.channel = create(`khc-snapshot:${this.shared?.hubId ?? ''}`);
    } catch {
      this.channel = null;
      this.leader = true;
      this.ready = true;
      return false;
    }
    this.channel.addEventListener('message', this.handleMessage);
    this.heartbeat = setInterval(() => this.beat(), SHARED_HEARTBEAT_MS);
    return true;
  }

  private post(message: SharedMessage): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      // 通道关闭/序列化失败不影响本标签继续轮询。
    }
  }

  private beat(): void {
    if (!this.running) return;
    this.prunePeers();
    this.post({
      type: 'visibility',
      id: this.tabId,
      joinedAt: this.joinedAt,
      visible: this.visible,
      startedAt: this.startedAt ?? this.now(),
      polls: this.state.pollCount,
    });
    this.recomputeLeadership();
  }

  private prunePeers(): void {
    const now = this.now();
    for (const [id, peer] of this.peers) {
      if (now - peer.at > SHARED_PEER_TTL_MS) this.peers.delete(id);
    }
  }

  private touch(id: string, joinedAt: number, visible?: boolean): void {
    if (id === this.tabId) return;
    const prev = this.peers.get(id);
    this.peers.set(id, {
      id,
      joinedAt: prev?.joinedAt ?? joinedAt,
      visible: visible ?? prev?.visible ?? false,
      at: this.now(),
    });
  }

  /** 自己是否为「最早加入的存活标签」；新标签不会抢走现有 leader。 */
  private computeLeader(): boolean {
    let best = { id: this.tabId, joinedAt: this.joinedAt };
    const now = this.now();
    for (const peer of this.peers.values()) {
      if (now - peer.at > SHARED_PEER_TTL_MS) continue;
      if (
        peer.joinedAt < best.joinedAt ||
        (peer.joinedAt === best.joinedAt && peer.id < best.id)
      ) {
        best = { id: peer.id, joinedAt: peer.joinedAt };
      }
    }
    return best.id === this.tabId;
  }

  private recomputeLeadership(): void {
    if (this.shared === null || !this.running) return;
    const next = this.computeLeader();
    if (!next) {
      // 只有原本在带节奏的标签才需要清掉自己的轮询 timer；follower 的 settle 计时器不能被误清。
      if (this.leader) {
        this.leader = false;
        this.clearTimer();
      }
      return;
    }
    this.leader = true;
    // 仍在启动稳定期内先等着，由 settle 回调决定是否首发；已 settled 才排程。
    if (!this.ready) return;
    if (!this.anyVisible()) {
      this.clearTimer();
      return;
    }
    this.ensure();
  }

  private readonly handleMessage = (event: { data: unknown }): void => {
    const message = event.data as SharedMessage | null;
    if (!message || typeof message !== 'object' || message.id === this.tabId) return;
    switch (message.type) {
      case 'hello':
        this.touch(message.id, message.joinedAt, message.visible);
        this.post({
          type: 'visibility',
          id: this.tabId,
          joinedAt: this.joinedAt,
          visible: this.visible,
          startedAt: this.startedAt ?? this.now(),
          polls: this.state.pollCount,
        });
        if (this.leader) this.postState();
        this.recomputeLeadership();
        break;
      case 'visibility':
        this.touch(message.id, message.joinedAt, message.visible);
        this.recomputeLeadership();
        break;
      case 'state':
        this.touch(message.id, message.joinedAt);
        this.applySharedState(message);
        break;
      case 'bye':
        this.peers.delete(message.id);
        this.recomputeLeadership();
        break;
      case 'refresh':
        if (this.leader && !this.fetching) void this.tick({ manual: true });
        break;
      default:
        break;
    }
  };

  private postState(): void {
    if (this.shared === null || !this.leader) return;
    this.post({
      type: 'state',
      id: this.tabId,
      joinedAt: this.joinedAt,
      at: this.state.lastAt ?? this.now(),
      startedAt: this.startedAt ?? this.now(),
      polls: this.state.pollCount,
      snapshot: this.state.snapshot,
      error: this.state.error,
      status: this.state.status,
      capped: this.state.capped,
    });
  }

  private applySharedState(message: Extract<SharedMessage, { type: 'state' }>): void {
    if (this.leader) return;
    this.startedAt = message.startedAt;
    const patch: Partial<SnapshotState> = {
      status: message.status,
      error: message.error,
      lastAt: message.at,
      pollCount: message.polls,
      capped: message.capped,
    };
    // hello 触发的重播可能与已有快照同一点，按 lastAt 去重，避免 follower 环形缓冲重复。
    if (message.snapshot !== null && message.at !== this.state.lastAt) {
      patch.snapshot = message.snapshot;
      patch.receivedAt = message.at;
      patch.history = [...this.state.history, pointFrom(message.snapshot, message.at)].slice(
        -this.ringSize,
      );
    }
    this.commit(patch);
    if (this.state.capped) this.clearTimer();
  }


  private cappedNow(): boolean {
    if (this.state.pollCount >= this.maxPolls) return true;
    return this.startedAt !== null && this.now() - this.startedAt >= this.maxSessionMs;
  }

  private schedule(delay: number): void {
    this.clearTimer();
    if (!this.running || this.state.capped) return;
    if (this.shared === null ? !this.visible : !this.leader || !this.anyVisible()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
  }

  private async tick(options: { manual?: boolean } = {}): Promise<void> {
    const { manual = false } = options;
    if (!this.running && !manual) return;
    // 共享模式下只有 leader 发请求；已排的 timer 可能在可见性变化后失效，这里再兜一次。
    if (!manual && this.shared !== null && (!this.leader || !this.anyVisible())) return;
    if (this.fetching) return;
    if (!manual && this.cappedNow()) {
      this.commit({ status: 'stopped', capped: true });
      this.postState();
      return;
    }

    this.fetching = true;
    this.commit({ lastAt: this.now(), pollCount: this.state.pollCount + 1 });
    try {
      const snapshot = await this.fetchSnapshot();
      if (!this.running && !manual) return;
      const at = this.now();
      const history = [...this.state.history, pointFrom(snapshot, at)].slice(-this.ringSize);
      this.commit({
        snapshot,
        receivedAt: at,
        error: null,
        history,
        status: this.cappedNow() ? 'stopped' : 'live',
        capped: this.cappedNow(),
      });
    } catch (error) {
      if (!this.running && !manual) return;
      this.commit({
        error: error instanceof Error ? error.message : String(error),
        status: this.cappedNow() ? 'stopped' : 'fallback',
        capped: this.cappedNow(),
      });
    } finally {
      this.fetching = false;
    }
    // 成功/失败/手动刷新都把最新状态广播给同源其它标签（follower 据此渲染并同步计数）。
    this.postState();

    if (manual) return;
    if (this.cappedNow()) {
      this.commit({ status: 'stopped', capped: true });
      this.postState();
      return;
    }
    const elapsed = this.state.lastAt === null ? this.intervalMs : this.now() - this.state.lastAt;
    this.schedule(Math.max(0, this.intervalMs - elapsed));
  }

  private commit(patch: Partial<SnapshotState>): void {
    this.state = { ...this.state, ...patch };
    this.onUpdate(this.state);
  }
}

function isHttpsEndpoint(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** 票按「节点 + 观测入口」缓存；切换节点页面时不会复用别的节点的票。 */
let ticketCache: { key: string; ticket: string; expiresAt: number; path: string } | null = null;

async function directSnapshot(
  hubId: string,
  liveEndpoint: string,
  retried = false,
): Promise<AgentSnapshot> {
  const key = `${hubId}|${liveEndpoint}`;
  if (retried) ticketCache = null;
  if (
    !ticketCache ||
    ticketCache.key !== key ||
    ticketCache.expiresAt - 30 <= Math.floor(Date.now() / 1000)
  ) {
    const body = await apiRequest(`/api/v1/nodes/${encodeURIComponent(hubId)}/live-ticket`, {
      method: 'POST',
      body: JSON.stringify({ scope: 'snap', origin: window.location.origin }),
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    });
    const ticket = liveTicketResponseSchema.parse(body);
    ticketCache = {
      key,
      ticket: ticket.ticket,
      expiresAt: ticket.expiresAt,
      path: ticket.snapshotPath ?? SNAPSHOT_PATH,
    };
  }
  const url = new URL(liveEndpoint);
  url.pathname = ticketCache.path;
  url.search = `ticket=${encodeURIComponent(ticketCache.ticket)}`;
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      cache: 'no-store',
      credentials: 'omit',
      mode: 'cors',
      signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
    });
  } catch {
    throw new Error(
      '直连观测入口不可达（网络/CORS 被拦截；常见原因：网关未配置 /_live 反代，或 Agent 的 KHC_LIVE_ORIGINS 未包含当前面板域名）',
    );
  }
  if (response.status === 401 || response.status === 403) {
    // 票过期/被拒：换一张票重试一次；仍失败则交给外层进入失败态。
    if (retried) throw new Error('快照票被拒绝（Agent 鉴权失败）');
    return directSnapshot(hubId, liveEndpoint, true);
  }
  if (!response.ok) throw new Error(`快照请求失败（HTTP ${response.status}）`);
  const parsed = agentSnapshotSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('快照响应格式不合法');
  return parsed.data;
}

async function forwardSnapshot(hubId: string): Promise<AgentSnapshot> {
  const body = await apiRequest<NodeSnapshotResponse>(
    `/api/v1/nodes/${encodeURIComponent(hubId)}/snapshot`,
    { signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) },
  );
  if (!body.reachable || !body.snapshot) {
    throw new Error(body.error || 'Hub 不可达');
  }
  return body.snapshot;
}

export function useHubSnapshot(
  hubId: string,
  liveEndpoint: string | null | undefined,
): SnapshotObservation {
  const [state, setState] = useState<SnapshotState>(INITIAL_STATE);
  const loopRef = useRef<SnapshotLoop | null>(null);

  useEffect(() => {
    if (!hubId) return;
    // 节点数据未就绪（undefined）时先不启动：否则会先按「无域名」转发一次快照，
    // 拿到 HTTPS 入口后又重挂一个直连循环，直连模式下多出 1 次 Worker 请求。
    // 显式 null 表示节点确认没有观测入口，此时才走转发。
    if (liveEndpoint === undefined) return;
    // 只对可信 HTTPS 入口做浏览器直连；http/IP 覆盖值或非法 URL 一律走控制面转发，
    // 避免混合内容/证书失败导致 10s 重试全部落空。
    const endpoint = isHttpsEndpoint(liveEndpoint) ? liveEndpoint : null;
    const mode: SnapshotMode = endpoint ? 'direct' : 'forward';
    ticketCache = null;
    let mounted = true;
    // 只有直连模式共享多标签计时器；转发模式的去重由 Worker 尽力而为，不在浏览器侧串起来。
    const shared: SharedSnapshotOptions | undefined =
      mode === 'direct' && typeof BroadcastChannel !== 'undefined'
        ? {
            hubId,
            createChannel: (name) =>
              new BroadcastChannel(name) as unknown as SnapshotChannelLike,
          }
        : undefined;
    const loop = new SnapshotLoop({
      mode,
      initiallyVisible: !document.hidden,
      shared,
      fetchSnapshot: () =>
        mode === 'direct' && endpoint
          ? directSnapshot(hubId, endpoint)
          : forwardSnapshot(hubId),
      fetchForward: () => forwardSnapshot(hubId),
      onUpdate: (next) => {
        if (mounted) setState(next);
      },
    });
    loopRef.current = loop;
    loop.start();
    const onVisibility = () => loop.setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mounted = false;
      document.removeEventListener('visibilitychange', onVisibility);
      loop.stop();
      loopRef.current = null;
    };
  }, [hubId, liveEndpoint]);

  return {
    ...state,
    refresh: () => loopRef.current?.refresh(),
    reconnect: () => loopRef.current?.refresh(),
    readForward: () => loopRef.current?.readForward(),
  };
}
