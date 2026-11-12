// @vitest-environment jsdom
/**
 * 对外服务页 smoke（page-specs §2.2a / 第 4 批）：
 * 两张表、空态、离线、未生效行内「生效」、未安装、390 后端可见、零新增请求。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from '../../app/router';

const NOW = Math.floor(Date.now() / 1000);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
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

interface Options {
  sites?: Record<string, unknown>[];
  forwards?: Record<string, unknown>[];
  caddyRev?: number;
  caddyAppliedRev?: number;
  forwardRev?: number;
  forwardAppliedRev?: number;
  caddyInstalled?: boolean;
  forwardInstalled?: boolean;
  stateRead?: boolean;
  withForwards?: boolean;
}

let options: Options;
let requests: { url: string; init?: RequestInit }[] = [];

function appConfig(app: string, config: Record<string, unknown>, rev: number, appliedRev: number) {
  return { app, schemaVersion: 1, config, rev, appliedRev, updatedAt: NOW };
}

function mockApi() {
  const opts = options;
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url === '/api/v1/nodes') return json({ nodes: [node] });
      if (url === '/api/v1/nodes/tyo-1') return json({ node });
      if (url === '/api/v1/certs') return json({ certificates: [] });
      if (url === '/api/v1/settings') return json({ settings: [] });
      if (url === '/api/v1/nodes/tyo-1/apps') {
        return json({
          apps: [
            appConfig('caddy-site', { sites: opts.sites ?? [] }, opts.caddyRev ?? 1, opts.caddyAppliedRev ?? 1),
            ...(opts.withForwards === false
              ? []
              : [
                  appConfig(
                    'port-forward',
                    { forwards: opts.forwards ?? [] },
                    opts.forwardRev ?? 1,
                    opts.forwardAppliedRev ?? 1,
                  ),
                ]),
          ],
          adapters: [{ name: 'caddy-site', version: '1.0.0', api: 1 }],
          adaptersError: null,
        });
      }
      if (url === '/api/v1/nodes/tyo-1/apps/caddy-site') {
        return json({
          app: appConfig(
            'caddy-site',
            { sites: opts.sites ?? [] },
            opts.caddyRev ?? 1,
            opts.caddyAppliedRev ?? 1,
          ),
        });
      }
      if (url === '/api/v1/nodes/tyo-1/apps/port-forward') {
        return json({
          app: appConfig(
            'port-forward',
            { forwards: opts.forwards ?? [] },
            opts.forwardRev ?? 1,
            opts.forwardAppliedRev ?? 1,
          ),
        });
      }
      if (url === '/api/v1/nodes/tyo-1/state') {
        if (opts.stateRead === false) {
          return json({ reachable: false, route: 'direct', via: 'fetch', error: 'unreachable', state: null });
        }
        return json({
          reachable: true,
          route: 'direct',
          via: 'fetch',
          error: null,
          state: {
            host: { hostname: 'tyo-1' },
            adapters: [
              {
                name: 'caddy-site',
                version: '1.0.0',
                status: {
                  installed: opts.caddyInstalled ?? true,
                  running: true,
                  siteHealth: [
                    {
                      name: 'blog',
                      domain: 'blog.example.dev',
                      state: 'ok',
                      status: 200,
                      latencyMs: 38,
                    },
                  ],
                },
              },
              {
                name: 'wireguard',
                version: '1.0.0',
                status: {
                  installed: true,
                  running: true,
                  interface: 'khc0',
                  peers: [{ name: 'peer-a', allowedIps: ['10.99.0.2/32'], online: true }],
                },
              },
              {
                name: 'port-forward',
                version: '1.0.0',
                status: {
                  installed: opts.forwardInstalled ?? true,
                  running: true,
                  rules: [{ name: 'ssh', listenPort: 2222, protocol: 'tcp', active: true }],
                },
              },
            ],
            ports: [],
          },
        });
      }
      return json({});
    }),
  );
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  options = {
    sites: [
      {
        name: 'blog',
        domains: ['blog.example.dev'],
        listenPort: 443,
        kind: 'proxy',
        upstreams: ['10.99.0.2:8080'],
        enabled: true,
      },
      {
        name: 'landing',
        domains: ['landing.example.dev'],
        listenPort: 443,
        kind: 'static',
        root: '/srv/landing',
        enabled: true,
      },
    ],
    forwards: [
      {
        name: 'ssh',
        protocol: 'tcp',
        listenPort: 2222,
        targetHost: '10.99.0.2',
        targetPort: 22,
        enabled: true,
        note: '',
      },
    ],
    stateRead: true,
  };
  mockApi();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
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

describe('对外服务页（B4）', () => {
  it('两张表：网页服务与远程访问、后端与状态、底部跳转站点提示', async () => {
    await renderRoute('/hubs/tyo-1/services');
    expect(await screen.findByText('网页服务')).toBeTruthy();
    expect(screen.getByText('远程访问')).toBeTruthy();
    expect((await screen.findAllByText('blog')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('blog.example.dev').length).toBeGreaterThan(0);
    expect(
      (await screen.findAllByText(/内网 VM peer-a 10\.99\.0\.2:8080 · Peer 在线/)).length,
    ).toBeGreaterThan(0);
    expect((await screen.findAllByText('正常 38ms')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/内网 VM peer-a 10\.99\.0\.2:22 · Peer 在线/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('可连接')).length).toBeGreaterThan(0);
    expect(screen.getByText('另有 1 个跳转/静态站点，见「站点」')).toBeTruthy();
  });

  it('零新增请求：打开本页不拉证书，配置各 GET 一次，无任务轮询', async () => {
    await renderRoute('/hubs/tyo-1/services');
    await screen.findByText('网页服务');
    await waitFor(() => {
      expect(requests.filter((item) => item.url === '/api/v1/nodes/tyo-1/apps/caddy-site')).toHaveLength(1);
      expect(requests.filter((item) => item.url === '/api/v1/nodes/tyo-1/apps/port-forward')).toHaveLength(1);
    });
    expect(requests.some((item) => item.url === '/api/v1/certs')).toBe(false);
    expect(requests.some((item) => item.url.includes('/tasks/'))).toBe(false);
    expect(requests.some((item) => item.url.includes('/apps/caddy-site/plan'))).toBe(false);
  });

  it('空态：两张表都为空时只显示「还没有对外服务」', async () => {
    options = { sites: [], forwards: [], withForwards: false };
    mockApi();
    await renderRoute('/hubs/tyo-1/services');
    expect(await screen.findByText('还没有对外服务')).toBeTruthy();
    expect(screen.queryByText('网页服务')).toBeNull();
    expect(screen.queryByText('远程访问')).toBeNull();
  });

  it('节点离线：两张表仍按 D1 渲染，状态统一「未读取」', async () => {
    options = { ...options, stateRead: false };
    mockApi();
    await renderRoute('/hubs/tyo-1/services');
    expect((await screen.findAllByText('未读取')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('blog.example.dev').length).toBeGreaterThan(0);
  });

  it('未安装：Agent 明确回报 installed=false 时显示中性「未安装」', async () => {
    options = { ...options, caddyInstalled: false, forwardInstalled: false };
    mockApi();
    await renderRoute('/hubs/tyo-1/services');
    expect((await screen.findAllByText('未安装')).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('未读取')).toBeNull();
  });

  it('未生效：状态列右侧直接给「生效」（L2 确认），不收进菜单', async () => {
    options = { ...options, caddyRev: 2, caddyAppliedRev: 1, forwardRev: 2, forwardAppliedRev: 1 };
    mockApi();
    await renderRoute('/hubs/tyo-1/services');
    expect((await screen.findAllByText('未生效')).length).toBeGreaterThanOrEqual(2);
    const buttons = screen.getAllByRole('button', { name: '生效' });
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    await userEvent.click(buttons[0]!);
    expect(await screen.findByText('应用站点配置？')).toBeTruthy();
  });

  it('390：列表行三段（名称/对外地址/后端），后端信息不丢项', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    window.dispatchEvent(new Event('resize'));
    await renderRoute('/hubs/tyo-1/services');
    await screen.findByText('网页服务');
    const narrow = document.querySelector('.ui-list-meta-narrow');
    expect(narrow?.textContent).toContain('内网 VM');
    expect(narrow?.textContent).toContain('peer-a');
    expect(document.querySelector('.ui-list-meta')?.textContent).toContain('blog.example.dev');
  });

  it('行点击打开既有站点抽屉，证书按需加载一次', async () => {
    await renderRoute('/hubs/tyo-1/services');
    const names = await screen.findAllByText('blog');
    await userEvent.click(names[0]!);
    expect(await screen.findByText('编辑站点')).toBeTruthy();
    await waitFor(() =>
      expect(requests.filter((item) => item.url === '/api/v1/certs')).toHaveLength(1),
    );
  });
});
