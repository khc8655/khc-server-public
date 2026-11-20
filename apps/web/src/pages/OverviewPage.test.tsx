// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from '../app/router';
import { PANEL_VERSION_LABEL } from '../version';

const NOW = Math.floor(Date.now() / 1000);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  window.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderOverview() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: ['/'] }));
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...result, router };
}

describe('OverviewPage（首页概览 · U2）', () => {
  it('零 /certs 请求，仅发 GET /nodes + POST /nodes/probe；展示分诊芯片与动态 KPI', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
        if (url === '/api/v1/nodes') {
          return json({
            nodes: [
              {
                id: 'n1',
                name: 'oracle-x86-2',
                endpoint: 'https://oracle.example.dev',
                tunnelEndpoint: null,
                liveEndpoint: null,
                domain: 'oracle.example.dev',
                accessMode: 'domain',
                tunnelId: null,
                allowInsecure: false,
                preferredRoute: 'direct',
                status: 'online',
                lastSeenAt: NOW - 10,
                createdAt: 1,
                updatedAt: 2,
              },
              {
                id: 'n2',
                name: 'down-node',
                endpoint: 'http://203.0.113.8:8443',
                tunnelEndpoint: null,
                liveEndpoint: null,
                domain: null,
                accessMode: 'ip',
                tunnelId: null,
                allowInsecure: true,
                preferredRoute: 'direct',
                status: 'offline',
                lastSeenAt: NOW - 3 * 86400,
                createdAt: 1,
                updatedAt: 2,
                summary: { mode: 'wg', peers: 1, sites: { total: 2, disabled: 0 }, forwards: 0 },
              },
            ],
          });
        }
        if (url === '/api/v1/nodes/probe') {
          return json({
            probedAt: NOW,
            expiringCerts: [
              { id: 'c1', name: 'wild-cert', daysLeft: 9, nodeId: 'n1' },
            ],
            nodes: [
              {
                id: 'n1',
                reachable: true,
                route: 'direct',
                via: 'fetch',
                error: null,
                lastSeenAt: NOW,
                projection: {
                  apps: {
                    online: 1,
                    total: 2,
                    issues: [{ name: 'hermes', domain: 'hermes.example.dev', state: 'warn', status: 502 }],
                    staticCount: 0,
                    redirectCount: 0,
                  },
                  peers: {
                    online: 1,
                    total: 2,
                    enabled: true,
                    offline: ['office-nas'],
                    interfaceName: 'khc0',
                    listenPort: 51820,
                  },
                  forwards: { total: 1, tcpCount: 1, udpCount: 0 },
                  certs: {
                    count: 1,
                    soonestDaysLeft: 9,
                    expiring: [{ id: 'c1', name: 'wild-cert', daysLeft: 9, nodeId: 'n1' }],
                  },
                  accessCert: { daysLeft: 63, tlsState: 'verified' },
                },
              },
              {
                id: 'n2',
                reachable: false,
                route: null,
                via: null,
                error: 'timeout',
                lastSeenAt: NOW - 3 * 86400,
                projection: {
                  // R3：离线节点即使 D1 有应用/Peer，也不在首页待办里重复报「应用异常/Peer 离线」
                  apps: {
                    online: null,
                    total: 2,
                    issues: [],
                    staticCount: 0,
                    redirectCount: 0,
                  },
                  peers: {
                    online: null,
                    total: 1,
                    enabled: true,
                    offline: [],
                    interfaceName: 'khc0',
                    listenPort: 51820,
                  },
                  forwards: { total: 0, tcpCount: 0, udpCount: 0 },
                  certs: { count: 0, soonestDaysLeft: null, expiring: [] },
                  accessCert: { daysLeft: null, tlsState: 'none' },
                },
              },
            ],
          });
        }
        return json({});
      }),
    );

    const { container } = await renderOverview();
    expect(await screen.findByText(`面板 ${PANEL_VERSION_LABEL}`)).toBeTruthy();
    expect(await screen.findByText('oracle-x86-2 · hermes')).toBeTruthy();

    // 不请求 /api/v1/certs
    await waitFor(() => expect(calls).toContain('/api/v1/nodes/probe'));
    expect(calls).not.toContain('/api/v1/certs');

    const triageText = container.querySelector('.ui-triage-strip')?.textContent ?? '';
    expect(triageText).toContain('down-node');
    expect(triageText).toContain('节点离线');
    expect(triageText).toContain('oracle-x86-2 · hermes');
    expect(triageText).toContain('HTTP 502');
    expect(triageText).toContain('oracle-x86-2 · office-nas');
    expect(triageText).toContain('wild-cert');
    expect(triageText).not.toContain('down-node ·');

    expect(screen.getByRole('heading', { name: '节点' })).toBeTruthy();
  });

  it('R2：无 Peer、无应用、无待办时隐藏对应 KPI 与分诊条', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
        if (url === '/api/v1/nodes') {
          return json({
            nodes: [
              {
                id: 'n1',
                name: 'clean-node',
                endpoint: 'https://clean.example.dev',
                tunnelEndpoint: null,
                liveEndpoint: null,
                domain: 'clean.example.dev',
                accessMode: 'domain',
                tunnelId: null,
                allowInsecure: false,
                preferredRoute: 'direct',
                status: 'online',
                lastSeenAt: NOW,
                createdAt: 1,
                updatedAt: 2,
              },
            ],
          });
        }
        if (url === '/api/v1/nodes/probe') {
          return json({
            probedAt: NOW,
            expiringCerts: [],
            nodes: [
              {
                id: 'n1',
                reachable: true,
                route: 'direct',
                via: 'fetch',
                error: null,
                lastSeenAt: NOW,
                projection: {
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
                  accessCert: { daysLeft: null, tlsState: 'verified' },
                },
              },
            ],
          });
        }
        return json({});
      }),
    );

    const { container } = await renderOverview();
    expect(await screen.findByText('HTTPS · 证书有效')).toBeTruthy();
    expect(screen.queryByText('应用在线')).toBeNull();
    expect(screen.queryByText('Peer 在线')).toBeNull();
    expect(screen.queryByText('需要处理')).toBeNull();
    expect(container.querySelector('.ui-triage-strip')).toBeNull();
  });

  it('0 节点空态：只显示「添加第一个节点」引导，不显示 0 指标卡', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
        if (url === '/api/v1/nodes') return json({ nodes: [] });
        if (url === '/api/v1/nodes/probe') return json({ probedAt: NOW, expiringCerts: [], nodes: [] });
        return json({});
      }),
    );

    const { container } = await renderOverview();
    expect(await screen.findByText('还没有节点')).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加第一个节点' })).toBeTruthy();
    expect(container.querySelector('.ui-kpi-strip')).toBeNull();
  });

  it('异常态：GET /nodes 失败显示重试，probe 失败显示状态探测失败横幅', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
        if (url === '/api/v1/nodes') return json({ error: { code: 'E_DB', message: 'db down' } }, 500);
        if (url === '/api/v1/nodes/probe') return json({ error: { code: 'E_PROBE', message: 'probe down' } }, 502);
        return json({});
      }),
    );

    await renderOverview();
    expect(await screen.findByText('无法加载节点列表')).toBeTruthy();
    expect(await screen.findByText('状态探测失败')).toBeTruthy();
  });
});
