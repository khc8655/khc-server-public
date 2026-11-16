// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastContextProvider } from '../../ui/primitives';
import { AppCatalog } from './AppCatalog';

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

let requests: string[] = [];

function stubApi() {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url === '/api/v1/nodes' && (!init || !init.method)) return json({ nodes: [node] });
      if (url === '/api/v1/app-manifests' && (!init || !init.method)) {
        return json({
          appManifests: [
            {
              id: 'demo-echo',
              enabled: true,
              createdAt: 1,
              updatedAt: 2,
              manifest: {
                name: '示例服务（假服务）',
                version: '1.0.0',
                runtime: { mode: 'root', linger: true },
                params: [
                  {
                    key: 'port',
                    type: 'integer',
                    label: '监听端口',
                    default: 19090,
                    min: 1024,
                    max: 65535,
                  },
                ],
                scripts: { install: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
                sha256: { install: '0'.repeat(64), uninstall: '0'.repeat(64) },
                writes: [],
              },
            },
          ],
        });
      }
      if (url === '/api/v1/nodes/tyo-1/apps/app-catalog/recipe_install') {
        return json({ ok: true, accepted: true, taskId: 'task-1', result: { taskId: 'task-1' } });
      }
      if (url === '/api/v1/nodes/tyo-1/apps/app-catalog/recipe_installed') {
        return json({
          ok: true,
          result: { installed: { 'demo-echo': { version: '1.0.0', installedAt: NOW } } },
        });
      }
      if (url === '/api/v1/nodes/tyo-1/apps/app-catalog/recipe_uninstall') {
        return json({ ok: true, accepted: true, taskId: 'task-2', result: { taskId: 'task-2' } });
      }
      if (url === '/api/v1/nodes/tyo-1/tasks/task-2') {
        return json({
          task: {
            id: 'task-2',
            state: 'running',
            progress: 10,
            logs: ['卸载 demo-echo'],
            result: {},
            error: null,
          },
        });
      }
      if (url === '/api/v1/nodes/tyo-1/tasks/task-1') {
        return json({
          task: {
            id: 'task-1',
            state: 'running',
            progress: 40,
            logs: ['安装 demo-echo'],
            result: { access: [{ label: '本地地址', value: 'http://127.0.0.1:19090/' }] },
            error: null,
          },
        });
      }
      return json({ error: { code: 'not_found', message: url } }, 404);
    }),
  );
}

function renderCatalog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastContextProvider value={{ show: vi.fn() }}>
        <AppCatalog />
      </ToastContextProvider>
    </QueryClientProvider>,
  );
}

describe('应用目录（R1 运行时清单）', () => {
  beforeEach(stubApi);
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('列出随包 recipe，安装只发 1 次安装 + 1 次任务查询', async () => {
    renderCatalog();
    expect((await screen.findAllByText(/示例服务/)).length).toBeGreaterThan(0);

    const names = await screen.findAllByText(/示例服务/);
    await userEvent.click(names.at(-1)!);
    expect(await screen.findByText('安装 示例服务（假服务）')).toBeTruthy();

    const buttons = screen.getAllByRole('button', { name: '安装' });
    await userEvent.click(buttons.at(-1)!);

    await waitFor(() => {
      expect(
        requests.filter((url) => url === '/api/v1/nodes/tyo-1/apps/app-catalog/recipe_install').length,
      ).toBe(1);
      expect(requests.filter((url) => url === '/api/v1/nodes/tyo-1/tasks/task-1').length).toBe(1);
    });
    expect(await screen.findByText(/任务状态：running/)).toBeTruthy();
    expect(await screen.findByText('http://127.0.0.1:19090/')).toBeTruthy();
  });

  it('非法参数（端口越界）时禁用安装，不发安装请求', async () => {
    renderCatalog();
    const names = await screen.findAllByText(/示例服务/);
    await userEvent.click(names[0]!);

    const port = await screen.findByLabelText('监听端口');
    await userEvent.clear(port);
    await userEvent.type(port, '80');

    expect(await screen.findByText('监听端口需在 1024–65535 之间')).toBeTruthy();
    const install = screen.getAllByRole('button', { name: '安装' }).at(-1)!;
    expect((install as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(install);
    expect(
      requests.filter((url) => url === '/api/v1/nodes/tyo-1/apps/app-catalog/recipe_install').length,
    ).toBe(0);
  });

  it('已安装列表可卸载：确认后提交 recipe_uninstall 并展示任务', async () => {
    renderCatalog();
    expect(await screen.findByText('已安装应用')).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: '卸载' }));

    const nameInput = await screen.findByLabelText('应用');
    await userEvent.type(nameInput, '示例服务（假服务）');
    await userEvent.click(screen.getAllByRole('button', { name: '卸载' }).at(-1)!);

    await waitFor(() => {
      expect(
        requests.filter(
          (url) => url === '/api/v1/nodes/tyo-1/apps/app-catalog/recipe_uninstall',
        ).length,
      ).toBe(1);
      expect(requests.filter((url) => url === '/api/v1/nodes/tyo-1/tasks/task-2').length).toBe(1);
    });
    expect(await screen.findByText(/任务状态：running/)).toBeTruthy();
  });

  it('运行身份选「新建应用用户」时要求填用户名和密码，提交带上凭据', async () => {
    renderCatalog();
    const names = await screen.findAllByText(/示例服务/);
    await userEvent.click(names.at(-1)!);
    expect(await screen.findByLabelText('运行身份')).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText('运行身份'), 'create');
    expect(await screen.findByLabelText('用户名')).toBeTruthy();
    expect(screen.getByLabelText('密码')).toBeTruthy();

    await userEvent.type(screen.getByLabelText('用户名'), 'khc-app-new');
    await userEvent.type(screen.getByLabelText('密码'), 's3cret');
    await userEvent.click(screen.getAllByRole('button', { name: '安装' }).at(-1)!);

    await waitFor(() => {
      expect(
        requests.filter((url) => url === '/api/v1/nodes/tyo-1/apps/app-catalog/recipe_install').length,
      ).toBe(1);
    });
    const sent = JSON.parse(
      (vi.mocked(fetch).mock.calls as Array<[string, RequestInit | undefined]>)
        .find(([url]) => url === '/api/v1/nodes/tyo-1/apps/app-catalog/recipe_install')?.[1]
        ?.body as string,
    );
    expect(sent.params.runtimeMode).toBe('create');
    expect(sent.params.runtimeUser).toBe('khc-app-new');
    expect(sent.params.runtimePassword).toBe('s3cret');
  });

  it('运行身份选「以 root 运行」时显示警示，提交 runtimeMode=root 且不带凭据', async () => {
    renderCatalog();
    const names = await screen.findAllByText(/示例服务/);
    await userEvent.click(names.at(-1)!);
    const select = (await screen.findByLabelText('运行身份')) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['create', 'root']);
    await userEvent.selectOptions(select, 'root');
    expect(await screen.findByText('脚本将以 root 执行')).toBeTruthy();
    expect(screen.queryByLabelText('密码')).toBeNull();

    await userEvent.click(screen.getAllByRole('button', { name: '安装' }).at(-1)!);
    await waitFor(() => {
      expect(
        requests.filter((url) => url === '/api/v1/nodes/tyo-1/apps/app-catalog/recipe_install').length,
      ).toBe(1);
    });
    const sent = JSON.parse(
      (vi.mocked(fetch).mock.calls as Array<[string, RequestInit | undefined]>)
        .find(([url]) => url === '/api/v1/nodes/tyo-1/apps/app-catalog/recipe_install')?.[1]
        ?.body as string,
    );
    expect(sent.params.runtimeMode).toBe('root');
    expect(sent.params.runtimeUser).toBeUndefined();
    expect(sent.params.runtimePassword).toBeUndefined();
  });

  it('旧 Agent 返回 recipe 清单错误时显示升级引导而不是原始报错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        if (url === '/api/v1/nodes') return json({ nodes: [node] });
        if (url.endsWith('/recipe_installed')) {
          return json(
            {
              error: {
                code: 'recipe_error',
                message: 'recipe 清单不存在或不是 JSON 对象: /opt/khc-agent/recipes/catalog.json',
              },
            },
            400,
          );
        }
        return json({ ok: true, result: {} });
      }),
    );
    renderCatalog();
    expect(await screen.findByText(/升级节点 Agent/)).toBeTruthy();
    expect(screen.queryByText(/清单不存在/)).toBeNull();
  });
});
