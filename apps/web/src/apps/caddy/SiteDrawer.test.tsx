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

function Harness({
  initial,
  nodeOverride,
  existingSites,
  certificates = [],
  existingDomains = [],
  saveError = null,
}: {
  initial?: Partial<SiteFormState>;
  nodeOverride?: Node;
  existingSites?: import('../../data/sites').CaddySite[];
  certificates?: { id: string; name: string; domains: string[]; notAfter: number | null }[];
  existingDomains?: string[];
  saveError?: string | { message: string; details?: string | null; hint?: string | null } | null;
}) {
  const [form, setForm] = useState<SiteFormState>(() => ({ ...createForm(), ...initial }));
  return (
    <SiteDrawer
      form={form}
      errors={{}}
      saveError={saveError}
      saving={false}
      hubId="hub-1"
      hubName="app-1"
      node={nodeOverride ?? node}
      certificates={certificates}
      peers={[{ name: 'peer-a', host: '10.20.30.40' }]}
      existingDomains={existingDomains}
      existingSites={existingSites}
      onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
      onClose={() => {}}
      onSave={() => {}}
      onDelete={async () => {}}
    />
  );
}

function renderDrawer(
  initial?: Partial<SiteFormState>,
  options?: {
    nodeOverride?: Node;
    existingSites?: import('../../data/sites').CaddySite[];
    certificates?: { id: string; name: string; domains: string[]; notAfter: number | null }[];
    existingDomains?: string[];
    saveError?: string | { message: string; details?: string | null; hint?: string | null } | null;
  },
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness
        initial={initial}
        nodeOverride={options?.nodeOverride}
        existingSites={options?.existingSites}
        certificates={options?.certificates}
        existingDomains={options?.existingDomains}
        saveError={options?.saveError}
      />
    </QueryClientProvider>,
  );
}

describe('站点抽屉上游配置（精简版）', () => {
  beforeEach(stubApi);
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('本机目标使用「本机监听端口」并精简掉重复域名下拉、启用开关、向导横幅与只读上游灰框', async () => {
    renderDrawer({ domains: 'svc.example.com', listenPort: 2083 });

    expect((screen.getByLabelText('目标来源') as HTMLSelectElement).value).toBe('local');
    expect(screen.queryByLabelText('上游来源')).toBeNull();
    expect(screen.queryByLabelText(/从已有域名选择/)).toBeNull();
    expect(screen.queryByRole('button', { name: '打开安装并发布向导' })).toBeNull();
    expect(screen.queryByText('启用')).toBeNull();
    expect(screen.queryByText('上游地址')).toBeNull();
    expect(document.getElementById('site-upstreams')).toBeNull();

    const portInput = screen.getByLabelText(/^本机监听端口/) as HTMLInputElement;
    await userEvent.clear(portInput);
    await userEvent.type(portInput, '3430');
    expect(screen.getByText('127.0.0.1:3430')).toBeTruthy();
  });

  it('目标指向 Peer 时不渲染向导与只读上游框，并实时更新顶部路由预览', async () => {
    renderDrawer({ domains: 'svc.example.com', listenPort: 2083 });
    await userEvent.selectOptions(screen.getByLabelText('目标来源'), '10.20.30.40');

    expect(screen.queryByRole('button', { name: '打开安装并发布向导' })).toBeNull();
    expect(document.getElementById('site-upstreams')).toBeNull();
    expect(screen.getByText(/10\.20\.30\.40:/)).toBeTruthy();
  });

  it('编辑已有站点展示「启用」开关，且路径路由收纳进「高级」；自定义上游才显示上游地址输入', async () => {
    renderDrawer({ domains: 'new.example.com', listenPort: 2083 });
    expect((screen.getByLabelText('目标来源') as HTMLSelectElement).value).toBe('local');
    expect(screen.getByLabelText('应用名称')).toBeTruthy();
    expect(screen.queryByText('路径路由')).toBeNull();

    cleanup();

    renderDrawer({
      mode: 'edit',
      domains: 'old.example.com',
      listenPort: 2083,
      upstreams: '192.168.1.10:8080',
    });
    expect((screen.getByLabelText('目标来源') as HTMLSelectElement).value).toBe('custom');
    expect(screen.queryByLabelText(/^本机监听端口/)).toBeNull();
    expect(screen.getByLabelText(/^上游地址/)).toBeTruthy();
    expect(screen.getByText('启用')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '打开安装并发布向导' })).toBeNull();
    // 瘦身：精简掉低频企业反代细项与抽屉内重复删除
    expect(screen.getByLabelText('应用名称')).toBeTruthy();
    expect(screen.queryByLabelText('站点名称')).toBeNull();
    expect(screen.queryByLabelText('负载均衡')).toBeNull();
    expect(screen.queryByLabelText('健康检查路径')).toBeNull();
    expect(screen.queryByLabelText('仅允许 TLS 1.3')).toBeNull();
    expect(screen.queryByLabelText('最大请求体')).toBeNull();
    expect(screen.queryByLabelText('日志路径')).toBeNull();
    expect(screen.queryByRole('button', { name: '删除此站点' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '高级' }));
    expect(screen.getByText('路径路由')).toBeTruthy();
    expect(screen.getByText('响应头')).toBeTruthy();
  });

  it('顶部实时路由预览完整显示访问地址与转发目标', () => {
    renderDrawer({
      name: 'llmproxy',
      domains: 'app.example.com',
      listenPort: 8443,
      upstreams: '127.0.0.1:8787',
    });
    expect(screen.getByText('对外访问预览')).toBeTruthy();
    expect(screen.getByText('https://app.example.com:8443')).toBeTruthy();
    expect(screen.getByText('127.0.0.1:8787')).toBeTruthy();
    expect((screen.getByLabelText('应用名称') as HTMLInputElement).value).toBe('llmproxy');
  });

  it('对外端口与本机应用端口或 Agent 端口冲突时内联报错，点「改用推荐端口」一键修复', async () => {
    renderDrawer({
      name: 'llmproxy',
      domains: 'app.example.com',
      listenPort: 8787,
      upstreams: '127.0.0.1:8787',
    });
    expect(screen.getByText(/对外端口不能与本机应用端口（8787）相同/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '改用推荐端口 443' }));
    expect((screen.getByLabelText('对外端口') as HTMLInputElement).value).toBe('443');
    expect(screen.queryByText(/对外端口不能与本机应用端口/)).toBeNull();

    cleanup();

    renderDrawer(
      {
        name: 'llmproxy',
        domains: 'app.example.com',
        listenPort: 443,
        upstreams: '127.0.0.1:8787',
      },
      { nodeOverride: { ...node, endpoint: 'https://app.example.com:443' } },
    );
    expect(screen.getByText('端口 443 已被本节点 Agent 占用，请改用其他对外端口。')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '改用推荐端口 8443' }));
    expect((screen.getByLabelText('对外端口') as HTMLInputElement).value).toBe('8443');
    expect(screen.queryByText(/已被本节点 Agent 占用/)).toBeNull();
  });

  it('.test 非公网域名搭配自动签发时提示警告并支持一键切换为节点域名', async () => {
    renderDrawer({
      name: 'llmproxy',
      domains: 'khc9099.test',
      listenPort: 8443,
      upstreams: '127.0.0.1:8787',
      tlsMode: 'auto',
    });
    expect(screen.getByText('当前域名无法自动签发公网证书')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '改用节点域名 app.example.com' }));
    expect((screen.getByLabelText(/^域名/) as HTMLInputElement).value).toBe('app.example.com');
    expect(screen.queryByText('当前域名无法自动签发公网证书')).toBeNull();
  });

  it('域名框关联 datalist 候选并在匹配证书库时自动切换手动模式与证书；失败展示 details 与 hint', async () => {
    renderDrawer(
      { name: 'magpie', listenPort: 2583, upstreams: '127.0.0.1:3430', tlsMode: 'auto' },
      {
        existingDomains: ['hw.16666.cyou'],
        certificates: [
          {
            id: 'cert-wild',
            name: '16666.cyou wildcard',
            domains: ['*.16666.cyou'],
            notAfter: Math.floor(Date.now() / 1000) + 86400 * 60,
          },
        ],
        saveError: {
          message: '应用失败，已自动回滚：caddy reload 失败',
          details: 'systemctlStderr: caddy.service is not active, cannot reload.',
          hint: '节点上的 Caddy 服务当前未启动：请先在应用页右上角「Caddy 服务」启动 Caddy。',
        },
      },
    );

    const domainInput = screen.getByLabelText(/^域名/) as HTMLInputElement;
    expect(domainInput.getAttribute('list')).toBe('site-domain-options');
    expect(document.querySelector('#site-domain-options option[value="hw.16666.cyou"]')).toBeTruthy();

    await userEvent.type(domainInput, 'hw.16666.cyou');
    expect((screen.getByLabelText(/^TLS 模式/) as HTMLSelectElement).value).toBe('manual');
    expect((screen.getByLabelText(/^证书/) as HTMLSelectElement).value).toBe('cert-wild');

    expect(screen.getByText('应用失败，已自动回滚：caddy reload 失败')).toBeTruthy();
    expect(screen.getByText(/caddy\.service is not active, cannot reload\./)).toBeTruthy();
    expect(screen.getByText(/节点上的 Caddy 服务当前未启动/)).toBeTruthy();
  });
});
