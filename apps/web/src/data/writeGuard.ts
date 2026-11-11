/** 浏览器侧写操作闸门：控制面不可达时区分"保存"与"执行"两类写请求。
 *
 * 保存类（PUT 应用配置 / PUT 节点字段）只写 D1，与 Worker→Hub 通道无关，永远放行；
 * 执行类（plan/apply/rollback/自定义动作等）必须转发到 Hub，离线时拦截。
 * 这不是服务端授权，只是避免 UI 在明确不可执行时仍把请求发出去；服务端仍然按
 * 自己的鉴权/审计规则拒绝或执行。
 */
let active: { hubId: string; canMutate: boolean; reason: string } | null = null;

export function setHubWriteGuard(next: { hubId: string; canMutate: boolean; reason: string } | null): void {
  active = next;
}

function isMutating(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

/** 保存类纯 D1 写：`PUT /nodes/:id/apps/:app`（应用配置）与 `PUT /nodes/:id`（节点字段）。 */
const SAVE_PUT_PATTERN = /^\/api\/v1\/nodes\/[^/]+(?:\/apps\/[^/]+)?$/;

function isSavePut(path: string, method: string): boolean {
  if (method.toUpperCase() !== 'PUT') return false;
  return SAVE_PUT_PATTERN.test(path);
}

/**
 * 命令生成类：只读 D1（解密 token）+ 发布清单，返回一段给人在节点上粘贴的文本，
 * **完全不触达 Hub**。节点离线时恰恰最需要它（卸载完要重装、装新机还没有 Agent），
 * 所以离线时同样放行。2026-11-07 真机：卸载后节点必然离线，UI 报
 * "控制面无法访问 Hub，写操作已禁用"，等于卸载成了单程票。
 */
const COMMAND_GEN_PATTERN = /^\/api\/v1\/nodes\/[^/]+\/agent\/(?:install|uninstall)-command$/;

export function assertHubWriteAllowed(path: string, init: RequestInit = {}): void {
  if (!active || active.canMutate) return;
  if (!isMutating(init.method ?? 'GET')) return;
  const prefix = `/api/v1/nodes/${encodeURIComponent(active.hubId)}/`;
  if (!path.startsWith(prefix)) return;
  // ticket 是只读观测的入口，必须允许。
  if (path.includes('/live-ticket')) return;
  // 保存类只写 D1（rev+1，applied_rev 保持），离线时仍然允许。
  if (isSavePut(path, init.method ?? 'GET')) return;
  // 生成安装/卸载命令是纯文本产出，不下发到 Hub，离线时必须可用。
  if (COMMAND_GEN_PATTERN.test(path)) return;
  throw new Error(active.reason || '控制面不可达，执行类操作暂停（保存配置不受影响）');
}
