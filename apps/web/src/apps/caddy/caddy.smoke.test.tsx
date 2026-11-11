// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from '../../app/router';

const pickMock = vi.hoisted(() => vi.fn());

vi.mock('../../data/backup', async () => {
  const actual = await vi.importActual<typeof import('../../data/backup')>('../../data/backup');
  return { ...actual, pickBackupFile: pickMock };
});

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
  tunnelEndpoint: null,
  liveEndpoint: null,
  preferredRoute: 'direct',
  status: 'online',
  lastSeenAt: NOW,
  createdAt: 1,
  updatedAt: 2,
};

const certificate = {
  id: 'cert_abc',
  name: 'blog-cert',
  domains: ['blog.example.dev'],
  issuer: 'selfsigned',
  notAfter: NOW + 5 * 24 * 3600,
  sourceNodeId: 'tyo-1',
  createdAt: NOW,
  updatedAt: NOW,
};

let caddySites: Record<string, unknown>[] = [];
let requests: { url: string; init?: RequestInit }[] = [];

function appConfig() {
  return {
    app: 'caddy-site',
    schemaVersion: 1,
    config: { sites: caddySites },
    rev: 1,
    appliedRev: 1,
    updatedAt: NOW,
  };
}

function mockApi(
  options: { caddyInstalled?: boolean; pkgInstall?: boolean; taskId?: string } = {},
) {
  const caddyInstalled = options.caddyInstalled ?? true;
  const pkgInstall = options.pkgInstall ?? false;
  const taskId = options.taskId ?? 'task-install';
  caddySites = [
    {
      name: 'blog',
      domains: ['blog.example.dev'],
      listenPort: 443,
      kind: 'proxy',
      upstreams: ['10.99.0.2:8080'],
      enabled: true,
    },
  ];
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url === '/api/v1/nodes') return json({ nodes: [node] });
      if (url === '/api/v1/nodes/tyo-1') return json({ node });
      if (url === '/api/v1/certs') return json({ certificates: [certificate] });
      if (url === '/api/v1/settings') return json({ settings: [] });
      if (url === '/api/v1/nodes/tyo-1/apps') {
        return json({
          apps: [appConfig()],
          adapters: [
            {
              name: 'caddy-site',
              version: '1.0.0',
              api: 1,
              ...(pkgInstall ? { capabilities: { pkgInstall: true } } : {}),
            },
          ],
          adaptersError: null,
        });
      }
      if (url === '/api/v1/nodes/tyo-1/apps/caddy-site/install') {
        return json({ ok: true, accepted: true, taskId, result: { taskId } });
      }
      if (url === `/api/v1/nodes/tyo-1/tasks/${taskId}`) {
        return json({
          task: { id: taskId, state: 'running', progress: 40, logs: [], result: null, error: null },
        });
      }
      if (url === '/api/v1/nodes/tyo-1/apps/caddy-site') {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as { config?: { sites?: Record<string, unknown>[] } };
          caddySites = body.config?.sites ?? caddySites;
          return json({ app: appConfig() });
        }
        return json({ app: appConfig() });
      }
      if (url === '/api/v1/nodes/tyo-1/state') {
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
                  installed: caddyInstalled,
                  running: true,
                  sites: [{ name: 'blog', domain: 'blog.example.dev', active: true }],
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

function fileOf(text: string): File {
  return {
    name: 'sites.json',
    size: text.length,
    lastModified: 1,
    text: async () => text,
  } as File;
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  pickMock.mockReset();
  pickMock.mockResolvedValue(null);
  URL.createObjectURL = vi.fn(() => 'blob:sites');
  URL.revokeObjectURL = vi.fn();
  HTMLAnchorElement.prototype.click = vi.fn();
  mockApi();
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

/** 展开表格下方的「高级」折叠区（ui-redesign ⑤ 后导入/导出/清空收进高级区） */
async function expandAdvanced() {
  await userEvent.click(await screen.findByRole('button', { name: '高级' }));
}

describe('Caddy 站点导入导出', () => {
  it('导出当前 sites JSON', async () => {
    await renderRoute('/hubs/tyo-1/sites');
    expect((await screen.findAllByText('blog.example.dev')).length).toBeGreaterThan(0);
    await expandAdvanced();
    await userEvent.click(screen.getByRole('button', { name: '导出 JSON' }));
    expect(await screen.findByText('站点 JSON 已导出')).toBeTruthy();
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('导入预览新增并只保存不 apply', async () => {
    const payload = {
      sites: [
        {
          name: 'api',
          domains: ['api.example.dev'],
          listenPort: 443,
          kind: 'proxy',
          upstreams: ['127.0.0.1:3000'],
          enabled: true,
        },
      ],
    };
    pickMock.mockResolvedValue(fileOf(JSON.stringify(payload)));
    await renderRoute('/hubs/tyo-1/sites');
    await expandAdvanced();
    await userEvent.click(await screen.findByRole('button', { name: '导入 JSON' }));

    expect(await screen.findByText('导入站点预览')).toBeTruthy();
    expect((await screen.findAllByText('新增')).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: '确认导入' }));

    await waitFor(() => {
      expect(requests.some((item) => item.url === '/api/v1/nodes/tyo-1/apps/caddy-site' && item.init?.method === 'PUT')).toBe(true);
    });
    const put = requests.find(
      (item) => item.url === '/api/v1/nodes/tyo-1/apps/caddy-site' && item.init?.method === 'PUT',
    );
    const body = JSON.parse(String(put?.init?.body)) as { config: { sites: { name: string }[] } };
    expect(body.config.sites.map((item) => item.name)).toEqual(['blog', 'api']);
    expect(requests.some((item) => item.url.endsWith('/plan'))).toBe(false);
    expect(requests.some((item) => item.url.endsWith('/apply'))).toBe(false);
    expect(await screen.findByText('站点已导入并保存，需手动应用')).toBeTruthy();
  });

  it('冲突项禁用确认', async () => {
    pickMock.mockResolvedValue(
      fileOf(
        JSON.stringify({
          sites: [
            {
              name: 'other',
              domains: ['blog.example.dev'],
              listenPort: 443,
              kind: 'proxy',
              upstreams: ['127.0.0.1:3000'],
            },
          ],
        }),
      ),
    );
    await renderRoute('/hubs/tyo-1/sites');
    await expandAdvanced();
    await userEvent.click(await screen.findByRole('button', { name: '导入 JSON' }));
    expect((await screen.findAllByText('冲突')).length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: '确认导入' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('非法 JSON 显示错误', async () => {
    pickMock.mockResolvedValue(fileOf('{bad'));
    await renderRoute('/hubs/tyo-1/sites');
    await expandAdvanced();
    await userEvent.click(await screen.findByRole('button', { name: '导入 JSON' }));
    expect(await screen.findByText('文件不是合法 JSON')).toBeTruthy();
  });
});

describe('P1 Caddy 未安装一键安装（能力驱动）', () => {
  it('声明 pkgInstall 时展示安装按钮，确认后只发 1 次安装 + 1 次任务查询', async () => {
    mockApi({ caddyInstalled: false, pkgInstall: true, taskId: 'task-install' });
    await renderRoute('/hubs/tyo-1/sites');
    const installButton = await screen.findByRole('button', { name: '安装 Caddy' });
    await userEvent.click(installButton);
    expect(await screen.findByText('在节点上安装 Caddy？')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: '安装 Caddy' });
    await userEvent.click(buttons.at(-1)!);

    await waitFor(() => {
      expect(
        requests.filter((item) => item.url.endsWith('/apps/caddy-site/install')).length,
      ).toBe(1);
      expect(
        requests.filter((item) => item.url === '/api/v1/nodes/tyo-1/tasks/task-install').length,
      ).toBe(1);
    });
    expect(await screen.findByText(/任务 task-install：running/)).toBeTruthy();
  });

  it('旧 Agent 未声明能力时不展示安装按钮', async () => {
    mockApi({ caddyInstalled: false, pkgInstall: false });
    await renderRoute('/hubs/tyo-1/sites');
    expect(screen.queryByRole('button', { name: '安装 Caddy' })).toBeNull();
  });
});

describe('站点页分段（ui-redesign ⑤）', () => {
  it('证书分段展示本节点关联证书与管理链接', async () => {
    await renderRoute('/hubs/tyo-1/sites');
    await userEvent.click(await screen.findByRole('button', { name: '证书' }));
    expect((await screen.findAllByText('blog-cert')).length).toBeGreaterThan(0);
    expect(screen.getByText('管理全局证书库 →')).toBeTruthy();
  });

  it('扩展应用分段过滤内置模块并展示空态', async () => {
    await renderRoute('/hubs/tyo-1/sites');
    await userEvent.click(await screen.findByRole('button', { name: '扩展应用' }));
    expect(await screen.findByText('还没有应用')).toBeTruthy();
  });

  it('旧 /apps 暗路由 302 到站点页', async () => {
    const router = await renderRoute('/hubs/tyo-1/apps');
    expect((await screen.findAllByText('blog.example.dev')).length).toBeGreaterThan(0);
    expect(router.state.location.pathname).toBe('/hubs/tyo-1/sites');
  });

  it('旧 /certs 暗路由 302 到站点页', async () => {
    const router = await renderRoute('/hubs/tyo-1/certs');
    expect((await screen.findAllByText('blog.example.dev')).length).toBeGreaterThan(0);
    expect(router.state.location.pathname).toBe('/hubs/tyo-1/sites');
  });
});
