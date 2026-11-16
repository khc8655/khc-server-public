/**
 * 概况页「对外服务」三组列表（2026-11-16 P-2）。
 *
 * 回归目标：过去这张卡片把「站点 1 · 本机 1」「Peer 1/1 在线」再写一遍，
 * 与上方指标卡完全重复。现在卡片只列名字，计数只在上面。
 */
import { describe, expect, it } from 'vitest';
import { SERVICE_ROW_LIMIT, forwardRows, handshakeLabel, peerRows, siteRows } from './hubServiceRows';
import type { CaddySite } from '../data/sites';
import type { ForwardRule } from '../data/forwards';
import type { WgPeer } from '../data/wireguard';

function site(name: string, overrides: Partial<CaddySite> = {}): CaddySite {
  return {
    name,
    kind: 'proxy',
    domain: `${name}.example.com`,
    domains: [`${name}.example.com`],
    listenPort: 443,
    enabled: true,
    upstream: '127.0.0.1:3245',
    upstreams: ['127.0.0.1:3245'],
    lbPolicy: 'round_robin',
    healthUri: '',
    pathRoutes: [],
    root: '',
    browse: false,
    spa: false,
    index: 'index.html',
    tryFiles: [],
    redirectTo: '',
    ...overrides,
  } as CaddySite;
}

function forward(name: string, overrides: Partial<ForwardRule> = {}): ForwardRule {
  return {
    name,
    protocol: 'tcp',
    listenHost: '0.0.0.0',
    listenPort: 8080,
    targetHost: '10.8.0.12',
    targetPort: 22,
    enabled: true,
    note: '',
    ...overrides,
  };
}

function peer(name: string): WgPeer {
  return {
    name,
    publicKey: `pk-${name}`,
    privateKey: '',
    allowedIps: ['10.8.0.12/32'],
    keepalive: 25,
    endpoint: null,
    enabled: true,
  };
}

describe('siteRows', () => {
  it('每行一个站点：域名为主名，后端为补充', () => {
    const group = siteRows([site('app')]);
    expect(group.total).toBe(1);
    expect(group.items[0]!.name).toBe('app.example.com');
    expect(group.items[0]!.detail).toBe('127.0.0.1:3245');
    expect(group.items[0]!.tone).toBe('ok');
  });

  it('停用站点显示中性色，仍列出来（隐藏的停用站点更难发现）', () => {
    const group = siteRows([site('off', { enabled: false })]);
    expect(group.items[0]!.tone).toBe('neutral');
    expect(group.total).toBe(1);
  });

  it(`最多列 ${SERVICE_ROW_LIMIT} 行，超出标记 truncated 并给出总数`, () => {
    const many = Array.from({ length: SERVICE_ROW_LIMIT + 3 }, (_, i) => site(`s${i}`));
    const group = siteRows(many);
    expect(group.items).toHaveLength(SERVICE_ROW_LIMIT);
    expect(group.truncated).toBe(true);
    expect(group.total).toBe(SERVICE_ROW_LIMIT + 3);
  });

  it(`正好 ${SERVICE_ROW_LIMIT} 行时不折叠`, () => {
    const exact = Array.from({ length: SERVICE_ROW_LIMIT }, (_, i) => site(`s${i}`));
    const group = siteRows(exact);
    expect(group.truncated).toBe(false);
    expect(group.items).toHaveLength(SERVICE_ROW_LIMIT);
  });
});

describe('forwardRows', () => {
  it('每行一条规则：「名称 + 对外端口 → 目标」', () => {
    const group = forwardRows([forward('ssh')]);
    expect(group.items[0]!.name).toBe('ssh');
    expect(group.items[0]!.detail).toContain(':8080');
    expect(group.items[0]!.detail).toContain('10.8.0.12:22');
  });

  it('停用规则中性色', () => {
    expect(forwardRows([forward('x', { enabled: false })]).items[0]!.tone).toBe('neutral');
  });
});

describe('peerRows', () => {
  const now = 1_700_000_000;

  it('在线 Peer 绿色 + 握手时间', () => {
    const group = peerRows([peer('a')], [{ name: 'a', online: true, latestHandshake: now - 120 }], now, true);
    expect(group.items[0]!.tone).toBe('ok');
    expect(group.items[0]!.detail).toBe('2 分钟前');
  });

  it('离线 Peer 琥珀色', () => {
    const group = peerRows([peer('a')], [{ name: 'a', online: false, latestHandshake: 0 }], now, true);
    expect(group.items[0]!.tone).toBe('warn');
    expect(group.items[0]!.detail).toBe('未握手');
  });

  it('运行时数据未到时不谎报离线（中性色）', () => {
    const group = peerRows([peer('a')], undefined, now, true);
    expect(group.items[0]!.tone).toBe('neutral');
    expect(group.items[0]!.detail).toBe('—');
  });

  it('停用的 Peer 不列（与「需要处理」口径一致）', () => {
    const disabled = { ...peer('a'), enabled: false };
    expect(peerRows([disabled], [], now, true).items).toHaveLength(0);
  });

  it('未安装时返回 installed=false，调用方渲染「未安装」一行', () => {
    const group = peerRows([peer('a')], [], now, false);
    expect(group.installed).toBe(false);
    expect(group.items).toHaveLength(0);
  });
});

describe('handshakeLabel', () => {
  const now = 1_700_000_000;
  it('按时间跨度给中文相对时间', () => {
    expect(handshakeLabel(0, now)).toBe('未握手');
    expect(handshakeLabel(null, now)).toBe('未握手');
    expect(handshakeLabel(now - 10, now)).toBe('刚刚握手');
    expect(handshakeLabel(now - 300, now)).toBe('5 分钟前');
    expect(handshakeLabel(now - 7200, now)).toBe('2 小时前');
    expect(handshakeLabel(now - 86400 * 2, now)).toBe('2 天前');
  });
});
