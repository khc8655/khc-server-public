/**
 * 概况页「对外服务」三组列表（2026-11-16 P-2）。
 *
 * 分工：上方指标卡负责计数，这里负责列名字。曾经的重复是「站点 1 / 反代 1」
 * 在上下两处各说一遍。
 *
 * 约束（提案 §2）：
 * - 每组最多 5 行，超出给一行「全部 N 个 ›」；
 * - 整行可点，不是蓝色链接；
 * - 行内容只放「状态 + 名字 + 一行补充」，不再复述计数。
 */
import type { WgPeer } from '../data/wireguard';
import type { CaddySite } from '../data/sites';
import type { ForwardRule } from '../data/forwards';

/** 每组最多列几行，超出折叠成「全部 N 个 ›」。 */
export const SERVICE_ROW_LIMIT = 5;

export type ServiceRowTone = 'ok' | 'warn' | 'danger' | 'neutral';

export interface ServiceRowItem {
  key: string;
  tone: ServiceRowTone;
  /** 主名：域名 / 转发名 / Peer 名 */
  name: string;
  /** 右侧补充：后端地址、对外端口、最近握手 */
  detail: string;
}

export interface ServiceRowGroup {
  /** 分组标题 */
  title: string;
  /** 该组全部条目数（用于「全部 N 个」） */
  total: number;
  /** 最多 SERVICE_ROW_LIMIT 条 */
  items: ServiceRowItem[];
  /** 超出时为 true，调用方据此渲染「全部 N 个 ›」 */
  truncated: boolean;
  /** 该组是否已安装/已配置；false 时渲染一行灰色「未安装」，不展开 */
  installed: boolean;
}

function clip(items: ServiceRowItem[]): { items: ServiceRowItem[]; truncated: boolean } {
  if (items.length <= SERVICE_ROW_LIMIT) return { items, truncated: false };
  return { items: items.slice(0, SERVICE_ROW_LIMIT), truncated: true };
}

/**
 * 网页服务：每行一个站点，「域名 → 后端」。
 *
 * 停用的站点也列出来（灰色），因为「看不见的停用站点」比列表更长更难发现。
 * `installed=false` 表示 Agent 明确报告 Caddy 未安装，该组渲染一行「未安装」，
 * 而不是把 D1 里的配置伪装成生效中。
 */
export function siteRows(sites: CaddySite[], installed = true): ServiceRowGroup {
  if (!installed) {
    return { title: '网页服务', total: 0, items: [], truncated: false, installed: false };
  }
  const items: ServiceRowItem[] = sites.map((site) => ({
    key: site.name || site.domain,
    tone: site.enabled ? 'ok' : 'neutral',
    name: site.domain || site.name,
    detail: site.upstream || site.upstreams[0] || '—',
  }));
  const { items: shown, truncated } = clip(items);
  return {
    title: '网页服务',
    total: items.length,
    items: shown,
    truncated,
    installed: true,
  };
}

/** 远程访问：每行一条转发规则，「名称 + 对外端口 → 目标」。 */
export function forwardRows(forwards: ForwardRule[], installed = true): ServiceRowGroup {
  if (!installed) {
    return { title: '远程访问', total: 0, items: [], truncated: false, installed: false };
  }
  const items: ServiceRowItem[] = forwards.map((forward) => ({
    key: forward.name,
    tone: forward.enabled ? 'ok' : 'neutral',
    name: forward.name,
    detail: `:${forward.listenPort} → ${forward.targetHost}:${forward.targetPort}`,
  }));
  const { items: shown, truncated } = clip(items);
  return {
    title: '远程访问',
    total: items.length,
    items: shown,
    truncated,
    installed: true,
  };
}

/** 最近握手时间的相对文案；未握手返回「未握手」。 */
export function handshakeLabel(latestHandshake: number | null | undefined, nowSec: number): string {
  if (!latestHandshake || latestHandshake <= 0) return '未握手';
  const delta = Math.max(0, nowSec - latestHandshake);
  if (delta < 60) return '刚刚握手';
  if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`;
  return `${Math.floor(delta / 86400)} 天前`;
}

/**
 * Peer：每行一个，「状态 + 名称 + 最近握手」。
 *
 * `runtime` 只要求「名字 + 在线 + 握手时间」三项：页面拿到的运行时是精简投影，
 * 不保证带公钥等全字段。undefined 表示运行时数据还没到（状态显示中性，不谎报离线）。
 */
export function peerRows(
  peers: WgPeer[],
  runtime: ReadonlyArray<{ name: string; online?: boolean; latestHandshake?: number }> | undefined,
  nowSec: number,
  installed: boolean,
): ServiceRowGroup {
  if (!installed) {
    return { title: 'Peer', total: 0, items: [], truncated: false, installed: false };
  }
  const items: ServiceRowItem[] = peers
    .filter((peer) => peer.enabled)
    .map((peer) => {
      const live = runtime?.find((item) => item.name === peer.name);
      return {
        key: peer.name,
        tone: live?.online === true ? 'ok' : runtime === undefined ? 'neutral' : 'warn',
        name: peer.name,
        detail: live ? handshakeLabel(live.latestHandshake, nowSec) : '—',
      };
    });
  const { items: shown, truncated } = clip(items);
  return {
    title: 'Peer',
    total: items.length,
    items: shown,
    truncated,
    installed: true,
  };
}
