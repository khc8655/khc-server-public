// @vitest-environment jsdom
// 节点概况页（page-specs §2.1，2026-11-10）：只列已配置应用、单徽标、关键参数、无负向占位。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { createAppRouter } from '../app/router';

const NOW = Math.floor(Date.now() / 1000);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const node = {
  id: 'x86-2',
  name: 'x86-2',
  endpoint: 'https://203.0.113.20:8880',
  tunnelEndpoint: null,
  liveEndpoint: null,
  preferredRoute: 'direct',
  status: 'online',
  lastSeenAt: NOW,
  createdAt: 1,
  updatedAt: 2,
  summary: { mode: 'wg', peers: 2, sites: { total: 1, disabled: 0 }, forwards: 1 },
};

const wgConfig = {
  enabled: true,
  interface: { name: 'khc0', address: '10.99.0.1/24', listenPort: 51820 },
  peers: [
    { name: 'phone', publicKey: 'P1', allowedIps: ['10.99.0.2/32'], enabled: true },
    { name: 'pad', publicKey: 'P2', allowedIps: ['10.99.0.3/32'], enabled: true },
  ],
};

const sitesConfig = {
  sites: [
    { name: 'blog', domain: 'blog.example.dev', kind: 'proxy', upstream: '10.99.0.2:8080', enabled: true },
  ],
};

const forwardsConfig = {
  forwards: [
    { name: 'ssh', protocol: 'tcp', listenPort: 2222, targetHost: '10.99.0.2', targetPort: 22, enabled: true },
  ],
};

let wgRev = 2;
let wgAppliedRev = 2;
let sitesRev = 1;
let sitesAppliedRev = 1;
let stateOk = true;
// 模拟 POST/PATCH /nodes 响应或旧缓存：node 上没有 summary 字段
let withSummary = true;
// 模拟节点实装状态：未安装的 WG（node-prod-1 口径）/ Caddy 有行但 0 站点
let wgInstalled = true;
let caddyInstalled = true;
let emptySites = false;
// 证书状态相关：节点绑定域名 + 控制面实测结论（/state 的 tls 字段）
let nodeDomain: string | null = null;
let tlsProbeState: 'verified' | 'failed' | 'none' | 'unknown' | null = null;

/** 详情响应：withSummary=false 时返回不带 summary 的节点（回归：WireGuard 行不得整块消失） */
function detailNode() {
  const base = withSummary
    ? node
    : Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'summary'));
  return { ...base, domain: nodeDomain };
}

function stateBody() {
  if (!stateOk) {
    return { reachable: false, route: 'direct', via: 'tcp', state: null, error: 'connect timeout' };
  }
  return {
    reachable: true,
    route: 'direct',
    via: 'tcp',
    error: null,
    ...(tlsProbeState
      ? {
          tls: {
            state: tlsProbeState,
            endpoint: 'https://203.0.113.20:8880',
            detail: tlsProbeState === 'failed' ? '证书已过期' : null,
            checkedAt: NOW,
          },
        }
      : {}),
    state: {
      host: { hostname: 'hub-x86', os: 'Debian 12', kernel: '6.1.0', uptime: 86400 },
      agent: { version: '0.1.37', serverTime: NOW },
      ops: {
        cpu: { usagePercent: 12.4, load: [0.52] },
        mem: { total: 8_000_000_000, used: 2_000_000_000, percent: 25 },
        disks: [{ path: '/', percent: 41 }],
        services: {
          services: [
            { name: 'caddy', state: 'active' },
            { name: 'khc-agent', state: 'active' },
          ],
          failedUnits: [],
        },
      },
      adapters: [
        {
          name: 'wireguard',
          version: '1.0.0',
          status: {
            installed: wgInstalled,
            running: wgInstalled,
            peers: [
              { name: 'phone', online: true },
              { name: 'pad', online: false },
            ],
          },
        },
        { name: 'caddy-site', version: '1.0.0', status: { installed: caddyInstalled, running: caddyInstalled } },
        { name: 'port-forward', version: '1.0.0', status: { installed: true, running: true, count: 1 } },
      ],
      ports: [],
    },
  };
}

beforeEach(() => {
  window.scrollTo = vi.fn();
  wgRev = 2;
  wgAppliedRev = 2;
  sitesRev = 1;
  sitesAppliedRev = 1;
  stateOk = true;
  withSummary = true;
  wgInstalled = true;
  caddyInstalled = true;
  emptySites = false;
  nodeDomain = null;
  tlsProbeState = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/auth/me') return json({ user: { name: 'admin' } });
      if (url === '/api/v1/nodes') return json({ nodes: [{ ...node, domain: nodeDomain }] });
      if (url === '/api/v1/nodes/x86-2') return json({ node: detailNode() });
      if (url === '/api/v1/nodes/x86-2/state') return json(stateBody());
      if (url === '/api/v1/certs') return json({ certificates: [] });
      if (url === '/api/v1/nodes/x86-2/apps/wireguard') {
        return json({
          app: { app: 'wireguard', schemaVersion: 1, config: wgConfig, rev: wgRev, appliedRev: wgAppliedRev, updatedAt: NOW },
        });
      }
      if (url === '/api/v1/nodes/x86-2/apps/caddy-site') {
        return json({
          app: {
            app: 'caddy-site',
            schemaVersion: 1,
            config: emptySites ? { sites: [] } : sitesConfig,
            rev: sitesRev,
            appliedRev: sitesAppliedRev,
            updatedAt: NOW,
          },
        });
      }
      if (url === '/api/v1/nodes/x86-2/apps/port-forward') {
        return json({
          app: { app: 'port-forward', schemaVersion: 1, config: forwardsConfig, rev: 1, appliedRev: 1, updatedAt: NOW },
        });
      }
      if (url === '/api/v1/diagnostics/hints') return json({ hintsVersion: '2026-10-26.1', hints: [] });
      if (url.startsWith('/api/v1/nodes/x86-2/diagnostics')) {
        return json({ nodeId: 'x86-2', generatedAt: NOW, durationMs: 10, hintsVersion: '2026-10-26.1', reachable: stateOk, route: 'direct', via: 'tcp', checks: [] });
      }
      return json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderOverview() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: ['/hubs/x86-2'] }));
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  // 等摘要卡的两行都到位再断言（「对外服务」也是侧栏项，不能用它判断渲染完成）
  await screen.findByText('网页服务');
  return utils;
}

describe('节点概况页 · 对外服务摘要', () => {
  it('只列已配置的对外服务：单徽标 + 数量与后端概览，无「已安装/未配置」文案', async () => {
    const { container } = await renderOverview();

    expect(screen.getByText('网页服务')).toBeTruthy();
    expect(screen.getByText('远程访问')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('运行中')).toHaveLength(2));
    expect(screen.queryByText('已安装')).toBeNull();
    expect(screen.queryByText(/未配置/)).toBeNull();
    expect(screen.queryByText(/还没有站点/)).toBeNull();

    const facts = Array.from(container.querySelectorAll('.ui-app-facts')).map((el) => el.textContent);
    expect(facts[0]).toContain('1 个站点');
    expect(facts[0]).toContain('内网 VM 1');
    expect(facts[1]).toContain('1 条规则');
    expect(facts[1]).toContain('内网 VM 1');
    // Peer 概览保留在摘要卡底部，不进表格
    expect(screen.getByText('Peer 1/2 在线')).toBeTruthy();

    // 页头：模式徽标（D1 摘要）+ 副标题计数
    expect(screen.getAllByText('组网节点').length).toBeGreaterThan(0);
    expect(screen.getByText('节点概况 · 1 站点 · 2 Peer')).toBeTruthy();
    // Stat hint：站点类型分布 / Peer 接口与端口
    expect(screen.getByText('反代 1')).toBeTruthy();
    expect(screen.getByText('khc0 · :51820')).toBeTruthy();
  });

  it('配置未应用时单徽标为「待生效」，不叠双徽标', async () => {
    sitesRev = 2;
    sitesAppliedRev = 1;
    await renderOverview();
    await waitFor(() => {
      expect(screen.getByText('待生效')).toBeTruthy();
      expect(screen.getAllByText('运行中')).toHaveLength(1);
    });
  });

  it('Agent 不可达：徽标降级为「未读取」，模式徽标仍来自 D1', async () => {
    stateOk = false;
    await renderOverview();
    await waitFor(() => expect(screen.getAllByText('未读取')).toHaveLength(2));
    expect(screen.getAllByText('组网节点').length).toBeGreaterThan(0);
  });

  it('summary 缺失（POST/PATCH 响应或旧缓存）：摘要行与 Peer 指标不消失', async () => {
    withSummary = false;
    const { container } = await renderOverview();

    // 回退到同源 wireguard 配置：Peer 指标仍按接口/端口展示
    expect(screen.getByText('网页服务')).toBeTruthy();
    expect(screen.getByText('远程访问')).toBeTruthy();
    expect(screen.getByText('Peer 1/2 在线')).toBeTruthy();
    const facts = Array.from(container.querySelectorAll('.ui-app-facts')).map((el) => el.textContent);
    expect(facts[0]).toContain('1 个站点');
    expect(screen.getByText('khc0 · :51820')).toBeTruthy();
    expect(screen.getAllByText('组网节点').length).toBeGreaterThan(0);
  });

  it('Agent 明确 installed=false：显示中性「未安装」，不是「未读取」', async () => {
    caddyInstalled = false;
    await renderOverview();

    await waitFor(() => expect(screen.getAllByText('未安装')).toHaveLength(1));
    expect(screen.queryByText('未读取')).toBeNull();
    // 模式徽标只看 D1 期望配置，离线/未装也可见
    expect(screen.getAllByText('组网节点').length).toBeGreaterThan(0);
  });

  it('拿不到 /state：显示「未读取」，不冒充「未安装」', async () => {
    stateOk = false;
    await renderOverview();

    await waitFor(() => expect(screen.getAllByText('未读取')).toHaveLength(2));
    expect(screen.queryByText('未安装')).toBeNull();
  });

  it('Caddy 有配置行但 0 站点：行不消失，显示「0 个站点」，不出现「暂无站点 / 未纳管」', async () => {
    emptySites = true;
    const { container } = await renderOverview();

    await waitFor(() => expect(container.textContent).toContain('0 个站点'));
    expect(screen.queryByText('已安装 · 暂无站点')).toBeNull();
    expect(screen.queryByText('外部安装 · 未纳管')).toBeNull();
    expect(container.textContent).not.toContain('未纳管');
    const facts = Array.from(container.querySelectorAll('.ui-app-facts')).map((el) => el.textContent);
    expect(facts[0]).toContain('0 个站点');
    expect(facts[0]).not.toContain('接管');
  });
});
/**
 * 回归：TLS 由外部反代 / Caddy / Tunnel 终结时，面板过去因为「没有托管站点」把证书
 * 判成「未签发」，而那一刻域名 HTTPS 完全可用。现在以控制面实测（/state.tls）为准。
 */
describe('节点概况页 · 证书状态', () => {
  it('控制面实测通过且没有托管站点：显示已签发，不再说未签发', async () => {
    nodeDomain = 'hub.example.com';
    tlsProbeState = 'verified';
    const { container } = await renderOverview();

    await waitFor(() => expect(container.textContent).toContain('已签发（控制面实测证书有效）'));
    expect(container.textContent).not.toContain('未签发');
    expect(container.textContent).not.toContain('Caddy 不会申请证书');
  });

  it('证书类失败：直接说校验失败并带原因', async () => {
    nodeDomain = 'hub.example.com';
    tlsProbeState = 'failed';
    const { container } = await renderOverview();

    await waitFor(() => expect(container.textContent).toContain('证书校验失败'));
    expect(container.textContent).toContain('证书已过期');
  });

  it('接入地址非 https：说「未启用 TLS」，不说「未绑定域名」', async () => {
    nodeDomain = 'hub.example.com';
    tlsProbeState = 'none';
    const { container } = await renderOverview();

    await waitFor(() => expect(container.textContent).toContain('未启用 TLS'));
    expect(container.textContent).not.toContain('未绑定域名');
  });

  it('未绑定域名：仍显示「未绑定域名」', async () => {
    tlsProbeState = 'verified';
    const { container } = await renderOverview();

    await waitFor(() => expect(container.textContent).toContain('未绑定域名'));
  });
});
