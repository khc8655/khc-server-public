// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from './router';
// 版本来自唯一来源（package.json），测试不再写死版本字面量 —— 否则每次发版都要改测试，
// 而这正是 ADR-0013 要消除的漂移点。
import { PANEL_VERSION_LABEL } from '../version';

const PANEL_LABEL_TEXT = `面板 ${PANEL_VERSION_LABEL}`;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url === '/api/v1/nodes') {
        return json({
          nodes: [
            {
              id: 'tyo-1',
              name: 'tyo-1',
              endpoint: 'https://203.0.113.10:8880',
              tunnelEndpoint: null,
              liveEndpoint: null,
              preferredRoute: 'direct',
              status: 'online',
              lastSeenAt: Math.floor(Date.now() / 1000),
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        });
      }
      if (url === '/api/v1/nodes/tyo-1') {
        return json({
          node: {
            id: 'tyo-1',
            name: 'tyo-1',
            endpoint: 'https://203.0.113.10:8880',
            tunnelEndpoint: null,
              liveEndpoint: null,
            preferredRoute: 'direct',
            status: 'online',
            lastSeenAt: Math.floor(Date.now() / 1000),
            createdAt: 1,
            updatedAt: 2,
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

  it('概览页渲染面板版本与 Hub 卡片', async () => {
    await renderRoute('/');
    expect(await screen.findByText(PANEL_LABEL_TEXT)).toBeTruthy();
    expect((await screen.findAllByText('tyo-1')).length).toBeGreaterThan(0);
    expect(await screen.findByText('进入节点')).toBeTruthy();
  });

  it('概览页打开只发一次批量探测 + 既有两份列表', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    await renderRoute('/');
    expect(await screen.findByText(PANEL_LABEL_TEXT)).toBeTruthy();

    // 等探测与两份列表都完成
    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(calls).toContain('/api/v1/nodes/probe');
    });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    const count = (target: string) => urls.filter((url) => url === target).length;
    expect(count('/api/v1/nodes/probe')).toBe(1);
    expect(count('/api/v1/nodes')).toBe(1);
    expect(count('/api/v1/certs')).toBe(1);
    // 不在首页 fan-out 单节点 /state、/apps
    expect(urls.some((url) => url.includes('/state') || url.includes('/apps'))).toBe(false);
  });

  it('节点概况页展示作用域与实时状态', async () => {
    await renderRoute('/hubs/tyo-1');
    expect(await screen.findByRole('heading', { name: 'tyo-1' })).toBeTruthy();
    expect(await screen.findByText('在线')).toBeTruthy();
    // 无任何已配置应用时「应用与发布」整卡不渲染（page-specs §2.1）
    expect(screen.queryByText('应用与发布')).toBeNull();
    expect(await screen.findByText('主机与服务')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Peer' })).toBeNull();
  });

  it('旧 /apps 路由 302 到站点页，扩展应用分段可打开应用', async () => {
    const router = await renderRoute('/hubs/tyo-1/apps');
    expect(await screen.findByRole('heading', { name: '站点' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/hubs/tyo-1/sites');
    await userEvent.click(await screen.findByRole('button', { name: '扩展应用' }));
    expect((await screen.findAllByText('node-exporter')).length).toBeGreaterThan(0);
  });

  it('组件样例页不套外壳且无需登录', async () => {
    await renderRoute('/dev/gallery');
    expect(await screen.findByText('组件样例')).toBeTruthy();
  });
});
