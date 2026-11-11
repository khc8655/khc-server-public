// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from '../../app/router';
import { makeLiveEventSource } from '../../test/liveMock';

const NOW = Math.floor(Date.now() / 1000);
const PEER_KEY = 'A'.repeat(43) + '=';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const configRecord = (rev: number, appliedRev: number, peers: unknown[]) => ({
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
    peers,
  },
  rev,
  appliedRev,
  updatedAt: NOW,
});

const peerConfig = {
  name: 'pixel-8',
  publicKey: PEER_KEY,
  privateKey: 'PRIV',
  allowedIps: ['10.99.0.2/32'],
  keepalive: 25,
  endpoint: null,
  enabled: true,
};

function wireGuardState(withPeer: boolean, rotations: unknown[] = []) {
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
          status: {
            installed: true,
            running: true,
            interface: 'wg0',
            peers: withPeer
              ? [
                  {
                    name: 'pixel-8',
                    publicKey: PEER_KEY,
                    allowedIps: ['10.99.0.2/32'],
                    enabled: true,
                    endpoint: '203.0.113.5:51820',
                    latestHandshake: NOW - 30,
                    online: true,
                    rx: 12 * 1024 * 1024,
                    tx: 4 * 1024 * 1024,
                    keepalive: 25,
                  },
                ]
              : [],
            rotations,
          },
        },
      ],
      ports: [],
    },
  };
}

const NEW_PEER_KEY = 'B'.repeat(43) + '=';

const expiredRotation = {
  peer: 'pixel-8',
  interface: 'wg0',
  state: 'expired',
  oldPublicKey: PEER_KEY,
  newPublicKey: NEW_PEER_KEY,
  allowedIps: ['10.99.0.2/32'],
  startedAt: NOW - 8 * 24 * 3600,
  cutoverAt: null,
  graceUntil: null,
  expiredAt: NOW - 24 * 3600,
  expiresAt: NOW - 24 * 3600,
  latestHandshake: 0,
  online: false,
};

function mockApi(options: {
  peers: unknown[];
  rev: number;
  appliedRev: number;
  state?: () => unknown;
}) {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  // 观测面：运行态只从浏览器直连的 state 事件读取。
  vi.stubGlobal(
    'EventSource',
    makeLiveEventSource(() => {
      const payload = options.state ? options.state() : wireGuardState(options.peers.length > 0);
      return (payload as { state?: unknown }).state ?? payload;
    }),
  );
  // 有状态配置：PUT 保存后，后续 GET 返回最新 rev/peers（模拟 D1 写后读）
  const store = {
    peers: [...options.peers],
    rev: options.rev,
    appliedRev: options.appliedRev,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url.endsWith('/apps/wireguard') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { config?: { peers?: unknown[] } };
        if (body.config?.peers) store.peers = body.config.peers;
        store.rev += 1;
        return json({ app: configRecord(store.rev, store.appliedRev, store.peers) });
      }
      if (url.endsWith('/apps/wireguard/apply')) {
        return json({ ok: true, appliedRev: options.rev + 1 });
      }
      if (url.endsWith('/apps/wireguard/cancel_rotation')) {
        return json({
          ok: true,
          peer: 'pixel-8',
          state: 'active',
          cards: [{ title: '超时轮换已清理', value: '已在面板恢复旧公钥。', copy: false }],
          client: { privateKey: 'OLDPRIVATE' },
        });
      }
      if (url.endsWith('/apps/wireguard/rotate_peer')) {
        return json({
          ok: true,
          state: 'pending',
          result: {
            cards: [
              {
                title: '客户端配置',
                value: '[Interface]\nPrivateKey = NEWPRIVATEKEY\nAddress = 10.99.0.2/32\n',
                copy: true,
              },
            ],
          },
          rotation: {
            peer: 'pixel-8',
            interface: 'wg0',
            state: 'pending',
            oldPublicKey: PEER_KEY,
            newPublicKey: 'B'.repeat(43) + '=',
            allowedIps: ['10.99.0.2/32'],
            startedAt: NOW,
            cutoverAt: null,
            graceUntil: null,
            expiresAt: NOW + 7 * 24 * 3600,
            latestHandshake: 0,
            online: false,
          },
          client: { privateKey: 'NEWPRIVATEKEY' },
        });
      }
      if (url === '/api/v1/nodes') {
        return json({
          nodes: [
            {
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
              liveEndpoint: 'https://hub.example.com',
            preferredRoute: 'direct',
            status: 'online',
            lastSeenAt: NOW,
            createdAt: 1,
            updatedAt: 2,
          },
        });
      }
      if (url.endsWith('/apps/wireguard/client_config')) {
        return json({
          ok: true,
          peer: 'pixel-8',
          result: {
            cards: [
              {
                title: '客户端配置',
                value: '[Interface]\nPrivateKey = PRIVATEKEY\nAddress = 10.99.0.2/32\n',
                copy: true,
              },
            ],
          },
          client: { privateKey: 'PRIVATEKEY' },
        });
      }
      if (url === '/api/v1/nodes/tyo-1/apps/wireguard') {
        return json({ app: configRecord(store.rev, store.appliedRev, store.peers) });
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
      if (url === '/api/v1/nodes/tyo-1/apps') {
        return json({
          apps: [
            configRecord(store.rev, store.appliedRev, store.peers),
            {
              app: 'port-forward',
              schemaVersion: 1,
              config: { forwards: [] },
              rev: 1,
              appliedRev: 1,
              updatedAt: NOW,
            },
          ],
          adapters: [
            { name: 'wireguard', version: '1.0.0', api: 1 },
            { name: 'port-forward', version: '1.0.0', api: 1 },
          ],
          adaptersError: null,
        });
      }
      if (url === '/api/v1/nodes/tyo-1/live-ticket') {
        return json({ ticket: 'test-ticket', livePath: '/_live/', expiresAt: NOW });
      }
      if (url === '/api/v1/nodes/tyo-1/state') {
        return json(options.state ? options.state() : wireGuardState(options.peers.length > 0));
      }
      return json({});
    }),
  );
  return calls;
}

beforeEach(() => {
  window.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderWireGuard(path = '/hubs/tyo-1/wireguard') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('WireGuard 页', () => {
  it('列表展示客户端、状态与未应用同步状态', async () => {
    mockApi({ peers: [peerConfig], rev: 2, appliedRev: 1 });
    await renderWireGuard();

    expect(await screen.findByRole('heading', { name: '内网穿透' })).toBeTruthy();
    expect((await screen.findAllByText('pixel-8')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('有未应用的改动').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '添加 Peer' })).toBeTruthy();
    expect(screen.getByText('最新握手')).toBeTruthy();
  });

  it('空状态显示添加客户端入口', async () => {
    mockApi({ peers: [], rev: 1, appliedRev: 1 });
    await renderWireGuard();

    expect(await screen.findByText('还没有 Peer')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '添加 Peer' }).length).toBeGreaterThan(0);
  });

  it('行内菜单可打开导出配置抽屉并展示 .conf', async () => {
    mockApi({ peers: [peerConfig], rev: 1, appliedRev: 1 });
    await renderWireGuard();
    await screen.findAllByText('pixel-8');

    await userEvent.click(screen.getAllByRole('button', { name: '更多操作' })[0] as HTMLElement);
    await userEvent.click(await screen.findByRole('menuitem', { name: '导出配置' }));

    expect(await screen.findByText('导出 Peer 配置')).toBeTruthy();
    expect(await screen.findByText(/PrivateKey = PRIVATEKEY/)).toBeTruthy();
    expect(screen.getAllByText(/请勿通过不安全渠道发送/).length).toBeGreaterThan(0);
  });

  // B-1：暂存态（有未应用的改动）导出不走 Agent，显示引导而不是「peer 不存在」。
  it('暂存态导出：不调用 Agent，展示引导与去应用入口', async () => {
    const calls = mockApi({ peers: [peerConfig], rev: 2, appliedRev: 1 });
    await renderWireGuard();
    await screen.findAllByText('pixel-8');

    await userEvent.click(screen.getAllByRole('button', { name: '更多操作' })[0] as HTMLElement);
    await userEvent.click(await screen.findByRole('menuitem', { name: '导出配置' }));

    expect(await screen.findByText('该 Peer 尚未下发到节点')).toBeTruthy();
    expect(screen.getByRole('button', { name: '去应用配置' })).toBeTruthy();
    // 不允许出现原始「peer 不存在」文案
    expect(screen.queryByText(/peer 不存在/)).toBeNull();
    // 暂存态不得触发任何 Agent 侧导出动作
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/apps/wireguard/client_config'))).toBe(false);
      expect(calls.some((call) => call.url.includes('/apps/wireguard/peer_install_script'))).toBe(
        false,
      );
    });
  });

  // B-1：已应用态导出走 Agent，正常展示 .conf（与暂存态互为对照路径）。
  it('已应用态导出：调用 Agent 拿到 .conf，不出现暂存引导', async () => {
    const calls = mockApi({ peers: [peerConfig], rev: 1, appliedRev: 1 });
    await renderWireGuard();
    await screen.findAllByText('pixel-8');

    await userEvent.click(screen.getAllByRole('button', { name: '更多操作' })[0] as HTMLElement);
    await userEvent.click(await screen.findByRole('menuitem', { name: '导出配置' }));

    expect(await screen.findByText(/PrivateKey = PRIVATEKEY/)).toBeTruthy();
    expect(screen.queryByText('该 Peer 尚未下发到节点')).toBeNull();
    expect(screen.queryByText(/peer 不存在/)).toBeNull();
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/apps/wireguard/client_config'))).toBe(true);
    });
  });

  // B-1 审计原始场景：新建 Peer 只点「保存」（未应用）→ 自动弹出的导出抽屉必须走
  // 暂存引导而不是调 Agent 报「peer 不存在」。回归点：openExport 闭包里的 unapplied
  // 是保存前的旧值，必须改读 queryClient 最新配置态。
  it('保存新 Peer 后自动打开导出：暂存引导且不调 Agent', async () => {
    const calls = mockApi({ peers: [peerConfig], rev: 1, appliedRev: 1 });
    await renderWireGuard();
    await screen.findAllByText('pixel-8');

    await userEvent.click(screen.getByRole('button', { name: '添加 Peer' }));
    const drawer = (await screen.findAllByRole('dialog')).at(-1);
    if (!drawer) throw new Error('missing peer drawer');
    await userEvent.type(within(drawer).getByLabelText('名称'), 'new-peer');
    await userEvent.click(within(drawer).getByRole('button', { name: '保存' }));

    expect(await screen.findByText('该 Peer 尚未下发到节点')).toBeTruthy();
    expect(screen.getByRole('button', { name: '去应用配置' })).toBeTruthy();
    expect(screen.queryByText(/peer 不存在/)).toBeNull();
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/apps/wireguard/client_config'))).toBe(false);
      expect(calls.some((call) => call.url.includes('/apps/wireguard/peer_install_script'))).toBe(
        false,
      );
    });
  });

  it('Peer 抽屉高级区可发起轮换密钥，确认按钮禁用', async () => {
    mockApi({ peers: [peerConfig], rev: 1, appliedRev: 1 });
    await renderWireGuard();
    await screen.findAllByText('pixel-8');

    // 行内菜单打开编辑抽屉，轮换入口收进「高级」折叠区（ui-redesign §2.4）
    await userEvent.click(screen.getAllByRole('button', { name: '更多操作' })[0] as HTMLElement);
    await userEvent.click(await screen.findByRole('menuitem', { name: '编辑' }));

    const drawer = (await screen.findAllByRole('dialog')).at(-1);
    if (!drawer) throw new Error('missing peer drawer');
    await userEvent.click(within(drawer).getByRole('button', { name: '高级' }));
    await userEvent.click(within(drawer).getByRole('button', { name: '轮换密钥' }));

    const confirmDialog = (await screen.findAllByRole('dialog')).at(-1);
    if (!confirmDialog) throw new Error('missing rotate confirm');
    expect(within(confirmDialog).getByText('轮换密钥 pixel-8？')).toBeTruthy();
    await userEvent.click(within(confirmDialog).getByRole('button', { name: '轮换密钥' }));

    expect(await screen.findByText('等待新设备握手')).toBeTruthy();
    expect(await screen.findByText(/NEWPRIVATEKEY/)).toBeTruthy();
    const confirmButton = await screen.findByRole('button', { name: '确认完成' });
    expect((confirmButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('超时轮换横幅可一键恢复旧公钥并回写仓库', async () => {
    // R2：D1 已写回新钥对（rotate 立即写回），超时后横幅提示，恢复按钮回写旧钥。
    const writtenBackPeer = { ...peerConfig, publicKey: NEW_PEER_KEY, privateKey: 'NEWPRIVATE' };
    const calls = mockApi({
      peers: [writtenBackPeer],
      rev: 2,
      appliedRev: 1,
      state: () => wireGuardState(true, [expiredRotation]),
    });
    await renderWireGuard();

    expect(await screen.findByText('换钥已超时取消')).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: '恢复旧公钥' }));

    const cancel = calls.find((call) => call.url.endsWith('/apps/wireguard/cancel_rotation'));
    expect(cancel).toBeTruthy();
    const put = calls.find((call) => call.url.endsWith('/apps/wireguard') && call.method === 'PUT');
    expect(put).toBeTruthy();
    const body = put?.body as { config?: { peers?: Array<Record<string, unknown>> } };
    const restored = body.config?.peers?.find((peer) => peer.name === 'pixel-8');
    expect(restored?.publicKey).toBe(PEER_KEY);
    expect(restored?.privateKey).toBe('OLDPRIVATE');
  });

  it('删除 Peer：确认后直接删配置，不再调用本机清理', async () => {
    const calls = mockApi({ peers: [peerConfig], rev: 1, appliedRev: 1 });
    await renderWireGuard();
    await screen.findAllByText('pixel-8');

    await userEvent.click(screen.getAllByRole('button', { name: '更多操作' })[0] as HTMLElement);
    await userEvent.click(await screen.findByRole('menuitem', { name: '删除 Peer' }));

    const confirmDialog = (await screen.findAllByRole('dialog')).at(-1);
    if (!confirmDialog) throw new Error('missing delete confirm');
    expect(within(confirmDialog).getByText('删除 Peer pixel-8？')).toBeTruthy();
    await userEvent.click(within(confirmDialog).getByRole('button', { name: '删除 Peer' }));

    expect(calls.some((call) => call.url.endsWith('/apps/host-ops/call'))).toBe(false);
    const put = calls.find((call) => call.url.endsWith('/apps/wireguard') && call.method === 'PUT');
    expect(put).toBeTruthy();
    const body = put?.body as { config?: { peers?: unknown[] } };
    expect(body.config?.peers).toEqual([]);
    expect(await screen.findByText('已删除 pixel-8')).toBeTruthy();
  });

  it('旧 /peers 暗路由 302 到内网穿透页', async () => {
    mockApi({ peers: [peerConfig], rev: 1, appliedRev: 1 });
    const router = await renderWireGuard('/hubs/tyo-1/peers');

    expect(await screen.findByRole('heading', { name: '内网穿透' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/hubs/tyo-1/wireguard');
  });
});
