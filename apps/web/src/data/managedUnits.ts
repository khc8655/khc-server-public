/**
 * 面板受管 systemd 单元名单（2026-11-16 P-3 A / N-4）。
 *
 * 「需要处理」只该提示面板能处理的东西。过去把 `systemctl --failed` 的每个单元都
 * 塞进去，包括 `unattended-upgrades.service` 这类与面板无关的系统单元 —— 面板管不了，
 * 提示就永远挂着，最后用户学会无视整条提示。
 *
 * 名单**只写在这一处**：页面与组件不得散写单元名。新增受管单元先改这里并补单测。
 */

/** 精确匹配的单元名（含 `.service`）。 */
export const MANAGED_UNITS: readonly string[] = ['caddy.service', 'khc-agent.service'];

/** 前缀匹配：`khc-*`（Agent 自己写的 unit）与 `khc-app-*`（脚本式应用）走 `khc-` 前缀。 */
const MANAGED_PREFIXES: readonly string[] = ['khc-', 'khc-app-'];

/** 模板单元实例：`wg-quick@wg0.service` 这类。 */
const MANAGED_TEMPLATES: readonly string[] = ['wg-quick@'];

/**
 * 该单元是否由面板管理。
 *
 * 判定顺序：精确名单 → 模板前缀 → `khc-` 前缀。未知单元一律**不算**受管
 * （宁可不在「需要处理」里提示，也不制造面板无法消除的告警）。
 */
export function isManagedUnit(unit: string | null | undefined): boolean {
  const name = (unit ?? '').trim();
  if (!name) return false;
  if (MANAGED_UNITS.includes(name)) return true;
  if (MANAGED_TEMPLATES.some((prefix) => name.startsWith(prefix))) return true;
  return MANAGED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** 把失败单元拆成「面板受管」与「系统单元」两拨，顺序保持不变。 */
export function splitFailedUnits(units: readonly string[]): {
  managed: string[];
  system: string[];
} {
  const managed: string[] = [];
  const system: string[] = [];
  for (const unit of units) {
    (isManagedUnit(unit) ? managed : system).push(unit);
  }
  return { managed, system };
}
