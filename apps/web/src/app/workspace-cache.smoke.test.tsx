// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import type { NodeStateResponse } from '@khc/contracts';
import { createAppRouter } from './router';
import { zh } from '../i18n/zh';

const NOW = Math.floor(Date.now() / 1000);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const baseNode = {
  id: 'tyo-1',
  name: 'tyo-1',
  endpoint: 'https://hub.example.com',
  tunnelEndpoint: null,
  liveEndpoint: 'https://hub.example.com',
  domain: 'hub.example.com',
  preferredRoute: 'direct',
  status: 'online',
  lastSeenAt: NOW,
  createdAt: 1,
  updatedAt: 2,
};

const emptyOverview = {
  apps: { online: 1, total: 1, issues: [], staticCount: 0, redirectCount: 0, items: [] },
  peers: { enabled: true, online: 1, total: 1, offline: [], interfaceName: 'wg0', listenPort: 51820, items: [] },
  forwards: { total: 0, tcpCount: 0, udpCount: 0, items: [] },
  certs: { count: 0, soonestDaysLeft: null, expiring: [] },
  accessCert: { daysLeft: 45, tlsState: 'verified' },
  host: { hostname: 'hub-tyo', os: 'Debian 12', kernel: '6.1.0', uptime: 3600, agentVersion: '0.7.0' },
  managedServices: [],
  failedUnits: null,
};

function makeState(hostname: string) {
  return {
    host: { hostname, os: 'Debian 12', kernel: '6.1.0', uptime: 3600 },
    agent: { version: '0.7.0', serverTime: NOW },
    adapters: [
      {
        name: 'caddy-site',
        version: '1.0.0',
        status: {
          installed: true,
          running: true,
          sites: [{ name: 'blog', domain: 'blog.example.dev', active: true }],
        },
      },
      {
        name: 'wireguard',
        version: '1.0.0',
        status: { installed: true, running: true, peers: [] },
      },
      { name: 'host-ops', version: '1.0.0', status: {} },
    ],
    ports: [],
    ops: {
      cpu: { usagePercent: 12, load: [0.1, 0.2, 0.3] },
      mem: { total: 1000, used: 400, percent: 40 },
      disks: [{ total: 1000, used: 300, percent: 30 }],
      services: { services: [{ name: 'caddy', state: 'active' }], failedUnits: [] },
    },
  };
}

interface RecordedRequest {
  url: string;
  method: string;
  verb?: string;
}

interface MockControls {
  overviewReachable: boolean;
  overviewError: string | null;
  overviewHostname: string;
  svcListFail: boolean;
  holdNextSvcList: boolean;
  resolveHeldSvcList: (() => void) | null;
  snapshotSeq: number;
  requests: RecordedRequest[];
}

function defaultControls(): MockControls {
  return {
    overviewReachable: true,
    overviewError: null,
    overviewHostname: 'hub-tyo',
    svcListFail: false,
    holdNextSvcList: false,
    resolveHeldSvcList: null,
    snapshotSeq: 0,
    requests: [],
  };
}

function createFetchMock(ctrl: MockControls) {
  let caddyRev = 1;
  let caddyAppliedRev = 1;
  let caddySites: Record<string, unknown>[] = [
    {
      name: 'blog',
      domains: ['blog.example.dev'],
      listenPort: 443,
      kind: 'proxy',
      upstreams: ['10.99.0.2:8080'],
      enabled: true,
    },
  ];
  const caddyRecord = () => ({
    app: 'caddy-site',
    schemaVersion: 1,
    config: { sites: caddySites },
    rev: caddyRev,
    appliedRev: caddyAppliedRev,
    updatedAt: NOW,
  });
  const wgRecord = {
    app: 'wireguard',
    schemaVersion: 1,
    config: {
      interface: {
        name: 'wg0',
        address: '10.99.0.1/24',
        listenPort: 51820,
        privateKey: '',
        publicKey: 'HUBPUB',
        mtu: 1420,
        extIface: 'eth0',
        publicEndpoint: '',
        postUp: '',
        postDown: '',
      },
      peers: [],
    },
    rev: 1,
    appliedRev: 1,
    updatedAt: NOW,
  };
  const hostOpsRecord = {
    app: 'host-ops',
    schemaVersion: 1,
    config: { peers: {} },
    rev: 1,
    appliedRev: 1,
    updatedAt: NOW,
  };

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    let verb: string | undefined;
    if (url.endsWith('/apps/host-ops/call') && init?.body) {
      const parsed = JSON.parse(String(init.body)) as { params?: { verb?: string } };
      verb = parsed.params?.verb;
    }
    ctrl.requests.push({ url, method, ...(verb ? { verb } : {}) });

    if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
    if (url === '/api/v1/nodes') return json({ nodes: [baseNode] });
    if (url === '/api/v1/certs') return json({ certificates: [] });
    if (url === '/api/v1/settings') return json({ settings: [] });
    if (url === '/api/v1/diagnostics/hints') {
      return json({ hintsVersion: '2026-10-29.1', hints: [] });
    }
    if (url === '/api/v1/agent/releases') {
      return json({ releases: [{ version: '0.7.0', publishedAt: NOW }] });
    }

    if (url === '/api/v1/nodes/tyo-1/overview') {
      return json({
        node: baseNode,
        reachable: ctrl.overviewReachable,
        route: ctrl.overviewReachable ? 'direct' : null,
        via: ctrl.overviewReachable ? 'fetch' : null,
        error: ctrl.overviewError,
        state: ctrl.overviewReachable ? makeState(ctrl.overviewHostname) : null,
        overview: emptyOverview,
      });
    }
    if (url === '/api/v1/nodes/tyo-1/snapshot') {
      ctrl.snapshotSeq += 1;
      return json({
        reachable: true,
        route: 'direct',
        via: 'fetch',
        error: null,
        snapshot: {
          ts: NOW + ctrl.snapshotSeq,
          host: { hostname: ctrl.overviewHostname, uptime: 3600 + ctrl.snapshotSeq },
          ops: {
            cpu: { usagePercent: 12, load: [0.1, 0.2, 0.3] },
            mem: { total: 1000, used: 400, percent: 40 },
            disks: [{ total: 1000, used: 300, percent: 30 }],
            services: { services: [{ name: 'caddy', state: 'active' }], failedUnits: [] },
          },
        },
      });
    }

    if (url === '/api/v1/nodes/tyo-1/apps') {
      return json({
        apps: [caddyRecord(), wgRecord, hostOpsRecord],
        adapters: [
          { name: 'caddy-site', version: '1.0.0', api: 1 },
          { name: 'wireguard', version: '1.0.0', api: 1 },
          { name: 'host-ops', version: '1.0.0', api: 1 },
        ],
        adaptersError: null,
      });
    }
    if (url === '/api/v1/nodes/tyo-1/apps/caddy-site') {
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { config?: { sites?: Record<string, unknown>[] } };
        caddySites = body.config?.sites ?? caddySites;
        caddyRev += 1;
      }
      return json({ app: caddyRecord() });
    }
    if (url === '/api/v1/nodes/tyo-1/apps/caddy-site/apply') {
      caddyAppliedRev = caddyRev;
      ctrl.overviewHostname = 'hub-tyo-after-apply';
      return json({ ok: true, result: {} });
    }
    if (url === '/api/v1/nodes/tyo-1/apps/caddy-site/caddy_import_scan') {
      return json({
        ok: true,
        result: { exists: true, caddyfilePath: '/etc/caddy/Caddyfile', blocks: [], imports: [], backups: [] },
      });
    }
    if (url === '/api/v1/nodes/tyo-1/apps/wireguard') return json({ app: wgRecord });
    if (url === '/api/v1/nodes/tyo-1/apps/host-ops') return json({ app: hostOpsRecord });
    if (url === '/api/v1/nodes/tyo-1/apps/port-forward') {
      return json({
        app: {
          app: 'port-forward',
          schemaVersion: 1,
          config: { forwards: [] },
          rev: 1,
          appliedRev: 1,
          updatedAt: NOW,
        },
      });
    }

    if (url === '/api/v1/nodes/tyo-1/apps/host-ops/call') {
      if (verb === 'svc.list') {
        const makePayload = () =>
          ctrl.svcListFail
            ? json({ ok: false, error: { code: 'E_SVC', message: 'systemctl 失败' } })
            : json({
                ok: true,
                data: {
                  services: [
                    { unit: 'caddy.service', load: 'loaded', active: 'active', sub: 'running', description: 'Caddy' },
                    { unit: 'ssh.service', load: 'loaded', active: 'active', sub: 'running', description: 'OpenSSH' },
                  ],
                  count: 2,
                },
              });
        if (ctrl.holdNextSvcList) {
          ctrl.holdNextSvcList = false;
          return new Promise<Response>((resolve) => {
            ctrl.resolveHeldSvcList = () => resolve(makePayload());
          });
        }
        return makePayload();
      }
      if (verb === 'cron.list') {
        return json({
          ok: true,
          data: {
            dir: '/etc/cron.d',
            available: true,
            writable: true,
            managed: [{ name: 'backup', file: 'khc-backup', enabled: true, lines: ['0 2 * * * root /usr/local/bin/backup'] }],
            unmanaged: [],
          },
        });
      }
      if (verb === 'snapshot') {
        return json({
          ok: true,
          data: {
            hostname: 'hub-tyo',
            uptime: 3600,
            root: true,
            processes: [
              { pid: 42, ppid: 1, name: 'caddy', user: 'root', cpu: 1.5, mem: 32, startTime: 100, cmdline: 'caddy run' },
            ],
          },
        });
      }
      if (verb === 'version') {
        return json({ ok: true, data: { version: '1.4.0', python: '3.11', root: true, nft: true } });
      }
      if (verb === 'keys.list') {
        return json({
          ok: true,
          data: {
            keys: [{ fingerprint: 'SHA256:managed', type: 'ssh-ed25519', comment: 'pc', managed: true }],
          },
        });
      }
      if (verb === 'svc.restart') {
        return json({ ok: true, data: { unit: 'caddy.service', restarted: true, active: true } });
      }
      return json({ ok: true, data: {} });
    }

    return json({});
  });
}

async function renderApp(pathToRender: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: [pathToRender] }));
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return Object.assign(rendered, { queryClient, router });
}

function countUrl(reqs: RecordedRequest[], suffix: string, method = 'GET'): number {
  return reqs.filter((r) => r.method === method && r.url === suffix).length;
}

function countVerb(reqs: RecordedRequest[], verb: string): number {
  return reqs.filter((r) => r.verb === verb).length;
}

let ctrl: MockControls;

beforeEach(() => {
  window.scrollTo = vi.fn();
  ctrl = defaultControls();
  vi.stubGlobal('fetch', createFetchMock(ctrl));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function firstLink(name: string): HTMLElement {
  const link = screen.getAllByRole('link', { name })[0];
  if (!link) throw new Error(`missing link: ${name}`);
  return link;
}

describe('B2 工作区单一入口、运维分段缓存与写后精确刷新', () => {
  it('1. 进工作区后切换各页签（含 apps/$app 并返回概况）：只发 1 次 /overview，0 次 /state 与 /nodes/:id', async () => {
    const { router } = await renderApp('/hubs/tyo-1');
    await screen.findByText('Agent v0.7.0');

    await userEvent.click(firstLink('应用'));
    await screen.findByRole('button', { name: '添加站点' });

    await userEvent.click(firstLink('网络'));
    await waitFor(() => expect(router.state.location.pathname).toContain('/wireguard'));

    await userEvent.click(firstLink('主机'));
    await screen.findAllByText('caddy.service');

    await userEvent.click(firstLink('设置'));
    await screen.findByRole('heading', { name: '设置' });

    await router.navigate({ to: '/hubs/$hubId/apps/$app', params: { hubId: 'tyo-1', app: 'caddy-site' } });
    await router.navigate({ to: '/hubs/$hubId', params: { hubId: 'tyo-1' } });
    await screen.findByText('Agent v0.7.0');

    expect(countUrl(ctrl.requests, '/api/v1/nodes/tyo-1/overview')).toBe(1);
    expect(countUrl(ctrl.requests, '/api/v1/nodes/tyo-1/state')).toBe(0);
    expect(countUrl(ctrl.requests, '/api/v1/nodes/tyo-1')).toBe(0);
  });

  it('2. 深链直达 /hubs/:id/ops：仅发 1 次 /overview，0 次 /state 与 /nodes/:id', async () => {
    await renderApp('/hubs/tyo-1/ops');
    await screen.findAllByText('caddy.service');

    expect(countUrl(ctrl.requests, '/api/v1/nodes/tyo-1/overview')).toBe(1);
    expect(countUrl(ctrl.requests, '/api/v1/nodes/tyo-1/state')).toBe(0);
    expect(countUrl(ctrl.requests, '/api/v1/nodes/tyo-1')).toBe(0);
  });

  it('3. Caddy 应用生效成功：触发 /overview 重拉并同步回填 stateQuery 缓存', async () => {
    const { queryClient } = await renderApp('/hubs/tyo-1/sites');
    await screen.findAllByText(/https:\/\/blog\.example\.dev/);
    expect(countUrl(ctrl.requests, '/api/v1/nodes/tyo-1/overview')).toBe(1);
    expect(queryClient.getQueryData<NodeStateResponse>(['hubs', 'tyo-1', 'state'])?.state?.host?.hostname).toBe(
      'hub-tyo',
    );

    await userEvent.click(screen.getByRole('button', { name: '添加站点' }));
    const drawer = await screen.findByRole('dialog');
    await userEvent.type(within(drawer).getByLabelText(/^域名/), 'app.example.dev');
    const port = within(drawer).getByLabelText(/^本机监听端口/) as HTMLInputElement;
    await userEvent.clear(port);
    await userEvent.type(port, '9000');
    await userEvent.click(within(drawer).getByRole('button', { name: '保存并生效' }));

    await waitFor(() => expect(countUrl(ctrl.requests, '/api/v1/nodes/tyo-1/overview')).toBe(2));
    expect(countUrl(ctrl.requests, '/api/v1/nodes/tyo-1/state')).toBe(0);
    expect(queryClient.getQueryData<NodeStateResponse>(['hubs', 'tyo-1', 'state'])?.state?.host?.hostname).toBe(
      'hub-tyo-after-apply',
    );
  });

  it('4. D-03 自动补探：/overview 不可达后随 /snapshot 新帧补探，最多 3 次封顶', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', undefined);
    ctrl.overviewReachable = false;
    ctrl.overviewError = 'connect timeout';

    await renderApp('/hubs/tyo-1');
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(countUrl(ctrl.requests, '/api/v1/nodes/tyo-1/snapshot')).toBeGreaterThanOrEqual(4);
    expect(countUrl(ctrl.requests, '/api/v1/nodes/tyo-1/overview')).toBe(4);

    // 继续到达多个 /snapshot 新帧也不再超过 3 次补探
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(countUrl(ctrl.requests, '/api/v1/nodes/tyo-1/snapshot')).toBeGreaterThanOrEqual(6);
    expect(countUrl(ctrl.requests, '/api/v1/nodes/tyo-1/overview')).toBe(4);
    expect(countUrl(ctrl.requests, '/api/v1/nodes/tyo-1/state')).toBe(0);
  });

  it('5. 主机运维分段 30s 缓存：切段再回不重发，超 30s 再进入重拉', async () => {
    let fakeNow = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);

    await renderApp('/hubs/tyo-1/ops');
    await screen.findAllByText('caddy.service');
    await userEvent.click(await screen.findByRole('button', { name: '定时任务' }));
    await screen.findAllByText('backup');
    await userEvent.click(await screen.findByRole('button', { name: '进程' }));
    await screen.findAllByText('caddy run');
    await userEvent.click(await screen.findByRole('button', { name: 'SSH 公钥' }));
    await screen.findAllByText('SHA256:managed');
    await userEvent.click(await screen.findByRole('button', { name: '服务' }));
    await screen.findAllByText('caddy.service');

    expect(countVerb(ctrl.requests, 'svc.list')).toBe(1);
    expect(countVerb(ctrl.requests, 'cron.list')).toBe(1);
    expect(countVerb(ctrl.requests, 'snapshot')).toBe(1);
    expect(countVerb(ctrl.requests, 'version')).toBe(1);
    expect(countVerb(ctrl.requests, 'keys.list')).toBe(1);

    // 30s 内切回定时任务仍命中缓存
    fakeNow += 15_000;
    await userEvent.click(await screen.findByRole('button', { name: '定时任务' }));
    expect(countVerb(ctrl.requests, 'cron.list')).toBe(1);

    // 超过 30s 后切回服务应重新请求 svc.list
    fakeNow += 20_000;
    await userEvent.click(await screen.findByRole('button', { name: '服务' }));
    await waitFor(() => expect(countVerb(ctrl.requests, 'svc.list')).toBe(2));
  });

  it('6. host-ops 读失败不缓存：展示错误，切走再切回重新请求', async () => {
    ctrl.svcListFail = true;
    await renderApp('/hubs/tyo-1/ops');
    await screen.findByText(zh.hostOps.errors.E_UNKNOWN);
    await userEvent.click(screen.getByRole('button', { name: zh.hostOps.detailsShow }));
    await screen.findByText(/systemctl 失败/);
    expect(countVerb(ctrl.requests, 'svc.list')).toBe(1);

    await userEvent.click(await screen.findByRole('button', { name: '进程' }));
    await screen.findAllByText('caddy run');

    ctrl.svcListFail = false;
    await userEvent.click(await screen.findByRole('button', { name: '服务' }));
    await waitFor(() => expect(countVerb(ctrl.requests, 'svc.list')).toBe(2));
    await screen.findAllByText('caddy.service');
  });

  it('7. 服务重启后置请求只含 svc.list + 2.1s 后单次 /snapshot，无 /state 或 /overview', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', undefined);

    await renderApp('/hubs/tyo-1/ops');
    await vi.advanceTimersByTimeAsync(100);
    expect(screen.getAllByText('caddy.service').length).toBeGreaterThan(0);
    expect(countUrl(ctrl.requests, '/api/v1/nodes/tyo-1/snapshot')).toBe(1);

    const caddyRow = screen
      .getAllByText('caddy.service')
      .map((el) => el.closest('tr'))
      .find((el): el is HTMLTableRowElement => el !== null);
    if (!caddyRow) throw new Error('missing caddy row');

    fireEvent.click(within(caddyRow).getByRole('button', { name: '更多操作' }));
    await vi.advanceTimersByTimeAsync(10);
    fireEvent.click(screen.getByRole('menuitem', { name: '重启' }));
    await vi.advanceTimersByTimeAsync(10);

    const confirm = screen.getByRole('dialog');
    const mark = ctrl.requests.length;
    fireEvent.click(within(confirm).getByRole('button', { name: '重启' }));
    await vi.advanceTimersByTimeAsync(100);

    const immediateTail = ctrl.requests.slice(mark);
    expect(countVerb(immediateTail, 'svc.restart')).toBe(1);
    expect(countVerb(immediateTail, 'svc.list')).toBe(1);
    // live.lastAt 距今不足 2.1s 时，/snapshot 延迟等待，不立即发出
    expect(countUrl(immediateTail, '/api/v1/nodes/tyo-1/snapshot')).toBe(0);
    expect(countUrl(immediateTail, '/api/v1/nodes/tyo-1/state')).toBe(0);
    expect(countUrl(immediateTail, '/api/v1/nodes/tyo-1/overview')).toBe(0);

    await vi.advanceTimersByTimeAsync(2_100);
    const fullTail = ctrl.requests.slice(mark);
    expect(countVerb(fullTail, 'svc.restart')).toBe(1);
    expect(countVerb(fullTail, 'svc.list')).toBe(1);
    expect(countUrl(fullTail, '/api/v1/nodes/tyo-1/snapshot')).toBe(1);
    expect(countUrl(fullTail, '/api/v1/nodes/tyo-1/state')).toBe(0);
    expect(countUrl(fullTail, '/api/v1/nodes/tyo-1/overview')).toBe(0);
  });

  it('8. 有缓存数据时手动刷新保留已有列表，不闪回 Skeleton', async () => {
    await renderApp('/hubs/tyo-1/ops');
    await screen.findAllByText('caddy.service');

    ctrl.holdNextSvcList = true;
    await userEvent.click(screen.getByRole('button', { name: '刷新' }));

    await waitFor(() => expect(ctrl.resolveHeldSvcList).not.toBeNull());
    expect(screen.getAllByText('caddy.service').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('.ui-skeleton').length).toBe(0);

    ctrl.resolveHeldSvcList?.();
    await waitFor(() => expect(countVerb(ctrl.requests, 'svc.list')).toBe(2));
  });

  it('9. 源码静态扫描：非 HubChannelsProvider 不读 stateQuery 且全仓无 hubs/*/state invalidateQueries', () => {
    const modules = import.meta.glob(['../**/*.ts', '../**/*.tsx'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;

    const forbiddenStateProps: string[] = [];
    const forbiddenInvalidate: string[] = [];
    const entries = Object.entries(modules).filter(
      ([file]) => !/\.(test|smoke\.test)\.(ts|tsx)$/.test(file),
    );
    expect(entries.length).toBeGreaterThan(20);

    for (const [file, content] of entries) {
      if (file !== './HubChannelsProvider.tsx' && /stateQuery\.(refetch|isLoading|error)\b/.test(content)) {
        forbiddenStateProps.push(file);
      }
      if (/invalidateQueries\(\s*\{[\s\S]{0,160}?['"]hubs['"][\s\S]{0,80}?['"]state['"]/.test(content)) {
        forbiddenInvalidate.push(file);
      }
    }

    expect(forbiddenStateProps).toEqual([]);
    expect(forbiddenInvalidate).toEqual([]);
  });
});
