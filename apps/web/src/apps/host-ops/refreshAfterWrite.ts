/**
 * 主机运维写操作成功后的统一刷新（2026-11-16 §5 / N-3）。
 *
 * 缺陷链（真机实测于 oracle-x86-2 确认，见 docs/verification/2026-11-16/ui-polish-u1.md）：
 *
 * 1. 状态带的「服务 N 个失败」来自打开页面时那一次 `/state`；
 * 2. 10 秒快照（`/snapshot`）**不含** services / failedUnits，重启成功后它不会变；
 * 3. 「刷新」只重拉 `svc.list`，列表变了、计数不动 —— 页面自相矛盾。
 *
 * 还有一层容易漏：Agent 的 ops 采集有 **5 秒进程内缓存**（`khc/ops.py` 的
 * `CACHE_TTL`）。所以「写成功后立刻失效查询」仍可能读到缓存里的旧值（真机复现：
 * 重启成功后立即读 `/state`，失败单元仍是旧的）。
 * 因此这里不是单纯 invalidate，而是**带 `force=1` 重新拉取**，让 Agent 跳过缓存
 * 重新跑 systemctl（Agent 0.3.2 起支持 `GET /state?force=1`）。
 */
import type { QueryClient } from '@tanstack/react-query';
import { fetchHubState } from '../../data/hubs';

/** `/state` 的 queryKey 前缀；与 `hubStateQueryOptions` 保持同一口径。 */
export const hubStateQueryKey = (hubId: string) => ['hubs', hubId, 'state'] as const;

/**
 * 写操作成功后调用：
 * - 用 `force=1` 重新拉 `/state` 并写入缓存（绕过 Agent 的 5 秒 ops 缓存）；
 * - 拉取失败时退回 invalidate，让页面下次进入时重试，不抛错打断写操作的收尾。
 * 服务列表由调用方自己的 `load()` 重拉（它不经过 react-query）。
 */
export async function refreshAfterWrite(
  queryClient: Pick<QueryClient, 'invalidateQueries' | 'setQueryData'>,
  hubId: string,
): Promise<void> {
  try {
    const fresh = await fetchHubState(hubId, { force: true });
    queryClient.setQueryData(hubStateQueryKey(hubId), fresh);
  } catch {
    // 刷新失败不影响「写操作本身已成功」这个事实：退回失效，等下次进入重试。
    await queryClient.invalidateQueries({ queryKey: hubStateQueryKey(hubId) });
  }
}
