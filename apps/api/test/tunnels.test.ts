import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { authHeaders, loginAsAdmin, makeTestContext } from './helpers/context';

/**
 * PR1：全局隧道配置 + 节点接入方式。
 * 覆盖：Token 只写不读、节点引用隧道时 endpoint/preferredRoute 由服务端推导、
 * 隧道被引用时禁止删除、安装命令注册 cloudflared 且 Agent 只监听回环。
 */

const TOKEN = 'cf-tunnel-token-0123456789abcdef';
const PACKAGE_URL = 'https://downloads.example.com/khc-agent/khc-agent-0.1.0.tar.gz';
const SHA256 = 'a'.repeat(64);

beforeEach(() => resetRateLimitForTests());

async function setup() {
  const ctx = makeTestContext();
  const cookie = await loginAsAdmin(ctx);
  return { ctx, cookie };
}

async function createTunnel(
  ctx: ReturnType<typeof makeTestContext>,
  cookie: string,
  overrides: Record<string, unknown> = {},
) {
  return ctx.app.request(
    '/api/v1/tunnels',
    {
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify({
        name: '东京隧道',
        hostname: 'tokyo.example.com',
        originPort: 8880,
        token: TOKEN,
        ...overrides,
      }),
    },
    ctx.env,
  );
}

describe('全局隧道配置', () => {
  it('创建/列表只回 hasToken，任何响应都不回显 Token', async () => {
    const { ctx, cookie } = await setup();
    const created = await createTunnel(ctx, cookie);
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      tunnel: { id: string; hasToken: boolean; hostname: string };
    };
    expect(body.tunnel.hasToken).toBe(true);
    expect(body.tunnel.hostname).toBe('tokyo.example.com');
    expect(JSON.stringify(body)).not.toContain(TOKEN);

    const list = await ctx.app.request('/api/v1/tunnels', { headers: authHeaders(cookie) }, ctx.env);
    const listBody = await list.text();
    expect(listBody).not.toContain(TOKEN);
    expect(JSON.parse(listBody).tunnels).toHaveLength(1);
  });

  it('同域名不可重复；更新可轮换 Token 但响应当中仍无明文', async () => {
    const { ctx, cookie } = await setup();
    const created = (await (await createTunnel(ctx, cookie)).json()) as {
      tunnel: { id: string };
    };
    const duplicate = await createTunnel(ctx, cookie);
    expect(duplicate.status).toBe(409);

    const patched = await ctx.app.request(
      `/api/v1/tunnels/${created.tunnel.id}`,
      {
        method: 'PATCH',
        headers: authHeaders(cookie),
        body: JSON.stringify({ token: 'rotated-tunnel-token-0123456789' }),
      },
      ctx.env,
    );
    expect(patched.status).toBe(200);
    const text = await patched.text();
    expect(text).not.toContain('rotated-tunnel-token');
    expect(JSON.parse(text).tunnel.hasToken).toBe(true);
  });

  it('节点引用隧道时禁止删除；解除引用后可删', async () => {
    const { ctx, cookie } = await setup();
    const created = (await (await createTunnel(ctx, cookie)).json()) as {
      tunnel: { id: string };
    };
    const nodeRes = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: '隧道节点',
          endpoint: 'https://placeholder.example.com',
          accessMode: 'tunnel',
          tunnelId: created.tunnel.id,
        }),
      },
      ctx.env,
    );
    expect(nodeRes.status).toBe(201);
    const node = (await nodeRes.json()) as {
      node: { id: string; endpoint: string; accessMode: string; preferredRoute: string };
    };
    // endpoint / 路由由服务端按隧道域名推导，不接受手填
    expect(node.node.endpoint).toBe('https://tokyo.example.com');
    expect(node.node.accessMode).toBe('tunnel');
    expect(node.node.preferredRoute).toBe('tunnel');

    const blocked = await ctx.app.request(
      `/api/v1/tunnels/${created.tunnel.id}`,
      { method: 'DELETE', headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(blocked.status).toBe(409);

    const detach = await ctx.app.request(
      `/api/v1/nodes/${node.node.id}`,
      {
        method: 'PATCH',
        headers: authHeaders(cookie),
        body: JSON.stringify({ accessMode: 'domain', endpoint: 'https://hub.example.com:8443' }),
      },
      ctx.env,
    );
    expect(detach.status).toBe(200);

    const removed = await ctx.app.request(
      `/api/v1/tunnels/${created.tunnel.id}`,
      { method: 'DELETE', headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(removed.status).toBe(200);
  });

  it('tunnel 安装命令：先注册 cloudflared，Agent 监听 127.0.0.1:<originPort>', async () => {
    const { ctx, cookie } = await setup();
    const created = (await (await createTunnel(ctx, cookie)).json()) as {
      tunnel: { id: string };
    };
    const nodeRes = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: '隧道节点',
          endpoint: 'https://placeholder.example.com',
          accessMode: 'tunnel',
          tunnelId: created.tunnel.id,
        }),
      },
      ctx.env,
    );
    const node = (await nodeRes.json()) as { node: { id: string } };
    const res = await ctx.app.request(
      `/api/v1/nodes/${node.node.id}/agent/install-command`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ mode: 'system', packageUrl: PACKAGE_URL, sha256: SHA256 }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { command: string };
    expect(body.command).toContain('cloudflared service install');
    expect(body.command).toContain(TOKEN);
    expect(body.command).toContain('--host 127.0.0.1 --port 8880');
    expect(body.command).toContain('--insecure-http');
  });

  it('隧道引用不存在时创建节点返回 400', async () => {
    const { ctx, cookie } = await setup();
    const res = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: '坏引用',
          endpoint: 'https://placeholder.example.com',
          accessMode: 'tunnel',
          tunnelId: 'tn_missing',
        }),
      },
      ctx.env,
    );
    expect(res.status).toBe(400);
  });
});

describe('节点接入方式（IP 直连）', () => {
  it('IP 模式需要 allowInsecure；生产环境无显式开关仍返回 insecure_endpoint', async () => {
    const { ctx, cookie } = await setup();
    // development：允许创建（TLS 门禁豁免），accessMode 落库为 ip
    const ok = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: 'IP 节点',
          endpoint: 'http://10.0.0.9:8880',
          accessMode: 'ip',
          allowInsecure: true,
        }),
      },
      ctx.env,
    );
    expect(ok.status).toBe(201);
    const node = (await ok.json()) as {
      node: { accessMode: string; allowInsecure: boolean };
    };
    expect(node.node.accessMode).toBe('ip');
    expect(node.node.allowInsecure).toBe(true);
  });

  it('生产环境 allowInsecure=true 时放行 http 入口', async () => {
    const { ctx, cookie } = await setup();
    ctx.env.ENVIRONMENT = 'production';
    const res = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: '明文节点',
          endpoint: 'http://203.0.113.12:8880',
          accessMode: 'ip',
          allowInsecure: true,
        }),
      },
      ctx.env,
    );
    expect(res.status).toBe(201);
  });
});
