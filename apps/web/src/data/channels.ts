/** Hub 的“控制面 / 观测面”双通道模型。
 *
 * 控制面（浏览器 -> Worker -> Hub）只在打开工作区时探测一次 `/state`
 * （判断可写 + 更新可达租约），不做周期轮询。
 * 观测面 = 10 秒快照轮询：有可信 HTTPS 域名时浏览器直连 Agent（同源多标签经
 * BroadcastChannel 共享一个计时器，只有 leader 发请求），否则经 Worker
 * `/nodes/:id/snapshot` 转发（2 秒去重为单 isolate 尽力而为，不保证跨标签页不放大）。
 */
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { hubStateQueryOptions, useMarkHubReachable } from './queries';
import { useHubSnapshot, type SnapshotObservation, type SnapshotStatus } from './snapshot';

export type HubPresence = 'managed-online' | 'live-only' | 'offline' | 'unknown';
/** 运维观测数据来源：直连 Agent、控制面转发快照，或没有。 */
export type ObservationSource = 'direct' | 'forward' | 'none';

export interface HubChannels {
  control: {
    reachable: boolean | null;
    error: string | null;
  };
  live: {
    status: SnapshotStatus;
    lastFrameAt: number | null;
    error: string | null;
  };
  presence: HubPresence;
  /** 保存期望配置（PUT apps 配置 / 节点字段，纯 D1 写）永远允许，与通道无关。 */
  canSave: boolean;
  /** 执行类动作（plan/apply/rollback/自定义动作）需要 Worker→Hub 通道。 */
  canApply: boolean;
  /** 兼容别名（= canApply）：执行类写闸门。存量页面逐步迁移到 canApply。 */
  canMutate: boolean;
  readSource: ObservationSource;
}

export function deriveHubChannels(input: {
  controlReachable: boolean | null;
  controlError?: string | null;
  live: Pick<SnapshotObservation, 'status' | 'snapshot' | 'error' | 'mode'>;
  knownStatus?: 'online' | 'offline' | 'unknown' | null;
}): HubChannels {
  const { controlReachable, controlError = null, live, knownStatus = null } = input;
  // stopped = 到上限但已有数据；fallback = 请求失败但可能仍有上一帧。
  const liveLive =
    (live.status === 'live' || live.status === 'stopped' || live.status === 'fallback') &&
    live.snapshot !== null;
  // 控制面探测失败但节点列表仍标记在线（lastSeen 租约未过期）时属于「未确认」，
  // 不能直接宣称离线，否则会和概况页的「在线」互相矛盾。
  const presence: HubPresence =
    controlReachable === true
      ? 'managed-online'
      : liveLive
        ? 'live-only'
        : controlReachable === false
          ? knownStatus === 'online'
            ? 'unknown'
            : 'offline'
          : 'unknown';
  return {
    control: { reachable: controlReachable, error: controlError },
    live: {
      status: live.status,
      lastFrameAt: live.snapshot?.ts ?? null,
      error: live.error,
    },
    presence,
    canSave: true,
    canApply: controlReachable === true,
    canMutate: controlReachable === true,
    readSource: live.mode === 'none' ? 'none' : live.mode,
  };
}

/**
 * 控制面探测失败时的自动补探（最多 3 次，仍不做周期轮询）：
 * - 节点级不可达（reachable=false）：要等观测面出现新帧，证明节点确实恢复；
 * - 请求本身失败（reachable=null + failed）：浏览器↔Worker 断链时快照也可能拿不到，
 *   直接有限重试，避免只能手动点「重试」。
 */
export function shouldRetryControlProbe(input: {
  attempts: number;
  controlReachable: boolean | null | undefined;
  hasLiveFrame: boolean;
  fetching: boolean;
  failed?: boolean;
}): boolean {
  if (input.attempts >= 3) return false;
  if (input.fetching) return false;
  if (input.controlReachable === false) return input.hasLiveFrame;
  if (input.failed && input.controlReachable == null) return true;
  return false;
}

export function useHubChannels(
  hubId: string,
  liveEndpoint: string | null | undefined,
  options: { enabled?: boolean; knownStatus?: 'online' | 'offline' | 'unknown' | null } = {},
) {
  // 只在打开工作区时探测一次；手动重试由页面/提示条触发，不做周期轮询。
  const stateQuery = useQuery({
    ...hubStateQueryOptions(hubId),
    enabled: options.enabled ?? true,
  });
  const live = useHubSnapshot(hubId, liveEndpoint);
  useMarkHubReachable(hubId, stateQuery.data?.reachable);
  const channels = deriveHubChannels({
    controlReachable: stateQuery.data?.reachable ?? null,
    controlError: stateQuery.data?.error ?? null,
    live,
    knownStatus: options.knownStatus ?? null,
  });
  // D-03：探测失败后如果快照又拿到了新帧，说明节点已恢复；此时自动补探，
  // 避免按钮一直停留在「待上线后生效」直到整页刷新。最多 3 次，不引入周期轮询。
  const attempts = useRef(0);
  const controlReachable = stateQuery.data?.reachable;
  const failed = stateQuery.isError;
  const hasLiveFrame =
    (live.status === 'live' || live.status === 'stopped' || live.status === 'fallback') &&
    live.snapshot !== null;
  const lastFrameTs = live.snapshot?.ts ?? null;
  useEffect(() => {
    // 成功、或还没失败过：清零计数，下一次断链重新给 3 次机会。
    if (controlReachable === true || (!failed && controlReachable == null)) {
      attempts.current = 0;
      return;
    }
    if (
      !shouldRetryControlProbe({
        attempts: attempts.current,
        controlReachable,
        hasLiveFrame,
        fetching: stateQuery.isFetching,
        failed,
      })
    ) {
      return;
    }
    const retry = () => {
      attempts.current += 1;
      void stateQuery.refetch();
    };
    // 请求本身失败给 1.5s 缓冲，避免网络瞬断时连打 3 次；节点级不可达仍由新帧触发。
    if (failed && controlReachable !== false) {
      const timer = setTimeout(retry, 1_500);
      return () => clearTimeout(timer);
    }
    retry();
  }, [
    controlReachable,
    failed,
    hasLiveFrame,
    lastFrameTs,
    stateQuery.isFetching,
    stateQuery.refetch,
  ]);
  return { stateQuery, live, channels };
}
