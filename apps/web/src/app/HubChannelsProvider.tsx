import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { Node, NodeOverviewResponse, NodeStateResponse } from '@khc/contracts';
import { useHubSnapshot, type SnapshotObservation } from '../data/snapshot';
import { deriveHubChannels, shouldRetryControlProbe, type HubChannels } from '../data/channels';
import { fetchHubOverview } from '../data/hubs';
import {
  fillHubOverviewCaches,
  hubOverviewQueryOptions,
  hubStateQueryOptions,
  refreshHubRuntime,
  useMarkHubReachable,
} from '../data/queries';
import { setHubWriteGuard } from '../data/writeGuard';
import { Banner, Button } from '../ui';
import { zh, fmt } from '../i18n/zh';
import { formatStamp } from '../i18n/format';
import { channelRows, connectionState } from '../apps/host-ops/connectionState';

interface HubChannelsContextValue {
  hubId: string;
  stateQuery: UseQueryResult<NodeStateResponse, Error>;
  overviewQuery: UseQueryResult<NodeOverviewResponse, Error>;
  runtimePending: boolean;
  runtimeError: Error | null;
  refreshRuntime: (opts?: { force?: boolean }) => Promise<void>;
  live: SnapshotObservation;
  channels: HubChannels;
}

const HubChannelsContext = createContext<HubChannelsContextValue | null>(null);

export function HubChannelsProvider({
  hubId,
  children,
}: {
  hubId: string;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();

  // 工作区单一取数入口：始终通过 /overview 获取节点详情、控制面状态与 D1 摘要，并回填共享缓存。
  const baseOverviewOptions = hubOverviewQueryOptions(hubId);
  const overviewQuery = useQuery({
    ...baseOverviewOptions,
    queryFn: async () => {
      const data = await fetchHubOverview(hubId);
      fillHubOverviewCaches(queryClient, hubId, data);
      return data;
    },
    enabled: Boolean(hubId),
  });

  useEffect(() => {
    const data = overviewQuery.data;
    if (!data) return;
    fillHubOverviewCaches(queryClient, hubId, data);
  }, [hubId, overviewQuery.data, queryClient]);

  // stateQuery 只作禁用状态缓存订阅（由 overview 回填），页面不得调用 stateQuery.refetch()。
  const stateQuery = useQuery({
    ...hubStateQueryOptions(hubId),
    enabled: false,
  });

  const live = useHubSnapshot(hubId);
  useMarkHubReachable(hubId, overviewQuery.data?.reachable);

  const listHubStatus =
    queryClient.getQueryData<Node[]>(['hubs'])?.find((node) => node.id === hubId)?.status ?? null;
  const knownStatus = overviewQuery.data?.node?.status ?? listHubStatus;

  const channels = deriveHubChannels({
    controlReachable: overviewQuery.data?.reachable ?? stateQuery.data?.reachable ?? null,
    controlError: overviewQuery.data?.error ?? stateQuery.data?.error ?? null,
    live,
    knownStatus,
  });

  // D-03：控制面探测失败后，如果快照出现了新帧或请求异常恢复，有限自动补探 /overview（最多 3 次）。
  const attempts = useRef(0);
  useEffect(() => {
    attempts.current = 0;
  }, [hubId]);

  const controlReachable = overviewQuery.data?.reachable;
  const failed = overviewQuery.isError;
  const hasLiveFrame =
    (live.status === 'live' || live.status === 'stopped' || live.status === 'fallback') &&
    live.snapshot !== null;
  const lastFrameTs = live.snapshot?.ts ?? null;

  useEffect(() => {
    if (!hubId) return;
    if (controlReachable === true || (!failed && controlReachable == null)) {
      attempts.current = 0;
      return;
    }
    if (
      !shouldRetryControlProbe({
        attempts: attempts.current,
        controlReachable,
        hasLiveFrame,
        fetching: overviewQuery.isFetching,
        failed,
      })
    ) {
      return;
    }
    const retry = () => {
      attempts.current += 1;
      void overviewQuery.refetch();
    };
    if (failed && controlReachable !== false) {
      const timer = setTimeout(retry, 1_500);
      return () => clearTimeout(timer);
    }
    retry();
  }, [
    controlReachable,
    failed,
    hasLiveFrame,
    hubId,
    lastFrameTs,
    overviewQuery.isFetching,
    overviewQuery.refetch,
  ]);

  const { canApply, control } = channels;

  useEffect(() => {
    setHubWriteGuard(
      control.reachable === false
        ? {
            hubId,
            canMutate: false,
            reason: zh.channels.controlFailed,
          }
        : null,
    );
    return () => setHubWriteGuard(null);
  }, [canApply, control.reachable, hubId]);

  const refreshRuntime = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!hubId) return;
      await refreshHubRuntime(queryClient, hubId, opts);
    },
    [hubId, queryClient],
  );

  return (
    <HubChannelsContext.Provider
      value={{
        hubId,
        stateQuery,
        overviewQuery,
        runtimePending: overviewQuery.isPending,
        runtimeError: overviewQuery.error,
        refreshRuntime,
        live,
        channels,
      }}
    >
      {children}
    </HubChannelsContext.Provider>
  );
}

export function useHubChannelsContext(): HubChannelsContextValue {
  const value = useContext(HubChannelsContext);
  if (!value) throw new Error('useHubChannelsContext 必须在 HubChannelsProvider 内使用');
  return value;
}

/**
 * 节点栏的统一连接指示数据：三态 + 每类数据走控制面说明。
 */
export function useConnectionIndicator(): {
  state: { label: string; tone: 'ok' | 'warn' | 'neutral' | 'danger' };
  rows: ReadonlyArray<{ name: string; channel: string }>;
} {
  const { channels } = useHubChannelsContext();
  const state = connectionState(channels);
  return { state: { label: state.label, tone: state.tone }, rows: channelRows() };
}

/**
 * 节点栏右侧同步状态与统一刷新入口：
 * 收口原本压在内容区主按钮上方的快照提示条；点击时同时强制刷新控制面 `/overview?force=1`
 * （含 Peer 在线状态、站点与服务）并重置 10s 自动快照预算。
 */
export function HubBarRefreshControl() {
  const { live, overviewQuery, refreshRuntime } = useHubChannelsContext();
  const [pending, setPending] = useState(false);

  const snapshotAt = live.receivedAt ?? 0;
  const overviewAt = overviewQuery.dataUpdatedAt ?? 0;
  const latestMs = Math.max(snapshotAt, overviewAt);
  const timeText = latestMs > 0 ? formatStamp(latestMs) : null;

  let statusText: string;
  if (live.mode === 'none') {
    statusText = timeText ? fmt(zh.snapshot.updatedAt, { time: timeText }) : zh.snapshot.noData;
  } else if (live.status === 'stopped') {
    statusText = timeText ? `${zh.snapshot.stoppedShort} · ${timeText}` : zh.snapshot.stoppedShort;
  } else if (live.status === 'fallback') {
    statusText = timeText
      ? `${zh.snapshot.unavailableShort} · ${timeText}`
      : zh.snapshot.unavailableShort;
  } else {
    statusText = timeText ? `${zh.snapshot.modeForward} · ${timeText}` : zh.snapshot.modeForward;
  }

  const title =
    live.status === 'fallback' && live.error
      ? fmt(zh.snapshot.unavailable, { reason: live.error })
      : zh.snapshot.refreshTitle;

  const busy = pending || overviewQuery.isFetching;

  const handleRefresh = () => {
    if (busy) return;
    setPending(true);
    if (live.mode !== 'none') live.restart();
    void refreshRuntime({ force: true }).finally(() => setPending(false));
  };

  return (
    <div className="ui-hubbar-sync">
      <span className="ui-hubbar-sync-text" title={title}>
        {statusText}
      </span>
      <Button
        label={busy ? zh.snapshot.refreshing : zh.snapshot.refresh}
        size="sm"
        loading={busy}
        onClick={handleRefresh}
      />
    </div>
  );
}

/** Hub 工作区顶部的只读提示；只在明确离线时出现，避免把「探测中」误报成离线。 */
export function HubReadOnlyNotice() {
  const { channels, overviewQuery, refreshRuntime } = useHubChannelsContext();
  if (channels.presence !== 'offline') return null;
  return (
    <Banner
      tone="danger"
      title={zh.channels.controlUnavailableTitle}
      description={zh.channels.controlUnavailableDesc}
      action={
        <Button
          label={zh.channels.retryControl}
          size="sm"
          loading={overviewQuery.isFetching}
          onClick={() => void refreshRuntime()}
        />
      }
    />
  );
}
