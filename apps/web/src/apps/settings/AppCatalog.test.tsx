// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastContextProvider } from '../../ui/primitives';
import { AppCatalog } from './AppCatalog';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const magpie = {
  id: 'magpie',
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
  manifest: {
    name: 'magpie',
    version: '0.1.4265',
    runtime: { mode: 'create', user: 'khc-app-magpie', linger: true },
    params: [
      { key: 'port', type: 'integer', label: '网关端口', default: 3425 },
      { key: 'web_port', type: 'integer', label: 'Web 管理页端口', default: 3430 },
      { key: 'public_url', type: 'string', label: 'Caddy 发布后的对外地址（可选）', default: '' },
    ],
    scripts: { install: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
    sha256: { install: '0'.repeat(64), uninstall: '0'.repeat(64) },
    publish: { label: 'Web 管理页', host: '127.0.0.1', portParam: 'web_port', port: 3430 },
    writes: [],
  },
};

let requests: string[] = [];

function stubApi(opts?: { manifests?: Response }) {
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === '/api/v1/app-manifests') {
        return opts?.manifests ?? json({ appManifests: [magpie] });
      }
      return json({ error: { code: 'not_found', message: url } }, 404);
    }),
  );
}

function renderCatalog(onOpenManifests?: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastContextProvider value={{ show: vi.fn() }}>
        <AppCatalog onOpenManifests={onOpenManifests} />
      </ToastContextProvider>
    </QueryClientProvider>,
  );
}

describe('设置 → 应用目录（只读脚本库）', () => {
  beforeEach(() => stubApi());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('列出适配过的应用与可发布端口，但不提供任何安装动作', async () => {
    renderCatalog();
    expect((await screen.findAllByText('magpie')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('0.1.4265').length).toBeGreaterThan(0);
    expect(screen.getByText('新建用户 khc-app-magpie')).toBeTruthy();
    expect(screen.getByText('Web 管理页 · 3430')).toBeTruthy();

    // 设置里不装东西：没有安装按钮，也不发任何节点侧请求。
    expect(screen.queryByRole('button', { name: '安装' })).toBeNull();
    expect(requests.filter((url) => url.includes('/nodes/'))).toHaveLength(0);
  });

  it('打开清单只读详情：参数可见只读，并指向节点页去安装', async () => {
    renderCatalog();
    await userEvent.click((await screen.findAllByText('magpie'))[0]!);

    expect(await screen.findByText('应用清单：magpie')).toBeTruthy();
    expect(screen.getByText('安装不在这里')).toBeTruthy();
    expect(screen.getByText(/去「节点 → 应用 → 发布应用」/)).toBeTruthy();

    // 参数只作展示（不是输入框），避免看起来能在这里装机。
    expect(screen.getByText('Web 管理页端口')).toBeTruthy();
    expect(screen.getByText('3430')).toBeTruthy();
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
  });

  it('清单为空时指向「应用管理」，不在这里装', async () => {
    vi.unstubAllGlobals();
    stubApi({ manifests: json({ appManifests: [] }) });
    const onOpenManifests = vi.fn();
    renderCatalog(onOpenManifests);

    expect(await screen.findByText('还没有发布应用清单')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '去应用管理添加' }));
    expect(onOpenManifests).toHaveBeenCalledTimes(1);
  });

  it('应用目录加载失败时显示加载失败与重试，而不是「目录为空」', async () => {
    vi.unstubAllGlobals();
    stubApi({
      manifests: json({ error: { code: 'internal_error', message: '服务器内部错误' } }, 500),
    });
    renderCatalog();

    expect((await screen.findAllByText('应用目录加载失败')).length).toBeGreaterThan(0);
    expect(await screen.findByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.queryByText('还没有发布应用清单')).toBeNull();
  });
});
