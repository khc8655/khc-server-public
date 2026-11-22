/**
 * 主机运维服务写操作成功后的精确刷新（2026-11-16 U1 缺陷链的 B2 收敛版）。
 *
 * 历史缺陷链（oracle-x86-2 复现，见 docs/verification/2026-11-16/ui-polish-u1.md）：
 * - 运维页与概况页的「服务 N 个失败」来自轻量快照 `/snapshot` 的 `failedUnits`（每次现采，不进 ops 5s 缓存）；
 * - 过去只重拉 `svc.list` 时状态带计数仍冻在旧值；又曾退而求其次带 `force=1` 重拉整份 `/state`，开销过重；
 * - 现在精确失效 `svc.list` 并触发 `live.refresh()` 拉一帧 `/snapshot`；同时避开 Worker `/snapshot`
 *   2 秒同节点去重窗口，避免刚完成操作却拿到上一帧的旧失败计数。
 */
import type { QueryClient } from '@tanstack/react-query';
import { HOST_OPS_TARGET_SELF, hostOpsQueryKey } from '../../data/hostOps';
import type { SnapshotObservation } from '../../data/snapshot';

/** 避开 Worker `routes/snapshot.ts` `DEDUPE_MS = 2_000` 的安全等待间隔。 */
export const SNAPSHOT_DEDUPE_DELAY_MS = 2_100;

/**
 * 服务类写操作（`svc.restart` / `svc.reset-failed`）成功后调用：
 * 1. 失效 `svc.list` 缓存 key，触发当前分段重新读取最新服务表；
 * 2. 若距上次 `/snapshot` 请求不足 2.1s，延迟到满 2.1s 再调用 `live.refresh()` 刷新失败计数；
 * 3. 不请求整份 `/state` 或 `/overview`。
 */
export async function refreshAfterServiceWrite(
  queryClient: Pick<QueryClient, 'invalidateQueries'>,
  hubId: string,
  live: Pick<SnapshotObservation, 'lastAt' | 'refresh'>,
  now: () => number = Date.now,
): Promise<void> {
  await queryClient.invalidateQueries({
    queryKey: hostOpsQueryKey(hubId, HOST_OPS_TARGET_SELF, 'svc.list', {}),
  });
  const elapsed =
    live.lastAt === null ? SNAPSHOT_DEDUPE_DELAY_MS : Math.max(0, now() - live.lastAt);
  const remaining = SNAPSHOT_DEDUPE_DELAY_MS - elapsed;
  if (remaining <= 0) {
    live.refresh();
    return;
  }
  setTimeout(() => {
    live.refresh();
  }, remaining);
}
