import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { HubUnreachableError } from '../src/lib/node-client';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

beforeEach(() => resetRateLimitForTests());

describe('GET /api/v1/nodes/:id/overview', () => {
  it('未登录返回 401，节点不存在返回 404', async () => {
    const ctx = makeTestContext();
    const unauth = await ctx.app.request('/api/v1/nodes/nd_missing/overview', {}, ctx.env);
    expect(unauth.status).toBe(401);

    const cookie = await loginAsAdmin(ctx);
    const missing = await ctx.app.request(
      '/api/v1/nodes/nd_missing/overview',
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(missing.status).toBe(404);
  });

  it('聚合 D1 配置、证书与 Agent /state，更新 lastSeenAt 并正确判定 502/500/404', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const { id } = await createNode(ctx, cookie);
    await ctx.nodes.update(id, { domain: 'hub.example.com' });

    const now = Math.floor(Date.now() / 1000);
    await ctx.apps.put(id, 'caddy-site', {
      schemaVersion: 1,
      actor: 'admin',
      config: {
        sites: [
          { name: 'ok-app', kind: 'proxy', domains: ['ok.example.com'], upstreams: ['127.0.0.1:8080'], enabled: true },
          { name: 'bad-502', kind: 'proxy', domains: ['bad.example.com'], upstreams: ['127.0.0.1:8081'], enabled: true },
          { name: 'err-500', kind: 'proxy', domains: ['e500.example.com'], upstreams: ['127.0.0.1:8082'], enabled: true },
          { name: 'err-404', kind: 'proxy', domains: ['e404.example.com'], upstreams: ['127.0.0.1:8083'], enabled: true },
          { name: 'blog', kind: 'static', domains: ['blog.example.com'], root: '/var/www', enabled: true },
          { name: 'jump', kind: 'redirect', domains: ['jump.example.com'], redirectTo: 'https://ok.example.com', enabled: true },
        ],
      },
    });
    await ctx.apps.put(id, 'wireguard', {
      schemaVersion: 1,
      actor: 'admin',
      config: {
        enabled: true,
        interface: { name: 'wg0', listenPort: 51820 },
        peers: [
          { name: 'peer-a', enabled: true },
          { name: 'peer-b', enabled: true },
        ],
      },
    });
    await ctx.apps.put(id, 'port-forward', {
      schemaVersion: 1,
      actor: 'admin',
      config: {
        forwards: [{ name: 'ssh', listenPort: 2222, targetHost: '10.8.0.2', targetPort: 22, protocol: 'tcp', enabled: true }],
      },
    });
    await ctx.certs.create({
      name: 'hub-cert',
      domains: ['hub.example.com'],
      issuer: 'acme',
      notAfter: now + 9 * 86_400,
      certPem: 'CERT',
      keyPem: 'KEY',
      sourceNodeId: id,
    });

    ctx.agent.handler = async (_method, path) => {
      expect(path).toBe('/state');
      return {
        status: 200,
        body: {
          host: { hostname: 'hk-1', os: 'Ubuntu 24.04', kernel: '6.8.0', uptime: 12345 },
          agent: { version: '0.6.3', serverTime: now, epoch: 'stale-epoch', tls: { enabled: true, notAfter: now + 50 * 86_400 } },
          adapters: [
            {
              name: 'caddy-site',
              version: '1.2.0',
              status: {
                siteHealth: [
                  { name: 'ok-app', domain: 'ok.example.com', state: 'ok', status: 200, upstreams: ['127.0.0.1:8080'] },
                  { name: 'bad-502', domain: 'bad.example.com', state: 'warn', status: 502, error: 'HTTP 502', upstreams: ['127.0.0.1:8081'] },
                  { name: 'err-500', domain: 'e500.example.com', state: 'warn', status: 500, error: 'HTTP 500', upstreams: ['127.0.0.1:8082'] },
                  { name: 'err-404', domain: 'e404.example.com', state: 'warn', status: 404, error: 'HTTP 404', upstreams: ['127.0.0.1:8083'] },
                ],
              },
            },
            {
              name: 'wireguard',
              version: '1.0.0',
              status: {
                peers: [
                  { name: 'peer-a', online: true, latestHandshake: now - 15 },
                  { name: 'peer-b', online: false, latestHandshake: 0 },
                ],
              },
            },
            {
              name: 'port-forward',
              version: '1.0.0',
              status: {
                forwards: [{ name: 'ssh', listenPort: 2222, targetHost: '10.8.0.2', targetPort: 22, protocol: 'tcp', active: true }],
              },
            },
          ],
          ports: [],
          ops: {
            failedUnits: ['caddy.service'],
            services: {
              services: [
                { name: 'khc-agent', state: 'active' },
                { name: 'caddy', state: 'failed' },
              ],
            },
          },
        },
      };
    };

    const res = await ctx.app.request(`/api/v1/nodes/${id}/overview`, { headers }, ctx.env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as {
      node: { id: string; status: string; lastSeenAt: number | null; summary?: { mode: string | null; peers: number | null } };
      reachable: boolean;
      epochStale?: boolean;
      tls?: { state: string };
      state: unknown;
      overview: {
        apps: { online: number | null; total: number; staticCount: number; redirectCount: number; issues: Array<{ name: string; status: number | null }> };
        peers: { online: number | null; total: number; offline: string[] };
        forwards: { total: number; tcpCount: number };
        certs: { count: number; soonestDaysLeft: number | null; expiring: Array<{ name: string }> };
        accessCert: { daysLeft: number | null; tlsState: string };
        host: { hostname: string | null; agentVersion: string | null } | null;
        managedServices: Array<{ name: string; state: string }>;
        failedUnits: string[] | null;
      };
    };

    expect(body.reachable).toBe(true);
    expect(body.epochStale).toBe(true);
    expect(body.tls?.state).toBe('verified');
    expect(body.state).toBeTruthy();
    expect(body.node.status).toBe('online');
    expect(body.node.lastSeenAt).toBeTruthy();
    expect(body.node.summary?.mode).toBe('wg');
    expect(body.node.summary?.peers).toBe(2);

    expect(body.overview.apps.online).toBe(3);
    expect(body.overview.apps.total).toBe(4);
    expect(body.overview.apps.staticCount).toBe(1);
    expect(body.overview.apps.redirectCount).toBe(1);
    expect(body.overview.apps.issues).toEqual([{ name: 'bad-502', domain: 'bad.example.com', state: 'warn', status: 502 }]);
    expect(body.overview.peers.online).toBe(1);
    expect(body.overview.peers.total).toBe(2);
    expect(body.overview.peers.offline).toEqual(['peer-b']);
    expect(body.overview.forwards.total).toBe(1);
    expect(body.overview.forwards.tcpCount).toBe(1);
    expect(body.overview.certs.count).toBe(1);
    expect(body.overview.certs.soonestDaysLeft).toBe(9);
    expect(body.overview.certs.expiring).toHaveLength(1);
    expect(body.overview.accessCert).toEqual({ daysLeft: 50, tlsState: 'verified' });
    expect(body.overview.host?.hostname).toBe('hk-1');
    expect(body.overview.host?.agentVersion).toBe('0.6.3');
    expect(body.overview.managedServices).toHaveLength(2);
    expect(body.overview.failedUnits).toEqual(['caddy.service']);

    const stored = await ctx.nodes.get(id);
    expect(stored?.lastSeenAt).toBe(body.node.lastSeenAt);
  });

  it('Agent 不可达时仍返回 200，保留 D1 配置投影且不写 lastSeenAt', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    await ctx.apps.put(id, 'caddy-site', {
      schemaVersion: 1,
      actor: 'admin',
      config: {
        sites: [{ name: 'web', kind: 'proxy', domains: ['web.test'], upstreams: ['127.0.0.1:8080'] }],
      },
    });
    ctx.agent.handler = async () => {
      throw new HubUnreachableError('Hub 不可达', { direct: 'ECONNREFUSED' });
    };

    const res = await ctx.app.request(`/api/v1/nodes/${id}/overview`, { headers: authHeaders(cookie) }, ctx.env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reachable: boolean;
      error: string | null;
      state: unknown;
      node: { lastSeenAt: number | null };
      overview: {
        apps: { online: number | null; total: number; items: Array<{ name: string; verdict: string }> };
        host: unknown;
        failedUnits: unknown;
      };
    };
    expect(body.reachable).toBe(false);
    expect(body.error).toContain('Hub 不可达');
    expect(body.state).toBeNull();
    expect(body.node.lastSeenAt).toBeNull();
    expect(body.overview.apps.total).toBe(1);
    expect(body.overview.apps.online).toBeNull();
    expect(body.overview.apps.items[0]).toMatchObject({ name: 'web', verdict: 'unknown' });
    expect(body.overview.host).toBeNull();
    expect(body.overview.failedUnits).toBeNull();
    expect((await ctx.nodes.get(id))?.lastSeenAt).toBeNull();
  });

  it('Agent 401/无效 /state 时返回可读错误与 D1 投影，且支持 ?force=1 透传', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    await ctx.apps.put(id, 'port-forward', {
      schemaVersion: 1,
      actor: 'admin',
      config: { forwards: [{ name: 'ssh', listenPort: 2222, targetHost: '10.0.0.2', targetPort: 22 }] },
    });

    ctx.agent.handler = async () => ({ status: 401, body: { error: { message: 'invalid hmac' } } });
    const res401 = await ctx.app.request(
      `/api/v1/nodes/${id}/overview?force=1`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res401.status).toBe(200);
    expect(ctx.agent.requests[0]?.path).toBe('/state?force=1');
    const b401 = (await res401.json()) as {
      reachable: boolean;
      error: string | null;
      state: unknown;
      overview: { forwards: { total: number } };
    };
    expect(b401.reachable).toBe(false);
    expect(b401.error).toContain('Agent 鉴权失败');
    expect(b401.state).toBeNull();
    expect(b401.overview.forwards.total).toBe(1);

    ctx.agent.handler = async () => ({ status: 200, body: { ok: true } });
    const resInvalid = await ctx.app.request(
      `/api/v1/nodes/${id}/overview`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(resInvalid.status).toBe(200);
    const bInvalid = (await resInvalid.json()) as {
      reachable: boolean;
      error: string | null;
      state: unknown;
      overview: { forwards: { total: number } };
    };
    expect(bInvalid.reachable).toBe(true);
    expect(bInvalid.error).toContain('返回格式不合法');
    expect(bInvalid.state).toBeNull();
    expect(bInvalid.overview.forwards.total).toBe(1);

    // 旧 Agent 无 D1 配置时仍可从 /state 回退构建投影
    const emptyCtx = makeTestContext();
    const emptyCookie = await loginAsAdmin(emptyCtx);
    const { id: legacyId } = await createNode(emptyCtx, emptyCookie);
    emptyCtx.agent.handler = async () => ({
      status: 200,
      body: {
        host: { hostname: 'legacy' },
        adapters: [
          {
            name: 'caddy-site',
            version: '1.0.0',
            status: { siteHealth: [{ name: 's1', domain: 's1.test', state: 'ok', status: 200, upstreams: ['127.0.0.1:8080'] }] },
          },
        ],
        ports: [],
      },
    });
    const resLegacy = await emptyCtx.app.request(
      `/api/v1/nodes/${legacyId}/overview`,
      { headers: authHeaders(emptyCookie) },
      emptyCtx.env,
    );
    const bLegacy = (await resLegacy.json()) as {
      overview: { apps: { total: number; online: number | null } };
    };
    expect(bLegacy.overview.apps.total).toBe(1);
    expect(bLegacy.overview.apps.online).toBe(1);
  });
});
