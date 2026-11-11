// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

const wgConfig = {
  enabled: true,
  interface: {
    name: 'wg0',
    address: '10.99.0.1/24',
    listenPort: 51820,
    privateKey: '',
    publicKey: 'PUB',
    mtu: 1420,
    extIface: 'eth0',
    publicEndpoint: '',
    postUp: '',
    postDown: '',
  },
  peers: [
    {
      name: 'phone',
      publicKey: 'PEER',
      privateKey: '',
      allowedIps: ['10.99.0.2/32'],
      keepalive: 25,
      endpoint: null,
      enabled: true,
    },
  ],
};

let mode: 'wg' | 'caddy' | 'unknown' = 'wg';
let blockers: { code: string; message: string; fixRoute?: string }[] = [];
let warnings: { code: string; message: string }[] = [];
let wireguardRunning = true;
let applyFails = false;
let requests: { url: string; init?: RequestInit }[] = [];

function modeBody() {
  return {
    nodeId: 'tyo-1',
    mode,
    target: mode === 'wg' ? 'caddy' : mode === 'caddy' ? 'wg' : null,
    reachable: mode !== 'unknown',
    blockers,
    warnings,
    checkedAt: NOW,
  };
}

function appConfig() {
  return {
    app: 'wireguard',
    schemaVersion: 1,
    config: { ...wgConfig, enabled: mode === 'wg' },
    rev: 2,
    appliedRev: 2,
    updatedAt: NOW,
  };
}

function mockApi() {
  mode = 'wg';
  blockers = [];
  warnings = [];
  wireguardRunning = true;
  applyFails = false;
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url === '/api/v1/nodes') return json({ nodes: [node] });
      if (url === '/api/v1/nodes/tyo-1') {
        return json({
          node: {
            ...node,
            summary: {
              mode: mode === 'wg' ? 'wg' : 'caddy',
              peers: mode === 'wg' ? 1 : null,
              sites: null,
              forwards: null,
            },
          },
        });
      }
      if (url === '/api/v1/nodes/tyo-1/mode') return json(modeBody());
      if (url === '/api/v1/nodes/tyo-1/state') {
        return json({
          reachable: true,
          route: 'direct',
          via: 'tcp',
          error: null,
          state: {
            host: { hostname: 'hub-tyo' },
            adapters: [{ name: 'wireguard', version: '1.0.0', status: { running: wireguardRunning } }],
            ports: [],
          },
        });
      }
      if (url === '/api/v1/nodes/tyo-1/apps') {
        return json({
          apps: [appConfig()],
          adapters: [{ name: 'wireguard', version: '1.0.0', api: 1 }],
          adaptersError: null,
        });
      }
      if (url === '/api/v1/nodes/tyo-1/apps/wireguard') {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as { config?: Record<string, unknown> };
          const enabled = body.config?.enabled !== false;
          mode = enabled ? 'wg' : 'caddy';
          wireguardRunning = enabled;
          blockers = [];
          return json({ app: appConfig() });
        }
        return json({ app: appConfig() });
      }
      if (url.endsWith('/apps/wireguard/plan') || url.endsWith('/apps/wireguard/apply')) {
        if (applyFails) {
          return json({ ok: false, error: { code: 'MODE_APPLY_FAILED', message: '应用失败' } });
        }
        return json({ ok: true, rev: 3, appliedRev: 3 });
      }
      if (url === '/api/v1/nodes/tyo-1/apps/port-forward') {
        return json({
          app: {
            app: 'port-forward',
            schemaVersion: 1,
            config: { forwards: [] },
            rev: 1,
            appliedRev: 1,
            updatedAt: NOW,
          },
        });
      }
      if (url === '/api/v1/diagnostics/hints') return json({ hintsVersion: '2026-10-26.1', hints: [] });
      if (url.startsWith('/api/v1/nodes/tyo-1/diagnostics')) {
        return json({
          nodeId: 'tyo-1',
          generatedAt: NOW,
          durationMs: 10,
          hintsVersion: '2026-10-26.1',
          reachable: true,
          route: 'direct',
          via: 'tcp',
          checks: [],
        });
      }
      return json({});
    }),
  );
}

beforeEach(() => {
  window.scrollTo = vi.fn();
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
}

async function openModeSegment() {
  await userEvent.click(await screen.findByRole('button', { name: '节点模式' }));
}

async function openSwitchDrawer() {
  await openModeSegment();
  await userEvent.click(await screen.findByRole('button', { name: '切换到 Caddy 网关' }));
  expect(await screen.findByText('当前为组网节点')).toBeTruthy();
}

describe('节点模式 UI', () => {
  it('设置页展示 3 态徽章；blocker 禁用切换并提供修复入口', async () => {
    blockers = [
      {
        code: 'MODE_BLOCKED_CADDY_NOT_RUNNING',
        message: 'Caddy 未运行，切到网关前请先修复。',
        fixRoute: '/hubs/:hubId/sites',
      },
    ];
    await renderRoute('/hubs/tyo-1/settings');
    await openModeSegment();
    expect((await screen.findAllByText('节点模式')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('组网节点')).length).toBeGreaterThan(0);
    await openSwitchDrawer();
    expect(await screen.findByText('Caddy 未运行，切到网关前请先修复。')).toBeTruthy();
    expect(screen.getByRole('link', { name: '去处理' })).toBeTruthy();
    const confirm = screen.getByRole('button', { name: '确认切换 · Caddy 网关' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it('勾选影响摘要后一次确认即可切换成功', async () => {
    warnings = [
      {
        code: 'MODE_WARN_IMPACT',
        message: '切换后：2 个客户端会断开（其中 1 个在线）；1 条端口转发会停止。',
      },
    ];
    await renderRoute('/hubs/tyo-1/settings');
    await openSwitchDrawer();

    expect(await screen.findByText('影响摘要')).toBeTruthy();
    const confirm = screen.getByRole('button', { name: '确认切换 · Caddy 网关' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: '我已了解以上影响' }));
    expect(
      (screen.getByRole('button', { name: '确认切换 · Caddy 网关' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: '确认切换 · Caddy 网关' }));

    expect(await screen.findByText('已切换到Caddy 网关')).toBeTruthy();
    const put = requests.find(
      (item) => item.url === '/api/v1/nodes/tyo-1/apps/wireguard' && item.init?.method === 'PUT',
    );
    expect(put).toBeTruthy();
    const putBody = JSON.parse(String(put?.init?.body)) as { config: { enabled: boolean } };
    expect(putBody.config.enabled).toBe(false);
    expect(requests.some((item) => item.url.endsWith('/apps/wireguard/plan'))).toBe(true);
    expect(requests.some((item) => item.url.endsWith('/apps/wireguard/apply'))).toBe(true);
    expect(requests.some((item) => item.url === '/api/v1/nodes/tyo-1/state')).toBe(true);

    const closeButtons = screen.getAllByRole('button', { name: '关闭' });
    await userEvent.click(closeButtons[closeButtons.length - 1] as HTMLElement);
    expect((await screen.findAllByText('Caddy 网关')).length).toBeGreaterThan(0);
  });

  it('切换失败在同一屏显示错误码、重试与诊断', async () => {
    applyFails = true;
    await renderRoute('/hubs/tyo-1/settings');
    await openSwitchDrawer();
    await userEvent.click(screen.getByRole('button', { name: '确认切换 · Caddy 网关' }));

    expect(await screen.findByText('切换失败')).toBeTruthy();
    expect(await screen.findByText('错误码 MODE_APPLY_FAILED')).toBeTruthy();
    expect(screen.getByRole('link', { name: '查看诊断' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认切换 · Caddy 网关' })).toBeTruthy();
  });

  it('unknown 模式禁用切换并提示原因', async () => {
    mode = 'unknown';
    wireguardRunning = false;
    await renderRoute('/hubs/tyo-1/settings');
    await openModeSegment();
    const badges = await screen.findAllByText('未确认');
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0]?.closest('[title]')?.getAttribute('title')).toBe(
      'Agent 不可达或还没有网络配置，暂时无法切换模式。',
    );
    const button = (await screen.findByRole('button', { name: '切换到 Caddy 网关' })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('caddy 模式下 WireGuard 页只读并提示', async () => {
    mode = 'caddy';
    wireguardRunning = false;
    await renderRoute('/hubs/tyo-1/wireguard');
    expect(await screen.findByText('当前是 Caddy 网关模式，WireGuard 已停用')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '添加客户端' })).toBeNull();
    expect(screen.queryByRole('button', { name: '应用配置' })).toBeNull();
  });

  it('caddy 模式下端口转发卡提示并提供设置链接', async () => {
    mode = 'caddy';
    wireguardRunning = false;
    await renderRoute('/hubs/tyo-1/wireguard');
    expect(await screen.findByText('端口转发依赖 WireGuard，当前不可用')).toBeTruthy();
    expect(await screen.findByRole('link', { name: '去节点设置' })).toBeTruthy();
  });

  it('390 宽度下模式卡与抽屉仍可操作', async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    try {
      await renderRoute('/hubs/tyo-1/settings');
      expect(await screen.findByText('节点模式')).toBeTruthy();
      await openSwitchDrawer();
      expect(screen.getByRole('button', { name: '确认切换 · Caddy 网关' })).toBeTruthy();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
    }
  });

  it('概况页头模式徽章来自 D1 摘要，不再请求 /mode', async () => {
    mode = 'caddy';
    wireguardRunning = false;
    await renderRoute('/hubs/tyo-1');
    expect((await screen.findAllByText('Caddy 网关')).length).toBeGreaterThan(0);
    expect(requests.some((item) => item.url.endsWith('/mode'))).toBe(false);
  });
});
