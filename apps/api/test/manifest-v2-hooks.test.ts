import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_MANIFEST_FEATURES } from '@khc/contracts';
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

const INSTALL = '#!/usr/bin/env bash\necho ok\n';
const UNINSTALL = '#!/usr/bin/env bash\necho rm\n';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function makeContext(opts: { hookFetch?: typeof fetch; environment?: string } = {}) {
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

function makeManifestWithHook(hook: Record<string, unknown>, stage: 'preInstall' | 'preUpgrade' = 'preInstall') {
  return {
    schema: 2 as const,
    name: 'Hook App',
    version: '2.0.0',
    runtime: { mode: 'root' as const, linger: true },
    params: [{ key: 'label', type: 'string' as const, default: 'prod' }],
    secrets: [{ name: 'api_key', label: 'Key' }],
    hooks: { [stage]: hook },
    scripts: { install: INSTALL, uninstall: UNINSTALL, upgrade: INSTALL },
    sha256: { install: sha(INSTALL), uninstall: sha(UNINSTALL), upgrade: sha(INSTALL) },
    writes: [],
  };
}

let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  resetRateLimitForTests();
  consoleSpies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'info').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
});

describe('应用清单 v2 控制面步骤与出站安全约束（V2）', () => {
  it('模板替换、facts 作用域、allowHosts 精确校验与凭据零回显', async () => {
    const SECRET_RAW = 'sk_live_NEVER_LEAK_XYZ';
    const receivedRequests: Array<{ url: string; init?: RequestInit }> = [];
    const hookFetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      receivedRequests.push({ url: String(url), init });
      return new Response(JSON.stringify({ token: 'tok_out', ext_id: 'ext_42', num: 12 }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const ctx = makeContext({ hookFetch });
    const cookie = await loginAsAdmin(ctx as never);
    const { id: nodeId } = await createNode(ctx as never, cookie);

    ctx.agent.handler = async (_m, p) => {
      if (p.includes('manifest_preflight')) {
        return {
          status: 200,
          body: {
            ok: true,
            capabilities: { schemas: [1, 2], features: [...AGENT_MANIFEST_FEATURES] },
            checks: [],
            installed: { version: '2.0.0', schema: 2, facts: { hub_node_id: 'hn_99' } },
          },
        };
      }
      return { status: 200, body: { ok: true, taskId: 't-ok' } };
    };

    // 1. 未配置凭据 → 400 secret_not_configured 且不发请求
    await ctx.appManifests.create({
      id: 'hook-app',
      enabled: true,
      manifest: makeManifestWithHook(
        {
          method: 'POST',
          url: 'https://hub.example.com/nodes/{{facts.hub_node_id}}?env={{params.label}}&node={{node.name}}',
          headers: { authorization: 'Bearer {{secret.api_key}}' },
          body: { inst: '{{instance}}', id: '{{facts.hub_node_id}}' },
          extract: { token: '/token', ext_id: '/ext_id' },
          public: ['ext_id'],
          expectStatus: [200, 201],
        },
        'preUpgrade',
      ),
    });

    const missingRes = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/manifest_upgrade`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ params: { manifestId: 'hook-app' }, idempotencyKey: 'h-miss' }),
      },
      ctx.env,
    );
    expect(missingRes.status).toBe(400);
    expect(((await missingRes.json()) as { error: { code: string } }).error.code).toBe('secret_not_configured');
    expect(hookFetch).not.toHaveBeenCalled();

    // 2. 主机不在 allowHosts → 403 secret_host_not_allowed 且不发请求
    await ctx.settings.put('app.hook-app.api_key', {
      value: SECRET_RAW,
      allowHosts: ['evil-only.example.com'],
    });
    const hostErrRes = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/manifest_upgrade`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ params: { manifestId: 'hook-app' }, idempotencyKey: 'h-host' }),
      },
      ctx.env,
    );
    expect(hostErrRes.status).toBe(403);
    expect(((await hostErrRes.json()) as { error: { code: string } }).error.code).toBe('secret_host_not_allowed');
    expect(hookFetch).not.toHaveBeenCalled();

    // 3. 配置正确 host → 成功、ext 进入 Server-Timing、audit 无凭据值、hookOutputs/hookFacts 分离
    await ctx.settings.put('app.hook-app.api_key', {
      value: SECRET_RAW,
      allowHosts: ['hub.example.com'],
    });
    const okRes = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/manifest_upgrade`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ params: { manifestId: 'hook-app', instance: 'alpha' }, idempotencyKey: 'h-ok' }),
      },
      ctx.env,
    );
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get('Server-Timing')).toContain('ext;');
    expect(receivedRequests[0]?.url).toBe('https://hub.example.com/nodes/hn_99?env=prod&node=测试 Hub');
    expect(receivedRequests[0]?.init?.redirect).toBe('manual');
    expect((receivedRequests[0]?.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${SECRET_RAW}`);

    const agentForwarded = (ctx.agent.requests.at(-1)?.body as { params: Record<string, unknown> }).params;
    expect(agentForwarded.hookOutputs).toEqual({ token: 'tok_out', ext_id: 'ext_42' });
    expect(agentForwarded.hookFacts).toEqual({ ext_id: 'ext_42' });

    // 凭据值绝不出现在响应、审计或任何 console.* 调用中
    expect(await okRes.text()).not.toContain(SECRET_RAW);
    expect(JSON.stringify(ctx.audit.entries)).not.toContain(SECRET_RAW);
    expect(JSON.stringify(ctx.audit.entries)).not.toContain('tok_out');
    for (const spy of consoleSpies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET_RAW);
    }
  });

  it('出站保护：3xx 失败、超时失败、65KB 响应失败、非 JSON/状态不符失败（仅截断 error）', async () => {
    let mode: '302' | 'timeout' | 'huge' | 'not_json' | 'err_status' = '302';
    const hookFetch = vi.fn(async () => {
      if (mode === '302') {
        return new Response('', { status: 302, headers: { location: 'https://evil.example/steal' } });
      }
      if (mode === 'timeout') {
        throw new DOMException('Aborted', 'TimeoutError');
      }
      if (mode === 'huge') {
        const big = new Uint8Array(65 * 1024).fill(97);
        return new Response(big, { status: 200 });
      }
      if (mode === 'not_json') {
        return new Response('plain-not-json', { status: 200 });
      }
      return new Response(
        JSON.stringify({ error: 'E'.repeat(300), secretEcho: 'should-never-echo' }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const ctx = makeContext({ hookFetch });
    const cookie = await loginAsAdmin(ctx as never);
    const { id: nodeId } = await createNode(ctx as never, cookie);
    await ctx.appManifests.create({
      id: 'guard-app',
      enabled: true,
      manifest: makeManifestWithHook({
        method: 'POST',
        url: 'https://hub.example.com/hook',
        extract: { key: '/key' },
        expectStatus: [200],
      }),
    });
    ctx.agent.handler = async () => ({
      status: 200,
      body: {
        ok: true,
        capabilities: { schemas: [1, 2], features: [...AGENT_MANIFEST_FEATURES] },
        checks: [],
        installed: null,
      },
    });

    const invoke = (k: string) =>
      ctx.app.request(
        `/api/v1/nodes/${nodeId}/apps/app-catalog/manifest_install`,
        {
          method: 'POST',
          headers: authHeaders(cookie),
          body: JSON.stringify({ params: { manifestId: 'guard-app' }, idempotencyKey: k }),
        },
        ctx.env,
      );

    for (const [m, code] of [
      ['302', 'hook_failed'],
      ['timeout', 'hook_failed'],
      ['huge', 'hook_failed'],
      ['not_json', 'hook_extract_failed'],
    ] as const) {
      mode = m;
      const res = await invoke(`k-${m}`);
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    }

    mode = 'err_status';
    const errRes = await invoke('k-err');
    expect(errRes.status).toBe(502);
    const errText = await errRes.text();
    expect(errText).not.toContain('should-never-echo');
    const errBody = JSON.parse(errText) as { error: { details: { error: string } } };
    expect(errBody.error.details.error).toHaveLength(200);
  });

  it('明文通道且带 hookOutputs 时拒绝转发给 Agent', async () => {
    const hookFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ key: 'hk_secret' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const ctx = makeContext({ hookFetch });
    const cookie = await loginAsAdmin(ctx as never);
    const { id: nodeId } = await createNode(ctx as never, cookie);
    await ctx.nodes.update(nodeId, {
      endpoint: 'http://203.0.113.10:8880',
      accessMode: 'ip',
      allowInsecure: true,
    });
    (ctx.env as { ENVIRONMENT?: string }).ENVIRONMENT = 'production';
    await ctx.appManifests.create({
      id: 'sec-chan-app',
      enabled: true,
      manifest: makeManifestWithHook({
        method: 'POST',
        url: 'https://hub.example.com/hook',
        extract: { key: '/key' },
      }),
    });
    ctx.agent.handler = async () => ({
      status: 200,
      body: {
        ok: true,
        capabilities: { schemas: [1, 2], features: [...AGENT_MANIFEST_FEATURES] },
        checks: [],
        installed: null,
      },
    });

    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/app-catalog/manifest_install`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ params: { manifestId: 'sec-chan-app' }, idempotencyKey: 'sec-chan' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('insecure_channel_secret');
    // 预检发出过，但安装动作因明文通道被阻断未发给 Agent
    expect(ctx.agent.requests.every((r) => !r.path.includes('manifest_install'))).toBe(true);
  });
});
