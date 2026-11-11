/**
 * 双模式派生与预检汇总的纯函数（docs/dual-mode.md §2.2 / §6）。
 *
 * 输入全部来自 D1（app_configs）+ Agent `/state`；不写库、不调动作、不依赖 Hono。
 *
 * 设计红线：
 * - 这里只认 3 个模式（wg / caddy / unknown），不再有 switching_* / degraded_*。
 * - 这里不出现任何应用名或应用判断。阻断与影响由适配器 `status().modeImpact`
 *   计算，本文件只按目标模式筛选、拼接摘要、排序输出。
 */
import type { ModeIssue, ModeTarget, NodeMode, NodeModeValue } from '@khc/contracts';

export type ModeDerivation = Omit<NodeMode, 'nodeId' | 'checkedAt'>;

/** 适配器上报的一条模式影响（status().modeImpact 的元素）。 */
export interface ModeImpactContribution {
  /** 切到该模式时才会生效。 */
  target: ModeTarget;
  /** 切到该模式会真正出问题的事项（仅 4 类）。 */
  blockers?: ModeImpactBlocker[];
  /** 一句话影响摘要片段，计数由适配器内联；核心只负责拼接。 */
  summary?: string[];
}

export interface ModeImpactBlocker {
  code: string;
  message: string;
  /** 相对节点根的路由段（例如某个应用的页面），核心不解释其含义。 */
  fixPath?: string;
  details?: Record<string, unknown>;
}

export interface ModeDeriveInput {
  /** D1 期望模式；null = 未配置。 */
  desired: NodeModeValue | null;
  /** Agent `/state` 是否可达。 */
  reachable: boolean;
  /** 所有适配器 status().modeImpact 的汇总。 */
  impacts: ModeImpactContribution[];
  /** 任一应用存在 rev > appliedRev。 */
  configDirty: boolean;
  /** 修复入口前缀，例如 /hubs/<nodeId>。 */
  basePath: string;
}

/**
 * blocker / warning 码（docs/dual-mode.md §6）。
 * 4 个阻断码 + 1 条影响摘要；其余旧码（防火墙/根状态/任务未知/转发启用/
 * 443 端口/全部站点依赖…）已删除。
 */
export const MODE_CODES = {
  rotationPending: 'MODE_BLOCKED_ROTATION_PENDING',
  portConflict: 'MODE_BLOCKED_PORT_CONFLICT',
  configDirty: 'MODE_BLOCKED_CONFIG_DIRTY',
  caddyNotRunning: 'MODE_BLOCKED_CADDY_NOT_RUNNING',
  impact: 'MODE_WARN_IMPACT',
} as const;

/** 展示顺序：换钥 → 端口 → 未应用配置 → 目标服务未运行。 */
const BLOCKER_ORDER: string[] = [
  MODE_CODES.rotationPending,
  MODE_CODES.portConflict,
  MODE_CODES.configDirty,
  MODE_CODES.caddyNotRunning,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readTarget(value: unknown): ModeTarget | null {
  return value === 'wg' || value === 'caddy' ? value : null;
}

function normalizeBlocker(value: unknown): ModeImpactBlocker | null {
  if (!isRecord(value)) return null;
  const code = readString(value.code);
  const message = readString(value.message);
  if (!code || !message) return null;
  const blocker: ModeImpactBlocker = { code, message };
  const fixPath = readString(value.fixPath);
  if (fixPath) blocker.fixPath = fixPath.replace(/^\/+/, '');
  if (isRecord(value.details)) blocker.details = { ...value.details };
  return blocker;
}

/**
 * 从 Agent `/state.adapters[].status.modeImpact` 收集影响。
 *
 * 兼容单对象与数组两种写法；任何非法项直接丢弃，绝不让坏状态炸掉预检。
 */
export function collectModeImpacts(adapters: ReadonlyArray<{ status?: unknown }> | null | undefined): ModeImpactContribution[] {
  const result: ModeImpactContribution[] = [];
  if (!adapters) return result;
  for (const adapter of adapters) {
    if (!isRecord(adapter)) continue;
    const status = adapter.status;
    if (!isRecord(status)) continue;
    const raw = status.modeImpact;
    const items = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    for (const item of items) {
      if (!isRecord(item)) continue;
      const target = readTarget(item.target);
      if (!target) continue;
      const blockers = Array.isArray(item.blockers)
        ? item.blockers.map(normalizeBlocker).filter((entry): entry is ModeImpactBlocker => entry !== null)
        : [];
      const summary = Array.isArray(item.summary)
        ? item.summary
            .map(readString)
            .filter((entry): entry is string => entry !== null)
        : [];
      if (blockers.length === 0 && summary.length === 0) continue;
      result.push({ target, blockers, summary });
    }
  }
  return result;
}

function modeFor(desired: NodeModeValue | null, reachable: boolean): NodeModeValue {
  if (!reachable || desired === null || desired === 'unknown') return 'unknown';
  return desired;
}

function targetFor(mode: NodeModeValue): ModeTarget | null {
  if (mode === 'wg') return 'caddy';
  if (mode === 'caddy') return 'wg';
  return null;
}

function joinRoute(basePath: string, fixPath: string | undefined): string | undefined {
  if (!fixPath) return undefined;
  return `${basePath}/${fixPath}`;
}

/** 兼容 §2.4 伪代码里的命名。 */
export function deriveNodeMode(input: ModeDeriveInput): ModeDerivation {
  const mode = modeFor(input.desired, input.reachable);
  const target = targetFor(mode);
  const base = input.basePath.replace(/\/+$/, '');

  const collected: ModeImpactBlocker[] = [];
  const summary: string[] = [];
  if (target) {
    for (const contribution of input.impacts) {
      if (!isRecord(contribution) || contribution.target !== target) continue;
      for (const blocker of contribution.blockers ?? []) {
        if (blocker && typeof blocker.code === 'string') collected.push(blocker);
      }
      for (const text of contribution.summary ?? []) {
        if (typeof text === 'string' && text && !summary.includes(text)) summary.push(text);
      }
    }
  }

  if (input.configDirty) {
    collected.push({
      code: MODE_CODES.configDirty,
      message: '存在未应用的配置修改，请先应用或撤销后再切换模式。',
      fixPath: 'apps',
    });
  }

  const seen = new Set<string>();
  const blockers: ModeIssue[] = [];
  for (const blocker of [...collected].sort(
    (left, right) => BLOCKER_ORDER.indexOf(left.code) - BLOCKER_ORDER.indexOf(right.code),
  )) {
    if (seen.has(blocker.code)) continue;
    seen.add(blocker.code);
    blockers.push({
      code: blocker.code,
      message: blocker.message,
      fixRoute: joinRoute(base, blocker.fixPath),
      ...(blocker.details ? { details: blocker.details } : {}),
    });
  }

  const warnings: ModeIssue[] = [];
  if (summary.length > 0) {
    warnings.push({
      code: MODE_CODES.impact,
      message: `切换后：${summary.join('；')}。`,
    });
  }

  return { mode, target, reachable: input.reachable, blockers, warnings };
}

/** 兼容别名：docs/dual-mode.md §2.4 的伪代码叫 deriveMode。 */
export const deriveMode = deriveNodeMode;
