// @vitest-environment jsdom
/**
 * B3 任务快照 smoke：有任务 / 无任务 / 旧 Agent 无字段 / 离线四态，
 * 以及全局页无节点上下文时顶栏入口隐藏；打开抽屉不新增请求。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from './router';

const NOW = Math.floor(Date.now() / 1000);

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const node = {
  id: 'tyo-1',
  name: 'tyo-1',
  endpoint: 'https://203.0.113.10:8880',
  domain: null,
  tunnelEndpoint: null,
  liveEndpoint: null,
  preferredRoute: 'direct',
  status: 'online',
  lastSeenAt: NOW,
  createdAt: 1,
  updatedAt: 2,
};

interface SnapshotOptions {
  tasks?: unknown;
  agent?: unknown;
  reachable?: boolean;
}

let options: SnapshotOptions;
let requests: string[] = [];

function mockApi() {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url === '/api/v1/nodes') return json({ nodes: [node] });
      if (url === '/api/v1/nodes/tyo-1') return json({ node });
      if (url === '/api/v1/certs') return json({ certificates: [] });
      if (url === '/api/v1/nodes/tyo-1/apps') {
        return json({ apps: [], adapters: [], adaptersError: null });
      }
      if (url === '/api/v1/nodes/tyo-1/state') {
        return json({
          reachable: true,
          route: 'direct',
          via: 'fetch',
          error: null,
          state: { host: { hostname: 'tyo-1' }, adapters: [], ports: [] },
        });
      }
      if (url === '/api/v1/nodes/tyo-1/snapshot') {
        if (options.reachable === false) {
          return json({
            reachable: false,
            route: 'direct',
            via: 'fetch',
            snapshot: null,
            error: 'unreachable',
          });
        }
        return json({
          reachable: true,
          route: 'direct',
          via: 'fetch',
          error: null,
          snapshot: {
            ts: NOW,
            agent: options.agent ?? { version: '0.1.40', serverTime: NOW },
            ...(options.tasks === undefined ? {} : { tasks: options.tasks }),
          },
        });
      }
      return json({});
    }),
  );
}

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

async function openTaskDrawer() {
  await renderRoute('/hubs/tyo-1');
  expect(await screen.findByRole('heading', { name: 'tyo-1' })).toBeTruthy();
  await userEvent.click(await screen.findByRole('button', { name: '任务' }));
  return screen.findByRole('dialog');
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  options = {};
  mockApi();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('B3 任务快照', () => {
  it('有任务：顶栏显示进行中数量，抽屉展示任务与日志', async () => {
    options.tasks = {
      items: [
        {
          id: 't1',
          app: 'caddy-site',
          action: 'install',
          state: 'running',
          progress: 40,
          createdAt: NOW - 10,
          updatedAt: NOW - 2,
          logs: ['installing caddy', 'waiting for health'],
        },
      ],
      total: 1,
      truncated: false,
    };
    await openTaskDrawer();
    expect(await screen.findByText('1 个任务进行中')).toBeTruthy();
    expect(await screen.findByText('caddy-site · install')).toBeTruthy();
    expect(await screen.findByText(/installing caddy/)).toBeTruthy();
    // 打开抽屉不新增任务查询
    expect(requests.some((url) => url.includes('/tasks/'))).toBe(false);
    expect(requests.filter((url) => url.endsWith('/snapshot')).length).toBe(1);
  });

  it('无任务：显示空态', async () => {
    options.tasks = { items: [], total: 0, truncated: false };
    await openTaskDrawer();
    expect(await screen.findByText('还没有任务')).toBeTruthy();
    expect(await screen.findByText('安装、应用或卸载时会在这里显示进度。')).toBeTruthy();
  });

  it('旧 Agent 无 tasks 字段：降级说明，不报错', async () => {
    options.agent = { version: '0.1.38', serverTime: NOW };
    await openTaskDrawer();
    expect(await screen.findByText('当前 Agent 不提供任务快照')).toBeTruthy();
    expect(await screen.findByText('升级节点 Agent 后，这里会显示进行中与最近完成的任务。')).toBeTruthy();
  });

  it('离线：抽屉显示暂时读不到任务', async () => {
    options.reachable = false;
    await openTaskDrawer();
    expect(await screen.findByText('暂时读不到任务')).toBeTruthy();
    expect(
      await screen.findByText('节点快照不可用；恢复后这里会自动更新，不需要手动刷新。'),
    ).toBeTruthy();
  });

  it('全局页无节点上下文：顶栏任务入口隐藏，且不请求快照', async () => {
    await renderRoute('/hubs');
    expect(await screen.findByRole('heading', { name: '节点' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '任务' })).toBeNull();
    });
    expect(requests.some((url) => url.endsWith('/snapshot'))).toBe(false);
  });
});
