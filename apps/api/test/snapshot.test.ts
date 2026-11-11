import { describe, expect, it } from 'vitest';
import { HubUnreachableError } from '../src/lib/node-client';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

const SNAPSHOT = {
  ok: true,
  ts: 100,
  host: { hostname: 'hub-test', uptime: 3600, load: [0.1, 0.2, 0.3] },
  ops: {
    cpu: { cores: 2, model: 'Test CPU', usagePercent: 12.5, load: [0.1, 0.2, 0.3] },
    mem: { total: 1000, available: 600, used: 400, percent: 40 },
    disks: [{ name: 'root', path: '/', total: 100, used: 20, free: 80, percent: 20 }],
    collectedAt: 100,
  },
  agent: { version: '0.1.0', serverTime: 100 },
};

describe('快照转发（无域名节点）', () => {
  it('未登录 401', async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.request('/api/v1/nodes/nd_x/snapshot', {}, ctx.env);
    expect(res.status).toBe(401);
  });

  it('转发 Agent /snapshot 并返回轻量指标', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    ctx.agent.handler = async (_method, path) =>
      path === '/snapshot'
        ? { status: 200, body: SNAPSHOT }
        : { status: 404, body: { error: { code: 'not_found', message: 'no' } } };

    const res = await ctx.app.request(
      `/api/v1/nodes/${id}/snapshot`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reachable).toBe(true);
    expect((body.snapshot as typeof SNAPSHOT).ops.cpu.usagePercent).toBe(12.5);
    expect(ctx.agent.requests.some((item) => item.path === '/snapshot')).toBe(true);
  });

  it('Hub 不可达时 200 + reachable=false（页面进入失败态而非报错）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    ctx.agent.handler = async () => {
      throw new HubUnreachableError('hub unreachable', { direct: 'timeout' });
    };
    const res = await ctx.app.request(
      `/api/v1/nodes/${id}/snapshot`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reachable).toBe(false);
    expect(body.snapshot).toBeNull();
  });

  it('2 秒内并发请求只打一次 Agent（单 isolate 尽力而为）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    let calls = 0;
    ctx.agent.handler = async (_method, path) => {
      if (path === '/snapshot') {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { status: 200, body: SNAPSHOT };
      }
      return { status: 404, body: {} };
    };

    const [first, second] = await Promise.all([
      ctx.app.request(`/api/v1/nodes/${id}/snapshot`, { headers: authHeaders(cookie) }, ctx.env),
      ctx.app.request(`/api/v1/nodes/${id}/snapshot`, { headers: authHeaders(cookie) }, ctx.env),
    ]);
    expect(calls).toBe(1);
    const bodies = (await Promise.all([first.json(), second.json()])) as Array<Record<string, unknown>>;
    expect(bodies.filter((body) => body.cached === true)).toHaveLength(1);
  });
});
