import { describe, expect, it } from 'vitest';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

/**
 * 并发 apply / 重复点击：
 * - Worker 不丢弃并发请求，但必须把同一个 idempotencyKey 原样转给 Agent
 *   （真正去重由 Agent 的任务/执行计数保证）；
 * - 未显式带键时每次生成不同的键，避免误把两次独立操作合并；
 * - 并发成功后 appliedRev 落在同一个终态，不留半更新。
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup() {
  const ctx = makeTestContext();
  const cookie = await loginAsAdmin(ctx);
  const { id } = await createNode(ctx, cookie);
  const put = await ctx.app.request(
    `/api/v1/nodes/${id}/apps/wireguard`,
    {
      method: 'PUT',
      headers: authHeaders(cookie),
      body: JSON.stringify({ config: { listenPort: 51820, peers: [] }, schemaVersion: 1 }),
    },
    ctx.env,
  );
  expect(put.status).toBe(200);
  return { ctx, cookie, nodeId: id };
}

async function applyOnce(
  ctx: ReturnType<typeof makeTestContext>,
  cookie: string,
  nodeId: string,
  idempotencyKey?: string,
): Promise<Response> {
  return ctx.app.request(
    `/api/v1/nodes/${nodeId}/apps/wireguard/apply`,
    {
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify(idempotencyKey ? { idempotencyKey } : {}),
    },
    ctx.env,
  );
}

describe('并发 apply / 重复点击', () => {
  it('同一幂等键并发：两次都成功，键原样透传，appliedRev 一致', async () => {
    const { ctx, cookie, nodeId } = await setup();
    ctx.agent.handler = async () => {
      await sleep(60);
      return { status: 200, body: { ok: true, rev: 1, appliedRev: 1 } };
    };

    const [first, second] = await Promise.all([
      applyOnce(ctx, cookie, nodeId, 'idem-dup-1'),
      applyOnce(ctx, cookie, nodeId, 'idem-dup-1'),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Worker 不做本地去重：两次都转发，交给 Agent 按同一键去重。
    expect(ctx.agent.requests).toHaveLength(2);
    expect(ctx.agent.requests.map((call) => call.idempotencyKey)).toEqual([
      'idem-dup-1',
      'idem-dup-1',
    ]);
    const record = await ctx.apps.get(nodeId, 'wireguard');
    expect(record?.appliedRev).toBe(1);
  });

  it('未显式带键时，并发请求各自生成不同的键', async () => {
    const { ctx, cookie, nodeId } = await setup();
    ctx.agent.handler = async () => ({ status: 200, body: { ok: true, rev: 1, appliedRev: 1 } });

    const [first, second] = await Promise.all([
      applyOnce(ctx, cookie, nodeId),
      applyOnce(ctx, cookie, nodeId),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const keys = ctx.agent.requests.map((call) => call.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) expect(key).toBeTruthy();
  });

  it('一次成功一次失败：lastApplyError 反映失败，appliedRev 不被失败覆盖', async () => {
    const { ctx, cookie, nodeId } = await setup();
    let calls = 0;
    ctx.agent.handler = async () => {
      calls += 1;
      if (calls === 1) return { status: 200, body: { ok: true, rev: 1, appliedRev: 1 } };
      return {
        status: 200,
        body: { ok: false, error: { code: 'apply_failed', message: '端口被占用' } },
      };
    };

    const [ok, failed] = await Promise.all([
      applyOnce(ctx, cookie, nodeId, 'idem-a'),
      applyOnce(ctx, cookie, nodeId, 'idem-b'),
    ]);
    expect([ok.status, failed.status]).toEqual([200, 200]);

    const record = await ctx.apps.get(nodeId, 'wireguard');
    expect(record?.appliedRev).toBe(1);
    expect(record?.lastApplyError?.code).toBe('apply_failed');
  });
});
