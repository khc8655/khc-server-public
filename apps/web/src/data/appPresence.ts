/**
 * 应用纳管状态（2026-11-11；2026-11-11 修正标注语义）：
 * 把 D1 期望配置与节点在线状态做差集。
 *
 * 应用名与"哪些应用有接管流程"属于页面/数据层知识；核心路由与
 * `lib/node-summary.ts` 只处理 D1 派生，不感知在线探测。
 */
export type AppPresence =
  /** D1 有配置且节点已实装 */
  | 'managed'
  /** 节点已安装、D1 有配置行，但生效条数为 0（如 Caddy 0 站点）→ 「已安装 · 暂无站点」 */
  | 'installed-empty'
  /** 节点已安装、D1 没有该应用配置行 → 「已安装 · 面板无配置」 */
  | 'unconfigured'
  /** D1 有配置行但节点未安装 → 「未安装 / 未生效」 */
  | 'missing'
  /** 没拿到在线结论（离线 / 未探测 / 适配器未上报） */
  | 'unknown';

/**
 * 判定只看「D1 期望配置」与「节点实装」两路事实：
 * - 不把"没有站点"推断成"存在外部配置"——是否真有未托管站点块只能由
 *   `caddy_import_scan` 回答，那属于站点页的扫描结果，不在这里猜。
 * - WireGuard / 端口转发没有接管动作，0 条时也只表达"已安装 + 空"。
 */
export function appPresence(
  configured: boolean,
  effectiveCount: number | null,
  live: { installed?: boolean | null } | undefined,
): AppPresence {
  if (live?.installed === false) return configured ? 'missing' : 'unknown';
  if (live?.installed !== true) return 'unknown';
  if (!configured) return 'unconfigured';
  if (effectiveCount === 0) return 'installed-empty';
  return 'managed';
}

/**
 * 是否真的扫描到外部站点块（`caddy_import_scan` 的 `blocks`）。
 * 这是「外部安装 · 未纳管」唯一的显示条件——0 站点不等于有未托管配置。
 */
export function hasExternalBlocks(blocks: readonly unknown[] | undefined): boolean {
  return (blocks?.length ?? 0) > 0;
}
