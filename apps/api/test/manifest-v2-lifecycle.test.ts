import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_MANIFEST_FEATURES, MANIFEST_V2_MIN_AGENT } from '@khc/contracts';
import { createApp } from '../src/app';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import {
  FakeAgentClient,
  authHeaders,
  createNode,
  loginAsAdmin,
} from './helpers/context';
import {
  MemoryAppConfigRepo,
  MemoryAppManifestRepo,
  MemoryAuditRepo,
  MemoryCertificateRepo,
  MemoryNodeRepo,
  MemorySettingsRepo,
  MemorySshKeyRepo,
  MemoryTunnelRepo,
} from './helpers/memory';

const INSTALL = '#!/usr/bin/env bash\necho KHC_RESULT={}\n';
const UPGRADE = '#!/usr/bin/env bash\necho upgraded\n';
const UNINSTALL = '#!/usr/bin/env bash\necho removed\n';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function makeV2AppContext(opts: { hookFetch?: typeof fetch; environment?: string } = {}) {
  const nodes = new MemoryNodeRepo();
  const apps = new MemoryAppConfigRepo();
  const audit = new MemoryAuditRepo();
  const certs = new MemoryCertificateRepo();
  const settings = new MemorySettingsRepo();
  const sshKeys = new MemorySshKeyRepo();
  const appManifests = new MemoryAppManifestRepo();
  const tunnels = new MemoryTunnelRepo();
  const agent = new FakeAgentClient();
  const app = createApp({
    nodes,
    apps,
    audit,
    certs,
    settings,
    sshKeys,
    appManifests,
    tunnels,
    agent,
    hookFetch: opts.hookFetch,
  });
  const env = {
    ENVIRONMENT: opts.environment ?? 'development',
    ADMIN_PASSWORD: 'test-pass',
    SESSION_SECRET: '0123456789abcdef0123456789abcdef',
    MASTER_ENC_KEY: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
  } as unknown as import('../src/types').Env;
  return { app, env, nodes, apps, audit, settings, appManifests, agent };
}

function v2Manifest(overrides: Record<string, unknown> = {}): import('@khc/contracts').AppManifestAnyDefinition {
  return {
    schema: 2 as const,
    name: 'Demo V2',
    version: '2.0.0',
    runtime: { mode: 'root' as const, linger: true },
    params: [{ key: 'port', type: 'integer' as const, default: 18080 }],
    scripts: { install: INSTALL, uninstall: UNINSTALL, upgrade: UPGRADE },
    sha256: { install: sha(INSTALL), uninstall: sha(UNINSTALL), upgrade: sha(UPGRADE) },
    writes: ['~/data'],
    ...overrides,
  } as import('@khc/contracts').AppManifestAnyDefinition;
}

function v1Manifest(overrides: Record<string, unknown> = {}): import('@khc/contracts').AppManifestAnyDefinition {
  return {
    name: 'Legacy V1',
    version: '1.0.0',
    runtime: { mode: 'root' as const, linger: true },
    params: [{ key: 'port', type: 'integer' as const, default: 3425 }],
    scripts: { install: INSTALL, uninstall: UNINSTALL },
    sha256: { install: sha(INSTALL), uninstall: sha(UNINSTALL) },
    writes: [],
    ...overrides,
  } as import('@khc/contracts').AppManifestAnyDefinition;
}

beforeEach(() => resetRateLimitForTests());

describe('应用清单 v2 写入与生命周期编排（V2）', () => {
  it('写入：v2 合法清单 201 含 schema/sha256 审计，upgrade sha256 不符 400，v1 照旧', async () => {
    const ctx = makeV2AppContext();
    const cookie = await loginAsAdmin(ctx as never);

    const okRes = await ctx.app.request(
      '/api/v1/app-manifests',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ id: 'v2-app', manifest: v2Manifest() }),
      },
      ctx.env,
    );
    expect(okRes.status).toBe(201);
    const createAudit = ctx.audit.entries.find((e) => e.action === 'appManifest.create');
    expect(createAudit?.detail).toMatchObject({
      id: 'v2-app',
      schema: 2,
      upgradeSha256: sha(UPGRADE),
    });

    const badRes = await ctx.app.request(
      '/api/v1/app-manifests',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          id: 'v2-bad-sha',
          manifest: v2Manifest({
            sha256: { install: sha(INSTALL), uninstall: sha(UNINSTALL), upgrade: '0'.repeat(64) },
          }),
        }),
      },
      ctx.env,
    );
    expect(badRes.status).toBe(400);

    const v1Res = await ctx.app.request(
      '/api/v1/app-manifests',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ id: 'v1-app', manifest: v1Manifest() }),
      },
      ctx.env,
    );
    expect(v1Res.status).toBe(201);
  });

  it('v2 保存：secrets allowHosts 未覆盖 hook 主机返回非阻断 warnings[]', async () => {
    const ctx = makeV2AppContext();
    const cookie = await loginAsAdmin(ctx as never);
    await ctx.app.request(
      '/api/v1/settings/app.warn-app.token',
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({ value: { value: 'sec-123', allowHosts: ['other.example.com'] } }),
      },
      ctx.env,
    );

    const res = await ctx.app.request(
      '/api/v1/app-manifests',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          id: 'warn-app',
          manifest: v2Manifest({
            secrets: [{ name: 'token', label: 'Token' }],
            hooks: {
              preInstall: {
                method: 'POST',
                url: 'https://hub.example.com/enroll',
                headers: { authorization: 'Bearer {{secret.token}}' },
              },
            },
          }),
        }),
      },
      ctx.env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { warnings?: string[] };
    expect(body.warnings?.[0]).toContain('hub.example.com');
  });

  it('编排顺序：预检 → hook → 转发；v1 recipe_install 不调用预检', async () => {
    const events: string[] = [];
    const hookFetch = vi.fn(async () => {
      events.push('hook');
      return new Response(JSON.stringify({ key: 'hk_live', pub: 'pub_9' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const ctx = makeV2AppContext({ hookFetch });
    const cookie = await loginAsAdmin(ctx as never);
    const { id: nodeId } = await createNode(ctx as never, cookie);

    await ctx.settings.put('app.seq-app.api_key', {
      value: 'super-secret-xyz',
      allowHosts: ['issuer.example.com'],
    });
    await ctx.appManifests.create({
      id: 'seq-app',
      enabled: true,
      manifest: v2Manifest({
        secrets: [{ name: 'api_key', label: 'API Key' }],
        hooks: {
          preInstall: {
            method: 'POST',
            url: 'https://issuer.example.com/register',
            headers: { authorization: 'Bearer {{secret.api_key}}' },
            extract: { key: '/key', pub: '/pub' },
            public: ['pub'],
          },
        },
      }),
    });

    ctx.agent.handler = async (_method, reqPath) => {
      events.push(reqPath);
      if (reqPath === '/apps/app-catalog/manifest_preflight') {
        return {
          status: 200,
          body: {
            ok: true,
            capabilities: { schemas: [1, 2], features: [...AGENT_MANIFEST_FEATURES] },
            checks: [],
            installed: null,
          },
        };
      }
      return { status: 200, body: { ok: true, taskId: 'task-1' } };
    };

    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/manifest_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          params: { manifestId: 'seq-app', values: { port: 9000 } },
          idempotencyKey: 'seq-k1',
        }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    expect(events).toEqual([
      '/apps/app-catalog/manifest_preflight',
      'hook',
      '/apps/app-catalog/manifest_install',
    ]);
    const forwarded = (ctx.agent.requests[1]?.body as { params: Record<string, unknown> }).params;
    expect(forwarded.hookOutputs).toEqual({ key: 'hk_live', pub: 'pub_9' });
    expect(forwarded.hookFacts).toEqual({ pub: 'pub_9' });

    // v1 清单走 recipe_install 不预检、不调 hook
    await ctx.appManifests.create({ id: 'legacy-v1', enabled: true, manifest: v1Manifest() });
    const reqsBefore = ctx.agent.requests.length;
    const v1Res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/recipe_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ params: { manifestId: 'legacy-v1' }, idempotencyKey: 'v1-k1' }),
      },
      ctx.env,
    );
    expect(v1Res.status).toBe(200);
    expect(ctx.agent.requests.length - reqsBefore).toBe(1);
    expect(ctx.agent.requests.at(-1)?.path).toBe('/apps/app-catalog/recipe_install');
  });

  it('幂等重放（§8 #3）：同一 idempotencyKey 重放时不重复执行控制面 hook', async () => {
    const hookFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ key: 'hk_once' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const ctx = makeV2AppContext({ hookFetch });
    const cookie = await loginAsAdmin(ctx as never);
    const { id: nodeId } = await createNode(ctx as never, cookie);
    await ctx.appManifests.create({
      id: 'idem-app',
      enabled: true,
      manifest: v2Manifest({
        hooks: {
          preInstall: {
            method: 'POST',
            url: 'https://issuer.example.com/issue',
            extract: { key: '/key' },
          },
        },
      }),
    });
    ctx.agent.handler = async (_m, p) => {
      if (p.includes('manifest_preflight')) {
        return {
          status: 200,
          body: {
            ok: true,
            capabilities: { schemas: [1, 2], features: [...AGENT_MANIFEST_FEATURES] },
            checks: [],
            installed: null,
          },
        };
      }
      return { status: 200, body: { ok: true, taskId: 'task-idem' } };
    };

    const reqInit = () => ({
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify({
        params: { manifestId: 'idem-app' },
        idempotencyKey: 'same-idem-key-123',
      }),
    });

    const r1 = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/manifest_install`,
      reqInit(),
      ctx.env,
    );
    const r2 = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/manifest_install`,
      reqInit(),
      ctx.env,
    );
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(hookFetch).toHaveBeenCalledTimes(1);
  });

  it('版本协商与所需能力：未知动作/缺能力报 409 agent_upgrade_required，含 missing 与 minAgentVersion', async () => {
    const ctx = makeV2AppContext();
    const cookie = await loginAsAdmin(ctx as never);
    const { id: nodeId } = await createNode(ctx as never, cookie);
    await ctx.appManifests.create({
      id: 'min-v2',
      enabled: true,
      manifest: v2Manifest({
        scripts: { install: INSTALL, uninstall: UNINSTALL },
        sha256: { install: sha(INSTALL), uninstall: sha(UNINSTALL) },
      }),
    });

    // 1. 旧 Agent 返回 400 invalid_action → 409 agent_upgrade_required
    ctx.agent.handler = async () => ({
      status: 400,
      body: { ok: false, error: { code: 'invalid_action', message: 'unknown action' } },
    });
    const oldRes = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/manifest_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ params: { manifestId: 'min-v2' }, idempotencyKey: 'k-old' }),
      },
      ctx.env,
    );
    expect(oldRes.status).toBe(409);
    const oldBody = (await oldRes.json()) as {
      error: { code: string; details: { minAgentVersion: string; missing: string[] } };
    };
    expect(oldBody.error.code).toBe('agent_upgrade_required');
    expect(oldBody.error.details.minAgentVersion).toBe(MANIFEST_V2_MIN_AGENT);

    // 2. manifest_upgrade 需 upgrade 能力；manifest_control 需 units 能力
    ctx.agent.handler = async (_m, p) => {
      if (p.includes('manifest_preflight')) {
        return {
          status: 200,
          body: {
            ok: true,
            capabilities: { schemas: [1, 2], features: ['schema2'] },
            checks: [],
            installed: { version: '1.0.0', schema: 2, facts: {} },
          },
        };
      }
      return { status: 400, body: { ok: false, error: { code: 'invalid_action', message: 'nope' } } };
    };
    const upgRes = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/manifest_upgrade`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ params: { manifestId: 'min-v2' }, idempotencyKey: 'k-upg' }),
      },
      ctx.env,
    );
    expect(upgRes.status).toBe(409);
    const upgBody = (await upgRes.json()) as { error: { code: string; details: { missing: string[] } } };
    expect(upgBody.error.code).toBe('agent_upgrade_required');
    expect(upgBody.error.details.missing).toEqual(['upgrade']);

    // /state 缓存的 capabilities 也生效于 manifest_control
    ctx.agent.handler = async () => ({
      status: 200,
      body: {
        host: { hostname: 'n1', os: 'debian', kernel: '6.1', uptime: 10, load: [0, 0, 0], disk: { total: 10, used: 1, free: 9, percent: 10 }, mem: { total: 10, used: 1, free: 9, percent: 10 } },
        adapters: [],
        ports: [],
        agent: {
          version: '0.8.0',
          serverTime: 1700000000,
          capabilities: { appManifest: { schemas: [1, 2], features: ['schema2'] } },
        },
      },
    });
    await ctx.app.request(`/api/v1/nodes/${nodeId}/state`, { headers: authHeaders(cookie) }, ctx.env);
    const ctrlRes = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/manifest_control`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          params: { manifestId: 'min-v2', op: 'restart', unit: 'demo.service' },
          idempotencyKey: 'k-ctrl',
        }),
      },
      ctx.env,
    );
    expect(ctrlRes.status).toBe(409);
    const ctrlBody = (await ctrlRes.json()) as { error: { details: { missing: string[] } } };
    expect(ctrlBody.error.details.missing).toEqual(['units']);
  });

  it('预检失败 422 / upgrade 未安装 409 / manifest 失败 400 manifest_invalid（未调 hook）', async () => {
    const hookFetch = vi.fn() as unknown as typeof fetch;
    const ctx = makeV2AppContext({ hookFetch });
    const cookie = await loginAsAdmin(ctx as never);
    const { id: nodeId } = await createNode(ctx as never, cookie);
    await ctx.appManifests.create({
      id: 'pre-app',
      enabled: true,
      manifest: v2Manifest({
        hooks: { preInstall: { method: 'POST', url: 'https://issuer.example.com/a' } },
      }),
    });

    ctx.agent.handler = async () => ({
      status: 200,
      body: {
        ok: false,
        capabilities: { schemas: [1, 2], features: [...AGENT_MANIFEST_FEATURES] },
        checks: [{ name: 'memMB', ok: false, message: '可用内存不足' }],
        installed: null,
      },
    });
    const res422 = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/manifest_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ params: { manifestId: 'pre-app' }, idempotencyKey: 'p-422' }),
      },
      ctx.env,
    );
    expect(res422.status).toBe(422);
    expect(hookFetch).not.toHaveBeenCalled();

    ctx.agent.handler = async () => ({
      status: 200,
      body: {
        ok: true,
        capabilities: { schemas: [1, 2], features: [...AGENT_MANIFEST_FEATURES] },
        checks: [],
        installed: null,
      },
    });
    const res409 = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/manifest_upgrade`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ params: { manifestId: 'pre-app' }, idempotencyKey: 'p-409' }),
      },
      ctx.env,
    );
    expect(res409.status).toBe(409);

    ctx.agent.handler = async () => ({
      status: 200,
      body: {
        ok: false,
        capabilities: { schemas: [1, 2], features: [...AGENT_MANIFEST_FEATURES] },
        checks: [{ name: 'manifest', ok: false, message: 'sha256 不合法' }],
        installed: null,
      },
    });
    const res400 = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/manifest_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ params: { manifestId: 'pre-app' }, idempotencyKey: 'p-400' }),
      },
      ctx.env,
    );
    expect(res400.status).toBe(400);
    expect(((await res400.json()) as { error: { code: string } }).error.code).toBe('manifest_invalid');
    expect(hookFetch).not.toHaveBeenCalled();
  });

  it('skipHooks 只在 uninstall 生效，install 带 skipHooks 报 400', async () => {
    const hookFetch = vi.fn() as unknown as typeof fetch;
    const ctx = makeV2AppContext({ hookFetch });
    const cookie = await loginAsAdmin(ctx as never);
    const { id: nodeId } = await createNode(ctx as never, cookie);
    await ctx.appManifests.create({
      id: 'skip-app',
      enabled: true,
      manifest: v2Manifest({
        hooks: { preUninstall: { method: 'POST', url: 'https://issuer.example.com/del' } },
      }),
    });
    ctx.agent.handler = async () => ({
      status: 200,
      body: {
        ok: true,
        capabilities: { schemas: [1, 2], features: [...AGENT_MANIFEST_FEATURES] },
        checks: [],
        installed: { version: '2.0.0', schema: 2, facts: {} },
      },
    });

    const badInstall = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/manifest_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          params: { manifestId: 'skip-app', skipHooks: true },
          idempotencyKey: 'skip-bad',
        }),
      },
      ctx.env,
    );
    expect(badInstall.status).toBe(400);

    const okUninstall = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/manifest_uninstall`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          params: { manifestId: 'skip-app', skipHooks: true },
          idempotencyKey: 'skip-ok',
        }),
      },
      ctx.env,
    );
    expect(okUninstall.status).toBe(200);
    expect(hookFetch).not.toHaveBeenCalled();
    expect(ctx.audit.entries.some((e) => e.action === 'app.hook.skipped')).toBe(true);
    const forwarded = (ctx.agent.requests.at(-1)?.body as { params: Record<string, unknown> }).params;
    expect(forwarded.hooksSkipped).toBe(true);
  });

  it('/app-manifests/:id/secrets 不含 value，PUT /settings/app.x.y 校验格式', async () => {
    const ctx = makeV2AppContext();
    const cookie = await loginAsAdmin(ctx as never);
    await ctx.appManifests.create({
      id: 'sec-app',
      enabled: true,
      manifest: v2Manifest({
        secrets: [
          { name: 'prov_key', label: '发放密钥', hint: '在控制台生成' },
          { name: 'opt_key', label: '备用密钥' },
        ],
      }),
    });

    const badSetting = await ctx.app.request(
      '/api/v1/settings/app.sec-app.prov_key',
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({ value: 'plain-string-not-object' }),
      },
      ctx.env,
    );
    expect(badSetting.status).toBe(400);

    const okSetting = await ctx.app.request(
      '/api/v1/settings/app.sec-app.prov_key',
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          value: { value: 'TOP-SECRET-VALUE-999', allowHosts: ['api.example.com'] },
        }),
      },
      ctx.env,
    );
    expect(okSetting.status).toBe(200);

    const listRes = await ctx.app.request(
      '/api/v1/app-manifests/sec-app/secrets',
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(listRes.status).toBe(200);
    const raw = await listRes.text();
    expect(raw).not.toContain('TOP-SECRET-VALUE-999');
    const body = JSON.parse(raw) as { secrets: Array<{ name: string; configured: boolean; allowHosts: string[] }> };
    expect(body.secrets[0]).toMatchObject({
      name: 'prov_key',
      configured: true,
      allowHosts: ['api.example.com'],
    });
    expect(body.secrets[1]).toMatchObject({
      name: 'opt_key',
      configured: false,
      allowHosts: [],
    });
  });

  it('列表容错：坏清单条返回 invalid:true 不 500，安装坏清单返回 400 manifest_invalid', async () => {
    const ctx = makeV2AppContext();
    const cookie = await loginAsAdmin(ctx as never);
    const { id: nodeId } = await createNode(ctx as never, cookie);
    ctx.appManifests.seedInvalid('corrupt-app', 'schema: 格式损坏');

    const listRes = await ctx.app.request(
      '/api/v1/app-manifests',
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      appManifests: Array<{ id: string; invalid?: boolean; error?: string; manifest?: unknown }>;
    };
    const badRow = listBody.appManifests.find((r) => r.id === 'corrupt-app');
    expect(badRow).toMatchObject({ id: 'corrupt-app', invalid: true, error: 'schema: 格式损坏' });
    expect(badRow?.manifest).toBeUndefined();

    const instRes = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/manifest_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ params: { manifestId: 'corrupt-app' }, idempotencyKey: 'bad-row' }),
      },
      ctx.env,
    );
    expect(instRes.status).toBe(400);
    expect(((await instRes.json()) as { error: { code: string } }).error.code).toBe('manifest_invalid');
  });

  it('源码扫描：路由与编排文件不出现任何具体应用名', () => {
    const files = [
      'apps/api/src/routes/apps.ts',
      'apps/api/src/routes/appManifests.ts',
      'apps/api/src/routes/settings.ts',
      'apps/api/src/lib/app-manifests.ts',
      'apps/api/src/lib/manifest-lifecycle.ts',
      'apps/api/src/lib/manifest-hooks.ts',
    ];
    const forbidden = ['khcsearch', 'sing-box', 'nezha', 'alist', 'magpie'];
    for (const rel of files) {
      const content = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8').toLowerCase();
      for (const appName of forbidden) {
        expect(content, `${rel} 不得出现 ${appName}`).not.toContain(appName);
      }
    }
  });

  describe('升级转发原始 values（V4.1）', () => {
    const upgradeManifest = () =>
      v2Manifest({
        hooks: {
          preUpgrade: {
            method: 'POST',
            url: 'https://issuer.example.com/upgrade',
            body: { port: '{{params.port}}' },
          },
        },
      });

    function setup() {
      const hookBodies: unknown[] = [];
      const hookFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        hookBodies.push(JSON.parse(String(init?.body ?? '{}')));
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch;
      const ctx = makeV2AppContext({ hookFetch });
      ctx.agent.handler = async (_m, p) => {
        if (p.includes('manifest_preflight')) {
          return {
            status: 200,
            body: {
              ok: true,
              capabilities: { schemas: [1, 2], features: [...AGENT_MANIFEST_FEATURES] },
              checks: [],
              installed: { version: '1.0.0', schema: 2, facts: {} },
            },
          };
        }
        return { status: 200, body: { ok: true, taskId: 'task-up' } };
      };
      return { ctx, hookBodies, hookFetch };
    }

    async function call(
      ctx: ReturnType<typeof makeV2AppContext>,
      cookie: string,
      nodeId: string,
      action: 'manifest_upgrade' | 'manifest_install',
      values: Record<string, unknown>,
      key: string,
    ) {
      const res = await ctx.app.request(
        `/api/v1/nodes/${nodeId}/apps/app-catalog/${action}`,
        {
          method: 'POST',
          headers: authHeaders(cookie),
          body: JSON.stringify({ params: { manifestId: 'up-app', values }, idempotencyKey: key }),
        },
        ctx.env,
      );
      expect(res.status).toBe(200);
      const forwarded = ctx.agent.requests.filter((r) => r.path === `/apps/app-catalog/${action}`).at(-1);
      return (forwarded?.body as { params: { values: Record<string, unknown> } }).params.values;
    }

    it('upgrade：values 为空时转发 {}（不含默认值），有值时原样转发；hook 渲染仍合并默认值', async () => {
      const { ctx, hookBodies } = setup();
      const cookie = await loginAsAdmin(ctx as never);
      const { id: nodeId } = await createNode(ctx as never, cookie);
      await ctx.appManifests.create({ id: 'up-app', enabled: true, manifest: upgradeManifest() });

      expect(await call(ctx, cookie, nodeId, 'manifest_upgrade', {}, 'up-key-0001')).toEqual({});
      expect(hookBodies.at(-1)).toEqual({ port: '18080' });

      expect(await call(ctx, cookie, nodeId, 'manifest_upgrade', { port: 9000 }, 'up-key-0002')).toEqual({
        port: 9000,
      });
      expect(hookBodies.at(-1)).toEqual({ port: '9000' });
    });

    it('upgrade 幂等重放分支同样转发原始 values，且不重复跑 hook', async () => {
      const { ctx, hookFetch } = setup();
      const cookie = await loginAsAdmin(ctx as never);
      const { id: nodeId } = await createNode(ctx as never, cookie);
      await ctx.appManifests.create({ id: 'up-app', enabled: true, manifest: upgradeManifest() });

      expect(await call(ctx, cookie, nodeId, 'manifest_upgrade', { port: 9100 }, 'up-key-replay')).toEqual({
        port: 9100,
      });
      expect(await call(ctx, cookie, nodeId, 'manifest_upgrade', { port: 9100 }, 'up-key-replay')).toEqual({
        port: 9100,
      });
      expect(hookFetch).toHaveBeenCalledTimes(1);
      expect(await call(ctx, cookie, nodeId, 'manifest_upgrade', {}, 'up-key-replay')).toEqual({});
    });

    it('install 行为不变：转发值仍合并清单默认值', async () => {
      const { ctx } = setup();
      const cookie = await loginAsAdmin(ctx as never);
      const { id: nodeId } = await createNode(ctx as never, cookie);
      await ctx.appManifests.create({ id: 'up-app', enabled: true, manifest: upgradeManifest() });
      expect(await call(ctx, cookie, nodeId, 'manifest_install', {}, 'in-key-0001')).toEqual({ port: 18080 });
    });
  });

  it('保存提醒：preUpgrade / preUninstall 引用 params.* 时提示，仅 preInstall 或不引用时无此提醒', async () => {
    const ctx = makeV2AppContext();
    const cookie = await loginAsAdmin(ctx as never);
    const post = async (id: string, hooks: Record<string, unknown>) => {
      const res = await ctx.app.request(
        '/api/v1/app-manifests',
        {
          method: 'POST',
          headers: authHeaders(cookie),
          body: JSON.stringify({ id, manifest: v2Manifest({ hooks }) }),
        },
        ctx.env,
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { warnings?: string[] }).warnings ?? [];
    };

    const upgradeWarn = await post('warn-up', {
      preUpgrade: { method: 'POST', url: 'https://hub.example.com/u', body: { p: '{{params.port}}' } },
    });
    expect(upgradeWarn).toHaveLength(1);
    expect(upgradeWarn[0]).toContain('preUpgrade');
    expect(upgradeWarn[0]).toContain('{{params.port}}');
    expect(upgradeWarn[0]).toContain('拿不到安装时填的值');

    const uninstallWarn = await post('warn-un', {
      preUninstall: { method: 'POST', url: 'https://hub.example.com/{{params.port}}' },
    });
    expect(uninstallWarn.join('\n')).toContain('preUninstall');

    expect(
      await post('warn-in', {
        preInstall: { method: 'POST', url: 'https://hub.example.com/i', body: { p: '{{params.port}}' } },
      }),
    ).toEqual([]);
    expect(
      await post('warn-none', {
        preUpgrade: { method: 'POST', url: 'https://hub.example.com/u', body: { p: '{{instance}}' } },
      }),
    ).toEqual([]);
  });
});
