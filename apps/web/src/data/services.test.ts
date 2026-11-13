import { describe, expect, it } from 'vitest';
import {
  RESERVED_PUBLISH_PORTS,
  classifyBackend,
  ipv4InCidr,
  isLocalListenAddress,
  publishedLocalPorts,
  unpublishedListeningPorts,
} from './services';

const item = (port: number, address = '0.0.0.0', proto = 'tcp') => ({ proto, address, port });
const ops = (items: unknown[]) => ({ network: { listening: { count: items.length, items } } });

const wg = (peers: Array<{ name: string; allowedIps: string[]; online?: boolean }>, installed = true) => ({
  wireguard: { installed, peers },
});

describe('classifyBackend：本机 / 套接字', () => {
  it('localhost、127.0.0.0/8、::1、[::1]:port 都归本机', () => {
    for (const raw of ['localhost:3245', '127.0.0.1:3245', 'http://127.0.0.1:3245', '::1', '[::1]:80']) {
      const info = classifyBackend(raw, wg([]));
      expect(info.kind, raw).toBe('local');
    }
    expect(classifyBackend('127.0.0.1:3245', wg([])).target).toBe('127.0.0.1:3245');
  });

  it('unix// 与 unix: 归本机套接字', () => {
    expect(classifyBackend('unix//run/app.sock', wg([])).kind).toBe('unix');
    expect(classifyBackend('unix:/run/app.sock', wg([])).kind).toBe('unix');
  });

  it('scheme 与路径被剥离，端口保留', () => {
    const info = classifyBackend('https://example.com:8443/api', wg([]));
    expect(info.target).toBe('example.com:8443');
    expect(info.host).toBe('example.com');
    expect(info.port).toBe('8443');
    expect(info.kind).toBe('external');
  });
});

describe('classifyBackend：内网 VM（Peer）', () => {
  it('命中 /32 映射 Peer，带名称与在线状态', () => {
    const info = classifyBackend('10.8.0.2:3000', wg([{ name: 'vm-app', allowedIps: ['10.8.0.2/32'], online: true }]));
    expect(info).toMatchObject({ kind: 'vm', peerName: 'vm-app', peerOnline: true });
  });

  it('命中网段映射 Peer', () => {
    const info = classifyBackend('10.9.0.7:22', wg([{ name: 'vm-net', allowedIps: ['10.9.0.0/24'], online: true }]));
    expect(info).toMatchObject({ kind: 'vm', peerName: 'vm-net' });
  });

  it('Peer 离线：仍是 VM，但 online=false', () => {
    const info = classifyBackend('10.8.0.2:3000', wg([{ name: 'vm-app', allowedIps: ['10.8.0.2/32'], online: false }]));
    expect(info.kind).toBe('vm');
    expect(info.peerOnline).toBe(false);
  });

  it('Peer 在线状态未知：peerOnline=null，不冒充在线', () => {
    const info = classifyBackend('10.8.0.2:3000', wg([{ name: 'vm-app', allowedIps: ['10.8.0.2/32'] }]));
    expect(info.peerOnline).toBeNull();
  });

  it('IPv6 Peer：/128 精确匹配', () => {
    const info = classifyBackend('[fd00::2]:8080', wg([{ name: 'vm6', allowedIps: ['fd00::2/128'], online: true }]));
    expect(info).toMatchObject({ kind: 'vm', peerName: 'vm6' });
  });

  it('私网地址但无对应 Peer：内网（未登记）', () => {
    const info = classifyBackend('192.168.1.20:80', wg([{ name: 'other', allowedIps: ['10.8.0.2/32'], online: true }]));
    expect(info.kind).toBe('internal');
    expect(info.peerName).toBeUndefined();
  });
});

describe('classifyBackend：状态未读取 / 未安装 / 外部', () => {
  it('WireGuard 未安装：10.x 归「外部」，不冒充内网 VM', () => {
    const info = classifyBackend('10.8.0.2:3000', wg([{ name: 'vm-app', allowedIps: ['10.8.0.2/32'], online: true }], false));
    expect(info.kind).toBe('external');
    expect(info.peerName).toBeUndefined();
  });

  it('WireGuard 状态未读取（undefined）：私网归「内网（未登记）」，不猜 Peer', () => {
    const info = classifyBackend('10.8.0.2:3000', {});
    expect(info.kind).toBe('internal');
    expect(info.peerName).toBeUndefined();
  });

  it('公网 IP / 域名：外部', () => {
    expect(classifyBackend('203.0.113.10:443', wg([])).kind).toBe('external');
    expect(classifyBackend('example.com', wg([])).kind).toBe('external');
  });

  it('端口转发不参与后端判定：映射到 10.x 的本机监听仍是本机', () => {
    // 8888 是端口转发的监听端口，但开发没有把它作为输入；上游只按地址识别。
    const info = classifyBackend('127.0.0.1:8888', wg([{ name: 'vm-app', allowedIps: ['10.0.0.5/32'] }]));
    expect(info.kind).toBe('local');
  });

  it('多上游只识别第一个，其余计入 extra', () => {
    const info = classifyBackend('127.0.0.1:3245', wg([]), 2);
    expect(info.target).toBe('127.0.0.1:3245');
    expect(info.extra).toBe(2);
  });
});

describe('ipv4InCidr', () => {
  it('边界与非法输入', () => {
    expect(ipv4InCidr('10.8.0.1', '10.8.0.0/24')).toBe(true);
    expect(ipv4InCidr('10.8.1.1', '10.8.0.0/24')).toBe(false);
    expect(ipv4InCidr('10.8.0.1', '10.8.0.1')).toBe(true);
    expect(ipv4InCidr('example.com', '10.0.0.0/8')).toBe(false);
    expect(ipv4InCidr('10.8.0.1', '10.8.0.0/33')).toBe(false);
    expect(ipv4InCidr('10.8.0.1', '0.0.0.0/0')).toBe(true);
  });
});

describe('本机监听端口（T-C 批次 3）', () => {
  it('去重：同一端口 tcp/tcp6、多地址只保留一个并按端口升序', () => {
    const rows = unpublishedListeningPorts(
      ops([
        item(9100, '::', 'tcp6'),
        item(9000, '0.0.0.0', 'tcp'),
        item(9000, '::', 'tcp6'),
        item(9000, '127.0.0.1', 'tcp'),
        item(9200, '127.0.0.1', 'tcp'),
      ]),
      [],
    );
    expect(rows.map((row) => row.port)).toEqual([9000, 9100, 9200]);
  });

  it('已发布端口不重复列出：upstreams / 旧 upstream / pathRoutes / scheme 都算', () => {
    const rows = unpublishedListeningPorts(
      ops([item(9000), item(9100), item(9200), item(9300), item(9400), item(9500)]),
      [
        { upstreams: ['127.0.0.1:9000'] },
        { upstream: '127.0.0.1:9100' },
        { pathRoutes: [{ upstreams: ['127.0.0.1:9200'] }] },
        { upstreams: ['http://127.0.0.1:9300'] },
        { upstreams: ['localhost:9400'] },
        { upstreams: ['10.9.0.2:9500'] },
      ],
    );
    expect(rows.map((row) => row.port)).toEqual([9500]);
  });

  it('非本机上游不误判为已发布，unix 套接字与非本机地址不计入', () => {
    expect(publishedLocalPorts([
      { upstreams: ['10.9.0.2:3000', 'unix//run/app.sock', 'example.com:3100'] },
      { upstreams: ['127.0.0.1:3200', '127.0.0.1:3200'] },
    ])).toEqual([3200]);
  });

  it('过滤非本机监听地址与保留端口，避免把管理端口发布成站点', () => {
    const reserved = [...RESERVED_PUBLISH_PORTS].map((port) => item(port, '127.0.0.1'));
    const rows = unpublishedListeningPorts(
      ops([
        ...reserved,
        item(9000, '203.0.113.10'),
        item(9100, '10.9.0.2'),
        item(9200, '192.168.1.7'),
        item(9300, '0.0.0.0'),
        item(9400, '::', 'tcp6'),
        item(9500, '127.0.0.1'),
        item(9600, 'localhost'),
        item(9700, '::1', 'tcp6'),
      ]),
      [],
    );
    expect(rows.map((row) => row.port)).toEqual([9300, 9400, 9500, 9600, 9700]);
  });

  it('listening 为空/缺失/形状异常时返回空数组，不抛异常', () => {
    const missing: unknown[] = [
      undefined,
      null,
      {},
      { network: null },
      { network: 'oops' },
      { network: {} },
      { network: { listening: null } },
      { network: { listening: {} } },
      { network: { listening: { items: [] } } },
      { network: { listening: { items: 'oops' } } },
      { network: { listening: { items: [null, 3, {}, { port: '9000' }, { port: 0 }, { port: 70000 }, { port: 9000.5 }] } } },
    ];
    for (const value of missing) {
      expect(unpublishedListeningPorts(value, [])).toEqual([]);
    }
    expect(unpublishedListeningPorts(ops([]), [])).toEqual([]);
  });

  it('isLocalListenAddress：本机/回环/通配保留，外部与非法地址排除', () => {
    for (const address of ['127.0.0.1', '127.2.3.4', 'localhost', '::1', '[::1]', '0.0.0.0', '::', '[::]']) {
      expect(isLocalListenAddress(address), address).toBe(true);
    }
    for (const address of ['', '10.9.0.2', '192.168.1.7', '203.0.113.10', 'example.com', 'fd00::2']) {
      expect(isLocalListenAddress(address), address).toBe(false);
    }
  });
});
