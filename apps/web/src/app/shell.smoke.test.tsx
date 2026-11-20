// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from './router';
import { PANEL_VERSION_LABEL } from '../version';

const PANEL_LABEL_TEXT = `面板 ${PANEL_VERSION_LABEL}`;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let nodeSummary = { mode: 'caddy' as const, peers: null as number | null, sites: null, forwards: null as number | null };

function buildNode() {
  return {
    id: 'tyo-1',
    name: 'tyo-1',
    endpoint: 'https://203.0.113.10:8880',
    tunnelEndpoint: null,
    liveEndpoint: null,
    domain: null,
    accessMode: 'domain' as const,
    tunnelId: null,
    allowInsecure: false,
    preferredRoute: 'direct' as const,
    status: 'online' as const,
    lastSeenAt: Math.floor(Date.now() / 1000),
    createdAt: 1,
    updatedAt: 2,
    summary: nodeSummary,
  };
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  nodeSummary = { mode: 'caddy', peers: null, sites: null, forwards: null };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url === '/api/v1/nodes') return json({ nodes: [buildNode()] });
      if (url === '/api/v1/nodes/tyo-1') return json({ node: buildNode() });
      if (url === '/api/v1/nodes/tyo-1/overview') {
        return json({
          node: buildNode(),
          reachable: true,
          route: 'direct',
          via: 'fetch',
          error: null,
          tls: { state: 'verified', endpoint: 'https://203.0.113.10:8880', detail: null, checkedAt: Math.floor(Date.now() / 1000) },
          state: { host: { hostname: 'hub' }, adapters: [], ports: [] },
          overview: {
            apps: { online: null, total: 0, issues: [], staticCount: 0, redirectCount: 0, items: [] },
            peers: { enabled: false, online: null, total: 0, offline: [], interfaceName: null, listenPort: null, items: [] },
            forwards: { total: 0, tcpCount: 0, udpCount: 0, items: [] },
            certs: { count: 0, soonestDaysLeft: null, expiring: [] },
            accessCert: { daysLeft: 40, tlsState: 'verified' },
            host: { hostname: 'hub', os: 'Debian 12', kernel: '6.1.0', uptime: 3600, agentVersion: '0.6.3' },
            managedServices: [],
            failedUnits: [],
          },
        });
      }
      if (url === '/api/v1/certs') return json({ certificates: [] });
      if (url === '/api/v1/nodes/probe') {
        return json({
          probedAt: Math.floor(Date.now() / 1000),
          nodes: [
            {
              id: 'tyo-1',
              reachable: true,
              route: 'direct',
              via: 'fetch',
              error: null,
              lastSeenAt: Math.floor(Date.now() / 1000),
            },
          ],
          expiringCerts: [],
        });
      }
      if (url === '/api/v1/nodes/tyo-1/state') {
        return json({
          reachable: true,
          route: 'direct',
          via: 'fetch',
          state: { host: { hostname: 'hub' }, adapters: [], ports: [] },
          error: null,
        });
      }
      if (url === '/api/v1/nodes/tyo-1/apps') {
        return json({
          apps: [],
          adapters: [{ name: 'node-exporter', version: '1.8.2', api: 1 }],
          adaptersError: null,
        });
      }
      return json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderRoute(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('AppShell 与页面渲染', () => {
  it('节点列表页渲染外壳、页头与空状态', async () => {
    await renderRoute('/hubs');
    expect(await screen.findByRole('heading', { name: '节点' })).toBeTruthy();
    expect((await screen.findAllByText('tyo-1')).length).toBeGreaterThan(0);
    expect(screen.getByText('控制面已连接')).toBeTruthy();
  });

  it('概览页渲染面板版本与节点卡片', async () => {
    await renderRoute('/');
    expect(await screen.findByText(PANEL_LABEL_TEXT)).toBeTruthy();
    expect((await screen.findAllByText('tyo-1')).length).toBeGreaterThan(0);
    expect(await screen.findByRole('heading', { name: '节点' })).toBeTruthy();
  });

  it('概览页打开只发 /nodes + /nodes/probe，不再拉取 /certs', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    await renderRoute('/');
    expect(await screen.findByText(PANEL_LABEL_TEXT)).toBeTruthy();

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(calls).toContain('/api/v1/nodes/probe');
    });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    const count = (target: string) => urls.filter((url) => url === target).length;
    expect(count('/api/v1/nodes/probe')).toBe(1);
    expect(count('/api/v1/nodes')).toBe(1);
    expect(count('/api/v1/certs')).toBe(0);
    expect(urls.some((url) => url.includes('/state') || url.includes('/apps'))).toBe(false);
  });

  it('节点概况页单请求 /overview + 10s 快照，无 WG/转发时仅 4 Tab（无「网络」）', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    await renderRoute('/hubs/tyo-1');
    expect(await screen.findByRole('heading', { name: 'tyo-1' })).toBeTruthy();
    expect(await screen.findByText('主机')).toBeTruthy();
    // 新 5-Tab 名称（无「对外服务」；无 WG 且 0 转发时隐藏「网络」）
    const hubBarNav = document.querySelector('.ui-hubbar-tabs') as HTMLElement;
    expect(hubBarNav.textContent).toContain('概况');
    expect(hubBarNav.textContent).toContain('应用');
    expect(hubBarNav.textContent).toContain('主机');
    expect(hubBarNav.textContent).toContain('设置');
    expect(hubBarNav.textContent).not.toContain('对外服务');
    expect(hubBarNav.textContent).not.toContain('网络');

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls).toContain('/api/v1/nodes/tyo-1/overview');
      expect(urls).toContain('/api/v1/nodes/tyo-1/snapshot');
      expect(urls).not.toContain('/api/v1/nodes/tyo-1/state');
      expect(urls).not.toContain('/api/v1/certs');
      expect(urls.some((url) => url.includes('/live-ticket') || url.includes('/_live/'))).toBe(false);
    });
  });

  it('只有端口转发（caddy 模式且 forwards > 0）时「网络」Tab 出现', async () => {
    nodeSummary = { mode: 'caddy', peers: null, sites: null, forwards: 2 };
    await renderRoute('/hubs/tyo-1');
    expect(await screen.findByRole('heading', { name: 'tyo-1' })).toBeTruthy();
    const hubBarNav = document.querySelector('.ui-hubbar-tabs') as HTMLElement;
    expect(hubBarNav.textContent).toContain('网络');
  });

  it('旧 /services 路由 302 到应用页，旧 /apps 路由 302 到设置页组件分段', async () => {
    const r1 = await renderRoute('/hubs/tyo-1/services');
    expect(await screen.findByRole('heading', { name: '应用' })).toBeTruthy();
    expect(r1.state.location.pathname).toBe('/hubs/tyo-1/sites');

    cleanup();
    const r2 = await renderRoute('/hubs/tyo-1/apps');
    expect(await screen.findByRole('heading', { name: '设置' })).toBeTruthy();
    expect(r2.state.location.pathname).toBe('/hubs/tyo-1/settings');
    expect(await screen.findByText('内置组件')).toBeTruthy();
    expect((await screen.findAllByText('node-exporter')).length).toBeGreaterThan(0);
  });

  it('组件样例页不套外壳且无需登录', async () => {
    await renderRoute('/dev/gallery');
    expect(await screen.findByText('组件样例')).toBeTruthy();
  });
});
