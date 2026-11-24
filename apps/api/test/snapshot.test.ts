import { describe, expect, it } from 'vitest';
import { HttpAgentClient, HubUnreachableError } from '../src/lib/node-client';
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

  it('节点冷却期间：/snapshot?force=1 与 /state?force=1 跳过冷却并清除冷却', async () => {
    let shouldFail = true;
    const client = new HttpAgentClient(
      async (url) => {
        if (shouldFail) throw new Error('ECONNREFUSED');
        const path = new URL(String(url)).pathname;
        if (path === '/snapshot') {
          return new Response(JSON.stringify(SNAPSHOT), { status: 200 });
        }
        return new Response(
          JSON.stringify({ ok: true, host: { hostname: 'hub-test' }, adapters: [], ports: [] }),
          { status: 200 },
        );
      },
      async () => {
        throw new Error('ECONNREFUSED');
      },
    );
    const ctx = makeTestContext(undefined, client);
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);

    // 首次 /state 失败触发冷却
    const firstState = await ctx.app.request(
      `/api/v1/nodes/${id}/state`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(((await firstState.json()) as { reachable: boolean }).reachable).toBe(false);

    // 恢复后普通 /snapshot 命中冷却（不发请求）
    shouldFail = false;
    const cooledSnap = await ctx.app.request(
      `/api/v1/nodes/${id}/snapshot`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    const cooledBody = (await cooledSnap.json()) as { reachable: boolean; error: string | null };
    expect(cooledBody.reachable).toBe(false);
    expect(cooledBody.error).toContain('冷却');

    // /state?force=1 与 /snapshot?force=1 均跳过冷却并恢复在线
    const forcedState = await ctx.app.request(
      `/api/v1/nodes/${id}/state?force=1`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(((await forcedState.json()) as { reachable: boolean }).reachable).toBe(true);

    // 重新进入冷却，再验证 /snapshot?force=1
    shouldFail = true;
    await ctx.app.request(`/api/v1/nodes/${id}/state`, { headers: authHeaders(cookie) }, ctx.env);
    shouldFail = false;
    const forcedSnap = await ctx.app.request(
      `/api/v1/nodes/${id}/snapshot?force=1`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(((await forcedSnap.json()) as { reachable: boolean }).reachable).toBe(true);
  });
});
