/**
 * 失败单元的取值顺序（2026-11-16 U2）。
 *
 * 背景：失败单元过去只在 `/state` 采集，而 `/state` 只在打开页面时拉一次。
 * 10 秒轮询的快照不含它，于是「重启修好了服务，状态带还显示旧计数」——
 * 真机复现见 `docs/verification/2026-11-16/ui-polish-u1.md`。
 *
 * Agent 0.3.3 起快照带 `failedUnits`，但**旧 Agent 不会返回**，所以取值必须分三态：
 *
 * 1. 快照有该字段（数组，可为空）→ 用它。空数组 = 确实没有失败单元。
 * 2. 快照没有该字段（旧 Agent）→ 退回 `/state` 的 `ops.services.failedUnits`。
 * 3. 两处都没有 → 返回 `null`，表示「不知道」。
 *
 * 返回 `null` 与返回 `[]` 在页面上是完全不同的文案：
 * 「没有失败单元」vs「读不到失败单元」。**不能合并**。
 */

type OpsLike = {
  failedUnits?: string[] | null;
  services?: { failedUnits?: string[] | null } | null;
} | null | undefined;

export function pickFailedUnits(
  snapshotOps: OpsLike,
  stateServices?: { failedUnits?: string[] | null } | null,
): string[] | null {
  // 1. 快照顶层（Agent 0.3.3+）。注意空数组要算有效值，不能被 `||` 当成假值跳过。
  const fromSnapshot = snapshotOps?.failedUnits;
  if (Array.isArray(fromSnapshot)) return fromSnapshot;

  // 2. 快照的 ops.services（老路径，部分 Agent 版本把失败单元放在这里）
  const fromSnapshotServices = snapshotOps?.services?.failedUnits;
  if (Array.isArray(fromSnapshotServices)) return fromSnapshotServices;

  // 3. /state 的 ops.services
  if (Array.isArray(stateServices?.failedUnits)) return stateServices!.failedUnits!;

  return null;
}
