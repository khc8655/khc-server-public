import { createContext, useContext, useEffect, type ReactNode } from 'react';
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { NodeOverviewResponse, NodeStateResponse } from '@khc/contracts';
import type { SnapshotObservation } from '../data/snapshot';
import { deriveHubChannels, useHubChannels, type HubChannels } from '../data/channels';
import { fetchHubOverview } from '../data/hubs';
import { hubOverviewQueryOptions, hubQueryOptions } from '../data/queries';
import { setHubWriteGuard } from '../data/writeGuard';
import { Banner, Button, Row } from '../ui';
import { zh, fmt } from '../i18n/zh';
import { formatStamp } from '../i18n/format';
import { channelRows, connectionState } from '../apps/host-ops/connectionState';

interface HubChannelsContextValue {
  hubId: string;
  useOverview: boolean;
  stateQuery: UseQueryResult<NodeStateResponse, Error>;
  overviewQuery: UseQueryResult<NodeOverviewResponse, Error>;
  live: SnapshotObservation;
  channels: HubChannels;
}

const HubChannelsContext = createContext<HubChannelsContextValue | null>(null);

export function HubChannelsProvider({
  hubId,
  useOverview = false,
  children,
}: {
  hubId: string;
  /** 概况页（/hubs/:id）走单请求聚合 /overview，并把 node 与 /state 回填进共享缓存 */
  useOverview?: boolean;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  // 节点列表状态只作为「探测未出结果时的参考」：控制面探测失败但列表仍在线时
  // 保持 unknown，不能把未确认直接当成离线（否则与概况页状态互相矛盾）。
  const hubQuery = useQuery({
    ...hubQueryOptions(hubId),
    enabled: Boolean(hubId) && !useOverview,
  });

  const baseOverviewOptions = hubOverviewQueryOptions(hubId);
  const overviewQuery = useQuery({
    ...baseOverviewOptions,
    queryFn: async () => {
      const data = await fetchHubOverview(hubId);
      queryClient.setQueryData(['hubs', hubId], data.node);
      queryClient.setQueryData<NodeStateResponse>(['hubs', hubId, 'state'], {
        reachable: data.reachable,
        route: data.route,
        via: data.via,
        error: data.error,
        ...(data.epochStale ? { epochStale: data.epochStale } : {}),
        tls: data.tls,
        state: data.state,
      });
      return data;
    },
    enabled: Boolean(hubId) && useOverview,
  });

  useEffect(() => {
    const data = overviewQuery.data;
    if (!useOverview || !data) return;
    queryClient.setQueryData(['hubs', hubId], data.node);
    queryClient.setQueryData<NodeStateResponse>(['hubs', hubId, 'state'], {
      reachable: data.reachable,
      route: data.route,
      via: data.via,
      error: data.error,
      ...(data.epochStale ? { epochStale: data.epochStale } : {}),
      tls: data.tls,
      state: data.state,
    });
  }, [hubId, overviewQuery.data, queryClient, useOverview]);

  const knownStatus = (overviewQuery.data?.node ?? hubQuery.data)?.status ?? null;
  const baseChannels = useHubChannels(hubId, {
    enabled: !useOverview,
    knownStatus,
  });

  const channels = useOverview
    ? deriveHubChannels({
        controlReachable: overviewQuery.data?.reachable ?? baseChannels.stateQuery.data?.reachable ?? null,
        controlError: overviewQuery.data?.error ?? baseChannels.stateQuery.data?.error ?? null,
        live: baseChannels.live,
        knownStatus,
      })
    : baseChannels.channels;

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

  return (
    <HubChannelsContext.Provider
      value={{
        hubId,
        useOverview,
        stateQuery: baseChannels.stateQuery,
        overviewQuery,
        live: baseChannels.live,
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
 * 状态快照提示条：统一展示「实时快照（10s）」与「已停止自动刷新 · 截至 xx:xx」。
 * 只做信息展示 + 手动刷新，不新增导航/页面范式。
 */
export function HubSnapshotNotice() {
  const { live } = useHubChannelsContext();
  if (live.mode === 'none') return null;
  if (live.status === 'disabled' && live.receivedAt === null && live.error === null) return null;

  const at = live.receivedAt !== null ? formatStamp(live.receivedAt) : null;
  const updated = at ? ` · ${fmt(zh.snapshot.updatedAt, { time: at })}` : '';
  let text =
    live.status === 'stopped'
      ? fmt(zh.snapshot.stoppedAt, { time: at ?? '—' })
      : `${zh.snapshot.modeForward}${updated}`;
  if (live.status === 'fallback') {
    text = `${text} · ${fmt(zh.snapshot.unavailable, { reason: live.error ?? zh.snapshot.unknownReason })}`;
  }

  return (
    <Row justify="between" gap={2}>
      <span className="ui-muted">{text}</span>
      {live.status === 'stopped' || live.status === 'fallback' ? (
        <Button label={zh.snapshot.refresh} size="sm" onClick={() => live.refresh()} />
      ) : null}
    </Row>
  );
}

/** Hub 工作区顶部的只读提示；只在明确离线时出现，避免把「探测中」误报成离线。 */
export function HubReadOnlyNotice() {
  const { useOverview, channels, stateQuery, overviewQuery } = useHubChannelsContext();
  if (channels.presence !== 'offline') return null;
  const activeQuery = useOverview ? overviewQuery : stateQuery;
  return (
    <Banner
      tone="danger"
      title={zh.channels.controlUnavailableTitle}
      description={zh.channels.controlUnavailableDesc}
      action={
        <Button
          label={zh.channels.retryControl}
          size="sm"
          loading={activeQuery.isFetching}
          onClick={() => void activeQuery.refetch()}
        />
      }
    />
  );
}
