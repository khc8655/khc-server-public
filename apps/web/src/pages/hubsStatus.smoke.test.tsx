// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from '../app/router';

/**
 * 节点列表状态（2026-11-07 改口径）：
 * - 打开列表页**即自动批量探测**（POST /nodes/probe，一次请求覆盖全部节点）；
 * - 用户可见状态只有「探测中…」/「在线」/「离线」，**不再有「未探测」**；
 * - 探测请求整体失败才落到「未知」并给错误横幅；
 * - 手动「刷新状态」= 强制再探一轮（绕过 15s 结果复用）。
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function node(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    endpoint: 'http://203.0.113.10:8880',
    tunnelEndpoint: null,
    liveEndpoint: null,
    preferredRoute: 'direct',
    status: 'unknown',
    lastSeenAt: null,
    domain: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

const NODES = [node('x86-2', 'x86-2'), node('dead-node', 'dead-node'), node('third', 'third')];

type ProbeMode = 'ok' | 'fail' | 'pending';

let probeMode: ProbeMode = 'ok';
let probeCalls = 0;
/** 用例可覆盖单次探测返回（构造失联 N 天、恢复在线等场景） */
let probeResponse: () => unknown = probeBody;
/** 允许用例替换 /nodes 列表返回（用于构造"租约仍是 online"的假在线场景） */
let listNodes: Record<string, unknown>[] = NODES;
let resolvePending: ((response: Response) => void) | null = null;

function probeBody() {
  return {
    probedAt: 1_700_000_000,
    nodes: [
      { id: 'x86-2', reachable: true, route: 'direct', via: 'tcp', error: null, lastSeenAt: 1_700_000_000 },
      { id: 'dead-node', reachable: false, route: 'direct', via: 'tcp', error: 'Hub 不可达', lastSeenAt: null },
      { id: 'third', reachable: false, route: 'direct', via: 'tcp', error: 'Hub 不可达', lastSeenAt: null },
    ],
  };
}

function mockApi() {
  probeMode = 'ok';
  probeCalls = 0;
  probeResponse = probeBody;
  resolvePending = null;
  listNodes = NODES;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url === '/api/v1/nodes') return json({ nodes: listNodes });
      if (url === '/api/v1/nodes/probe') {
        probeCalls += 1;
        if (probeMode === 'pending') {
          return await new Promise<Response>((resolve) => {
            resolvePending = resolve;
          });
        }
        if (probeMode === 'fail') {
          return json({ error: { code: 'probe_failed', message: '批量探测失败' } }, 503);
        }
        return json(probeResponse());
      }
      return json({});
    }),
  );
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  mockApi();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderHubs() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: ['/hubs'] }));
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: '节点' });
}

describe('节点列表状态（自动探测，无「未探测」）', () => {
  it('打开列表页即探测一次，且任何时刻都不出现「未探测」', async () => {
    await renderHubs();

    const table = screen.getByRole('table');
    await within(table).findByText('在线');

    expect(probeCalls).toBe(1);
    expect(within(table).queryByText('未探测')).toBeNull();
    expect(screen.queryByText('未探测')).toBeNull();
    expect(within(table).getAllByText('在线')).toHaveLength(1);
    expect(within(table).getAllByText('离线')).toHaveLength(2);
  });

  it('探测未返回期间显示「探测中…」，返回后变成在线/离线', async () => {
    probeMode = 'pending';
    await renderHubs();

    const table = await screen.findByRole('table');
    // 探测挂起：三行都应是「探测中…」，绝不能是「未探测」
    await within(table).findAllByText('探测中…');
    expect(within(table).getAllByText('探测中…')).toHaveLength(NODES.length);
    expect(within(table).queryByText('未探测')).toBeNull();

    resolvePending?.(json(probeBody()));

    await within(table).findByText('在线');
    expect(within(table).queryByText('探测中…')).toBeNull();
    expect(within(table).getAllByText('离线')).toHaveLength(2);
  });

  it('探测请求整体失败：落到「未知」并给出错误横幅，仍不出现「未探测」', async () => {
    probeMode = 'fail';
    await renderHubs();

    expect(await screen.findByText('状态探测失败')).toBeTruthy();
    const table = await screen.findByRole('table');
    await within(table).findAllByText('未知');
    expect(within(table).queryByText('未探测')).toBeNull();
  });

  it('列表租约仍是 online 但本次探测未返回：不显示「在线」（防假在线）', async () => {
    // 复现 2026-11-07 真机问题：Agent 已 stop，D1 租约在窗口内 → 列表 status=online，
    // 若信任租约就会显示"在线"，实际节点已经停了。
    listNodes = [
      { ...node('stale', 'stale'), status: 'online', lastSeenAt: Math.floor(Date.now() / 1000) },
    ];
    probeMode = 'pending';
    await renderHubs();

    const table = await screen.findByRole('table');
    await within(table).findAllByText('探测中…');
    expect(within(table).queryByText('在线')).toBeNull();
    expect(within(table).queryByText('未探测')).toBeNull();

    resolvePending?.(json({ probedAt: 1_700_000_000, nodes: [
      { id: 'stale', reachable: false, route: 'direct', via: 'tcp', error: 'connect timeout', lastSeenAt: null },
    ] }));
    await within(table).findByText('离线');
    expect(within(table).queryByText('在线')).toBeNull();
  });

  it('手动「刷新状态」强制再探一轮（绕过 15s 复用）', async () => {
    await renderHubs();
    const table = screen.getByRole('table');
    await within(table).findByText('在线');
    expect(probeCalls).toBe(1);

    await userEvent.click(screen.getByRole('button', { name: '刷新状态' }));
    await waitFor(() => expect(probeCalls).toBe(2));
  });

  it('失联超过 1 天：标「已失联 N 天」，并提供复用 L3 确认 + 卸载脚本的删除入口', async () => {
    const staleAt = Math.floor(Date.now() / 1000) - 3 * 86_400;
    listNodes = [{ ...node('node-prod-1', 'node-prod-1'), lastSeenAt: staleAt }];
    probeResponse = () => ({
      probedAt: Math.floor(Date.now() / 1000),
      nodes: [
        {
          id: 'node-prod-1',
          reachable: false,
          route: 'direct',
          via: 'tcp',
          error: 'connect timeout',
          lastSeenAt: staleAt,
        },
      ],
    });

    await renderHubs();
    const table = await screen.findByRole('table');
    await within(table).findByText('离线 · 已失联 3 天');
    expect(screen.getByText('1 个节点已失联超过 1 天')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '删除失联节点' }));
    expect(await screen.findByText('删除节点 node-prod-1？')).toBeTruthy();
    // 与行内删除完全一致：L3 输入节点名确认，且仍会生成卸载脚本。
    expect(screen.getByText('删除后自动生成卸载脚本')).toBeTruthy();
  });

  it('探测到离线后按 60s 节奏自动复核一次，恢复在线即停（不轮询轰炸）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderHubs();
      const table = await screen.findByRole('table');
      await within(table).findAllByText('离线');
      expect(probeCalls).toBe(1);

      probeResponse = () => ({
        probedAt: Math.floor(Date.now() / 1000),
        nodes: NODES.map((item) => ({
          id: item.id,
          reachable: true,
          route: 'direct',
          via: 'tcp',
          error: null,
          lastSeenAt: Math.floor(Date.now() / 1000),
        })),
      });

      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      await waitFor(() => expect(probeCalls).toBe(2));
      await waitFor(() => expect(within(table).queryAllByText('离线')).toHaveLength(0));

      // 全部在线后不再安排自动复核。
      await act(async () => {
        vi.advanceTimersByTime(600_000);
      });
      expect(probeCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
