// @vitest-environment jsdom
/**
 * 节点概况页 smoke（U3）：
 * - 单请求 GET /api/v1/nodes/:id/overview（离线仍渲染 D1 部分；不再拉 /state、/apps/*、/certs）
 * - R2/R3 指标与首页节点卡片同源；502/down 标红进「需要处理」
 * - 保留「面板受管 failed 单元」与「系统自带单元失败」分离（PR #96/#97）
 * - 未装 WireGuard 时零 Peer/WireGuard 文案；四态完整
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import type { NodeOverviewData } from '@khc/contracts';
import { createAppRouter } from '../app/router';

const NOW = Math.floor(Date.now() / 1000);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const baseNode = {
  id: 'x86-2',
  name: 'x86-2',
  endpoint: 'https://hub.example.com',
  tunnelEndpoint: null,
  liveEndpoint: null,
  domain: 'hub.example.com',
  accessMode: 'domain' as const,
  tunnelId: null,
  allowInsecure: false,
  preferredRoute: 'direct' as const,
  status: 'online' as const,
  lastSeenAt: NOW,
  createdAt: 1,
  updatedAt: 2,
  summary: { mode: 'wg' as const, peers: 2, sites: { total: 1, disabled: 0 }, forwards: 1 },
};

let reachable = true;
let failedUnits: string[] = [];
let overviewStatus = 200;
let overviewPatch: Partial<NodeOverviewData> = {};
let accessMode: 'domain' | 'tunnel' | 'ip' = 'domain';
let nodeExpiresAt: string | null = null;
let requests: string[] = [];

function buildOverviewResponse() {
  const defaultOverview: NodeOverviewData = {
    apps: {
      online: 1,
      total: 1,
      issues: [],
      staticCount: 0,
      redirectCount: 0,
      items: [
        {
          name: 'blog',
          domain: 'blog.example.dev',
          upstream: '10.99.0.2:8080',
          verdict: 'online',
          status: 200,
          error: null,
        },
      ],
    },
    peers: {
      enabled: true,
      online: 1,
      total: 2,
      offline: ['pad'],
      interfaceName: 'khc0',
      listenPort: 51820,
      items: [
        { name: 'phone', online: true, latestHandshake: NOW - 30 },
        { name: 'pad', online: false, latestHandshake: null },
      ],
    },
    forwards: {
      total: 1,
      tcpCount: 1,
      udpCount: 0,
      items: [
        {
          name: 'ssh',
          listenPort: 2222,
          targetHost: '10.99.0.2',
          targetPort: 22,
          protocol: 'tcp',
          active: true,
        },
      ],
    },
    certs: {
      count: 1,
      soonestDaysLeft: 20,
      expiring: [],
    },
    accessCert: { daysLeft: 45, tlsState: 'verified' },
    host: reachable
      ? { hostname: 'hub-x86', os: 'Debian 12', kernel: '6.1.0', uptime: 86400, agentVersion: '0.6.3' }
      : null,
    managedServices: reachable
      ? [
          { name: 'caddy', state: 'active' },
          { name: 'khc-agent', state: 'active' },
        ]
      : [],
    failedUnits: reachable ? failedUnits : null,
  };

  const overview: NodeOverviewData = { ...defaultOverview, ...overviewPatch };
  return {
    node: {
      ...baseNode,
      expiresAt: nodeExpiresAt,
      accessMode,
      endpoint:
        accessMode === 'ip'
          ? 'http://203.0.113.20:8880'
          : accessMode === 'tunnel'
            ? 'https://tun.example.com'
            : 'https://hub.example.com',
      domain: accessMode === 'domain' ? 'hub.example.com' : null,
      status: reachable ? 'online' : 'offline',
    },
    reachable,
    route: reachable ? 'direct' : null,
    via: reachable ? 'fetch' : null,
    error: reachable ? null : 'connect timeout',
    tls: { state: accessMode === 'ip' ? 'none' : reachable ? 'verified' : 'unknown', endpoint: 'https://hub.example.com', detail: null, checkedAt: NOW },
    state: reachable
      ? {
          host: { hostname: 'hub-x86', os: 'Debian 12', kernel: '6.1.0', uptime: 86400 },
          agent: { version: '0.6.3', serverTime: NOW },
          ops: {
            cpu: { usagePercent: 12.4, load: [0.52] },
            mem: { total: 8_000_000_000, used: 2_000_000_000, percent: 25 },
            disks: [{ path: '/', percent: 41 }],
            services: {
              services: defaultOverview.managedServices,
              failedUnits,
            },
          },
          adapters: [],
          ports: [],
        }
      : null,
    overview,
  };
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  reachable = true;
  failedUnits = [];
  overviewStatus = 200;
  overviewPatch = {};
  accessMode = 'domain';
  nodeExpiresAt = null;
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url === '/api/v1/nodes') return json({ nodes: [baseNode] });
      if (url === '/api/v1/nodes/x86-2/overview') {
        if (overviewStatus !== 200) {
          return json({ error: { code: 'err', message: '加载失败' } }, overviewStatus);
        }
        return json(buildOverviewResponse());
      }
      if (url === '/api/v1/nodes/x86-2/snapshot') {
        return json({ ok: false, snapshot: null });
      }
      return json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderOverview() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(
    queryClient,
    createMemoryHistory({ initialEntries: ['/hubs/x86-2'] }),
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('节点概况页 · 单请求与核心展示（U3）', () => {
  it('只发 /overview + /snapshot，不发 /nodes/:id、/state、/apps/*、/certs', async () => {
    const { container } = await renderOverview();
    expect(await screen.findByText('1 / 1')).toBeTruthy();
    expect(screen.getByText('1 / 2')).toBeTruthy();
    expect(screen.getByText('1 条')).toBeTruthy();
    expect(screen.getByText('1 张 · 20 天')).toBeTruthy();
    expect(screen.getByText('证书库（不含自动签发）')).toBeTruthy();
    expect(screen.getByText(/HTTPS · 接入证书剩 45 天/)).toBeTruthy();
    expect(screen.getByText('Agent v0.6.3')).toBeTruthy();
    expect(screen.getByText('blog')).toBeTruthy();
    expect(screen.getByText('10.99.0.2:8080')).toBeTruthy();
    expect(screen.getByText('phone')).toBeTruthy();
    expect(screen.getByText('ssh')).toBeTruthy();
    expect(screen.getByText('12.4%')).toBeTruthy();
    expect(screen.getByText('25%')).toBeTruthy();
    expect(screen.getByText('41%')).toBeTruthy();
    // 在线状态仅保留在节点栏，页头/正文不重复
    expect(screen.queryByText('组网节点')).toBeNull();

    await waitFor(() => {
      expect(requests).toContain('/api/v1/nodes/x86-2/overview');
    });
    expect(requests).not.toContain('/api/v1/nodes/x86-2');
    expect(requests).not.toContain('/api/v1/nodes/x86-2/state');
    expect(requests.some((u) => u.includes('/apps'))).toBe(false);
    expect(requests).not.toContain('/api/v1/certs');
    expect(container.textContent).not.toContain('对外服务');
  });

  it('HTTP 502 应用异常进「需要处理」并在应用行标红状态码', async () => {
    overviewPatch = {
      apps: {
        online: 0,
        total: 1,
        issues: [{ name: 'hermes', domain: 'h.example.com', state: 'warn', status: 502 }],
        staticCount: 0,
        redirectCount: 0,
        items: [
          {
            name: 'hermes',
            domain: 'h.example.com',
            upstream: '127.0.0.1:8000',
            verdict: 'issue',
            status: 502,
            error: 'HTTP 502',
          },
        ],
      },
    };
    const { container } = await renderOverview();
    await screen.findByText('1 个离线');
    const triage = container.querySelector('.ui-triage-strip');
    expect(triage).toBeTruthy();
    expect(triage!.textContent).toContain('应用异常');
    expect(triage!.textContent).toContain('hermes');
    expect(triage!.textContent).toContain('HTTP 502');
  });

  it('未安装 WireGuard 的节点不渲染 Peer 统计与明细，页面零 Peer/WireGuard 文案', async () => {
    overviewPatch = {
      peers: {
        enabled: false,
        online: null,
        total: 0,
        offline: [],
        interfaceName: null,
        listenPort: null,
        items: [],
      },
      forwards: { total: 0, tcpCount: 0, udpCount: 0, items: [] },
      certs: { count: 0, soonestDaysLeft: null, expiring: [] },
    };
    const { container } = await renderOverview();
    await screen.findByText('blog');
    const main = container.querySelector('.ui-hub-content')?.textContent ?? '';
    expect(main).not.toMatch(/peer/i);
    expect(main).not.toMatch(/wireguard/i);
    expect(screen.queryByText('暂无')).toBeNull();
    expect(screen.queryByText('0 / 0')).toBeNull();
  });

  it('节点离线：D1 配置与总计数仍展示，不显示主机假 0% 也不报「0 / N」', async () => {
    reachable = false;
    overviewPatch = {
      apps: {
        online: null,
        total: 2,
        issues: [],
        staticCount: 0,
        redirectCount: 0,
        items: [
          { name: 'a', domain: 'a.dev', upstream: '127.0.0.1:80', verdict: 'unknown', status: null, error: null },
          { name: 'b', domain: 'b.dev', upstream: '127.0.0.1:81', verdict: 'unknown', status: null, error: null },
        ],
      },
      peers: {
        enabled: true,
        online: null,
        total: 2,
        offline: [],
        interfaceName: 'khc0',
        listenPort: 51820,
        items: [
          { name: 'phone', online: null, latestHandshake: null },
          { name: 'pad', online: null, latestHandshake: null },
        ],
      },
    };
    await renderOverview();
    expect(await screen.findByText('节点不可达')).toBeTruthy();
    expect(screen.getByText('节点离线，暂无实时主机指标')).toBeTruthy();
    expect(screen.queryByText('0 / 2')).toBeNull();
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('a')).toBeTruthy();
  });

  it('系统自带单元失败：不进「需要处理」，只在主机卡片保留一行入口（PR #96/#97 回归）', async () => {
    failedUnits = ['unattended-upgrades.service', 'fwupd.service'];
    const { container } = await renderOverview();
    await screen.findByText('2 个系统单元失败');
    const triage = container.querySelector('.ui-triage-strip')?.textContent ?? '';
    expect(triage).not.toContain('unattended-upgrades');
    expect(triage).not.toContain('fwupd');
  });

  it('面板受管单元失败：进「需要处理」且在主机卡片显示失败计数', async () => {
    failedUnits = ['khc-agent.service', 'caddy.service'];
    const { container } = await renderOverview();
    await screen.findByText('2 个失败');
    const triage = container.querySelector('.ui-triage-strip')?.textContent ?? '';
    expect(triage).toContain('khc-agent.service');
    expect(triage).toContain('caddy.service');
    expect(triage).toContain('服务失败');
  });

  it('接口报错：渲染错误横幅与重试按钮', async () => {
    overviewStatus = 500;
    await renderOverview();
    expect(await screen.findByText('无法加载概况')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('U4 节点到期：标题栏渲染徽标，≤14 天与到期当天进入「需要处理」并链到设置页', async () => {
    nodeExpiresAt = '2026-11-26';
    overviewPatch = { expiresAt: '2026-11-26', expiresDaysLeft: 5 };
    const warnRender = await renderOverview();
    expect(await screen.findByText('到期剩 5 天')).toBeTruthy();
    expect(warnRender.container.querySelector('.ui-expiry-chip--warn')?.textContent).toBe(
      '到期剩 5 天',
    );
    const warnTriage = warnRender.container.querySelector('.ui-triage-strip')?.textContent ?? '';
    expect(warnTriage).toContain('即将到期');
    expect(warnTriage).toContain('节点到期剩 5 天');
    cleanup();

    nodeExpiresAt = '2026-11-21';
    overviewPatch = { expiresAt: '2026-11-21', expiresDaysLeft: 0 };
    const dueRender = await renderOverview();
    expect(await screen.findByText('今日到期')).toBeTruthy();
    expect(dueRender.container.querySelector('.ui-expiry-chip--danger')?.textContent).toBe(
      '今日到期',
    );
    const dueTriage = dueRender.container.querySelector('.ui-triage-strip')?.textContent ?? '';
    expect(dueTriage).toContain('节点已过期');
    expect(dueTriage).toContain('节点今日到期');
  });
});
