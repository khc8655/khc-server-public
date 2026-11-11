import { describe, expect, it } from 'vitest';
import { authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

const CERT_PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const KEY_PEM = '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n';

describe('C3：证书库与设置', () => {
  it('创建/列表/导出证书；列表不回显 PEM', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);

    const created = await ctx.app.request(
      '/api/v1/certs',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: 'blog',
          domains: ['blog.example.com'],
          issuer: 'manual',
          certPem: CERT_PEM,
          keyPem: KEY_PEM,
        }),
      },
      ctx.env,
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      certificate: { id: string; domains: string[] };
    };
    expect(createdBody.certificate.domains).toEqual(['blog.example.com']);
    expect(JSON.stringify(createdBody)).not.toContain('BEGIN CERTIFICATE');

    const list = await ctx.app.request('/api/v1/certs', { headers: authHeaders(cookie) }, ctx.env);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { certificates: unknown[] };
    expect(listBody.certificates).toHaveLength(1);
    expect(JSON.stringify(listBody)).not.toContain('BEGIN CERTIFICATE');

    const material = await ctx.app.request(
      `/api/v1/certs/${createdBody.certificate.id}/material`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(material.status).toBe(200);
    const materialBody = (await material.json()) as { certPem: string; keyPem: string };
    expect(materialBody.certPem).toBe(CERT_PEM);
    expect(materialBody.keyPem).toBe(KEY_PEM);
  });

  it('拒绝非 PEM 内容', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/certs',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: 'bad',
          domains: ['bad.example.com'],
          certPem: 'not a cert',
          keyPem: 'not a key',
        }),
      },
      ctx.env,
    );
    expect(res.status).toBe(400);
  });

  it('设置在列表中只回显键，不回显值', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const put = await ctx.app.request(
      '/api/v1/settings/dns.cloudflare',
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({ value: { token: 'super-secret-token' } }),
      },
      ctx.env,
    );
    expect(put.status).toBe(200);
    const list = await ctx.app.request(
      '/api/v1/settings',
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    const body = (await list.json()) as { settings: Array<{ key: string; value?: unknown }> };
    expect(body.settings.map((s) => s.key)).toContain('dns.cloudflare');
    expect(JSON.stringify(body)).not.toContain('super-secret-token');
  });

  it('转发前把 $cert / $dnsCred 解析成密钥材料', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    const created = await ctx.app.request(
      '/api/v1/certs',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: 'site',
          domains: ['site.example.com'],
          certPem: CERT_PEM,
          keyPem: KEY_PEM,
        }),
      },
      ctx.env,
    );
    const certId = ((await created.json()) as { certificate: { id: string } }).certificate.id;
    await ctx.app.request(
      '/api/v1/settings/dns.cf',
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({ value: { token: 'cf-token' } }),
      },
      ctx.env,
    );
    await ctx.app.request(
      `/api/v1/nodes/${id}/apps/caddy-site`,
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          config: {
            sites: [{ domain: 'site.example.com', tls: { mode: 'manual', cert: { $cert: certId } } }],
          },
        }),
      },
      ctx.env,
    );

    ctx.agent.handler = async () => ({ status: 200, body: { ok: true, changes: [] } });
    const plan = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/caddy-site/plan`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ params: { cred: { $dnsCred: 'dns.cf' } } }),
      },
      ctx.env,
    );
    expect(plan.status).toBe(200);
    const call = ctx.agent.requests.at(-1);
    const payload = call?.body as {
      config: { sites: Array<{ tls: { cert: { certPem: string; keyPem: string } } }> };
      params: { cred: { token: string } };
    };
    expect(payload.config.sites[0]?.tls.cert.certPem).toBe(CERT_PEM);
    expect(payload.config.sites[0]?.tls.cert.keyPem).toBe(KEY_PEM);
    expect(payload.params.cred.token).toBe('cf-token');
  });

  it('引用不存在的证书时 400 且不调用 Agent', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    await ctx.app.request(
      `/api/v1/nodes/${id}/apps/caddy-site`,
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          config: { sites: [{ domain: 'x.test', tls: { cert: { $cert: 'cert_missing' } } }] },
        }),
      },
      ctx.env,
    );
    const before = ctx.agent.requests.length;
    const res = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/caddy-site/plan`,
      { method: 'POST', headers: authHeaders(cookie), body: '{}' },
      ctx.env,
    );
    expect(res.status).toBe(400);
    expect(ctx.agent.requests.length).toBe(before);
  });
});

describe('PR2：ACME 证书续期与安装到节点', () => {
  it('创建时记录 ACME 参数并标记 renewable', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    const created = await ctx.app.request(
      '/api/v1/certs',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: 'acme-cert',
          domains: ['acme.example.com'],
          issuer: 'acme',
          certPem: CERT_PEM,
          keyPem: KEY_PEM,
          sourceNodeId: id,
          acme: { provider: 'cloudflare', credentialKey: 'dns.cf', keyType: 'ec' },
        }),
      },
      ctx.env,
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      certificate: {
        renewable: boolean;
        acmeProvider: string | null;
        acmeCredentialKey: string | null;
        acmeKeyType: string | null;
      };
    };
    expect(body.certificate.renewable).toBe(true);
    expect(body.certificate.acmeProvider).toBe('cloudflare');
    expect(body.certificate.acmeCredentialKey).toBe('dns.cf');
    expect(body.certificate.acmeKeyType).toBe('ec');
  });

  it('PUT /certs/:id 用续期材料替换同一条记录', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const created = await ctx.app.request(
      '/api/v1/certs',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: 'renew-me',
          domains: ['renew.example.com'],
          issuer: 'acme',
          certPem: CERT_PEM,
          keyPem: KEY_PEM,
        }),
      },
      ctx.env,
    );
    const certId = ((await created.json()) as { certificate: { id: string } }).certificate.id;
    const newCert = '-----BEGIN CERTIFICATE-----\nNEWCERT\n-----END CERTIFICATE-----\n';
    const newKey = '-----BEGIN EC PRIVATE KEY-----\nNEWKEY\n-----END EC PRIVATE KEY-----\n';
    const updated = await ctx.app.request(
      `/api/v1/certs/${certId}`,
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({ certPem: newCert, keyPem: newKey, notAfter: 1_900_000_000 }),
      },
      ctx.env,
    );
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as {
      certificate: { id: string; notAfter: number; domains: string[] };
    };
    expect(updatedBody.certificate.id).toBe(certId);
    expect(updatedBody.certificate.notAfter).toBe(1_900_000_000);
    expect(updatedBody.certificate.domains).toEqual(['renew.example.com']);

    const material = await ctx.app.request(
      `/api/v1/certs/${certId}/material`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    const materialBody = (await material.json()) as { certPem: string; keyPem: string };
    expect(materialBody.certPem).toBe(newCert);
    expect(materialBody.keyPem).toBe(newKey);
  });

  it('POST /certs/:id/bind 把 PEM 安装到节点并返回热重载结果', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    const created = await ctx.app.request(
      '/api/v1/certs',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: 'bind-me',
          domains: ['bind.example.com'],
          issuer: 'acme',
          certPem: CERT_PEM,
          keyPem: KEY_PEM,
        }),
      },
      ctx.env,
    );
    const certId = ((await created.json()) as { certificate: { id: string } }).certificate.id;
    ctx.agent.handler = async () => ({
      status: 200,
      body: {
        ok: true,
        result: {
          certPath: '/etc/khc-agent/tls/fullchain.pem',
          keyPath: '/etc/khc-agent/tls/key.pem',
          notAfter: 1_900_000_000,
          reloaded: true,
          restartRequired: false,
        },
      },
    });
    const res = await ctx.app.request(
      `/api/v1/certs/${certId}/bind`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ nodeId: id }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodeId: string;
      reloaded: boolean;
      restartRequired: boolean;
      notAfter: number;
    };
    expect(body.nodeId).toBe(id);
    expect(body.reloaded).toBe(true);
    expect(body.restartRequired).toBe(false);
    expect(body.notAfter).toBe(1_900_000_000);
    const call = ctx.agent.requests.at(-1);
    expect(call?.path).toBe('/apps/certificates/install_tls');
    const payload = call?.body as { params: { certPem: string; keyPem: string } };
    expect(payload.params.certPem).toBe(CERT_PEM);
    expect(payload.params.keyPem).toBe(KEY_PEM);
  });

  it('明文直连节点拒绝下发私钥', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const node = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: 'plain',
          endpoint: 'http://1.2.3.4:8880',
          allowInsecure: true,
        }),
      },
      ctx.env,
    );
    expect(node.status).toBe(201);
    const nodeId = ((await node.json()) as { node: { id: string } }).node.id;
    const created = await ctx.app.request(
      '/api/v1/certs',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: 'plain-bind',
          domains: ['plain.example.com'],
          certPem: CERT_PEM,
          keyPem: KEY_PEM,
        }),
      },
      ctx.env,
    );
    const certId = ((await created.json()) as { certificate: { id: string } }).certificate.id;
    ctx.env.ENVIRONMENT = 'production';
    const before = ctx.agent.requests.length;
    const res = await ctx.app.request(
      `/api/v1/certs/${certId}/bind`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ nodeId }),
      },
      ctx.env,
    );
    expect(res.status).toBe(400);
    expect(ctx.agent.requests.length).toBe(before);
  });
});


describe('C3：私钥脱敏', () => {
  it('plan diff 不返回私钥 PEM', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    await ctx.app.request(
      `/api/v1/nodes/${id}/apps/caddy-site`,
      { method: 'PUT', headers: authHeaders(cookie), body: JSON.stringify({ config: { sites: [] } }) },
      ctx.env,
    );
    ctx.agent.handler = async () => ({
      status: 200,
      body: {
        ok: true,
        changes: [
          {
            path: '/etc/caddy/khc-certs/site.test.key',
            diff: '+++ site.test.key\n+-----BEGIN PRIVATE KEY-----\n+MIIE\n+-----END PRIVATE KEY-----',
          },
        ],
      },
    });
    const res = await ctx.app.request(
      `/api/v1/nodes/${id}/apps/caddy-site/plan`,
      { method: 'POST', headers: authHeaders(cookie), body: '{}' },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changes: Array<{ diff: string }> };
    expect(body.changes[0]?.diff).not.toContain('BEGIN PRIVATE KEY');
    expect(body.changes[0]?.diff).toContain('已隐藏私钥');
  });
});
