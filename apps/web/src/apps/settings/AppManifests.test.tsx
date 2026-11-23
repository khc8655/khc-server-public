// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import { ToastContextProvider } from '../../ui/primitives';
import { AppManifests } from './AppManifests';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const manifest = {
  name: '示例应用',
  version: '1.2.3',
  runtime: { mode: 'root', linger: true },
  params: [],
  scripts: { install: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
  sha256: { install: '0'.repeat(64), uninstall: '0'.repeat(64) },
  writes: [],
};

const v2Manifest = {
  schema: 2,
  name: '动态应用',
  version: '2.1.0',
  runtime: { mode: 'create', user: 'khc-app-dyn', linger: true },
  secrets: [
    { name: 'api_token', label: '接口密钥', hint: '用于预检请求' },
  ],
  hooks: {
    preInstall: {
      method: 'POST',
      url: 'https://hook.example.com/register',
      headers: { Authorization: 'Bearer {{secret.api_token}}' },
      extract: { token: '/token' },
    },
  },
  sources: [
    { host: 'hook.example.com', purpose: '注册实例', pinned: false },
    { host: 'releases.example.com', purpose: '二进制下载', pinned: true },
  ],
  params: [],
  scripts: { install: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
  sha256: { install: '0'.repeat(64), uninstall: '0'.repeat(64) },
  writes: [],
};

function renderPage(initialSearch = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <ToastContextProvider value={{ show: vi.fn() }}>
        <AppManifests />
      </ToastContextProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [`/${initialSearch}`] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('应用管理（V4）', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('空清单显示引导，并提供添加入口', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ appManifests: [] })));
    renderPage();
    expect(await screen.findByText('还没有应用')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '添加应用' }).length).toBeGreaterThan(0);
    expect(screen.getByText(/不需要发布新版 Agent/)).toBeTruthy();
  });

  it('清单运行时读取，展示 id / 版本 / 运行用户 / v2 与动态脚本徽章', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return json({
          appManifests: [
            { id: 'demo-app', manifest, enabled: true, createdAt: 1, updatedAt: 2 },
            { id: 'dyn-app', manifest: v2Manifest, enabled: true, createdAt: 1, updatedAt: 2 },
          ],
        });
      }),
    );
    renderPage();
    expect(await screen.findByText('demo-app')).toBeTruthy();
    expect(screen.getByText('dyn-app')).toBeTruthy();
    expect(screen.getByText('1.2.3')).toBeTruthy();
    expect(screen.getByText('root')).toBeTruthy();
    expect(screen.getByText('v2')).toBeTruthy();
    expect(screen.getByText('动态脚本')).toBeTruthy();
    expect(calls).toContain('/api/v1/app-manifests');
  });

  it('编辑抽屉分三区（凭据设置与删除不含值回显 / 控制面步骤 / 外部来源），保存展示 warnings[]', async () => {
    window.scrollTo = vi.fn();
    let putSecretBody: Record<string, unknown> | null = null;
    let deletedSecretUrl: string | null = null;
    let putManifestCalled = false;
    let configured = false;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/v1/app-manifests') {
          return json({
            appManifests: [{ id: 'dyn-app', manifest: v2Manifest, enabled: true, createdAt: 1, updatedAt: 2 }],
          });
        }
        if (url === '/api/v1/app-manifests/dyn-app/secrets') {
          return json({
            secrets: [
              {
                name: 'api_token',
                label: '接口密钥',
                hint: '用于预检请求',
                configured,
                allowHosts: configured ? ['hook.example.com'] : [],
                updatedAt: configured ? 1_700_000_000 : null,
              },
            ],
          });
        }
        if (url.startsWith('/api/v1/settings/')) {
          if (init?.method === 'PUT') {
            putSecretBody = JSON.parse(String(init.body)) as Record<string, unknown>;
            configured = true;
            return json({
              setting: {
                key: 'app.dyn-app.api_token',
                value: { allowHosts: ['hook.example.com'] },
                updatedAt: 1_700_000_000,
              },
            });
          }
          if (init?.method === 'DELETE') {
            deletedSecretUrl = url;
            configured = false;
            return json({ ok: true });
          }
        }
        if (url === '/api/v1/app-manifests/dyn-app' && init?.method === 'PUT') {
          putManifestCalled = true;
          return json({
            appManifest: { id: 'dyn-app', manifest: v2Manifest, enabled: true, createdAt: 1, updatedAt: 2 },
            warnings: ['脚本包含外部下载来源，请确认已开启凭据主机白名单'],
          });
        }
        return json({});
      }),
    );

    renderPage();
    expect(await screen.findByText('dyn-app')).toBeTruthy();
    await userEvent.click(screen.getAllByText('动态应用')[0]!);

    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('凭据')).toBeTruthy();
    expect(within(drawer).getByText('控制面步骤')).toBeTruthy();
    expect(within(drawer).getByText('外部来源')).toBeTruthy();
    expect(within(drawer).getByText('preInstall · POST · hook.example.com')).toBeTruthy();
    expect(within(drawer).getByText('动态')).toBeTruthy();
    expect(within(drawer).getByText('固定')).toBeTruthy();

    // 设置凭据：带 allowHosts 建议，提交保存后不回显明文
    await userEvent.click(within(drawer).getByRole('button', { name: '设置' }));
    const valInput = within(drawer).getByLabelText(/凭据值/) as HTMLInputElement;
    const hostsInput = within(drawer).getByLabelText(/允许主机/) as HTMLInputElement;
    expect(hostsInput.value).toBe('hook.example.com');
    await userEvent.type(valInput, 'sec-xyz-123');
    await userEvent.click(within(drawer).getByRole('button', { name: '保存凭据' }));

    expect(await within(drawer).findByText('已配置')).toBeTruthy();
    expect(putSecretBody).toEqual({
      value: { value: 'sec-xyz-123', allowHosts: ['hook.example.com'] },
    });
    expect(within(drawer).queryByDisplayValue('sec-xyz-123')).toBeNull();

    // 行内删除凭据
    await userEvent.click(within(drawer).getByRole('button', { name: '删除' }));
    await userEvent.click(within(drawer).getByRole('button', { name: '确认删除' }));
    expect(await within(drawer).findByText('未配置')).toBeTruthy();
    expect(deletedSecretUrl).toBe('/api/v1/settings/app.dyn-app.api_token');

    // 保存清单并展示 warnings[]
    await userEvent.click(within(drawer).getByRole('button', { name: '保存' }));
    expect(putManifestCalled).toBe(true);
    expect(await within(drawer).findByText(/脚本包含外部下载来源/)).toBeTruthy();
  });
});
