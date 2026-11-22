import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

const stateBody = {
  host: { hostname: 'node-1', uptime: 120 },
  adapters: [{ name: 'caddy-site', version: '1.0.0', status: { installed: true, running: true, sites: [] } }],
  ports: [],
};

const snapshotBody = {
  ts: 1_730_000_000,
  host: { hostname: 'node-1', uptime: 120 },
  ops: {
    cpu: { usagePercent: 5, load: [0.1, 0.1, 0.1] },
    mem: { total: 1000, used: 200, percent: 20 },
    disks: [{ total: 1000, used: 100, percent: 10 }],
    services: { services: [], failedUnits: [] },
  },
};

beforeEach(() => {
  resetRateLimitForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('B3-② 只读节点缓存（/snapshot、/state、/overview）与写后失效', () => {
  it('15s 内 /state、/overview、/snapshot 共享缓存只读 1 次 D1，超时后刷新', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-22T12:00:00Z'));

    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const node = await createNode(ctx, cookie);

    const getSpy = vi.spyOn(ctx.nodes, 'get');
    ctx.agent.handler = async (_method, path) => {
      if (path === '/snapshot') return { status: 200, body: snapshotBody };
      return { status: 200, body: stateBody };
    };

    expect((await ctx.app.request(`/api/v1/nodes/${node.id}/state`, { headers }, ctx.env)).status).toBe(200);
    expect((await ctx.app.request(`/api/v1/nodes/${node.id}/overview`, { headers }, ctx.env)).status).toBe(200);
    expect((await ctx.app.request(`/api/v1/nodes/${node.id}/snapshot`, { headers }, ctx.env)).status).toBe(200);
    expect((await ctx.app.request(`/api/v1/nodes/${node.id}/state`, { headers }, ctx.env)).status).toBe(200);
    expect(getSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(15_001);
    expect((await ctx.app.request(`/api/v1/nodes/${node.id}/state`, { headers }, ctx.env)).status).toBe(200);
    expect(getSpy).toHaveBeenCalledTimes(2);
  });

  it('同 isolate 内 PATCH endpoint 后立刻 GET /state 使用新地址，不读旧缓存', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const node = await createNode(ctx, cookie);

    const seenEndpoints: string[] = [];
    ctx.agent.handler = async (_method, path, _body, agentNode) => {
      if (agentNode) seenEndpoints.push(agentNode.endpoint);
      if (path === '/snapshot') return { status: 200, body: snapshotBody };
      return { status: 200, body: stateBody };
    };

    await ctx.app.request(`/api/v1/nodes/${node.id}/state`, { headers }, ctx.env);
    expect(seenEndpoints).toEqual(['https://hub.example.com:8443']);

    const patchRes = await ctx.app.request(
      `/api/v1/nodes/${node.id}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ endpoint: 'https://new.example.com:8443' }),
      },
      ctx.env,
    );
    expect(patchRes.status).toBe(200);

    await ctx.app.request(`/api/v1/nodes/${node.id}/state`, { headers }, ctx.env);
    await ctx.app.request(`/api/v1/nodes/${node.id}/overview`, { headers }, ctx.env);
    expect(seenEndpoints.slice(1)).toEqual([
      'https://new.example.com:8443',
      'https://new.example.com:8443',
    ]);
  });

  it('DELETE 节点后立即 GET /state 与 /overview 返回 404（失效缓存）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const node = await createNode(ctx, cookie);

    ctx.agent.handler = async () => ({ status: 200, body: stateBody });
    expect((await ctx.app.request(`/api/v1/nodes/${node.id}/state`, { headers }, ctx.env)).status).toBe(200);

    const delRes = await ctx.app.request(`/api/v1/nodes/${node.id}`, { method: 'DELETE', headers }, ctx.env);
    expect(delRes.status).toBe(200);

    expect((await ctx.app.request(`/api/v1/nodes/${node.id}/state`, { headers }, ctx.env)).status).toBe(404);
    expect((await ctx.app.request(`/api/v1/nodes/${node.id}/overview`, { headers }, ctx.env)).status).toBe(404);
  });

  it('lastSeenAt 60s 节流在缓存命中期间依然生效（60s 内不重复写 D1）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-22T12:00:00Z'));

    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const node = await createNode(ctx, cookie);

    const updateSpy = vi.spyOn(ctx.nodes, 'update');
    ctx.agent.handler = async (_method, path) => {
      if (path === '/snapshot') return { status: 200, body: snapshotBody };
      return { status: 200, body: stateBody };
    };

    // 首次 /state 写入 lastSeenAt
    await ctx.app.request(`/api/v1/nodes/${node.id}/state`, { headers }, ctx.env);
    expect(updateSpy).toHaveBeenCalledTimes(1);

    // 紧接着命中缓存多次，不应再写 D1
    await ctx.app.request(`/api/v1/nodes/${node.id}/state`, { headers }, ctx.env);
    await ctx.app.request(`/api/v1/nodes/${node.id}/overview`, { headers }, ctx.env);
    await ctx.app.request(`/api/v1/nodes/${node.id}/snapshot`, { headers }, ctx.env);
    expect(updateSpy).toHaveBeenCalledTimes(1);

    // 超过 60s 后再调用允许再次刷新 lastSeenAt
    vi.advanceTimersByTime(61_000);
    await ctx.app.request(`/api/v1/nodes/${node.id}/state`, { headers }, ctx.env);
    expect(updateSpy).toHaveBeenCalledTimes(2);
  });

  it('更新全局隧道域名后节点只读缓存同步失效，立即 /state 用新域名', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);

    const createTun = await ctx.app.request(
      '/api/v1/tunnels',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 't1',
          hostname: 'tun-old.example.com',
          originPort: 8880,
          token: 't'.repeat(24),
        }),
      },
      ctx.env,
    );
    expect(createTun.status).toBe(201);
    const tunnelId = ((await createTun.json()) as { tunnel: { id: string } }).tunnel.id;

    const createNodeRes = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: 'tun-hub',
          accessMode: 'tunnel',
          tunnelId,
        }),
      },
      ctx.env,
    );
    expect(createNodeRes.status).toBe(201);
    const node = ((await createNodeRes.json()) as { node: { id: string } }).node;

    const seen: string[] = [];
    ctx.agent.handler = async (_m, _p, _b, agentNode) => {
      if (agentNode) seen.push(agentNode.tunnelEndpoint ?? agentNode.endpoint);
      return { status: 200, body: stateBody };
    };

    await ctx.app.request(`/api/v1/nodes/${node.id}/state`, { headers }, ctx.env);
    expect(seen).toEqual(['https://tun-old.example.com']);

    const updTun = await ctx.app.request(
      `/api/v1/tunnels/${tunnelId}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ hostname: 'tun-new.example.com' }),
      },
      ctx.env,
    );
    expect(updTun.status).toBe(200);

    await ctx.app.request(`/api/v1/nodes/${node.id}/state`, { headers }, ctx.env);
    expect(seen).toEqual(['https://tun-old.example.com', 'https://tun-new.example.com']);
  });
});
