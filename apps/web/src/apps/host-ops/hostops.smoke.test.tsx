// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from '../../app/router';

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

const agentState = {
  reachable: true,
  route: 'direct',
  via: 'fetch',
  error: null,
  state: {
    host: { hostname: 'hub-tyo', os: 'Debian 12', kernel: '6.1.0', uptime: 3600 },
    adapters: [
      { name: 'wireguard', version: '1.0.0', status: { installed: true, running: true } },
      { name: 'host-ops', version: '1.0.0', status: {} },
    ],
    ports: [],
    ops: {
      cpu: { usagePercent: 12, load: [0.1, 0.2, 0.3] },
      mem: { total: 1000, used: 400, percent: 40 },
      disks: [{ total: 1000, used: 300, percent: 30 }],
      services: { services: [{ name: 'caddy', state: 'active' }], failedUnits: [] },
    },
  },
};

const wgConfig = {
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
    peers: [
      {
        name: 'peer-1',
        publicKey: 'PEERPUB',
        privateKey: '',
        allowedIps: ['10.99.0.2/32'],
        keepalive: 25,
        endpoint: null,
        enabled: true,
      },
    ],
  },
  rev: 1,
  appliedRev: 1,
  updatedAt: NOW,
};

let hostOpsConfig: Record<string, unknown> = { peers: {} };
let hostOpsConfigExists = false;
let taskState: 'done' | 'error' | 'running' = 'done';
let removedManagedKey = false;
/** 模拟发行版自带单元失败（真机 aws-hui-us 上的 fwupd / apt-daily-upgrade 就是这个形态）。 */
let systemUnitFailed = false;
let userAppServiceIncluded = false;
let requests: { url: string; init?: RequestInit }[] = [];
type LogsErrorsMode = 'data' | 'empty' | 'error' | 'loading';
let logsErrorsMode: LogsErrorsMode = 'data';
let logsErrorsHold: ((response: Response) => void) | null = null;
let versionNft = true;
let versionNftInstallable = false;
let versionNftReason: string | null = null;
let fwShowUnsupported = false;
let fwModeState: 'open' | 'allowlist' = 'open';
let fwClosePublicSshState = false;
let tuneErrorMode = false;
let tuneSwapState = {
  active: false,
  managed: false,
  external: false,
  totalBytes: 0,
  usedBytes: 0,
  percent: 0,
  memTotalBytes: 1024 * 1024 * 1024,
  rootFreeBytes: 20 * 1024 * 1024 * 1024,
  swappiness: 60,
  sources: [] as string[],
};
let tuneBbrState = {
  supported: true,
  enabled: false,
  congestionControl: 'cubic',
  qdisc: 'fq_codel',
};
let tuneJournalState = {
  available: true,
  usedBytes: 320 * 1024 * 1024,
  maxUse: null as string | null,
  managed: false,
};
let tuneAptState = {
  available: true,
  cacheBytes: 180 * 1024 * 1024,
};
let lastCallTaskVerb = '';

const logsErrorsPayload = {
  windowHours: 24,
  count: 2,
  entries: [
    {
      time: NOW - 120,
      priority: '3',
      level: 'err',
      message: 'caddy.service: 连接上游失败 password=[REDACTED]',
    },
    { time: NOW - 300, priority: '2', level: 'crit', message: 'khc-agent: 证书校验失败' },
  ],
  oom: [
    {
      time: NOW - 600,
      priority: '3',
      level: 'oom',
      message: 'Out of memory: Killed process 123 (yes)',
    },
  ],
  oomCount: 1,
};

function logsErrorsCalls(): { url: string; init?: RequestInit }[] {
  return requests.filter((item) => {
    if (!item.url.endsWith('/apps/host-ops/call') || !item.init?.body) return false;
    try {
      const body = JSON.parse(String(item.init.body)) as { params?: { verb?: string } };
      return body.params?.verb === 'logs.errors';
    } catch {
      return false;
    }
  });
}

function hostOpsApp() {
  return {
    app: 'host-ops',
    schemaVersion: 1,
    config: hostOpsConfig,
    rev: 1,
    appliedRev: 1,
    updatedAt: NOW,
  };
}

const emptyOverview = {
  apps: { online: 0, total: 0, issues: [], staticCount: 0, redirectCount: 0, items: [] },
  peers: { enabled: false, online: 0, total: 0, offline: [], interfaceName: null, listenPort: null, items: [] },
  forwards: { total: 0, tcpCount: 0, udpCount: 0, items: [] },
  certs: { count: 0, soonestDaysLeft: null, expiring: [] },
  accessCert: { daysLeft: null, tlsState: 'none' },
  host: null,
  managedServices: [],
  failedUnits: null,
};

function mockApi() {
  hostOpsConfig = { peers: {} };
  hostOpsConfigExists = false;
  taskState = 'done';
  requests = [];
  logsErrorsMode = 'data';
  logsErrorsHold = null;
  tuneErrorMode = false;
  lastCallTaskVerb = '';
  tuneSwapState = {
    active: false,
    managed: false,
    external: false,
    totalBytes: 0,
    usedBytes: 0,
    percent: 0,
    memTotalBytes: 1024 * 1024 * 1024,
    rootFreeBytes: 20 * 1024 * 1024 * 1024,
    swappiness: 60,
    sources: [],
  };
  tuneBbrState = {
    supported: true,
    enabled: false,
    congestionControl: 'cubic',
    qdisc: 'fq_codel',
  };
  tuneJournalState = {
    available: true,
    usedBytes: 320 * 1024 * 1024,
    maxUse: null,
    managed: false,
  };
  tuneAptState = {
    available: true,
    cacheBytes: 180 * 1024 * 1024,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url === '/api/v1/nodes') return json({ nodes: [node] });
      if (url === '/api/v1/nodes/tyo-1') return json({ node });
      if (url === '/api/v1/nodes/tyo-1/overview') {
        return json({ node, ...agentState, overview: emptyOverview });
      }
      if (url === '/api/v1/diagnostics/hints') {
        return json({ hintsVersion: '2026-10-29.1', hints: [] });
      }
      if (url === '/api/v1/nodes/tyo-1/diagnostics') {
        return json({
          nodeId: 'tyo-1',
          generatedAt: NOW,
          durationMs: 200,
          hintsVersion: '2026-10-29.1',
          reachable: true,
          route: 'direct',
          via: 'tcp',
          checks: [],
        });
      }
      if (url === '/api/v1/nodes/tyo-1/apps') {
        return json({
          apps: [wgConfig, hostOpsApp()],
          adapters: [
            { name: 'wireguard', version: '1.0.0', api: 1 },
            { name: 'host-ops', version: '1.0.0', api: 1 },
          ],
          adaptersError: null,
        });
      }
      if (url === '/api/v1/nodes/tyo-1/apps/wireguard') return json({ app: wgConfig });
      if (url === '/api/v1/nodes/tyo-1/apps/host-ops') {
        if (init?.method === 'PUT') {
          const body = JSON.parse(String(init.body)) as { config?: Record<string, unknown> };
          hostOpsConfig = body.config ?? {};
          hostOpsConfigExists = true;
          return json({ app: hostOpsApp() });
        }
        if (!hostOpsConfigExists) {
          return json({ error: { code: 'not_found', message: '应用尚未配置' } }, 404);
        }
        return json({ app: hostOpsApp() });
      }
      if (url.endsWith('/apps/host-ops/plan') || url.endsWith('/apps/host-ops/apply')) {
        return json({ ok: true, rev: 1, appliedRev: 1 });
      }
      if (url.endsWith('/apps/host-ops/onboard')) {
        return json({
          ok: true,
          installCommand: 'curl -fsSL https://hub.example/onboard.sh | sudo sh',
          uninstallCommand: 'curl -fsSL https://hub.example/uninstall.sh | sudo sh',
          publicKey: 'ssh-ed25519 HUBKEY',
          hubWgIp: '10.8.0.1',
          scriptVersion: '1.4.0',
        });
      }
      if (url.endsWith('/apps/host-ops/probe')) {
        return json({
          ok: true,
          host: '10.99.0.2',
          port: 22,
          keys: [
            {
              type: 'ssh-ed25519',
              key: 'ssh-ed25519 PEERHOSTKEY',
              fingerprint: 'SHA256:peerfingerprint',
            },
          ],
        });
      }
      if (url.endsWith('/apps/host-ops/hub_pubkey')) {
        return json({ ok: true, publicKey: 'ssh-ed25519 HUBKEY', fingerprint: 'SHA256:hubkey' });
      }
      if (url.endsWith('/apps/host-ops/install_nftables')) {
        return json({ ok: true, taskId: 'task-nft' });
      }
      if (url === '/api/v1/nodes/tyo-1/tasks/task-nft') {
        versionNft = true;
        versionNftInstallable = false;
        versionNftReason = null;
        fwShowUnsupported = false;
        return json({
          ok: true,
          task: {
            id: 'task-nft',
            state: 'done',
            result: { ok: true, installed: true, manager: 'apt-get', nftVersion: 'nftables v1.0.9' },
            error: null,
          },
        });
      }
      if (url.endsWith('/apps/host-ops/call_task')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          params?: { verb?: string; params?: Record<string, unknown> };
        };
        lastCallTaskVerb = body.params?.verb ?? '';
        if (lastCallTaskVerb === 'tune.swap' && body.params?.params?.action === 'create') {
          const sizeGb = Number(body.params.params.sizeGb ?? 2);
          tuneSwapState = {
            ...tuneSwapState,
            active: true,
            managed: true,
            external: false,
            totalBytes: sizeGb * 1024 * 1024 * 1024,
            swappiness: 10,
            sources: ['/swapfile'],
          };
        } else if (lastCallTaskVerb === 'tune.swap' && body.params?.params?.action === 'remove') {
          tuneSwapState = {
            ...tuneSwapState,
            active: false,
            managed: false,
            external: false,
            totalBytes: 0,
            usedBytes: 0,
            percent: 0,
            swappiness: 10,
            sources: [],
          };
        }
        return json({ ok: true, taskId: 'task-1' });
      }
      if (url === '/api/v1/nodes/tyo-1/tasks/task-1') {
        const resultData =
          lastCallTaskVerb === 'tune.swap'
            ? { swap: tuneSwapState }
            : { token: 'fw-token-1' };
        return json({
          ok: true,
          task: {
            id: 'task-1',
            state: taskState,
            result:
              taskState === 'done'
                ? {
                    ok: true,
                    v: '1.7.0',
                    data: resultData,
                  }
                : null,
            error:
              taskState === 'error'
                ? { code: 'E_PROTECTED', message: '规则被保护' }
                : null,
          },
        });
      }
      if (url.endsWith('/apps/host-ops/call')) {
        const body = JSON.parse(String(init?.body)) as {
          params: { target: string; verb: string; params: Record<string, unknown> };
        };
        const verb = body.params.verb;
        if (verb === 'tune.status') {
          if (tuneErrorMode) {
            return json({ ok: false, error: { code: 'E_IO', message: '读取系统调优状态失败' } });
          }
          return json({
            ok: true,
            v: '1.7.0',
            data: {
              swap: tuneSwapState,
              bbr: tuneBbrState,
              journal: tuneJournalState,
              apt: tuneAptState,
            },
          });
        }
        if (verb === 'logs.errors') {
          if (logsErrorsMode === 'loading') {
            return new Promise<Response>((resolve) => {
              logsErrorsHold = resolve;
            });
          }
          if (logsErrorsMode === 'error') {
            return json({ ok: false, error: { code: 'E_JOURNAL', message: 'journalctl 不可用' } });
          }
          if (logsErrorsMode === 'empty') {
            return json({
              ok: true,
              data: { windowHours: 24, count: 0, entries: [], oom: [], oomCount: 0 },
            });
          }
          return json({ ok: true, data: logsErrorsPayload });
        }
        if (verb === 'version') {
          return json({
            ok: true,
            v: '1.6.0',
            data: {
              version: '1.6.0',
              python: '3.11',
              root: true,
              nft: versionNft,
              nftInstallable: versionNftInstallable,
              nftUnavailableReason: versionNftReason,
            },
          });
        }
        if (verb === 'snapshot') {
          return json({
            ok: true,
            v: '1.4.0',
            data: {
              version: '1.4.0',
              scriptVersion: '1.4.0',
              python: '3.11',
              root: true,
              nft: true,
              hostname: 'peer-1',
              uptime: NOW - 100,
              ops: {
                cpu: { usagePercent: 7, load: [0.1, 0.2, 0.3] },
                mem: { total: 1000, used: 400, percent: 40 },
                disks: [{ total: 1000, used: 300, percent: 30 }],
                services: { services: [{ name: 'sshd', state: 'active' }], failedUnits: [] },
              },
              processes: body.params.params.processes
                ? [
                    { pid: 2, ppid: 0, name: 'kthreadd', user: 'root', cpu: 0, mem: 0, startTime: NOW - 100, cmdline: '[kthreadd]' },
                    { pid: 3, ppid: 2, name: 'kworker/0:1', user: 'root', cpu: 0, mem: 0, startTime: NOW - 100, cmdline: '[kworker/0:1]' },
                    { pid: 42, ppid: 1, name: 'nginx', user: 'root', cpu: 1.5, mem: 2, startTime: NOW - 60, cmdline: 'nginx' },
                    { pid: 43, ppid: 1, name: 'php-fpm', user: 'www', cpu: 0.5, mem: 1, startTime: NOW - 30, cmdline: 'php-fpm' },
                  ]
                : [],
            },
          });
        }
        if (verb === 'status') {
          return json({
            ok: true,
            v: '1.4.0',
            data: {
              hostname: 'peer-1',
              ops: {
                cpu: { usagePercent: 7, load: [0.1, 0.2, 0.3] },
                mem: { total: 1000, used: 400, percent: 40 },
                disks: [{ total: 1000, used: 300, percent: 30 }],
                services: { services: [{ name: 'sshd', state: 'active' }], failedUnits: [] },
              },
            },
          });
        }
        if (verb === 'fw.show') {
          if (fwShowUnsupported) {
            return json({
              ok: false,
              error: { code: 'E_UNSUPPORTED', message: '本机没有 nftables（nft），防火墙功能不可用' },
            });
          }
          return json({
            ok: true,
            data: {
              baseRev: 'fw-rev-1',
              mode: fwModeState,
              closePublicSsh: fwClosePublicSshState,
              appPorts: [
                { app: 'caddy-site', proto: 'tcp', port: 443 },
                { app: 'port-forward', proto: 'tcp', port: 9000 },
              ],
              wgInterfaces: ['wg0'],
              wgSubnets: ['10.99.0.0/24'],
              rules: [
                { id: '__ssh_22', action: 'allow', proto: 'tcp', port: '22', source: '0.0.0.0/0', note: 'SSH', locked: true },
                { id: 'r2', action: 'allow', proto: 'tcp', port: '443', source: '0.0.0.0/0', note: 'web' },
              ],
              otherTables: ['table ip filter { chain INPUT { } }'],
            },
          });
        }
        if (verb === 'fw.apply') {
          return json({ ok: true, data: { token: 'fw-token-1' } });
        }
        if (verb === 'fw.confirm') {
          return json({ ok: true, data: { confirmed: true } });
        }
        if (verb === 'keys.list') {
          return json({
            ok: true,
            data: {
              keys: [
                ...(removedManagedKey
                  ? []
                  : [{ fingerprint: 'SHA256:managed', type: 'ssh-ed25519', comment: 'pc', managed: true }]),
                { fingerprint: 'SHA256:hub', type: 'ssh-ed25519', comment: 'khc-hub-hub1', managed: true, hubKey: true },
              ],
            },
          });
        }
        if (verb === 'keys.remove') {
          if (body.params.params.fingerprint === 'SHA256:managed') removedManagedKey = true;
          return json({ ok: true, data: { removed: true } });
        }
        if (verb === 'keys.add') {
          return json({ ok: true, data: {} });
        }
        if (verb === 'svc.list') {
          const baseServices = [
            { unit: 'caddy.service', load: 'loaded', active: 'active', sub: 'running', description: 'Caddy' },
            { unit: 'ssh.service', load: 'loaded', active: 'active', sub: 'running', description: 'OpenBSD Secure Shell server' },
            { unit: 'khc-r3-driver.service', load: 'loaded', active: 'failed', sub: 'failed', description: 'KHC R3 driver' },
            ...(systemUnitFailed
              ? [{ unit: 'fwupd.service', load: 'loaded', active: 'failed', sub: 'failed', description: 'Firmware update daemon' }]
              : []),
            ...(userAppServiceIncluded
              ? [{ unit: 'khc-magpie-default.service', load: 'loaded', active: 'active', sub: 'running', description: 'magpie gateway', scope: 'user', user: 'khc-app-magpie' }]
              : []),
          ];
          return json({
            ok: true,
            data: {
              services: baseServices,
              count: baseServices.length,
            },
          });
        }
        if (verb === 'svc.logs') {
          return json({
            ok: true,
            data: { unit: String(body.params.params.unit), lines: ['2026-11-02T00:00:00+00:00 host caddy[881]: serving'], count: 1 },
          });
        }
        if (verb === 'svc.restart') {
          return json({
            ok: true,
            data: { unit: String(body.params.params.unit), restarted: true, active: true },
          });
        }
        if (verb === 'svc.reset-failed') {
          return json({
            ok: true,
            data: { unit: String(body.params.params.unit), reset: true, stillFailed: false },
          });
        }
        return json({ ok: false, error: { code: 'E_BAD_REQUEST', message: 'unknown verb' } });
      }
      return json({});
    }),
  );
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  removedManagedKey = false;
  systemUnitFailed = false;
  userAppServiceIncluded = false;
  versionNft = true;
  versionNftInstallable = false;
  versionNftReason = null;
  fwShowUnsupported = false;
  fwModeState = 'open';
  fwClosePublicSshState = false;
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
}

describe('主机运维页（ui-redesign §4：状态带 + 分段对象表 + 唯一抽屉）', () => {
  it('服务段实时列出 running/failed 单元，日志进抽屉、重启 L2 确认、受保护单元禁用', async () => {
    await renderRoute('/hubs/tyo-1/ops');
    expect(await screen.findAllByText('caddy.service')).toBeTruthy();
    expect(screen.getByText('Agent 连接')).toBeTruthy();
    expect(screen.getByText(/^CPU/)).toBeTruthy();

    const caddyRow = (await screen.findAllByText('caddy.service'))
      .map((element) => element.closest('tr'))
      .find((element): element is HTMLTableRowElement => element !== null);
    if (!caddyRow) throw new Error('missing caddy row');

    // 日志：页面级唯一抽屉展示 journalctl 尾读
    await userEvent.click(within(caddyRow).getByRole('button', { name: '更多操作' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '日志' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/caddy\[881\]: serving/)).toBeTruthy();
    const closeButton = within(dialog).getAllByRole('button', { name: '关闭' }).at(0);
    if (!closeButton) throw new Error('missing close button');
    await userEvent.click(closeButton);

    // 重启：L2 确认后调用 svc.restart
    await userEvent.click(within(caddyRow).getByRole('button', { name: '更多操作' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '重启' }));
    const confirm = await screen.findByRole('dialog');
    expect(within(confirm).getByText('重启服务 caddy.service？')).toBeTruthy();
    await userEvent.click(within(confirm).getByRole('button', { name: '重启' }));
    await waitFor(() => expect(screen.getAllByText(/已重启 caddy\.service/).length).toBeGreaterThan(0));

    // 受保护单元（ssh）在行内禁用并给出原因
    const sshRow = (await screen.findAllByText('ssh.service'))
      .map((element) => element.closest('tr'))
      .find((element): element is HTMLTableRowElement => element !== null);
    if (!sshRow) throw new Error('missing ssh row');
    await userEvent.click(within(sshRow).getByRole('button', { name: '更多操作' }));
    const sshRestart = await screen.findByRole('menuitem', { name: '重启' });
    expect((sshRestart as HTMLButtonElement).disabled).toBe(true);
    expect(sshRestart.getAttribute('title')).toBe('该服务受保护，不允许从面板操作');
  });

  it('系统自带单元失败：行仍列出并给说明，但不冒充面板待处理', async () => {
    // 真机 aws-hui-us：fwupd / fwupd-refresh / apt-daily-upgrade 常驻 failed。
    // 面板修不了它们，所以只解释一句、不摆红色告警（口径见 serviceStatus.ts）。
    systemUnitFailed = true;
    await renderRoute('/hubs/tyo-1/ops');
    const row = (await screen.findAllByText('fwupd.service'))
      .map((element) => element.closest('tr'))
      .find((element): element is HTMLTableRowElement => element !== null);
    if (!row) throw new Error('missing fwupd row');
    expect(
      await screen.findByText(/另有 1 个系统自带单元处于失败状态/),
    ).toBeTruthy();
  });

  it('失败单元可清除失败状态：L2 确认后调用 svc.reset-failed 并成功提示', async () => {
    await renderRoute('/hubs/tyo-1/ops');
    const failedRow = (await screen.findAllByText('khc-r3-driver.service'))
      .map((element) => element.closest('tr'))
      .find((element): element is HTMLTableRowElement => element !== null);
    if (!failedRow) throw new Error('missing failed row');

    await userEvent.click(within(failedRow).getByRole('button', { name: '更多操作' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '清除失败状态' }));
    const confirm = await screen.findByRole('dialog');
    expect(within(confirm).getByText('清除 khc-r3-driver.service 的失败状态？')).toBeTruthy();
    // 确认框必须说清「只清标记、不修服务」，否则用户会以为问题解决了
    expect(within(confirm).getByText(/不会启动服务、也不会改配置/)).toBeTruthy();
    await userEvent.click(within(confirm).getByRole('button', { name: '清除失败状态' }));
    await waitFor(() =>
      expect(screen.getAllByText(/已清除 khc-r3-driver\.service 的失败状态/).length).toBeGreaterThan(0),
    );
  });

  it('非失败单元上「清除失败状态」禁用并说明原因（点了也没意义）', async () => {
    await renderRoute('/hubs/tyo-1/ops');
    const caddyRow = (await screen.findAllByText('caddy.service'))
      .map((element) => element.closest('tr'))
      .find((element): element is HTMLTableRowElement => element !== null);
    if (!caddyRow) throw new Error('missing caddy row');

    await userEvent.click(within(caddyRow).getByRole('button', { name: '更多操作' }));
    const item = await screen.findByRole('menuitem', { name: '清除失败状态' });
    expect((item as HTMLButtonElement).disabled).toBe(true);
    expect(item.getAttribute('title')).toBe('这个单元当前不是失败状态，无需清除');
  });

  it('托管应用用户级服务（systemd --user）列出并在日志与重启时透传 user', async () => {
    userAppServiceIncluded = true;
    await renderRoute('/hubs/tyo-1/ops');
    const magpieRow = (await screen.findAllByText('khc-magpie-default.service'))
      .map((element) => element.closest('tr'))
      .find((element): element is HTMLTableRowElement => element !== null);
    if (!magpieRow) throw new Error('missing magpie row');

    // 日志：携带 user = khc-app-magpie
    await userEvent.click(within(magpieRow).getByRole('button', { name: '更多操作' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '日志' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/serving/)).toBeTruthy();
    const closeButton = within(dialog).getAllByRole('button', { name: '关闭' }).at(0);
    if (!closeButton) throw new Error('missing close button');
    await userEvent.click(closeButton);

    // 重启：L2 确认后携带 user = khc-app-magpie
    await userEvent.click(within(magpieRow).getByRole('button', { name: '更多操作' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '重启' }));
    const confirm = await screen.findByRole('dialog');
    await userEvent.click(within(confirm).getByRole('button', { name: '重启' }));
    await waitFor(() => expect(screen.getAllByText(/已重启 khc-magpie-default\.service/).length).toBeGreaterThan(0));

    const svcCalls = requests
      .filter((req) => req.url.endsWith('/apps/host-ops/call') && req.init?.body)
      .map((req) => JSON.parse(String(req.init!.body)) as { params: { verb: string; params: Record<string, unknown> } });
    const magpieLogs = svcCalls.find((c) => c.params.verb === 'svc.logs' && c.params.params.unit === 'khc-magpie-default.service');
    const magpieRestart = svcCalls.find((c) => c.params.verb === 'svc.restart' && c.params.params.unit === 'khc-magpie-default.service');
    expect(magpieLogs?.params.params).toMatchObject({ unit: 'khc-magpie-default.service', user: 'khc-app-magpie', lines: 200 });
    expect(magpieRestart?.params.params).toEqual({ unit: 'khc-magpie-default.service', user: 'khc-app-magpie' });
  });

  it('状态带 CPU 下钻进程段，行点击在唯一抽屉展示详情（无二级弹窗）', async () => {
    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: /^CPU/ }));
    expect((await screen.findAllByText('nginx')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('php-fpm').length).toBeGreaterThan(0);

    const row = (await screen.findAllByText('nginx'))
      .map((element) => element.closest('tr'))
      .find((element): element is HTMLTableRowElement => element !== null);
    if (!row) throw new Error('missing process row');
    await userEvent.click(row);

    expect(await screen.findByText('nginx（PID 42）')).toBeTruthy();
    const dialog = await screen.findByRole('dialog');
    const closeButtons = within(dialog).getAllByRole('button', { name: '关闭' });
    await userEvent.click(closeButtons[0] as HTMLElement);
    expect(await waitFor(() => screen.queryByRole('dialog'))).toBeNull();
  });

  it('防火墙：编辑抽屉保存草稿后应用，进入 60 秒确认并支持确认连接', async () => {
    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: '防火墙' }));
    expect(await screen.findByText('web')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '编辑' }));
    const drawer = await screen.findByRole('dialog');
    await userEvent.click(within(drawer).getByRole('button', { name: '添加规则' }));
    const portInputs = within(drawer).getAllByLabelText('端口');
    await userEvent.type(portInputs[portInputs.length - 1] as HTMLElement, '8080');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('有未应用的规则修改')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '应用' }));
    expect(await screen.findByText(/请在 \d+ 秒内确认连接/)).toBeTruthy();
    expect(requests.some((item) => item.url.endsWith('/apps/host-ops/call_task'))).toBe(true);
    expect(requests.some((item) => item.url.includes('/tasks/task-1'))).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '确认连接' }));
    expect((await screen.findAllByText('已确认，规则已保留')).length).toBeGreaterThan(0);
  });

  it('进程分段默认隐藏系统进程，切换显示全部同步真实隐藏数', async () => {
    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: /^CPU/ }));
    expect(await screen.findByText('已隐藏 2 个系统进程')).toBeTruthy();
    // 抓取上限要大于展示上限：否则业务视图会被内核线程挤空（2026-11-20 走查）。
    const snapshot = requests.find((item) =>
      String(item.init?.body ?? '').includes('"verb":"snapshot"'),
    );
    const sent = JSON.parse(String(snapshot?.init?.body)) as {
      params: { params: { processes: boolean; limit: number } };
    };
    expect(sent.params.params.processes).toBe(true);
    expect(sent.params.params.limit).toBe(200);
    expect(screen.queryByText('[kthreadd]')).toBeNull();

    await userEvent.click(screen.getByText('显示全部'));
    expect(await screen.findByText('已显示全部进程（其中 2 个系统进程）')).toBeTruthy();
    expect(await screen.findByText('[kthreadd]')).toBeTruthy();
  });

  it('进程抽屉只读：没有结束进程入口', async () => {
    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: /^CPU/ }));
    const cmd = (await screen.findAllByText('nginx'))[0] as HTMLElement;
    const row = cmd.closest('tr');
    if (!row) throw new Error('missing process row');
    expect(within(row).queryByRole('button', { name: '更多操作' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '结束进程' })).toBeNull();
  });

  it('异步任务 error 显示映射错误', async () => {
    taskState = 'error';
    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: '防火墙' }));
    await screen.findByText('web');
    await userEvent.click(screen.getByRole('button', { name: '编辑' }));
    const drawer = await screen.findByRole('dialog');
    await userEvent.click(within(drawer).getByRole('button', { name: '添加规则' }));
    const portInputs = within(drawer).getAllByLabelText('端口');
    await userEvent.type(portInputs[portInputs.length - 1] as HTMLElement, '8081');
    await userEvent.click(screen.getByRole('button', { name: '保存' }));
    await userEvent.click(await screen.findByRole('button', { name: '应用' }));
    expect(await screen.findByText('该操作被保护规则拦截。')).toBeTruthy();
  });

  it('任务超时显示错误并停止轮询', async () => {
    taskState = 'running';
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    try {
      await renderRoute('/hubs/tyo-1/ops');
      await user.click(await screen.findByRole('button', { name: '防火墙' }));
      await screen.findByText('web');
      await user.click(screen.getByRole('button', { name: '编辑' }));
      const drawer = await screen.findByRole('dialog');
      await user.click(within(drawer).getByRole('button', { name: '添加规则' }));
      const portInputs = within(drawer).getAllByLabelText('端口');
      await user.type(portInputs[portInputs.length - 1] as HTMLElement, '8082');
      await user.click(screen.getByRole('button', { name: '保存' }));
      await user.click(await screen.findByRole('button', { name: '应用' }));

      await vi.advanceTimersByTimeAsync(121_000);
      expect(await screen.findByText('操作失败，请稍后重试。')).toBeTruthy();
      const taskPolls = requests.filter((item) => item.url.includes('/tasks/task-1'));
      expect(taskPolls.length).toBeGreaterThan(1);
      expect(taskPolls.length).toBeLessThan(130);
    } finally {
      vi.useRealTimers();
    }
  });

  it('SSH 公钥段：添加表单进抽屉，Hub 运维公钥受保护', async () => {
    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: 'SSH 公钥' }));
    expect((await screen.findAllByText('SHA256:managed')).length).toBeGreaterThan(0);

    const hubRow = (await screen.findAllByText(/Hub 运维公钥不可移除|SHA256:hub/))
      .map((element) => element.closest('tr'))
      .find((element): element is HTMLTableRowElement => element !== null);
    if (!hubRow) throw new Error('missing hub key row');
    await userEvent.click(within(hubRow).getByRole('button', { name: '更多操作' }));
    const remove = await screen.findByRole('menuitem', { name: '移除公钥' });
    expect((remove as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: '添加公钥' }));
    expect(await screen.findByText('只接受公钥文本；私钥不要粘贴到面板。')).toBeTruthy();
  });

  it('SSH 公钥段：移除成功后列表立即刷新（不需要手动重载）', async () => {
    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: 'SSH 公钥' }));
    expect((await screen.findAllByText('SHA256:managed')).length).toBeGreaterThan(0);

    const row = (await screen.findAllByText('SHA256:managed'))
      .map((element) => element.closest('tr'))
      .find((element): element is HTMLTableRowElement => element !== null);
    if (!row) throw new Error('missing managed key row');
    await userEvent.click(within(row).getByRole('button', { name: '更多操作' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '移除公钥' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: '移除' }));

    await waitFor(() => expect(screen.queryByText('SHA256:managed')).toBeNull());
    expect(screen.getAllByText('SHA256:hub').length).toBeGreaterThan(0);
  });
});

const LOGS_SECTION_TITLE = '近 24 小时日志错误';

function expectFiveSegments() {
  const group = screen.getByRole('group', { name: '主机运维' });
  expect(within(group).getAllByRole('button')).toHaveLength(6);
  expect(within(group).queryByRole('button', { name: '日志错误' })).toBeNull();
  expect(screen.queryByRole('button', { name: '日志错误' })).toBeNull();
}

describe('服务分段内的系统错误折叠区（批次 2 修正：5 个分段不变、展开才调用、四态、390）', () => {
  it('5 个分段不变；打开运维页不读取系统错误，展开折叠区才请求一次且不轮询', async () => {
    await renderRoute('/hubs/tyo-1/ops');
    await screen.findByText('Agent 连接');
    expectFiveSegments();
    expect(logsErrorsCalls()).toHaveLength(0);
    expect(screen.queryByText(/最近 24 小时 · 2 条错误/)).toBeNull();

    await userEvent.click(await screen.findByRole('button', { name: LOGS_SECTION_TITLE }));
    expect(await screen.findByText(/最近 24 小时 · 2 条错误 · 1 条 OOM/)).toBeTruthy();
    expectFiveSegments();
    expect(logsErrorsCalls()).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(logsErrorsCalls()).toHaveLength(1);
  });

  it('有数据：条数、级别、时间、脱敏后文本同表展示，不显示凭据', async () => {
    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: LOGS_SECTION_TITLE }));
    expect(
      (await screen.findAllByText('caddy.service: 连接上游失败 password=[REDACTED]')).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/最近 24 小时 · 2 条错误 · 1 条 OOM/)).toBeTruthy();
    expect(screen.getAllByText('错误').length).toBeGreaterThan(0);
    expect(screen.getAllByText('严重').length).toBeGreaterThan(0);
    expect(screen.getAllByText('OOM').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/分钟前/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/hunter2/)).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expectFiveSegments();
  });

  it('空态：无错误与 OOM 时显示空态说明', async () => {
    logsErrorsMode = 'empty';
    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: LOGS_SECTION_TITLE }));
    expect(await screen.findByText('近 24 小时没有日志错误')).toBeTruthy();
    expect(screen.getByText(/最近 24 小时 · 0 条错误 · 0 条 OOM/)).toBeTruthy();
  });

  it('错误态：动词失败显示 InlineError 与重试，不残留数据', async () => {
    logsErrorsMode = 'error';
    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: LOGS_SECTION_TITLE }));
    expect(await screen.findByText('操作失败，请稍后重试。')).toBeTruthy();
    expect(screen.queryByText('caddy.service: 连接上游失败 password=[REDACTED]')).toBeNull();
    const retry = await screen.findByRole('button', { name: '重试' });
    expect(retry).toBeTruthy();
    expect(logsErrorsCalls()).toHaveLength(1);
    await userEvent.click(retry);
    await waitFor(() => expect(logsErrorsCalls()).toHaveLength(2));
  });

  it('加载态：请求未返回时显示骨架，返回后显示数据', async () => {
    logsErrorsMode = 'loading';
    await renderRoute('/hubs/tyo-1/ops');
    await screen.findByText('Agent 连接');
    await userEvent.click(await screen.findByRole('button', { name: LOGS_SECTION_TITLE }));
    await waitFor(() =>
      expect(
        document.querySelectorAll('.ui-advanced-body .ui-skeleton').length,
      ).toBeGreaterThan(0),
    );
    logsErrorsHold?.(json({ ok: true, data: logsErrorsPayload }));
    expect(
      (await screen.findAllByText('caddy.service: 连接上游失败 password=[REDACTED]')).length,
    ).toBeGreaterThan(0);
  });

  it('390 宽：级别与时间并入名称列第二段，不丢项也不开新抽屉', async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    window.dispatchEvent(new Event('resize'));
    try {
      await renderRoute('/hubs/tyo-1/ops');
      await userEvent.click(await screen.findByRole('button', { name: LOGS_SECTION_TITLE }));
      expect(
        (await screen.findAllByText('caddy.service: 连接上游失败 password=[REDACTED]')).length,
      ).toBeGreaterThan(0);
      const narrow = document.querySelector('.ui-advanced-body .ui-list-meta-narrow');
      expect(narrow?.textContent).toContain('错误');
      expect(narrow?.textContent).toContain(':');
      expect(screen.queryByRole('dialog')).toBeNull();
      expectFiveSegments();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
    }
  });
});

describe('Peer 运维（内网穿透页，不受本次重组影响）', () => {
  it('Peer 运维标签完成未接入向导并自动获取状态', async () => {
    await renderRoute('/hubs/tyo-1/wireguard?drawer=peer:peer-1');
    const tab = await screen.findByRole('tab', { name: '运维' });
    await userEvent.click(tab);

    expect(await screen.findByText('接入主机运维')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '生成接入命令' }));
    expect(await screen.findByText(/onboard\.sh/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '检查连接' }));
    expect(await screen.findByText('SHA256:peerfingerprint')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '确认指纹' }));
    expect(await screen.findByRole('button', { name: '获取状态' })).toBeTruthy();
    expect(await screen.findByText('10.99.0.2:22')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText(/7%/).length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: '进程' })).toBeTruthy();
  });
});

/* ---------------------------------------------------------------------------
 * 防火墙段的并发加载（2026-11-16 U6）
 *
 * version 与 fw.show 互不依赖，必须并行发出。串行时总耗时是两者之和，
 * 而 Peer 目标走 SSH 那一跳要几百毫秒，串起来的代价很明显。
 * ------------------------------------------------------------------------- */

describe('防火墙加载的并发', () => {
  function verbOf(init: RequestInit | undefined): string {
    try {
      const body = JSON.parse(String(init?.body ?? '{}'));
      return String(body?.params?.verb ?? '');
    } catch {
      return '';
    }
  }

  it('version 未返回前就已经发出 fw.show（串行实现会失败）', async () => {
    mockApi();

    // 关键：让 version 挂起一段真实时间。串行实现必须等它 resolve 才会发 fw.show，
    // 并行实现则会在它还没返回时就发出 fw.show。
    // 不注入延迟的话，mock 同步返回，串行与并行在请求序上无法区分（踩过这个坑）。
    const realFetch = globalThis.fetch;
    let versionResolved = false;
    let showSentBeforeVersionResolved: boolean | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const verb = verbOf(init);
        if (verb === 'version') {
          await new Promise((resolve) => setTimeout(resolve, 60));
          versionResolved = true;
          return (realFetch as typeof fetch)(input, init);
        }
        if (verb === 'fw.show') {
          showSentBeforeVersionResolved = !versionResolved;
          return (realFetch as typeof fetch)(input, init);
        }
        return (realFetch as typeof fetch)(input, init);
      }),
    );

    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: '防火墙' }));
    await screen.findByText('web');

    expect(versionResolved).toBe(true);
    expect(showSentBeforeVersionResolved).toBe(true);
  });
});

describe('防火墙 nftables 一键安装与白名单模式（批次 2/3）', () => {
  it('缺 nftables 包时只渲染单个提示横幅，并支持 L2 一键安装后自动刷新', async () => {
    versionNft = false;
    versionNftInstallable = true;
    versionNftReason = 'missing_pkg';
    fwShowUnsupported = true;

    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: '防火墙' }));

    expect(await screen.findByText('该主机尚未安装 nftables，防火墙功能暂不可用')).toBeTruthy();
    // 去重：不再同时渲染冗余的 E_UNSUPPORTED 红色错误横幅与「查看详情」按钮
    expect(screen.queryByText('该主机不支持 nftables，防火墙功能不可用。')).toBeNull();
    expect(screen.queryByRole('button', { name: '查看详情' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: '一键安装 nftables' }));
    const confirmDialog = await screen.findByRole('dialog');
    expect(within(confirmDialog).getByText('安装 nftables？')).toBeTruthy();
    await userEvent.click(within(confirmDialog).getByRole('button', { name: '立即安装' }));

    expect(await screen.findByText('web')).toBeTruthy();
    expect(requests.some((item) => item.url.endsWith('/apps/host-ops/install_nftables'))).toBe(true);
    expect(requests.some((item) => item.url.includes('/tasks/task-nft'))).toBe(true);
  });

  it('内核不支持 nf_tables 时仅提示不可用，不显示安装按钮', async () => {
    versionNft = false;
    versionNftInstallable = false;
    versionNftReason = 'no_kernel';
    fwShowUnsupported = true;

    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: '防火墙' }));

    expect(await screen.findByText('当前主机内核不支持 nftables')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '一键安装 nftables' })).toBeNull();
    expect(screen.queryByRole('button', { name: '查看详情' })).toBeNull();
  });

  it('切换「仅开面板应用」并关闭公网 SSH 22 时，要求 L3 强确认（节点名 + VNC 勾选）并下发模式参数', async () => {
    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: '防火墙' }));
    expect(await screen.findByText('web')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '仅开面板应用' }));
    expect(await screen.findByText('TCP/443 · caddy-site')).toBeTruthy();
    expect(screen.getByText('TCP/9000 · port-forward')).toBeTruthy();

    await userEvent.click(screen.getByLabelText(/关闭公网 SSH 22 端口/));
    await userEvent.click(screen.getByRole('button', { name: '应用' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('关闭节点 tyo-1 的公网 SSH 22 端口？')).toBeTruthy();
    const confirmBtn = within(dialog).getByRole('button', { name: '确认应用并关闭公网 SSH' });
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);

    const nameInput = within(dialog).getByLabelText('输入节点名 tyo-1 以确认关闭公网 SSH');
    await userEvent.type(nameInput, 'tyo-1');
    // 未勾选 VNC 可用确认时仍禁用
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(within(dialog).getByLabelText(/我已确认云厂商 VNC 控制台可用/));
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(confirmBtn);

    expect(await screen.findByText(/请在 \d+ 秒内确认连接/)).toBeTruthy();
    const applyReq = requests.find((item) => item.url.endsWith('/apps/host-ops/call_task'));
    expect(applyReq).toBeTruthy();
    const sent = JSON.parse(String(applyReq?.init?.body)) as {
      params: { verb: string; params: { mode: string; closePublicSsh: boolean } };
    };
    expect(sent.params.verb).toBe('fw.apply');
    expect(sent.params.params.mode).toBe('allowlist');
    expect(sent.params.params.closePublicSsh).toBe(true);
  });
});

describe('主机「优化」标准表与低内存 Swap（P2）', () => {
  it('总内存 ≤ 2 GiB 且无 Swap 时状态带提示「未开 Swap」，点击直达优化表并支持一键开启 2G', async () => {
    await renderRoute('/hubs/tyo-1/ops');
    const hint = await screen.findByText('未开 Swap');
    expect(hint).toBeTruthy();

    await userEvent.click(hint);
    expect((await screen.findAllByText('Swap 交换空间')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('TCP BBR 加速').length).toBeGreaterThan(0);
    expect(screen.getAllByText('系统日志（journald）').length).toBeGreaterThan(0);
    expect(screen.getAllByText('APT 缓存清理').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: '开启 2G' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('开启 2G Swap？')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: '开启 2G' }));

    await waitFor(() => {
      expect(screen.getAllByText('已开启 · 2.0 GiB').length).toBeGreaterThan(0);
    });
    expect(
      requests.some(
        (item) =>
          item.url.endsWith('/apps/host-ops/call_task') &&
          String(item.init?.body ?? '').includes('"verb":"tune.swap"'),
      ),
    ).toBe(true);
  });

  it('点击 Swap 行可进抽屉选 4G 档位并触发 call_task', async () => {
    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: '优化' }));
    await screen.findAllByText('Swap 交换空间');

    await userEvent.click(screen.getAllByText('Swap 交换空间')[0]!);
    expect(await screen.findByRole('button', { name: '4G' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '4G' }));
    await userEvent.click(screen.getByRole('button', { name: '开启 4G Swap' }));

    await waitFor(() => {
      expect(screen.getAllByText('已开启 · 4.0 GiB').length).toBeGreaterThan(0);
    });
  });

  it('外部自带 Swap 隐藏操作按钮；内核不支持 BBR 时展示「内核不支持」并禁用开启', async () => {
    tuneSwapState = {
      ...tuneSwapState,
      active: true,
      managed: false,
      external: true,
      totalBytes: 512 * 1024 * 1024,
      sources: ['/dev/zram0'],
    };
    tuneBbrState = {
      supported: false,
      enabled: false,
      congestionControl: 'cubic',
      qdisc: 'pfifo_fast',
    };

    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: '优化' }));

    const table = screen.getByRole('table');
    expect((await screen.findAllByText('已开启 · 512 MiB（系统自带）')).length).toBeGreaterThan(0);
    expect(within(table).queryByRole('button', { name: '开启 2G' })).toBeNull();
    expect(within(table).queryByRole('button', { name: '关闭' })).toBeNull();
    expect(screen.getAllByText('内核不支持').length).toBeGreaterThan(0);
    const bbrBtn = screen.getByRole('button', { name: '开启' }) as HTMLButtonElement;
    expect(bbrBtn.disabled).toBe(true);
  });

  it('tune.status 失败时展示错误横幅与重试按钮', async () => {
    tuneErrorMode = true;
    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: '优化' }));

    expect(await screen.findByText('读取系统调优状态失败')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});
