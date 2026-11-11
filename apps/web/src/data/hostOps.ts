/**
 * 主机运维（host-ops）数据层：配置、按需 call/onboard/probe/hub_pubkey、
 * 进程/防火墙/SSH 公钥/状态结果规范化，以及错误码。
 */
import { queryOptions } from '@tanstack/react-query';
import {
  taskResponseSchema,
  type AgentOps,
  type AgentState,
  type AppConfig,
  type AgentEnvelope,
  type AgentTask,
} from '@khc/contracts';
import { ApiError, apiRequest } from './client';
import { fetchAppConfig, runAppAction, saveAppConfig } from './apps';

export const HOST_OPS_APP = 'host-ops';
export const HOST_OPS_TARGET_SELF = 'self';
export const HOST_OPS_TASK_POLL_MS = 1_000;
/** 任务进度轮询的退避上限（请求预算）：1→2→4→8s，120s 内约 17 次而不是 120 次。 */
export const HOST_OPS_TASK_POLL_MAX_MS = 8_000;
export const HOST_OPS_TASK_TIMEOUT_MS = 120_000;

export type HostOpsVerb =
  | 'version'
  | 'status'
  | 'snapshot'
  | 'processes'
  | 'fw.show'
  | 'fw.apply'
  | 'fw.confirm'
  | 'keys.list'
  | 'keys.add'
  | 'keys.remove'
  | 'svc.list'
  | 'svc.logs'
  | 'svc.restart'
  | 'cron.list'
  | 'cron.set'
  | 'cleanup';

export interface HostOpsPeerConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  hostKey: string;
}

export interface HostOpsConfig {
  peers: Record<string, HostOpsPeerConfig>;
}

export interface HostOpsConfigState {
  config: HostOpsConfig;
  rev: number | null;
  appliedRev: number | null;
  exists: boolean;
}

export interface HostOpsError {
  code: string;
  message: string;
  details: string | null;
}

export interface HostOpsResult<T> {
  ok: boolean;
  v: string | null;
  data: T | null;
  error: HostOpsError | null;
  /** 适配器附带的脚本版本信息（用于「脚本需更新」状态） */
  scriptVersion: string | null;
  expectedVersion: string | null;
  updateRequired: boolean | null;
}

export interface HostOpsVersion {
  version: string | null;
  python: string | null;
  root: boolean | null;
  nft: boolean | null;
}

export interface HostOpsStatus {
  ops: AgentOps | null;
  hostname: string | null;
  uptime: number | null;
  version: string | null;
  collectedAt: number | null;
  /** 运维通道临时改过 peer 用户 shell 时的可见状态（批次 S 缺陷 2）。 */
  onboard: HostOpsOnboardState | null;
}

export interface HostOpsOnboardState {
  user: string;
  originalShell: string | null;
  currentShell: string | null;
  createdUser: boolean;
  shellModified: boolean;
}

export interface HostOpsProcess {
  pid: number;
  ppid: number | null;
  name: string;
  user: string;
  startTime: number | null;
  cpu: number | null;
  mem: number | null;
  cmdline: string;
}

export type HostOpsFirewallAction = 'allow' | 'deny';

export interface HostOpsFirewallRule {
  id: string;
  action: HostOpsFirewallAction;
  proto: string;
  port: string;
  source: string;
  note: string;
  locked: boolean;
  lockReason: string | null;
}

export interface HostOpsFirewallPending {
  token: string;
  secondsLeft: number | null;
}

/** 主机 iptables 上的系统自动放行规则（khc-agent 插入，非用户策略）。 */
export interface HostOpsFirewallAutoRule {
  app: string;
  proto: string;
  port: string;
  note: string;
}

export interface HostOpsFirewallShow {
  rules: HostOpsFirewallRule[];
  baseRev: string | null;
  other: string[];
  pending: HostOpsFirewallPending | null;
  autoRules: HostOpsFirewallAutoRule[];
}

export interface HostOpsKey {
  fingerprint: string;
  type: string;
  comment: string;
  managed: boolean;
  removable: boolean;
  hubKey: boolean;
}

export interface HostOpsOnboard {
  installCommand: string;
  uninstallCommand: string;
  publicKey: string;
  hubWgIp: string;
  scriptVersion: string;
}

export interface HostOpsProbe {
  hostKey: string;
  fingerprint: string;
  algorithm: string;
}

export interface HostOpsHubKey {
  publicKey: string;
  fingerprint: string;
}

export interface HostOpsCachedPeerStatus {
  status: HostOpsStatus | null;
  version: string | null;
  fetchedAt: number | null;
}

interface HostOpsEnvelope extends AgentEnvelope {
  v?: unknown;
  data?: unknown;
  version?: unknown;
  python?: unknown;
  root?: unknown;
  nft?: unknown;
  installCommand?: unknown;
  uninstallCommand?: unknown;
  publicKey?: unknown;
  hubWgIp?: unknown;
  scriptVersion?: unknown;
  hostKey?: unknown;
  fingerprint?: unknown;
  algorithm?: unknown;
  token?: unknown;
  result?: NonNullable<AgentEnvelope['result']> & Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  return null;
}

function stringifyUnknown(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `hostops-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/* ------------------------------------------------------------------ 配置 */

export function normalizeHostOpsConfig(raw: unknown): HostOpsConfig {
  const record = asRecord(raw);
  const rawPeers = asRecord(record.peers);
  const peers: Record<string, HostOpsPeerConfig> = {};
  for (const [peerId, value] of Object.entries(rawPeers)) {
    const peer = asRecord(value);
    const host = asString(peer.host);
    if (!peerId || !host) continue;
    const port = asNumber(peer.port) ?? 22;
    peers[peerId] = {
      enabled: asBoolean(peer.enabled) ?? true,
      host,
      port: port >= 1 && port <= 65535 ? Math.floor(port) : 22,
      user: asString(peer.user) || 'khcops',
      hostKey: asString(peer.hostKey),
    };
  }
  return { peers };
}

export const hostOpsConfigQueryOptions = (hubId: string) =>
  queryOptions({
    queryKey: ['hubs', hubId, 'apps', HOST_OPS_APP],
    queryFn: () => fetchAppConfig(hubId, HOST_OPS_APP),
    select: (data: AppConfig | null): HostOpsConfigState => ({
      config: normalizeHostOpsConfig(data?.config ?? null),
      rev: data?.rev ?? null,
      appliedRev: data?.appliedRev ?? null,
      exists: Boolean(data),
    }),
    staleTime: 5_000,
    enabled: Boolean(hubId),
  });

export async function saveHostOpsConfig(
  hubId: string,
  config: HostOpsConfig,
): Promise<AppConfig> {
  return saveAppConfig(hubId, HOST_OPS_APP, config as unknown as Record<string, unknown>);
}

/* -------------------------------------------------------------- 动作调用 */

const ENVELOPE_KEYS = new Set([
  'ok',
  'v',
  'rev',
  'appliedRev',
  'changes',
  'warnings',
  'result',
  'taskId',
  'error',
  'cards',
  'data',
]);

function envelopeData(envelope: HostOpsEnvelope): unknown {
  const topData = (envelope as unknown as Record<string, unknown>).data;
  if (topData !== undefined) return topData;
  const result = asRecord(envelope.result);
  if (result.data !== undefined) return result.data;
  const rest = Object.fromEntries(
    Object.entries(result).filter(([key]) => key !== 'cards'),
  );
  if (Object.keys(rest).length > 0) return rest;
  // onboard/probe/hub_pubkey 等动作可能把字段直接放在顶层（适配器约定）。
  const top = envelope as unknown as Record<string, unknown>;
  const direct = Object.fromEntries(
    Object.entries(top).filter(([key]) => !ENVELOPE_KEYS.has(key)),
  );
  return Object.keys(direct).length > 0 ? direct : null;
}

function resultFromEnvelope<T>(envelope: HostOpsEnvelope): HostOpsResult<T> {
  const top = envelope as unknown as Record<string, unknown>;
  const result = asRecord(envelope.result);
  const scriptVersion =
    asString(top.scriptVersion ?? result.scriptVersion ?? top.v ?? result.v) || null;
  const expectedVersion =
    asString(top.expectedVersion ?? result.expectedVersion) || null;
  const updateRequired = asBoolean(top.updateRequired ?? result.updateRequired);
  if (!envelope.ok) {
    const error = envelope.error;
    return {
      ok: false,
      v: asString(top.v ?? result.v) || null,
      data: null,
      error: {
        code: error?.code || 'E_UNKNOWN',
        message: error?.message || '主机运维操作失败',
        details: stringifyUnknown(error?.details),
      },
      scriptVersion,
      expectedVersion,
      updateRequired,
    };
  }
  return {
    ok: true,
    v: asString(top.v ?? result.v) || null,
    data: envelopeData(envelope) as T | null,
    error: null,
    scriptVersion,
    expectedVersion,
    updateRequired,
  };
}

function apiErrorResult<T>(error: ApiError): HostOpsResult<T> {
  return {
    ok: false,
    v: null,
    data: null,
    error: {
      code: error.code || 'E_UNKNOWN',
      message: error.message,
      details: stringifyUnknown(error.fields),
    },
    scriptVersion: null,
    expectedVersion: null,
    updateRequired: null,
  };
}

async function hostOpsAction<T>(
  hubId: string,
  action: string,
  params: Record<string, unknown>,
): Promise<HostOpsResult<T>> {
  try {
    const envelope = await runAppAction(hubId, HOST_OPS_APP, action, params, {
      idempotencyKey: newIdempotencyKey(),
    });
    return resultFromEnvelope<T>(envelope as unknown as HostOpsEnvelope);
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResult<T>(error);
    // 服务端 2xx 但响应体不符合契约（如网关返回空对象）时按结构化错误呈现，
    // 不让解析异常变成调用方的 unhandled rejection。
    return taskErrorResult<T>(
      'E_RESPONSE',
      error instanceof Error && error.message ? error.message : '服务端响应格式不合法',
    );
  }
}

/**
 * POST /apps/host-ops/call，body.params = { target, verb, params }。
 * 读写都带 idempotencyKey；写动词由适配器审计。
 */
export async function callHostOps<T = unknown>(
  hubId: string,
  target: string,
  verb: HostOpsVerb,
  params: Record<string, unknown> = {},
): Promise<HostOpsResult<T>> {
  return hostOpsAction<T>(hubId, 'call', { target, verb, params });
}

export interface HostOpsTaskOptions {
  signal?: AbortSignal;
  /** 默认 1s；测试可缩短 */
  pollIntervalMs?: number;
  /** 默认 120s；测试可缩短 */
  timeoutMs?: number;
}

function taskErrorResult<T>(
  code: string,
  message: string,
  details: string | null = null,
): HostOpsResult<T> {
  return {
    ok: false,
    v: null,
    data: null,
    error: { code, message, details },
    scriptVersion: null,
    expectedVersion: null,
    updateRequired: null,
  };
}

function taskResultFromValue<T>(value: unknown): HostOpsResult<T> {
  const record = value === null || value === undefined ? { ok: true } : asRecord(value);
  return resultFromEnvelope<T>({
    ...record,
    ok: record.ok !== false,
  } as unknown as HostOpsEnvelope);
}

function taskFailure<T>(task: AgentTask, fallback: string): HostOpsResult<T> {
  const error = task.error;
  return taskErrorResult<T>(
    error?.code || 'E_TASK_FAILED',
    error?.message || fallback,
    stringifyUnknown(error?.details),
  );
}

export function isHostOpsAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function abortError(): Error {
  const error = new Error('任务轮询已取消');
  error.name = 'AbortError';
  return error;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchTask(hubId: string, taskId: string): Promise<AgentTask> {
  const body = await apiRequest<unknown>(
    `/api/v1/nodes/${encodeURIComponent(hubId)}/tasks/${encodeURIComponent(taskId)}`,
  );
  const parsed = taskResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('任务状态响应格式不合法');
  }
  return parsed.data.task;
}

/**
 * 任务模式调用（#17）：POST call_task 拿 taskId，按退避轮询 /tasks/:taskId。
 * done → 解析 task.result 为 HostOpsResult；error → task.error；取消/超时返回错误结果。
 * 只服务于用户主动发起的写操作进度回执，有硬超时与退避上限，不是后台定时轮询；
 * 关闭抽屉时通过 AbortSignal 立即终止。
 */
export async function callHostOpsTask<T = unknown>(
  hubId: string,
  target: string,
  verb: HostOpsVerb,
  params: Record<string, unknown> = {},
  options: HostOpsTaskOptions = {},
): Promise<HostOpsResult<T>> {
  const signal = options.signal;
  const pollIntervalMs = options.pollIntervalMs ?? HOST_OPS_TASK_POLL_MS;
  const timeoutMs = options.timeoutMs ?? HOST_OPS_TASK_TIMEOUT_MS;
  if (signal?.aborted) throw abortError();

  let envelope: AgentEnvelope;
  try {
    envelope = await runAppAction(hubId, HOST_OPS_APP, 'call_task', { target, verb, params }, {
      idempotencyKey: newIdempotencyKey(),
    });
  } catch (error) {
    if (isHostOpsAbortError(error)) throw error;
    if (error instanceof ApiError) return apiErrorResult<T>(error);
    return taskErrorResult<T>(
      'E_TASK_SUBMIT',
      error instanceof Error && error.message ? error.message : '任务提交失败',
    );
  }

  if (!envelope.ok) {
    return resultFromEnvelope<T>(envelope as unknown as HostOpsEnvelope);
  }
  const taskId =
    typeof (envelope as unknown as Record<string, unknown>).taskId === 'string'
      ? String((envelope as unknown as Record<string, unknown>).taskId).trim()
      : '';
  if (!taskId) {
    return taskErrorResult<T>('E_TASK_NO_ID', '任务提交成功但未返回 taskId');
  }

  const deadline = Date.now() + timeoutMs;
  let delay = pollIntervalMs;
  let first = true;
  while (true) {
    if (signal?.aborted) throw abortError();
    if (!first && Date.now() >= deadline) {
      return taskErrorResult<T>(
        'E_TASK_TIMEOUT',
        `任务在 ${Math.round(timeoutMs / 1000)} 秒内未完成`,
        `taskId: ${taskId}`,
      );
    }
    first = false;

    let task: AgentTask;
    try {
      task = await fetchTask(hubId, taskId);
    } catch (error) {
      if (isHostOpsAbortError(error)) throw error;
      if (error instanceof ApiError) return apiErrorResult<T>(error);
      return taskErrorResult<T>(
        'E_TASK_POLL',
        error instanceof Error && error.message ? error.message : '任务状态查询失败',
        `taskId: ${taskId}`,
      );
    }
    if (signal?.aborted) throw abortError();

    if (task.state === 'done') return taskResultFromValue<T>(task.result);
    if (task.state === 'error') return taskFailure<T>(task, '任务执行失败');
    if (task.state === 'canceled') {
      return taskErrorResult<T>('E_TASK_CANCELED', '任务已取消', `taskId: ${taskId}`);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return taskErrorResult<T>(
        'E_TASK_TIMEOUT',
        `任务在 ${Math.round(timeoutMs / 1000)} 秒内未完成`,
        `taskId: ${taskId}`,
      );
    }
    await sleep(Math.min(delay, remaining), signal);
    delay = Math.min(delay * 2, HOST_OPS_TASK_POLL_MAX_MS);
  }
}

export async function onboardHostOps(
  hubId: string,
  params: { peerId?: string; host: string; port?: number; user?: string },
): Promise<HostOpsResult<HostOpsOnboard>> {
  return hostOpsAction<HostOpsOnboard>(hubId, 'onboard', params);
}

export async function probeHostOps(
  hubId: string,
  params: { peerId: string } | { host: string; port?: number },
): Promise<HostOpsResult<HostOpsProbe>> {
  return hostOpsAction<HostOpsProbe>(hubId, 'probe', params);
}

export async function hubPubKeyHostOps(
  hubId: string,
): Promise<HostOpsResult<HostOpsHubKey>> {
  return hostOpsAction<HostOpsHubKey>(hubId, 'hub_pubkey', {});
}

/** PUT app config，然后 plan + apply。失败时返回结构化错误（配置可能已保存）。 */
export async function applyHostOpsConfig(
  hubId: string,
  config: HostOpsConfig,
): Promise<HostOpsResult<null>> {
  try {
    await saveHostOpsConfig(hubId, config);
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResult<null>(error);
    throw error;
  }
  for (const action of ['plan', 'apply']) {
    try {
      const envelope = await runAppAction(hubId, HOST_OPS_APP, action, {}, {
        idempotencyKey: newIdempotencyKey(),
      });
      if (!envelope.ok) {
        return {
          ok: false,
          v: null,
          data: null,
          error: {
            code: envelope.error?.code || 'E_UNKNOWN',
            message:
              envelope.error?.message ||
              (action === 'plan' ? '主机运维配置计划失败' : '主机运维配置应用失败'),
            details: stringifyUnknown(envelope.error?.details),
          },
          scriptVersion: null,
          expectedVersion: null,
          updateRequired: null,
        };
      }
    } catch (error) {
      if (error instanceof ApiError) return apiErrorResult<null>(error);
      throw error;
    }
  }
  return {
    ok: true,
    v: null,
    data: null,
    error: null,
    scriptVersion: null,
    expectedVersion: null,
    updateRequired: null,
  };
}

/* ---------------------------------------------------------- 结果规范化 */

export function normalizeVersion(data: unknown): HostOpsVersion {
  const record = asRecord(data);
  return {
    version:
      asString(record.version) ||
      asString(record.scriptVersion) ||
      asString(record.v) ||
      null,
    python: asString(record.python) || null,
    root: asBoolean(record.root),
    nft: asBoolean(record.nft),
  };
}

export function normalizeStatus(data: unknown): HostOpsStatus {
  const record = asRecord(data);
  const nested = asRecord(record.ops);
  const opsSource = Object.keys(nested).length > 0 ? nested : record;
  const looksLikeOps =
    'cpu' in opsSource ||
    'mem' in opsSource ||
    'disks' in opsSource ||
    'services' in opsSource ||
    'processes' in opsSource ||
    'network' in opsSource;
  const host = asRecord(record.host);
  const collectedRaw = asNumber(record.collectedAt) ?? asNumber(opsSource.collectedAt);
  return {
    ops: looksLikeOps ? (opsSource as AgentOps) : null,
    hostname: asString(record.hostname) || asString(host.hostname) || null,
    uptime: asNumber(record.uptime) ?? asNumber(host.uptime),
    version: asString(record.version) || null,
    collectedAt:
      collectedRaw === null
        ? null
        : collectedRaw > 10_000_000_000
          ? Math.floor(collectedRaw / 1000)
          : collectedRaw,
    onboard: normalizeOnboardState(record.onboard),
  };
}

function normalizeOnboardState(value: unknown): HostOpsOnboardState | null {
  const record = asRecord(value);
  const user = asString(record.user);
  if (!user) return null;
  return {
    user,
    originalShell: asString(record.originalShell) || null,
    currentShell: asString(record.currentShell) || null,
    createdUser: asBoolean(record.createdUser) === true,
    shellModified: asBoolean(record.shellModified) === true,
  };
}

const INTERPRETER_NAME = /^(python[\d.]*|node|nodejs|ruby|perl|java|bash|sh|dash|php[\d.]*)$/i;

function basenameOfPath(value: string): string {
  return value.split('/').filter(Boolean).pop() ?? value;
}

/**
 * 进程可读名：内核 comm 只有 15 字符，解释器进程还只会显示 python3/node。
 * 纯展示层补全，不改变 Agent 采集口径：优先脚本名，其次补全被截断的 basename。
 */
export function displayProcessName(comm: string, cmdline: string): string {
  const args = cmdline.trim().split(/\s+/).filter(Boolean);
  if (INTERPRETER_NAME.test(comm)) {
    const script = args.slice(1).find((arg) => !arg.startsWith('-'));
    if (script) return basenameOfPath(script);
  }
  if (comm.length >= 15) {
    const full = args
      .map(basenameOfPath)
      .find((item) => item.length > comm.length && item.startsWith(comm));
    if (full) return full;
  }
  return comm;
}

export function normalizeProcesses(data: unknown): HostOpsProcess[] {
  const record = asRecord(data);
  const rawList = Array.isArray(data)
    ? data
    : Array.isArray(record.processes)
      ? record.processes
      : [];
  return rawList
    .map((value) => asRecord(value))
    .map((process) => {
      const pid = asNumber(process.pid);
      if (pid === null || pid <= 0) return null;
      const cmdline =
        asString(process.cmdline) ||
        asString(process.cmd) ||
        asString(process.command) ||
        asString(process.name) ||
        '—';
      const comm = asString(process.name) || asString(process.comm) || '—';
      return {
        pid: Math.floor(pid),
        ppid: asNumber(process.ppid),
        name: displayProcessName(comm, cmdline),
        user: asString(process.user) || '—',
        startTime: asNumber(process.startTime),
        cpu: asNumber(process.cpu),
        mem: asNumber(process.mem),
        cmdline,
      } satisfies HostOpsProcess;
    })
    .filter((process): process is HostOpsProcess => process !== null);
}

function normalizeFirewallAction(value: unknown): HostOpsFirewallAction {
  const text = asString(value).toLowerCase();
  return text === 'deny' || text === 'drop' || text === 'reject' ? 'deny' : 'allow';
}

function normalizeFirewallRule(value: unknown, index: number): HostOpsFirewallRule {
  const rule = asRecord(value);
  return {
    id: asString(rule.id) || `rule-${index + 1}`,
    action: normalizeFirewallAction(rule.action),
    proto: asString(rule.proto),
    port: asString(rule.port) || '—',
    source: asString(rule.source) || '0.0.0.0/0',
    note: asString(rule.note),
    locked: asBoolean(rule.locked) === true || asBoolean(rule.protected) === true,
    lockReason: asString(rule.lockReason) || null,
  };
}

function normalizeOtherRules(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === 'string') return item.trim() ? [item] : [];
      const text = stringifyUnknown(item);
      return text ? [text] : [];
    });
  }
  const text = stringifyUnknown(value);
  return text ? [text] : [];
}

export function normalizeFirewallShow(data: unknown): HostOpsFirewallShow {
  const record = asRecord(data);
  const pendingRecord = asRecord(record.pending);
  const pendingToken = asString(pendingRecord.token);
  const pending: HostOpsFirewallPending | null = pendingToken
    ? {
        token: pendingToken,
        secondsLeft: asNumber(pendingRecord.secondsLeft),
      }
    : null;
  const rawRules = Array.isArray(data)
    ? data
    : Array.isArray(record.rules)
      ? record.rules
      : [];
  return {
    rules: rawRules.map(normalizeFirewallRule),
    baseRev:
      asString(record.baseRev) ||
      asString(record.rev) ||
      asString(record.hash) ||
      null,
    other: normalizeOtherRules(
      record.other ?? record.otherRules ?? record.tables ?? record.otherTables,
    ),
    pending,
    autoRules: normalizeFirewallAutoRules(record.autoRules),
  };
}

function normalizeFirewallAutoRules(value: unknown): HostOpsFirewallAutoRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const app = asString(record.app);
    const proto = asString(record.proto);
    const port = asString(record.port);
    if (!app || !proto || !port) return [];
    return [
      {
        app,
        proto,
        port,
        note: asString(record.note),
      },
    ];
  });
}

export function normalizeFirewallToken(data: unknown): string | null {
  const record = asRecord(data);
  return asString(record.token) || asString(record.confirmToken) || null;
}

export function normalizeKillResult(data: unknown): string | null {
  const record = asRecord(data);
  return asString(record.result) || asString(record.status) || null;
}

export function normalizeKeys(data: unknown): HostOpsKey[] {
  const record = asRecord(data);
  const rawList = Array.isArray(data)
    ? data
    : Array.isArray(record.keys)
      ? record.keys
      : [];
  return rawList.flatMap((value) => {
    const key = asRecord(value);
    const fingerprint =
      asString(key.fingerprint) ||
      asString(key.fp) ||
      asString(key.sha256);
    if (!fingerprint) return [];
    const comment = asString(key.comment) || asString(key.label);
    const hubKey =
      asBoolean(key.hubKey) === true ||
      asBoolean(key.protected) === true ||
      comment.startsWith('khc-hub-');
    const managed = asBoolean(key.managed) ?? false;
    const removable = asBoolean(key.removable) ?? (managed && !hubKey);
    return [
      {
        fingerprint,
        type: asString(key.type) || asString(key.algorithm) || '—',
        comment,
        managed,
        removable,
        hubKey,
      },
    ];
  });
}

/* ------------------------------------------------------------------ svc / cron */

export interface HostOpsService {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

export interface HostOpsSvcLogs {
  unit: string;
  lines: string[];
}

export interface HostOpsCronEntry {
  name: string;
  file: string;
  enabled: boolean;
  lines: string[];
}

export interface HostOpsCronList {
  dir: string;
  available: boolean;
  managed: HostOpsCronEntry[];
  unmanaged: string[];
  writable: boolean;
}

const SERVICE_UNIT_RE = /^[A-Za-z0-9_.@:\\-]{1,64}\.service$/;
const CRON_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function normalizeServices(data: unknown): HostOpsService[] {
  const record = asRecord(data);
  const rawList = Array.isArray(record.services) ? record.services : [];
  return rawList.flatMap((value) => {
    const item = asRecord(value);
    const unit = asString(item.unit);
    if (!unit) return [];
    return [
      {
        unit,
        load: asString(item.load) || '—',
        active: asString(item.active) || '—',
        sub: asString(item.sub) || '—',
        description: asString(item.description) || '',
      },
    ];
  });
}

export function normalizeSvcLogs(data: unknown): HostOpsSvcLogs {
  const record = asRecord(data);
  const rawLines = Array.isArray(record.lines) ? record.lines : [];
  return {
    unit: asString(record.unit) || '—',
    lines: rawLines.flatMap((line) => (typeof line === 'string' ? [line] : [])),
  };
}

export function normalizeCronList(data: unknown): HostOpsCronList {
  const record = asRecord(data);
  const managed = Array.isArray(record.managed)
    ? record.managed.flatMap((value) => {
        const item = asRecord(value);
        const name = asString(item.name);
        if (!name) return [];
        const rawLines = Array.isArray(item.lines) ? item.lines : [];
        return [
          {
            name,
            file: asString(item.file) || `khc-${name}`,
            enabled: asBoolean(item.enabled) ?? true,
            lines: rawLines.flatMap((line) => (typeof line === 'string' ? [line] : [])),
          },
        ];
      })
    : [];
  const unmanaged = Array.isArray(record.unmanaged)
    ? record.unmanaged.flatMap((name) => (typeof name === 'string' ? [name] : []))
    : [];
  return {
    dir: asString(record.dir) || '/etc/cron.d',
    available: asBoolean(record.available) ?? managed.length > 0,
    managed,
    unmanaged,
    writable: asBoolean(record.writable) ?? false,
  };
}

/** 与 khc-host 侧相同的护栏：仅 *.service。返回错误 key（invalid/protected）或 null。 */
export function validateServiceUnit(unit: string): 'invalid' | 'protected' | null {
  if (!SERVICE_UNIT_RE.test(unit)) return 'invalid';
  if (unit.startsWith('systemd-')) return 'protected';
  if (unit === 'ssh.service' || unit === 'sshd.service' || unit === 'dbus.service') {
    return 'protected';
  }
  return null;
}

export function validateCronName(name: string): 'invalid' | null {
  if (!CRON_NAME_RE.test(name)) return 'invalid';
  return null;
}

export function normalizeOnboard(data: unknown): HostOpsOnboard | null {
  const record = asRecord(data);
  const installCommand =
    asString(record.installCommand) || asString(record.install);
  if (!installCommand) return null;
  return {
    installCommand,
    uninstallCommand:
      asString(record.uninstallCommand) || asString(record.uninstall),
    publicKey: asString(record.publicKey),
    hubWgIp: asString(record.hubWgIp),
    scriptVersion: asString(record.scriptVersion) || asString(record.version),
  };
}

export function normalizeProbe(data: unknown): HostOpsProbe | null {
  const record = asRecord(data);
  // probe 返回 keys[]（每个类型一个）；优先 ed25519，否则取第一把。
  const keys = Array.isArray(record.keys)
    ? record.keys.flatMap((item) => {
        const key = asRecord(item);
        const publicKey = asString(key.key) || asString(key.publicKey);
        const fingerprint = asString(key.fingerprint);
        if (!publicKey || !fingerprint) return [];
        return [
          {
            hostKey: publicKey,
            fingerprint,
            algorithm: asString(key.type) || asString(key.algorithm),
          },
        ];
      })
    : [];
  if (keys.length > 0) {
    return keys.find((key) => key.algorithm.includes('ed25519')) ?? keys[0] ?? null;
  }
  const fingerprint =
    asString(record.fingerprint) || asString(record.hostKeyFingerprint);
  const hostKey = asString(record.hostKey) || asString(record.publicKey);
  if (!fingerprint && !hostKey) return null;
  return {
    hostKey,
    fingerprint,
    algorithm: asString(record.algorithm) || asString(record.type),
  };
}

export function normalizeHubKey(data: unknown): HostOpsHubKey | null {
  const record = asRecord(data);
  const publicKey = asString(record.publicKey) || asString(record.key);
  if (!publicKey) return null;
  return { publicKey, fingerprint: asString(record.fingerprint) };
}

/* ------------------------------------------------------------------ cleanup */

export interface HostOpsCleanupRemaining {
  item: string;
  reason: string;
}

export interface HostOpsCleanupResult {
  cleaned: string[];
  remaining: HostOpsCleanupRemaining[];
  note: string | null;
}

/** cleanup 动词结果规范化：缺失字段按空清单处理（保持可展示）。 */
export function normalizeCleanup(data: unknown): HostOpsCleanupResult {
  const record = asRecord(data);
  const remaining = Array.isArray(record.remaining)
    ? record.remaining.flatMap((value) => {
        const item = asRecord(value);
        const name = asString(item.item);
        if (!name) return [];
        return [{ item: name, reason: asString(item.reason) || '原因未说明' }];
      })
    : [];
  const cleaned = Array.isArray(record.cleaned)
    ? record.cleaned.flatMap((value) => (typeof value === 'string' ? [value] : []))
    : [];
  return {
    cleaned,
    remaining,
    note: asString(record.note) || null,
  };
}

/**
 * 删除节点/Peer 前的本机残留清理（走查 #4）。返回 null 表示清理完成且无残留；
 * 有残留时返回拼接好的错误消息（含清单），调用方以此阻止删除并提示。
 * 清理调用本身失败（不可达/未 onboard）抛 Error，消息来自结构化错误。
 */
export async function cleanupForDelete(
  hubId: string,
  target: string,
): Promise<string | null> {
  const result = await callHostOps<unknown>(hubId, target, 'cleanup');
  if (!result.ok || !result.data) {
    throw new Error(result.error?.message || '残留清理调用失败');
  }
  const cleanup = normalizeCleanup(result.data);
  if (cleanup.remaining.length === 0) return null;
  return cleanup.remaining.map((item) => `${item.item}：${item.reason}`).join('；');
}

/* --------------------------------------------------- /state 缓存状态读取 */

/** 从 /state 的 host-ops adapter status 读取某 target 的缓存状态（无数据则 null）。 */
export function cachedHostOpsStatus(
  state: AgentState | null | undefined,
  target: string,
): HostOpsCachedPeerStatus | null {
  const adapter = state?.adapters?.find((item) => item.name === HOST_OPS_APP);
  if (!adapter) return null;
  const status = asRecord(adapter.status);
  const peers = asRecord(status.peers);
  const statuses = asRecord(status.statuses);
  let entry: unknown = peers[target] ?? statuses[target];
  if (
    entry === undefined &&
    (asString(status.target) === target || asString(status.peerId) === target)
  ) {
    entry = status;
  }
  const record = entry === undefined || entry === null ? null : asRecord(entry);
  if (!record) {
    if (target === HOST_OPS_TARGET_SELF) {
      const normalized = normalizeStatus(status);
      if (!normalized.ops) return null;
      return { status: normalized, version: normalized.version, fetchedAt: null };
    }
    return null;
  }
  const statusData = normalizeStatus(record.ops !== undefined ? record : record.status ?? record);
  const version = asString(record.version) || statusData.version;
  const collected = asNumber(record.collectedAt) ?? statusData.collectedAt;
  return {
    status: statusData.ops ? statusData : null,
    version: version || null,
    fetchedAt:
      collected === null
        ? null
        : collected > 10_000_000_000
          ? Math.floor(collected / 1000)
          : collected * 1000,
  };
}

/* ------------------------------------------------------------------ 工具 */

export function peerHostAddress(allowedIps: readonly string[]): string {
  const candidates = allowedIps
    .map((item) => item.trim())
    .map((item) => ({ raw: item, address: item.split('/')[0] ?? '' }))
    .filter((item) => item.address && /^[0-9a-fA-F:.]+$/.test(item.address));
  const exact = candidates.find((item) => item.raw.endsWith('/32') || item.raw.endsWith('/128'));
  return (exact ?? candidates[0])?.address ?? '';
}

/** 语义化版本比较：a<b 返回负数。 */
export function compareVersions(a: string, b: string): number {
  const left = a.split(/[^0-9]+/).filter(Boolean).map(Number);
  const right = b.split(/[^0-9]+/).filter(Boolean).map(Number);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
