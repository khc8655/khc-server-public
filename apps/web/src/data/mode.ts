/** 节点双模式（WireGuard 组网 / 纯 Caddy 网关）：3 态预检与一次性切换。 */
import { queryOptions } from '@tanstack/react-query';
import {
  nodeModeSchema,
  type ModeIssue,
  type ModeTarget,
  type NodeMode,
  type NodeModeValue,
} from '@khc/contracts';
import { ApiError, apiRequest } from './client';
import { fetchAppConfig, runAppAction, saveAppConfig } from './apps';
import { fetchHubState } from './hubs';

export const NODE_MODE_WG = 'wg';
export const NODE_MODE_CADDY = 'caddy';
export const NODE_MODE_UNKNOWN = 'unknown';

export type NodeModeKind = NodeModeValue;
export type NodeModeIssue = ModeIssue;
export type NodeModeInfo = NodeMode;

export class ModeSwitchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: string | null = null,
  ) {
    super(message);
    this.name = 'ModeSwitchError';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function modeKind(value: unknown): NodeModeKind | null {
  return value === 'wg' || value === 'caddy' || value === 'unknown' ? value : null;
}

function targetKind(value: unknown): ModeTarget | null {
  return value === 'wg' || value === 'caddy' ? value : null;
}

function normalizeIssue(value: unknown): NodeModeIssue | null {
  const record = asRecord(value);
  const code = asString(record.code);
  const message = asString(record.message);
  if (!code || !message) return null;
  const fixRoute = asString(record.fixRoute);
  const details = asRecord(record.details);
  return {
    code,
    message,
    ...(fixRoute ? { fixRoute } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

function nextTargetOf(mode: NodeModeKind): ModeTarget | null {
  if (mode === 'wg') return 'caddy';
  if (mode === 'caddy') return 'wg';
  return null;
}

export function normalizeNodeMode(raw: unknown, hubId: string): NodeModeInfo {
  const record = asRecord(raw);
  const mode = modeKind(record.mode) ?? 'unknown';
  const target = targetKind(record.target) ?? nextTargetOf(mode);
  const blockers = Array.isArray(record.blockers)
    ? record.blockers.map(normalizeIssue).filter((item): item is NodeModeIssue => item !== null)
    : [];
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.map(normalizeIssue).filter((item): item is NodeModeIssue => item !== null)
    : [];
  return {
    nodeId: asString(record.nodeId) || hubId,
    mode,
    target,
    reachable: typeof record.reachable === 'boolean' ? record.reachable : false,
    blockers,
    warnings,
    checkedAt: asNumber(record.checkedAt, Math.floor(Date.now() / 1000)),
  };
}

export async function fetchNodeMode(hubId: string): Promise<NodeModeInfo> {
  try {
    const body = await apiRequest<unknown>(
      `/api/v1/nodes/${encodeURIComponent(hubId)}/mode`,
    );
    const parsed = nodeModeSchema.safeParse(body);
    return parsed.success ? parsed.data : normalizeNodeMode(body, hubId);
  } catch (error) {
    // 旧环境/旧测试没有 mode 路由时按未知处理，真实节点错误仍上抛。
    if (error instanceof ApiError && error.status === 404) {
      return normalizeNodeMode({}, hubId);
    }
    throw error;
  }
}

export const nodeModeQueryOptions = (hubId: string) =>
  queryOptions({
    queryKey: ['hubs', hubId, 'mode'],
    queryFn: () => fetchNodeMode(hubId),
    staleTime: 10_000,
    retry: false,
    enabled: Boolean(hubId),
  });

export function nextModeTarget(mode: NodeModeKind): ModeTarget {
  return mode === 'wg' ? 'caddy' : 'wg';
}

/** 保存 enabled 字段，保留 wireguard config 的其它字段（不回退 peers/interface/keys）。 */
export async function saveWireGuardEnabled(hubId: string, enabled: boolean): Promise<void> {
  const current = await fetchAppConfig(hubId, 'wireguard');
  if (!current) {
    throw new ModeSwitchError('E_MODE_NO_CONFIG', '节点还没有 WireGuard 配置，无法切换模式');
  }
  const config = asRecord(current.config);
  await saveAppConfig(hubId, 'wireguard', { ...config, enabled });
}

function envelopeFailure(envelope: {
  ok: boolean;
  error?: { code?: string; message?: string; details?: unknown } | null;
}): ModeSwitchError | null {
  if (envelope.ok) return null;
  const error = envelope.error;
  return new ModeSwitchError(
    error?.code ?? 'E_MODE_APPLY',
    error?.message ?? '切换模式时应用配置失败',
    error?.details ? JSON.stringify(error.details, null, 2) : null,
  );
}

/** plan + apply（沿用既有 Worker/Agent 动作，不新增执行动作）。 */
export async function applyWireGuardMode(hubId: string): Promise<void> {
  const plan = await runAppAction(hubId, 'wireguard', 'plan');
  const planError = envelopeFailure(plan);
  if (planError) throw planError;
  const apply = await runAppAction(hubId, 'wireguard', 'apply');
  const applyError = envelopeFailure(apply);
  if (applyError) throw applyError;
}

function wireGuardRunningFromState(state: Awaited<ReturnType<typeof fetchHubState>>): boolean | null {
  const adapter = state.state?.adapters.find((item) => item.name === 'wireguard');
  if (!adapter) return null;
  const status = asRecord(adapter.status);
  return typeof status.running === 'boolean' ? status.running : null;
}

/**
 * 等 WireGuard 运行态与目标模式一致：默认 2s 起、按退避放大到 10s，最长 60s。
 * 仅用于用户主动切换模式后的收敛确认（有硬超时、退避与取消信号），不是后台轮询。
 */
export async function waitForWireGuardMode(
  hubId: string,
  target: ModeTarget,
  options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxIntervalMs = 10_000;
  const signal = options.signal;
  const deadline = Date.now() + timeoutMs;
  let delay = options.intervalMs ?? 2_000;
  while (true) {
    if (signal?.aborted) {
      const error = new Error('模式切换轮询已取消');
      error.name = 'AbortError';
      throw error;
    }
    const state = await fetchHubState(hubId);
    const running = wireGuardRunningFromState(state);
    const converged = target === 'wg' ? running === true : running === false;
    if (converged) return;
    if (Date.now() >= deadline) {
      throw new ModeSwitchError(
        'E_MODE_VERIFY_TIMEOUT',
        target === 'wg'
          ? 'WireGuard 未在 60 秒内启动，请查看诊断'
          : 'WireGuard 未在 60 秒内停止，请查看诊断',
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))));
    delay = Math.min(delay * 2, maxIntervalMs);
  }
}
