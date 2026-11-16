import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

const INSTALL = '#!/usr/bin/env bash\necho KHC_RESULT={}\n';
const UNINSTALL = '#!/usr/bin/env bash\necho removed\n';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function definition(): import('@khc/contracts').AppManifestDefinition {
  return {
    name: '测试应用',
    version: '0.2.0',
    runtime: { mode: 'root', linger: true },
    params: [],
    scripts: { install: INSTALL, uninstall: UNINSTALL },
    sha256: { install: sha(INSTALL), uninstall: sha(UNINSTALL) },
    writes: [],
  };
}

function createDefinition(): import('@khc/contracts').AppManifestDefinition {
  return { ...definition(), runtime: { mode: 'create', user: 'khc-app-x', linger: true } };
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

  it('create 模式：凭据随请求下发，且不出现在审计里', async () => {
    const { ctx, cookie, nodeId } = await setup();
    await ctx.appManifests.create({
      id: 'create-mode',
      manifest: { ...definition(), runtime: { mode: 'create', linger: true } },
      enabled: true,
    });
    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/recipe_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: actionBody({
          manifestId: 'create-mode',
          values: {},
          runtimeUser: 'khc-app-new',
          runtimePassword: 's3cret-pass',
        }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const params = (ctx.agent.requests[0]?.body as { params: Record<string, unknown> }).params;
    expect(params.runtimeUser).toBe('khc-app-new');
    expect(params.runtimePassword).toBe('s3cret-pass');
    const auditText = JSON.stringify(ctx.audit.entries);
    expect(auditText).not.toContain('s3cret-pass');
  });

  it('root 模式传凭据被拒绝', async () => {
    const { ctx, cookie, nodeId } = await setup();
    await ctx.appManifests.create({ id: 'root-mode', manifest: definition(), enabled: true });
    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/recipe_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: actionBody({
          manifestId: 'root-mode',
          values: {},
          runtimeUser: 'khc-app-x',
          runtimePassword: 'p',
        }),
      },
      ctx.env,
    );
    expect(res.status).toBe(400);
    expect(ctx.agent.requests).toHaveLength(0);
  });

  it('安装时选的运行身份覆盖 manifest 默认值，并显式转发给节点', async () => {
    const { ctx, cookie, nodeId } = await setup();
    await ctx.appManifests.create({ id: 'pick-root', manifest: createDefinition(), enabled: true });
    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/recipe_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: actionBody({ manifestId: 'pick-root', values: {}, runtimeMode: 'root' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const params = (ctx.agent.requests[0]?.body as { params: Record<string, unknown> }).params;
    expect(params.runtimeMode).toBe('root');
  });

  it('root 安装写审计，记下运行身份', async () => {
    const { ctx, cookie, nodeId } = await setup();
    await ctx.appManifests.create({ id: 'audit-root', manifest: definition(), enabled: true });
    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/recipe_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: actionBody({ manifestId: 'audit-root', values: {}, instance: 'a', runtimeMode: 'root' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const entry = ctx.audit.entries.find((item) => item.action === 'app-catalog.recipe_install');
    expect(entry?.detail).toMatchObject({
      manifestId: 'audit-root',
      instance: 'a',
      runtimeMode: 'root',
      runtimeUser: 'root',
    });
  });

  it('create 模式填 root 用户名被拒绝（不能借「新建用户」拿到 root）', async () => {
    const { ctx, cookie, nodeId } = await setup();
    await ctx.appManifests.create({ id: 'create-root', manifest: createDefinition(), enabled: true });
    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/recipe_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: actionBody({
          manifestId: 'create-root',
          values: {},
          runtimeUser: 'root',
          runtimePassword: 'p',
        }),
      },
      ctx.env,
    );
    expect(res.status).toBe(400);
    expect(ctx.agent.requests).toHaveLength(0);
  });

  it('旧定义里的 shared 按 create 校验，填 root 用户名照样被拒绝', async () => {
    const { ctx, cookie, nodeId } = await setup();
    const legacy = { ...definition(), runtime: { mode: 'shared' } } as unknown as import('@khc/contracts').AppManifestDefinition;
    await ctx.appManifests.create({ id: 'legacy', manifest: legacy, enabled: true });
    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/recipe_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: actionBody({ manifestId: 'legacy', values: {}, runtimeUser: 'root', runtimePassword: 'p' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(400);
    expect(ctx.agent.requests).toHaveLength(0);
  });

  it('未选运行身份时不替节点做主（卸载由节点沿用安装时的身份）', async () => {
    const { ctx, cookie, nodeId } = await setup();
    await ctx.appManifests.create({ id: 'no-pick', manifest: definition(), enabled: true });
    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/recipe_uninstall`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: actionBody({ manifestId: 'no-pick', values: {} }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const params = (ctx.agent.requests[0]?.body as { params: Record<string, unknown> }).params;
    expect(params.runtimeMode).toBeUndefined();
  });

  it('create 模式只给用户名不给密码被拒绝', async () => {
    const { ctx, cookie, nodeId } = await setup();
    await ctx.appManifests.create({
      id: 'create-partial',
      manifest: { ...definition(), runtime: { mode: 'create', linger: true } },
      enabled: true,
    });
    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/recipe_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: actionBody({ manifestId: 'create-partial', values: {}, runtimeUser: 'khc-app-x' }),
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
