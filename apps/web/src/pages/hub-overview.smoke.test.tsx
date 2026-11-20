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
// 失败单元：用来区分「面板受管」与「系统自带」（P-3 A）
let failedUnits: string[] = [];
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
          failedUnits,
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
  failedUnits = [];
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

describe('节点概况页 · 需要处理只收受管单元', () => {
  it('系统自带单元失败：不进「需要处理」，只在主机卡片给一行入口', async () => {
    failedUnits = ['unattended-upgrades.service', 'fwupd.service'];
    const { container } = await renderOverview();

    // 「需要处理」条只应由证书/Peer 构成，不该出现系统单元
    const triage = container.querySelector('.ui-triage-strip')?.textContent ?? '';
    expect(triage).not.toContain('unattended-upgrades');
    expect(triage).not.toContain('fwupd');

    // 主机卡片里有一行灰色入口，说明「2 个系统单元失败」并可点进去
    expect(screen.getByText('2 个系统单元失败')).toBeTruthy();
  });

  it('面板受管单元失败：进「需要处理」，也计入主机卡片计数', async () => {
    failedUnits = ['khc-agent.service', 'caddy.service'];
    const { container } = await renderOverview();

    const triage = container.querySelector('.ui-triage-strip')?.textContent ?? '';
    expect(triage).toContain('khc-agent.service');
    expect(triage).toContain('caddy.service');
    // 徽标词已从「服务异常」改为「服务失败」
    expect(triage).toContain('服务失败');
    expect(triage).not.toContain('异常');

    // 主机卡片显示受管失败计数
    expect(screen.getByText('2 个失败')).toBeTruthy();
  });

  it('受管与系统混合：两者分开表达，互不吞掉', async () => {
    failedUnits = ['khc-agent.service', 'unattended-upgrades.service'];
    const { container } = await renderOverview();

    const triage = container.querySelector('.ui-triage-strip')?.textContent ?? '';
    expect(triage).toContain('khc-agent.service');
    expect(triage).not.toContain('unattended-upgrades');
    // 只余一条系统单元
    expect(screen.getByText('1 个系统单元失败')).toBeTruthy();
  });
});

describe('节点概况页 · 对外服务摘要', () => {
  it('只列已配置的对外服务：三组各列名字，不再复述计数', async () => {
    const { container } = await renderOverview();

    // 分组标题仍在（2026-11-16 P-2：卡片只列名字）
    expect(screen.getByText('网页服务')).toBeTruthy();
    expect(screen.getByText('远程访问')).toBeTruthy();
    expect(screen.getByText('Peer')).toBeTruthy();

    // 不再出现按应用聚合的徽标文案
    expect(screen.queryByText('已安装')).toBeNull();
    expect(screen.queryByText(/未配置/)).toBeNull();
    expect(screen.queryByText(/还没有站点/)).toBeNull();

    // 每个站点是一行：域名 + 后端（fixture 站点 blog.example.dev → 10.99.0.2:8080）
    const rows = Array.from(container.querySelectorAll('.ui-service-row')).map((el) => el.textContent);
    expect(rows.some((text) => text?.includes('blog.example.dev'))).toBe(true);
    expect(rows.some((text) => text?.includes('10.99.0.2:8080'))).toBe(true);

    // 计数只留在上方指标卡，卡片里不再重复「1 个站点 / 1 条规则」
    const card = container.querySelector('.ui-service-list')?.closest('.ui-card')?.textContent ?? '';
    expect(card).not.toContain('1 个站点');
    expect(card).not.toContain('1 条规则');

    // 页头：模式徽标（D1 摘要）+ 副标题计数
    expect(screen.getAllByText('组网节点').length).toBeGreaterThan(0);
    expect(screen.getByText('节点概况 · 1 站点 · 2 Peer')).toBeTruthy();
    // Stat hint：站点类型分布 / Peer 接口与端口
    expect(screen.getByText('反代 1')).toBeTruthy();
    expect(screen.getByText('khc0 · :51820')).toBeTruthy();
  });

  it('Peer 行显示最近握手时间，不再有「Peer 1/2 在线」汇总行', async () => {
    const { container } = await renderOverview();
    expect(screen.queryByText('Peer 1/2 在线')).toBeNull();
    const rows = Array.from(container.querySelectorAll('.ui-service-row')).map((el) => el.textContent);
    // 两个 Peer 各一行，握手/未握手都在行内
    expect(rows.some((text) => text?.includes('握手'))).toBe(true);
  });

  it('Agent 明确 installed=false：显示中性「未安装」，不是「未读取」', async () => {
    caddyInstalled = false;
    await renderOverview();

    await waitFor(() => expect(screen.getByText('未安装')).toBeTruthy());
    expect(screen.queryByText('未读取')).toBeNull();
    // 模式徽标只看 D1 期望配置，离线/未装也可见
    expect(screen.getAllByText('组网节点').length).toBeGreaterThan(0);
  });

  it('Caddy 有配置行但 0 站点：组仍在，显示「暂无」而不是旧占位文案', async () => {
    emptySites = true;
    const { container } = await renderOverview();

    // 0 站点时该组不出行，但页面不因此空白
    expect(screen.getByText('网页服务')).toBeTruthy();
    expect(screen.queryByText('已安装 · 暂无站点')).toBeNull();
    expect(screen.queryByText('外部安装 · 未纳管')).toBeNull();
    expect(container.textContent).not.toContain('未纳管');
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
