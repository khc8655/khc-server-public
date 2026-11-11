import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentState } from '@khc/contracts';
import { nodeModeSchema } from '@khc/contracts';
import {
  MODE_CODES,
  collectModeImpacts,
  deriveNodeMode,
  type ModeDeriveInput,
} from '../src/lib/mode';
import { HubUnreachableError } from '../src/lib/node-client';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

const WG_CONFIG = {
  enabled: true,
  interface: { name: 'wg0', address: '10.99.0.1/24', listenPort: 51820 },
  peers: [
    { name: 'phone', enabled: true },
    { name: 'laptop', enabled: false },
  ],
};

const CADDY_CONFIG = {
  sites: [
    {
      name: 'blog',
      domain: 'blog.test',
      enabled: true,
      upstreams: ['10.99.0.2:8080'],
    },
  ],
};

function modeInput(overrides: Partial<ModeDeriveInput> = {}): ModeDeriveInput {
  return {
    desired: 'wg',
    reachable: true,
    impacts: [],
    configDirty: false,
    basePath: '/hubs/nd_1',
    ...overrides,
  };
}

function codes(issues: Array<{ code: string }>): string[] {
  return issues.map((issue) => issue.code);
}

interface AgentOptions {
  wgRunning?: boolean;
  caddyActive?: boolean;
  rotation?: boolean;
  portConflict?: boolean;
  peers?: number;
  dependentSites?: number;
  forwards?: number;
  hostOpsPeers?: number;
}

function agentState(options: AgentOptions = {}): AgentState {
  const rotation = options.rotation
    ? [
        {
          code: MODE_CODES.rotationPending,
          message: '存在等待握手的换钥，请先确认或取消换钥再切换模式。',
          fixPath: 'wireguard',
          details: { peers: ['phone'] },
        },
      ]
    : [];
  const portBlockers = options.portConflict
    ? [
        {
          code: MODE_CODES.portConflict,
          message: 'udp/51820 已被 other-app 占用，切换前请修改 WireGuard 监听端口。',
          fixPath: 'wireguard',
          details: { proto: 'udp', port: 51820, occupiedBy: 'other-app' },
        },
      ]
    : [];
  const caddyBlockers =
    options.caddyActive === false
      ? [
          {
            code: MODE_CODES.caddyNotRunning,
            message: 'Caddy 未运行，切到网关前请先修复。',
            fixPath: 'sites',
          },
        ]
      : [];
  return {
    host: { hostname: 'hub-a' },
    agent: {
      version: '0.1.0',
      serverTime: NOW_SEC(),
      mode: options.wgRunning === false ? 'caddy' : 'wg',
    },
    adapters: [
      {
        name: 'wireguard',
        version: '1.0.0',
        appliedRev: 1,
        status: {
          installed: true,
          running: options.wgRunning ?? true,
          rotations: options.rotation ? [{ state: 'pending', peer: 'phone' }] : [],
          modeImpact: [
            { target: 'wg', blockers: [...rotation, ...portBlockers], summary: [] },
            {
              target: 'caddy',
              blockers: rotation,
              summary: options.peers ? [`${options.peers} 个客户端会断开（其中 1 个在线）`] : [],
            },
          ],
        },
      },
      {
        name: 'caddy-site',
        version: '1.1.0',
        appliedRev: 1,
        status: {
          active: options.caddyActive ?? true,
          validate: { ok: true },
          modeImpact: [
            {
              target: 'caddy',
              blockers: caddyBlockers,
              summary: options.dependentSites
                ? [`${options.dependentSites} 个站点的上游在内网（blog），切换后不可用`]
                : [],
            },
          ],
        },
      },
      {
        name: 'port-forward',
        version: '1.0.0',
        appliedRev: 1,
        status: {
          modeImpact: [
            {
              target: 'caddy',
              blockers: [],
              summary: options.forwards ? [`${options.forwards} 条端口转发会停止`] : [],
            },
          ],
        },
      },
      {
        name: 'host-ops',
        version: '1.0.0',
        appliedRev: 1,
        status: {
          modeImpact: [
            {
              target: 'caddy',
              blockers: [],
              summary: options.hostOpsPeers
                ? [`${options.hostOpsPeers} 台 Peer 的主机运维会失联`]
                : [],
            },
          ],
        },
      },
    ],
    ports: [],
  } as unknown as AgentState;
}

function NOW_SEC(): number {
  return Math.floor(Date.now() / 1000);
}

beforeEach(() => resetRateLimitForTests());

describe('双模式派生（纯函数）', () => {
  it('只剩 3 态：wg / caddy / unknown', () => {
    expect(deriveNodeMode(modeInput({ desired: null }))).toMatchObject({
      mode: 'unknown',
      target: null,
    });
    expect(deriveNodeMode(modeInput({ reachable: false }))).toMatchObject({
      mode: 'unknown',
      target: null,
    });
    expect(deriveNodeMode(modeInput())).toMatchObject({ mode: 'wg', target: 'caddy' });
    expect(deriveNodeMode(modeInput({ desired: 'caddy' }))).toMatchObject({
      mode: 'caddy',
      target: 'wg',
    });
  });

  it('只保留 4 个阻断码，并按固定顺序输出', () => {
    const impacts = [
      {
        target: 'caddy' as const,
        blockers: [
          { code: MODE_CODES.caddyNotRunning, message: 'Caddy 未运行', fixPath: 'sites' },
          { code: MODE_CODES.rotationPending, message: '换钥中', fixPath: 'wireguard' },
        ],
      },
      {
        target: 'wg' as const,
        blockers: [
          {
            code: MODE_CODES.portConflict,
            message: 'udp/51820 被占用',
            fixPath: 'wireguard',
            details: { proto: 'udp', port: 51820, occupiedBy: 'other-app' },
          },
        ],
      },
    ];
    const result = deriveNodeMode(modeInput({ impacts, configDirty: true }));
    expect(codes(result.blockers)).toEqual([
      MODE_CODES.rotationPending,
      MODE_CODES.configDirty,
      MODE_CODES.caddyNotRunning,
    ]);
    expect(result.blockers[0]).toMatchObject({ fixRoute: '/hubs/nd_1/wireguard' });
    expect(result.blockers[1]).toMatchObject({ fixRoute: '/hubs/nd_1/apps' });
    expect(result.blockers[2]).toMatchObject({ fixRoute: '/hubs/nd_1/sites' });
  });

  it('端口冲突只阻断切到组网，不阻断切到网关', () => {
    const impacts = [
      {
        target: 'wg' as const,
        blockers: [
          {
            code: MODE_CODES.portConflict,
            message: 'udp/443 冲突',
            fixPath: 'wireguard',
            details: { proto: 'udp', port: 443, reason: 'http3' },
          },
        ],
      },
    ];
    expect(codes(deriveNodeMode(modeInput({ impacts })).blockers)).not.toContain(
      MODE_CODES.portConflict,
    );
    expect(
      codes(deriveNodeMode(modeInput({ desired: 'caddy', impacts })).blockers),
    ).toContain(MODE_CODES.portConflict);
  });

  it('影响摘要合并成一条 warning，只取目标模式的片段', () => {
    const impacts = [
      { target: 'caddy' as const, summary: ['2 个客户端会断开（其中 1 个在线）'] },
      { target: 'caddy' as const, summary: ['1 条端口转发会停止'] },
      { target: 'wg' as const, summary: ['不应出现'] },
    ];
    const result = deriveNodeMode(modeInput({ impacts }));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({ code: MODE_CODES.impact });
    expect(result.warnings[0]?.message).toBe(
      '切换后：2 个客户端会断开（其中 1 个在线）；1 条端口转发会停止。',
    );
    expect(deriveNodeMode(modeInput({ desired: 'caddy', impacts })).warnings[0]?.message).toContain('不应出现');
  });

  it('没有影响时不出 warning', () => {
    expect(deriveNodeMode(modeInput()).warnings).toEqual([]);
  });

  it('collectModeImpacts 只接受合法 target/blocker，坏状态不炸', () => {
    const impacts = collectModeImpacts([
      { status: { modeImpact: [{ target: 'caddy', blockers: [{ code: 'X', message: 'm' }] }] } },
      { status: { modeImpact: { target: 'wg', summary: ['s'] } } },
      { status: { modeImpact: [{ target: 'bogus', summary: ['no'] }] } },
      { status: null },
      {},
    ]);
    expect(impacts).toEqual([
      { target: 'caddy', blockers: [{ code: 'X', message: 'm' }], summary: [] },
      { target: 'wg', blockers: [], summary: ['s'] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

async function seedModeConfigs(
  ctx: ReturnType<typeof makeTestContext>,
  nodeId: string,
  options: { wg?: Record<string, unknown> | null; forwards?: Record<string, unknown>; caddy?: Record<string, unknown> } = {},
): Promise<void> {
  const wg = options.wg === undefined ? WG_CONFIG : options.wg;
  if (wg !== null) {
    await ctx.apps.put(nodeId, 'wireguard', { config: wg, schemaVersion: 1, actor: 'test' });
    await ctx.apps.setAppliedRev(nodeId, 'wireguard', 1);
  }
  await ctx.apps.put(nodeId, 'port-forward', {
    config: options.forwards ?? { forwards: [] },
    schemaVersion: 1,
    actor: 'test',
  });
  await ctx.apps.setAppliedRev(nodeId, 'port-forward', 1);
  await ctx.apps.put(nodeId, 'caddy-site', {
    config: options.caddy ?? CADDY_CONFIG,
    schemaVersion: 1,
    actor: 'test',
  });
  await ctx.apps.setAppliedRev(nodeId, 'caddy-site', 1);
}

describe('GET /nodes/:id/mode', () => {
  it('未登录 401；节点不存在 404', async () => {
    const ctx = makeTestContext();
    const anon = await ctx.app.request('/api/v1/nodes/nd_x/mode', {}, ctx.env);
    expect(anon.status).toBe(401);

    const cookie = await loginAsAdmin(ctx);
    const missing = await ctx.app.request('/api/v1/nodes/nd_x/mode', { headers: authHeaders(cookie) }, ctx.env);
    expect(missing.status).toBe(404);
    expect(ctx.agent.requests).toHaveLength(0);
  });

  it('wg 模式：3 态 + 一条影响摘要 + no-store，且不写 D1/audit', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    await seedModeConfigs(ctx, id);
    ctx.agent.handler = async () => ({
      status: 200,
      body: { ok: true, ...agentState({ peers: 2, dependentSites: 1, forwards: 1, hostOpsPeers: 1 }) },
    });
    ctx.audit.entries.length = 0;
    const updateSpy = vi.spyOn(ctx.nodes, 'update');
    const auditSpy = vi.spyOn(ctx.audit, 'log');

    const res = await ctx.app.request(`/api/v1/nodes/${id}/mode`, { headers: authHeaders(cookie) }, ctx.env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(nodeModeSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ nodeId: id, mode: 'wg', target: 'caddy', reachable: true });
    expect(body.blockers).toEqual([]);
    const warnings = body.warnings as Array<{ code: string; message: string }>;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe(MODE_CODES.impact);
    expect(warnings[0]?.message).toContain('2 个客户端会断开');
    expect(warnings[0]?.message).toContain('1 条端口转发会停止');
    expect(warnings[0]?.message).toContain('1 台 Peer 的主机运维会失联');
    expect(warnings[0]?.message).toContain('1 个站点的上游在内网');
    expect(ctx.agent.requests).toHaveLength(1);
    expect(ctx.agent.requests[0]?.path).toBe('/state');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('节点不可达：200 + mode=unknown（不 5xx）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    await seedModeConfigs(ctx, id);
    ctx.agent.handler = async () => {
      throw new HubUnreachableError('Hub 不可达', { direct: 'TCP 连接超时（>3000ms）' });
    };
    const res = await ctx.app.request(`/api/v1/nodes/${id}/mode`, { headers: authHeaders(cookie) }, ctx.env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; target: unknown; reachable: boolean; warnings: unknown[] };
    expect(body).toMatchObject({ mode: 'unknown', target: null, reachable: false });
    expect(body.warnings).toEqual([]);
  });

  it('未配置 WireGuard → unknown', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    ctx.agent.handler = async () => ({ status: 200, body: { ok: true, ...agentState() } });
    const res = await ctx.app.request(`/api/v1/nodes/${id}/mode`, { headers: authHeaders(cookie) }, ctx.env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; target: unknown };
    expect(body).toMatchObject({ mode: 'unknown', target: null });
  });

  it('切到 caddy：Caddy 未运行 → 唯一阻断；转发只进影响摘要', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    await seedModeConfigs(ctx, id, { forwards: { forwards: [{ name: 'ssh', listenPort: 2201, enabled: true }] } });
    ctx.agent.handler = async () => ({
      status: 200,
      body: { ok: true, ...agentState({ wgRunning: true, caddyActive: false, forwards: 1 }) },
    });
    const res = await ctx.app.request(`/api/v1/nodes/${id}/mode`, { headers: authHeaders(cookie) }, ctx.env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      target: string;
      blockers: Array<{ code: string; fixRoute?: string }>;
      warnings: Array<{ message: string }>;
    };
    expect(body).toMatchObject({ mode: 'wg', target: 'caddy' });
    expect(codes(body.blockers)).toEqual([MODE_CODES.caddyNotRunning]);
    expect(body.blockers[0]?.fixRoute).toBe(`/hubs/${id}/sites`);
    expect(body.warnings[0]?.message).toContain('1 条端口转发会停止');
  });

  it('切到 wg：端口冲突 → 阻断，但 Caddy 未运行不阻断', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    await seedModeConfigs(ctx, id, { wg: { ...WG_CONFIG, enabled: false } });
    ctx.agent.handler = async () => ({
      status: 200,
      body: {
        ok: true,
        ...agentState({ wgRunning: false, caddyActive: false, portConflict: true }),
      },
    });
    const res = await ctx.app.request(`/api/v1/nodes/${id}/mode`, { headers: authHeaders(cookie) }, ctx.env);
    const body = (await res.json()) as {
      mode: string;
      target: string;
      blockers: Array<{ code: string; details?: Record<string, unknown> }>;
    };
    expect(body).toMatchObject({ mode: 'caddy', target: 'wg' });
    expect(codes(body.blockers)).toEqual([MODE_CODES.portConflict]);
    expect(body.blockers[0]?.details).toMatchObject({
      proto: 'udp',
      port: 51820,
      occupiedBy: 'other-app',
    });
  });

  it('换钥进行中两个方向都阻断', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    await seedModeConfigs(ctx, id);
    ctx.agent.handler = async () => ({
      status: 200,
      body: { ok: true, ...agentState({ rotation: true }) },
    });
    const res = await ctx.app.request(`/api/v1/nodes/${id}/mode`, { headers: authHeaders(cookie) }, ctx.env);
    const body = (await res.json()) as { blockers: Array<{ code: string }> };
    expect(codes(body.blockers)).toEqual([MODE_CODES.rotationPending]);
  });

  it('配置未生效 → MODE_BLOCKED_CONFIG_DIRTY', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    await ctx.apps.put(id, 'wireguard', { config: WG_CONFIG, schemaVersion: 1, actor: 'test' });
    ctx.agent.handler = async () => ({ status: 200, body: { ok: true, ...agentState() } });
    const res = await ctx.app.request(`/api/v1/nodes/${id}/mode`, { headers: authHeaders(cookie) }, ctx.env);
    const body = (await res.json()) as { blockers: Array<{ code: string }> };
    expect(codes(body.blockers)).toContain(MODE_CODES.configDirty);
  });
});

// ---------------------------------------------------------------------------
// D6 / D7
// ---------------------------------------------------------------------------

describe('D6：last_apply_error', () => {
  async function seedApp(ctx: ReturnType<typeof makeTestContext>, cookie: string): Promise<string> {
    const { id } = await createNode(ctx, cookie);
    await ctx.app.request(
      `/api/v1/nodes/${id}/apps/wireguard`,
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({ config: WG_CONFIG, schemaVersion: 1 }),
      },
      ctx.env,
    );
    return id;
  }

  it('Agent 200 + ok=false 写入错误；成功 apply 清除', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const id = await seedApp(ctx, cookie);
    ctx.agent.handler = async (method, path) => {
      if (path.endsWith('/apply')) {
        return {
          status: 200,
          body: { ok: false, error: { code: 'apply_failed', message: 'health check failed' } },
        };
      }
      return { status: 200, body: { ok: true } };
    };
    const failed = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/wireguard/apply`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ idempotencyKey: 'apply-fail-1' }),
      },
      ctx.env,
    );
    expect(failed.status).toBe(200);

    const afterFail = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/wireguard`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    const failBody = (await afterFail.json()) as {
      app: { lastApplyError: { code: string; message: string } | null };
    };
    expect(failBody.app.lastApplyError).toMatchObject({
      code: 'apply_failed',
      message: 'health check failed',
    });

    ctx.agent.handler = async (method, path) => {
      if (path.endsWith('/apply')) {
        return { status: 200, body: { ok: true, rev: 1, appliedRev: 1 } };
      }
      return { status: 200, body: { ok: true } };
    };
    const ok = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/wireguard/apply`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ idempotencyKey: 'apply-ok-1' }),
      },
      ctx.env,
    );
    expect(ok.status).toBe(200);
    const afterOk = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/wireguard`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    const okBody = (await afterOk.json()) as { app: { lastApplyError: unknown } };
    expect(okBody.app.lastApplyError).toBeNull();
  });

  it('Agent HTTP 错误 / 网络异常也写入摘要', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const id = await seedApp(ctx, cookie);

    ctx.agent.handler = async () => ({
      status: 502,
      body: { ok: false, error: { code: 'apply_failed', message: 'agent exploded' } },
    });
    const httpError = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/wireguard/apply`,
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({ idempotencyKey: 'apply-http' }) },
      ctx.env,
    );
    expect(httpError.status).toBeGreaterThanOrEqual(400);
    let stored = await ctx.apps.get(id, 'wireguard');
    expect(stored?.lastApplyError).toMatchObject({ code: 'apply_failed', message: 'agent exploded' });

    ctx.agent.handler = async () => {
      throw new HubUnreachableError('Hub 不可达', { direct: 'timeout' });
    };
    const network = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/wireguard/apply`,
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({ idempotencyKey: 'apply-net' }) },
      ctx.env,
    );
    expect(network.status).toBeGreaterThanOrEqual(400);
    stored = await ctx.apps.get(id, 'wireguard');
    expect(stored?.lastApplyError?.code).toBe('hub_unreachable');
  });

  it('重新保存配置会清空旧错误；diagnostics config.sync 使用 lastApplyError', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const id = await seedApp(ctx, cookie);
    await ctx.apps.setLastApplyError(id, 'wireguard', {
      code: 'apply_failed',
      message: 'old failure',
      at: NOW_SEC(),
    });
    await ctx.app.request(
      `/api/v1/nodes/${id}/apps/wireguard`,
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({ config: { ...WG_CONFIG, enabled: false }, schemaVersion: 1 }),
      },
      ctx.env,
    );
    const stored = await ctx.apps.get(id, 'wireguard');
    expect(stored?.lastApplyError).toBeNull();

    // 再写一次失败摘要，诊断应命中 pending_apply（而不是只按 10 分钟年龄猜）
    await ctx.apps.setLastApplyError(id, 'wireguard', {
      code: 'apply_failed',
      message: 'restart failed',
      at: NOW_SEC(),
    });
    ctx.agent.handler = async () => ({ status: 200, body: { ok: true, ...agentState() } });
    const diag = await ctx.app.request(
      `/api/v1/nodes/${id}/diagnostics`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(diag.status).toBe(200);
    const body = (await diag.json()) as { checks: Array<{ id: string; code: string; severity: string; detail: string }> };
    const sync = body.checks.find((check) => check.id === 'config.sync');
    expect(sync).toMatchObject({ severity: 'warn', code: 'khc.config.pending_apply' });
    expect(sync?.detail).toContain('apply_failed');
  });
});

describe('D7：/state.agent', () => {
  it('Worker 在接受新版 /state 的同时兼容旧版（无 agent 字段）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    const state = agentState();
    delete (state as { agent?: unknown }).agent;
    ctx.agent.handler = async () => ({ status: 200, body: { ok: true, ...state } });
    const res = await ctx.app.request(`/api/v1/nodes/${id}/state`, { headers: authHeaders(cookie) }, ctx.env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: { agent?: unknown } };
    expect(body.state.agent).toBeUndefined();

    const withAgent = await ctx.app.request(`/api/v1/nodes/${id}/diagnostics`, {
      headers: authHeaders(cookie),
    }, ctx.env);
    expect(withAgent.status).toBe(200);
  });

  it('diagnostics 使用 agent.serverTime 检查时钟偏差', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    const state = agentState();
    state.agent = { version: '0.1.0', serverTime: NOW_SEC() - 120 };
    ctx.agent.handler = async () => ({ status: 200, body: { ok: true, ...state } });
    const res = await ctx.app.request(
      `/api/v1/nodes/${id}/diagnostics`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    const body = (await res.json()) as {
      checks: Array<{ id: string; severity: string; code: string }>;
    };
    const clock = body.checks.find((check) => check.id === 'agent.clock');
    expect(clock).toMatchObject({ severity: 'warn', code: 'khc.agent.clock_skew' });
    // 只返回问题：版本正常时不再产生 ok 行。
    expect(body.checks.every((check) => check.severity !== ('ok' as string))).toBe(true);
  });
});
