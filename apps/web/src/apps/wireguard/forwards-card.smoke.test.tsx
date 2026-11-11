// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from '../../app/router';
import { makeLiveEventSource } from '../../test/liveMock';

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
  liveEndpoint: 'https://hub.example.com',
  preferredRoute: 'direct',
  status: 'online',
  lastSeenAt: NOW,
  createdAt: 1,
  updatedAt: 2,
};

function state(empty = false) {
  return {
    reachable: true,
    route: 'direct',
    via: 'fetch',
    error: null,
    state: {
      host: { hostname: 'hub' },
      adapters: [
        {
          name: 'wireguard',
          version: '1.0.0',
          appliedRev: 1,
          status: { installed: true, running: true, interface: 'wg0', peers: [], rotations: [] },
        },
        {
          name: 'port-forward',
          version: '1.0.0',
          status: {
            installed: true,
            running: true,
            socatVersion: '1.8.0.0',
            forwards: empty
              ? []
              : [
                  { name: 'ssh', protocol: 'tcp', listenPort: 7001, active: true, enabled: true },
                  {
                    name: 'dns',
                    protocol: 'udp',
                    listenPort: 5300,
                    active: false,
                    enabled: true,
                    error: 'unit failed',
                  },
                ],
          },
        },
      ],
      ports: [],
    },
  };
}

function app(empty = false, applied = true) {
  const forwards = empty
    ? []
    : [
        {
          name: 'ssh',
          protocol: 'tcp',
          listenPort: 7001,
          targetHost: '10.99.0.2',
          targetPort: 22,
          enabled: true,
          note: '手机 SSH',
        },
        {
          name: 'dns',
          protocol: 'udp',
          listenPort: 5300,
          targetHost: '10.99.0.2',
          targetPort: 53,
          enabled: true,
          note: '',
        },
        {
          name: 'legacy',
          protocol: 'tcp',
          listenPort: 9000,
          targetHost: '10.99.0.9',
          targetPort: 9000,
          enabled: false,
          note: 'old',
        },
        {
          name: 'pending',
          protocol: 'tcp',
          listenPort: 9100,
          targetHost: '10.99.0.10',
          targetPort: 9100,
          enabled: true,
          note: 'new',
        },
      ];
  return {
    app: 'port-forward',
    schemaVersion: 1,
    config: { forwards },
    rev: applied ? 1 : 2,
    appliedRev: 1,
    updatedAt: NOW,
  };
}

const wireguardApp = {
  app: 'wireguard',
  schemaVersion: 1,
  config: {
    interface: {
      name: 'wg0',
      address: '10.99.0.1/24',
      listenPort: 51820,
      privateKey: '',
      publicKey: 'SERVERPUBLICKEY',
      mtu: 1420,
      extIface: 'eth0',
      publicEndpoint: 'vpn.example.dev:51820',
      postUp: '',
      postDown: '',
    },
    peers: [
      {
        name: 'pixel-8',
        publicKey: 'A'.repeat(43) + '=',
        privateKey: 'PRIV',
        allowedIps: ['10.99.0.2/32'],
        keepalive: 25,
        endpoint: null,
        enabled: true,
      },
    ],
  },
  rev: 1,
  appliedRev: 1,
  updatedAt: NOW,
};

let emptyMode = false;
let applyFails = false;
let currentApp = app();
let requests: { url: string; init?: RequestInit }[] = [];

function mockApi() {
  emptyMode = false;
  applyFails = false;
  currentApp = app();
  requests = [];
  vi.stubGlobal('EventSource', makeLiveEventSource(() => state(emptyMode).state));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url === '/api/v1/nodes') return json({ nodes: [node] });
      if (url === '/api/v1/nodes/tyo-1') return json({ node });
      if (url === '/api/v1/nodes/tyo-1/live-ticket') {
        return json({ ticket: 'test-ticket', livePath: '/_live/', expiresAt: NOW });
      }
      if (url === '/api/v1/nodes/tyo-1/mode') {
        return json({
          nodeId: 'tyo-1',
          mode: 'wg',
          target: 'caddy',
          reachable: true,
          blockers: [],
          warnings: [],
          checkedAt: NOW,
        });
      }
      if (url === '/api/v1/nodes/tyo-1/state') return json(state(emptyMode));
      if (url === '/api/v1/nodes/tyo-1/apps') {
        return json({
          apps: [wireguardApp, currentApp],
          adapters: [
            { name: 'wireguard', version: '1.0.0', api: 1 },
            { name: 'port-forward', version: '1.0.0', api: 1 },
          ],
          adaptersError: null,
        });
      }
      if (url === '/api/v1/nodes/tyo-1/apps/wireguard') return json({ app: wireguardApp });
      if (url === '/api/v1/nodes/tyo-1/apps/port-forward') {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as { config?: Record<string, unknown> };
          currentApp = {
            ...currentApp,
            config: (body.config ?? currentApp.config) as unknown as typeof currentApp.config,
            rev: currentApp.rev + 1,
            updatedAt: NOW,
          };
          return json({ app: currentApp });
        }
        return json({ app: currentApp });
      }
      if (url.endsWith('/apps/port-forward/plan')) {
        if (applyFails) {
          return json({
            ok: false,
            error: {
              code: 'validation_failed',
              message: '监听端口冲突',
              details: { listenPort: 7001 },
            },
          });
        }
        return json({ ok: true, rev: currentApp.rev });
      }
      if (url.endsWith('/apps/port-forward/apply')) {
        return json({ ok: true, rev: currentApp.rev, appliedRev: currentApp.rev });
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

async function renderWireGuard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: ['/hubs/tyo-1/wireguard'] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('内网穿透页 · 端口转发卡', () => {
  it('卡内展示转发列表与四种状态', async () => {
    await renderWireGuard();
    expect(await screen.findByRole('heading', { name: '内网穿透' })).toBeTruthy();
    expect(await screen.findByText('端口转发')).toBeTruthy();
    expect((await screen.findAllByText('ssh')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('10.99.0.2:22')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('生效')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('失败')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('停用')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('待应用')).length).toBeGreaterThan(0);
  });

  it('空状态显示添加入口', async () => {
    emptyMode = true;
    currentApp = app(true);
    await renderWireGuard();
    expect(await screen.findByText('还没有转发规则')).toBeTruthy();
    expect((await screen.findAllByRole('button', { name: '添加转发' })).length).toBeGreaterThan(0);
  });

  it('添加转发并保存生效：PUT 后 plan/apply', async () => {
    await renderWireGuard();
    await userEvent.click((await screen.findAllByRole('button', { name: '添加转发' }))[0] as HTMLElement);

    const drawer = (await screen.findAllByRole('dialog')).at(-1);
    if (!drawer) throw new Error('missing forward drawer');
    fireEvent.change(within(drawer).getByLabelText('名称'), { target: { value: 'web' } });
    fireEvent.change(within(drawer).getByLabelText('对外端口'), { target: { value: '8080' } });
    fireEvent.change(within(drawer).getByLabelText('目标主机'), { target: { value: '10.99.0.3' } });
    fireEvent.change(within(drawer).getByLabelText('目标端口'), { target: { value: '80' } });
    await userEvent.click(within(drawer).getByRole('button', { name: '保存并生效' }));

    const dialogs = await screen.findAllByRole('dialog');
    const confirm = dialogs.find((dialog) => dialog.textContent?.includes('应用转发配置？'));
    if (!confirm) throw new Error('missing apply confirm');
    await userEvent.click(within(confirm).getByRole('button', { name: '保存并生效' }));

    await waitFor(() => {
      expect(requests.some((item) => item.url.endsWith('/plan'))).toBe(true);
      expect(requests.some((item) => item.url.endsWith('/apply'))).toBe(true);
    });
    const put = requests.find(
      (item) => item.url === '/api/v1/nodes/tyo-1/apps/port-forward' && item.init?.method === 'PUT',
    );
    expect(put).toBeTruthy();
    const body = JSON.parse(String(put?.init?.body)) as {
      config: { forwards: { name: string; listenPort: number; targetHost: string }[] };
    };
    expect(body.config.forwards.some((item) => item.name === 'web')).toBe(true);
    expect(body.config.forwards.find((item) => item.name === 'web')?.listenPort).toBe(8080);
  });

  it('目标来源选择「自定义」后可编辑目标主机', async () => {
    await renderWireGuard();
    await userEvent.click((await screen.findAllByText('ssh'))[0] as HTMLElement);

    const drawer = (await screen.findAllByRole('dialog')).at(-1);
    if (!drawer) throw new Error('missing forward drawer');
    fireEvent.change(within(drawer).getByLabelText(/目标来源/), { target: { value: 'custom' } });

    const target = await within(drawer).findByLabelText('目标主机');
    expect(target.tagName).toBe('INPUT');
    expect((target as HTMLInputElement).value).toBe('10.99.0.2');
  });

  it('应用失败展示 error.details', async () => {
    applyFails = true;
    currentApp = app(false, false);
    await renderWireGuard();
    await userEvent.click((await screen.findAllByRole('button', { name: '保存并生效' }))[0] as HTMLElement);

    const dialogs = await screen.findAllByRole('dialog');
    const confirm = dialogs.find((dialog) => dialog.textContent?.includes('应用转发配置？'));
    if (!confirm) throw new Error('missing apply confirm');
    await userEvent.click(within(confirm).getByRole('button', { name: '保存并生效' }));

    expect((await screen.findAllByText('应用错误详情')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('监听端口冲突')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/"listenPort": 7001/)).length).toBeGreaterThan(0);
  });
});
