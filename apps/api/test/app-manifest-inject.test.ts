import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

const INSTALL = '#!/usr/bin/env bash\necho KHC_RESULT={}\n';
const UNINSTALL = '#!/usr/bin/env bash\necho removed\n';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function definition() {
  return {
    name: '测试应用',
    version: '0.2.0',
    runtime: { user: 'khc-app-test', linger: true },
    params: [],
    scripts: { install: INSTALL, uninstall: UNINSTALL },
    sha256: { install: sha(INSTALL), uninstall: sha(UNINSTALL) },
    writes: [],
  };
}

async function setup() {
  const ctx = makeTestContext();
  const cookie = await loginAsAdmin(ctx);
  const { id } = await createNode(ctx, cookie);
  ctx.agent.handler = async () => ({ status: 200, body: { ok: true } });
  return { ctx, cookie, nodeId: id };
}

function actionBody(params: Record<string, unknown>) {
  return JSON.stringify({ params, idempotencyKey: 'idem-manifest-1' });
}

beforeEach(() => resetRateLimitForTests());

describe('应用清单下发：Worker 注入 manifest（R1）', () => {
  it('带 manifestId 时，Worker 从 D1 读出正文附上，不把 id 直传当成正文', async () => {
    const { ctx, cookie, nodeId } = await setup();
    const manifest = definition();
    await ctx.appManifests.create({ id: 'test-app', manifest, enabled: true });

    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/recipe_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: actionBody({ manifestId: 'test-app', values: { port: 3425 }, instance: 'a' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);

    const params = (ctx.agent.requests[0]?.body as { params: Record<string, unknown> }).params;
    expect(params.manifest).toEqual(manifest);
    expect(params.manifestId).toBe('test-app');
    expect(params.instance).toBe('a');
  });

  it('浏览器直接传 manifest 正文被拒绝，且不调用 Agent', async () => {
    const { ctx, cookie, nodeId } = await setup();
    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/recipe_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: actionBody({ manifest: definition(), values: {} }),
      },
      ctx.env,
    );
    expect(res.status).toBe(400);
    expect(ctx.agent.requests).toHaveLength(0);
  });

  it('不存在的 manifestId 返回 404，不调用 Agent', async () => {
    const { ctx, cookie, nodeId } = await setup();
    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/recipe_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: actionBody({ manifestId: 'missing', values: {} }),
      },
      ctx.env,
    );
    expect(res.status).toBe(404);
    expect(ctx.agent.requests).toHaveLength(0);
  });

  it('停用的应用不能发起安装', async () => {
    const { ctx, cookie, nodeId } = await setup();
    await ctx.appManifests.create({ id: 'disabled', manifest: definition(), enabled: false });
    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/recipe_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: actionBody({ manifestId: 'disabled', values: {} }),
      },
      ctx.env,
    );
    expect(res.status).toBe(400);
    expect(ctx.agent.requests).toHaveLength(0);
  });

  it('不带 manifestId 的普通动作完全不受影响（通用透传）', async () => {
    const { ctx, cookie, nodeId } = await setup();
    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/wireguard/rotate_peer`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: actionBody({ peer: 'phone' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const params = (ctx.agent.requests[0]?.body as { params: Record<string, unknown> }).params;
    expect(params).toEqual({ peer: 'phone' });
  });
});
