/**
 * 统一连接指示（2026-11-16 §4 / P-4 A）。
 *
 * 缺陷背景：「实时状态」卡片上挂「直连」两个字，让人以为整页都直连。实际只有
 * 指标走直连，主机运维（服务/进程/防火墙/公钥/定时任务）一律经 Worker。
 * 没有域名的节点照样能用主机运维，但那个标签会让人误以为「没域名就不可用」。
 *
 * 这里把「哪条数据走哪条通道」收进一个可展开的指示，节点栏只显示三态：
 * 实时 · 直连 / 实时 · 经控制面 / 离线。
 */
import type { HubChannels } from '../../data/channels';
import type { SnapshotObservation } from '../../data/snapshot';

export type ConnectionTone = 'ok' | 'warn' | 'neutral' | 'danger';

export interface ConnectionState {
  /** 指示上的短文案 */
  label: string;
  tone: ConnectionTone;
  /** 三态归类：直连 / 经控制面 / 离线 */
  kind: 'direct' | 'forward' | 'offline' | 'unknown';
}

export interface ChannelRow {
  /** 数据类别：指标 / 主机运维 / 服务清单 */
  name: string;
  /** 该类别实际走的通道 */
  channel: string;
}

/**
 * 由控制面可达性与快照模式推导三态指示。
 *
 * 优先级：控制面明确不可达 → 离线；否则看指标通道（direct / forward）。
 * `live.mode` 为 none 表示节点没配可信域名，指标也走控制面。
 */
export function connectionState(
  channels: Pick<HubChannels, 'presence'>,
  live: Pick<SnapshotObservation, 'mode' | 'status'>,
): ConnectionState {
  if (channels.presence === 'offline') {
    return { label: '离线', tone: 'danger', kind: 'offline' };
  }
  // 仅观测可达要先判：浏览器能直连看指标，但控制面下发不了操作 —— 是警告不是正常。
  if (channels.presence === 'live-only') {
    return { label: '实时 · 直连', tone: 'warn', kind: 'direct' };
  }
  if (live.mode === 'direct' && live.status !== 'fallback') {
    return { label: '实时 · 直连', tone: 'ok', kind: 'direct' };
  }
  if (live.mode === 'forward') {
    return { label: '实时 · 经控制面', tone: 'ok', kind: 'forward' };
  }
  return { label: '实时 · 经控制面', tone: 'neutral', kind: 'forward' };
}

/**
 * 每类数据走哪条通道。指标可能是直连；主机运维与服务清单**一律经控制面**，
 * 与有没有域名无关 —— 这正是原来那个「直连」标签误导的地方。
 */
export function channelRows(
  live: Pick<SnapshotObservation, 'mode' | 'status'>,
): ChannelRow[] {
  const metricDirect = live.mode === 'direct' && live.status !== 'fallback';
  return [
    { name: '指标（CPU / 内存 / 磁盘 / 负载）', channel: metricDirect ? '浏览器直连' : '经控制面' },
    { name: '主机运维（服务 / 进程 / 防火墙 / 公钥 / 定时任务）', channel: '经控制面' },
    { name: '服务清单与失败单元', channel: '经控制面（打开页面时读取一次）' },
  ];
}
