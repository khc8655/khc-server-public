import { afterEach, describe, expect, it, vi } from 'vitest';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';
import { HubUnreachableError } from '../src/lib/node-client';

/** 建 + 登录 + 配置 wireguard（rev 1），返回调用 rotate 所需的上下文 */
async function setup() {
  const ctx = makeTestContext();
  const cookie = await loginAsAdmin(ctx);
  const { id } = await createNode(ctx, cookie);
  const put = await ctx.app.request(
    `/api/v1/nodes/${id}/apps/wireguard`,
    {
      method: 'PUT',
      headers: authHeaders(cookie),
      body: JSON.stringify({
        config: { listenPort: 51820, peers: [{ name: 'phone', key: 'pk-1' }] },
        schemaVersion: 1,
      }),
    },
    ctx.env,
  );
  expect(put.status).toBe(200);
  return { ctx, cookie, nodeId: id };
}

/**
 * 小步推进 fake 时钟直到响应落地。
 *
 * 请求处理链是微任务驱动的：「调用 Agent → 拿到 202 → 注册 sleep(750) → 再调用」。
 * `advanceTimersByTimeAsync(750)` 只会触发**已经注册**的定时器；如果推进时链还没走到
 * 注册 sleep 这一步，这次推进就是纯空转——时钟走了 750ms，链一步没动。CI 上
 * main 曾出现「800 步只用 49ms 跑完、响应始终不落地」，就是整轮推进都在链注册之前。
 *
 * 因此每步拆成两拍，顺序不能颠倒：
 *   1) `advanceTimersByTimeAsync(0)`：只冲刷微任务队列、不移动时钟，链必然推进到
 *      「下一个 sleep 已注册进假时钟」的位置；
 *   2) `advanceTimersByTimeAsync(750)`：此时队列里一定有待触发的 sleep，推进的每
 *      750ms 都对应一次真实轮询，保证「每推进一次就有进展」。
 *
 * 每步仍用 setSystemTime 显式校准 Date：部分 CI 环境下 advanceTimersByTimeAsync
 * 只推进定时器队列、不推进被 mock 的 Date，导致 60s 截止永远不到达（本地/CI 不一致的根因）。
 *
 * @param probe 失败诊断用：返回当前已发出的 Agent 调用次数（默认未知）
 */
async function driveUntilSettled(
  request: Promise<Response> | Response,
  probe?: () => number,
): Promise<Response> {
  const promise = Promise.resolve(request);
  let settled: Response | undefined;
  const guarded = promise.then((res) => {
    settled = res;
    return res;
  });
  const start = Date.now();
  const STEPS = 800;
  let advanced = 0;
  for (let i = 0; i < STEPS && !settled; i += 1) {
    // 1) 冲刷微任务（时钟不动）：确保轮询链把下一个 sleep(750) 注册好
    await vi.advanceTimersByTimeAsync(0);
    // 2) 推进一个重试间隔：必然命中上一步刚注册的定时器
    await vi.advanceTimersByTimeAsync(750);
    vi.setSystemTime(start + (i + 1) * 750);
    advanced = i + 1;
  }
  if (!settled) {
    const calls = probe ? probe() : '未知';
    throw new Error(
      `响应在 ${advanced}/${STEPS} 步（假时钟 ${(advanced * 750) / 1000}s）推进后仍未落地；` +
        `已发出的 Agent 调用次数=${calls}`,
    );
  }
  return guarded;
}

describe('apps 动作：rotate_peer 透传与降级（批次 F）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rotate_peer 透传 expectRev/params/idempotencyKey，cards 归一化到 result.cards', async () => {
    const { ctx, cookie, nodeId } = await setup();
    ctx.agent.handler = async () => ({
      status: 200,
      body: {
        ok: true,
        rev: 1,
        // 自定义动作把 cards 放顶层；Worker 应归一化到 result.cards
        cards: [{ title: '新公钥', value: 'new-pub', copy: true }],
      },
    });

    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/wireguard/rotate_peer`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ params: { peer: 'phone' }, idempotencyKey: 'idem-rotate-1' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: { cards: unknown[] } };
    expect(body.ok).toBe(true);
    expect(body.result.cards[0]).toMatchObject({ title: '新公钥', value: 'new-pub' });

    // 透传断言：路径、expectRev、params、幂等键
    const call = ctx.agent.requests[0];
    expect(call?.method).toBe('POST');
    expect(call?.path).toBe('/apps/wireguard/rotate_peer');
    expect((call?.body as { expectRev: number }).expectRev).toBe(1);
    expect((call?.body as { params: unknown }).params).toEqual({ peer: 'phone' });
    expect(call?.idempotencyKey).toBe('idem-rotate-1');
  });

  it('Agent 409 rev_conflict 原样透传（版本冲突不重试）', async () => {
    const { ctx, cookie, nodeId } = await setup();
    ctx.agent.handler = async () => ({
      status: 409,
      body: { error: { code: 'rev_conflict', message: '配置已被其他操作更新，请刷新后重试' } },
    });

    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/wireguard/rotate_peer`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ params: { peer: 'phone' } }),
      },
      ctx.env,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('rev_conflict');
    expect(body.error.message).toContain('请刷新后重试');
    // 4xx 是 Agent 明确应答：不换路、不重试
    expect(ctx.agent.requests).toHaveLength(1);
  });

  it('202 inProgress：用同一幂等键轮询直到拿到最终结果', async () => {
    // 只 fake 轮询真正依赖的 setTimeout/Date，避免拦住运行时内部定时器
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { ctx, cookie, nodeId } = await setup();
    let calls = 0;
    ctx.agent.handler = async () => {
      calls += 1;
      if (calls < 3) return { status: 202, body: { ok: true, taskId: 't1' } };
      return { status: 200, body: { ok: true, rev: 1 } };
    };

    const responsePromise = ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/wireguard/rotate_peer`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ params: { peer: 'phone' }, idempotencyKey: 'idem-pending' }),
      },
      ctx.env,
    );
    const res = await driveUntilSettled(responsePromise, () => calls);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });

    // 轮询的每次调用都带同一个幂等键（Agent 侧去重，避免重复 rotate）
    expect(calls).toBe(3);
    const keys = ctx.agent.requests.map((r) => r.idempotencyKey);
    expect(keys).toEqual(['idem-pending', 'idem-pending', 'idem-pending']);
  });

  it('持续 202 超过 60s：502 hub_unreachable，不污染配置/审计状态', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { ctx, cookie, nodeId } = await setup();
    const auditBefore = ctx.audit.entries.length;
    ctx.agent.handler = async () => ({ status: 202, body: { ok: true, taskId: 't1' } });

    const responsePromise = ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/wireguard/rotate_peer`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ params: { peer: 'phone' }, idempotencyKey: 'idem-stuck' }),
      },
      ctx.env,
    );
    const res = await driveUntilSettled(responsePromise, () => ctx.agent.requests.length);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('hub_unreachable');
    expect(body.error.message).toContain('60s');

    // 超时期间反复重试（同一幂等键），但只到 60s 窗口为止
    expect(ctx.agent.requests.length).toBeGreaterThan(3);
    expect(new Set(ctx.agent.requests.map((r) => r.idempotencyKey))).toEqual(
      new Set(['idem-stuck']),
    );
    // 非 apply 动作失败：不写 lastApplyError，也不新增 audit（无 rotate/apply 动作）
    const record = await ctx.apps.get(nodeId, 'wireguard');
    expect(record?.lastApplyError).toBeNull();
    expect(ctx.audit.entries.length).toBe(auditBefore);
    expect(
      ctx.audit.entries.filter((e) => e.action.includes('rotate') || e.action === 'app.apply'),
    ).toHaveLength(0);
    expect(record?.appliedRev).toBeNull();
  });
});

describe('apps 动作：同步动作超时重试判定（R-3）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('传输超时（timedOut=true）用同一幂等键重试，直到拿到结果', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { ctx, cookie, nodeId } = await setup();
    let calls = 0;
    ctx.agent.handler = async () => {
      calls += 1;
      if (calls === 1) {
        // 真实客户端超时抛的 message 不含"超时"字样——判定必须靠 timedOut 标记
        throw new HubUnreachableError('Hub 不可达（直连与隧道均失败）', {}, true);
      }
      return { status: 200, body: { ok: true, rev: 1 } };
    };

    const responsePromise = ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/wireguard/rotate_peer`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ params: { peer: 'phone' }, idempotencyKey: 'idem-r3-retry' }),
      },
      ctx.env,
    );
    const res = await driveUntilSettled(responsePromise);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
    // 超时进重试：第二次调用成功返回
    expect(calls).toBe(2);
    // 重试必须用同一幂等键（Agent 侧去重，写动作不重复执行）
    expect(ctx.agent.requests.map((r) => r.idempotencyKey)).toEqual([
      'idem-r3-retry',
      'idem-r3-retry',
    ]);
  });

  it('非超时不可达（timedOut=false）立即抛出，不重试', async () => {
    const { ctx, cookie, nodeId } = await setup();
    ctx.agent.handler = async () => {
      throw new HubUnreachableError('Hub 不可达（直连与隧道均失败）', {
        direct: 'fetch: ECONNREFUSED',
      });
    };

    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/wireguard/rotate_peer`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ params: { peer: 'phone' }, idempotencyKey: 'idem-r3-fast' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('hub_unreachable');
    // AppError 原样抛出（routeErrors 细节不进响应体）
    expect(body.error.message).toContain('Hub 不可达');
    // 非超时立即抛：Agent 只被调用一次
    expect(ctx.agent.requests).toHaveLength(1);
  });
});
