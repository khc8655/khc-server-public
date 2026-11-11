import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ModeSwitchError,
  applyWireGuardMode,
  fetchNodeMode,
  nextModeTarget,
  nodeModeQueryOptions,
  normalizeNodeMode,
  saveWireGuardEnabled,
  waitForWireGuardMode,
} from './mode';

const NOW = 1_700_000_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const wireguardApp = {
  app: 'wireguard',
  schemaVersion: 1,
  config: {
    enabled: true,
    interface: { name: 'wg0', address: '10.99.0.1/24', listenPort: 51820 },
    peers: [{ name: 'phone', publicKey: 'PUB', allowedIps: ['10.99.0.2/32'], enabled: true }],
  },
  rev: 2,
  appliedRev: 2,
  updatedAt: NOW,
};

const modeBody = {
  nodeId: 'hub-1',
  mode: 'wg',
  target: 'caddy',
  reachable: true,
  blockers: [
    {
      code: 'MODE_BLOCKED_CADDY_NOT_RUNNING',
      message: 'Caddy 未运行，切到网关前请先修复。',
      fixRoute: '/hubs/:hubId/sites',
    },
  ],
  warnings: [
    {
      code: 'MODE_WARN_IMPACT',
      message: '切换后：2 个客户端会断开（其中 1 个在线）；1 条端口转发会停止。',
    },
  ],
  checkedAt: NOW,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('节点模式数据层', () => {
  it('规范化 3 态响应与影响摘要', () => {
    const mode = normalizeNodeMode(modeBody, 'hub-1');
    expect(mode.mode).toBe('wg');
    expect(mode.target).toBe('caddy');
    expect(mode.reachable).toBe(true);
    expect(mode.blockers[0]).toMatchObject({
      code: 'MODE_BLOCKED_CADDY_NOT_RUNNING',
      fixRoute: '/hubs/:hubId/sites',
    });
    expect(mode.warnings[0]?.code).toBe('MODE_WARN_IMPACT');
    expect(mode.warnings[0]?.message).toContain('1 条端口转发会停止');
    expect(nextModeTarget('wg')).toBe('caddy');
    expect(nextModeTarget('caddy')).toBe('wg');
  });

  it('未知模式与目标缺失时降级为 unknown', () => {
    const unknown = normalizeNodeMode({ mode: 'switching_to_wg', state: 'degraded_wg' }, 'hub-1');
    expect(unknown.mode).toBe('unknown');
    expect(unknown.target).toBeNull();
    expect(unknown.reachable).toBe(false);
  });

  it('从 /mode 拉取预检，404 时降级为 unknown 但不抛错', async () => {
    const fetchMock = vi.fn(async () => json(modeBody));
    vi.stubGlobal('fetch', fetchMock);
    const mode = await fetchNodeMode('hub-1');
    expect(mode.mode).toBe('wg');
    const modeCall = fetchMock.mock.calls[0] as unknown as [string];
    expect(modeCall[0]).toBe('/api/v1/nodes/hub-1/mode');

    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'not_found', message: '未实现' } }, 404)));
    const fallback = await fetchNodeMode('hub-1');
    expect(fallback.mode).toBe('unknown');
  });

  it('保存 enabled 时保留 interface/peers', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return json({ app: { ...wireguardApp, config: { ...wireguardApp.config, enabled: false } } });
      return json({ app: wireguardApp });
    });
    vi.stubGlobal('fetch', fetchMock);
    await saveWireGuardEnabled('hub-1', false);
    const put = fetchMock.mock.calls.find((call) => call[1]?.method === 'PUT') as [string, RequestInit];
    expect(put[0]).toBe('/api/v1/nodes/hub-1/apps/wireguard');
    const body = JSON.parse(String(put[1].body)) as { config: Record<string, unknown> };
    expect(body.config.enabled).toBe(false);
    expect(body.config.peers).toHaveLength(1);
    expect(body.config.interface).toMatchObject({ name: 'wg0', listenPort: 51820 });
  });

  it('apply 先 plan 后 apply，失败抛 ModeSwitchError', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/plan')) return json({ ok: true, rev: 3 });
      if (url.endsWith('/apply')) return json({ ok: false, error: { code: 'MODE_APPLY_FAILED', message: '应用失败' } });
      return json({});
    }));
    await expect(applyWireGuardMode('hub-1')).rejects.toBeInstanceOf(ModeSwitchError);
    expect(calls).toEqual([
      '/api/v1/nodes/hub-1/apps/wireguard/plan',
      '/api/v1/nodes/hub-1/apps/wireguard/apply',
    ]);
  });

  it('轮询 /state 等待 running 收敛，超时抛错', async () => {
    let running = true;
    vi.stubGlobal('fetch', vi.fn(async () =>
      json({
        reachable: true,
        route: 'direct',
        via: 'tcp',
        error: null,
        state: { host: { hostname: 'h' }, adapters: [{ name: 'wireguard', version: '1.0.0', status: { running } }], ports: [] },
      }),
    ));
    await expect(waitForWireGuardMode('hub-1', 'wg', { intervalMs: 1 })).resolves.toBeUndefined();
    running = true;
    await expect(
      waitForWireGuardMode('hub-1', 'caddy', { intervalMs: 1, timeoutMs: 1 }),
    ).rejects.toMatchObject({ code: 'E_MODE_VERIFY_TIMEOUT' });
  });

  it('query options staleTime 10s', () => {
    expect(nodeModeQueryOptions('hub-1').staleTime).toBe(10_000);
  });
});
