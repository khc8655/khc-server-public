/**
 * 主机运维写操作成功后的统一刷新（2026-11-16 §5 / N-3）。
 *
 * 缺陷背景：状态带的「服务 N 个失败」来自打开页面时那一次 `/state`，10 秒快照
 * 不含失败单元，而「刷新」只重拉 `svc.list`。结果是用重启修好了服务，列表变了、
 * 计数却停在旧值 —— 页面自相矛盾。
 *
 * 这里把两处一起失效：服务清单（`svc.list` 由各分段的本地 state 承载，需显式重拉）
 * 和 `/state`（`['hubs', hubId, 'state']`，失败计数的来源）。U2 把来源换成快照后，
 * 这个失效点仍然成立（快照由 live 通道推送，不受影响）。
 */
import type { QueryClient } from '@tanstack/react-query';

/** `/state` 的 queryKey 前缀；与 `hubStateQueryOptions` 保持同一口径。 */
export const hubStateQueryKey = (hubId: string) => ['hubs', hubId, 'state'] as const;

/**
 * 写操作成功后调用：让 `/state` 重新拉取，把状态带与概况页的失败计数刷新。
 * 服务列表由调用方自己的 `load()` 重拉（它不经过 react-query）。
 */
export async function refreshAfterWrite(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  hubId: string,
): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: hubStateQueryKey(hubId) });
}
