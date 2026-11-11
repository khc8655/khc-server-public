import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CfFetch, CfFetchResult } from '../src/lib/cf-dns';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

/**
 * CF DNS 集成（#E1 / 第 5 步）：全部走注入的 mock fetch，不触达真实 CF API。
 * 覆盖：配置与 Token 不回显、测试连接（成功/Token 无效/权限不足/Zone 不存在/网络失败）、
 * 代建 A/AAAA（成功/幂等/冲突/域名 endpoint/未启用）、登记失败回滚、联动删除（成功/
 * CF 失败保留清单/幂等/无凭据提示）。
 */

const TOKEN = 'cf-api-token-0123456789abcdef';
const ZONE = 'example.com';
const ZONE_ID = 'zone-123';

interface MockState {
  verify?: { status: number; body: unknown };
  zone?: { status: number; body: unknown };
  create?: { status: number; body: unknown };
  list?: { status: number; body: unknown };
  update?: { status: number; body: unknown };
  delete?: { status: number; body: unknown };
  networkFail?: boolean;
  createdRecords: Array<Record<string, unknown>>;
  updatedRecords: Array<Record<string, unknown>>;
  deletedRecords: string[];
}

function defaultState(): MockState {
  return {
    verify: { status: 200, body: { success: true, result: { status: 'active' } } },
    zone: {
      status: 200,
      body: { success: true, result: [{ id: ZONE_ID, name: ZONE, status: 'active' }] },
    },
    create: { status: 200, body: { success: true, result: { id: 'rec-1' } } },
    list: {
      status: 200,
      body: {
        success: true,
        result: [
          { id: 'rec-a', type: 'A', name: `hub.${ZONE}`, content: '198.51.100.10', proxied: false, comment: 'khc-server managed' },
          { id: 'rec-aaaa', type: 'AAAA', name: `v6.${ZONE}`, content: '2001:db8::1', proxied: false, comment: null },
          { id: 'rec-cname', type: 'CNAME', name: `alias.${ZONE}`, content: `hub.${ZONE}`, proxied: false, comment: null },
          { id: 'rec-txt', type: 'TXT', name: ZONE, content: 'v=spf1 -all', proxied: false, comment: null },
        ],
        result_info: { page: 1, total_pages: 1 },
      },
    },
    update: {
      status: 200,
      body: {
        success: true,
        result: {
          id: 'rec-a',
          type: 'A',
          name: `hub.${ZONE}`,
          content: '198.51.100.11',
          proxied: false,
          comment: 'khc-server managed',
        },
      },
    },
    delete: { status: 200, body: { success: true, result: { id: 'rec-1' } } },
    createdRecords: [],
    updatedRecords: [],
    deletedRecords: [],
  };
}

let state: MockState = defaultState();

// 共享 ctx 与登录（避免触发登录限流 429）；每用例只重置 mock state。
const ctx = makeTestContext(
  cfMockRef(() => state),
);
let cookie: string;
beforeAll(async () => {
  cookie = await loginAsAdmin(ctx);
});
beforeEach(async () => {
  state = defaultState();
  // 共享 settings：清掉上一用例留下的单 Zone 与多凭据配置，保证"未配置"场景干净。
  await ctx.settings.remove('cf_dns');
  await ctx.settings.remove('cf_dns_accounts');
});

function cfMockRef(getState: () => MockState): CfFetch {
  return async (url: string, init: RequestInit): Promise<CfFetchResult> => {
    const state = getState();
    if (state.networkFail) throw new TypeError('network down');
    if (url.includes('/user/tokens/verify')) {
      return { status: state.verify!.status, body: state.verify!.body as never };
    }
    if (url.startsWith('https://api.cloudflare.com/client/v4/zones?')) {
      return { status: state.zone!.status, body: state.zone!.body as never };
    }
    if (url.includes('/dns_records') && init.method === 'GET') {
      return { status: state.list!.status, body: state.list!.body as never };
    }
    if (url.includes('/dns_records') && init.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      state.createdRecords.push({ ...body, url });
      return { status: state.create!.status, body: state.create!.body as never };
    }
    if (url.includes('/dns_records') && init.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      state.updatedRecords.push({ ...body, url });
      return { status: state.update!.status, body: state.update!.body as never };
    }
    const match = /\/dns_records\/([^/?]+)/.exec(url);
    if (match && init.method === 'DELETE') {
      state.deletedRecords.push(match[1] ?? '');
      return { status: state.delete!.status, body: state.delete!.body as never };
    }
    return { status: 500, body: { success: false, errors: [{ message: 'unexpected url' }] } };
  };
}

async function enableCfDns(
  ctx: ReturnType<typeof makeTestContext>,
  cookie: string,
  token = TOKEN,
): Promise<void> {
  const res = await ctx.app.request(
    '/api/v1/cf-dns',
    {
      method: 'PUT',
      headers: authHeaders(cookie),
      body: JSON.stringify({ enabled: true, zoneName: ZONE, token }),
    },
    ctx.env,
  );
  expect(res.status).toBe(200);
}

async function createIpNode(
  ctx: ReturnType<typeof makeTestContext>,
  cookie: string,
  name: string,
  endpoint: string,
): Promise<string> {
  const res = await ctx.app.request(
    '/api/v1/nodes',
    {
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify({ name, endpoint }),
    },
    ctx.env,
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { node: { id: string } };
  return body.node.id;
}

async function createRecordFor(
  ctx: ReturnType<typeof makeTestContext>,
  cookie: string,
  nodeId: string,
): Promise<Response> {
  return ctx.app.request(
    '/api/v1/cf-dns/records',
    {
      method: 'POST',
      headers: authHeaders(cookie),
      body: JSON.stringify({ nodeId }),
    },
    ctx.env,
  );
}

describe('CF DNS 集成：配置与测试连接', () => {
  it('保存配置后状态只报告是否已配置，任何响应都不回显 Token', async () => {

    const before = await ctx.app.request('/api/v1/cf-dns', { headers: authHeaders(cookie) }, ctx.env);
    expect(before.status).toBe(200);
    expect(((await before.json()) as Record<string, unknown>).enabled).toBe(false);

    await enableCfDns(ctx, cookie);

    const status = await ctx.app.request('/api/v1/cf-dns', { headers: authHeaders(cookie) }, ctx.env);
    const body = (await status.json()) as Record<string, unknown>;
    expect(body).toEqual({ enabled: true, configured: true, hasToken: true, zoneName: ZONE });
    expect(JSON.stringify(body)).not.toContain(TOKEN);

    // settings 列表也不泄漏
    const settings = await ctx.app.request('/api/v1/settings', { headers: authHeaders(cookie) }, ctx.env);
    expect(JSON.stringify(await settings.json())).not.toContain(TOKEN);

    // Token 只写不读：D1 层存储为密文（Memory repo 同样经 encryptSecret 包装）
    const stored = await ctx.settings.getValue('cf_dns');
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
  });

  it('未配置前测试连接返回明确错误，启用前缺 Token/Zone 拒绝保存', async () => {

    const test = await ctx.app.request(
      '/api/v1/cf-dns/test',
      { method: 'POST', headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(test.status).toBe(409);
    expect(((await test.json()) as { error: { code: string } }).error.code).toBe('cf_dns_not_configured');

    const bad = await ctx.app.request(
      '/api/v1/cf-dns',
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({ enabled: true, zoneName: null }),
      },
      ctx.env,
    );
    expect(bad.status).toBe(400);
  });

  it('测试连接成功返回 Zone 信息', async () => {
    await enableCfDns(ctx, cookie);

    const res = await ctx.app.request(
      '/api/v1/cf-dns/test',
      { method: 'POST', headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { zone: { id: string; name: string } };
    expect(body.zone.id).toBe(ZONE_ID);
    expect(body.zone.name).toBe(ZONE);
  });

  it('Token 无效 → cf_dns_auth；权限不足 → cf_dns_permission（提示所需权限）；Zone 不存在 → cf_dns_zone；网络失败 → cf_dns_network', async () => {
    const cases: Array<{
      name: string;
      state: MockState;
      code: string;
    }> = [
      {
        name: 'token 无效（9109）',
        state: {
          ...defaultState(),
          verify: { status: 401, body: { success: false, errors: [{ code: 9109, message: 'Invalid access token' }] } },
        },
        code: 'cf_dns_auth',
      },
      {
        name: '权限不足（403）',
        state: {
          ...defaultState(),
          zone: { status: 403, body: { success: false, errors: [{ message: 'You do not have permission' }] } },
          verify: undefined,
        },
        code: 'cf_dns_permission',
      },
      {
        name: 'Zone 不存在',
        state: { ...defaultState(), zone: { status: 200, body: { success: true, result: [] } } },
        code: 'cf_dns_zone',
      },
      { name: '网络失败', state: { ...defaultState(), networkFail: true }, code: 'cf_dns_network' },
    ];
    for (const item of cases) {
      state = { ...item.state, verify: item.state.verify ?? defaultState().verify };
      await enableCfDns(ctx, cookie);
      const res = await ctx.app.request(
        '/api/v1/cf-dns/test',
        { method: 'POST', headers: authHeaders(cookie) },
        ctx.env,
      );
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code, item.name).toBe(item.code);
      if (item.code === 'cf_dns_permission') {
        expect(body.error.message).toContain('Zone→DNS→Read');
      }
    }
  });
});

describe('CF DNS 集成：代建与联动删除', () => {
  it('IPv4 endpoint 代建 A 记录，重复调用幂等', async () => {
    await enableCfDns(ctx, cookie);
    const nodeId = await createIpNode(ctx, cookie, 'aws-1', 'https://203.0.113.10:8880');

    const res = await createRecordFor(ctx, cookie, nodeId);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      created: boolean;
      record: { type: string; name: string; content: string };
    };
    expect(body.created).toBe(true);
    expect(body.record).toEqual({ id: 'rec-1', type: 'A', name: 'aws-1.example.com', content: '203.0.113.10' });
    expect(state.createdRecords).toHaveLength(1);
    expect(state.createdRecords[0]?.comment).toBe('khc-server managed');

    // 幂等重入：不再创建
    const again = await createRecordFor(ctx, cookie, nodeId);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { created: boolean }).created).toBe(false);
    expect(state.createdRecords).toHaveLength(1);
  });

  it('IPv6 endpoint 代建 AAAA 记录', async () => {
    await enableCfDns(ctx, cookie);
    const nodeId = await createIpNode(ctx, cookie, 'v6', 'https://[2001:db8::1]:8880');

    const res = await createRecordFor(ctx, cookie, nodeId);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { record: { type: string; content: string } };
    expect(body.record.type).toBe('AAAA');
    expect(body.record.content).toBe('2001:db8::1');
  });

  it('未启用时代建返回 cf_dns_disabled，不影响节点本身', async () => {
    const nodeId = await createIpNode(ctx, cookie, 'aws-2', 'https://1.2.3.4:8880');

    const res = await createRecordFor(ctx, cookie, nodeId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('cf_dns_disabled');
    // 节点仍存在
    const node = await ctx.app.request(`/api/v1/nodes/${nodeId}`, { headers: authHeaders(cookie) }, ctx.env);
    expect(node.status).toBe(200);
  });

  it('域名 endpoint 无法推断记录值时给出可操作提示', async () => {
    await enableCfDns(ctx, cookie);
    const nodeId = await createIpNode(ctx, cookie, 'dom', 'https://hub.example.com:8880');

    const res = await createRecordFor(ctx, cookie, nodeId);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('手工建记录');
  });

  it('同名记录已存在（81057）→ cf_dns_conflict，不覆盖用户记录', async () => {
    state = {
      ...defaultState(),
      create: {
        status: 400,
        body: { success: false, errors: [{ code: 81057, message: 'record already exists' }] },
      },
    };
    await enableCfDns(ctx, cookie);
    const nodeId = await createIpNode(ctx, cookie, 'aws-3', 'https://9.9.9.9:8880');

    const res = await createRecordFor(ctx, cookie, nodeId);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('cf_dns_conflict');
  });

  it('联动删除：成功后清理托管清单，重复删除幂等', async () => {
    await enableCfDns(ctx, cookie);
    const nodeId = await createIpNode(ctx, cookie, 'aws-4', 'https://8.8.8.8:8880');
    await createRecordFor(ctx, cookie, nodeId);

    const del = await ctx.app.request(
      `/api/v1/cf-dns/records/${nodeId}`,
      { method: 'DELETE', headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(del.status).toBe(200);
    expect(((await del.json()) as { deleted: boolean }).deleted).toBe(true);
    expect(state.deletedRecords).toEqual(['rec-1']);
    expect(await ctx.settings.getValue(`cf_dns_node_${nodeId}`)).toBeNull();

    const again = await ctx.app.request(
      `/api/v1/cf-dns/records/${nodeId}`,
      { method: 'DELETE', headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(((await again.json()) as { deleted: boolean }).deleted).toBe(true);
    expect(state.deletedRecords).toHaveLength(1);
  });

  it('联动删除 CF 失败：错误清单回显且保留托管清单（下次可重试）', async () => {
    state = {
      ...defaultState(),
      delete: { status: 403, body: { success: false, errors: [{ message: 'insufficient permissions' }] } },
    };
    await enableCfDns(ctx, cookie);
    const nodeId = await createIpNode(ctx, cookie, 'aws-5', 'https://7.7.7.7:8880');
    await createRecordFor(ctx, cookie, nodeId);

    const del = await ctx.app.request(
      `/api/v1/cf-dns/records/${nodeId}`,
      { method: 'DELETE', headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(del.status).toBe(200);
    const body = (await del.json()) as { deleted: boolean; errors: string[] };
    expect(body.deleted).toBe(false);
    expect(body.errors.join()).toContain('aws-5.example.com');
    expect(await ctx.settings.getValue(`cf_dns_node_${nodeId}`)).not.toBeNull();
  });

  it('面板已无凭据时联动删除不抛错，提示手工删除', async () => {
    await enableCfDns(ctx, cookie);
    const nodeId = await createIpNode(ctx, cookie, 'aws-6', 'https://6.6.6.6:8880');
    await createRecordFor(ctx, cookie, nodeId);

    // 模拟凭据被清空（PUT 空配置）
    await ctx.settings.remove('cf_dns');
    const del = await ctx.app.request(
      `/api/v1/cf-dns/records/${nodeId}`,
      { method: 'DELETE', headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(del.status).toBe(200);
    const body = (await del.json()) as { deleted: boolean; errors: string[] };
    expect(body.deleted).toBe(false);
    expect(body.errors.join()).toContain('手工删除');
  });

  it('未鉴权请求一律 401', async () => {
    const res = await ctx.app.request('/api/v1/cf-dns', {}, ctx.env);
    expect(res.status).toBe(401);
  });
});

describe('CF DNS 多凭据', () => {
  async function addAccount(name: string): Promise<{ id: string; name: string }> {
    const res = await ctx.app.request(
      '/api/v1/cf-dns/accounts',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ name, token: TOKEN }),
      },
      ctx.env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { account: { id: string; name: string } };
    return body.account;
  }

  it('新增凭据拉取全部 Zone 并默认全选，响应永不回显 Token', async () => {
    const account = await addAccount('主账号');
    expect(account.name).toBe('主账号');

    const list = await ctx.app.request(
      '/api/v1/cf-dns/accounts',
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      accounts: Array<{ zones: unknown[]; enabledZoneIds: string[]; hasToken: boolean }>;
    };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]?.hasToken).toBe(true);
    expect(body.accounts[0]?.zones).toEqual([{ id: ZONE_ID, name: ZONE }]);
    expect(body.accounts[0]?.enabledZoneIds).toEqual([ZONE_ID]);
    expect(JSON.stringify(body)).not.toContain(TOKEN);

    // 落库只存密文
    const stored = await ctx.settings.getValue('cf_dns_accounts');
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
  });

  it('可勾选 Zone 子集；不属于该凭据的 Zone 拒绝', async () => {
    state = {
      ...defaultState(),
      zone: {
        status: 200,
        body: {
          success: true,
          result: [
            { id: 'z-a', name: 'a.example.com', status: 'active' },
            { id: 'z-b', name: 'b.example.com', status: 'active' },
          ],
        },
      },
    };
    const account = await addAccount('双 Zone');

    const put = await ctx.app.request(
      `/api/v1/cf-dns/accounts/${account.id}`,
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({ enabledZoneIds: ['z-b'] }),
      },
      ctx.env,
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as { account: { enabledZoneIds: string[] } }).account.enabledZoneIds).toEqual([
      'z-b',
    ]);

    const bad = await ctx.app.request(
      `/api/v1/cf-dns/accounts/${account.id}`,
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({ enabledZoneIds: ['z-not-mine'] }),
      },
      ctx.env,
    );
    expect(bad.status).toBe(400);

    // /cf-dns/zones 只返回已勾选的 Zone（添加节点时的候选）
    const zones = await ctx.app.request('/api/v1/cf-dns/zones', { headers: authHeaders(cookie) }, ctx.env);
    const zoneBody = (await zones.json()) as { zones: Array<{ id: string; name: string; accountId: string }> };
    expect(zoneBody.zones).toEqual([
      { id: 'z-b', name: 'b.example.com', accountId: account.id, accountName: '双 Zone' },
    ]);
  });

  it('按所选 Zone + 子域名代建记录，并把域名写入节点', async () => {
    const account = await addAccount('主账号');
    const nodeId = await createIpNode(ctx, cookie, 'aws-1', 'https://203.0.113.10:8880');

    const res = await ctx.app.request(
      '/api/v1/cf-dns/records',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ nodeId, zoneId: ZONE_ID, subdomain: 'hub' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { created: boolean; domain: string; record: { name: string } };
    expect(body.domain).toBe(`hub.${ZONE}`);
    expect(body.record.name).toBe(`hub.${ZONE}`);
    expect(state.createdRecords[0]?.name).toBe(`hub.${ZONE}`);
    expect(state.createdRecords[0]?.comment).toBe('khc-server managed');

    const node = await ctx.app.request(`/api/v1/nodes/${nodeId}`, { headers: authHeaders(cookie) }, ctx.env);
    expect(((await node.json()) as { node: { domain: string | null } }).node.domain).toBe(`hub.${ZONE}`);
    // 托管清单记录所属凭据与 Zone，供联动删除用
    const managed = await ctx.settings.getValue(`cf_dns_node_${nodeId}`);
    expect(JSON.stringify(managed)).toContain(account.id);
    expect(JSON.stringify(managed)).toContain(ZONE_ID);
  });

  it('多凭据下只有一个启用 Zone 时，不带 zoneId 也能按节点名代建', async () => {
    await addAccount('主账号');
    const nodeId = await createIpNode(ctx, cookie, 'aws-auto', 'https://203.0.113.10:8880');

    const res = await createRecordFor(ctx, cookie, nodeId);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { domain: string; record: { name: string } };
    expect(body.domain).toBe(`aws-auto.${ZONE}`);
    expect(state.createdRecords).toHaveLength(1);
  });

  it('多个启用 Zone 且未选择时返回 cf_dns_zone_required，不猜 Zone', async () => {
    state = {
      ...defaultState(),
      zone: {
        status: 200,
        body: {
          success: true,
          result: [
            { id: 'z-a', name: 'a.example.com', status: 'active' },
            { id: 'z-b', name: 'b.example.com', status: 'active' },
          ],
        },
      },
    };
    await addAccount('双 Zone');
    const nodeId = await createIpNode(ctx, cookie, 'aws-ambiguous', 'https://203.0.113.10:8880');

    const res = await createRecordFor(ctx, cookie, nodeId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('cf_dns_zone_required');
    expect(body.error.message).toContain('a.example.com');
    expect(state.createdRecords).toHaveLength(0);
  });

  it('所有凭据都停用时返回 cf_dns_disabled', async () => {
    const account = await addAccount('停用账号');
    await ctx.app.request(
      `/api/v1/cf-dns/accounts/${account.id}`,
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({ enabled: false }),
      },
      ctx.env,
    );
    const nodeId = await createIpNode(ctx, cookie, 'aws-disabled', 'https://203.0.113.10:8880');

    const res = await createRecordFor(ctx, cookie, nodeId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('cf_dns_disabled');
    expect(state.createdRecords).toHaveLength(0);
  });

  it('Token 无效 / 无可用 Zone 时新增凭据返回 400', async () => {
    state = {
      ...defaultState(),
      zone: { status: 401, body: { success: false, errors: [{ code: 9109, message: 'Invalid token' }] } },
    };
    const bad = await ctx.app.request(
      '/api/v1/cf-dns/accounts',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ name: '坏凭据', token: TOKEN }),
      },
      ctx.env,
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('cf_dns_token_invalid');

    state = { ...defaultState(), zone: { status: 200, body: { success: true, result: [] } } };
    const empty = await ctx.app.request(
      '/api/v1/cf-dns/accounts',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ name: '空凭据', token: TOKEN }),
      },
      ctx.env,
    );
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: { code: string } }).error.code).toBe('cf_dns_no_zones');
  });

  it('旧单 Zone 配置在新增凭据时迁移，不保留双份真相', async () => {
    await enableCfDns(ctx, cookie);
    const account = await addAccount('新账号');

    const list = await ctx.app.request(
      '/api/v1/cf-dns/accounts',
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    const accounts = ((await list.json()) as { accounts: Array<{ id: string }> }).accounts;
    expect(accounts.map((item) => item.id)).toEqual(['legacy', account.id]);
    expect(await ctx.settings.getValue('cf_dns')).toBeNull();
  });

  it('删除凭据只清面板配置，返回剩余列表', async () => {
    const account = await addAccount('待删除');
    const del = await ctx.app.request(
      `/api/v1/cf-dns/accounts/${account.id}`,
      { method: 'DELETE', headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(del.status).toBe(200);
    expect(((await del.json()) as { accounts: unknown[] }).accounts).toEqual([]);
    expect(await ctx.settings.getValue('cf_dns_accounts')).toBeNull();
  });
});

describe('CF DNS 集成：读取已有解析记录（只读）', () => {
  it('只返回 A/AAAA/CNAME，comment 命中标记的 managed=true，响应不含 Token', async () => {
    await enableCfDns(ctx, cookie);
    const res = await ctx.app.request(
      `/api/v1/cf-dns/records?zoneId=${ZONE_ID}`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      zoneId: string;
      zoneName: string;
      records: Array<{ id: string; type: string; name: string; managed: boolean }>;
    };
    expect(body.zoneId).toBe(ZONE_ID);
    expect(body.zoneName).toBe(ZONE);
    expect(body.records.map((item) => item.type)).toEqual(['A', 'AAAA', 'CNAME']);
    expect(body.records.find((item) => item.id === 'rec-a')?.managed).toBe(true);
    expect(body.records.find((item) => item.id === 'rec-aaaa')?.managed).toBe(false);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toContain('rec-txt');
    // 只读路径不产生任何写调用
    expect(state.createdRecords).toHaveLength(0);
    expect(state.deletedRecords).toHaveLength(0);
  });

  it('读取失败 403 → cf_dns_permission，文案区分读取权限', async () => {
    state = {
      ...defaultState(),
      list: {
        status: 403,
        body: { success: false, errors: [{ message: 'Authentication error' }] },
      },
    };
    await enableCfDns(ctx, cookie);
    const res = await ctx.app.request(
      `/api/v1/cf-dns/records?zoneId=${ZONE_ID}`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('cf_dns_permission');
    expect(body.error.message).toContain('Zone→DNS→Read');
  });

  it('未启用的 Zone → 409 cf_dns_zone_unavailable', async () => {
    await enableCfDns(ctx, cookie);
    const res = await ctx.app.request(
      '/api/v1/cf-dns/records?zoneId=not-mine',
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'cf_dns_zone_unavailable',
    );
  });

  it('缺 zoneId → 400；未鉴权 → 401', async () => {
    await enableCfDns(ctx, cookie);
    const bad = await ctx.app.request(
      '/api/v1/cf-dns/records',
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(bad.status).toBe(400);
    const unauth = await ctx.app.request(`/api/v1/cf-dns/records?zoneId=${ZONE_ID}`, {}, ctx.env);
    expect(unauth.status).toBe(401);
  });

  it('创建节点时可携带已有记录域名（不建 DNS 记录）', async () => {
    const res = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: 'manual-dns',
          endpoint: 'http://198.51.100.10:8880',
          domain: `hub.${ZONE}`,
        }),
      },
      ctx.env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { node: { domain: string | null } };
    expect(body.node.domain).toBe(`hub.${ZONE}`);
    expect(state.createdRecords).toHaveLength(0);
  });
});

describe('全局域名管理：单条记录改 / 删', () => {
  it('PATCH 只提交显式字段，并把 managed 标记带回', async () => {
    await enableCfDns(ctx, cookie);
    const res = await ctx.app.request(
      `/api/v1/cf-dns/records/${ZONE_ID}/rec-a`,
      {
        method: 'PATCH',
        headers: authHeaders(cookie),
        body: JSON.stringify({ content: '198.51.100.11' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      record: { id: string; content: string; managed: boolean };
    };
    expect(body.record.id).toBe('rec-a');
    expect(body.record.content).toBe('198.51.100.11');
    expect(body.record.managed).toBe(true);
    expect(state.updatedRecords).toHaveLength(1);
    expect(state.updatedRecords[0]).toMatchObject({ content: '198.51.100.11' });
    expect(state.updatedRecords[0]?.name).toBeUndefined();
  });

  it('PATCH 跨 Zone 的记录名被拒', async () => {
    await enableCfDns(ctx, cookie);
    const res = await ctx.app.request(
      `/api/v1/cf-dns/records/${ZONE_ID}/rec-a`,
      {
        method: 'PATCH',
        headers: authHeaders(cookie),
        body: JSON.stringify({ name: 'evil.other-zone.com' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(400);
    expect(state.updatedRecords).toHaveLength(0);
  });

  it('DELETE 单条记录成功（不依赖节点）', async () => {
    await enableCfDns(ctx, cookie);
    const res = await ctx.app.request(
      `/api/v1/cf-dns/records/${ZONE_ID}/rec-a`,
      { method: 'DELETE', headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    expect(state.deletedRecords).toEqual(['rec-a']);
  });

  it('POST 在指定 Zone 下新增记录（不带面板托管标记）', async () => {
    await enableCfDns(ctx, cookie);
    const res = await ctx.app.request(
      `/api/v1/cf-dns/records/${ZONE_ID}`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ type: 'A', name: `app.${ZONE}`, content: '198.51.100.20' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      record: { id: string; type: string; name: string; content: string; proxied: boolean; managed: boolean };
    };
    expect(body.record).toMatchObject({
      id: 'rec-1',
      type: 'A',
      name: `app.${ZONE}`,
      content: '198.51.100.20',
      proxied: false,
      managed: false,
    });
    expect(state.createdRecords).toHaveLength(1);
    expect(state.createdRecords[0]).toMatchObject({
      type: 'A',
      name: `app.${ZONE}`,
      content: '198.51.100.20',
      proxied: false,
      ttl: 1,
    });
    // 手工新增不写 khc-server managed 注释，避免被误认为面板代建。
    expect(state.createdRecords[0]?.comment).toBeUndefined();
  });

  it('POST 记录名不属于该 Zone 时拒绝', async () => {
    await enableCfDns(ctx, cookie);
    const res = await ctx.app.request(
      `/api/v1/cf-dns/records/${ZONE_ID}`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ type: 'A', name: 'evil.other-zone.com', content: '198.51.100.20' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(400);
    expect(state.createdRecords).toHaveLength(0);
  });
});
