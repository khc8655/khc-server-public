// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from '../../app/router';

const NOW = Math.floor(Date.now() / 1000);
const SHA = 'b'.repeat(64);
const URL = 'https://example.com/khc-agent-0.2.0.tar.gz';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let nodeStatus: 'online' | 'offline' = 'online';
let commandFails = false;
let requests: { url: string; init?: RequestInit }[] = [];

const node = {
  id: 'tyo-1',
  name: 'tyo-1',
  endpoint: 'https://203.0.113.10:8880',
  tunnelEndpoint: null,
  liveEndpoint: null,
  preferredRoute: 'direct',
  status: nodeStatus,
  lastSeenAt: NOW - 60,
  createdAt: 1,
  updatedAt: 2,
};

const mode = {
  nodeId: 'tyo-1',
  mode: 'wg',
  state: 'wg',
  desired: { wireguardEnabled: true },
  effective: {
    reachable: true,
    wireguardRunning: true,
    caddyActive: true,
    caddyValidateOk: true,
    appliedRev: 1,
  },
  counts: { peers: 0, enabledPeers: 0, forwards: 0, sites: 0, wgDependentSites: 0 },
  blockers: [],
  warnings: [],
  checkedAt: NOW,
};

function mockApi() {
  nodeStatus = 'online';
  commandFails = false;
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url === '/api/v1/nodes') return json({ nodes: [{ ...node, status: nodeStatus }] });
      if (url === '/api/v1/nodes/tyo-1') return json({ node: { ...node, status: nodeStatus } });
      if (url === '/api/v1/nodes/tyo-1/mode') return json(mode);
      if (url === '/api/v1/nodes/tyo-1/state') {
        return json({
          reachable: nodeStatus === 'online',
          route: 'direct',
          via: 'tcp',
          error: null,
          state: {
            host: { hostname: 'hub-tyo' },
            adapters: [],
            ports: [],
            agent: { version: '1.2.3', serverTime: NOW, mode: 'wg' },
          },
        });
      }
      if (url === '/api/v1/nodes/tyo-1/apps') {
        return json({ apps: [], adapters: [], adaptersError: null });
      }
      if (url === '/api/v1/agent/releases') {
        return json({ releases: [{ version: '0.2.0', url: URL, sha256: SHA }] });
      }
      if (url.endsWith('/agent/upgrade')) {
        return json({ ok: true, accepted: true, fromVersion: '0.1.4', targetVersion: '0.2.0' }, 202);
      }
      if (url.endsWith('/agent/install-command') || url.endsWith('/agent/upgrade-command') || url.endsWith('/agent/uninstall-command')) {
        if (commandFails) return json({ error: { code: 'agent_command_failed', message: '无法生成命令' } }, 500);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const kind = url.includes('uninstall') ? 'uninstall' : url.includes('upgrade') ? 'upgrade' : 'install';
        return json({
          command: `#!/bin/bash\n# ${kind}\n${String(body.packageUrl)}`,
          mode: body.mode ?? (kind === 'uninstall' ? undefined : 'system'),
          packageUrl: body.packageUrl,
          sha256: body.sha256,
        });
      }
      return json({});
    }),
  );
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
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

async function openInstall() {
  await userEvent.click(await screen.findByRole('button', { name: '安装 Agent' }));
  expect(await screen.findByRole('dialog')).toBeTruthy();
}

function fillPackage(url = URL, sha = SHA) {
  fireEvent.change(screen.getByLabelText('安装包地址'), { target: { value: url } });
  fireEvent.change(screen.getByLabelText('sha256'), { target: { value: sha } });
}

describe('Agent 命令 UI', () => {
  it('展示 Agent 版本/运行模式/最后在线并生成复制命令', async () => {
    await renderRoute('/hubs/tyo-1/settings');
    expect(await screen.findByText('Agent')).toBeTruthy();
    expect(await screen.findByText('v1.2.3')).toBeTruthy();
    expect((await screen.findAllByText('组网节点')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/最后在线/)).length).toBeGreaterThan(0);

    await openInstall();
    fillPackage();
    await userEvent.click(screen.getByRole('button', { name: '生成命令' }));
    const command = await screen.findByText(/khc-agent-0\.2\.0\.tar\.gz/);
    expect(command).toBeTruthy();
    expect(screen.getByText(/命令不包含节点令牌/)).toBeTruthy();
    const drawer = screen.getAllByRole('dialog').at(-1);
    if (!drawer) throw new Error('missing agent drawer');
    await userEvent.click(within(drawer).getByRole('button', { name: '复制' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());

    const post = requests.find((item) => item.url.endsWith('/agent/install-command'));
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      mode: 'system',
      packageUrl: URL,
      sha256: SHA,
    });
  });

  it('本地校验 URL 与 sha256 错误', async () => {
    await renderRoute('/hubs/tyo-1/settings');
    await openInstall();
    fillPackage('http://example.com/a.tgz', 'bad');
    await userEvent.click(screen.getByRole('button', { name: '生成命令' }));
    expect(await screen.findByText(/必须是 https/)).toBeTruthy();
    expect(await screen.findByText(/64 位十六进制/)).toBeTruthy();
    expect(requests.some((item) => item.url.endsWith('/agent/install-command'))).toBe(false);
  });

  it('卸载命令免填包信息，带 purge；升级命令带 user 模式', async () => {
    await renderRoute('/hubs/tyo-1/settings');
    await userEvent.click(await screen.findByRole('button', { name: '卸载 Agent' }));
    const drawer = (await screen.findAllByRole('dialog')).at(-1);
    if (!drawer) throw new Error('missing uninstall drawer');
    // 用户不知道包地址/sha256：卸载抽屉不再展示这两个字段。
    expect(within(drawer).queryByLabelText('安装包地址')).toBeNull();
    expect(within(drawer).queryByLabelText('sha256')).toBeNull();
    await userEvent.click(screen.getByRole('switch', { name: '同时删除配置与数据' }));
    await userEvent.click(screen.getByRole('button', { name: '生成命令' }));
    await waitFor(() => {
      expect(requests.some((item) => item.url.endsWith('/agent/uninstall-command'))).toBe(true);
    });
    const uninstall = requests.find((item) => item.url.endsWith('/agent/uninstall-command'));
    expect(JSON.parse(String(uninstall?.init?.body))).toMatchObject({ mode: 'system', purge: true });
    expect(JSON.parse(String(uninstall?.init?.body))).not.toHaveProperty('packageUrl');
    expect(within(drawer).getByText('运行模式')).toBeTruthy();
  });

  it('命令生成失败显示错误', async () => {
    commandFails = true;
    await renderRoute('/hubs/tyo-1/settings');
    await openInstall();
    fillPackage();
    await userEvent.click(screen.getByRole('button', { name: '生成命令' }));
    expect(await screen.findByText(/无法生成命令/)).toBeTruthy();
  });

  it('节点离线时仍可生成安装/卸载命令，远程升级禁用', async () => {
    nodeStatus = 'offline';
    await renderRoute('/hubs/tyo-1/settings');
    const install = (await screen.findByRole('button', { name: '安装 Agent' })) as HTMLButtonElement;
    await waitFor(() => expect(screen.getAllByText('节点离线').length).toBeGreaterThan(0));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '远程升级' }) as HTMLButtonElement).disabled).toBe(true),
    );
    expect((screen.getByRole('button', { name: '安装 Agent' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: '卸载 Agent' }) as HTMLButtonElement).disabled).toBe(false);
    expect((await screen.findAllByText('节点离线')).length).toBeGreaterThan(0);
  });

  it('远程升级：展示发布清单并 L3 确认后下发 upgrade 接口', async () => {
    await renderRoute('/hubs/tyo-1/settings');
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '远程升级' }) as HTMLButtonElement).disabled).toBe(false),
    );
    const upgrade = screen.getByRole('button', { name: '远程升级' });
    await userEvent.click(upgrade);
    const drawer = (await screen.findAllByRole('dialog')).at(-1);
    if (!drawer) throw new Error('missing upgrade drawer');
    expect(within(drawer).getByText('0.2.0')).toBeTruthy();
    // ui-guidelines §8.3：先关闭抽屉，再在页面级 ConfirmAction 做 L3 确认
    await userEvent.click(within(drawer).getByRole('button', { name: '下发升级' }));
    const input = await screen.findByLabelText(/输入版本号/);
    await userEvent.type(input, '0.2.0');
    await userEvent.click(screen.getByRole('button', { name: '下发升级' }));
    await waitFor(() => {
      expect(requests.some((item) => item.url.endsWith('/agent/upgrade'))).toBe(true);
    });
    const posted = requests.find((item) => item.url.endsWith('/agent/upgrade'));
    expect(JSON.parse(String(posted?.init?.body))).toMatchObject({ packageUrl: URL, sha256: SHA });
    expect((await screen.findAllByText(/升级指令已下发/)).length).toBeGreaterThan(0);
  });

  it('390 宽度下 Agent 卡与抽屉可用', async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    try {
      await renderRoute('/hubs/tyo-1/settings');
      await openInstall();
      expect(await screen.findByRole('dialog')).toBeTruthy();
      expect(await screen.findByRole('button', { name: '生成命令' })).toBeTruthy();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
    }
  });
});
