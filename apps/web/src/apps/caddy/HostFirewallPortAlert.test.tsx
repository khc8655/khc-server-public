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
import type { HostOpsFirewallShow } from '../../data/hostOps';
import {
  HostFirewallPortAlert,
  buildAppendTcpAllowPayload,
  isTcpPortAllowedByFirewall,
  portMatchesSpec,
} from './HostFirewallPortAlert';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function baseShow(overrides: Partial<HostOpsFirewallShow> = {}): HostOpsFirewallShow {
  return {
    rules: [
      {
        id: '__ssh_22',
        action: 'allow',
        proto: 'tcp',
        port: '22',
        source: '0.0.0.0/0',
        note: 'SSH',
        locked: true,
        lockReason: null,
      },
      {
        id: 'r-https',
        action: 'allow',
        proto: 'tcp',
        port: '443',
        source: '0.0.0.0/0',
        note: 'HTTPS',
        locked: false,
        lockReason: null,
      },
    ],
    baseRev: 'fw-rev-1',
    other: [],
    pending: null,
    autoRules: [],
    ...overrides,
  };
}

function renderAlert(props: { port: number | null; enabled: boolean; appLabel?: string }) {
  window.scrollTo = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({
    component: () => (
      <HostFirewallPortAlert
        hubId="hub-1"
        port={props.port}
        enabled={props.enabled}
        appLabel={props.appLabel}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('HostFirewallPortAlert 纯逻辑', () => {
  it('portMatchesSpec 支持单端口、逗号分隔与端口范围', () => {
    expect(portMatchesSpec('8443', 8443)).toBe(true);
    expect(portMatchesSpec('80, 443, 8443', 443)).toBe(true);
    expect(portMatchesSpec('8000-9000', 8443)).toBe(true);
    expect(portMatchesSpec('8000-9000', 7999)).toBe(false);
    expect(portMatchesSpec('443', 8443)).toBe(false);
  });

  it('isTcpPortAllowedByFirewall 识别允许规则、autoRules，忽略 deny 与受限来源，空白规则放行', () => {
    expect(isTcpPortAllowedByFirewall(baseShow({ rules: [], autoRules: [] }), 8443)).toBe(true);
    expect(isTcpPortAllowedByFirewall(baseShow(), 443)).toBe(true);
    expect(isTcpPortAllowedByFirewall(baseShow(), 8443)).toBe(false);
    expect(
      isTcpPortAllowedByFirewall(
        baseShow({
          rules: [
            {
              id: 'deny-8443',
              action: 'deny',
              proto: 'tcp',
              port: '8443',
              source: '0.0.0.0/0',
              note: '',
              locked: false,
              lockReason: null,
            },
            {
              id: 'lan-only',
              action: 'allow',
              proto: 'tcp',
              port: '8443',
              source: '10.0.0.0/8',
              note: '',
              locked: false,
              lockReason: null,
            },
          ],
        }),
        8443,
      ),
    ).toBe(false);
    expect(
      isTcpPortAllowedByFirewall(
        baseShow({
          autoRules: [{ app: 'caddy-site', proto: 'tcp', port: '8443', note: 'auto' }],
        }),
        8443,
      ),
    ).toBe(true);
  });

  it('buildAppendTcpAllowPayload 保留现有规则并在末尾追加 TCP 放行规则与 baseRev', () => {
    const payload = buildAppendTcpAllowPayload(baseShow(), 8443, 'magpie :8443');
    expect(payload.baseRev).toBe('fw-rev-1');
    expect(payload.rules).toHaveLength(3);
    expect(payload.rules[2]).toEqual({
      id: 'caddy-allow-tcp-8443',
      action: 'allow',
      proto: 'tcp',
      port: '8443',
      source: '0.0.0.0/0',
      note: 'magpie :8443',
    });
  });
});

describe('HostFirewallPortAlert 组件交互', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('未放行端口告警并支持一键放行（fw.apply + fw.confirm），放行后转绿', async () => {
    let rules = baseShow().rules;
    const requests: { url: string; body?: unknown }[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ url, body });

        if (url === '/api/v1/nodes/hub-1/apps/host-ops/call') {
          const verb = (body as { params: { verb: string } }).params.verb;
          if (verb === 'version') {
            return json({ ok: true, data: { version: '1.4.0', root: true, nft: true } });
          }
          if (verb === 'fw.show') {
            return json({ ok: true, data: { baseRev: 'fw-rev-1', rules, autoRules: [] } });
          }
          if (verb === 'fw.confirm') {
            return json({ ok: true, data: { confirmed: true } });
          }
        }
        if (url === '/api/v1/nodes/hub-1/apps/host-ops/call_task') {
          const applyParams = (body as { params: { params: { rules: typeof rules } } }).params.params;
          rules = applyParams.rules;
          return json({ ok: true, accepted: true, taskId: 'task-fw-1', result: { taskId: 'task-fw-1' } });
        }
        if (url === '/api/v1/nodes/hub-1/tasks/task-fw-1') {
          return json({
            ok: true,
            task: {
              id: 'task-fw-1',
              state: 'done',
              result: { ok: true, data: { token: 'fw-token-9' } },
              error: null,
            },
          });
        }
        return json({});
      }),
    );

    renderAlert({ port: 8443, enabled: true, appLabel: 'magpie' });
    expect(await screen.findByText('主机防火墙尚未放行 TCP 8443')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '一键放行 TCP 8443' }));
    expect(await screen.findByText('主机防火墙已放行 TCP 8443')).toBeTruthy();

    const applyReq = requests.find((item) => item.url.endsWith('/call_task'));
    expect(applyReq).toBeTruthy();
    expect((applyReq?.body as { params: { verb: string } }).params.verb).toBe('fw.apply');
    const confirmReq = requests.find(
      (item) =>
        item.url.endsWith('/call') &&
        (item.body as { params: { verb: string } }).params.verb === 'fw.confirm',
    );
    expect((confirmReq?.body as { params: { params: { token: string } } }).params.params.token).toBe(
      'fw-token-9',
    );
  });

  it('enabled=false（如 Tunnel 或未装 host-ops）时不发任何请求', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { container } = renderAlert({ port: 8443, enabled: false });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });

  it('存在 pending 待确认变更时引导前往主机运维；E_UNSUPPORTED 时静默隐藏', async () => {
    let mode: 'pending' | 'unsupported' = 'pending';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === '/api/v1/nodes/hub-1/apps/host-ops/call') {
          const verb = (JSON.parse(String(init?.body)) as { params: { verb: string } }).params.verb;
          if (verb === 'version') return json({ ok: true, data: { root: true, nft: true } });
          if (verb === 'fw.show') {
            if (mode === 'unsupported') {
              return json({ ok: false, error: { code: 'E_UNSUPPORTED', message: 'no nft' } });
            }
            return json({
              ok: true,
              data: {
                baseRev: 'fw-1',
                rules: baseShow().rules,
                pending: { token: 'pending-tok', secondsLeft: 30 },
              },
            });
          }
        }
        return json({});
      }),
    );

    renderAlert({ port: 8443, enabled: true });
    expect(await screen.findByText('主机防火墙尚未放行 TCP 8443（存在待确认变更）')).toBeTruthy();
    expect(screen.getByRole('link', { name: '前往主机运维' }).getAttribute('href')).toBe('/hubs/hub-1/ops');
    cleanup();

    mode = 'unsupported';
    const view = renderAlert({ port: 8443, enabled: true });
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(view.container.textContent).toBe('');
  });
});
