import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

beforeEach(() => resetRateLimitForTests());

/** 冒烟：Hub 完全不可达时的两级闸门行为。
 *
 * 验证「闸门拆分」方案的后端前提：
 * 1. PUT 保存配置（只写 D1）在 Hub 不可达时仍然成功，rev 递增；
 * 2. apply 在 Hub 不可达时失败，且 last_apply_error 记录 hub_unreachable；
 * 3. Hub 恢复后 apply 期望最新的 rev（离线保存的 desired 生效）。
 */
describe('smoke: Hub 不可达时的保存/应用两级行为', () => {
  it('离线保存成功、apply 失败并记录错误、恢复后 apply 到最新 rev', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);

    // 初始：在线保存 rev=1 并成功 apply
    ctx.agent.handler = async () => ({ status: 200, body: { ok: true, rev: 1 } });
    await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter`,
      { method: 'PUT', headers: authHeaders(cookie), body: JSON.stringify({ config: { port: 9100 } }) },
      ctx.env,
    );
    const apply1 = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter/apply`,
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({}) },
      ctx.env,
    );
    expect(apply1.status).toBe(200);

    // Hub 断连：所有 agent 调用抛网络错误
    ctx.agent.handler = async () => {
      throw new Error('connect timeout');
    };

    // 离线保存 rev=2：应当成功（只写 D1）
    const putOffline = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter`,
      { method: 'PUT', headers: authHeaders(cookie), body: JSON.stringify({ config: { port: 9200 }, note: 'offline edit' }) },
      ctx.env,
    );
    expect(putOffline.status).toBe(200);
    const putBody = (await putOffline.json()) as { app: { rev: number; appliedRev: number | null } };
    expect(putBody.app.rev).toBe(2);
    expect(putBody.app.appliedRev).toBe(1); // appliedRev 保持上次成功值

    // 离线 apply：应当失败（5xx/错误码）而不是挂起
    const applyOffline = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter/apply`,
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({}) },
      ctx.env,
    );
    expect(applyOffline.status).toBeGreaterThanOrEqual(500);

    // 失败应写入 last_apply_error（GET 配置可见）
    const getConfig = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    const configBody = (await getConfig.json()) as {
      app: { rev: number; appliedRev: number | null; lastApplyError: { code: string } | null };
    };
    expect(configBody.app.rev).toBe(2);
    expect(configBody.app.appliedRev).toBe(1);
    expect(configBody.app.lastApplyError?.code).toBeTruthy();

    // Hub 恢复：apply 应携带 expectRev=2（离线保存的 desired 生效）
    let seenExpectRev = -1;
    ctx.agent.handler = async (_method, _path, body) => {
      const payload = body as { expectRev?: number };
      seenExpectRev = payload?.expectRev ?? -1;
      return { status: 200, body: { ok: true, rev: payload?.expectRev ?? 0 } };
    };
    const applyRecover = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/node-exporter/apply`,
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({}) },
      ctx.env,
    );
    expect(applyRecover.status).toBe(200);
    expect(seenExpectRev).toBe(2);
    const stored = await ctx.apps.get(id, 'node-exporter');
    expect(stored?.appliedRev).toBe(2);
  });
});
