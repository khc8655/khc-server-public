// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { hubOverviewQueryOptions } from '../../data/queries';
import { ToastContextProvider } from '../../ui';
import { InstalledAppsCard } from './InstalledAppsCard';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Call = { url: string; body?: { params?: Record<string, unknown> } };

function makeOverviewResponse(catalogStatus: Record<string, unknown>, agentVersion = '0.8.0') {
  return {
    node: {
      id: 'hub-1',
      name: 'hub-1',
      endpoint: 'https://hub1.example.com:2053',
      tunnelEndpoint: null,
      liveEndpoint: null,
      domain: 'hub1.example.com',
      accessMode: 'domain',
      tunnelId: null,
      allowInsecure: false,
      preferredRoute: 'direct',
      status: 'online',
      lastSeenAt: 1_700_000_000,
      createdAt: 1,
      updatedAt: 2,
    },
    reachable: true,
    route: 'direct',
    via: 'fetch',
    error: null,
    state: {
      host: {
        hostname: 'hub-1',
        os: 'Ubuntu',
        kernel: '6.8',
        uptime: 100,
        load: [0, 0, 0],
        disk: { total: 100, used: 10, free: 90, percent: 10 },
        mem: { total: 1000, available: 800, used: 200, percent: 20 },
      },
      adapters: [{ name: 'app-catalog', version: '1.0.0', appliedRev: null, status: catalogStatus }],
      ports: [],
      agent: {
        version: agentVersion,
        serverTime: 1_700_000_000,
        capabilities: {
          appManifest: {
            schemas: [1, 2],
            features: ['schema2', 'upgrade', 'units', 'health.http', 'hookEnv'],
          },
        },
      },
    },
    overview: {
      apps: { online: 0, total: 0, issues: [], staticCount: 0, redirectCount: 0, items: [] },
      peers: {
        enabled: false,
        online: 0,
        total: 0,
        offline: [],
        interfaceName: null,
        listenPort: null,
        items: [],
      },
      forwards: { total: 0, tcpCount: 0, udpCount: 0, items: [] },
      certs: { count: 0, soonestDaysLeft: null, expiring: [] },
      accessCert: { daysLeft: null, tlsState: 'none' },
      host: null,
      managedServices: [],
      failedUnits: null,
    },
  };
}

let lastQueryClient: QueryClient | null = null;

function renderWithRouter(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lastQueryClient = queryClient;
  const rootRoute = createRootRoute({
    component: () => <ToastContextProvider value={{ show: vi.fn() }}>{ui}</ToastContextProvider>,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function Harness() {
  const overview = useQuery(hubOverviewQueryOptions('hub-1'));
  return (
    <InstalledAppsCard
      hubId="hub-1"
      state={overview.data?.state ?? null}
      stateLoading={overview.isLoading}
      pollIntervalMs={5}
    />
  );
}

const upgradeManifest = {
  id: 'demo-up',
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
  manifest: {
    schema: 2,
    name: 'demo-up',
    version: '2.0.0',
    runtime: { mode: 'create', user: 'khc-app-up', linger: true },
    params: [
      { key: 'web_port', type: 'integer', label: '端口', default: 3430, min: 1024, max: 65535 },
      { key: 'api_key', type: 'string', label: '访问密钥', secret: true, default: '' },
      { key: 'verbose', type: 'boolean', label: '详细日志', default: false },
      { key: 'link', type: 'string', label: '访问地址', derive: 'endpoint:web.publicUrl' },
    ],
    endpoints: [
      { id: 'web', label: 'Web', protocol: 'http', portParam: 'web_port', bind: 'loopback', publish: 'none' },
    ],
    scripts: { install: '#!/bin/sh\n', upgrade: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
    sha256: { install: '0'.repeat(64), upgrade: '1'.repeat(64), uninstall: '2'.repeat(64) },
    writes: [],
    units: [{ name: 'demo-up.service', scope: 'user' }],
  },
};

const upInstalled = {
  'demo-up/demo-up': {
    manifestId: 'demo-up',
    instance: 'demo-up',
    version: '1.0.0',
    schema: 2,
    source: 'manifest',
    mode: 'create',
    user: 'khc-app-up',
    units: [{ name: 'demo-up.service', scope: 'user', active: true, state: 'active' }],
    lastHealth: { ok: true },
  },
};

function stubUpgradeNode(opts: {
  installedDetail?: Record<string, unknown>;
  manifests?: unknown[];
  agentVersion?: string;
  upgradeTaskError?: Record<string, unknown>;
  calls: Call[];
}) {
  let upgradeCount = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Call['body']) : undefined;
      opts.calls.push({ url, body });
      if (url === '/api/v1/app-manifests') {
        return json({ appManifests: opts.manifests ?? [upgradeManifest] });
      }
      if (url.includes('/overview')) {
        return json(
          makeOverviewResponse({ installedDetail: opts.installedDetail ?? upInstalled }, opts.agentVersion),
        );
      }
      if (url.endsWith('/manifest_upgrade')) {
        upgradeCount += 1;
        return json({ ok: true, taskId: `task-up-${upgradeCount}` });
      }
      if (url.includes('/tasks/task-up-')) {
        const failing = opts.upgradeTaskError && url.endsWith('task-up-1');
        return json({
          task: {
            id: url.split('/').pop(),
            state: failing ? 'error' : 'done',
            progress: 100,
            logs: [],
            result: {},
            error: failing ? opts.upgradeTaskError : null,
          },
        });
      }
      if (url.endsWith('/recipe_uninstall') || url.endsWith('/manifest_uninstall')) {
        return json({ ok: true, taskId: 'task-un-1' });
      }
      if (url.includes('/tasks/task-un-1')) {
        return json({ task: { id: 'task-un-1', state: 'done', progress: 100, logs: [], result: {}, error: null } });
      }
      return json({});
    }),
  );
}

async function openDrawerAndUpgrade() {
  expect(await screen.findByText('→ 2.0.0')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: '详情' }));
  const drawer = await screen.findByRole('dialog');
  await userEvent.click(within(drawer).getByRole('button', { name: '升级到 2.0.0' }));
  return drawer;
}

const upgradeCallsOf = (calls: Call[]) => calls.filter((c) => c.url.endsWith('/manifest_upgrade'));

describe('已装应用抽屉：升级沿用安装参数、单元状态与 v1 条目（V4.1）', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('升级不展开参数 → values 为空对象；Agent < 0.8.1 时提示不会记住安装参数', async () => {
    const calls: Call[] = [];
    stubUpgradeNode({ calls });
    renderWithRouter(<Harness />);
    const drawer = await openDrawerAndUpgrade();

    expect(within(drawer).getByText(/节点 Agent < 0\.8\.1 时不会记住安装参数/)).toBeTruthy();
    expect(within(drawer).queryByLabelText('端口')).toBeNull();
    await userEvent.click(within(drawer).getByRole('button', { name: '确认升级' }));
    await waitFor(() => expect(upgradeCallsOf(calls)).toHaveLength(1));
    const params = upgradeCallsOf(calls)[0]!.body!.params!;
    expect(params).toEqual({ manifestId: 'demo-up', values: {} });
    expect(params).not.toHaveProperty('instance');
  });

  it('Agent ≥ 0.8.1 时不显示旧 Agent 提示', async () => {
    const calls: Call[] = [];
    stubUpgradeNode({ calls, agentVersion: '0.8.1' });
    renderWithRouter(<Harness />);
    const drawer = await openDrawerAndUpgrade();
    expect(within(drawer).queryByText(/不会记住安装参数/)).toBeNull();
    expect(within(drawer).getByRole('button', { name: '修改参数（可选）' })).toBeTruthy();
  });

  it('展开后只改端口与密钥 → values 只含这两个键；boolean 保持原值不出现；密钥不进缓存键与 localStorage', async () => {
    const calls: Call[] = [];
    stubUpgradeNode({ calls });
    renderWithRouter(<Harness />);
    const drawer = await openDrawerAndUpgrade();

    await userEvent.click(within(drawer).getByRole('button', { name: '修改参数（可选）' }));
    const secret = within(drawer).getByLabelText('访问密钥') as HTMLInputElement;
    expect(secret.type).toBe('password');
    expect(secret.placeholder).toBe('留空保持原值');
    const verbose = within(drawer).getByLabelText('详细日志') as HTMLSelectElement;
    expect(verbose.value).toBe('');
    expect(within(drawer).getByLabelText('访问地址')).toBeTruthy();
    expect(within(drawer).getByText('安装时自动推导，升级不会重新推导')).toBeTruthy();

    await userEvent.type(within(drawer).getByLabelText('端口'), '9000');
    await userEvent.type(secret, 'UP-SECRET-777');

    await userEvent.click(within(drawer).getByRole('button', { name: '确认升级' }));
    await waitFor(() => expect(upgradeCallsOf(calls)).toHaveLength(1));
    expect(upgradeCallsOf(calls)[0]!.body!.params).toEqual({
      manifestId: 'demo-up',
      values: { web_port: 9000, api_key: 'UP-SECRET-777' },
    });
    expect(
      JSON.stringify(lastQueryClient!.getQueryCache().getAll().map((q) => q.queryKey)),
    ).not.toContain('UP-SECRET-777');
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('UP-SECRET-777');
  });

  it('boolean 三态：选「是」才提交；整数越界只对已填写的键报错且不发请求', async () => {
    const calls: Call[] = [];
    stubUpgradeNode({ calls });
    renderWithRouter(<Harness />);
    const drawer = await openDrawerAndUpgrade();
    await userEvent.click(within(drawer).getByRole('button', { name: '修改参数（可选）' }));

    await userEvent.type(within(drawer).getByLabelText('端口'), '80');
    await userEvent.click(within(drawer).getByRole('button', { name: '确认升级' }));
    expect(await within(drawer).findByText(/端口.*1024/)).toBeTruthy();
    expect(upgradeCallsOf(calls)).toHaveLength(0);
    expect(within(drawer).queryByText('请填写访问密钥')).toBeNull();

    await userEvent.clear(within(drawer).getByLabelText('端口'));
    await userEvent.selectOptions(within(drawer).getByLabelText('详细日志'), '是');
    await userEvent.click(within(drawer).getByRole('button', { name: '确认升级' }));
    await waitFor(() => expect(upgradeCallsOf(calls)).toHaveLength(1));
    expect(upgradeCallsOf(calls)[0]!.body!.params!.values).toEqual({ verbose: true });
  });

  it('任务失败带 details.field → 自动展开折叠区、字段显示错误、按钮变为「补填后重试升级」，补填后重试带该键', async () => {
    const calls: Call[] = [];
    stubUpgradeNode({
      calls,
      upgradeTaskError: { code: 'internal_error', message: '缺少参数 link', details: { field: 'link' } },
    });
    renderWithRouter(<Harness />);
    const drawer = await openDrawerAndUpgrade();
    await userEvent.click(within(drawer).getByRole('button', { name: '确认升级' }));

    expect(await within(drawer).findByRole('button', { name: '补填后重试升级' })).toBeTruthy();
    const linkInput = within(drawer).getByLabelText('访问地址') as HTMLInputElement;
    expect(within(drawer).getAllByText('缺少参数 link').length).toBeGreaterThanOrEqual(1);

    await userEvent.type(linkInput, 'https://app.example.com');
    await userEvent.click(within(drawer).getByRole('button', { name: '补填后重试升级' }));
    await waitFor(() => expect(upgradeCallsOf(calls)).toHaveLength(2));
    expect(upgradeCallsOf(calls)[1]!.body!.params!.values).toEqual({ link: 'https://app.example.com' });
  });

  it('details.field 不在新版本清单参数里 → 不展开折叠区，只显示错误原文', async () => {
    const calls: Call[] = [];
    stubUpgradeNode({
      calls,
      upgradeTaskError: {
        code: 'internal_error',
        message: '缺少参数 removed_param',
        details: { field: 'removed_param' },
      },
    });
    renderWithRouter(<Harness />);
    const drawer = await openDrawerAndUpgrade();
    await userEvent.click(within(drawer).getByRole('button', { name: '确认升级' }));
    await waitFor(() => expect(upgradeCallsOf(calls)).toHaveLength(1));
    expect(await within(drawer).findByText(/缺少参数 removed_param/)).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: '补填后重试升级' })).toBeNull();
    expect(within(drawer).queryByLabelText('访问地址')).toBeNull();
  });

  it('只认 details.field：没有 details 时即使 message 含「缺少参数」也不展开', async () => {
    const calls: Call[] = [];
    stubUpgradeNode({
      calls,
      upgradeTaskError: { code: 'internal_error', message: '缺少参数 link' },
    });
    renderWithRouter(<Harness />);
    const drawer = await openDrawerAndUpgrade();
    await userEvent.click(within(drawer).getByRole('button', { name: '确认升级' }));
    await waitFor(() => expect(upgradeCallsOf(calls)).toHaveLength(1));
    expect(await within(drawer).findByText(/缺少参数 link/)).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: '补填后重试升级' })).toBeNull();
  });

  it('v1 清单（D1 schema 1）+ 记录 schema 2：徽标 v1、卸载发 recipe_uninstall、无启停与升级按钮', async () => {
    const v1Manifest = {
      id: 'demo-v1',
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
      manifest: {
        name: 'demo-v1',
        version: '0.1.0',
        runtime: { mode: 'create', user: 'khc-app-demo', linger: true },
        params: [{ key: 'web_port', type: 'integer', default: 3430 }],
        scripts: { install: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
        sha256: { install: '0'.repeat(64), uninstall: '0'.repeat(64) },
        publish: { label: 'Web', host: '127.0.0.1', portParam: 'web_port', port: 3430 },
        writes: [],
      },
    };
    const calls: Call[] = [];
    stubUpgradeNode({
      calls,
      manifests: [v1Manifest],
      installedDetail: {
        'demo-v1/demo-v1': {
          manifestId: 'demo-v1',
          instance: 'demo-v1',
          version: '0.1.0',
          schema: 2,
          source: 'manifest',
          units: [{ name: 'demo-v1.service', scope: 'user', active: true, state: 'active' }],
        },
      },
    });
    renderWithRouter(<Harness />);
    await screen.findAllByText(/demo-v1/);
    await userEvent.click(screen.getByRole('button', { name: '详情' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('v1')).toBeTruthy();
    expect(within(drawer).queryByText('v2')).toBeNull();
    expect(within(drawer).queryByRole('button', { name: '重启' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: '查看日志' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: /升级到/ })).toBeNull();

    await userEvent.click(within(drawer).getByRole('button', { name: '卸载' }));
    const btns = within(drawer).getAllByRole('button', { name: '卸载' });
    await userEvent.click(btns[btns.length - 1]!);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/recipe_uninstall'))).toBe(true));
    expect(calls.some((c) => c.url.endsWith('/manifest_uninstall'))).toBe(false);
  });

  it('清单已被删除时退回记录里的 schema；单元 failed 显示 failed 与 danger 色调', async () => {
    const calls: Call[] = [];
    stubUpgradeNode({
      calls,
      manifests: [],
      installedDetail: {
        'gone/gone': {
          manifestId: 'gone',
          instance: 'gone',
          version: '1.0.0',
          schema: 2,
          source: 'manifest',
          units: [{ name: 'gone.service', scope: 'user', active: false, state: 'failed' }],
        },
      },
    });
    renderWithRouter(<Harness />);
    await screen.findAllByText(/gone/);
    await userEvent.click(screen.getByRole('button', { name: '详情' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('v2')).toBeTruthy();
    const failed = within(drawer).getByText('failed');
    expect(failed.className).toContain('ui-badge-danger');
  });
});
