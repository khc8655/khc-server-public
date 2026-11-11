import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { HttpAgentClient } from '../src/lib/node-client';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

beforeEach(() => resetRateLimitForTests());

describe('apps: 配置仓库 + Agent 转发', () => {
  it('PUT 配置生成新 rev；GET 列表带适配器', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    ctx.agent.handler = async () => ({
      status: 200,
      body: { ok: true, adapters: [{ name: 'node-exporter', version: '1.0.0', api: 1 }] },
    });

    const put = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter`,
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({ config: { port: 9100 }, note: 'first' }),
      },
      ctx.env,
    );
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { app: { rev: number; appliedRev: number | null } };
    expect(putBody.app.rev).toBe(1);
    expect(putBody.app.appliedRev).toBeNull();

    const list = await ctx.app.request(`/api/v1/nodes/${id}/apps`, { headers: authHeaders(cookie) }, ctx.env);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      apps: Array<{ app: string; rev: number }>;
      adapters: Array<{ name: string }>;
      adaptersError: string | null;
    };
    expect(listBody.apps).toHaveLength(1);
    expect(listBody.apps[0]).toMatchObject({ app: 'node-exporter', rev: 1 });
    expect(listBody.adapters[0]?.name).toBe('node-exporter');
    expect(listBody.adaptersError).toBeNull();

    const revisions = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter/revisions`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    const revBody = (await revisions.json()) as { revisions: Array<{ rev: number; note: string }> };
    expect(revBody.revisions).toHaveLength(1);
    expect(revBody.revisions[0]).toMatchObject({ rev: 1, note: 'first' });
  });

  it('plan / apply：带 expectRev 转发，apply 成功后回写 appliedRev', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);

    await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter`,
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({ config: { port: 9100 } }),
      },
      ctx.env,
    );

    ctx.agent.handler = async (method, path, body) => {
      if (path.endsWith('/plan')) {
        return {
          status: 200,
          body: {
            ok: true,
            rev: 1,
            changes: [{ path: '/etc/systemd/system/khc-node-exporter.service', diff: '+ ...' }],
          },
        };
      }
      if (path.endsWith('/apply')) {
        const payload = body as { expectRev: number };
        return {
          status: 200,
          body: {
            ok: true,
            rev: payload.expectRev,
            appliedRev: payload.expectRev,
            result: { cards: [{ title: '监听', value: ':9100', copy: true }] },
          },
        };
      }
      return { status: 200, body: { ok: true } };
    };

    const plan = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter/plan`,
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({}) },
      ctx.env,
    );
    expect(plan.status).toBe(200);
    const planBody = (await plan.json()) as { changes: Array<{ path: string }> };
    expect(planBody.changes).toHaveLength(1);

    const apply = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter/apply`,
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({}) },
      ctx.env,
    );
    expect(apply.status).toBe(200);
    const stored = await ctx.apps.get(id, 'node-exporter');
    expect(stored?.appliedRev).toBe(1);

    const planRequest = ctx.agent.requests.find((r) => r.path.endsWith('/plan'));
    expect((planRequest?.body as { expectRev: number }).expectRev).toBe(1);
    expect((planRequest?.body as { config: unknown }).config).toEqual({ port: 9100 });
    // D-2/T2.2：apply 载荷带节点当前 rev epoch（Agent 据此判定旧纪元）
    const applyRequest = ctx.agent.requests.find((r) => r.path.endsWith('/apply'));
    const node = await ctx.nodes.get(id);
    expect((applyRequest?.body as { epoch?: string }).epoch).toBe(node?.revEpoch);
  });

  it('apply 时 Agent 返回 500 结构化错误：透传真实 code，不误标 hub_unreachable', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);

    await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter`,
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({ config: { port: 9100 } }),
      },
      ctx.env,
    );

    ctx.agent.handler = async () => ({
      status: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: 'OSError: [Errno 30] Read-only file system: /etc/khc',
        },
      },
    });

    const apply = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter/apply`,
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({}) },
      ctx.env,
    );
    expect(apply.status).toBe(502);
    const body = (await apply.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toContain('Read-only file system');
    expect(body.error.code).not.toBe('hub_unreachable');

    // 失败摘要记录真实错误码，供诊断使用；appliedRev 不推进。
    const stored = await ctx.apps.get(id, 'node-exporter');
    expect(stored?.appliedRev).toBeNull();
    expect(stored?.lastApplyError?.code).toBe('internal_error');
  });

  it('apply 时 Agent 网络层失败仍归类 hub_unreachable', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);

    await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter`,
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({ config: { port: 9100 } }),
      },
      ctx.env,
    );

    ctx.agent.handler = async () => {
      throw new Error('fetch failed: connection reset');
    };

    const apply = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter/apply`,
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({}) },
      ctx.env,
    );
    expect(apply.status).toBe(502);
    const body = (await apply.json()) as { error: { code: string } };
    expect(body.error.code).toBe('hub_unreachable');
    const stored = await ctx.apps.get(id, 'node-exporter');
    expect(stored?.lastApplyError?.code).toBe('hub_unreachable');
  });

  it('自定义动作（client_config）可透传到 Agent', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    await ctx.app.request(
      `/api/v1/nodes/${id}/apps/wireguard`,
      { method: 'PUT', headers: authHeaders(cookie), body: JSON.stringify({ config: { peers: [] } }) },
      ctx.env,
    );
    ctx.agent.handler = async (_method, path) => {
      if (path.endsWith('/client_config')) {
        return {
          status: 200,
          body: { ok: true, result: { cards: [{ title: '客户端配置', value: '[Interface]', copy: true }] } },
        };
      }
      return { status: 200, body: { ok: true } };
    };
    const res = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/wireguard/client_config`,
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({ params: { peer: 'phone' } }) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { cards: Array<{ title: string }> } };
    expect(body.result.cards[0]?.title).toBe('客户端配置');
    const request = ctx.agent.requests.find((r) => r.path.endsWith('/client_config'));
    expect((request?.body as { params: { peer: string } }).params.peer).toBe('phone');
  });

  it('install 返回 taskId；任务状态可代理查询', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter`,
      { method: 'PUT', headers: authHeaders(cookie), body: JSON.stringify({ config: {} }) },
      ctx.env,
    );

    ctx.agent.handler = async (method, path) => {
      if (path.endsWith('/install')) return { status: 200, body: { ok: true, taskId: 't_1' } };
      if (path === '/tasks/t_1') {
        return {
          status: 200,
          body: { ok: true, task: { id: 't_1', state: 'done', logs: ['installed'] } },
        };
      }
      return { status: 200, body: { ok: true } };
    };

    const install = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter/install`,
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({}) },
      ctx.env,
    );
    const installBody = (await install.json()) as { taskId: string };
    expect(installBody.taskId).toBe('t_1');

    const task = await ctx.app.request(
      `/api/v1/nodes/${id}/tasks/t_1`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    const taskBody = (await task.json()) as { task: { state: string } };
    expect(taskBody.task.state).toBe('done');
  });

  it('rollback = 旧配置生成新 rev 再 apply', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);

    const put = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter`,
      { method: 'PUT', headers: authHeaders(cookie), body: JSON.stringify({ config: { port: 9100 } }) },
      ctx.env,
    );
    expect(put.status).toBe(200);

    ctx.agent.handler = async (_method, path, body) => {
      if (path.endsWith('/apply')) {
        const payload = body as { expectRev: number };
        return { status: 200, body: { ok: true, rev: payload.expectRev, appliedRev: payload.expectRev } };
      }
      return { status: 200, body: { ok: true } };
    };

    await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter/apply`,
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({}) },
      ctx.env,
    );
    await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter`,
      { method: 'PUT', headers: authHeaders(cookie), body: JSON.stringify({ config: { port: 9200 } }) },
      ctx.env,
    );

    const rollback = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter/rollback/1`,
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({}) },
      ctx.env,
    );
    expect(rollback.status).toBe(200);
    const body = (await rollback.json()) as { ok: boolean; app: { rev: number; config: { port: number } } };
    expect(body.ok).toBe(true);
    expect(body.app.rev).toBe(3);
    expect(body.app.config).toEqual({ port: 9100 });
    // D-2/T2.2：rollback 走同一条 apply 通道，同样携带节点 rev epoch
    const rollbackApply = ctx.agent.requests
      .filter((r) => r.path.endsWith('/apply'))
      .pop();
    const node = await ctx.nodes.get(id);
    expect((rollbackApply?.body as { epoch?: string }).epoch).toBe(node?.revEpoch);
  });

  it('未配置的应用 plan 返回 404；不支持的动作返回 400', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);

    const plan = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/wireguard/plan`,
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({}) },
      ctx.env,
    );
    expect(plan.status).toBe(404);

    const bogus = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter/BadAction`,
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({}) },
      ctx.env,
    );
    expect(bogus.status).toBe(400);
  });
});

describe('apps: 真实 AgentClient 集成（B-6 / T4.15）', () => {
  it('注入真实 HttpAgentClient 后 apply 全链路走 HMAC 签名请求，fake 完全不参与', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const realAgent = new HttpAgentClient(async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body = typeof init?.body === 'string' ? init.body : '';
      calls.push({ url: String(url), headers, body });
      const payload = String(url).endsWith('/plan')
        ? { ok: true, rev: 1, changes: [] }
        : { ok: true, rev: 1, appliedRev: 1, result: {} };
      return new Response(JSON.stringify(payload), { status: 200 });
    });

    const ctx = makeTestContext(undefined, realAgent);
    expect(ctx.agentClient).toBe(realAgent);
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter`,
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({ config: { port: 9100 } }),
      },
      ctx.env,
    );

    const apply = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter/apply`,
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({}) },
      ctx.env,
    );
    expect(apply.status).toBe(200);
    expect(ctx.agent.requests).toHaveLength(0);

    const applyCall = calls.find((call) => call.url.endsWith('/apply'));
    expect(applyCall?.headers['x-khc-sig']).toMatch(/^[0-9a-f]{64}$/);
    expect(applyCall?.headers['idempotency-key']).toBeTruthy();
    expect((JSON.parse(applyCall?.body ?? '{}') as { expectRev: number }).expectRev).toBe(1);
    expect((await ctx.apps.get(id, 'node-exporter'))?.appliedRev).toBe(1);
  });
});
