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
import type { Certificate, Node } from '@khc/contracts';
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
    onPublished?: () => Promise<void> | void;
    onClose?: () => void;
  } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <InstallAndPublishDrawer
        hubId="hub-1"
        hubName="hk-1"
        node={node}
        certificates={props.certificates ?? []}
        existingSites={[]}
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
        if (url === '/api/v1/nodes/hub-1/apps/app-catalog/recipe_installed') {
          return json({ ok: true, result: { installed: {} } });
        }
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
                ? { access: [{ label: 'Web 登录', value: 'https://app.example.com:8443/?k=1' }] }
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

    // 不再要求输入密码或冗余的 public_url；默认对外端口 2083（避开 443 与 Agent 2053）且不预填 Agent 域名
    expect(screen.queryByLabelText('密码')).toBeNull();
    expect(screen.queryByLabelText('Caddy 发布后的对外地址（可选）')).toBeNull();
    const domainInput = screen.getByLabelText('发布域名') as HTMLInputElement;
    expect(domainInput.value).toBe('');
    const portInput = screen.getByLabelText('对外端口') as HTMLInputElement;
    expect(portInput.value).toBe('2083');

    // 对外端口与 Agent 2053 撞端口时内联报错且禁用提交
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
      name: 'app.example.com',
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
        if (url === '/api/v1/nodes/hub-1/apps/app-catalog/recipe_installed') {
          return json({ ok: true, result: { installed: { magpie: { version: '0.1.4265' } } } });
        }
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

    renderWizard({ certificates: [wildcardCert] });

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
        name: 'drive.example.com',
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
        if (url === '/api/v1/nodes/hub-1/apps/app-catalog/recipe_installed') {
          return json({ ok: true, result: { installed: {} } });
        }
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
          return json({ app: { app: 'caddy-site', schemaVersion: 1, config: { sites: [] }, rev: 1, appliedRev: 1, updatedAt: NOW } });
        }
        if (url === '/api/v1/nodes/hub-1/apps/caddy-site/apply') return json({ ok: true });
        return json({});
      }),
    );

    renderWizard();
    expect(await screen.findByText('magpie')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '选择并配置' }));

    await userEvent.type(screen.getByLabelText('发布域名'), 'plain.example.com');
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
});
