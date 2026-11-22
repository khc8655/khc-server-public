/** Hub 单控制面通道模型。
 *
 * 控制面（浏览器 -> Worker -> Hub）只在打开工作区时经 `/overview` 探测一次
 * （判断可写 + 更新可达租约），不做周期轮询。
 * 10 秒快照轮询统一经 Worker `/nodes/:id/snapshot` 转发（同源多标签经
 * BroadcastChannel 共享一个计时器，只有 leader 发请求）。
 */
import type { SnapshotObservation, SnapshotStatus } from './snapshot';

export type HubPresence = 'managed-online' | 'offline' | 'unknown';
/** 运维观测数据来源：统一经控制面转发快照，或尚未启动。 */
export type ObservationSource = 'forward' | 'none';

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
  // 控制面探测失败但节点列表仍标记在线（lastSeen 租约未过期）时属于「未确认」，
  // 不能直接宣称离线，否则会和概况页的「在线」互相矛盾。
  const presence: HubPresence =
    controlReachable === true
      ? 'managed-online'
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
