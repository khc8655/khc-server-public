/**
 * 节点应用摘要派生（编排/知识层，2026-11-10）。
 *
 * 输入只有 D1 app_configs（期望配置）：不连节点、不写库、不依赖 Hono。
 * 应用名与配置形状的知识集中在本文件；核心路由只做分组与调用。
 * 口径：未配置的项为 null（UI 显示即开启）；有配置行但条数为 0 时为 0
 * （UI 必须明确表达，不能与"未配置"混成空白）。
 */
import type { NodeAppSummary } from '@khc/contracts';

/**
 * 派生只需要的字段：`AppConfigRecord` 与 `AppConfigSummaryRow` 都满足这个结构，
 * 因此同一套派生物既能给单节点详情（完整记录）用，也能给列表（最小投影）用。
 */
export interface AppConfigLike {
  app: string;
  config: Record<string, unknown>;
}

/**
 * 单行配置的明文摘要（写入 app_configs.summary_json 的内容）。
 * 硬约束：只允许模式与计数，不得包含任何私钥、证书内容、密码或哈希。
 */
export interface AppSummaryCounts {
  /** wireguard 行的期望模式（仅 wireguard 行有） */
  mode?: 'wg' | 'caddy';
  /** WireGuard Peer 总数（含停用）；仅 wireguard 行有 */
  peers?: number;
  /** 站点计数（total 含停用）；仅 caddy-site 行有 */
  sites?: { total: number; disabled: number };
  /** 端口转发规则数；仅 port-forward 行有 */
  forwards?: number;
}

/** 摘要聚合的入参：一行配置 + 它的明文摘要（来自 summary_json 或即时派生） */
export interface AppSummaryEntry {
  app: string;
  summary: AppSummaryCounts;
}

/** 组网开关的唯一真源（app_configs 行）；缺省视为启用。 */
export function desiredMode(configs: AppConfigLike[]): 'wg' | 'caddy' | null {
  const record = configs.find((item) => item.app === 'wireguard');
  if (!record) return null;
  return record.config.enabled === false ? 'caddy' : 'wg';
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function disabledCount(items: unknown[]): number {
  return items.filter(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      (item as Record<string, unknown>).enabled === false,
  ).length;
}

/**
 * 单行配置 → 明文摘要。putAppConfig 落库前调用；旧行回填/兜底也走同一函数，
 * 保证 summary_json 与即时派生永远同源。
 */
export function summarizeAppConfig(
  app: string,
  config: Record<string, unknown>,
): AppSummaryCounts {
  if (app === 'wireguard') {
    return {
      mode: config.enabled === false ? 'caddy' : 'wg',
      peers: asArray(config.peers).length,
    };
  }
  if (app === 'caddy-site') {
    const items = asArray(config.sites);
    return { sites: { total: items.length, disabled: disabledCount(items) } };
  }
  if (app === 'port-forward') {
    return { forwards: asArray(config.forwards).length };
  }
  return {};
}

/**
 * 同节点的多行摘要 → 节点摘要。
 * 「有行但计数为 0」保留 0（sites/forwards 不再折成 null），
 * 让首页/详情能区分"未配置"与"配置未生效"。
 */
export function summarizeAppSummaries(rows: AppSummaryEntry[]): NodeAppSummary {
  const wg = rows.find((row) => row.app === 'wireguard');
  const mode = wg ? (wg.summary.mode ?? 'wg') : null;
  // 纯 Caddy 模式下 WireGuard 停用，即使库里留着 Peer 也不展示。
  const peers = mode === 'wg' && wg ? (wg.summary.peers ?? 0) : null;

  const caddy = rows.find((row) => row.app === 'caddy-site');
  const sites = caddy ? (caddy.summary.sites ?? { total: 0, disabled: 0 }) : null;

  const forward = rows.find((row) => row.app === 'port-forward');
  const forwards = forward ? (forward.summary.forwards ?? 0) : null;

  return { mode, peers, sites, forwards };
}

/** 完整记录（或最小投影）→ 节点摘要：先逐行派生，再聚合。 */
export function summarizeNodeApps(configs: AppConfigLike[]): NodeAppSummary {
  return summarizeAppSummaries(
    configs.map((item) => ({
      app: item.app,
      summary: summarizeAppConfig(item.app, item.config),
    })),
  );
}
