// @vitest-environment jsdom
/**
 * 发布应用流程的安装入口（docs/hosted-apps.md §3）：
 * 安装选项只在「发布应用 → 上游来源 = 从应用目录安装应用」里出现，
 * 目标不是本机时不提供；装完由清单声明的端口自动填上游。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { Node } from '@khc/contracts';
import { SiteDrawer } from './SiteDrawer';
import { createForm, type SiteFormState } from './siteForm';

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
      {
        key: 'web_port',
        type: 'integer',
        label: 'Web 管理页端口',
        default: 3430,
        min: 1024,
        max: 65535,
      },
      { key: 'public_url', type: 'string', label: 'Caddy 发布后的对外地址（可选）', default: '' },
    ],
    scripts: { install: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
    sha256: { install: '0'.repeat(64), uninstall: '0'.repeat(64) },
    publish: { label: 'Web 管理页', host: '127.0.0.1', portParam: 'web_port', port: 3430 },
    writes: [],
  },
};

let polls = 0;

function stubApi() {
  polls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/app-manifests') return json({ appManifests: [magpie] });
      if (url === '/api/v1/nodes/hub-1/apps/app-catalog/recipe_install') {
        return json({ ok: true, accepted: true, taskId: 'task-9', result: { taskId: 'task-9' } });
      }
      if (url === '/api/v1/nodes/hub-1/tasks/task-9') {
        polls += 1;
        const state = polls === 1 ? 'running' : 'done';
        return json({
          task: {
            id: 'task-9',
            state,
            progress: state === 'done' ? 100 : 60,
            logs: ['安装 magpie'],
            result: {},
            error: null,
          },
        });
      }
      return json({ error: { code: 'not_found', message: url } }, 404);
    }),
  );
}

function Harness({ initial }: { initial?: Partial<SiteFormState> }) {
  const [form, setForm] = useState<SiteFormState>(() => ({ ...createForm(), ...initial }));
  return (
    <SiteDrawer
      form={form}
      errors={{}}
      saveError={null}
      saving={false}
      hubId="hub-1"
      hubName="app-1"
      node={node}
      certificates={[]}
      peers={[{ name: 'peer-a', host: '10.20.30.40' }]}
      existingDomains={[]}
      onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
      onClose={() => {}}
      onSave={() => {}}
      onDelete={async () => {}}
    />
  );
}

function renderDrawer(initial?: Partial<SiteFormState>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness initial={initial} />
    </QueryClientProvider>,
  );
}

describe('发布应用 → 上游来源 = 从应用目录安装', () => {
  beforeEach(stubApi);
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('本机目标才有安装入口，装完自动把清单端口填成上游', async () => {
    renderDrawer({ domains: 'svc.example.com', listenPort: 2083 });

    // 目标选「本机」后才出现上游来源；默认手填时没有「应用」下拉。
    await userEvent.selectOptions(screen.getByLabelText('目标来源'), 'local');
    const source = await screen.findByLabelText('上游来源');
    expect(screen.queryByLabelText('应用')).toBeNull();

    await userEvent.selectOptions(source, 'app');
    const picker = (await screen.findByLabelText('应用')) as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(picker.options).map((option) => option.value)).toContain('magpie');
    });

    await userEvent.selectOptions(picker, 'magpie');
    // 对外地址用当前站点域名 + 对外端口预填，避免装出一个指向 localhost 的登录地址。
    const publicUrl = screen.getByLabelText('Caddy 发布后的对外地址（可选）') as HTMLInputElement;
    expect(publicUrl.value).toBe('https://svc.example.com:2083');

    await userEvent.type(screen.getByLabelText('密码'), 's3cret');
    await userEvent.click(screen.getByRole('button', { name: '安装 magpie 到本机' }));
    await waitFor(() => expect(polls).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole('button', { name: '刷新进度' }));

    // 装完：上游变成 127.0.0.1:3430，页面上给一条已经填好的确认。
    await waitFor(() => {
      expect((screen.getByLabelText('目标端口') as HTMLInputElement).value).toBe('3430');
    });
    expect(screen.getByText('127.0.0.1:3430')).toBeTruthy();
    expect(await screen.findByText(/magpie 已装好（127\.0\.0\.1:3430）/)).toBeTruthy();
  });

  it('目标指向 Peer 时不提供安装入口', async () => {
    renderDrawer({ domains: 'svc.example.com', listenPort: 2083 });
    await userEvent.selectOptions(screen.getByLabelText('目标来源'), '10.20.30.40');

    await waitFor(() => {
      expect(screen.queryByLabelText('上游来源')).toBeNull();
    });
    expect(screen.getByText(/安装只能落在本机/)).toBeTruthy();
  });
});
