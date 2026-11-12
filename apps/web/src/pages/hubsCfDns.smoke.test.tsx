// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from '../app/router';

/**
 * 添加节点：接入方式统一表单（AccessForm）。
 * - 域名：只选已有解析记录，不代建 DNS；
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
  probeReachable = false;
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

    expect((screen.getByLabelText('HTTPS 端口') as HTMLSelectElement).value).toBe('443');
    expect(
      (screen.getByLabelText('接入地址（自动生成）') as HTMLInputElement).value,
    ).toBe('https://manual.example.com');

    await submitCreate();
    await screen.findByText('节点已创建');
    const post = requests.find(
      (item) => item.url === '/api/v1/nodes' && item.init?.method === 'POST',
    );
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      name: 'node-9',
      accessMode: 'domain',
      endpoint: 'https://manual.example.com',
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

    // DNS 代建：IP 节点创建后自动调用代建端点（域名模式不调用，见上一个用例）。
    await waitFor(() => {
      const dns = requests.find(
        (item) => item.url === '/api/v1/cf-dns/records' && item.init?.method === 'POST',
      );
      expect(dns).toBeTruthy();
      expect(JSON.parse(String(dns?.init?.body))).toEqual({ nodeId: 'node-9' });
    });
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
});
