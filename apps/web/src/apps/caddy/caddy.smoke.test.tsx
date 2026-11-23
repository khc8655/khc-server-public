// @vitest-environment jsdom
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
let caddyRev = 1;
let caddyAppliedRev = 1;
let currentNode: Record<string, unknown> = node;
let listeningItems: { proto: string; address: string; port: number; process?: string }[] = [];
let scanBlocks: Record<string, unknown>[] = [];
let applyError: string | null = null;
let applyFailure: { status?: number; message: string; details?: Record<string, unknown> } | null = null;
let requests: { url: string; init?: RequestInit }[] = [];

function appConfig() {
  return {
    app: 'caddy-site',
    schemaVersion: 1,
    config: { sites: caddySites },
    rev: caddyRev,
    appliedRev: caddyAppliedRev,
    updatedAt: NOW,
  };
}

const emptyOverview = {
  apps: { online: 0, total: 0, issues: [], staticCount: 0, redirectCount: 0, items: [] },
  peers: { enabled: false, online: 0, total: 0, offline: [], interfaceName: null, listenPort: null, items: [] },
  forwards: { total: 0, tcpCount: 0, udpCount: 0, items: [] },
  certs: { count: 0, soonestDaysLeft: null, expiring: [] },
  accessCert: { daysLeft: null, tlsState: 'none' },
  host: null,
  managedServices: [],
  failedUnits: null,
};

function mockApi(
  options: {
    nodeOverride?: Record<string, unknown>;
    caddyInstalled?: boolean;
    pkgInstall?: boolean;
    taskId?: string;
    sites?: Record<string, unknown>[];
    withCerts?: boolean;
    listening?: { proto: string; address: string; port: number; process?: string }[];
  } = {},
) {
  currentNode = options.nodeOverride ?? node;
  const caddyInstalled = options.caddyInstalled ?? true;
  const pkgInstall = options.pkgInstall ?? false;
  const taskId = options.taskId ?? 'task-install';
  const withCerts = options.withCerts ?? true;
  listeningItems = options.listening ?? [];
  caddyRev = 1;
  caddyAppliedRev = 1;
  scanBlocks = [];
  applyError = null;
  applyFailure = null;
  caddySites = options.sites ?? [
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
      if (url === '/api/v1/nodes') return json({ nodes: [currentNode] });
      if (url === '/api/v1/nodes/tyo-1') return json({ node: currentNode });
      if (url === '/api/v1/certs') return json({ certificates: withCerts ? [certificate] : [] });
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
          caddyRev += 1;
          return json({ app: appConfig() });
        }
        return json({ app: appConfig() });
      }
      if (url === '/api/v1/nodes/tyo-1/apps/caddy-site/apply') {
        if (applyFailure) {
          return json(
            {
              error: {
                code: 'apply_failed',
                message: applyFailure.message,
                ...(applyFailure.details ? { details: applyFailure.details } : {}),
              },
            },
            applyFailure.status ?? 500,
          );
        }
        if (applyError) {
          return json({ ok: false, error: { code: 'apply_failed', message: applyError } });
        }
        caddyAppliedRev = caddyRev;
        return json({ ok: true, result: {} });
      }
      if (url === '/api/v1/nodes/tyo-1/apps/caddy-site/caddy_import_scan') {
        return json({
          ok: true,
          result: {
            exists: true,
            caddyfilePath: '/etc/caddy/Caddyfile',
            blocks: scanBlocks,
            imports: [],
            backups: [],
          },
        });
      }
      if (url === '/api/v1/nodes/tyo-1/overview') {
        return json({
          node: { ...currentNode, caddyMode: caddyInstalled ? 'installed' : 'none' },
          reachable: true,
          route: 'direct',
          via: 'fetch',
          error: null,
          state: {
            host: { hostname: 'tyo-1' },
            ops: {
              network: {
                listening: { count: listeningItems.length, items: listeningItems },
              },
            },
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
          overview: emptyOverview,
        });
      }
      return json({});
    }),
  );
}

beforeEach(() => {
  window.scrollTo = vi.fn();
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

/** 展开表格下方的「高级」折叠区 */
async function expandAdvanced() {
  await userEvent.click(await screen.findByRole('button', { name: '高级' }));
}

describe('站点抽屉与列表交互规范（T3）', () => {
  it('高级区仅保留清空站点（移除页底 JSON 导入导出），且过滤占位块与 caddy 自身端口', async () => {
    scanBlocks = [
      {
        id: 'placeholder',
        hash: 'h-empty',
        address: '—',
        startLine: 11,
        endLine: 23,
        text: ':80 {}',
        supported: false,
        reason: null,
        domains: [],
        listenPort: 80,
        kind: 'proxy',
        upstreams: [],
      },
    ];
    mockApi({
      withCerts: false,
      listening: [
        { proto: 'tcp', address: '0.0.0.0', port: 2083, process: 'caddy' },
        { proto: 'tcp', address: '0.0.0.0', port: 9000, process: 'python3' },
      ],
    });
    // 保留上面设置的 scanBlocks（mockApi 清空了 scanBlocks，重新注入）
    scanBlocks = [
      {
        id: 'placeholder',
        hash: 'h-empty',
        address: '—',
        startLine: 11,
        endLine: 23,
        text: ':80 {}',
        supported: false,
        reason: null,
        domains: [],
        listenPort: 80,
        kind: 'proxy',
        upstreams: [],
      },
    ];
    await renderRoute('/hubs/tyo-1/sites');
    expect((await screen.findAllByText(/https:\/\/blog\.example\.dev/)).length).toBeGreaterThan(0);
    // 无真实未托管站点块时，「外部配置（未托管）」默认折叠进页底「高级」区。
    await waitFor(() => {
      expect(requests.some((item) => item.url.endsWith('/caddy_import_scan'))).toBe(true);
    });
    expect(screen.queryByText('外部配置（未托管）')).toBeNull();
    await expandAdvanced();
    expect(await screen.findByText('外部配置（未托管）')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '导出 JSON' })).toBeNull();
    expect(screen.queryByRole('button', { name: '导入 JSON' })).toBeNull();
    expect(screen.getByRole('button', { name: '清空站点' })).toBeTruthy();

    // 过滤 Caddyfile 默认空占位块与 caddy 进程端口
    expect(await screen.findByText('没有发现未托管的外部站点块')).toBeTruthy();
    expect(screen.queryByText('需手工处理')).toBeNull();
    expect(screen.queryByText('2083 · caddy')).toBeNull();
    expect((await screen.findAllByText('9000 · python3')).length).toBeGreaterThan(0);
  });

  it('抽屉内「保存并生效」不叠弹 Dialog；apply 失败时回滚 D1 并在抽屉内直接报错', async () => {
    await renderRoute('/hubs/tyo-1/sites');
    await screen.findAllByText(/https:\/\/blog\.example\.dev/);
    applyError = 'caddy validate failed: bad upstream';

    await userEvent.click(screen.getByRole('button', { name: '添加站点' }));
    const drawer = await screen.findByRole('dialog');
    await userEvent.type(within(drawer).getByLabelText(/^域名/), 'bad.example.com');
    const targetPort = within(drawer).getByLabelText(/^本机监听端口/) as HTMLInputElement;
    await userEvent.clear(targetPort);
    await userEvent.type(targetPort, '9999');

    await userEvent.click(within(drawer).getByRole('button', { name: '保存并生效' }));

    // 只有一个 drawer dialog，不叠第二个确认弹窗
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(await within(drawer).findByText('caddy validate failed: bad upstream')).toBeTruthy();
    // 抽屉仍然打开，且 D1 已被回滚只剩最初 1 条站点
    expect(drawer.isConnected).toBe(true);
    expect(caddySites.map((item) => item.name)).toEqual(['blog']);
  });

  it('仅保存草稿时新增行标「待应用」、未改动运行行保持「已同步」，顶部横幅按钮为「应用到节点」', async () => {
    await renderRoute('/hubs/tyo-1/sites');
    await screen.findAllByText(/https:\/\/blog\.example\.dev/);

    await userEvent.click(screen.getByRole('button', { name: '添加站点' }));
    const drawer = await screen.findByRole('dialog');
    await userEvent.type(within(drawer).getByLabelText(/^域名/), 'draft.example.com');
    const targetPort = within(drawer).getByLabelText(/^本机监听端口/) as HTMLInputElement;
    await userEvent.clear(targetPort);
    await userEvent.type(targetPort, '9100');
    await userEvent.click(within(drawer).getByRole('button', { name: '保存' }));

    expect(await screen.findByRole('button', { name: '应用到节点' })).toBeTruthy();
    expect((await screen.findAllByText('已同步')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('待应用')).length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: '应用到节点' }));
    const confirm = await screen.findByRole('dialog');
    expect(confirm).toBeTruthy();
    await userEvent.click(confirm.querySelector('.ui-btn-primary') as HTMLButtonElement);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
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

describe('应用页分段与本机监听端口（U3）', () => {
  it('默认仅列反代应用，静态/跳转为空时不显示该分段；只有唯一分段时隐藏 Segmented', async () => {
    mockApi({ withCerts: false });
    await renderRoute('/hubs/tyo-1/sites');
    expect(await screen.findByRole('heading', { name: '应用' })).toBeTruthy();
    expect((await screen.findAllByText(/https:\/\/blog\.example\.dev/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('columnheader', { name: '应用' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '访问地址' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '指向目标' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '状态' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: '应用' })).toBeNull();
    expect(screen.queryByRole('button', { name: '静态与跳转' })).toBeNull();
    expect(screen.queryByRole('button', { name: '证书' })).toBeNull();
    expect(screen.queryByText('本机监听端口')).toBeNull();
  });

  it('有静态或跳转站点时出现「静态与跳转」分段', async () => {
    mockApi({
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
    });
    await renderRoute('/hubs/tyo-1/sites');
    expect((await screen.findAllByText(/https:\/\/blog\.example\.dev/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/https:\/\/landing\.example\.dev/)).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: '静态与跳转' }));
    expect((await screen.findAllByText(/https:\/\/landing\.example\.dev/)).length).toBeGreaterThan(0);
  });

  it('证书分段展示本节点关联证书、管理链接与 R6 统计说明', async () => {
    await renderRoute('/hubs/tyo-1/sites');
    await userEvent.click(await screen.findByRole('button', { name: '证书' }));
    expect((await screen.findAllByText('blog-cert')).length).toBeGreaterThan(0);
    expect(screen.getByText('管理全局证书库')).toBeTruthy();
    expect(screen.getByText('仅统计证书库中的证书，Caddy 自动签发的不计。')).toBeTruthy();
  });

  it('反代列表为空时保留 P-5「添加第一个应用」引导', async () => {
    mockApi({ sites: [], withCerts: false });
    await renderRoute('/hubs/tyo-1/sites');
    expect(await screen.findByText('还没有应用')).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加第一个应用' })).toBeTruthy();
  });

  it('有未发布本机监听端口时渲染卡片，支持行点击与「发布」按钮预填站点抽屉（IPv4/IPv6）', async () => {
    mockApi({
      withCerts: false,
      nodeOverride: { ...node, domain: 'vm.example.com', endpoint: 'https://vm.example.com' },
      listening: [
        { proto: 'tcp', address: '0.0.0.0', port: 9000, process: 'python3' },
        { proto: 'tcp6', address: '::1', port: 9500, process: 'node' },
        { proto: 'tcp', address: '127.0.0.1', port: 22 },
      ],
    });
    await renderRoute('/hubs/tyo-1/sites');
    expect(await screen.findByText('本机监听端口')).toBeTruthy();
    expect((await screen.findAllByText('9000 · python3')).length).toBeGreaterThan(0);
    expect(screen.queryByText('22')).toBeNull();
    const publishButtons = screen.getAllByRole('button', { name: '发布' });
    // 桌面表格 + 移动端 .ui-list-side 均渲染「发布」按钮（2 条监听 * 2 = 4 个）
    expect(publishButtons.length).toBe(4);
    const mobileSidePublish = [...document.querySelectorAll('.ui-list .ui-list-side button')].filter(
      (btn) => btn.textContent?.trim() === '发布',
    );
    expect(mobileSidePublish.length).toBe(2);
    await userEvent.click(mobileSidePublish[1] as HTMLButtonElement);
    expect(await screen.findByRole('heading', { name: '添加站点' })).toBeTruthy();
    expect((document.getElementById('site-name') as HTMLInputElement).value).toBe('node');
    expect((document.getElementById('site-domains') as HTMLInputElement).value).toBe('vm.example.com');
    expect((document.getElementById('site-port') as HTMLInputElement).value).toBe('8443');
    expect((document.getElementById('site-upstreams') as HTMLInputElement).value).toBe('[::1]:9500');
  });

  it('站点表指向目标与访问链接：宽屏独立列，窄屏并入应用列第二段（390 不丢项）', async () => {
    await renderRoute('/hubs/tyo-1/sites');
    const link = await screen.findByRole('link', { name: /https:\/\/blog\.example\.dev/ });
    expect(link.getAttribute('href')).toBe('https://blog.example.dev');
    expect(screen.getByRole('columnheader', { name: '指向目标' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制访问地址' })).toBeTruthy();
    const matches = await screen.findAllByText(/内网（未登记）\s*10\.99\.0\.2:8080/);
    expect(matches.length).toBeGreaterThanOrEqual(1);

    const narrow = document.querySelector('.ui-cell-narrow');
    expect(narrow?.textContent).toContain('内网（未登记）');
    expect(narrow?.textContent).toContain('10.99.0.2:8080');

    window.innerWidth = 390;
    window.dispatchEvent(new Event('resize'));
    expect(document.querySelector('.ui-cell-narrow')?.textContent).toContain('内网（未登记）');
  });

  it('已绑定 VM 域名的节点支持同一域名多端口添加第二个应用，不覆盖已有应用', async () => {
    mockApi({
      withCerts: false,
      nodeOverride: { ...node, domain: 'vm.example.com', endpoint: 'https://vm.example.com' },
      sites: [
        {
          name: 'llmproxy',
          domains: ['vm.example.com'],
          listenPort: 8443,
          kind: 'proxy',
          upstreams: ['127.0.0.1:8787'],
          enabled: true,
        },
      ],
    });
    await renderRoute('/hubs/tyo-1/sites');
    expect((await screen.findAllByText(/https:\/\/vm\.example\.com:8443/)).length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: '添加站点' }));
    const drawer = await screen.findByRole('dialog');
    expect((within(drawer).getByLabelText(/^域名/) as HTMLInputElement).value).toBe('vm.example.com');
    expect((within(drawer).getByLabelText('对外端口') as HTMLInputElement).value).toBe('2083');

    await userEvent.type(within(drawer).getByLabelText(/^应用名称/), 'magpie');
    const targetPort = within(drawer).getByLabelText(/^本机监听端口/) as HTMLInputElement;
    await userEvent.clear(targetPort);
    await userEvent.type(targetPort, '3430');

    await userEvent.click(within(drawer).getByRole('button', { name: '保存并生效' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(caddySites.map((item) => ({ name: item.name, listenPort: item.listenPort }))).toEqual([
      { name: 'llmproxy', listenPort: 8443 },
      { name: 'magpie', listenPort: 2083 },
    ]);
  });

  it('旧 /apps 暗路由 302 到设置页组件分段', async () => {
    const router = await renderRoute('/hubs/tyo-1/apps');
    expect(await screen.findByRole('heading', { name: '设置' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/hubs/tyo-1/settings');
    expect(await screen.findByText('内置组件')).toBeTruthy();
  });

  it('旧 /certs 暗路由 302 到应用页证书分段', async () => {
    const router = await renderRoute('/hubs/tyo-1/certs');
    expect((await screen.findAllByText('blog-cert')).length).toBeGreaterThan(0);
    expect(router.state.location.pathname).toBe('/hubs/tyo-1/sites');
  });

  it('应用页主按钮可直接打开「安装并发布应用」三步向导，添加站点抽屉内不再嵌套向导与冗余域名下拉', async () => {
    await renderRoute('/hubs/tyo-1/sites');
    await userEvent.click(await screen.findByRole('button', { name: '安装并发布应用' }));
    expect(await screen.findByRole('heading', { name: '安装并发布应用' })).toBeTruthy();

    await userEvent.click(screen.getAllByRole('button', { name: '关闭' }).at(-1)!);
    await userEvent.click(screen.getByRole('button', { name: '添加站点' }));
    expect(await screen.findByRole('heading', { name: '添加站点' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '打开安装并发布向导' })).toBeNull();
    expect(screen.queryByLabelText(/从已有域名选择/)).toBeNull();
  });

  it('存在未托管外部站点块时自动顶升外部配置卡到「高级」区外，且过滤 socat 转发端口', async () => {
    mockApi({
      listening: [
        { proto: 'tcp', address: '0.0.0.0', port: 2083, process: 'socat' },
        { proto: 'tcp', address: '0.0.0.0', port: 9099, process: 'python3' },
      ],
    });
    scanBlocks = [
      {
        id: 'legacy-1',
        hash: 'h-legacy',
        address: ':8443',
        startLine: 1,
        endLine: 6,
        text: 'legacy.example.com { reverse_proxy 127.0.0.1:8080 }',
        supported: true,
        reason: null,
        domains: ['legacy.example.com'],
        listenPort: 8443,
        kind: 'proxy',
        upstreams: ['127.0.0.1:8080'],
      },
    ];
    await renderRoute('/hubs/tyo-1/sites');
    expect(await screen.findByText('外部配置（未托管）')).toBeTruthy();
    expect((await screen.findAllByText('legacy.example.com')).length).toBeGreaterThan(0);
    expect(screen.queryByText('2083 · socat')).toBeNull();
    expect((await screen.findAllByText('9099 · python3')).length).toBeGreaterThan(0);
  });

  it('启用 host-ops 时，SiteDrawer 检查宿主防火墙并在抽屉内一键放行 TCP 8443（不叠 Dialog）', async () => {
    mockApi({ withCerts: false });
    let fwRules = [
      { id: '__ssh_22', action: 'allow', proto: 'tcp', port: '22', source: '0.0.0.0/0', note: 'SSH', locked: true },
      { id: 'r-443', action: 'allow', proto: 'tcp', port: '443', source: '0.0.0.0/0', note: 'web' },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
        if (url === '/api/v1/nodes') return json({ nodes: [currentNode] });
        if (url === '/api/v1/nodes/tyo-1') return json({ node: currentNode });
        if (url === '/api/v1/certs') return json({ certificates: [] });
        if (url === '/api/v1/settings') return json({ settings: [] });
        if (url === '/api/v1/nodes/tyo-1/apps') {
          return json({
            apps: [appConfig()],
            adapters: [
              { name: 'caddy-site', version: '1.0.0', api: 1 },
              { name: 'host-ops', version: '1.4.0', api: 1 },
            ],
            adaptersError: null,
          });
        }
        if (url === '/api/v1/nodes/tyo-1/apps/caddy-site') return json({ app: appConfig() });
        if (url === '/api/v1/nodes/tyo-1/apps/caddy-site/caddy_import_scan') {
          return json({ ok: true, result: { exists: true, caddyfilePath: '/etc/caddy/Caddyfile', blocks: [], imports: [], backups: [] } });
        }
        if (url === '/api/v1/nodes/tyo-1/overview') {
          return json({
            node,
            reachable: true,
            route: 'direct',
            via: 'fetch',
            error: null,
            state: {
              host: { hostname: 'tyo-1' },
              ops: {},
              adapters: [{ name: 'caddy-site', version: '1.0.0', status: { installed: true, running: true, sites: [] } }],
              ports: [],
            },
            overview: emptyOverview,
          });
        }
        if (url === '/api/v1/nodes/tyo-1/apps/host-ops/call') {
          const verb = (JSON.parse(String(init?.body)) as { params: { verb: string } }).params.verb;
          if (verb === 'version') return json({ ok: true, data: { root: true, nft: true } });
          if (verb === 'fw.show') return json({ ok: true, data: { baseRev: 'rev-1', rules: fwRules, autoRules: [] } });
          if (verb === 'fw.confirm') return json({ ok: true, data: { confirmed: true } });
        }
        if (url === '/api/v1/nodes/tyo-1/apps/host-ops/call_task') {
          const body = JSON.parse(String(init?.body)) as { params: { params: { rules: typeof fwRules } } };
          fwRules = body.params.params.rules;
          return json({ ok: true, accepted: true, taskId: 'task-fw', result: { taskId: 'task-fw' } });
        }
        if (url === '/api/v1/nodes/tyo-1/tasks/task-fw') {
          return json({ ok: true, task: { id: 'task-fw', state: 'done', result: { ok: true, data: { token: 'tok-fw' } }, error: null } });
        }
        return json({});
      }),
    );

    await renderRoute('/hubs/tyo-1/sites');
    await userEvent.click(await screen.findByRole('button', { name: '添加站点' }));
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('主机防火墙尚未放行 TCP 8443')).toBeTruthy();

    await userEvent.click(within(drawer).getByRole('button', { name: '一键放行 TCP 8443' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(await within(drawer).findByText('主机防火墙已放行 TCP 8443')).toBeTruthy();
    expect(fwRules.some((rule) => rule.port === '8443' && rule.action === 'allow')).toBe(true);
  });

  it('502/不可达站点在列表上方渲染「异常应用排查」病因并支持编辑/跳转运维（P3）', async () => {
    mockApi({
      withCerts: false,
      sites: [
        {
          name: 'llproxy',
          domains: ['test.example.com'],
          listenPort: 8779,
          kind: 'proxy',
          upstreams: ['127.0.0.1:8787'],
          enabled: true,
        },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
        if (url === '/api/v1/nodes') return json({ nodes: [currentNode] });
        if (url === '/api/v1/nodes/tyo-1') return json({ node: currentNode });
        if (url === '/api/v1/certs') return json({ certificates: [] });
        if (url === '/api/v1/settings') return json({ settings: [] });
        if (url === '/api/v1/nodes/tyo-1/apps') {
          return json({
            apps: [appConfig()],
            adapters: [{ name: 'caddy-site', version: '1.0.0', api: 1 }],
            adaptersError: null,
          });
        }
        if (url === '/api/v1/nodes/tyo-1/apps/caddy-site') return json({ app: appConfig() });
        if (url === '/api/v1/nodes/tyo-1/apps/caddy-site/caddy_import_scan') {
          return json({ ok: true, result: { exists: true, caddyfilePath: '/etc/caddy/Caddyfile', blocks: [], imports: [], backups: [] } });
        }
        if (url === '/api/v1/nodes/tyo-1/overview') {
          return json({
            node: currentNode,
            reachable: true,
            route: 'direct',
            via: 'fetch',
            error: null,
            state: {
              host: { hostname: 'tyo-1' },
              ops: {
                network: {
                  listening: {
                    count: 1,
                    items: [{ proto: 'tcp', address: '0.0.0.0', port: 9099, process: 'python3' }],
                  },
                },
              },
              adapters: [
                {
                  name: 'caddy-site',
                  version: '1.0.0',
                  status: {
                    installed: true,
                    running: true,
                    sites: [],
                    siteHealth: [
                      {
                        name: 'llproxy',
                        domain: 'test.example.com',
                        state: 'down',
                        status: null,
                        latencyMs: null,
                        error: 'connection refused',
                        upstreams: ['127.0.0.1:8787'],
                      },
                    ],
                  },
                },
              ],
              ports: [],
            },
            overview: emptyOverview,
          });
        }
        return json({});
      }),
    );

    await renderRoute('/hubs/tyo-1/sites');
    expect(await screen.findByText('异常应用排查')).toBeTruthy();
    expect(screen.getByText('本机目标 127.0.0.1:8787 未监听，对应进程可能未启动或监听端口已变化。')).toBeTruthy();
    expect(screen.getByRole('link', { name: '主机运维' }).getAttribute('href')).toBe('/hubs/tyo-1/ops');

    await userEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect(await screen.findByRole('heading', { name: '编辑站点' })).toBeTruthy();
  });

  it('保存并生效遇到 caddy reload 失败时，抽屉内透出具体 stderr 与 Caddy 未启动提示', async () => {
    mockApi({
      nodeOverride: { ...node, domain: 'vm.example.com', endpoint: 'https://vm.example.com:2053' },
    });
    applyFailure = {
      status: 500,
      message: '应用失败，已自动回滚：caddy reload 失败',
      details: {
        cause: {
          details: {
            systemctlStderr: 'caddy.service is not active, cannot reload.',
          },
        },
      },
    };
    await renderRoute('/hubs/tyo-1/sites');
    await userEvent.click(await screen.findByRole('button', { name: '添加站点' }));
    const drawer = await screen.findByRole('dialog');
    await userEvent.type(within(drawer).getByLabelText(/^应用名称/), 'magpie');
    const targetPort = within(drawer).getByLabelText(/^本机监听端口/) as HTMLInputElement;
    await userEvent.clear(targetPort);
    await userEvent.type(targetPort, '3430');

    await userEvent.click(within(drawer).getByRole('button', { name: '保存并生效' }));
    expect(await within(drawer).findByText(/caddy\.service is not active, cannot reload\./)).toBeTruthy();
    expect(within(drawer).getByText(/节点上的 Caddy 服务当前未启动/)).toBeTruthy();
  });
});
