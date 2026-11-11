import { beforeEach, describe, expect, it } from 'vitest';
import { nowSec } from '../src/lib/ids';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { HubUnreachableError } from '../src/lib/node-client';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

beforeEach(() => resetRateLimitForTests());

describe('nodes CRUD（v3）', () => {
  it('创建返回一次性 token → 列表 → 详情 → 修改 → 删除', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);

    const created = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: '阿里云 Hub',
          endpoint: 'https://hub-a.example.com:8443',
          tunnelEndpoint: 'https://hub-a-t.example.com',
        }),
      },
      ctx.env,
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      node: { id: string; name: string; preferredRoute: string; tunnelEndpoint: string };
      token: string;
    };
    expect(createdBody.node.name).toBe('阿里云 Hub');
    expect(createdBody.node.preferredRoute).toBe('direct');
    expect(createdBody.node.tunnelEndpoint).toBe('https://hub-a-t.example.com');
    expect(createdBody.token.length).toBeGreaterThan(20);
    const nodeId = createdBody.node.id;

    // token 只出现一次：GET 详情不再回显
    const detail = await ctx.app.request(`/api/v1/nodes/${nodeId}`, { headers }, ctx.env);
    const detailBody = (await detail.json()) as Record<string, unknown>;
    expect(detailBody.token).toBeUndefined();
    expect(JSON.stringify(detailBody)).not.toContain(createdBody.token);

    const list = await ctx.app.request('/api/v1/nodes', { headers }, ctx.env);
    const listBody = (await list.json()) as { nodes: Array<{ id: string }> };
    expect(listBody.nodes).toHaveLength(1);

    const patched = await ctx.app.request(
      `/api/v1/nodes/${nodeId}`,
      { method: 'PATCH', headers, body: JSON.stringify({ name: '阿里云 Hub 2' }) },
      ctx.env,
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as { node: { name: string } };
    expect(patchedBody.node.name).toBe('阿里云 Hub 2');

    const deleted = await ctx.app.request(
      `/api/v1/nodes/${nodeId}`,
      { method: 'DELETE', headers },
      ctx.env,
    );
    expect(deleted.status).toBe(200);
    const afterDelete = await ctx.app.request(`/api/v1/nodes/${nodeId}`, { headers }, ctx.env);
    expect(afterDelete.status).toBe(404);
  });

  it('参数校验失败返回 400 + 字段级错误', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/nodes',
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({ name: '' }) },
      ctx.env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; fields?: Record<string, string> };
    };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.fields?.name).toBeTruthy();

    // endpoint 对 tunnel 模式可省略；非隧道模式缺失时由路由层给出字段级错误。
    const missing = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ name: 'no-endpoint' }),
      },
      ctx.env,
    );
    expect(missing.status).toBe(400);
    const missingBody = (await missing.json()) as {
      error: { code: string; fields?: Record<string, string> };
    };
    expect(missingBody.error.code).toBe('bad_request');
    expect(missingBody.error.fields?.endpoint).toBeTruthy();
  });

  it('允许裸 IP endpoint（Worker 会走 TCP socket）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ name: 'IP 节点', endpoint: 'http://203.0.113.12:8880' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { node: { endpoint: string } };
    expect(body.node.endpoint).toBe('http://203.0.113.12:8880');
  });

  it('列表三态：从未探测/租约过期 = unknown（未探测），新鲜租约 = online，offline 不由列表推断', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const { id } = await createNode(ctx, cookie);

    const listStatus = async () => {
      const res = await ctx.app.request('/api/v1/nodes', { headers }, ctx.env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { nodes: Array<{ id: string; status: string }> };
      return body.nodes.find((node) => node.id === id)?.status;
    };

    // 刚建节点还没探测过：必须是 unknown，不能当成离线
    expect(await listStatus()).toBe('unknown');

    // 最后一次成功探测已超出 300s 窗口：老租约 ≠ 离线
    await ctx.nodes.update(id, { lastSeenAt: nowSec() - 400 });
    expect(await listStatus()).toBe('unknown');

    // 窗口内探测成功：在线
    await ctx.nodes.update(id, { lastSeenAt: nowSec() });
    expect(await listStatus()).toBe('online');
  });

  it('F-3：PATCH 带 token 显式轮换（加密写入、零回显、审计脱敏），不再静默丢弃', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const { id } = await createNode(ctx, cookie);
    const before = await ctx.nodes.get(id);
    const newToken = 'rotated-token-0123456789abcdef';

    const res = await ctx.app.request(
      `/api/v1/nodes/${id}`,
      { method: 'PATCH', headers, body: JSON.stringify({ token: newToken }) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const bodyText = JSON.stringify(await res.json());
    expect(bodyText).not.toContain(newToken); // 明文 token 不得回显

    const after = await ctx.nodes.get(id);
    expect(after?.tokenEnc).toBeTruthy();
    // token 必须真正更新（不再是静默丢弃）
    expect(after?.tokenEnc).not.toBe(before?.tokenEnc);
    expect(after?.tokenEnc).not.toContain(newToken); // 存储必须是密文

    // 审计只记 tokenRotated，不含明文
    const entries = await ctx.audit.list({ nodeId: id, limit: 5 });
    const updateEntry = entries.find((e) => e.action === 'node.update');
    expect(updateEntry?.detail).toEqual({ tokenRotated: true });
    expect(JSON.stringify(updateEntry?.detail)).not.toContain(newToken);
  });

  it('F-3：PATCH token 格式非法返回 400（不静默）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    const res = await ctx.app.request(
      `/api/v1/nodes/${id}`,
      { method: 'PATCH', headers: authHeaders(cookie), body: JSON.stringify({ token: 'short' }) },
      ctx.env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; fields?: Record<string, string> } };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.fields?.token).toBeTruthy();
  });

  it('GET /state 正常时更新 lastSeen 并返回状态', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    ctx.agent.handler = async () => ({
      status: 200,
      body: {
        ok: true,
        host: { hostname: 'hub-a', kernel: '6.1' },
        adapters: [{ name: 'node-exporter', version: '1.0.0', appliedRev: 2 }],
        ports: [{ proto: 'tcp', port: 9100, app: 'node-exporter' }],
      },
    });

    const res = await ctx.app.request(`/api/v1/nodes/${id}/state`, { headers: authHeaders(cookie) }, ctx.env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reachable: boolean;
      state: { host: { hostname: string } };
      error: string | null;
    };
    expect(body.reachable).toBe(true);
    expect(body.state.host.hostname).toBe('hub-a');
    expect(body.error).toBeNull();
    const stored = await ctx.nodes.get(id);
    expect(stored?.lastSeenAt).toBeTruthy();
    // 数据分层：运行快照不进入 D1/仓储，只保留轻量可达租约。
    expect(stored && 'lastStateJson' in stored).toBe(false);
  });

  it('D-2/T2.2：/state 旧纪元判定（epoch 一致/不一致/旧 Agent 三态）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    const node = await ctx.nodes.get(id);
    expect(node?.revEpoch).toMatch(/^[0-9a-f]{32}$/);
    const agentState = (epoch?: string) => ({
      status: 200,
      body: {
        ok: true,
        host: { hostname: 'hub-a' },
        adapters: [],
        ports: [],
        ...(epoch ? { agent: { version: '0.1.13', serverTime: 1, epoch } } : {}),
      },
    });
    const call = async () => {
      const res = await ctx.app.request(`/api/v1/nodes/${id}/state`, { headers: authHeaders(cookie) }, ctx.env);
      expect(res.status).toBe(200);
      return (await res.json()) as { epochStale?: boolean };
    };

    // 一致：无旧纪元标记
    ctx.agent.handler = async () => agentState(node?.revEpoch);
    expect((await call()).epochStale).toBeUndefined();
    // 不一致：旧纪元（Agent 记着节点重建/恢复前的 rev 基线），下一次 apply 自动重置
    ctx.agent.handler = async () => agentState('deadbeef'.repeat(4));
    expect((await call()).epochStale).toBe(true);
    // 旧 Agent（<0.1.13）不回传 epoch：按"待升级"处理，不判定
    ctx.agent.handler = async () => agentState();
    expect((await call()).epochStale).toBeUndefined();
  });

  it('GET /state Hub 不可达时返回 200 + reachable:false（不阻塞其他节点）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    ctx.agent.handler = async () => {
      throw new HubUnreachableError('Hub 不可达', { direct: 'ECONNREFUSED' });
    };

    const res = await ctx.app.request(`/api/v1/nodes/${id}/state`, { headers: authHeaders(cookie) }, ctx.env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reachable: boolean; error: string };
    expect(body.reachable).toBe(false);
    expect(body.error).toContain('Hub 不可达');
  });

  it('F-M1：GET /state Agent 401/403 报鉴权类错误，不再误报"格式不合法"', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    for (const status of [401, 403] as const) {
      ctx.agent.handler = async () => ({
        status,
        body: {
          ok: false,
          error: { code: 'unauthorized', message: 'nonce already used' },
        },
      });

      const res = await ctx.app.request(
        `/api/v1/nodes/${id}/state`,
        { headers: authHeaders(cookie) },
        ctx.env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { reachable: boolean; state: unknown; error: string };
      expect(body.reachable).toBe(true);
      expect(body.state).toBeNull();
      expect(body.error).toContain('Agent 鉴权失败');
      expect(body.error).toContain(`HTTP ${status}`);
      expect(body.error).toContain('nonce already used'); // 附带 Agent 的错误信息
      expect(body.error).not.toContain('格式不合法');
    }
    // 鉴权失败不算成功快照：不更新可达租约
    const stored = await ctx.nodes.get(id);
    expect(stored?.lastSeenAt).toBeFalsy();
  });

  it('F-M1：GET /state 其他非 200（如 404）保留格式提示并带状态码', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    ctx.agent.handler = async () => ({
      status: 404,
      body: { ok: false, error: { code: 'not_found', message: 'no such endpoint' } },
    });

    const res = await ctx.app.request(
      `/api/v1/nodes/${id}/state`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reachable: boolean; error: string };
    expect(body.error).toContain('格式不合法');
    expect(body.error).toContain('404');
  });
});

describe('§3.2 生产强制 TLS（路由层，ENVIRONMENT=production）', () => {
  /**
   * 先用 development 登录拿会话，再把同一个 env 对象切成 production；
   * 会话 cookie 只由 SESSION_SECRET 签名、与 ENVIRONMENT 无关，切换后仍有效。
   */
  async function productionSession() {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    ctx.env.ENVIRONMENT = 'production';
    return { ctx, headers };
  }

  const postNode = (
    ctx: ReturnType<typeof makeTestContext>,
    headers: Record<string, string>,
    body: unknown,
  ) =>
    ctx.app.request(
      '/api/v1/nodes',
      { method: 'POST', headers, body: JSON.stringify(body) },
      ctx.env,
    );

  it('production 新建 http:// endpoint 被拒：insecure_endpoint（路由层，不改 zod 契约）', async () => {
    const { ctx, headers } = await productionSession();
    const res = await postNode(ctx, headers, {
      name: '明文节点',
      endpoint: 'http://203.0.113.12:8880',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; fields?: Record<string, string> };
    };
    // http:// 在 contracts 的 endpointUrlSchema 里是合法值 → 不是 zod 的 validation_failed，
    // 而是路由层明确拒绝；证明没有改 contracts、没有与契约冲突。
    expect(body.error.code).toBe('insecure_endpoint');
    expect(body.error.code).not.toBe('validation_failed');
    expect(body.error.fields?.endpoint).toBeTruthy();
    expect(body.error.message).toContain('https');
  });

  it('production 新建非 http(s) 地址仍由 zod 拒绝（validation_failed）：契约未改', async () => {
    const { ctx, headers } = await productionSession();
    const res = await postNode(ctx, headers, {
      name: '非法地址',
      endpoint: 'ftp://hub.example.com',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; fields?: Record<string, string> };
    };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.fields?.endpoint).toBeTruthy();
  });

  it('production 新建 https:// endpoint 通过（含 https tunnelEndpoint）', async () => {
    const { ctx, headers } = await productionSession();
    const res = await postNode(ctx, headers, {
      name: '安全节点',
      endpoint: 'https://hub.example.com:8443',
      tunnelEndpoint: 'https://hub-t.example.com',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { node: { endpoint: string; tunnelEndpoint: string } };
    expect(body.node.endpoint).toBe('https://hub.example.com:8443');
    expect(body.node.tunnelEndpoint).toBe('https://hub-t.example.com');
  });

  it('production 新建填了 http:// tunnelEndpoint 同样被拒', async () => {
    const { ctx, headers } = await productionSession();
    const res = await postNode(ctx, headers, {
      name: '隧道明文',
      endpoint: 'https://hub.example.com:8443',
      tunnelEndpoint: 'http://hub-t.example.com',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; fields?: Record<string, string> };
    };
    expect(body.error.code).toBe('insecure_endpoint');
    expect(body.error.fields?.tunnelEndpoint).toBeTruthy();
  });

  it('development 豁免：http:// endpoint 与 tunnelEndpoint 均可创建', async () => {
    const ctx = makeTestContext(); // 默认 ENVIRONMENT=development
    const cookie = await loginAsAdmin(ctx);
    const res = await postNode(ctx, authHeaders(cookie), {
      name: '本地明文',
      endpoint: 'http://203.0.113.12:8880',
      tunnelEndpoint: 'http://127.0.0.1:8881',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { node: { endpoint: string } };
    expect(body.node.endpoint).toBe('http://203.0.113.12:8880');
  });

  describe('存量 http 节点（不阻断）', () => {
    /** 在 development 下先建一个 http 存量节点，随后把 env 切成 production */
    async function seedLegacyHttpNode() {
      const ctx = makeTestContext();
      const cookie = await loginAsAdmin(ctx);
      const headers = authHeaders(cookie);
      const created = await postNode(ctx, headers, {
        name: '存量 http 节点',
        endpoint: 'http://10.0.0.5:8880',
        tunnelEndpoint: 'http://10.0.0.5:8881',
      });
      expect(created.status).toBe(201);
      const { node } = (await created.json()) as { node: { id: string } };
      ctx.env.ENVIRONMENT = 'production';
      return { ctx, headers, id: node.id };
    }

    it('PATCH 其它字段（不带 endpoint）不受影响，正常放行且不带破坏性错误', async () => {
      const { ctx, headers, id } = await seedLegacyHttpNode();
      const res = await ctx.app.request(
        `/api/v1/nodes/${id}`,
        { method: 'PATCH', headers, body: JSON.stringify({ name: '存量节点改名' }) },
        ctx.env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        node: { name: string; endpoint: string };
        error?: unknown;
      };
      expect(body.node.name).toBe('存量节点改名');
      expect(body.node.endpoint).toBe('http://10.0.0.5:8880'); // 存量明文入口不被改写
      expect(body.error).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('insecure_endpoint');
    });

    it('PATCH 轮换 token（不带 endpoint）不受影响', async () => {
      const { ctx, headers, id } = await seedLegacyHttpNode();
      const res = await ctx.app.request(
        `/api/v1/nodes/${id}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ token: 'rotated-token-0123456789abcdef' }),
        },
        ctx.env,
      );
      expect(res.status).toBe(200);
    });

    it('PATCH 显式改 endpoint 仍为 http:// 被拒（迁移压力）', async () => {
      const { ctx, headers, id } = await seedLegacyHttpNode();
      const res = await ctx.app.request(
        `/api/v1/nodes/${id}`,
        { method: 'PATCH', headers, body: JSON.stringify({ endpoint: 'http://10.0.0.9:8880' }) },
        ctx.env,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('insecure_endpoint');
    });

    it('PATCH 显式迁移 endpoint 到 https:// 通过；但同请求写入 http tunnelEndpoint 仍被拒', async () => {
      const { ctx, headers, id } = await seedLegacyHttpNode();
      const migrated = await ctx.app.request(
        `/api/v1/nodes/${id}`,
        { method: 'PATCH', headers, body: JSON.stringify({ endpoint: 'https://10.0.0.5:8443' }) },
        ctx.env,
      );
      expect(migrated.status).toBe(200);
      const migratedBody = (await migrated.json()) as { node: { endpoint: string } };
      expect(migratedBody.node.endpoint).toBe('https://10.0.0.5:8443');

      // 改 endpoint 的同时把 tunnelEndpoint 写成 http：仍被拒（避免明文隧道绕过）
      const withTunnel = await ctx.app.request(
        `/api/v1/nodes/${id}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            endpoint: 'https://10.0.0.5:8443',
            tunnelEndpoint: 'http://10.0.0.5:8881',
          }),
        },
        ctx.env,
      );
      expect(withTunnel.status).toBe(400);
      const errBody = (await withTunnel.json()) as {
        error: { code: string; fields?: Record<string, string> };
      };
      expect(errBody.error.code).toBe('insecure_endpoint');
      expect(errBody.error.fields?.tunnelEndpoint).toBeTruthy();
    });
  });
});

describe('节点应用摘要（summary，D1 派生，零节点连接）', () => {
  it('列表与详情携带 summary：模式/Peer/站点/转发计数', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const { id } = await createNode(ctx, cookie);
    await ctx.apps.put(id, 'wireguard', {
      config: { peers: [{ name: 'a', enabled: true }, { name: 'b', enabled: false }] },
      schemaVersion: 1,
      actor: 'admin',
    });
    await ctx.apps.put(id, 'caddy-site', {
      config: { sites: [{ enabled: true }, { enabled: false }, { enabled: true }] },
      schemaVersion: 1,
      actor: 'admin',
    });
    await ctx.apps.put(id, 'port-forward', {
      config: { forwards: [{ name: 'ssh' }] },
      schemaVersion: 1,
      actor: 'admin',
    });

    const list = await ctx.app.request('/api/v1/nodes', { headers }, ctx.env);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { nodes: Array<{ id: string; summary: unknown }> };
    expect(listBody.nodes[0]?.summary).toEqual({
      mode: 'wg',
      peers: 2,
      sites: { total: 3, disabled: 1 },
      forwards: 1,
    });

    const detail = await ctx.app.request(`/api/v1/nodes/${id}`, { headers }, ctx.env);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { node: { summary: unknown } };
    expect(detailBody.node.summary).toEqual(listBody.nodes[0]?.summary);

    // 摘要只读 D1：整个过程不调用 Agent
    expect(ctx.agent.requests).toHaveLength(0);
  });

  it('纯 Caddy 模式 peers 为 null；无配置节点 summary 全 null；创建/修改响应不带 summary', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const { id: caddyId } = await createNode(ctx, cookie);
    const { id: bareId } = await createNode(ctx, cookie);
    await ctx.apps.put(caddyId, 'wireguard', {
      config: { enabled: false, peers: [{ name: '残留' }] },
      schemaVersion: 1,
      actor: 'admin',
    });

    const list = await ctx.app.request('/api/v1/nodes', { headers }, ctx.env);
    const body = (await list.json()) as { nodes: Array<{ id: string; summary: unknown }> };
    expect(body.nodes.find((n) => n.id === caddyId)?.summary).toEqual({
      mode: 'caddy',
      peers: null,
      sites: null,
      forwards: null,
    });
    expect(body.nodes.find((n) => n.id === bareId)?.summary).toEqual({
      mode: null,
      peers: null,
      sites: null,
      forwards: null,
    });

    const patched = await ctx.app.request(
      `/api/v1/nodes/${bareId}`,
      { method: 'PATCH', headers, body: JSON.stringify({ name: '改名' }) },
      ctx.env,
    );
    const patchedBody = (await patched.json()) as { node: Record<string, unknown> };
    expect(patchedBody.node.summary).toBeUndefined();
  });
});
