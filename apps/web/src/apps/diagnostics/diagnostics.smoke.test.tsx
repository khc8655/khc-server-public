// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

const hints = {
  hintsVersion: '2026-10-29.1',
  hints: [
    {
      code: 'khc.transport.unreachable',
      layer: 'transport',
      severity: 'error',
      title: '节点不可达',
      summary: '直连与隧道两条路都失败。',
      impact: '节点状态与全部远程操作不可用。',
      aliases: ['unreachable'],
      causes: ['网络阻断'],
      checks: [
        { text: '确认 Agent 服务', kind: 'manual', command: 'systemctl status khc-agent --no-pager' },
      ],
      fixes: [{ mode: 'manual', label: '人工排查网络与 Agent' }],
      readOnly: true,
      doc: 'docs/diagnostics.md §3.1',
    },
  ],
};

function problemCheck() {
  return {
    id: 'problem.demo-app.unit_failed',
    code: 'khc.demo-app.unit_failed',
    severity: 'error',
    title: '单元未运行',
    detail: 'demo 服务未运行',
    app: 'demo-app',
    evidence: { unit: 'demo.service', active: false },
    actions: [{ id: 'app.apply', label: '重新应用' }],
  };
}

function diagnosticBody(): Record<string, unknown> {
  if (mode === 'offline') {
    return {
      nodeId: 'tyo-1',
      generatedAt: NOW,
      durationMs: 3200,
      hintsVersion: '2026-10-29.1',
      reachable: false,
      route: null,
      via: null,
      checks: [
        {
          id: 'transport.reachability',
          code: 'khc.transport.unreachable',
          severity: 'error',
          title: '节点不可达',
          detail: '直连与隧道均超时。',
        },
        {
          id: 'agent.offline',
          code: 'khc.agent.offline',
          severity: 'error',
          title: '节点已离线 12 分钟',
          detail: '最后一次成功连接在 12 分钟前。',
        },
      ],
    };
  }
  if (mode === 'ok') {
    return {
      nodeId: 'tyo-1',
      generatedAt: NOW,
      durationMs: 200,
      hintsVersion: '2026-10-29.1',
      reachable: true,
      route: 'direct',
      via: 'tcp',
      checks: [],
      ...(truncated ? { truncated: true } : {}),
    };
  }
  return {
    nodeId: 'tyo-1',
    generatedAt: NOW,
    durationMs: 300,
    hintsVersion: '2026-10-29.1',
    reachable: true,
    route: 'direct',
    via: 'tcp',
    checks: [problemCheck()],
    ...(truncated ? { truncated: true } : {}),
  };
}

let mode: 'issue' | 'error' | 'ok' | 'offline' | 'pending' = 'issue';
let truncated = false;
let requests: { url: string; init?: RequestInit }[] = [];

function mockApi() {
  mode = 'issue';
  truncated = false;
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url === '/api/v1/nodes') return json({ nodes: [node] });
      if (url === '/api/v1/nodes/tyo-1') return json({ node });
      if (url === '/api/v1/nodes/tyo-1/state') {
        return json({
          reachable: true,
          route: 'direct',
          via: 'fetch',
          error: null,
          state: { host: { hostname: 'hub-tyo' }, adapters: [], ports: [] },
        });
      }
      if (url === '/api/v1/nodes/tyo-1/apps') {
        return json({ apps: [], adapters: [], adaptersError: null });
      }
      if (url === '/api/v1/diagnostics/hints') return json(hints);
      if (url.startsWith('/api/v1/nodes/tyo-1/diagnostics')) {
        if (mode === 'pending') return new Promise<Response>(() => undefined);
        if (mode === 'error') return json({ error: { code: 'internal', message: '诊断链路失败' } }, 500);
        return json(diagnosticBody());
      }
      if (url === '/api/v1/nodes/tyo-1/apps/demo-app/apply') {
        mode = 'ok';
        return json({ ok: true, rev: 2, appliedRev: 2 });
      }
      if (url.endsWith('/apps/host-ops/call')) {
        // 服务段挂载即读取 svc.list；返回空列表避免错误横幅与诊断抽屉的重试按钮混淆。
        return json({ ok: true, data: { services: [] } });
      }
      return json({});
    }),
  );
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
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

describe('主机运维页诊断入口与唯一抽屉（ui-redesign §4）', () => {
  it('入口进抽屉，行点击看详情并直接执行适配器上报的安全动作', async () => {
    await renderRoute('/hubs/tyo-1/ops');
    const entry = await screen.findByRole('button', { name: '诊断' });
    await userEvent.click(entry);

    expect(await screen.findByText('1 项需要处理')).toBeTruthy();
    const row = (await screen.findAllByText('单元未运行'))
      .map((element) => element.closest('tr'))
      .find((element): element is HTMLTableRowElement => element !== null);
    if (!row) throw new Error('missing diagnostics row');
    await userEvent.click(row);

    expect(await screen.findByText('根因')).toBeTruthy();
    expect((await screen.findAllByText('demo 服务未运行')).length).toBeGreaterThan(0);
    expect(await screen.findByText('unit')).toBeTruthy();
    expect(await screen.findByText('该应用问题由适配器上报，按说明与技术信息处理')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '重新应用' }));
    await waitFor(() => {
      expect(requests.some((item) => item.url === '/api/v1/nodes/tyo-1/apps/demo-app/apply')).toBe(true);
    });
    expect((await screen.findAllByText('已处理，正在重新检查')).length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: '返回列表' }));
    expect((await screen.findAllByText('未发现需要处理的问题')).length).toBeGreaterThan(0);
  });

  it('无问题时仍保留手动诊断入口，打开后才检查', async () => {
    mode = 'ok';
    await renderRoute('/hubs/tyo-1/ops');
    expect(await screen.findByText('Agent 连接')).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: '诊断' }));
    expect((await screen.findAllByText('未发现需要处理的问题')).length).toBeGreaterThan(0);
  });

  it('截断时提示仅显示部分项目', async () => {
    mode = 'issue';
    truncated = true;
    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: '诊断' }));
    expect(await screen.findByText('检查结果已截断，仅显示部分项目')).toBeTruthy();
  });

  it('诊断请求超时显示错误与重试', async () => {
    mode = 'pending';
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderRoute('/hubs/tyo-1/ops');
      expect(await screen.findByText('Agent 连接')).toBeTruthy();
      await userEvent.click(await screen.findByRole('button', { name: '诊断' }));
      await vi.advanceTimersByTimeAsync(9_000);
      expect(await screen.findByText('无法完成检查')).toBeTruthy();
      expect(await screen.findByText('诊断检查超时')).toBeTruthy();
      expect(await screen.findByRole('button', { name: '重试' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('面板级错误显示无法完成检查与重试', async () => {
    mode = 'error';
    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: '诊断' }));
    expect(await screen.findByText('无法完成检查')).toBeTruthy();
    expect(await screen.findByText('诊断链路失败')).toBeTruthy();
    expect(await screen.findByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('节点不可达显示离线提示，且没有问题动作', async () => {
    mode = 'offline';
    await renderRoute('/hubs/tyo-1/ops');
    await userEvent.click(await screen.findByRole('button', { name: '诊断' }));
    expect((await screen.findAllByText('节点离线')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('显示上次检查结果，恢复连接后可重新检查')).length).toBeGreaterThan(0);
    const row = (await screen.findAllByText('节点不可达'))
      .map((element) => element.closest('tr'))
      .find((element): element is HTMLTableRowElement => element !== null);
    if (!row) throw new Error('missing offline row');
    await userEvent.click(row);
    expect(await screen.findByText('根因')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重新应用' })).toBeNull();
    expect(await screen.findByText('人工处理')).toBeTruthy();
  });
});
