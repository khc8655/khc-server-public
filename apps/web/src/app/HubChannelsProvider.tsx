import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { NodeStateResponse } from '@khc/contracts';
import type { SnapshotObservation } from '../data/snapshot';
import { useHubChannels, type HubChannels } from '../data/channels';
import { hubQueryOptions } from '../data/queries';
import { setHubWriteGuard } from '../data/writeGuard';
import { Banner, Button, Row } from '../ui';
import { zh, fmt } from '../i18n/zh';
import { formatStamp } from '../i18n/format';

interface HubChannelsContextValue {
  hubId: string;
  stateQuery: UseQueryResult<NodeStateResponse, Error>;
  live: SnapshotObservation;
  channels: HubChannels;
}

const HubChannelsContext = createContext<HubChannelsContextValue | null>(null);

export function HubChannelsProvider({
  hubId,
  liveEndpoint,
  children,
}: {
  hubId: string;
  liveEndpoint: string | null | undefined;
  children: ReactNode;
}) {
  // 节点列表状态只作为「探测未出结果时的参考」：控制面探测失败但列表仍在线时
  // 保持 unknown，不能把未确认直接当成离线（否则与概况页状态互相矛盾）。
  const hubQuery = useQuery(hubQueryOptions(hubId));
  const value = useHubChannels(hubId, liveEndpoint, {
    knownStatus: hubQuery.data?.status ?? null,
  });
  const { canApply, presence, control } = value.channels;

  useEffect(() => {
    setHubWriteGuard(
      control.reachable === false
        ? {
            hubId,
            canMutate: false,
            reason: presence === 'live-only' ? zh.channels.liveOnlyDesc : zh.channels.controlFailed,
          }
        : null,
    );
    return () => setHubWriteGuard(null);
  }, [canApply, control.reachable, hubId, presence]);

  return <HubChannelsContext.Provider value={{ hubId, ...value }}>{children}</HubChannelsContext.Provider>;
}

export function useHubChannelsContext(): HubChannelsContextValue {
  const value = useContext(HubChannelsContext);
  if (!value) throw new Error('useHubChannelsContext 必须在 HubChannelsProvider 内使用');
  return value;
}

/**
 * 状态快照提示条：区分「实时（10s）」「无域名 · 仅快照」「已停止自动刷新 · 截至 xx:xx」。
 * 只做信息展示 + 手动刷新，不新增导航/页面范式。
 */
export function HubSnapshotNotice() {
  const { live } = useHubChannelsContext();
  if (live.mode === 'none') return null;
  if (live.status === 'disabled' && live.receivedAt === null && live.error === null) return null;

  const at = live.receivedAt !== null ? formatStamp(live.receivedAt) : null;
  const updated = at ? ` · ${fmt(zh.snapshot.updatedAt, { time: at })}` : '';
  let text: string;
  if (live.status === 'stopped') {
    text = fmt(zh.snapshot.stoppedAt, { time: at ?? '—' });
  } else if (live.mode === 'forward') {
    text = `${zh.snapshot.modeForward}${updated}`;
  } else {
    text = `${zh.snapshot.modeDirect}${updated}`;
  }
  // 直连失败时用户侧只说「暂不可用」；CORS / KHC_LIVE_ORIGINS 等排障术语收进可展开详情。
  const directFailed = live.status === 'fallback' && live.mode === 'direct';
  // 已停表时不会再自动重试，不能提示「将按 10s 重试」。
  if (live.status === 'fallback') {
    text = directFailed
      ? `${text} · ${zh.snapshot.unavailableShort}`
      : `${text} · ${fmt(zh.snapshot.unavailable, { reason: live.error ?? zh.snapshot.unknownReason })}`;
  }

  return (
    <>
      {/* 状态 + 手动刷新：停表后没有自动重试，必须给主人一个显式恢复入口。 */}
      <Row justify="between" gap={2}>
        <span className="ui-muted">{text}</span>
        <Row gap={2}>
          {live.status === 'stopped' ? (
            <Button label={zh.snapshot.refresh} size="sm" onClick={() => live.refresh()} />
          ) : null}
          {live.status === 'fallback' && live.mode === 'direct' ? (
            <Button label={zh.snapshot.readForward} size="sm" onClick={() => live.readForward()} />
          ) : null}
        </Row>
      </Row>
      {directFailed && live.error ? (
        <details className="ui-muted">
          <summary>{zh.snapshot.detail}</summary>
          <div>{live.error}</div>
        </details>
      ) : null}
    </>
  );
}

/** Hub 工作区顶部的只读提示；只在明确离线或仅观测可达时出现，避免把「探测中」误报成离线。 */
export function HubReadOnlyNotice() {
  const { channels, stateQuery } = useHubChannelsContext();
  if (channels.presence !== 'offline' && channels.presence !== 'live-only') return null;
  return (
    <Banner
      tone={channels.presence === 'live-only' ? 'warn' : 'danger'}
      title={channels.presence === 'live-only' ? zh.channels.liveOnlyTitle : zh.channels.controlUnavailableTitle}
      description={
        channels.presence === 'live-only'
          ? zh.channels.liveOnlyDesc
          : zh.channels.controlUnavailableDesc
      }
      action={
        <Button
          label={zh.channels.retryControl}
          size="sm"
          loading={stateQuery.isFetching}
          onClick={() => void stateQuery.refetch()}
        />
      }
    />
  );
}
