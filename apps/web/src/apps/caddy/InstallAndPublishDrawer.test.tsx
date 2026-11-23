// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import type { AgentState, Certificate, Node } from '@khc/contracts';
import { normalizeCaddyConfig, type CaddySite } from '../../data/sites';
import { InstallAndPublishDrawer } from './InstallAndPublishDrawer';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const NOW = Math.floor(Date.now() / 1000);

const node: Node = {
  id: 'hub-1',
  name: 'hk-1',
  endpoint: 'https://hk.example.com:2053',
  tunnelEndpoint: null,
  liveEndpoint: null,
  domain: 'hk.example.com',
  accessMode: 'domain',
  tunnelId: null,
  allowInsecure: false,
  preferredRoute: 'direct',
  status: 'online',
  lastSeenAt: NOW,
  createdAt: 1,
  updatedAt: 2,
};

function makeStateResponse(
  installedDetail: Record<string, unknown> = {},
  capabilities: Record<string, unknown> = {
    appManifest: {
      schemas: [1, 2],
      features: ['schema2', 'upgrade', 'units', 'health.http', 'hookEnv', 'params.enum'],
    },
  },
) {
  return {
    reachable: true,
    route: 'direct',
    via: 'fetch',
    error: null,
    state: {
      host: {
        hostname: 'hk-1',
        os: 'Ubuntu',
        kernel: '6.8',
        uptime: 100,
        load: [0, 0, 0],
        disk: { total: 100, used: 10, free: 90, percent: 10 },
        mem: { total: 1000, available: 800, used: 200, percent: 20 },
      },
      adapters: [
        { name: 'app-catalog', version: '1.0.0', appliedRev: null, status: { installedDetail } },
      ],
      ports: [],
      agent: {
        version: '0.8.0',
        serverTime: NOW,
        capabilities,
      },
    },
  };
}

const magpieManifest = {
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

const wildcardCert: Certificate = {
  id: 'cert_wild',
  name: 'wildcard-example',
  domains: ['*.example.com'],
  issuer: 'acme',
  notAfter: NOW + 60 * 86_400,
  sourceNodeId: null,
  acmeProvider: 'cf-dns01',
  acmeCredentialKey: 'acc_1',
  acmeCa: 'letsencrypt',
  acmeKeyType: 'ec',
  renewable: true,
  createdAt: NOW,
  updatedAt: NOW,
};

function renderWizard(
  props: {
    certificates?: Certificate[];
    existingSites?: CaddySite[];
    onPublished?: () => Promise<void> | void;
    onClose?: () => void;
    installedDetail?: Record<string, unknown>;
    capabilities?: Record<string, unknown>;
    hasHostOps?: boolean;
    installTimeoutMs?: number;
  } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <InstallAndPublishDrawer
        hubId="hub-1"
        hubName="hk-1"
        node={node}
        state={makeStateResponse(props.installedDetail, props.capabilities).state as unknown as AgentState}
        hasHostOps={props.hasHostOps}
        installTimeoutMs={props.installTimeoutMs}
        certificates={props.certificates ?? []}
        existingSites={props.existingSites ?? []}
        pollIntervalMs={5}
        onClose={props.onClose ?? vi.fn()}
        onPublished={props.onPublished ?? vi.fn()}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('InstallAndPublishDrawer 三步向导（S2）', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('选应用 → 配域名与自动 TLS（无密码/自动 public_url/端口防撞）→ 安装并生成可点带密钥链接', async () => {
    window.scrollTo = vi.fn();
    let polls = 0;
    let savedSites: Record<string, unknown>[] = [];
    let applyCount = 0;
    let installPayload: Record<string, unknown> | null = null;
    const onPublished = vi.fn();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/v1/app-manifests') return json({ appManifests: [magpieManifest] });
        if (url === '/api/v1/nodes/hub-1/apps/app-catalog/recipe_install') {
          installPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return json({ ok: true, accepted: true, taskId: 'task-42', result: { taskId: 'task-42' } });
        }
        if (url === '/api/v1/nodes/hub-1/tasks/task-42') {
          polls += 1;
          const done = polls >= 2;
          return json({
            task: {
              id: 'task-42',
              state: done ? 'done' : 'running',
              progress: done ? 100 : 50,
              logs: ['downloading magpie', ...(done ? ['service active on 3430'] : [])],
              result: done
                ? {
                    cards: [
                      {
                        title: '打开应用（含登录密钥）',
                        value: 'https://app.example.com:8443/?k=1',
                        kind: 'url',
                        primary: true,
                        copy: true,
                      },
                    ],
                  }
                : null,
              error: null,
            },
          });
        }
        if (url === '/api/v1/nodes/hub-1/apps/caddy-site') {
          if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body)) as { config: { sites: Record<string, unknown>[] } };
            savedSites = body.config.sites;
            return json({
              app: {
                app: 'caddy-site',
                schemaVersion: 1,
                config: { sites: savedSites },
                rev: 2,
                appliedRev: 1,
                updatedAt: NOW,
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
              updatedAt: NOW,
            },
          });
        }
        if (url === '/api/v1/nodes/hub-1/apps/caddy-site/apply') {
          applyCount += 1;
          return json({ ok: true });
        }
        return json({ error: { code: 'not_found', message: url } }, 404);
      }),
    );

    renderWizard({ onPublished });

    expect(await screen.findByText('magpie')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '选择并配置' }));

    // 默认预填 VM 绑定域名，默认对外端口 443（因 Agent 在 2053 且尚无其他站点占 443）
    expect(screen.queryByLabelText('密码')).toBeNull();
    expect(screen.queryByLabelText('Caddy 发布后的对外地址（可选）')).toBeNull();
    const domainInput = screen.getByLabelText('发布域名') as HTMLInputElement;
    expect(domainInput.value).toBe('hk.example.com');
    expect(domainInput.getAttribute('list')).toBe('wizard-domain-options');
    expect(document.querySelector('#wizard-domain-options option[value="hk.example.com"]')).toBeTruthy();
    expect(screen.queryByLabelText(/选择已有域名/)).toBeNull();
    const portInput = screen.getByLabelText('对外端口') as HTMLInputElement;
    expect(portInput.value).toBe('443');

    // 对外端口与 Agent 2053 撞端口时内联报错且禁用提交
    await userEvent.clear(domainInput);
    await userEvent.type(domainInput, 'app.example.com');
    await userEvent.clear(portInput);
    await userEvent.type(portInput, '2053');
    expect(await screen.findByText('对外端口不能与 Agent 监听端口（2053）相同。')).toBeTruthy();
    expect((screen.getByRole('button', { name: '开始安装并发布' }) as HTMLButtonElement).disabled).toBe(true);

    await userEvent.clear(portInput);
    await userEvent.type(portInput, '8443');

    const webPortInput = screen.getByLabelText('Web 管理页端口') as HTMLInputElement;
    await userEvent.clear(webPortInput);
    await userEvent.type(webPortInput, '4430');

    await userEvent.click(screen.getByRole('button', { name: '开始安装并发布' }));

    expect(await screen.findByText('magpie 已安装并发布')).toBeTruthy();
    const loginBtn = screen.getByRole('link', { name: '打开应用（含登录密钥）' }) as HTMLAnchorElement;
    expect(loginBtn.getAttribute('href')).toBe('https://app.example.com:8443/?k=1');
    expect((installPayload as { params?: Record<string, unknown> } | null)?.params).toMatchObject({
      manifestId: 'magpie',
      runtimeMode: 'create',
      runtimeUser: 'khc-app-magpie',
      values: { port: 3425, web_port: 4430, public_url: 'https://app.example.com:8443' },
    });
    expect(
      (installPayload as { params?: Record<string, unknown> } | null)?.params,
    ).not.toHaveProperty('runtimePassword');
    expect(screen.getByText('https://app.example.com:8443/?k=1')).toBeTruthy();
    expect(applyCount).toBe(1);
    expect(onPublished).toHaveBeenCalledTimes(1);
    expect(savedSites).toHaveLength(1);
    expect(savedSites[0]).toMatchObject({
      name: 'magpie',
      domains: ['app.example.com'],
      listenPort: 8443,
      upstreams: ['127.0.0.1:4430'],
      tls: { mode: 'auto', cert: null },
    });
  });

  it('支持绑定全局通配符证书（manual $cert），并在发布失败时保留重发入口', async () => {
    window.scrollTo = vi.fn();
    let savedSites: Record<string, unknown>[] = [];
    let failApply = true;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/v1/app-manifests') return json({ appManifests: [magpieManifest] });
        if (url === '/api/v1/nodes/hub-1/apps/app-catalog/recipe_install') {
          return json({ ok: true, accepted: true, taskId: 'task-99', result: { taskId: 'task-99' } });
        }
        if (url === '/api/v1/nodes/hub-1/tasks/task-99') {
          return json({
            task: { id: 'task-99', state: 'done', progress: 100, logs: ['ready'], result: {}, error: null },
          });
        }
        if (url === '/api/v1/nodes/hub-1/apps/caddy-site') {
          if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body)) as { config: { sites: Record<string, unknown>[] } };
            savedSites = body.config.sites;
            return json({
              app: {
                app: 'caddy-site',
                schemaVersion: 1,
                config: { sites: savedSites },
                rev: 2,
                appliedRev: 1,
                updatedAt: NOW,
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
              updatedAt: NOW,
            },
          });
        }
        if (url === '/api/v1/nodes/hub-1/apps/caddy-site/apply') {
          if (failApply) {
            return json({ ok: false, error: { code: 'E_APPLY', message: 'caddy reload failed' } });
          }
          return json({ ok: true });
        }
        return json({});
      }),
    );

    renderWizard({
      certificates: [wildcardCert],
      installedDetail: {
        'magpie/default': {
          manifestId: 'magpie',
          instance: 'default',
          version: '0.1.4265',
          source: 'manifest',
          schema: 1,
          installedAt: '2026-11-22T00:53:28Z',
        },
      },
    });

    expect(await screen.findByText('已安装 v0.1.4265')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '选择并配置' }));

    const domainInput = screen.getByLabelText('发布域名') as HTMLInputElement;
    await userEvent.clear(domainInput);
    await userEvent.type(domainInput, 'drive.example.com');

    await userEvent.selectOptions(screen.getByLabelText('TLS 证书模式'), 'manual');
    await userEvent.selectOptions(screen.getByLabelText('选择全局证书'), 'cert_wild');
    await userEvent.click(screen.getByRole('button', { name: '开始安装并发布' }));

    expect(await screen.findByText('caddy reload failed')).toBeTruthy();
    const retryBtn = screen.getByRole('button', { name: '重试发布站点' });
    expect(retryBtn).toBeTruthy();

    failApply = false;
    await userEvent.click(retryBtn);

    expect(await screen.findByText('magpie 已安装并发布')).toBeTruthy();
    await waitFor(() => {
      expect(savedSites[0]).toMatchObject({
        name: 'magpie',
        tls: { mode: 'manual', cert: { $cert: 'cert_wild' } },
      });
    });
  });

  it('支持关闭 TLS（http 明文发布）并拦截应用端口撞端口', async () => {
    window.scrollTo = vi.fn();
    let savedSites: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/v1/app-manifests') return json({ appManifests: [magpieManifest] });
        if (url === '/api/v1/nodes/hub-1/apps/app-catalog/recipe_install') {
          return json({ ok: true, accepted: true, taskId: 'task-off', result: { taskId: 'task-off' } });
        }
        if (url === '/api/v1/nodes/hub-1/tasks/task-off') {
          return json({
            task: { id: 'task-off', state: 'done', progress: 100, logs: [], result: {}, error: null },
          });
        }
        if (url === '/api/v1/nodes/hub-1/apps/caddy-site') {
          if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body)) as { config: { sites: Record<string, unknown>[] } };
            savedSites = body.config.sites;
            return json({ app: { app: 'caddy-site', schemaVersion: 1, config: { sites: savedSites }, rev: 2, appliedRev: 1, updatedAt: NOW } });
          }
          return json({ app: { app: 'caddy-site', schemaVersion: 1, config: { sites: savedSites }, rev: 1, appliedRev: 1, updatedAt: NOW } });
        }
        if (url === '/api/v1/nodes/hub-1/apps/caddy-site/apply') return json({ ok: true });
        return json({});
      }),
    );

    renderWizard();
    expect(await screen.findByText('magpie')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '选择并配置' }));

    const domainInput = screen.getByLabelText('发布域名') as HTMLInputElement;
    await userEvent.clear(domainInput);
    await userEvent.type(domainInput, 'plain.example.com');
    const portInput = screen.getByLabelText('对外端口') as HTMLInputElement;
    await userEvent.clear(portInput);
    await userEvent.type(portInput, '3430');
    expect(await screen.findByText('应用内部端口不能与对外端口或 Agent 监听端口（3430）相同。')).toBeTruthy();

    await userEvent.clear(portInput);
    await userEvent.type(portInput, '8088');
    await userEvent.selectOptions(screen.getByLabelText('TLS 证书模式'), 'off');
    await userEvent.click(screen.getByRole('button', { name: '开始安装并发布' }));

    expect(await screen.findByText('magpie 已安装并发布')).toBeTruthy();
    expect(savedSites[0]).toMatchObject({
      listenPort: 8088,
      tls: { mode: 'off', cert: null },
    });
  });

  it('复用已有 VM 域名并在不同端口发布第二个应用，不覆盖先前的同域名站点', async () => {
    window.scrollTo = vi.fn();
    const existing = normalizeCaddyConfig({
      sites: [
        {
          name: 'llmproxy',
          domains: ['hk.example.com'],
          listenPort: 443,
          kind: 'proxy',
          upstreams: ['127.0.0.1:8787'],
          enabled: true,
        },
      ],
    }).sites;
    let savedSites: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/v1/app-manifests') return json({ appManifests: [magpieManifest] });
        if (url === '/api/v1/nodes/hub-1/apps/app-catalog/recipe_install') {
          return json({ ok: true, accepted: true, taskId: 'task-second', result: { taskId: 'task-second' } });
        }
        if (url === '/api/v1/nodes/hub-1/tasks/task-second') {
          return json({
            task: { id: 'task-second', state: 'done', progress: 100, logs: [], result: {}, error: null },
          });
        }
        if (url === '/api/v1/nodes/hub-1/apps/caddy-site') {
          if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body)) as { config: { sites: Record<string, unknown>[] } };
            savedSites = body.config.sites;
            return json({ app: { app: 'caddy-site', schemaVersion: 1, config: { sites: savedSites }, rev: 2, appliedRev: 1, updatedAt: NOW } });
          }
          return json({
            app: {
              app: 'caddy-site',
              schemaVersion: 1,
              config: { sites: existing },
              rev: 1,
              appliedRev: 1,
              updatedAt: NOW,
            },
          });
        }
        if (url === '/api/v1/nodes/hub-1/apps/caddy-site/apply') return json({ ok: true });
        return json({});
      }),
    );

    renderWizard({ existingSites: existing });
    expect(await screen.findByText('magpie')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '选择并配置' }));

    const domainInput = screen.getByLabelText('发布域名') as HTMLInputElement;
    const portInput = screen.getByLabelText('对外端口') as HTMLInputElement;
    expect(domainInput.value).toBe('hk.example.com');
    expect(portInput.value).toBe('8443');

    await userEvent.click(screen.getByRole('button', { name: '开始安装并发布' }));
    expect(await screen.findByText('magpie 已安装并发布')).toBeTruthy();
    expect(savedSites).toHaveLength(2);
    expect(savedSites.map((s) => ({ name: s.name, listenPort: s.listenPort }))).toEqual([
      { name: 'llmproxy', listenPort: 443 },
      { name: 'magpie', listenPort: 8443 },
    ]);
  });

  it('schema=2 向导：enum/requires 联动、secret 遮罩切换、derive 隐藏推导、多端点发布走 manifest_install', async () => {
    window.scrollTo = vi.fn();
    let manifestInstallPayload: Record<string, unknown> | null = null;
    let savedSites: Record<string, unknown>[] = [];
    const v2App = {
      id: 'v2-demo',
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
      manifest: {
        schema: 2,
        name: 'V2 演示应用',
        version: '2.0.0',
        runtime: { mode: 'create', user: 'khc-app-v2', linger: true },
        params: [
          {
            key: 'tier',
            type: 'enum',
            label: '规格',
            default: 'lite',
            options: [
              { value: 'lite', label: '轻量' },
              { value: 'pro', label: '高配', requires: { memMB: 2048 } },
            ],
          },
          { key: 'api_secret', type: 'string', label: '管理密钥', secret: true, default: '' },
          { key: 'web_port', type: 'integer', label: '控制台端口', default: 5010, min: 1024, max: 65535 },
          { key: 'rpc_port', type: 'integer', label: '接口端口', default: 5020, min: 1024, max: 65535 },
          { key: 'public_url', type: 'string', label: '访问地址', derive: 'endpoint:web.publicUrl' },
        ],
        endpoints: [
          { id: 'web', label: '控制台', protocol: 'http', portParam: 'web_port', bind: 'loopback', publish: 'caddy' },
          { id: 'rpc', label: '接口', protocol: 'http', portParam: 'rpc_port', bind: 'loopback', publish: 'caddy' },
        ],
        units: [{ name: 'v2-demo.service', scope: 'user' }],
        health: {
          type: 'http',
          url: 'http://127.0.0.1:{{params.web_port}}/health',
          expectStatus: 200,
          graceSec: 10,
          intervalSec: 1,
          timeoutMs: 1000,
        },
        scripts: { install: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
        sha256: { install: '0'.repeat(64), uninstall: '0'.repeat(64) },
        writes: [],
      },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/v1/app-manifests') return json({ appManifests: [v2App] });
        if (url === '/api/v1/nodes/hub-1/apps/app-catalog/manifest_install') {
          manifestInstallPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return json({ ok: true, accepted: true, taskId: 'task-v2', result: { taskId: 'task-v2' } });
        }
        if (url === '/api/v1/nodes/hub-1/tasks/task-v2') {
          return json({
            task: {
              id: 'task-v2',
              state: 'done',
              progress: 100,
              logs: ['installed'],
              result: {
                cards: [{ title: '管理地址', value: 'https://hk.example.com:8443', kind: 'url', primary: true, copy: true }],
              },
              error: null,
            },
          });
        }
        if (url === '/api/v1/nodes/hub-1/apps/caddy-site') {
          if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body)) as { config: { sites: Record<string, unknown>[] } };
            savedSites = body.config.sites;
            return json({ app: { app: 'caddy-site', schemaVersion: 1, config: { sites: savedSites }, rev: 2, appliedRev: 1, updatedAt: NOW } });
          }
          return json({ app: { app: 'caddy-site', schemaVersion: 1, config: { sites: savedSites }, rev: 1, appliedRev: 1, updatedAt: NOW } });
        }
        if (url === '/api/v1/nodes/hub-1/apps/caddy-site/apply') return json({ ok: true });
        return json({});
      }),
    );

    renderWizard();
    expect(await screen.findByText('V2 演示应用')).toBeTruthy();
    expect(screen.getByText('v2')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '选择并配置' }));

    // derive 字段隐藏不渲染
    expect(screen.queryByLabelText('访问地址')).toBeNull();

    // enum requires 联动
    await userEvent.selectOptions(screen.getByLabelText('规格'), 'pro');
    expect(screen.getByText('需 ≥ 2048 MB 内存')).toBeTruthy();

    // secret 遮罩与显示切换
    const secretInput = screen.getByLabelText('管理密钥') as HTMLInputElement;
    expect(secretInput.type).toBe('password');
    await userEvent.type(secretInput, 'top-secret');
    await userEvent.click(screen.getByRole('button', { name: '显示' }));
    expect(secretInput.type).toBe('text');

    // 默认勾选首个端点、第二个未勾选；勾选第二个以同时发布两个端点
    const pubChecks = screen.getAllByRole('checkbox', { name: '通过 Caddy 发布此端点' }) as HTMLInputElement[];
    expect(pubChecks).toHaveLength(2);
    expect(pubChecks[0]!.checked).toBe(true);
    expect(pubChecks[1]!.checked).toBe(false);
    await userEvent.click(pubChecks[1]!);
    expect(pubChecks[1]!.checked).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: '开始安装并发布' }));
    expect(await screen.findByText('V2 演示应用 已安装并发布')).toBeTruthy();

    expect((manifestInstallPayload as { params?: Record<string, unknown> } | null)?.params).toMatchObject({
      manifestId: 'v2-demo',
      values: {
        tier: 'pro',
        api_secret: 'top-secret',
        web_port: 5010,
        rpc_port: 5020,
        public_url: 'https://hk.example.com',
      },
    });
    expect(savedSites).toHaveLength(2);
    expect(savedSites.map((s) => s.upstreams)).toEqual([['127.0.0.1:5010'], ['127.0.0.1:5020']]);
  });

  it('节点能力不足时禁用 schema=2 应用按钮并提示升级 Agent', async () => {
    window.scrollTo = vi.fn();
    const v2App = {
      id: 'v2-cap',
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
      manifest: {
        schema: 2,
        name: 'V2 能力应用',
        version: '2.0.0',
        runtime: { mode: 'create', user: 'khc-app-v2', linger: true },
        params: [],
        units: [{ name: 'v2-cap.service', scope: 'user' }],
        scripts: { install: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
        sha256: { install: '0'.repeat(64), uninstall: '0'.repeat(64) },
        writes: [],
      },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/app-manifests') return json({ appManifests: [v2App] });
        return json({});
      }),
    );

    renderWizard({ capabilities: { appManifest: { schemas: [1], features: [] } } });
    expect(await screen.findByText('V2 能力应用')).toBeTruthy();
    const pickBtn = screen.getByRole('button', { name: '选择并配置' }) as HTMLButtonElement;
    expect(pickBtn.disabled).toBe(true);
    expect(screen.getByText(/需将节点 Agent 升级到/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '去升级' })).toBeTruthy();
  });
  const v2Base = {
    schema: 2,
    runtime: { mode: 'create', user: 'khc-app-v2', linger: true },
    params: [
      { key: 'web_port', type: 'integer', label: '控制台端口', default: 5010, min: 1024, max: 65535 },
    ],
    units: [{ name: 'v2-demo.service', scope: 'user' }],
    scripts: { install: '#!/bin/sh\n', uninstall: '#!/bin/sh\n' },
    sha256: { install: '0'.repeat(64), uninstall: '0'.repeat(64) },
    writes: [],
  };

  it('安装返回 preflight_failed 时，第 3 步逐条渲染预检项（含失败项文案）', async () => {
    window.scrollTo = vi.fn();
    const app = {
      id: 'v2-pre',
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
      manifest: { ...v2Base, name: 'V2 预检应用', version: '2.0.0' },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/app-manifests') return json({ appManifests: [app] });
        if (url === '/api/v1/nodes/hub-1/apps/app-catalog/manifest_install') {
          return json(
            {
              error: {
                code: 'preflight_failed',
                message: '节点安装预检未通过',
                details: {
                  checks: [
                    { name: 'disk', ok: true, message: '磁盘空间充足' },
                    { name: 'mem', ok: false, message: '内存不足：需要 2048 MB' },
                    { name: 'port', ok: false, message: '端口 5010 已被占用' },
                  ],
                },
              },
            },
            422,
          );
        }
        return json({});
      }),
    );

    renderWizard();
    expect(await screen.findByText('V2 预检应用')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '选择并配置' }));
    await userEvent.click(screen.getByRole('button', { name: '开始安装并发布' }));

    expect(await screen.findByText('节点安装预检未通过')).toBeTruthy();
    expect(screen.getByText('磁盘空间充足')).toBeTruthy();
    expect(screen.getByText('内存不足：需要 2048 MB')).toBeTruthy();
    expect(screen.getByText('端口 5010 已被占用')).toBeTruthy();
    expect(screen.getAllByText('未通过')).toHaveLength(2);
    expect(screen.getAllByText('通过')).toHaveLength(1);
  });

  describe('bind:any 防火墙提示（第 2 步）', () => {
    const anyApp = {
      id: 'v2-any',
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
      manifest: {
        ...v2Base,
        name: 'V2 全地址应用',
        version: '2.0.0',
        endpoints: [
          { id: 'web', label: '控制台', protocol: 'http', portParam: 'web_port', bind: 'any', publish: 'caddy' },
        ],
      },
    };

    function stubFw(rules: Record<string, unknown>[]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url === '/api/v1/app-manifests') return json({ appManifests: [anyApp] });
          if (url === '/api/v1/nodes/hub-1/apps/host-ops/call') {
            const verb = (JSON.parse(String(init?.body)) as { params: { verb: string } }).params.verb;
            if (verb === 'version') return json({ ok: true, data: { root: true, nft: true } });
            if (verb === 'fw.show') return json({ ok: true, data: { baseRev: 'r1', rules, autoRules: [] } });
          }
          return json({});
        }),
      );
    }

    it('端口已放行时显示 warning 级提示并说明已放行', async () => {
      window.scrollTo = vi.fn();
      stubFw([{ id: 'r1', action: 'allow', proto: 'tcp', port: '5010', source: '0.0.0.0/0', note: '' }]);
      renderWizard({ hasHostOps: true });
      expect(await screen.findByText('V2 全地址应用')).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: '选择并配置' }));

      const desc = await screen.findByText('主机防火墙当前已放行 TCP 5010。');
      const banner = desc.closest('.ui-banner');
      expect(banner?.classList.contains('ui-banner-warn')).toBe(true);
      expect(banner?.textContent).toContain('应用监听所有地址');
    });

    it('端口未放行时显示信息级提示（无已放行说明）', async () => {
      window.scrollTo = vi.fn();
      stubFw([{ id: 'r1', action: 'allow', proto: 'tcp', port: '22', source: '0.0.0.0/0', note: '' }]);
      renderWizard({ hasHostOps: true });
      expect(await screen.findByText('V2 全地址应用')).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: '选择并配置' }));

      const title = await screen.findByText(/应用监听所有地址/);
      expect(title.closest('.ui-banner')?.classList.contains('ui-banner-info')).toBe(true);
      await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/v1/nodes/hub-1/apps/host-ops/call',
        expect.anything(),
      ));
      expect(screen.queryByText('主机防火墙当前已放行 TCP 5010。')).toBeNull();
    });
  });

  it('安装任务轮询超过上限时转为失败并提示查看任务日志', async () => {
    window.scrollTo = vi.fn();
    const app = {
      id: 'v2-slow',
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
      manifest: { ...v2Base, name: 'V2 慢安装应用', version: '2.0.0' },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/app-manifests') return json({ appManifests: [app] });
        if (url === '/api/v1/nodes/hub-1/apps/app-catalog/manifest_install') {
          return json({ ok: true, accepted: true, taskId: 'task-slow', result: { taskId: 'task-slow' } });
        }
        if (url === '/api/v1/nodes/hub-1/tasks/task-slow') {
          return json({
            task: { id: 'task-slow', state: 'running', progress: 10, logs: ['still running'], result: null, error: null },
          });
        }
        return json({});
      }),
    );

    renderWizard({ installTimeoutMs: 60 });
    expect(await screen.findByText('V2 慢安装应用')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '选择并配置' }));
    await userEvent.click(screen.getByRole('button', { name: '开始安装并发布' }));

    expect(await screen.findByText(/已停止等待；请查看任务日志/)).toBeTruthy();
    expect(screen.getByText('still running')).toBeTruthy();
  });

  it('全局证书库存在匹配证书时，进入第 2 步默认选用「全局证书库」并预填优选 certId', async () => {
    window.scrollTo = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/v1/app-manifests') return json({ appManifests: [magpieManifest] });
        return json({});
      }),
    );

    renderWizard({ certificates: [wildcardCert] });
    expect(await screen.findByText('magpie')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '选择并配置' }));

    const tlsSelect = (await screen.findByLabelText('TLS 证书模式')) as HTMLSelectElement;
    expect(tlsSelect.value).toBe('manual');
    const certSelect = (await screen.findByLabelText(/选择全局证书/)) as HTMLSelectElement;
    expect(certSelect.value).toBe(wildcardCert.id);
  });
});
