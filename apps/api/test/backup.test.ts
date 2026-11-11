import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

beforeEach(() => resetRateLimitForTests());

describe('C4 备份/恢复（export/import）', () => {
  it('导出节点公开信息 + 应用配置，不含 token；导入生成新 rev 且不自动 apply', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const { id: nodeId, token } = await createNode(ctx, cookie);

    await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/wireguard`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          config: {
            interface: { address: '10.9.0.1/24', privateKey: 'interface-private-value' },
            peers: [{ name: 'phone', publicKey: 'peer-public', privateKey: 'peer-private-value' }],
          },
          schemaVersion: 1,
        }),
      },
      ctx.env,
    );

    const exported = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/export`,
      { headers },
      ctx.env,
    );
    expect(exported.status).toBe(200);
    const body = (await exported.json()) as {
      format: string;
      version: number;
      node: { id: string; name: string };
      apps: Array<{ app: string; config: Record<string, unknown> }>;
    };
    expect(body.format).toBe('khc-backup/v1');
    expect(body.version).toBe(1);
    expect(body.node.id).toBe(nodeId);
    expect(body.apps.map((item) => item.app)).toContain('wireguard');
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toContain('token');
    expect(JSON.stringify(body)).not.toContain('keyEnc');
    expect(JSON.stringify(body)).not.toContain('privateKey');
    expect(JSON.stringify(body)).not.toContain('interface-private-value');
    expect(JSON.stringify(body)).not.toContain('peer-private-value');

    const imported = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/import`,
      { method: 'POST', headers, body: JSON.stringify(body) },
      ctx.env,
    );
    expect(imported.status).toBe(200);
    const result = (await imported.json()) as {
      ok: boolean;
      apps: Array<{ app: string; rev: number }>;
    };
    expect(result.ok).toBe(true);
    expect(result.apps.find((item) => item.app === 'wireguard')?.rev).toBe(2);

    const app = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/wireguard`,
      { headers },
      ctx.env,
    );
    const appBody = (await app.json()) as {
      app: { rev: number; appliedRev: number | null; config: Record<string, unknown> };
    };
    expect(appBody.app.rev).toBe(2);
    expect(appBody.app.appliedRev).toBeNull();
  });

  it('basicauth 哈希默认剥离，导入时保留目标节点旧值', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const { id: nodeId } = await createNode(ctx, cookie);
    const hash = '$2b$12$abcdefghijklmnopqrstuv';

    await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/caddy-site`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          config: { sites: [{ name: 'blog', basicauth: { user: 'admin', passwordHash: hash } }] },
          schemaVersion: 1,
        }),
      },
      ctx.env,
    );

    const exported = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/export`,
      { headers },
      ctx.env,
    );
    expect(exported.status).toBe(200);
    const body = (await exported.json()) as {
      manifest?: { stripped: string[]; encKeyId: string };
      apps: Array<{ app: string; config: Record<string, unknown> }>;
    };
    expect(body.manifest?.encKeyId).toBe('k1');
    expect(body.manifest?.stripped).toContain('passwordhash');
    expect(JSON.stringify(body)).not.toContain(hash);
    const site = (body.apps.find((item) => item.app === 'caddy-site')?.config.sites as Array<
      Record<string, unknown>
    >)[0]!;
    expect((site.basicauth as Record<string, unknown>).user).toBe('admin');
    expect((site.basicauth as Record<string, unknown>).passwordHash).toBeUndefined();

    const imported = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/import`,
      { method: 'POST', headers, body: JSON.stringify(body) },
      ctx.env,
    );
    expect(imported.status).toBe(200);
    const stored = await ctx.apps.get(nodeId, 'caddy-site');
    const storedSite = (stored?.config.sites as Array<Record<string, unknown>>)[0]!;
    expect((storedSite.basicauth as Record<string, unknown>).passwordHash).toBe(hash);
  });

  it('导入到另一个节点：可复制全拓扑配置', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const source = await createNode(ctx, cookie);
    const target = await createNode(ctx, cookie);

    await ctx.app.request(
      `/api/v1/nodes/${source.id}/apps/caddy-site`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({ config: { sites: [] }, schemaVersion: 1 }),
      },
      ctx.env,
    );
    const exported = await ctx.app.request(
      `/api/v1/nodes/${source.id}/export`,
      { headers },
      ctx.env,
    );
    const body = await exported.json();

    const imported = await ctx.app.request(
      `/api/v1/nodes/${target.id}/import`,
      { method: 'POST', headers, body: JSON.stringify(body) },
      ctx.env,
    );
    expect(imported.status).toBe(200);
    const result = (await imported.json()) as { nodeId: string; apps: Array<{ app: string }> };
    expect(result.nodeId).toBe(target.id);
    expect(result.apps.map((item) => item.app)).toContain('caddy-site');
  });

  it('导入不会覆盖目标节点已有私钥/PSK', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const { id: nodeId } = await createNode(ctx, cookie);

    await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/wireguard`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          config: {
            interface: { address: '10.9.0.1/24', publicKey: 'interface-public', privateKey: 'keep-interface-key' },
            peers: [{ name: 'phone', publicKey: 'pub-1', privateKey: 'keep-peer-key' }],
          },
          schemaVersion: 1,
        }),
      },
      ctx.env,
    );

    const backup = {
      format: 'khc-backup/v1',
      version: 1,
      exportedAt: 1,
      node: {
        id: nodeId,
        name: 'n',
        endpoint: 'https://hub.example.com:8443',
        tunnelEndpoint: null,
        liveEndpoint: null,
        preferredRoute: 'direct',
      },
      apps: [
        {
          app: 'wireguard',
          schemaVersion: 1,
          config: {
            interface: { address: '10.9.0.1/24', publicKey: 'interface-public' },
            peers: [{ name: 'phone', publicKey: 'pub-1' }],
          },
        },
      ],
    };
    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/import`,
      { method: 'POST', headers, body: JSON.stringify(backup) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const stored = await ctx.apps.get(nodeId, 'wireguard');
    expect((stored?.config.interface as Record<string, unknown>).privateKey).toBe('keep-interface-key');
    expect(
      ((stored?.config.peers as Array<Record<string, unknown>>)[0] as Record<string, unknown>)
        .privateKey,
    ).toBe('keep-peer-key');
  });


  it('公钥不匹配/顺序打乱时绝不按下标错配私钥', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const { id: nodeId } = await createNode(ctx, cookie);

    await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/wireguard`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          config: {
            interface: { address: '10.9.0.1/24', publicKey: 'if-public', privateKey: 'if-private' },
            peers: [
              { name: 'a', publicKey: 'pub-a', privateKey: 'priv-a' },
              { name: 'b', publicKey: 'pub-b', privateKey: 'priv-b' },
            ],
          },
          schemaVersion: 1,
        }),
      },
      ctx.env,
    );

    const backup = {
      format: 'khc-backup/v1',
      version: 1,
      exportedAt: 1,
      node: { id: nodeId, name: 'n', endpoint: 'https://h.example.com:8443', tunnelEndpoint: null, liveEndpoint: null, preferredRoute: 'direct' },
      apps: [
        {
          app: 'wireguard',
          schemaVersion: 1,
          config: {
            interface: { address: '10.9.0.1/24', publicKey: 'different-if-public' },
            peers: [
              { name: 'b', publicKey: 'pub-b' },
              { name: 'a', publicKey: 'pub-a' },
              { name: 'new', publicKey: 'pub-new' },
            ],
          },
        },
      ],
    };
    const res = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/import`,
      { method: 'POST', headers, body: JSON.stringify(backup) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const stored = await ctx.apps.get(nodeId, 'wireguard');
    expect((stored?.config.interface as Record<string, unknown>).privateKey).toBeUndefined();
    const peers = (stored?.config.peers ?? []) as Array<Record<string, unknown>>;
    expect(peers.find((peer) => peer.name === 'a')?.privateKey).toBe('priv-a');
    expect(peers.find((peer) => peer.name === 'b')?.privateKey).toBe('priv-b');
    expect(peers.find((peer) => peer.name === 'new')?.privateKey).toBeUndefined();
  });

  it('非法/重复应用名 400', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const headers = authHeaders(cookie);
    const { id: nodeId } = await createNode(ctx, cookie);
    const base = {
      format: 'khc-backup/v1',
      version: 1,
      exportedAt: 1,
      node: {
        id: nodeId,
        name: '校验节点',
        endpoint: 'https://hub.example.com:8443',
        tunnelEndpoint: null,
        liveEndpoint: null,
        preferredRoute: 'direct',
      },
    };
    for (const apps of [
      [{ app: 'Bad Name!', schemaVersion: 1, config: {} }],
      [
        { app: 'wireguard', schemaVersion: 1, config: {} },
        { app: 'wireguard', schemaVersion: 1, config: {} },
      ],
    ]) {
      const res = await ctx.app.request(
        `/api/v1/nodes/${nodeId}/import`,
        { method: 'POST', headers, body: JSON.stringify({ ...base, apps }) },
        ctx.env,
      );
      expect(res.status).toBe(400);
    }
  });
});
