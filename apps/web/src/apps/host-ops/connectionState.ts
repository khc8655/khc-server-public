/**
 * 统一连接指示（单控制面通道）。
 *
 * 所有状态观测、主机运维与配置变更统一经控制面（Worker → Agent），
 * 节点栏只展示三态：在线 / 离线 / 探测中。
 */
import type { HubChannels } from '../../data/channels';

export type ConnectionTone = 'ok' | 'warn' | 'neutral' | 'danger';

export interface ConnectionState {
  /** 指示上的短文案 */
  label: string;
  tone: ConnectionTone;
  /** 三态归类：在线 / 离线 / 未确认 */
  kind: 'online' | 'offline' | 'unknown';
}

export interface ChannelRow {
  /** 数据类别：指标 / 主机运维 / 服务清单 */
  name: string;
  /** 该类别实际走的通道 */
  channel: string;
}

/**
 * 由控制面可达性推导三态指示：在线 / 离线 / 探测中。
 */
export function connectionState(
  channels: Pick<HubChannels, 'presence'>,
): ConnectionState {
  if (channels.presence === 'offline') {
    return { label: '离线', tone: 'danger', kind: 'offline' };
  }
  if (channels.presence === 'managed-online') {
    return { label: '在线', tone: 'ok', kind: 'online' };
  }
  return { label: '探测中', tone: 'neutral', kind: 'unknown' };
}

/**
 * 每类数据统一走控制面（浏览器 → Worker → Agent）。
 */
export function channelRows(): ChannelRow[] {
  return [
    { name: '指标（CPU / 内存 / 磁盘 / 负载）', channel: '经控制面（10s）' },
    { name: '主机运维（服务 / 进程 / 防火墙 / 公钥 / 定时任务）', channel: '经控制面' },
    { name: '服务清单与失败单元', channel: '经控制面（打开页面时读取一次）' },
  ];
}
