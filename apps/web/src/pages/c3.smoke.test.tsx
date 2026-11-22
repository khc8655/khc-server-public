// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from '../app/router';

const NOW = Math.floor(Date.now() / 1000);

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const node = {
  id: 'tyo-1',
  name: 'tyo-1',
  endpoint: 'https://203.0.113.10:8880',
  tunnelEndpoint: null,
              liveEndpoint: 'https://hub.example.com',
  preferredRoute: 'direct',
  status: 'online',
  lastSeenAt: NOW,
  createdAt: 1,
  updatedAt: 2,
};

const certificate = {
  id: 'cert_abc',
  name: 'blog-cert',
  domains: ['blog.example.dev'],
  issuer: 'selfsigned',
  notAfter: NOW + 5 * 24 * 3600,
  sourceNodeId: 'tyo-1',
  createdAt: NOW,
  updatedAt: NOW,
};

const settings = [{ key: 'dns.cloudflare', updatedAt: NOW }];

/** 观测面（浏览器直连）与 /state 快照共享同一份 Agent 状态。 */
function agentState() {
  return {
    host: { hostname: 'tyo-1' },
    adapters: [
      {
        name: 'caddy-site',
        version: '1.0.0',
        appliedRev: 1,
        status: {
          installed: true,
          running: true,
          sites: [{ name: 'blog', domain: 'blog.example.dev', active: true }],
        },
      },
    ],
    ports: [],
  };
}

const caddyConfig = {
  app: 'caddy-site',
  schemaVersion: 1,
  config: {
    sites: [
      {
        name: 'blog',
        domain: 'blog.example.dev',
        listenPort: 443,
        upstream: '10.99.0.2:8080',
        tls: { mode: 'manual', cert: { $cert: 'cert_abc' } },
        basicauth: { user: 'admin', passwordHash: '$2b$hash' },
        headers: { 'X-Frame-Options': 'DENY' },
        forceTls13: false,
        enabled: true,
      },
    ],
  },
  rev: 1,
  appliedRev: 1,
  updatedAt: NOW,
};

let requests: { url: string; init?: RequestInit }[] = [];
let serviceActive = true;
let extraCerts: Record<string, unknown>[] = [];

function mockApi() {
  requests = [];
  extraCerts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url === '/api/v1/nodes') return json({ nodes: [node] });
      if (url === '/api/v1/nodes/tyo-1') return json({ node });
      if (url.endsWith('/apps/caddy-site/caddy_service')) {
        return json({
          ok: true,
          result: {
            version: '2.8.4',
            active: serviceActive,
            unit: 'caddy.service',
            caddyfile: '/etc/caddy/Caddyfile',
          },
        });
      }
      if (url.endsWith('/apps/caddy-site/caddy_start')) {
        serviceActive = true;
        return json({ ok: true, result: { started: true, active: true } });
      }
      if (url.endsWith('/apps/caddy-site/caddy_validate')) {
        return json({ ok: true, result: { validate: { ok: true, rc: 0 } } });
      }
      if (url.endsWith('/apps/caddy-site/caddy_config')) {
        return json({
          ok: true,
          result: { caddyfile: '# main config', snippets: ['# managed snippet'] },
        });
      }
      if (url.endsWith('/apps/caddy-site/caddy_reload')) {
        return json({ ok: true, result: { ok: true } });
      }
      if (url.endsWith('/apps/certificates/issue_selfsigned')) {
        return json({
          ok: true,
          result: {
            certPem: '-----BEGIN CERTIFICATE-----SELFSIGNED',
            keyPem: '-----BEGIN PRIVATE KEY-----SELFSIGNED',
            notAfter: '2027-10-26T01:00:00Z',
            issuer: 'selfsigned',
            domains: ['blog.example.dev'],
          },
          cards: [{ title: '自签证书', value: 'blog.example.dev', copy: false, qr: false }],
        });
      }
      if (url === '/api/v1/certs' && init?.method === 'POST') {
        const created = {
          ...certificate,
          id: 'cert_new',
          name: 'new-cert',
          notAfter: 1819328400,
        };
        return json({ certificate: created });
      }
      if (url === '/api/v1/certs/issue-dns01' && init?.method === 'POST') {
        return json({
          certificate: {
            ...certificate,
            id: 'cert_cf1',
            name: 'wild-cf',
            domains: ['*.example.com'],
            issuer: 'acme',
            sourceNodeId: null,
            acmeProvider: 'cf-dns01',
            acmeCredentialKey: 'acc_1',
            acmeCa: 'letsencrypt',
            acmeKeyType: 'ec',
            renewable: true,
          },
        });
      }
      if (url === '/api/v1/cf-dns/accounts') {
        return json({
          accounts: [
            {
              id: 'acc_1',
              name: '主账号',
              accountName: 'Owner',
              hasToken: true,
              enabled: true,
              zones: [{ id: 'z1', name: 'example.com' }],
              enabledZoneIds: ['z1'],
            },
          ],
        });
      }
      if (url === '/api/v1/certs/cert_cf1/renew' && init?.method === 'POST') {
        return json({
          certificate: {
            ...certificate,
            id: 'cert_cf1',
            name: 'wild-cf',
            domains: ['*.example.com'],
            issuer: 'acme',
            sourceNodeId: null,
            acmeProvider: 'cf-dns01',
            acmeCredentialKey: 'acc_1',
            acmeCa: 'letsencrypt',
            acmeKeyType: 'ec',
            renewable: true,
            autoSync: true,
            notAfter: NOW + 90 * 86_400,
          },
          syncResults: [
            {
              nodeId: 'tyo-1',
              nodeName: 'tyo-1',
              status: 'synced',
              appliedApps: ['caddy-site'],
              tlsBound: false,
              error: null,
            },
          ],
        });
      }
      if (url === '/api/v1/certs/cert_cf1/usages') {
        return json({
          usages: [
            { nodeId: 'tyo-1', nodeName: 'tyo-1', apps: ['caddy-site'], isSourceNode: false },
          ],
        });
      }
      if (url === '/api/v1/certs/cert_cf1' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { autoSync: boolean };
        return json({
          certificate: {
            ...certificate,
            id: 'cert_cf1',
            name: 'wild-cf',
            domains: ['*.example.com'],
            issuer: 'acme',
            sourceNodeId: null,
            acmeProvider: 'cf-dns01',
            acmeCredentialKey: 'acc_1',
            acmeCa: 'letsencrypt',
            acmeKeyType: 'ec',
            renewable: true,
            autoSync: body.autoSync,
          },
        });
      }
      if (url === '/api/v1/certs/cert_cf1/sync' && init?.method === 'POST') {
        return json({
          results: [
            {
              nodeId: 'tyo-1',
              nodeName: 'tyo-1',
              status: 'synced',
              appliedApps: ['caddy-site'],
              tlsBound: false,
              error: null,
            },
            {
              nodeId: 'nd_off',
              nodeName: 'offline-vm',
              status: 'offline',
              appliedApps: [],
              tlsBound: false,
              error: '节点控制通道不可达',
            },
          ],
        });
      }
      if (/^\/api\/v1\/certs\/[^/]+\/usages$/.test(url)) {
        return json({ usages: [] });
      }
      if (url === '/api/v1/certs') return json({ certificates: extraCerts.length > 0 ? extraCerts : [certificate] });
      if (url === '/api/v1/settings') return json({ settings });
      if (url === '/api/v1/nodes/tyo-1/apps') {
        return json({
          apps: [caddyConfig],
          adapters: [{ name: 'caddy-site', version: '1.0.0', api: 1 }],
          adaptersError: null,
        });
      }
      if (url === '/api/v1/nodes/tyo-1/apps/caddy-site') {
        return json({ app: caddyConfig });
      }
      if (url === '/api/v1/nodes/tyo-1/state') {
        return json({
          reachable: true,
          route: 'direct',
          via: 'fetch',
          error: null,
          state: agentState(),
        });
      }
      return json({});
    }),
  );
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  serviceActive = true;
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
  return router;
}

describe('C3 页面', () => {
  it('全局 /certs 暗路由 302 到设置页证书 Tab', async () => {
    const router = await renderRoute('/certs');
    expect(await screen.findByRole('heading', { name: '设置' })).toBeTruthy();
    expect((await screen.findAllByText('blog-cert')).length).toBeGreaterThan(0);
    expect(router.state.location.pathname).toBe('/settings');
  });

  it('证书库展示列表与到期状态，并可打开签发抽屉', async () => {
    await renderRoute('/settings?tab=certs');
    expect(await screen.findByRole('heading', { name: '设置' })).toBeTruthy();
    expect((await screen.findAllByText('blog-cert')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('5 天后').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: '签发证书' }));
    expect((await screen.findAllByText('证书名称')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('域名').length).toBeGreaterThan(0);
  });

  it('设置页旧 tab 重定向与主动作统一', async () => {
    await renderRoute('/settings?tab=system');
    expect(await screen.findByRole('heading', { name: '设置' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: '签发证书' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '系统变量' })).toBeNull();

    cleanup();
    await renderRoute('/settings?tab=domains');
    expect(await screen.findByRole('heading', { name: '设置' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '域名管理' }).getAttribute('aria-pressed')).toBe('true');
    });

    cleanup();
    await renderRoute('/settings?tab=cloudflare');
    expect(await screen.findByRole('heading', { name: '设置' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '账号' }).getAttribute('aria-pressed')).toBe('true');
    });

    cleanup();
    await renderRoute('/settings?tab=catalog');
    expect(await screen.findByRole('heading', { name: '设置' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '应用管理' }).getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('应用页展示站点、证书引用与运行状态', async () => {
    await renderRoute('/hubs/tyo-1/sites');
    expect(await screen.findByRole('heading', { name: '应用' })).toBeTruthy();
    expect((await screen.findAllByText('blog.example.dev')).length).toBeGreaterThan(0);
    // 健康状态并入名称左侧圆点；表格保留同步状态列。
    expect((await screen.findAllByText('已同步')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('反代').length).toBeGreaterThan(0);
    expect(screen.getAllByText('全局证书库').length).toBeGreaterThan(0);
    // 即使节点带 liveEndpoint，也统一经 Worker /snapshot，不再发 /live-ticket 或 /_live/。
    await waitFor(() => {
      expect(requests.some((item) => item.url === '/api/v1/nodes/tyo-1/snapshot')).toBe(true);
    });
    expect(
      requests.some((item) => item.url.includes('/live-ticket') || item.url.includes('/_live/')),
    ).toBe(false);
  });

  it('自签签发流程：Agent ISO 到期时间转 epoch 后入库', async () => {
    await renderRoute('/settings?tab=certs');
    await screen.findByRole('heading', { name: '设置' });

    await userEvent.click(screen.getByRole('button', { name: '签发证书' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: '自签' }));
    await userEvent.type(within(dialog).getByLabelText('证书名称'), 'new-cert');
    await userEvent.type(within(dialog).getByLabelText('域名'), 'blog.example.dev');
    await userEvent.click(within(dialog).getByRole('button', { name: '签发' }));

    expect(await screen.findByText('证书已入库')).toBeTruthy();
    const post = requests.find(
      (item) => item.url === '/api/v1/certs' && item.init?.method === 'POST',
    );
    expect(post).toBeTruthy();
    const body = JSON.parse(String(post?.init?.body)) as {
      issuer: string;
      notAfter: number;
      certPem: string;
      keyPem: string;
    };
    expect(body.issuer).toBe('selfsigned');
    expect(body.certPem).toContain('BEGIN CERTIFICATE');
    expect(body.keyPem).toContain('BEGIN PRIVATE KEY');
    expect(body.notAfter).toBe(Math.floor(Date.parse('2027-10-26T01:00:00Z') / 1000));
  });

  it('控制面 Cloudflare DNS-01 签发全局通配符证书（无需节点）', async () => {
    await renderRoute('/settings?tab=certs');
    await screen.findByRole('heading', { name: '设置' });

    await userEvent.click(screen.getByRole('button', { name: '签发证书' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => {
      expect((within(dialog).getByLabelText('Cloudflare 账号') as HTMLSelectElement).value).toBe('acc_1');
    });
    expect(within(dialog).queryByLabelText('节点')).toBeNull();

    await userEvent.type(within(dialog).getByLabelText('证书名称'), 'wild-cf');
    await userEvent.type(within(dialog).getByLabelText('域名'), '*.example.com');
    await userEvent.click(within(dialog).getByRole('button', { name: '签发' }));

    expect(await screen.findByText('证书已入库')).toBeTruthy();
    const post = requests.find(
      (item) => item.url === '/api/v1/certs/issue-dns01' && item.init?.method === 'POST',
    );
    expect(post).toBeTruthy();
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      name: 'wild-cf',
      domains: ['*.example.com'],
      accountId: 'acc_1',
      ca: 'letsencrypt',
    });
  });

  it('CF DNS-01 全球证书详情展示面板 DNS-01 来源并支持一键续期', async () => {
    extraCerts = [
      {
        ...certificate,
        id: 'cert_cf1',
        name: 'wild-cf',
        domains: ['*.example.com'],
        issuer: 'acme',
        sourceNodeId: null,
        acmeProvider: 'cf-dns01',
        acmeCredentialKey: 'acc_1',
        acmeCa: 'letsencrypt',
        acmeKeyType: 'ec',
        renewable: true,
      },
    ];
    await renderRoute('/settings?tab=certs');
    await userEvent.click((await screen.findAllByText('wild-cf'))[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText('面板 DNS-01').length).toBeGreaterThan(0);

    await userEvent.click(within(dialog).getByRole('button', { name: '续期' }));
    expect(await screen.findByText('证书已续期')).toBeTruthy();
    expect(
      requests.some(
        (item) => item.url === '/api/v1/certs/cert_cf1/renew' && item.init?.method === 'POST',
      ),
    ).toBe(true);
  });

  it('S4：开启自动同步、手动同步回执（含离线重试）及 ?drawer=cert:<id> 直达详情', async () => {
    extraCerts = [
      {
        ...certificate,
        id: 'cert_cf1',
        name: 'wild-cf',
        domains: ['*.example.com'],
        issuer: 'acme',
        sourceNodeId: null,
        acmeProvider: 'cf-dns01',
        acmeCredentialKey: 'acc_1',
        acmeCa: 'letsencrypt',
        acmeKeyType: 'ec',
        renewable: true,
        autoSync: false,
      },
    ];
    await renderRoute('/settings?tab=certs&drawer=cert%3Acert_cf1');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('wild-cf')).toBeTruthy();
    expect(await within(dialog).findByText('tyo-1')).toBeTruthy();
    expect(within(dialog).getAllByText('caddy-site').length).toBeGreaterThan(0);

    const autoSyncToggle = within(dialog).getByRole('switch', { name: '续期后自动同步到关联 Hub' });
    await userEvent.click(autoSyncToggle);
    expect(await screen.findByText('自动同步设置已更新')).toBeTruthy();
    expect(
      requests.some(
        (item) => item.url === '/api/v1/certs/cert_cf1' && item.init?.method === 'PATCH',
      ),
    ).toBe(true);

    await userEvent.click(within(dialog).getByRole('button', { name: '同步到关联 Hub' }));
    expect(await within(dialog).findByText('已同步')).toBeTruthy();
    expect(await within(dialog).findByText('节点离线')).toBeTruthy();
    expect(within(dialog).getByText('offline-vm')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: '重试同步' })).toBeTruthy();
  });

  it('Caddy 服务抽屉展示状态并导出配置', async () => {
    await renderRoute('/hubs/tyo-1/sites');
    await screen.findByRole('heading', { name: '应用' });

    await userEvent.click(screen.getByRole('button', { name: 'Caddy 服务' }));
    expect(await screen.findByText('服务状态')).toBeTruthy();
    expect(await screen.findByText('2.8.4')).toBeTruthy();
    expect(screen.getAllByText('通过').length).toBeGreaterThan(0);

    const exportButton = screen.getAllByRole('button', { name: '导出配置' })[0];
    if (!exportButton) throw new Error('missing export button');
    await userEvent.click(exportButton);
    const dialogs = await screen.findAllByRole('dialog');
    const confirm = dialogs.find((dialog) => dialog.textContent?.includes('导出 Caddy 配置'));
    if (!confirm) throw new Error('missing export confirm dialog');
    await userEvent.click(within(confirm).getByRole('button', { name: '导出配置' }));
    expect(await screen.findByText('主 Caddyfile')).toBeTruthy();
    expect(await screen.findByText(/# main config/)).toBeTruthy();
  });

  it('Caddy 服务未运行时提供「启动 Caddy」而不是只能重载', async () => {
    serviceActive = false;
    await renderRoute('/hubs/tyo-1/sites');
    await screen.findByRole('heading', { name: '应用' });

    await userEvent.click(screen.getByRole('button', { name: 'Caddy 服务' }));
    expect(await screen.findByText('服务状态')).toBeTruthy();

    const startButton = await screen.findByRole('button', { name: '启动 Caddy' });
    expect(screen.queryByRole('button', { name: '重载 Caddy' })).toBeNull();

    await userEvent.click(startButton);
    const dialogs = await screen.findAllByRole('dialog');
    const confirm = dialogs.find((dialog) => dialog.textContent?.includes('启动 Caddy？'));
    if (!confirm) throw new Error('missing start confirm dialog');
    await userEvent.click(within(confirm).getByRole('button', { name: '启动 Caddy' }));
    await screen.findByText('Caddy 已启动');
    expect(requests.some((item) => item.url.endsWith('/apps/caddy-site/caddy_start'))).toBe(true);
    // 启动走页面级确认：服务抽屉先关闭；重新打开后应显示「重载 Caddy」。
    await userEvent.click(screen.getByRole('button', { name: 'Caddy 服务' }));
    expect(await screen.findByRole('button', { name: '重载 Caddy' })).toBeTruthy();
  });

  it('站点抽屉按类型显示字段并可清空站点', async () => {
    await renderRoute('/hubs/tyo-1/sites');
    await screen.findByRole('heading', { name: '应用' });

    await userEvent.click(screen.getByRole('button', { name: '添加站点' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getAllByText('反代').length).toBeGreaterThan(0);
    await userEvent.selectOptions(within(drawer).getByLabelText('类型'), 'static');
    expect(await within(drawer).findByText('根目录')).toBeTruthy();
    await userEvent.selectOptions(within(drawer).getByLabelText('类型'), 'redirect');
    expect(await within(drawer).findByText('跳转目标')).toBeTruthy();
    await userEvent.click(within(drawer).getByRole('button', { name: '取消' }));

    // 清空站点按钮收进表格下方「高级」折叠区（ui-redesign ⑤）
    await userEvent.click(screen.getByRole('button', { name: '高级' }));
    await userEvent.click(screen.getByRole('button', { name: '清空站点' }));
    expect(await screen.findByText('清空所有站点？')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
  });

  it('站点抽屉可打开并显示证书引用字段', async () => {
    await renderRoute('/hubs/tyo-1/sites');
    await screen.findByRole('heading', { name: '应用' });

    await userEvent.click(screen.getByRole('button', { name: '添加站点' }));
    expect((await screen.findAllByText('上游地址')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('对外端口').length).toBeGreaterThan(0);

    const drawer = screen.getAllByRole('dialog').at(-1);
    if (!drawer) throw new Error('missing site drawer');
    expect(within(drawer).queryByText('站点名称')).toBeNull();
    await userEvent.selectOptions(within(drawer).getByLabelText('TLS 模式'), 'manual');
    expect(within(drawer).getByLabelText('证书')).toBeTruthy();
    expect(within(drawer).getAllByText(/blog.example.dev · 5 天后/).length).toBeGreaterThan(0);

    // 安全分组收进抽屉「高级」折叠区（ui-redesign ⑤）；已移除「启用观测入口」开关
    await userEvent.click(within(drawer).getByRole('button', { name: '高级' }));
    expect(within(drawer).queryByText('启用观测入口')).toBeNull();
    await userEvent.click(within(drawer).getByRole('button', { name: '添加响应头' }));
    expect(within(drawer).getByLabelText('响应头名称')).toBeTruthy();
    await userEvent.click(within(drawer).getByRole('button', { name: '添加路径' }));
    expect(within(drawer).getByLabelText('路径')).toBeTruthy();
  });
});
