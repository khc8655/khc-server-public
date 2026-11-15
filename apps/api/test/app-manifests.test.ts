import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { authHeaders, loginAsAdmin, makeTestContext } from './helpers/context';

const INSTALL = '#!/usr/bin/env bash\necho KHC_RESULT={}\n';
const UNINSTALL = '#!/usr/bin/env bash\necho removed\n';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function definition(overrides: Record<string, unknown> = {}) {
  return {
    name: '测试应用',
    version: '0.1.0',
    runtime: { user: 'khc-app-test', linger: true },
    params: [{ key: 'port', type: 'integer', default: 3425 }],
    scripts: { install: INSTALL, uninstall: UNINSTALL },
    sha256: { install: sha(INSTALL), uninstall: sha(UNINSTALL) },
    writes: ['~/.local/share/khc-apps/test'],
    ...overrides,
  };
}

async function create(ctx: ReturnType<typeof makeTestContext>, cookie: string, body: unknown) {
  return ctx.app.request(
    '/api/v1/app-manifests',
    {
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify(body),
    },
    ctx.env,
  );
}

beforeEach(() => resetRateLimitForTests());

describe('全局应用清单 /app-manifests（R1 架子）', () => {
  it('未登录不能读写', async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.request('/api/v1/app-manifests', {}, ctx.env);
    expect(res.status).toBe(401);
  });

  it('新增后列出来，字段与写入一致', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await create(ctx, cookie, {
      id: 'test-app',
      manifest: definition(),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      appManifest: { id: string; manifest: { version: string }; enabled: boolean };
    };
    expect(created.appManifest.id).toBe('test-app');
    expect(created.appManifest.enabled).toBe(true);

    const list = await ctx.app.request(
      '/api/v1/app-manifests',
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as { appManifests: Array<{ id: string }> };
    expect(body.appManifests.map((item) => item.id)).toEqual(['test-app']);
  });

  it('脚本正文与 sha256 不一致时拒绝写入，不落库', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const bad = definition({ sha256: { install: '0'.repeat(64), uninstall: sha(UNINSTALL) } });
    const res = await create(ctx, cookie, { id: 'bad-hash', manifest: bad });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { message: string } }).error.message).toContain('sha256');
    expect(await ctx.appManifests.get('bad-hash')).toBeNull();
  });

  it('未知字段被 .strict() 拒绝', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await create(ctx, cookie, {
      id: 'extra-field',
      manifest: definition({ unexpected: 'shell-injection' }),
    });
    expect(res.status).toBe(400);
    expect(await ctx.appManifests.get('extra-field')).toBeNull();
  });

  it('超长脚本被拒绝', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const long = 'x'.repeat(64 * 1024 + 1);
    const bad = definition({
      scripts: { install: long, uninstall: UNINSTALL },
      sha256: { install: sha(long), uninstall: sha(UNINSTALL) },
    });
    const res = await create(ctx, cookie, { id: 'too-long', manifest: bad });
    expect(res.status).toBe(400);
  });

  it('更新时审计记录新旧脚本哈希', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    await create(ctx, cookie, { id: 'audit-app', manifest: definition() });
    const nextInstall = `${INSTALL}echo updated\n`;
    const next = definition({
      scripts: { install: nextInstall, uninstall: UNINSTALL },
      sha256: { install: sha(nextInstall), uninstall: sha(UNINSTALL) },
    });
    const res = await ctx.app.request(
      '/api/v1/app-manifests/audit-app',
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({ manifest: next }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const update = ctx.audit.entries.find((entry) => entry.action === 'appManifest.update');
    expect(update?.detail).toMatchObject({
      id: 'audit-app',
      oldInstallSha256: sha(INSTALL),
      newInstallSha256: sha(nextInstall),
    });
  });

  it('新增与删除都写审计', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    await create(ctx, cookie, { id: 'del-app', manifest: definition() });
    const del = await ctx.app.request(
      '/api/v1/app-manifests/del-app',
      { method: 'DELETE', headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(del.status).toBe(200);
    const actions = ctx.audit.entries.map((entry) => entry.action);
    expect(actions).toContain('appManifest.create');
    expect(actions).toContain('appManifest.delete');
    expect(await ctx.appManifests.get('del-app')).toBeNull();
  });

  it('重复 id 返回 409', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const payload = { id: 'dup', manifest: definition() };
    expect((await create(ctx, cookie, payload)).status).toBe(201);
    expect((await create(ctx, cookie, payload)).status).toBe(409);
  });
});
