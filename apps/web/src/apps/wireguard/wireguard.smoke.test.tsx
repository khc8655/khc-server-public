// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from '../../app/router';

const NOW = Math.floor(Date.now() / 1000);
const PEER_KEY = 'A'.repeat(43) + '=';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const DEFAULT_ENDPOINT = 'vpn.example.dev:51820';

const configRecord = (
  rev: number,
  appliedRev: number,
  peers: unknown[],
  publicEndpoint: string = DEFAULT_ENDPOINT,
) => ({
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
      publicEndpoint,
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
  /** 是否已保存 WireGuard 面板配置（false 时模拟未纳管状态）。 */
  configExists?: boolean;
  /** 接口公网地址；空串用于验证「没填公网地址时导出只给引导，不打 Agent」。 */
  publicEndpoint?: string;
  mode?: 'wg' | 'caddy';
}) {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
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
        return json({
          app: configRecord(store.rev, store.appliedRev, store.peers, options.publicEndpoint),
        });
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
        if (options.configExists === false) return json({ app: null });
        return json({
          app: configRecord(store.rev, store.appliedRev, store.peers, options.publicEndpoint),
        });
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
        const mode = options.mode ?? 'wg';
        return json({
          nodeId: 'tyo-1',
          mode,
          target: mode === 'wg' ? 'caddy' : 'wg',
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
      if (url === '/api/v1/nodes/tyo-1/overview') {
        const statePayload = (options.state ? options.state() : wireGuardState(options.peers.length > 0)) as Record<string, unknown>;
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
          ...statePayload,
          overview: {
            apps: { online: 0, total: 0, issues: [], staticCount: 0, redirectCount: 0, items: [] },
            peers: { enabled: false, online: 0, total: 0, offline: [], interfaceName: null, listenPort: null, items: [] },
            forwards: { total: 0, tcpCount: 0, udpCount: 0, items: [] },
            certs: { count: 0, soonestDaysLeft: null, expiring: [] },
            accessCert: { daysLeft: null, tlsState: 'none' },
            host: null,
            managedServices: [],
            failedUnits: null,
          },
        });
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

    expect(await screen.findByRole('heading', { name: '网络' })).toBeTruthy();
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

  it('wireguard-tools 未安装：中性说明，不是告警横幅', async () => {
    mockApi({
      peers: [],
      rev: 1,
      appliedRev: 1,
      state: () => {
        const base = wireGuardState(false);
        return {
          ...base,
          state: {
            ...base.state,
            adapters: [
              {
                name: 'wireguard',
                version: '1.0.0',
                appliedRev: 1,
                status: { installed: false, running: false, interface: 'wg0', peers: [], rotations: [] },
              },
            ],
          },
        };
      },
    });
    await renderWireGuard();

    const title = await screen.findByText('节点上尚未安装 WireGuard');
    const banner = title.closest('.ui-banner');
    expect(banner?.className).toContain('ui-banner-neutral');
    expect(banner?.className).not.toContain('ui-banner-warn');
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

  // 2026-11-20 走查：没填公网地址时导出必然失败，先把原因摆出来，不要等 Agent 报原始错误。
  it('缺公网地址时导出：只给引导，不调用 Agent 生成配置', async () => {
    const calls = mockApi({ peers: [peerConfig], rev: 1, appliedRev: 1, publicEndpoint: '' });
    await renderWireGuard();
    await screen.findAllByText('pixel-8');

    await userEvent.click(screen.getAllByRole('button', { name: '更多操作' })[0] as HTMLElement);
    await userEvent.click(await screen.findByRole('menuitem', { name: '导出配置' }));

    expect(await screen.findByText(/还没有填公网地址/)).toBeTruthy();
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes('/apps/wireguard/client_config'))).toBe(false);
    });
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

  it('新建 Peer 默认「仅 Hub」：可达范围与出网方式都是安全值', async () => {
    mockApi({ peers: [peerConfig], rev: 1, appliedRev: 1 });
    await renderWireGuard();
    await screen.findAllByText('pixel-8');

    await userEvent.click(screen.getByRole('button', { name: '添加 Peer' }));
    const drawer = (await screen.findAllByRole('dialog')).at(-1);
    if (!drawer) throw new Error('missing peer drawer');

    // 默认必须是仅 Hub（新建 Peer 不该被动看到别人），出网保持原状
    expect((within(drawer).getByLabelText('可达范围') as HTMLSelectElement).value).toBe('hub');
    expect((within(drawer).getByLabelText('出网方式') as HTMLSelectElement).value).toBe('internal');
  });

  it('「全部流量走 Hub」置灰不可选（出网问题未解决前不开放）', async () => {
    // 2026-11-16 真机验证：经 Hub 出网不通，根因未定位。
    // 留一个坏选项比没有更糟 —— 置灰并给出原因，而不是让用户踩到断网。
    mockApi({ peers: [peerConfig], rev: 1, appliedRev: 1 });
    await renderWireGuard();
    await screen.findAllByText('pixel-8');

    await userEvent.click(screen.getByRole('button', { name: '添加 Peer' }));
    const drawer = (await screen.findAllByRole('dialog')).at(-1);
    if (!drawer) throw new Error('missing peer drawer');

    const select = within(drawer).getByLabelText('出网方式') as HTMLSelectElement;
    const option = Array.from(select.options).find((item) => item.value === 'all');
    expect(option).toBeTruthy();
    expect(option?.disabled).toBe(true);
    expect(option?.textContent).toContain('暂不可用');

    // 选中被禁用的选项不会改变值，也不会弹确认框
    await userEvent.selectOptions(select, 'all');
    expect(select.value).toBe('internal');
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

  it('旧 /peers 暗路由 302 到网络页', async () => {
    mockApi({ peers: [peerConfig], rev: 1, appliedRev: 1 });
    const router = await renderWireGuard('/hubs/tyo-1/peers');

    expect(await screen.findByRole('heading', { name: '网络' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/hubs/tyo-1/wireguard');
  });

  it('未启用 WG 且无 Peer 时（caddy 模式）：页面不出现任何 Peer/WireGuard 文案，仍保留端口转发卡', async () => {
    mockApi({ peers: [], rev: 1, appliedRev: 1, mode: 'caddy' });
    const { container } = await (async () => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const router = createAppRouter(
        queryClient,
        createMemoryHistory({ initialEntries: ['/hubs/tyo-1/wireguard'] }),
      );
      const utils = render(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      return utils;
    })();
    expect(await screen.findByRole('heading', { name: '网络' })).toBeTruthy();
    expect(await screen.findByText('端口转发')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '添加 Peer' })).toBeNull();
    const content = container.querySelector('.ui-hub-content')?.textContent ?? '';
    expect(content).not.toMatch(/peer/i);
    expect(content).not.toMatch(/wireguard/i);
  });

  it('节点已有运行中 WireGuard 但面板未配置时：展示未纳管标题，且等待配置加载不闪烁', async () => {
    mockApi({ peers: [], rev: 1, appliedRev: 1, configExists: false });
    await renderWireGuard();

    expect(await screen.findByText('面板尚未纳管节点上的 WireGuard')).toBeTruthy();
    expect(screen.getByText(/节点上已有运行中的 WireGuard 接口/)).toBeTruthy();
  });

  it('0-Peer 且公网地址为空时不再误报「公网地址未配置」，改为引导切换 Caddy 网关（P3）', async () => {
    mockApi({ peers: [], rev: 1, appliedRev: 1, publicEndpoint: '', mode: 'wg' });
    await renderWireGuard();

    expect(await screen.findByText('当前尚未接入任何 Peer')).toBeTruthy();
    expect(screen.getByRole('link', { name: '切换为 Caddy 网关' }).getAttribute('href')).toBe(
      '/hubs/tyo-1/settings',
    );
    expect(screen.queryByText('公网地址未配置')).toBeNull();
  });

  it('编辑 Peer 可达范围并保存后重新打开，回显仍保持已保存策略（不回退「Hub + 所有 Peer」）', async () => {
    const calls = mockApi({ peers: [peerConfig], rev: 1, appliedRev: 1 });
    await renderWireGuard();
    await screen.findAllByText('pixel-8');

    await userEvent.click(screen.getAllByRole('button', { name: '更多操作' })[0] as HTMLElement);
    await userEvent.click(await screen.findByRole('menuitem', { name: '编辑' }));

    const drawer = (await screen.findAllByRole('dialog')).at(-1);
    if (!drawer) throw new Error('missing peer drawer');
    const reachSelect = within(drawer).getByLabelText('可达范围') as HTMLSelectElement;
    expect(reachSelect.value).toBe('all');

    await userEvent.selectOptions(reachSelect, 'hub');
    await userEvent.click(within(drawer).getByRole('button', { name: '保存' }));

    await waitFor(() => {
      const put = calls.find((call) => call.url.endsWith('/apps/wireguard') && call.method === 'PUT');
      expect(put).toBeTruthy();
      const body = put?.body as { config?: { peers?: Array<Record<string, unknown>> } };
      expect(body.config?.peers?.[0]?.reach).toBe('hub');
    });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await userEvent.click(screen.getAllByRole('button', { name: '更多操作' })[0] as HTMLElement);
    await userEvent.click(await screen.findByRole('menuitem', { name: '编辑' }));
    const reopened = (await screen.findAllByRole('dialog')).at(-1);
    if (!reopened) throw new Error('missing reopened peer drawer');
    expect((within(reopened).getByLabelText('可达范围') as HTMLSelectElement).value).toBe('hub');
  });
});
