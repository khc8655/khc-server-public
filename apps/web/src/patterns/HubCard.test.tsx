// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { NodeProbeProjection } from '@khc/contracts';
import { HubCard } from './HubCard';
import type { HubView } from '../data/useHubProbe';

afterEach(cleanup);

const NOW = Math.floor(Date.now() / 1000);

function baseProjection(patch: Partial<NodeProbeProjection> = {}): NodeProbeProjection {
  return {
    apps: { online: 3, total: 3, issues: [], staticCount: 0, redirectCount: 0 },
    peers: {
      online: 1,
      total: 2,
      enabled: true,
      offline: ['pad'],
      interfaceName: 'khc0',
      listenPort: 51820,
    },
    forwards: { total: 1, tcpCount: 1, udpCount: 0 },
    certs: { count: 1, soonestDaysLeft: 63, expiring: [] },
    accessCert: { daysLeft: 63, tlsState: 'verified' },
    ...patch,
  };
}

function hub(patch: Partial<HubView> = {}): HubView {
  return {
    id: 'n1',
    name: 'oracle-x86-2',
    endpoint: 'https://hub.example.com',
    tunnelEndpoint: null,
    liveEndpoint: null,
    domain: 'hub.example.com',
    accessMode: 'domain',
    tunnelId: null,
    allowInsecure: false,
    preferredRoute: 'direct',
    status: 'online',
    lastSeenAt: NOW - 12,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    summary: { mode: 'wg', peers: 2, sites: { total: 3, disabled: 0 }, forwards: 1 },
    probed: true,
    projection: baseProjection(),
    ...patch,
  };
}

describe('HubCard（三层节点卡 · R2/R3/R5）', () => {
  it('域名接入：展示接入方式、主机、HTTPS 证书剩余天数与非零四项统计', () => {
    const { container } = render(<HubCard hub={hub()} phase="done" onOpen={() => {}} />);

    expect(container.querySelector('.ui-node-card-name')?.textContent).toBe('oracle-x86-2');
    expect(container.querySelector('.ui-node-card-status')?.textContent).toContain('在线');
    expect(container.querySelector('.ui-node-card-access-chip')?.textContent).toBe('域名');
    expect(container.querySelector('.ui-access-host')?.textContent).toBe('hub.example.com');
    expect(container.querySelector('.ui-access-sec--ok')?.textContent).toBe(
      'HTTPS · 接入证书剩 63 天',
    );

    const text = container.textContent ?? '';
    expect(text).toContain('应用在线');
    expect(text).toContain('3/3');
    expect(text).toContain('Peer 在线');
    expect(text).toContain('1/2');
    expect(text).toContain('转发');
    expect(text).toContain('1 张 · 63 天');
  });

  it('Tunnel 与 IP 直连：展示各自单行安全说明（R5）', () => {
    const tunnel = render(
      <HubCard
        hub={hub({
          id: 't1',
          accessMode: 'tunnel',
          domain: null,
          tunnelId: 'tn_1',
          endpoint: 'https://tunnel.example.com',
          projection: baseProjection({
            accessCert: { daysLeft: null, tlsState: 'verified' },
            peers: {
              online: null,
              total: 0,
              enabled: false,
              offline: [],
              interfaceName: null,
              listenPort: null,
            },
            forwards: { total: 0, tcpCount: 0, udpCount: 0 },
            certs: { count: 0, soonestDaysLeft: null, expiring: [] },
          }),
        })}
        phase="done"
        onOpen={() => {}}
      />,
    );
    expect(tunnel.container.querySelector('.ui-node-card-access-chip')?.textContent).toBe('Tunnel');
    expect(tunnel.container.querySelector('.ui-access-host')?.textContent).toBe('tunnel.example.com');
    expect(tunnel.container.textContent).toContain('HTTPS · 由 Cloudflare 边缘托管');
    // R2：0 Peer / 0 转发 / 0 证书隐藏
    expect(tunnel.container.textContent).not.toContain('Peer 在线');
    expect(tunnel.container.textContent).not.toContain('转发');
    expect(tunnel.container.textContent).not.toContain('证书');

    cleanup();

    const ip = render(
      <HubCard
        hub={hub({
          id: 'ip1',
          accessMode: 'ip',
          domain: null,
          allowInsecure: true,
          endpoint: 'http://203.0.113.8:8443',
          projection: baseProjection({
            accessCert: { daysLeft: null, tlsState: 'none' },
          }),
        })}
        phase="done"
        onOpen={() => {}}
      />,
    );
    expect(ip.container.querySelector('.ui-node-card-access-chip')?.textContent).toBe('IP 直连');
    expect(ip.container.querySelector('.ui-access-host')?.textContent).toBe('203.0.113.8:8443');
    expect(ip.container.textContent).toContain('HTTP 明文 · 无接入证书');
  });

  it('R2：未配置任何应用/Peer/转发/证书时隐藏整块统计区，不出 0 或 —', () => {
    const { container } = render(
      <HubCard
        hub={hub({
          summary: { mode: null, peers: null, sites: null, forwards: null },
          projection: baseProjection({
            apps: { online: 0, total: 0, issues: [], staticCount: 0, redirectCount: 0 },
            peers: {
              online: null,
              total: 0,
              enabled: false,
              offline: [],
              interfaceName: null,
              listenPort: null,
            },
            forwards: { total: 0, tcpCount: 0, udpCount: 0 },
            certs: { count: 0, soonestDaysLeft: null, expiring: [] },
          }),
        })}
        phase="done"
        onOpen={() => {}}
      />,
    );

    expect(container.querySelector('.ui-node-card-stats')).toBeNull();
    expect(container.textContent).not.toContain('0 / 0');
    expect(container.textContent).not.toContain('暂无');
    expect(container.textContent).not.toContain('—');
  });

  it('R3：可达节点应用全部离线时标红「N 个离线」并亮 warn 边框', () => {
    const { container } = render(
      <HubCard
        hub={hub({
          projection: baseProjection({
            apps: {
              online: 0,
              total: 3,
              issues: [
                { name: 'a', domain: 'a.dev', state: 'down', status: 502 },
                { name: 'b', domain: 'b.dev', state: 'down', status: 502 },
                { name: 'c', domain: 'c.dev', state: 'down', status: 502 },
              ],
              staticCount: 0,
              redirectCount: 0,
            },
          }),
        })}
        phase="done"
        onOpen={() => {}}
      />,
    );

    expect(container.querySelector('.ui-node-card')?.className).toContain('ui-node-card--warn');
    expect(container.querySelector('.ui-node-stat-val.is-danger')?.textContent).toBe('3 个离线');
  });

  it('R3：节点本身离线或探测中时，只显示中性总数，不伪造 0 / N 或红色离线', () => {
    const offline = render(
      <HubCard
        hub={hub({
          status: 'offline',
          projection: baseProjection({
            apps: { online: null, total: 3, issues: [], staticCount: 0, redirectCount: 0 },
            peers: {
              online: null,
              total: 2,
              enabled: true,
              offline: [],
              interfaceName: 'khc0',
              listenPort: 51820,
            },
          }),
        })}
        phase="done"
        onOpen={() => {}}
      />,
    );

    expect(offline.container.querySelector('.ui-node-card')?.className).toContain(
      'ui-node-card--offline',
    );
    expect(offline.container.querySelector('.ui-node-stat-val.is-danger')).toBeNull();
    expect(offline.container.textContent).not.toContain('0/3');
    expect(offline.container.textContent).not.toContain('3 个离线');

    cleanup();

    const probing = render(
      <HubCard
        hub={hub({ status: 'unknown', probed: false, projection: undefined })}
        phase="probing"
        onOpen={() => {}}
      />,
    );
    expect(probing.container.textContent).toContain('探测中…');
    expect(probing.container.querySelector('.ui-node-stat-val.is-danger')).toBeNull();
  });

  it('整卡链接可点击打开节点详情', () => {
    const onOpen = vi.fn();
    const { getByRole } = render(<HubCard hub={hub()} phase="done" onOpen={onOpen} />);
    const link = getByRole('link');
    expect(link.getAttribute('href')).toBe('/hubs/n1');
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
