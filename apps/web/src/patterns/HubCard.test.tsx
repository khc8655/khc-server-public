// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { NodeProbeApp } from '@khc/contracts';
import { HubCard } from './HubCard';
import type { HubView } from '../data/useHubProbe';

afterEach(cleanup);

const NOW = Math.floor(Date.now() / 1000);

function hub(patch: Partial<HubView> = {}): HubView {
  return {
    id: 'n1',
    name: 'aws-hui-us',
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
    summary: { mode: 'wg', peers: 4, sites: { total: 3, disabled: 1 }, forwards: 2 },
    probed: true,
    ...patch,
  };
}

const reported: NodeProbeApp[] = [
  { name: 'wireguard', installed: true, running: true },
  { name: 'caddy-site', installed: true, running: false },
  { name: 'port-forward', installed: false, running: false },
  { name: 'certificates', installed: true, running: true },
];

describe('HubCard（身份 → 可用性 → 承载 三层）', () => {
  it('渲染身份、地址、接入方式、应用状态与承载计数', () => {
    const { container } = render(<HubCard hub={hub({ apps: reported })} phase="done" onOpen={() => {}} />);

    expect(container.querySelector('.ui-node-card-name')?.textContent).toBe('aws-hui-us');
    expect(container.querySelector('.ui-node-card-endpoint')?.textContent).toBe('https://hub.example.com');
    expect(container.querySelector('.ui-node-card-access-chip')?.textContent).toBe('域名');

    const text = container.textContent ?? '';
    expect(text).toContain('内网穿透');
    expect(text).toContain('运行中');
    expect(text).toContain('未运行');
    expect(text).toContain('未安装');
    // 工具型适配器不上卡片
    expect(text).not.toContain('certificates');

    expect(text).toContain('Peer 4');
    expect(text).toContain('站点 3');
    expect(text).toContain('转发 2');
    expect(text).toContain('1 停用');
    expect(text).toContain('最后在线');
  });

  it('「未安装」「未读取」保持中性灰，不进告警色', () => {
    const { container } = render(
      <HubCard
        hub={hub({
          apps: [
            { name: 'wireguard', installed: false, running: false },
            { name: 'caddy-site', installed: true, running: null },
          ],
          summary: undefined,
        })}
        phase="done"
        onOpen={() => {}}
      />,
    );

    const states = [...container.querySelectorAll('.ui-node-app-state')];
    expect(states.map((node) => node.textContent)).toEqual(['未安装', '未读取']);
    for (const node of states) {
      expect(node.className).toContain('ui-node-app-state--neutral');
    }
  });

  it('离线且没有探测 apps 时退回期望应用并显示「未读取」，不推断未安装', () => {
    const { container } = render(
      <HubCard hub={hub({ status: 'offline', apps: undefined })} phase="done" onOpen={() => {}} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('内网穿透');
    expect(text).toContain('站点');
    expect(text).toContain('未读取');
    expect(text).not.toContain('未安装');
    expect(container.querySelector('.ui-node-card--offline')).toBeTruthy();
  });

  it('应用与计数全为空时保留「未读取」中性占位，不渲染计数', () => {
    const { container } = render(
      <HubCard
        hub={hub({ apps: [], summary: { mode: null, peers: null, sites: null, forwards: null } })}
        phase="probing"
        onOpen={() => {}}
      />,
    );
    expect(container.querySelector('.ui-node-card-app-empty')?.textContent).toBe('未读取');
    expect(container.querySelectorAll('.ui-node-card-fact')).toHaveLength(0);
  });

  it('整卡可点，Enter 也能进入节点', () => {
    const onOpen = vi.fn();
    const { container } = render(<HubCard hub={hub({ apps: reported })} phase="done" onOpen={onOpen} />);
    const card = container.querySelector('.ui-node-card') as HTMLElement;
    fireEvent.click(card);
    fireEvent.keyDown(card, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});
