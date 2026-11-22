import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { HubUnreachableError } from '../src/lib/node-client';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

beforeEach(() => resetRateLimitForTests());

describe('POST /nodes/probe（一次请求批量探测）', () => {
  const stateBody = {
    host: { hostname: 'hub' },
    adapters: [
      {
        name: 'wireguard',
        version: '1.0.0',
        status: { installed: false, running: false },
      },
      {
        name: 'caddy-site',
        version: '1.0.0',
        status: { installed: true, running: true },
      },
      { name: 'host-ops', version: '1.0.0' },
    ],
    ports: [],
  };

  it('逐节点返回可达结果与应用状态；只有成功的节点更新 lastSeenAt', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const first = await createNode(ctx, cookie);
    const second = await createNode(ctx, cookie);

    ctx.agent.handler = async (_method, path, _body, node) => {
      if (path !== '/state') return { status: 404, body: {} };
      if (node?.id === second.id) {
        throw new HubUnreachableError('Hub 不可达', { direct: 'ECONNREFUSED' });
      }
      return { status: 200, body: stateBody };
    };

    const res = await ctx.app.request(
      '/api/v1/nodes/probe',
      { method: 'POST', headers },
      ctx.env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as {
      probedAt: number;
      nodes: Array<{
        id: string;
        reachable: boolean;
        error: string | null;
        lastSeenAt: number | null;
        apps?: Array<{ name: string; installed: boolean | null; running: boolean | null }>;
      }>;
    };
    expect(body.nodes).toHaveLength(2);
    const ok = body.nodes.find((n) => n.id === first.id);
    const bad = body.nodes.find((n) => n.id === second.id);
    expect(ok?.reachable).toBe(true);
    expect(ok?.error).toBeNull();
    expect(ok?.lastSeenAt).toBe(body.probedAt);
    // 只透出 name/installed/running，未上报的字段为 null（不伪造）
    expect(ok?.apps).toEqual([
      { name: 'wireguard', installed: false, running: false },
      { name: 'caddy-site', installed: true, running: true },
      { name: 'host-ops', installed: null, running: null },
    ]);
    expect(bad?.reachable).toBe(false);
    expect(bad?.error).toContain('Hub 不可达');
    expect(bad?.apps).toBeUndefined();

    const storedFirst = await ctx.nodes.get(first.id);
    const storedSecond = await ctx.nodes.get(second.id);
    expect(storedFirst?.lastSeenAt).toBe(body.probedAt);
    expect(storedSecond?.lastSeenAt).toBeNull();
  });

  it('只访问 Agent /state（一次调用同时拿可达性与应用状态）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    await createNode(ctx, cookie);
    ctx.agent.handler = async () => ({ status: 200, body: stateBody });
    await ctx.app.request('/api/v1/nodes/probe', { method: 'POST', headers: authHeaders(cookie) }, ctx.env);
    expect(ctx.agent.requests.map((request) => request.path)).toEqual(['/state']);
    // /state 比 /health 重（systemctl/ps/df），沿用状态页的 10s 预算。
    expect(ctx.agent.requests[0]?.timeoutMs).toBe(10_000);
  });

  it('/state 返回非 2xx：标离线且不带 apps，不影响 lastSeenAt', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const node = await createNode(ctx, cookie);
    ctx.agent.handler = async () => ({ status: 500, body: { error: 'boom' } });
    const res = await ctx.app.request(
      '/api/v1/nodes/probe',
      { method: 'POST', headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: Array<{ reachable: boolean; error: string | null; apps?: unknown }>;
    };
    expect(body.nodes[0]?.reachable).toBe(false);
    expect(body.nodes[0]?.error).toContain('HTTP 500');
    expect(body.nodes[0]?.apps).toBeUndefined();
    expect((await ctx.nodes.get(node.id))?.lastSeenAt).toBeNull();
  });

  it('/state 结构不合法：可达仍为 true，apps 为空数组（不伪造状态）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    await createNode(ctx, cookie);
    ctx.agent.handler = async () => ({ status: 200, body: { ok: true } });
    const res = await ctx.app.request(
      '/api/v1/nodes/probe',
      { method: 'POST', headers: authHeaders(cookie) },
      ctx.env,
    );
    const body = (await res.json()) as {
      nodes: Array<{ reachable: boolean; apps?: unknown[] }>;
    };
    expect(body.nodes[0]?.reachable).toBe(true);
    expect(body.nodes[0]?.apps).toEqual([]);
  });

  it('未登录返回 401', async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.request('/api/v1/nodes/probe', { method: 'POST' }, ctx.env);
    expect(res.status).toBe(401);
  });

  it('没有节点时返回空列表而不是 5xx', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/nodes/probe',
      { method: 'POST', headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nodes: unknown[]; expiringCerts?: unknown[] };
    expect(body.nodes).toEqual([]);
    expect(body.expiringCerts).toEqual([]);
  });

  it('返回每节点同源 projection（502 异常/Peer/转发/证书）与顶层 expiringCerts（含已过期和未归属证书）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const onlineNode = await createNode(ctx, cookie);
    const offlineNode = await createNode(ctx, cookie);
    await ctx.nodes.update(onlineNode.id, { domain: 'on.example.com' });

    const now = Math.floor(Date.now() / 1000);
    await ctx.apps.put(onlineNode.id, 'caddy-site', {
      schemaVersion: 1,
      actor: 'admin',
      config: {
        sites: [
          { name: 'ok-site', kind: 'proxy', domains: ['ok.example.com'], upstreams: ['127.0.0.1:8080'] },
          { name: 'down-502', kind: 'proxy', domains: ['bad.example.com'], upstreams: ['127.0.0.1:8081'] },
        ],
      },
    });
    await ctx.apps.put(onlineNode.id, 'wireguard', {
      schemaVersion: 1,
      actor: 'admin',
      config: {
        enabled: true,
        interface: { name: 'wg0', listenPort: 51820 },
        peers: [
          { name: 'p1', enabled: true },
          { name: 'p2', enabled: true },
        ],
      },
    });
    await ctx.apps.put(offlineNode.id, 'caddy-site', {
      schemaVersion: 1,
      actor: 'admin',
      config: {
        sites: [{ name: 'off-site', kind: 'proxy', domains: ['off.example.com'], upstreams: ['127.0.0.1:9000'] }],
      },
    });
    await ctx.certs.create({
      name: 'node-cert',
      domains: ['on.example.com'],
      issuer: 'acme',
      notAfter: now + 7 * 86_400,
      certPem: 'CERT',
      keyPem: 'KEY',
      sourceNodeId: onlineNode.id,
    });
    await ctx.certs.create({
      name: 'unattached-expired',
      domains: ['orphan.example.com'],
      issuer: 'manual',
      notAfter: now - 2 * 86_400,
      certPem: 'CERT',
      keyPem: 'KEY',
      sourceNodeId: null,
    });
    await ctx.certs.create({
      name: 'healthy-cert',
      domains: ['far.example.com'],
      issuer: 'acme',
      notAfter: now + 60 * 86_400,
      certPem: 'CERT',
      keyPem: 'KEY',
      sourceNodeId: null,
    });

    ctx.agent.handler = async (_method, _path, _body, node) => {
      if (node?.id === offlineNode.id) {
        throw new HubUnreachableError('Hub 不可达', { direct: 'ECONNREFUSED' });
      }
      return {
        status: 200,
        body: {
          host: { hostname: 'on' },
          adapters: [
            {
              name: 'caddy-site',
              version: '1.2.0',
              status: {
                siteHealth: [
                  { name: 'ok-site', domain: 'ok.example.com', state: 'ok', status: 200, upstreams: ['127.0.0.1:8080'] },
                  { name: 'down-502', domain: 'bad.example.com', state: 'warn', status: 502, upstreams: ['127.0.0.1:8081'] },
                ],
              },
            },
            {
              name: 'wireguard',
              version: '1.0.0',
              status: {
                peers: [
                  { name: 'p1', online: true },
                  { name: 'p2', online: false },
                ],
              },
            },
          ],
          ports: [],
        },
      };
    };

    const res = await ctx.app.request('/api/v1/nodes/probe', { method: 'POST', headers }, ctx.env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: Array<{
        id: string;
        reachable: boolean;
        projection?: {
          apps: { online: number | null; total: number; issues: Array<{ name: string; status: number | null }> };
          peers: { online: number | null; total: number; offline: string[] };
          certs: { count: number; soonestDaysLeft: number | null };
          accessCert: { daysLeft: number | null; tlsState: string };
        };
      }>;
      expiringCerts?: Array<{ name: string; daysLeft: number; nodeId: string | null }>;
    };

    const on = body.nodes.find((n) => n.id === onlineNode.id);
    const off = body.nodes.find((n) => n.id === offlineNode.id);
    expect(on?.projection?.apps).toEqual({
      online: 1,
      total: 2,
      issues: [{ name: 'down-502', domain: 'bad.example.com', state: 'warn', status: 502 }],
      staticCount: 0,
      redirectCount: 0,
    });
    expect(on?.projection?.peers).toMatchObject({ online: 1, total: 2, offline: ['p2'] });
    expect(on?.projection?.certs).toMatchObject({ count: 1, soonestDaysLeft: 7 });
    expect(on?.projection?.accessCert).toEqual({ daysLeft: 7, tlsState: 'verified' });

    // 离线节点也保留 D1 配置投影，online 为 null
    expect(off?.reachable).toBe(false);
    expect(off?.projection?.apps).toEqual({
      online: null,
      total: 1,
      issues: [],
      staticCount: 0,
      redirectCount: 0,
    });

    // 顶层临期/已过期证书包含无归属证书且不含 >14 天的证书
    expect(body.expiringCerts?.map((c) => c.name)).toEqual(['unattached-expired', 'node-cert']);
    expect(body.expiringCerts?.[0]).toMatchObject({ name: 'unattached-expired', nodeId: null });
    expect(body.expiringCerts?.[0]?.daysLeft).toBeLessThan(0);
  });

  it('B3-① 滑动并发池（上限 6）：不触发固定分批队头阻塞且保持输入顺序', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const created = [];
    for (let i = 0; i < 8; i += 1) {
      created.push(await createNode(ctx, cookie));
    }
    const listOrder = (await ctx.nodes.list()).map((n) => n.id);
    const slowIds = new Set([listOrder[0], listOrder[4]]);

    let inflight = 0;
    let maxInflight = 0;
    ctx.agent.handler = async (_method, _path, _body, node) => {
      inflight += 1;
      if (inflight > maxInflight) maxInflight = inflight;
      try {
        const delayMs = node && slowIds.has(node.id) ? 240 : 25;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { status: 200, body: stateBody };
      } finally {
        inflight -= 1;
      }
    };

    const t0 = Date.now();
    const res = await ctx.app.request(
      '/api/v1/nodes/probe',
      { method: 'POST', headers: authHeaders(cookie) },
      ctx.env,
    );
    const elapsedMs = Date.now() - t0;
    expect(res.status).toBe(200);
    // 并行池同时跑 index 0 和 index 4，耗时约 240ms；固定 4 并发两批需要 ~480ms。
    expect(elapsedMs).toBeLessThan(410);
    expect(maxInflight).toBe(6);

    const body = (await res.json()) as { nodes: Array<{ id: string; reachable: boolean }> };
    expect(body.nodes.map((n) => n.id)).toEqual(listOrder);
    expect(body.nodes.every((n) => n.reachable)).toBe(true);
  });

  it('B3-① 并发池中单节点抛错/非 2xx 只影响该节点，其余照常成功', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    for (let i = 0; i < 8; i += 1) {
      await createNode(ctx, cookie);
    }
    const listOrder = (await ctx.nodes.list()).map((n) => n.id);
    const throwId = listOrder[1];
    const httpErrId = listOrder[6];

    ctx.agent.handler = async (_method, _path, _body, node) => {
      if (node?.id === throwId) {
        throw new HubUnreachableError('Hub 不可达', { direct: 'ETIMEDOUT' });
      }
      if (node?.id === httpErrId) {
        return { status: 502, body: { error: 'bad gateway' } };
      }
      return { status: 200, body: stateBody };
    };

    const res = await ctx.app.request(
      '/api/v1/nodes/probe',
      { method: 'POST', headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: Array<{ id: string; reachable: boolean; error: string | null }>;
    };
    expect(body.nodes.map((n) => n.id)).toEqual(listOrder);
    for (const item of body.nodes) {
      if (item.id === throwId || item.id === httpErrId) {
        expect(item.reachable).toBe(false);
        expect(item.error).toBeTruthy();
      } else {
        expect(item.reachable).toBe(true);
        expect(item.error).toBeNull();
      }
    }
  });
});
