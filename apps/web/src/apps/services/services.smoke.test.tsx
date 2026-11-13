// @vitest-environment jsdom
/**
 * 对外服务页 smoke（page-specs §2.2a / 第 4 批）：
 * 两张表、空态、离线、未生效行内「生效」、未安装、390 后端可见、零新增请求。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
  statePending?: boolean;
  stateError?: boolean;
  withForwards?: boolean;
  listening?: { proto: string; address: string; port: number; process?: string }[];
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
        if (opts.statePending) return new Promise<Response>(() => {});
        if (opts.stateError) {
          return json({ error: { code: 'E_STATE', message: 'state failed' } }, 500);
        }
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
            ops: {
              network: {
                listening: { count: (opts.listening ?? []).length, items: opts.listening ?? [] },
              },
            },
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

  it('⋯ 删除走已注册 L2 动作与既有确认组件，确认前不写接口', async () => {
    await renderRoute('/hubs/tyo-1/services');
    const more = await screen.findAllByRole('button', { name: '更多操作' });
    await userEvent.click(more[0]!);
    const items = await screen.findAllByRole('menuitem');
    const remove = items.find((item) => item.textContent?.includes('删除站点'));
    expect(remove).toBeTruthy();
    await userEvent.click(remove!);
    expect(await screen.findByText('删除站点 blog.example.dev？')).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除站点' })).toBeTruthy();
    expect(
      requests.filter(
        (item) =>
          ['PUT', 'POST', 'PATCH', 'DELETE'].includes(item.init?.method ?? 'GET') &&
          item.url.includes('/apps/caddy-site'),
      ),
    ).toHaveLength(0);
  });
});

describe('对外服务页 · 本机监听端口（T-C 批次 3）', () => {
  function listeningCard(): HTMLElement {
    return screen.getByText('本机监听端口').closest('.ui-card') as HTMLElement;
  }

  function withListening() {
    options = {
      ...options,
      sites: [
        {
          name: 'blog',
          domains: ['blog.example.dev'],
          kind: 'proxy',
          upstreams: ['10.99.0.2:8080'],
          enabled: true,
        },
        {
          name: 'local-app',
          domains: ['local.example.dev'],
          kind: 'proxy',
          upstreams: ['127.0.0.1:9200'],
          enabled: true,
        },
      ],
      listening: [
        { proto: 'tcp', address: '0.0.0.0', port: 9000 },
        { proto: 'tcp6', address: '::', port: 9000 },
        { proto: 'tcp', address: '127.0.0.1', port: 22 },
        { proto: 'tcp', address: '127.0.0.1', port: 8899 },
        { proto: 'tcp', address: '203.0.113.10', port: 9100 },
        { proto: 'tcp', address: '127.0.0.1', port: 9200 },
        { proto: 'tcp', address: '0.0.0.0', port: 9300 },
      ],
    };
    mockApi();
  }

  it('有数据：只列未发布的本机端口，去重并过滤保留端口/外部地址/已发布端口', async () => {
    withListening();
    await renderRoute('/hubs/tyo-1/services');
    expect(await screen.findByText('本机监听端口')).toBeTruthy();
    const card = within(listeningCard());
    expect((await card.findAllByText('9000')).length).toBeGreaterThan(0);
    expect(card.getAllByText('9300').length).toBeGreaterThan(0);
    expect(card.queryByText('9100')).toBeNull();
    expect(card.queryByText('9200')).toBeNull();
    expect(card.queryByText('22')).toBeNull();
    expect(card.queryByText('8899')).toBeNull();
    expect(card.queryByText('没有待发布的本机端口')).toBeNull();
  });

  it('点击端口：复用既有站点抽屉，预填 upstreams=127.0.0.1:<port>（不新增动作）', async () => {
    withListening();
    await renderRoute('/hubs/tyo-1/services');
    const ports = await screen.findAllByText('9000');
    await userEvent.click(ports[0]!);
    expect(await screen.findByText('添加站点')).toBeTruthy();
    expect(screen.getByText('127.0.0.1:9000')).toBeTruthy();
    expect((screen.getByRole('spinbutton', { name: /目标端口/ }) as HTMLInputElement)?.value).toBe('9000');
    expect(screen.queryByText('发布为站点')).toBeNull();
    expect(
      requests.filter((item) => ['PUT', 'POST', 'PATCH', 'DELETE'].includes(item.init?.method ?? 'GET')),
    ).toHaveLength(0);
  });

  it('上报进程名时行内展示，::1 端口点击预填带方括号（#33）', async () => {
    withListening();
    options = {
      ...options,
      listening: [
        { proto: 'tcp', address: '0.0.0.0', port: 9000, process: 'python3' },
        { proto: 'tcp6', address: '::1', port: 9500, process: 'node' },
      ],
    };
    mockApi();
    await renderRoute('/hubs/tyo-1/services');
    await screen.findByText('本机监听端口');
    const card = listeningCard();
    await waitFor(() => expect(card.textContent).toContain('9000 · python3'));
    expect(card.textContent).toContain('9500 · node');
    const ipv6Row = await screen.findAllByText('9500 · node');
    await userEvent.click(ipv6Row[0]!);
    expect(await screen.findByText('添加站点')).toBeTruthy();
    expect((document.getElementById('site-upstreams') as HTMLInputElement).value).toBe('[::1]:9500');
    expect((screen.getByRole('spinbutton', { name: /目标端口/ }) as HTMLInputElement).value).toBe('9500');
  });

  it('加载态：/state 未返回时列表为骨架，不提前显示空态', async () => {
    options = { ...options, statePending: true };
    mockApi();
    await renderRoute('/hubs/tyo-1/services');
    await screen.findByText('本机监听端口');
    const card = listeningCard();
    await waitFor(() => expect(card.querySelectorAll('.ui-skeleton').length).toBeGreaterThan(0));
    expect(within(card).queryByText('没有待发布的本机端口')).toBeNull();
  });

  it('空态：没有未发布端口时显示空态与说明', async () => {
    options = { ...options, listening: [] };
    mockApi();
    await renderRoute('/hubs/tyo-1/services');
    expect(await screen.findByText('没有待发布的本机端口')).toBeTruthy();
    expect(screen.getByText('节点上监听、但尚未发布为站点的本机端口；点击端口可预填站点抽屉。')).toBeTruthy();
  });

  it('错误态：读取运行状态失败时显示错误与重试，不误报为空', async () => {
    options = { ...options, stateError: true };
    mockApi();
    await renderRoute('/hubs/tyo-1/services');
    expect(
      await screen.findByText('读取节点运行状态失败，无法显示本机监听端口。检查节点后重试。'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.queryByText('没有待发布的本机端口')).toBeNull();
  });

  it('离线：/state 未读取到状态时给出中性说明', async () => {
    options = { ...options, stateRead: false };
    mockApi();
    await renderRoute('/hubs/tyo-1/services');
    expect(await screen.findByText('节点运行状态未读取，暂时无法显示本机监听端口。')).toBeTruthy();
  });

  it('390：列表行仍显示端口与监听地址/协议，可点击预填', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    window.dispatchEvent(new Event('resize'));
    withListening();
    await renderRoute('/hubs/tyo-1/services');
    await screen.findByText('本机监听端口');
    await waitFor(() => expect(listeningCard().textContent).toContain('9000'));
    const card = listeningCard();
    const rows = [...card.querySelectorAll('.ui-list-row')].filter((row) =>
      row.textContent?.includes('9000'),
    );
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0] as HTMLElement;
    expect(first.textContent).toContain('9000');
    expect(first.querySelector('.ui-list-meta-narrow')?.textContent).toContain('0.0.0.0');
    expect(first.querySelector('.ui-list-meta-narrow')?.textContent).toContain('tcp');
    expect(first.querySelector('.ui-list-side button')).toBeNull();
    await userEvent.click(first);
    expect(await screen.findByText('添加站点')).toBeTruthy();
    expect(screen.getByText('127.0.0.1:9000')).toBeTruthy();
  });
});
