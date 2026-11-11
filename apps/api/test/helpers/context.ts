import { createApp } from '../../src/app';
import type { Env } from '../../src/types';
import type { AgentCallOptions, AgentClient, AgentNode, AgentResponse } from '../../src/lib/node-client';
import type { CfFetch } from '../../src/lib/cf-dns';
import {
  MemoryAppConfigRepo,
  MemoryAuditRepo,
  MemoryCertificateRepo,
  MemoryNodeRepo,
  MemorySettingsRepo,
  MemorySshKeyRepo,
  MemoryTunnelRepo,
} from './memory';

/** 可编程的假 Agent：测试里通过 handler 决定 /state、/apps/... 的返回 */
export class FakeAgentClient implements AgentClient {
  readonly requests: Array<{
    method: string;
    path: string;
    body: unknown;
    idempotencyKey?: string;
    timeoutMs?: number;
  }> = [];

  handler: (
    method: string,
    path: string,
    body: unknown,
    node?: AgentNode,
  ) => Promise<{ status: number; body: unknown }> = async () => ({ status: 200, body: { ok: true } });

  async call(
    node: AgentNode,
    _token: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    opts?: AgentCallOptions,
  ): Promise<AgentResponse> {
    this.requests.push({
      method,
      path,
      body,
      idempotencyKey: opts?.idempotencyKey,
      timeoutMs: opts?.timeoutMs,
    });
    const result = await this.handler(method, path, body, node);
    return { status: result.status, body: result.body, route: node.preferredRoute, via: 'fetch' };
  }
}

export interface TestContext {
  app: ReturnType<typeof createApp>;
  env: Env;
  nodes: MemoryNodeRepo;
  apps: MemoryAppConfigRepo;
  audit: MemoryAuditRepo;
  certs: MemoryCertificateRepo;
  settings: MemorySettingsRepo;
  sshKeys: MemorySshKeyRepo;
  tunnels: MemoryTunnelRepo;
  /** 默认的可编程假 Agent（现有测试通过 .handler / .requests 驱动） */
  agent: FakeAgentClient;
  /** 实际注入 createApp 的客户端；注入真实 HttpAgentClient 时与 agent 不同 */
  agentClient: AgentClient;
}

export function makeTestContext(cfFetch?: CfFetch, agentOverride?: AgentClient): TestContext {
  const nodes = new MemoryNodeRepo();
  const apps = new MemoryAppConfigRepo();
  const audit = new MemoryAuditRepo();
  const certs = new MemoryCertificateRepo();
  const settings = new MemorySettingsRepo();
  const sshKeys = new MemorySshKeyRepo();
  const tunnels = new MemoryTunnelRepo();
  const agent = new FakeAgentClient();
  const agentClient = agentOverride ?? agent;
  const app = createApp({
    nodes,
    apps,
    audit,
    certs,
    settings,
    sshKeys,
    tunnels,
    agent: agentClient,
    cfFetch,
  });
  const env = {
    ENVIRONMENT: 'development',
    ADMIN_PASSWORD: 'test-pass',
    SESSION_SECRET: 'test-secret-0123456789abcdef0123456789',
    MASTER_ENC_KEY: 'test-master-key-0123456789',
    // 默认没有随部署发布的签名清单（404），走 secret 兜底；测试可按需替换。
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
  } as unknown as Env;
  return { app, env, nodes, apps, audit, certs, settings, sshKeys, tunnels, agent, agentClient };
}

/** 登录并返回 Cookie 头（含 name=value） */
export async function loginAsAdmin(ctx: TestContext): Promise<string> {
  const res = await ctx.app.request(
    '/api/v1/auth/login',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-pass' }),
    },
    ctx.env,
  );
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const setCookie = res.headers.get('set-cookie');
  if (!setCookie) throw new Error('missing set-cookie');
  return setCookie.split(';')[0] ?? '';
}

export function authHeaders(cookie: string): Record<string, string> {
  return { cookie, 'content-type': 'application/json' };
}

/** 建一个节点，返回 id 与一次性 token */
export async function createNode(
  ctx: TestContext,
  cookie: string,
): Promise<{ id: string; token: string }> {
  const res = await ctx.app.request(
    '/api/v1/nodes',
    {
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify({ name: '测试 Hub', endpoint: 'https://hub.example.com:8443' }),
    },
    ctx.env,
  );
  if (res.status !== 201) throw new Error(`create node failed: ${res.status}`);
  const body = (await res.json()) as { node: { id: string }; token: string };
  return { id: body.node.id, token: body.token };
}
