// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { ToastContextProvider } from '../../ui';
import { InstalledAppsCard } from './InstalledAppsCard';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const v1Manifest = {
  id: 'demo-v1',
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
  manifest: {
    name: 'demo-v1',
    version: '0.1.4265',
    runtime: { mode: 'create', user: 'khc-app-demo', linger: true },
    params: [
      { key: 'web_port', type: 'integer', label: 'Web 端口', default: 3430, min: 1024, max: 65535 },
    ],
    scripts: { install: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
    sha256: { install: '0'.repeat(64), uninstall: '0'.repeat(64) },
    publish: { label: 'Web', host: '127.0.0.1', portParam: 'web_port', port: 3430 },
    writes: [],
  },
};

const v2Manifest = {
  id: 'demo-v2',
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
  manifest: {
    schema: 2,
    name: 'demo-v2',
    version: '2.0.0',
    runtime: { mode: 'create', user: 'khc-app-v2', linger: true },
    params: [],
    hooks: {
      preUpgrade: { method: 'POST', url: 'https://echo.example.com/upgrade' },
      preUninstall: { method: 'POST', url: 'https://echo.example.com/uninstall' },
    },
    scripts: { install: '#!/bin/sh\n', upgrade: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
    sha256: { install: '0'.repeat(64), upgrade: '1'.repeat(64), uninstall: '2'.repeat(64) },
    writes: [],
    units: [{ name: 'demo-v2.service', scope: 'user' }],
    health: { type: 'http', url: 'http://127.0.0.1:8080/health', expectStatus: 200, graceSec: 15, intervalSec: 1, timeoutMs: 1000 },
  },
};

function makeOverviewResponse(catalogStatus: Record<string, unknown>) {
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
        version: '0.8.0',
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

function renderWithRouter(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <ToastContextProvider value={{ show: vi.fn() }}>{ui}</ToastContextProvider>
    ),
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

describe('InstalledAppsCard 已安装的托管应用（V4）', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('从 state 读取已装列表（不请求 recipe_installed），支持非默认实例抽屉内联卸载与列表刷新', async () => {
    let installedDetail: Record<string, unknown> = {
      'demo-v1/custom': {
        manifestId: 'demo-v1',
        instance: 'custom',
        version: '0.1.4265',
        installedAt: '2026-11-22T00:53:28Z',
        source: 'manifest',
        schema: 1,
      },
    };
    let taskPolls = 0;
    const requestedUrls: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url === '/api/v1/app-manifests') return json({ appManifests: [v1Manifest] });
        if (url === '/api/v1/nodes/hub-1/state') {
          return json(makeOverviewResponse({ installedDetail }));
        }
        if (url === '/api/v1/nodes/hub-1/overview?force=1' || url === '/api/v1/nodes/hub-1/overview') {
          return json(makeOverviewResponse({ installedDetail }));
        }
        if (url === '/api/v1/nodes/hub-1/apps/app-catalog/recipe_uninstall') {
          const parsed = JSON.parse(String(init?.body)) as { params: Record<string, unknown> };
          expect(parsed.params).toMatchObject({ manifestId: 'demo-v1', values: {} });
          expect(parsed.params).not.toHaveProperty('instance');
          return json({ ok: true, accepted: true, taskId: 'task-uninst-1' });
        }
        if (url === '/api/v1/nodes/hub-1/tasks/task-uninst-1') {
          taskPolls += 1;
          if (taskPolls < 2) {
            return json({
              task: { id: 'task-uninst-1', state: 'running', progress: 50, logs: [], result: null, error: null },
            });
          }
          installedDetail = {};
          return json({
            task: { id: 'task-uninst-1', state: 'done', progress: 100, logs: [], result: {}, error: null },
          });
        }
        return json({});
      }),
    );

    renderWithRouter(<InstalledAppsCard hubId="hub-1" pollIntervalMs={5} />);

    expect((await screen.findAllByText(/demo-v1/)).length).toBeGreaterThanOrEqual(1);
    expect(requestedUrls.some((u) => u.includes('recipe_installed'))).toBe(false);

    // 打开已装应用抽屉（v1 条目无升级/启停按钮）
    await userEvent.click(screen.getByRole('button', { name: '详情' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).queryByRole('button', { name: '重启' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: /升级到/ })).toBeNull();

    // 抽屉内行内确认卸载（不叠第二个 Dialog）
    await userEvent.click(within(drawer).getByRole('button', { name: '卸载' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const confirmBtns = within(drawer).getAllByRole('button', { name: '卸载' });
    await userEvent.click(confirmBtns[confirmBtns.length - 1]!);

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.queryByText('已安装的托管应用')).toBeNull());
    expect(taskPolls).toBeGreaterThanOrEqual(2);
  });

  it('v2 条目支持启停/重启、按需展开日志、升级与 hook 失败后强制卸载（skipHooks:true）', async () => {
    const installedDetail = {
      'demo-v2/demo-v2': {
        manifestId: 'demo-v2',
        instance: 'demo-v2',
        version: '1.0.0',
        schema: 2,
        source: 'manifest',
        mode: 'create',
        user: 'khc-app-v2',
        installedAt: '2026-11-23T00:00:00Z',
        units: [{ name: 'demo-v2.service', scope: 'user', active: 'active' }],
        lastHealth: { ok: true, checkedAt: '2026-11-23T00:00:00Z', version: '1.0.0' },
        facts: { node_id: 'ext-1' },
      },
    };
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    let logsRequested = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
        calls.push({ url, body });
        if (url === '/api/v1/app-manifests') return json({ appManifests: [v2Manifest] });
        if (url === '/api/v1/nodes/hub-1/state') return json(makeOverviewResponse({ installedDetail }));
        if (url.includes('/overview')) return json(makeOverviewResponse({ installedDetail }));
        if (url.endsWith('/manifest_control')) {
          return json({
            ok: true,
            manifestId: 'demo-v2',
            instance: 'demo-v2',
            unit: 'demo-v2.service',
            scope: 'user',
            op: (body?.params as { op?: string })?.op,
            active: true,
            state: 'active',
          });
        }
        if (url.endsWith('/manifest_logs')) {
          logsRequested += 1;
          return json({
            ok: true,
            logs: 'service started\nhealth ok\n',
            truncated: true,
            mayContainSecrets: true,
          });
        }
        if (url.endsWith('/manifest_upgrade')) {
          return json({ ok: true, taskId: 'task-upg-1' });
        }
        if (url === '/api/v1/nodes/hub-1/tasks/task-upg-1') {
          return json({
            task: { id: 'task-upg-1', state: 'done', progress: 100, logs: ['upgraded'], result: {}, error: null },
          });
        }
        if (url.endsWith('/manifest_uninstall')) {
          const skip = Boolean((body?.params as { skipHooks?: boolean })?.skipHooks);
          if (!skip) {
            return json(
              {
                error: {
                  code: 'hook_failed',
                  message: '第三方返回 503',
                  details: { stage: 'preUninstall', status: 503, error: 'busy' },
                },
              },
              502,
            );
          }
          return json({ ok: true, taskId: 'task-force-uninst' });
        }
        if (url === '/api/v1/nodes/hub-1/tasks/task-force-uninst') {
          return json({
            task: { id: 'task-force-uninst', state: 'done', progress: 100, logs: ['removed'], result: {}, error: null },
          });
        }
        return json({});
      }),
    );

    renderWithRouter(<InstalledAppsCard hubId="hub-1" pollIntervalMs={5} />);

    expect(await screen.findByText('→ 2.0.0')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '详情' }));
    const drawer = await screen.findByRole('dialog');

    // 未展开日志时不发 manifest_logs 请求
    expect(logsRequested).toBe(0);

    // 单元重启与停止（停止有行内确认）
    await userEvent.click(within(drawer).getByRole('button', { name: '重启' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/manifest_control'))).toBe(true),
    );
    const restartCall = calls.find((c) => c.url.endsWith('/manifest_control'))!;
    expect(restartCall.body?.params).toEqual({
      manifestId: 'demo-v2',
      unit: 'demo-v2.service',
      op: 'restart',
    });

    await userEvent.click(within(drawer).getByRole('button', { name: '停止' }));
    expect(await within(drawer).findByText('确认停止 demo-v2.service？')).toBeTruthy();
    await userEvent.click(within(drawer).getByRole('button', { name: '确认停止' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith('/manifest_control'))).toHaveLength(2),
    );

    // 展开日志才发 manifest_logs 请求
    await userEvent.click(within(drawer).getByRole('button', { name: '查看日志' }));
    expect(await within(drawer).findByText(/日志可能包含应用自己打印的敏感信息/)).toBeTruthy();
    expect(await within(drawer).findByText(/service started/)).toBeTruthy();
    expect(logsRequested).toBe(1);

    // 升级（带 preUpgrade 提示）
    await userEvent.click(within(drawer).getByRole('button', { name: '升级到 2.0.0' }));
    expect(await within(drawer).findByText(/将执行控制面步骤 preUpgrade/)).toBeTruthy();
    await userEvent.click(within(drawer).getByRole('button', { name: '确认升级' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/manifest_upgrade'))).toBe(true),
    );

    // 卸载遇到 hook_failed → 二次确认强制卸载带 skipHooks: true
    await userEvent.click(within(drawer).getByRole('button', { name: '卸载' }));
    const uninstBtns = within(drawer).getAllByRole('button', { name: '卸载' });
    await userEvent.click(uninstBtns[uninstBtns.length - 1]!);

    expect(
      await within(drawer).findByRole('button', { name: '跳过控制面步骤强制卸载' }),
    ).toBeTruthy();
    await userEvent.click(
      within(drawer).getByRole('button', { name: '跳过控制面步骤强制卸载' }),
    );
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.endsWith('/manifest_uninstall') &&
            (c.body?.params as { skipHooks?: boolean })?.skipHooks === true,
        ),
      ).toBe(true),
    );
  });

  it('status 为 stale 或 pending 时渲染对应状态横幅与未读取标签', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/app-manifests') return json({ appManifests: [v2Manifest] });
        if (url === '/api/v1/nodes/hub-1/state') {
          return json(
            makeOverviewResponse({
              stale: { since: 1700000000, reason: 'timeout' },
              pending: true,
              installedDetail: {
                'demo-v2/demo-v2': {
                  manifestId: 'demo-v2',
                  instance: 'demo-v2',
                  version: '1.0.0',
                  schema: 2,
                  source: 'manifest',
                },
              },
            }),
          );
        }
        return json({});
      }),
    );

    renderWithRouter(<InstalledAppsCard hubId="hub-1" pollIntervalMs={5} />);
    expect(await screen.findByText('状态可能不是最新')).toBeTruthy();
    expect(screen.getByText('状态读取中')).toBeTruthy();
    expect(screen.getAllByText('未读取').length).toBeGreaterThanOrEqual(1);
  });
});
