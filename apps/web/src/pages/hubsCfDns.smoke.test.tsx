// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from '../app/router';

/**
 * 添加节点：接入方式统一表单（AccessForm）。
 * - 域名：可选已有解析记录，也可直接手填域名（无 DNS 账户时唯一路径）；本表单不代建 DNS；
 * - Tunnel：选择全局隧道配置，空态给出设置链接；
 * - IP：必须确认明文风险，payload 自动生成 http endpoint；
 * - 创建后「我已完成安装」触发探活，失败时给出 3 条排查提示。
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SHA = '0123456789abcdef'.repeat(4);

const newNode = {
  id: 'node-9',
  name: 'node-9',
  endpoint: 'http://198.51.100.20:8880',
  tunnelEndpoint: null,
  liveEndpoint: null,
  preferredRoute: 'direct',
  accessMode: 'ip',
  tunnelId: null,
  allowInsecure: true,
  status: 'offline',
  lastSeenAt: null,
  domain: null,
  createdAt: 1,
  updatedAt: 1,
};

let zones: Array<{ id: string; name: string; accountId: string; accountName: string }> = [];
let records: Array<{
  id: string;
  type: 'A' | 'AAAA' | 'CNAME';
  name: string;
  content: string;
  proxied: boolean;
  comment: null;
  managed: boolean;
}> = [];
let tunnels: Array<{
  id: string;
  name: string;
  hostname: string;
  originPort: number;
  hasToken: boolean;
  createdAt: number;
  updatedAt: number;
}> = [];
let probeReachable = false;
/** 控制面 TLS 探测结果：一键发布用它判断「HTTPS 是否已生效」。 */
let tlsVerified = false;
/** 站点配置写入后的 sites（断言自动发布确实建了 tls=auto 的反代站点）。 */
let savedSites: Array<Record<string, unknown>> = [];
/** 模拟 apply 失败：验证一键发布会把站点配置回滚。 */
let applyFails = false;
/** 安装完成检查只看 Caddy；默认已就绪。 */
let caddyInstalled = true;
let accounts: Array<{
  id: string;
  name: string;
  accountName: string | null;
  hasToken: boolean;
  enabled: boolean;
  zones: Array<{ id: string; name: string }>;
  enabledZoneIds: string[];
}> = [];
let resolveCheckOk = true;
let requests: { url: string; init?: RequestInit }[] = [];

function mockApi() {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url === '/api/v1/tunnels') return json({ tunnels });
      if (url === '/api/v1/nodes') {
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          return json({ token: 'one-time-token', node: { ...newNode, ...body } });
        }
        return json({ nodes: [] });
      }
      if (url === '/api/v1/nodes/probe') {
        return json({
          probedAt: 1,
          nodes: [
            {
              id: 'node-9',
              reachable: probeReachable,
              route: 'direct',
              via: 'fetch',
              error: probeReachable ? null : 'connect timeout',
              lastSeenAt: null,
            },
          ],
        });
      }
      if (url === '/api/v1/cf-dns/zones') return json({ zones });
      if (url === '/api/v1/cf-dns/accounts') return json({ accounts });
      if (url.startsWith('/api/v1/cf-dns/accounts/') && init?.method === 'PUT') {
        // 就地「添加域名」= 把该 Zone 加进 enabledZoneIds，并让 Zone 列表立即可见。
        const body = JSON.parse(String(init.body)) as { enabledZoneIds?: string[] };
        const account = accounts[0]!;
        account.enabledZoneIds = body.enabledZoneIds ?? account.enabledZoneIds;
        zones = account.zones
          .filter((zone) => account.enabledZoneIds.includes(zone.id))
          .map((zone) => ({ ...zone, accountId: account.id, accountName: account.name }));
        return json({ account });
      }
      if (/^\/api\/v1\/cf-dns\/records\/[^/]+$/.test(url) && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          type: 'A' | 'AAAA' | 'CNAME';
          name: string;
          content: string;
          proxied?: boolean;
        };
        const created = {
          id: `rec-created-${records.length + 1}`,
          type: body.type,
          name: body.name,
          content: body.content,
          proxied: Boolean(body.proxied),
          comment: null,
          managed: true,
        };
        records = [created, ...records];
        return json({ record: created }, 201);
      }
      if (url === '/api/v1/cf-dns/resolve-check' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          name: string;
          type?: 'A' | 'AAAA' | 'CNAME';
        };
        return json({
          name: body.name,
          type: body.type ?? 'A',
          resolved: resolveCheckOk,
          answers: resolveCheckOk ? ['203.0.113.10'] : [],
          status: resolveCheckOk ? 0 : 3,
          checkedAt: 1700000000,
        });
      }
      if (url.startsWith('/api/v1/cf-dns/records')) {
        if (init?.method === 'POST') {
          return json(
            {
              created: true,
              record: {
                id: 'rec-9',
                type: 'A',
                name: 'node-9.example.com.',
                content: '198.51.100.20',
              },
              domain: 'node-9.example.com',
            },
            201,
          );
        }
        return json({ zoneId: 'z1', zoneName: 'example.com', records });
      }
      if (url === '/api/v1/nodes/node-9/state') {
        return json({
          reachable: true,
          route: 'direct',
          via: 'fetch',
          error: null,
          tls: { state: tlsVerified ? 'verified' : 'unknown', endpoint: 'https://x', detail: null, checkedAt: 1 },
          state: {
            host: { hostname: 'node-9' },
            adapters: [
              {
                name: 'caddy-site',
                version: '1.0.0',
                status: { installed: caddyInstalled, running: caddyInstalled },
              },
            ],
            ports: [],
          },
        });
      }
      if (url === '/api/v1/nodes/node-9/apps/caddy-site') {
        if (init?.method === 'PUT') {
          const payload = JSON.parse(String(init.body)) as { config: { sites: unknown[] } };
          savedSites = payload.config.sites as Array<Record<string, unknown>>;
          return json({
            app: {
              app: 'caddy-site',
              schemaVersion: 1,
              config: payload.config,
              rev: 2,
              appliedRev: 1,
              updatedAt: 1,
            },
          });
        }
        return json({
          app: {
            app: 'caddy-site',
            schemaVersion: 1,
            config: { sites: [] },
            rev: 1,
            appliedRev: 1,
            updatedAt: 1,
          },
        });
      }
      if (url === '/api/v1/nodes/node-9/apps/caddy-site/apply') {
        if (applyFails) return json({ error: { code: 'apply_failed', message: 'caddy reload 失败' } }, 500);
        return json({ ok: true, result: {} });
      }
      if (url === '/api/v1/agent/releases') {
        return json({
          releases: [{ version: '0.1.4', url: 'https://example.com/agent.pyz', sha256: SHA }],
        });
      }
      if (url === '/api/v1/nodes/node-9/agent/install-command') {
        return json({
          command: 'curl … | python3',
          mode: 'system',
          packageUrl: 'https://example.com/agent.pyz',
          sha256: SHA,
        });
      }
      return json({});
    }),
  );
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  zones = [];
  records = [];
  tunnels = [];
  accounts = [];
  resolveCheckOk = true;
  probeReachable = false;
  caddyInstalled = true;
  tlsVerified = false;
  savedSites = [];
  applyFails = false;
  mockApi();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderHubs() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: ['/hubs'] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: '节点' });
  return router;
}

async function openCreateDrawer() {
  const buttons = await screen.findAllByRole('button', { name: '添加节点' });
  await userEvent.click(buttons[0]!);
  await screen.findByRole('dialog');
}

async function submitCreate() {
  const dialog = screen.getByRole('dialog');
  await userEvent.click(within(dialog).getByRole('button', { name: '添加节点' }));
}

describe('添加节点：统一接入表单', () => {
  it('Tunnel 空态：给出「设置 · 隧道」链接，保存禁用', async () => {
    await renderHubs();
    await openCreateDrawer();
    await userEvent.type(screen.getByLabelText('节点名称'), 'node-9');
    await userEvent.click(screen.getByRole('button', { name: 'Tunnel' }));

    expect(await screen.findByText('还没有隧道配置')).toBeTruthy();
    const link = screen.getByRole('link', { name: '去设置添加隧道' });
    expect(link.getAttribute('href')).toBe('/settings?tab=tunnels');
    expect(
      (within(screen.getByRole('dialog')).getByRole('button', { name: '添加节点' }) as
        | HTMLButtonElement
        | undefined)?.disabled,
    ).toBe(true);
  });

  it('域名模式：只选已有记录，创建 payload 为 domain 且不代建 DNS', async () => {
    zones = [{ id: 'z1', name: 'example.com', accountId: 'acc-1', accountName: '主账号' }];
    records = [
      {
        id: 'rec-1',
        type: 'A',
        name: 'manual.example.com',
        content: '198.51.100.20',
        proxied: false,
        comment: null,
        managed: false,
      },
    ];
    await renderHubs();
    await openCreateDrawer();

    await userEvent.type(screen.getByLabelText('节点名称'), 'node-9');
    await userEvent.click(screen.getByRole('button', { name: '域名（HTTPS）' }));
    await userEvent.selectOptions(await screen.findByLabelText('Zone'), 'z1');
    await userEvent.selectOptions(await screen.findByLabelText('已有解析记录'), 'rec-1');

    expect((screen.getByLabelText('Agent 监听端口') as HTMLSelectElement).value).toBe('2053');
    expect(
      (screen.getByLabelText('Agent 接入地址（自动生成）') as HTMLInputElement).value,
    ).toBe('https://manual.example.com:2053');

    await submitCreate();
    await screen.findByText('节点已创建');
    const post = requests.find(
      (item) => item.url === '/api/v1/nodes' && item.init?.method === 'POST',
    );
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      name: 'node-9',
      accessMode: 'domain',
      endpoint: 'https://manual.example.com:2053',
      domain: 'manual.example.com',
    });
    expect(
      requests.some(
        (item) => item.url.startsWith('/api/v1/cf-dns/records') && item.init?.method === 'POST',
      ),
    ).toBe(false);

    await waitFor(() => {
      const install = requests.find(
        (item) =>
          item.url === '/api/v1/nodes/node-9/agent/install-command' && item.init?.method === 'POST',
      );
      expect(install).toBeTruthy();
      expect(JSON.parse(String(install?.init?.body))).toMatchObject({
        mode: 'system',
        installOptions: { withCaddy: true },
      });
    });
  });

  it('域名模式：没有 DNS 账户时直接手填域名，仍可建节点', async () => {
    // zones 默认为空 = 未配置任何 DNS 账户（非 Cloudflare 用户的真实状态）。
    await renderHubs();
    await openCreateDrawer();

    await userEvent.type(screen.getByLabelText('节点名称'), 'node-9');
    await userEvent.click(screen.getByRole('button', { name: '域名（HTTPS）' }));

    expect(await screen.findByText('没有 DNS 账户，可直接手填域名')).toBeTruthy();
    // 没有账户时不出现「选择 / 手填」的开关，只有一条明确的输入路径。
    expect(screen.queryByRole('button', { name: '已有解析记录' })).toBeNull();

    await userEvent.type(await screen.findByLabelText('域名'), 'app.other.net');
    expect((screen.getByLabelText('Agent 接入地址（自动生成）') as HTMLInputElement).value).toBe(
      'https://app.other.net:2053',
    );

    await submitCreate();
    await screen.findByText('节点已创建');
    const post = requests.find(
      (item) => item.url === '/api/v1/nodes' && item.init?.method === 'POST',
    );
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      name: 'node-9',
      accessMode: 'domain',
      endpoint: 'https://app.other.net:2053',
      domain: 'app.other.net',
    });
    // 手填域名不产生任何 DNS 写入。
    expect(
      requests.some(
        (item) => item.url.startsWith('/api/v1/cf-dns/records') && item.init?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('域名模式：有账户时可切到手动输入，端口沿用所选值', async () => {
    zones = [{ id: 'z1', name: 'example.com', accountId: 'acc-1', accountName: '主账号' }];
    records = [
      {
        id: 'rec-1',
        type: 'A',
        name: 'manual.example.com',
        content: '198.51.100.20',
        proxied: false,
        comment: null,
        managed: false,
      },
    ];
    await renderHubs();
    await openCreateDrawer();

    await userEvent.type(screen.getByLabelText('节点名称'), 'node-9');
    await userEvent.click(screen.getByRole('button', { name: '域名（HTTPS）' }));
    // 有账户时默认「已有解析记录」，可显式切到手填。
    await userEvent.click(await screen.findByRole('button', { name: '手动输入域名' }));
    await userEvent.type(await screen.findByLabelText('域名'), 'custom.example.org');
    await userEvent.selectOptions(screen.getByLabelText('Agent 监听端口'), '8443');

    expect((screen.getByLabelText('Agent 接入地址（自动生成）') as HTMLInputElement).value).toBe(
      'https://custom.example.org:8443',
    );

    await submitCreate();
    await screen.findByText('节点已创建');
    const post = requests.find(
      (item) => item.url === '/api/v1/nodes' && item.init?.method === 'POST',
    );
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      accessMode: 'domain',
      endpoint: 'https://custom.example.org:8443',
      domain: 'custom.example.org',
    });
  });

  it('域名模式：有账户但没启用域名时跳转「设置 → 账号」并支持刷新选中，切换来源清理旧域名', async () => {
    accounts = [
      {
        id: 'acc-1',
        name: '主账号',
        accountName: null,
        hasToken: true,
        enabled: true,
        zones: [{ id: 'z1', name: 'example.com' }],
        enabledZoneIds: [],
      },
    ];
    records = [
      {
        id: 'rec-1',
        type: 'A',
        name: 'app.example.com',
        content: '198.51.100.20',
        proxied: false,
        comment: null,
        managed: false,
      },
    ];
    await renderHubs();
    await openCreateDrawer();

    await userEvent.type(screen.getByLabelText('节点名称'), 'node-9');
    await userEvent.click(screen.getByRole('button', { name: '域名（HTTPS）' }));

    expect(await screen.findByText('已有 DNS 账户，但还没有启用的域名')).toBeTruthy();
    const accountsLink = screen.getByRole('link', { name: /前往设置 → 账号/ });
    expect(accountsLink.getAttribute('href')).toBe('/settings?tab=accounts');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    // 模拟在设置启用域名后点「刷新域名」
    accounts[0]!.enabledZoneIds = ['z1'];
    zones = [{ id: 'z1', name: 'example.com', accountId: 'acc-1', accountName: '主账号' }];
    await userEvent.click(screen.getByRole('button', { name: '刷新域名' }));

    await userEvent.selectOptions(await screen.findByLabelText('Zone'), 'z1');
    expect((screen.getByLabelText('Zone') as HTMLSelectElement).value).toBe('z1');
    // 从手动域名切回「已有解析记录」应清掉手填域名，不串台
    await userEvent.click(screen.getByRole('button', { name: '手动输入域名' }));
    await userEvent.type(await screen.findByLabelText('域名'), 'stale.other.net');
    const sourceGroup = screen.getByRole('group', { name: '域名来源' });
    await userEvent.click(within(sourceGroup).getByRole('button', { name: '已有解析记录' }));
    expect(screen.queryByDisplayValue('stale.other.net')).toBeNull();

    await userEvent.selectOptions(await screen.findByLabelText('已有解析记录'), 'rec-1');
    expect((screen.getByLabelText('Agent 接入地址（自动生成）') as HTMLInputElement).value).toBe(
      'https://app.example.com:2053',
    );

    await submitCreate();
    await screen.findByText('节点已创建');
    const post = requests.find(
      (item) => item.url === '/api/v1/nodes' && item.init?.method === 'POST',
    );
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      accessMode: 'domain',
      endpoint: 'https://app.example.com:2053',
      domain: 'app.example.com',
    });
  });

  it('域名模式：有账户但域名下没有记录时，一键改为手动输入', async () => {
    accounts = [
      {
        id: 'acc-1',
        name: '主账号',
        accountName: null,
        hasToken: true,
        enabled: true,
        zones: [{ id: 'z1', name: 'example.com' }],
        enabledZoneIds: ['z1'],
      },
    ];
    zones = [{ id: 'z1', name: 'example.com', accountId: 'acc-1', accountName: '主账号' }];
    await renderHubs();
    await openCreateDrawer();

    await userEvent.type(screen.getByLabelText('节点名称'), 'node-9');
    await userEvent.click(screen.getByRole('button', { name: '域名（HTTPS）' }));
    await userEvent.selectOptions(await screen.findByLabelText('Zone'), 'z1');

    // 该 Zone 没有 A/AAAA 记录：不让人卡在这里，直接给切换到手动输入的入口
    expect(await screen.findByText(/该 Zone 下还没有可用的 A\/AAAA 记录/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '改为手动输入域名' }));
    await userEvent.type(await screen.findByLabelText('域名'), 'app.elsewhere.net');

    await submitCreate();
    await screen.findByText('节点已创建');
    const post = requests.find(
      (item) => item.url === '/api/v1/nodes' && item.init?.method === 'POST',
    );
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      accessMode: 'domain',
      domain: 'app.elsewhere.net',
    });
  });

  it('一键发布：在线且 Caddy 就绪后自动建 tls=auto 站点并 apply', async () => {
    zones = [{ id: 'z1', name: 'example.com', accountId: 'acc-1', accountName: '主账号' }];
    records = [
      {
        id: 'rec-1',
        type: 'A',
        name: 'app.example.com',
        content: '198.51.100.20',
        proxied: false,
        comment: null,
        managed: false,
      },
    ];
    probeReachable = true;
    tlsVerified = true;
    await renderHubs();
    await openCreateDrawer();

    await userEvent.type(screen.getByLabelText('节点名称'), 'node-9');
    await userEvent.click(screen.getByRole('button', { name: '域名（HTTPS）' }));
    await userEvent.selectOptions(await screen.findByLabelText('Zone'), 'z1');
    await userEvent.selectOptions(await screen.findByLabelText('已有解析记录'), 'rec-1');
    // 勾选自动发布：默认发布端口 2083 与 Agent 的 2053 不撞，不会出现冲突提示
    await userEvent.click(screen.getByRole('checkbox', { name: /安装完成后自动发布 HTTPS/ }));
    expect(screen.queryByText('发布端口和 Agent 监听端口撞了')).toBeNull();
    expect((screen.getByLabelText('发布端口') as HTMLSelectElement).value).toBe('2083');
    const upstream = screen.getByLabelText('上游端口');
    await userEvent.clear(upstream);
    await userEvent.type(upstream, '8080');

    await submitCreate();
    await screen.findByText('节点已创建');
    await userEvent.click(await screen.findByRole('button', { name: '我已完成安装' }));

    // 站点写入 → apply → 控制面确认 HTTPS
    await waitFor(() => {
      expect(savedSites).toHaveLength(1);
      expect(savedSites[0]).toMatchObject({
        name: 'app.example.com',
        kind: 'proxy',
        domains: ['app.example.com'],
        upstreams: ['127.0.0.1:8080'],
        listenPort: 2083,
        tls: { mode: 'auto' },
      });
    });
    await waitFor(() => {
      expect(
        requests.some(
          (item) =>
            item.url === '/api/v1/nodes/node-9/apps/caddy-site/apply' && item.init?.method === 'POST',
        ),
      ).toBe(true);
    });
    expect(await screen.findByText('站点已应用')).toBeTruthy();
    // 完成提示里给的是发布地址（带发布端口），不是节点接入地址
    expect(
      screen.getByText(/打开 https:\/\/app\.example\.com:2083 应能访问/),
    ).toBeTruthy();
  });

  it('一键发布失败：apply 报错时回滚站点配置，不留半套站点', async () => {
    zones = [{ id: 'z1', name: 'example.com', accountId: 'acc-1', accountName: '主账号' }];
    records = [
      {
        id: 'rec-1',
        type: 'A',
        name: 'app.example.com',
        content: '198.51.100.20',
        proxied: false,
        comment: null,
        managed: false,
      },
    ];
    probeReachable = true;
    applyFails = true;
    await renderHubs();
    await openCreateDrawer();

    await userEvent.type(screen.getByLabelText('节点名称'), 'node-9');
    await userEvent.click(screen.getByRole('button', { name: '域名（HTTPS）' }));
    await userEvent.selectOptions(await screen.findByLabelText('Zone'), 'z1');
    await userEvent.selectOptions(await screen.findByLabelText('已有解析记录'), 'rec-1');
    await userEvent.click(screen.getByRole('checkbox', { name: /安装完成后自动发布 HTTPS/ }));

    await submitCreate();
    await screen.findByText('节点已创建');
    await userEvent.click(await screen.findByRole('button', { name: '我已完成安装' }));

    // 报错里明确「已回滚」，且最终落库的站点配置回到空
    expect(await screen.findByText(/已回滚到发布前的站点配置/)).toBeTruthy();
    await waitFor(() => {
      expect(savedSites).toEqual([]);
    });
  });

  it('一键发布：发布端口与 Agent 端口撞了时挡住提交，并给换端口的出口', async () => {
    zones = [{ id: 'z1', name: 'example.com', accountId: 'acc-1', accountName: '主账号' }];
    records = [
      {
        id: 'rec-1',
        type: 'A',
        name: 'app.example.com',
        content: '198.51.100.20',
        proxied: false,
        comment: null,
        managed: false,
      },
    ];
    await renderHubs();
    await openCreateDrawer();

    await userEvent.type(screen.getByLabelText('节点名称'), 'node-9');
    await userEvent.click(screen.getByRole('button', { name: '域名（HTTPS）' }));
    await userEvent.selectOptions(await screen.findByLabelText('Zone'), 'z1');
    await userEvent.selectOptions(await screen.findByLabelText('已有解析记录'), 'rec-1');
    await userEvent.click(screen.getByRole('checkbox', { name: /安装完成后自动发布 HTTPS/ }));

    const save = () =>
      within(screen.getByRole('dialog')).getByRole('button', {
        name: '添加节点',
      }) as HTMLButtonElement;
    expect(save().disabled).toBe(false);

    // 手动把发布端口挑成 Agent 正在用的那条：一条端口只能一个进程，必须挡住
    await userEvent.selectOptions(screen.getByLabelText('发布端口'), '2053');
    expect(save().disabled).toBe(true);
    expect(screen.getByText('发布端口和 Agent 监听端口撞了')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '改用 2083' }));
    expect(save().disabled).toBe(false);
    expect((screen.getByLabelText('发布端口') as HTMLSelectElement).value).toBe('2083');
    expect(screen.queryByText('发布端口和 Agent 监听端口撞了')).toBeNull();
  });

  it('Tunnel 模式：选择全局配置，payload 只带 tunnelId', async () => {
    tunnels = [
      {
        id: 't1',
        name: '家庭出口',
        hostname: 'agent.example.com',
        originPort: 8880,
        hasToken: true,
        createdAt: 1,
        updatedAt: 2,
      },
    ];
    await renderHubs();
    await openCreateDrawer();

    await userEvent.type(screen.getByLabelText('节点名称'), 'node-9');
    await userEvent.click(screen.getByRole('button', { name: 'Tunnel' }));
    await userEvent.selectOptions(await screen.findByLabelText('隧道配置'), 't1');

    expect((screen.getByLabelText('对外地址（自动生成）') as HTMLInputElement).value).toBe(
      'https://agent.example.com',
    );
    expect((screen.getByLabelText('源站端口') as HTMLInputElement).value).toBe('8880');

    await submitCreate();
    await screen.findByText('节点已创建');
    const post = requests.find(
      (item) => item.url === '/api/v1/nodes' && item.init?.method === 'POST',
    );
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      name: 'node-9',
      accessMode: 'tunnel',
      tunnelId: 't1',
    });
    expect(screen.getByText('Tunnel')).toBeTruthy();
  });

  it('IP 直连：未确认明文风险时保存禁用，确认后创建 http endpoint', async () => {
    await renderHubs();
    await openCreateDrawer();

    await userEvent.type(screen.getByLabelText('节点名称'), 'node-9');
    await userEvent.click(screen.getByRole('button', { name: 'IP 直连' }));
    await userEvent.type(screen.getByLabelText('主机 / IP'), '198.51.100.20');

    const save = () =>
      within(screen.getByRole('dialog')).getByRole('button', {
        name: '添加节点',
      }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);

    await userEvent.click(
      screen.getByRole('checkbox', { name: /我确认这是明文 HTTP/ }),
    );
    expect(save().disabled).toBe(false);

    await submitCreate();
    await screen.findByText('节点已创建');
    const post = requests.find(
      (item) => item.url === '/api/v1/nodes' && item.init?.method === 'POST',
    );
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      name: 'node-9',
      accessMode: 'ip',
      endpoint: 'http://198.51.100.20:8880',
      allowInsecure: true,
    });

    // 默认「不自动创建」：IP 节点创建后不得调用 DNS 代建端点。
    expect(
      requests.some(
        (item) => item.url.startsWith('/api/v1/cf-dns/records') && item.init?.method === 'POST',
      ),
    ).toBe(false);
  });

  it('IP 直连：显式选择 Zone 后才代建 DNS，payload 带 zoneId', async () => {
    zones = [{ id: 'z1', name: 'example.com', accountId: 'acc-1', accountName: '主账号' }];
    await renderHubs();
    await openCreateDrawer();

    await userEvent.type(screen.getByLabelText('节点名称'), 'node-9');
    await userEvent.click(screen.getByRole('button', { name: 'IP 直连' }));
    await userEvent.type(screen.getByLabelText('主机 / IP'), '198.51.100.20');
    await userEvent.click(screen.getByRole('checkbox', { name: /我确认这是明文 HTTP/ }));
    await userEvent.selectOptions(
      await screen.findByLabelText('自动创建 DNS 记录（可选）'),
      'z1',
    );
    await submitCreate();

    await screen.findByText('节点已创建');
    await waitFor(() => {
      const dns = requests.find(
        (item) => item.url === '/api/v1/cf-dns/records' && item.init?.method === 'POST',
      );
      expect(dns).toBeTruthy();
      expect(JSON.parse(String(dns?.init?.body))).toEqual({ nodeId: 'node-9', zoneId: 'z1' });
    });
  });

  it('我已完成安装：探活在线时只检查 Agent 与 Caddy', async () => {
    probeReachable = true;
    caddyInstalled = false;
    await renderHubs();
    await openCreateDrawer();

    await userEvent.type(screen.getByLabelText('节点名称'), 'node-9');
    await userEvent.click(screen.getByRole('button', { name: 'IP 直连' }));
    await userEvent.type(screen.getByLabelText('主机 / IP'), '198.51.100.20');
    await userEvent.click(screen.getByRole('checkbox', { name: /我确认这是明文 HTTP/ }));
    await submitCreate();

    await screen.findByText('节点已创建');
    await userEvent.click(await screen.findByRole('button', { name: '我已完成安装' }));

    expect(await screen.findByText('节点在线，接入已验证')).toBeTruthy();
    expect(screen.getByText('Agent 在线')).toBeTruthy();
    expect(screen.getByText('Caddy 未安装')).toBeTruthy();
    // 安装完成检查只有 Agent 与 Caddy 两项，其他模块按需安装、不参与检查。
    const checkRow = screen.getByText('Agent 在线').parentElement;
    expect(checkRow?.children).toHaveLength(2);
    expect(checkRow?.textContent).toContain('Caddy 未安装');
    expect(checkRow?.textContent).not.toContain('WireGuard');
    expect(checkRow?.textContent).not.toContain('端口转发');
  });

  it('我已完成安装：Caddy 已安装且运行 → 「Caddy 已就绪」', async () => {
    probeReachable = true;
    caddyInstalled = true;
    await renderHubs();
    await openCreateDrawer();

    await userEvent.type(screen.getByLabelText('节点名称'), 'node-9');
    await userEvent.click(screen.getByRole('button', { name: 'IP 直连' }));
    await userEvent.type(screen.getByLabelText('主机 / IP'), '198.51.100.20');
    await userEvent.click(screen.getByRole('checkbox', { name: /我确认这是明文 HTTP/ }));
    await submitCreate();

    await screen.findByText('节点已创建');
    await userEvent.click(await screen.findByRole('button', { name: '我已完成安装' }));

    expect(await screen.findByText('Caddy 已就绪')).toBeTruthy();
    expect(screen.getByText('Agent 在线')).toBeTruthy();
  });

  it('我已完成安装：探活离线时展示 3 条失败原因提示，抽屉保持打开', async () => {
    probeReachable = false;
    await renderHubs();
    await openCreateDrawer();

    await userEvent.type(screen.getByLabelText('节点名称'), 'node-9');
    await userEvent.click(screen.getByRole('button', { name: 'IP 直连' }));
    await userEvent.type(screen.getByLabelText('主机 / IP'), '198.51.100.20');
    await userEvent.click(
      screen.getByRole('checkbox', { name: /我确认这是明文 HTTP/ }),
    );
    await submitCreate();

    await screen.findByText('节点已创建');
    await userEvent.click(await screen.findByRole('button', { name: '我已完成安装' }));

    expect(await screen.findByText('暂未探测到节点')).toBeTruthy();
    expect(screen.getByText('DNS 记录尚未生效，或证书尚未签发（域名模式）')).toBeTruthy();
    expect(screen.getByText('cloudflared / 隧道尚未启动（Tunnel 模式）')).toBeTruthy();
    expect(screen.getByText('防火墙未放行端口（IP 直连）')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('域名模式：就地新建解析记录、检测 DoH 解析生效、创建后直达「去发布应用」', async () => {
    zones = [{ id: 'z1', name: 'example.com', accountId: 'acc-1', accountName: '主账号' }];
    const router = await renderHubs();
    await openCreateDrawer();

    await userEvent.type(screen.getByLabelText('节点名称'), 'edge-node');
    await userEvent.selectOptions(await screen.findByLabelText('Zone'), 'z1');
    await userEvent.click(await screen.findByRole('button', { name: '+ 新建解析记录' }));

    const dialog = screen.getByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText(/记录名/), 'edge');
    await userEvent.type(within(dialog).getByLabelText(/内容/), '203.0.113.10');
    await userEvent.click(within(dialog).getByRole('button', { name: '创建并选中' }));

    await waitFor(() => {
      const createdReq = requests.find(
        (item) => item.url === '/api/v1/cf-dns/records/z1' && item.init?.method === 'POST',
      );
      expect(createdReq).toBeTruthy();
      expect(JSON.parse(String(createdReq?.init?.body))).toEqual({
        type: 'A',
        name: 'edge.example.com',
        content: '203.0.113.10',
        proxied: false,
      });
    });

    await waitFor(() => {
      const preview = within(dialog).getByLabelText('Agent 接入地址（自动生成）') as HTMLInputElement;
      expect(preview.value).toBe('https://edge.example.com:2053');
    });

    await userEvent.click(within(dialog).getByRole('button', { name: '检测解析' }));
    expect(await within(dialog).findByText('解析已生效（203.0.113.10）')).toBeTruthy();

    await submitCreate();
    await screen.findByText('节点已创建');
    await userEvent.click(await screen.findByRole('button', { name: '去发布应用' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/hubs/node-9/sites');
    });
  });
});
