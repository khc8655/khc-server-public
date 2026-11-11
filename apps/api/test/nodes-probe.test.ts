import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { HubUnreachableError } from '../src/lib/node-client';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

beforeEach(() => resetRateLimitForTests());

describe('POST /nodes/probe（一次请求批量探测）', () => {
  const stateBody = {
    host: { hostname: 'hub' },
    adapters: [
      {
        name: 'wireguard',
        version: '1.0.0',
        status: { installed: false, running: false },
      },
      {
        name: 'caddy-site',
        version: '1.0.0',
        status: { installed: true, running: true },
      },
      { name: 'host-ops', version: '1.0.0' },
    ],
    ports: [],
  };

  it('逐节点返回可达结果与应用状态；只有成功的节点更新 lastSeenAt', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const first = await createNode(ctx, cookie);
    const second = await createNode(ctx, cookie);

    ctx.agent.handler = async (_method, path, _body, node) => {
      if (path !== '/state') return { status: 404, body: {} };
      if (node?.id === second.id) {
        throw new HubUnreachableError('Hub 不可达', { direct: 'ECONNREFUSED' });
      }
      return { status: 200, body: stateBody };
    };

    const res = await ctx.app.request(
      '/api/v1/nodes/probe',
      { method: 'POST', headers },
      ctx.env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as {
      probedAt: number;
      nodes: Array<{
        id: string;
        reachable: boolean;
        error: string | null;
        lastSeenAt: number | null;
        apps?: Array<{ name: string; installed: boolean | null; running: boolean | null }>;
      }>;
    };
    expect(body.nodes).toHaveLength(2);
    const ok = body.nodes.find((n) => n.id === first.id);
    const bad = body.nodes.find((n) => n.id === second.id);
    expect(ok?.reachable).toBe(true);
    expect(ok?.error).toBeNull();
    expect(ok?.lastSeenAt).toBe(body.probedAt);
    // 只透出 name/installed/running，未上报的字段为 null（不伪造）
    expect(ok?.apps).toEqual([
      { name: 'wireguard', installed: false, running: false },
      { name: 'caddy-site', installed: true, running: true },
      { name: 'host-ops', installed: null, running: null },
    ]);
    expect(bad?.reachable).toBe(false);
    expect(bad?.error).toContain('Hub 不可达');
    expect(bad?.apps).toBeUndefined();

    const storedFirst = await ctx.nodes.get(first.id);
    const storedSecond = await ctx.nodes.get(second.id);
    expect(storedFirst?.lastSeenAt).toBe(body.probedAt);
    expect(storedSecond?.lastSeenAt).toBeNull();
  });

  it('只访问 Agent /state（一次调用同时拿可达性与应用状态）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    await createNode(ctx, cookie);
    ctx.agent.handler = async () => ({ status: 200, body: stateBody });
    await ctx.app.request('/api/v1/nodes/probe', { method: 'POST', headers: authHeaders(cookie) }, ctx.env);
    expect(ctx.agent.requests.map((request) => request.path)).toEqual(['/state']);
    // /state 比 /health 重（systemctl/ps/df），沿用状态页的 10s 预算。
    expect(ctx.agent.requests[0]?.timeoutMs).toBe(10_000);
  });

  it('/state 返回非 2xx：标离线且不带 apps，不影响 lastSeenAt', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const node = await createNode(ctx, cookie);
    ctx.agent.handler = async () => ({ status: 500, body: { error: 'boom' } });
    const res = await ctx.app.request(
      '/api/v1/nodes/probe',
      { method: 'POST', headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: Array<{ reachable: boolean; error: string | null; apps?: unknown }>;
    };
    expect(body.nodes[0]?.reachable).toBe(false);
    expect(body.nodes[0]?.error).toContain('HTTP 500');
    expect(body.nodes[0]?.apps).toBeUndefined();
    expect((await ctx.nodes.get(node.id))?.lastSeenAt).toBeNull();
  });

  it('/state 结构不合法：可达仍为 true，apps 为空数组（不伪造状态）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    await createNode(ctx, cookie);
    ctx.agent.handler = async () => ({ status: 200, body: { ok: true } });
    const res = await ctx.app.request(
      '/api/v1/nodes/probe',
      { method: 'POST', headers: authHeaders(cookie) },
      ctx.env,
    );
    const body = (await res.json()) as {
      nodes: Array<{ reachable: boolean; apps?: unknown[] }>;
    };
    expect(body.nodes[0]?.reachable).toBe(true);
    expect(body.nodes[0]?.apps).toEqual([]);
  });

  it('未登录返回 401', async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.request('/api/v1/nodes/probe', { method: 'POST' }, ctx.env);
    expect(res.status).toBe(401);
  });

  it('没有节点时返回空列表而不是 5xx', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/nodes/probe',
      { method: 'POST', headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: unknown[] };
    expect(body.nodes).toEqual([]);
  });
});
