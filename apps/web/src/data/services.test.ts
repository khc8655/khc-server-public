import { describe, expect, it } from 'vitest';
import { classifyBackend, ipv4InCidr } from './services';

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
