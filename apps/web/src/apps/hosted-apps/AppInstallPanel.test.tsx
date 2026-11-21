// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Node } from '@khc/contracts';
import { AppInstallPanel } from './AppInstallPanel';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const node: Node = {
  id: 'hub-1',
  name: 'app-1',
  endpoint: 'https://app.example.com:2053',
  tunnelEndpoint: null,
  liveEndpoint: null,
  domain: 'app.example.com',
  accessMode: 'domain',
  tunnelId: null,
  allowInsecure: false,
  preferredRoute: 'direct',
  status: 'online',
  lastSeenAt: 1_700_000_000,
  createdAt: 1,
  updatedAt: 2,
};

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
      { key: 'port', type: 'integer', label: '网关端口', default: 3425, min: 1024, max: 65535 },
      { key: 'web_port', type: 'integer', label: 'Web 管理页端口', default: 3430, min: 1024, max: 65535 },
      { key: 'public_url', type: 'string', label: 'Caddy 发布后的对外地址（可选）', default: '' },
    ],
    scripts: { install: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
    sha256: { install: '0'.repeat(64), uninstall: '0'.repeat(64) },
    publish: { label: 'Web 管理页', host: '127.0.0.1', portParam: 'web_port', port: 3430 },
    writes: [],
  },
};

let requests: string[] = [];
let polls = 0;

function stubApi() {
  requests = [];
  polls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === '/api/v1/app-manifests') return json({ appManifests: [magpie] });
      if (url === '/api/v1/nodes/hub-1/apps/app-catalog/recipe_install') {
        return json({ ok: true, accepted: true, taskId: 'task-7', result: { taskId: 'task-7' } });
      }
      if (url === '/api/v1/nodes/hub-1/tasks/task-7') {
        polls += 1;
        const state = polls === 1 ? 'running' : 'done';
        return json({
          task: {
            id: 'task-7',
            state,
            progress: state === 'done' ? 100 : 60,
            logs: ['安装 magpie'],
            result:
              state === 'done'
                ? {
                    access: [
                      { label: 'Web 管理页（点击登录）', value: 'https://app.example.com:2083/?k=abc' },
                    ],
                  }
                : {},
            error: null,
          },
        });
      }
      return json({ error: { code: 'not_found', message: url } }, 404);
    }),
  );
}

function renderPanel(onInstalled = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AppInstallPanel
        hubId="hub-1"
        node={node}
        publicUrl="https://app.example.com:2083"
        onInstalled={onInstalled}
      />
    </QueryClientProvider>,
  );
  return onInstalled;
}

describe('发布应用 → 上游来源 = 应用目录', () => {
  beforeEach(stubApi);
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('选应用后参数与对外地址可视化，装机完成后回传清单声明的端口', async () => {
    const onInstalled = renderPanel();
    const picker = (await screen.findByLabelText('应用')) as HTMLSelectElement;
    // 下拉里只有我们适配过的应用。
    await waitFor(() => {
      expect(Array.from(picker.options).map((option) => option.value)).toContain('magpie');
    });
    await userEvent.selectOptions(picker, 'magpie');

    const webPort = (await screen.findByLabelText('Web 管理页端口')) as HTMLInputElement;
    expect(webPort.value).toBe('3430');
    // public_url 由当前站点的对外地址预填，可见可改。
    const publicUrl = screen.getByLabelText('Caddy 发布后的对外地址（可选）') as HTMLInputElement;
    expect(publicUrl.value).toBe('https://app.example.com:2083');
    expect(screen.getByText('装完会占用的端口')).toBeTruthy();

    await userEvent.type(screen.getByLabelText('密码'), 's3cret');
    await userEvent.click(screen.getByRole('button', { name: '安装 magpie 到本机' }));

    await waitFor(() => {
      expect(
        requests.filter((url) => url === '/api/v1/nodes/hub-1/apps/app-catalog/recipe_install'),
      ).toHaveLength(1);
    });
    const sent = JSON.parse(
      (vi.mocked(fetch).mock.calls as Array<[string, RequestInit | undefined]>)
        .find(([url]) => url === '/api/v1/nodes/hub-1/apps/app-catalog/recipe_install')?.[1]
        ?.body as string,
    );
    expect(sent.params.manifestId).toBe('magpie');
    expect(sent.params.runtimeMode).toBe('create');
    expect(sent.params.runtimeUser).toBe('khc-app-magpie');
    expect(sent.params.values).toMatchObject({
      port: 3425,
      web_port: 3430,
      public_url: 'https://app.example.com:2083',
    });

    // 任务完成前不填上游，避免指向还没起来的端口。
    expect(onInstalled).not.toHaveBeenCalled();
    expect(await screen.findByText(/任务状态：running/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '刷新进度' }));
    await waitFor(() => {
      expect(onInstalled).toHaveBeenCalledWith(3430, 'magpie');
    });
    expect(await screen.findByText(/任务状态：done/)).toBeTruthy();
    expect(await screen.findByText('https://app.example.com:2083/?k=abc')).toBeTruthy();
  });
});
