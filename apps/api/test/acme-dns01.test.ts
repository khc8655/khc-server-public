import { describe, expect, it } from 'vitest';
import {
  buildCsrDer,
  generateP256KeyPair,
  issueAcmeDns01,
  parseLeafCertNotAfter,
  type AcmeFetch,
} from '../src/lib/acme-dns01';
import { encryptSecret } from '../src/lib/crypto';
import type { CfFetch } from '../src/lib/cf-dns';
import { authHeaders, loginAsAdmin, makeTestContext } from './helpers/context';

function derTag(tag: number, content: Uint8Array): Uint8Array {
  const len = content.length;
  const header =
    len < 128
      ? new Uint8Array([tag, len])
      : new Uint8Array([tag, 0x81, len]);
  const out = new Uint8Array(header.length + content.length);
  out.set(header, 0);
  out.set(content, header.length);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function makeFakeCertPem(notAfterTag: 0x17 | 0x18, notAfterText: string): string {
  const enc = new TextEncoder();
  const version = derTag(0xa0, new Uint8Array([0x02, 0x01, 0x02]));
  const serial = new Uint8Array([0x02, 0x01, 0x01]);
  const sigAlg = derTag(0x30, new Uint8Array([0x06, 0x03, 0x55, 0x04, 0x03]));
  const name = derTag(0x30, new Uint8Array(0));
  const validity = derTag(
    0x30,
    concatBytes(
      derTag(0x17, enc.encode('261121000000Z')),
      derTag(notAfterTag, enc.encode(notAfterText)),
    ),
  );
  const spki = derTag(0x30, new Uint8Array(0));
  const tbs = derTag(0x30, concatBytes(version, serial, sigAlg, name, validity, name, spki));
  const certDer = derTag(0x30, concatBytes(tbs, sigAlg, new Uint8Array([0x03, 0x02, 0x00, 0x00])));
  let binary = '';
  for (const byte of certDer) binary += String.fromCharCode(byte);
  return `-----BEGIN CERTIFICATE-----\n${btoa(binary)}\n-----END CERTIFICATE-----\n`;
}

function createMockAcmeAndCf(opts: {
  challengeInvalid?: boolean;
  badNonceOnce?: boolean;
  notAfterPem?: string;
}) {
  const txtRecords = new Map<string, { zoneId: string; name: string; content: string }>();
  const deletedRecords: string[] = [];
  let seq = 0;
  let nonceSeq = 0;
  let finalizeCsrB64 = '';
  let sentBadNonce = false;
  const triggeredChalls = new Set<string>();

  const cfFetch: CfFetch = async (url, init) => {
    const method = init.method ?? 'GET';
    if (url.includes('/dns_records') && method === 'POST') {
      const payload = JSON.parse(String(init.body)) as { type: string; name: string; content: string };
      const zoneId = url.split('/zones/')[1]!.split('/')[0]!;
      const id = `txt_${++seq}`;
      txtRecords.set(id, { zoneId, name: payload.name, content: payload.content });
      return {
        status: 200,
        body: { success: true, result: { id, type: payload.type, name: payload.name, content: payload.content } },
      };
    }
    if (url.includes('/dns_records/') && method === 'DELETE') {
      const id = url.split('/dns_records/')[1]!;
      deletedRecords.push(id);
      txtRecords.delete(id);
      return { status: 200, body: { success: true, result: { id } } };
    }
    if (url.includes('/zones?')) {
      return {
        status: 200,
        body: { success: true, result: [{ id: 'zone_1', name: 'example.com', status: 'active' }] },
      };
    }
    return { status: 404, body: { success: false, errors: [{ message: 'not found' }] } };
  };

  const nextHeaders = () => ({ 'replay-nonce': `nonce-${++nonceSeq}` });
  const jsonRes = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...nextHeaders(), ...extra },
    });

  const acmeFetch: AcmeFetch = async (url, init) => {
    if (url.endsWith('/directory')) {
      return jsonRes({
        newNonce: 'https://acme.test/nonce',
        newAccount: 'https://acme.test/account',
        newOrder: 'https://acme.test/order',
      });
    }
    if (url === 'https://acme.test/nonce') {
      return new Response(null, { status: 204, headers: nextHeaders() });
    }
    const rawBody = init?.body ? (JSON.parse(String(init.body)) as { protected: string; payload: string; signature: string }) : null;
    if (opts.badNonceOnce && !sentBadNonce && url === 'https://acme.test/order') {
      sentBadNonce = true;
      return jsonRes({ type: 'urn:ietf:params:acme:error:badNonce', detail: 'stale nonce' }, 400);
    }
    if (url === 'https://acme.test/account') {
      return jsonRes({ status: 'valid' }, 201, { location: 'https://acme.test/acct/1' });
    }
    if (url === 'https://acme.test/order') {
      triggeredChalls.clear();
      const req = JSON.parse(Buffer.from(rawBody!.payload, 'base64url').toString('utf8')) as {
        identifiers: Array<{ type: string; value: string }>;
      };
      const authorizations = req.identifiers.map((_, idx) => `https://acme.test/auth/${idx + 1}`);
      return jsonRes(
        {
          status: 'pending',
          authorizations,
          finalize: 'https://acme.test/order/1/finalize',
        },
        201,
        { location: 'https://acme.test/order/1' },
      );
    }
    if (url.startsWith('https://acme.test/auth/')) {
      const idx = url.split('/').pop()!;
      if (!triggeredChalls.has(idx)) {
        return jsonRes({
          status: 'pending',
          wildcard: idx === '2',
          identifier: { type: 'dns', value: 'example.com' },
          challenges: [{ type: 'dns-01', url: `https://acme.test/chall/${idx}`, token: `tok-${idx}` }],
        });
      }
      if (opts.challengeInvalid) {
        return jsonRes({
          status: 'invalid',
          identifier: { type: 'dns', value: 'example.com' },
          challenges: [{ type: 'dns-01', error: { detail: 'NXDOMAIN for _acme-challenge' } }],
        });
      }
      return jsonRes({
        status: 'valid',
        identifier: { type: 'dns', value: 'example.com' },
        challenges: [{ type: 'dns-01', status: 'valid' }],
      });
    }
    if (url.startsWith('https://acme.test/chall/')) {
      const idx = url.split('/').pop()!;
      triggeredChalls.add(idx);
      return jsonRes({ type: 'dns-01', status: 'processing' });
    }
    if (url === 'https://acme.test/order/1/finalize') {
      const payload = JSON.parse(Buffer.from(rawBody!.payload, 'base64url').toString('utf8')) as { csr: string };
      finalizeCsrB64 = payload.csr;
      return jsonRes({ status: 'valid', certificate: 'https://acme.test/cert/1' });
    }
    if (url === 'https://acme.test/cert/1') {
      const pem =
        opts.notAfterPem ?? makeFakeCertPem(0x17, '270219120000Z');
      return new Response(pem, {
        status: 200,
        headers: { 'content-type': 'application/pem-certificate-chain', ...nextHeaders() },
      });
    }
    return jsonRes({ error: 'unexpected url' }, 404);
  };

  return {
    cfFetch,
    acmeFetch,
    txtRecords,
    deletedRecords,
    getFinalizeCsr: () => finalizeCsrB64,
  };
}

describe('S3：控制面原生 ACME v2 + Cloudflare DNS-01', () => {
  it('解析叶子证书 DER Validity UTCTime 与 GeneralizedTime', () => {
    const utcPem = makeFakeCertPem(0x17, '270219120000Z');
    expect(parseLeafCertNotAfter(utcPem)).toBe(Math.floor(Date.UTC(2027, 1, 19, 12, 0, 0) / 1000));

    const genPem = makeFakeCertPem(0x18, '20350501083000Z');
    expect(parseLeafCertNotAfter(genPem)).toBe(Math.floor(Date.UTC(2035, 4, 1, 8, 30, 0) / 1000));
  });

  it('构建带通配符 SAN 的 ECDSA P-256 PKCS#10 DER CSR', async () => {
    const key = await generateP256KeyPair();
    const csr = await buildCsrDer(key, ['example.com', '*.example.com']);
    expect(csr[0]).toBe(0x30); // ASN.1 SEQUENCE
    const text = new TextDecoder('latin1').decode(csr);
    expect(text).toContain('example.com');
    expect(text).toContain('*.example.com');
  });

  it('签发单域名与通配符证书：处理 badNonce 重试并清理全部 TXT 记录', async () => {
    const mock = createMockAcmeAndCf({ badNonceOnce: true });
    const issued = await issueAcmeDns01({
      domains: ['example.com', '*.example.com'],
      cfToken: 'cf-secret-tok',
      zones: [{ id: 'zone_1', name: 'example.com' }],
      ca: 'letsencrypt_staging',
      acmeFetch: mock.acmeFetch,
      cfFetch: mock.cfFetch,
      sleep: async () => {},
      propagationDelayMs: 0,
      pollIntervalMs: 0,
    });

    expect(issued.domains).toEqual(['example.com', '*.example.com']);
    expect(issued.certPem).toContain('BEGIN CERTIFICATE');
    expect(issued.keyPem).toContain('BEGIN PRIVATE KEY');
    expect(issued.notAfter).toBe(Math.floor(Date.UTC(2027, 1, 19, 12, 0, 0) / 1000));
    expect(mock.getFinalizeCsr().length).toBeGreaterThan(100);
    // 两条 _acme-challenge.example.com 记录都已创建并在 finally 中删光。
    expect(mock.deletedRecords).toEqual(['txt_1', 'txt_2']);
    expect(mock.txtRecords.size).toBe(0);
  });

  it('DNS-01 校验失败时也在 finally 中清理临时 TXT 记录', async () => {
    const mock = createMockAcmeAndCf({ challengeInvalid: true });
    await expect(
      issueAcmeDns01({
        domains: ['example.com'],
        cfToken: 'cf-secret-tok',
        zones: [{ id: 'zone_1', name: 'example.com' }],
        acmeFetch: mock.acmeFetch,
        cfFetch: mock.cfFetch,
        sleep: async () => {},
        propagationDelayMs: 0,
        pollIntervalMs: 0,
      }),
    ).rejects.toThrow(/NXDOMAIN for _acme-challenge.*DNS 传播延迟/);

    expect(mock.deletedRecords).toEqual(['txt_1']);
    expect(mock.txtRecords.size).toBe(0);
  });

  it('DNS-01 写入 TXT 后轮询双公共 DoH 直至生效再触发 ACME 校验', async () => {
    const mock = createMockAcmeAndCf({});
    let cfCalls = 0;
    let googleCalls = 0;
    const dohFetch: typeof fetch = async (input) => {
      const url = String(input);
      const currentTxt = [...mock.txtRecords.values()].map((item) => item.content);
      const payload =
        url.includes('cloudflare-dns.com')
          ? ((cfCalls += 1) >= 2 && currentTxt.length > 0
              ? { Status: 0, Answer: [{ type: 16, data: `"${currentTxt[0]}"` }] }
              : { Status: 3 })
          : ((googleCalls += 1) >= 3 && currentTxt.length > 0
              ? { Status: 0, Answer: [{ type: 16, data: `"${currentTxt[0]}"` }] }
              : { Status: 3 });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/dns-json' },
      });
    };
    const issued = await issueAcmeDns01({
      domains: ['example.com'],
      cfToken: 'cf-secret-tok',
      zones: [{ id: 'zone_1', name: 'example.com' }],
      acmeFetch: mock.acmeFetch,
      cfFetch: mock.cfFetch,
      dohFetch,
      verifyDnsPropagation: true,
      sleep: async () => {},
      propagationDelayMs: 0,
      propagationPollIntervalMs: 10,
      propagationMaxWaitMs: 50,
      pollIntervalMs: 0,
    });
    expect(issued.domains).toEqual(['example.com']);
    expect(cfCalls).toBe(3);
    expect(googleCalls).toBe(3);
    expect(mock.deletedRecords).toEqual(['txt_1']);
  });

  it('DoH 轮询超时兜底后仍放行 ACME 校验而不误杀，全局导入 PEM 自动解析到期时间', async () => {
    const mock = createMockAcmeAndCf({});
    const dohFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ Status: 3 }), {
        status: 200,
        headers: { 'content-type': 'application/dns-json' },
      });
    const issued = await issueAcmeDns01({
      domains: ['example.com'],
      cfToken: 'cf-secret-tok',
      zones: [{ id: 'zone_1', name: 'example.com' }],
      acmeFetch: mock.acmeFetch,
      cfFetch: mock.cfFetch,
      dohFetch,
      verifyDnsPropagation: true,
      sleep: async () => {},
      propagationDelayMs: 0,
      propagationPollIntervalMs: 10,
      propagationMaxWaitMs: 20,
      pollIntervalMs: 0,
    });
    expect(issued.domains).toEqual(['example.com']);

    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const validPem = makeFakeCertPem(0x17, '270219120000Z');
    const created = await ctx.app.request(
      '/api/v1/certs',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: 'imported-global',
          domains: ['example.com'],
          issuer: 'manual',
          certPem: validPem,
          keyPem: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n',
        }),
      },
      ctx.env,
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { certificate: { notAfter: number | null } };
    expect(body.certificate.notAfter).toBe(Math.floor(Date.UTC(2027, 1, 19, 12, 0, 0) / 1000));
  });

  it('路由 POST /certs/issue-dns01 与 POST /certs/:id/renew 完成全流程入库并更新到期', async () => {
    const mock = createMockAcmeAndCf({});
    const ctx = makeTestContext(mock.cfFetch);
    // 注入 acmeFetch 与 acmeSleep 到测试 App 上下文
    const { createApp } = await import('../src/app');
    ctx.app = createApp({
      nodes: ctx.nodes,
      apps: ctx.apps,
      audit: ctx.audit,
      certs: ctx.certs,
      settings: ctx.settings,
      sshKeys: ctx.sshKeys,
      appManifests: ctx.appManifests,
      tunnels: ctx.tunnels,
      agent: ctx.agentClient,
      cfFetch: mock.cfFetch,
      acmeFetch: mock.acmeFetch,
      acmeSleep: async () => {},
    });

    const cookie = await loginAsAdmin(ctx);
    const encToken = await encryptSecret(ctx.env.MASTER_ENC_KEY!, 'cf-token-real');
    await ctx.settings.put('cf_dns_accounts', {
      accounts: [
        {
          id: 'acc_cf1',
          name: '主 Cloudflare 账号',
          encToken,
          enabled: true,
          zones: [{ id: 'zone_1', name: 'example.com' }],
          enabledZoneIds: ['zone_1'],
        },
      ],
    });

    const issueRes = await ctx.app.request(
      '/api/v1/certs/issue-dns01',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: 'wild-example',
          domains: ['*.example.com', 'example.com'],
          accountId: 'acc_cf1',
          ca: 'letsencrypt',
        }),
      },
      ctx.env,
    );
    expect(issueRes.status).toBe(201);
    const issued = (await issueRes.json()) as {
      certificate: {
        id: string;
        issuer: string;
        sourceNodeId: string | null;
        acmeProvider: string | null;
        acmeCredentialKey: string | null;
        renewable: boolean;
        domains: string[];
      };
    };
    expect(issued.certificate.issuer).toBe('acme');
    expect(issued.certificate.sourceNodeId).toBeNull();
    expect(issued.certificate.acmeProvider).toBe('cf-dns01');
    expect(issued.certificate.acmeCredentialKey).toBe('acc_cf1');
    expect(issued.certificate.renewable).toBe(true);
    expect(issued.certificate.domains).toEqual(['*.example.com', 'example.com']);

    // 续期：使用同一 accountId 重签并原位更新证书记录
    const renewRes = await ctx.app.request(
      `/api/v1/certs/${issued.certificate.id}/renew`,
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: '{}',
      },
      ctx.env,
    );
    expect(renewRes.status).toBe(200);
    const renewed = (await renewRes.json()) as {
      certificate: { id: string; renewable: boolean; autoSync: boolean };
      syncResults?: unknown[];
    };
    expect(renewed.certificate.id).toBe(issued.certificate.id);
    expect(renewed.certificate.renewable).toBe(true);
    expect(renewed.certificate.autoSync).toBe(false);
    expect(renewed.syncResults).toBeUndefined();
  });

  it('S4：关联查询 / PATCH autoSync / 手动与续期自动同步到多节点（含离线节点部分失败回执）', async () => {
    const mock = createMockAcmeAndCf({});
    const ctx = makeTestContext(mock.cfFetch);
    const { createApp } = await import('../src/app');
    ctx.app = createApp({
      nodes: ctx.nodes,
      apps: ctx.apps,
      audit: ctx.audit,
      certs: ctx.certs,
      settings: ctx.settings,
      sshKeys: ctx.sshKeys,
      appManifests: ctx.appManifests,
      tunnels: ctx.tunnels,
      agent: ctx.agentClient,
      cfFetch: mock.cfFetch,
      acmeFetch: mock.acmeFetch,
      acmeSleep: async () => {},
    });

    const cookie = await loginAsAdmin(ctx);
    const encToken = await encryptSecret(ctx.env.MASTER_ENC_KEY!, 'cf-token-real');
    await ctx.settings.put('cf_dns_accounts', {
      accounts: [
        {
          id: 'acc_cf1',
          name: '主账号',
          encToken,
          enabled: true,
          zones: [{ id: 'zone_1', name: 'example.com' }],
          enabledZoneIds: ['zone_1'],
        },
      ],
    });

    // 准备 2 台域名/HTTPS 节点，一台在线、一台离线
    const nodeOnline = await ctx.nodes.create({
      name: 'hub-online',
      endpoint: 'https://online.example.com',
      accessMode: 'domain',
      domain: 'online.example.com',
      tokenEnc: await encryptSecret(ctx.env.MASTER_ENC_KEY!, 'tok-online'),
    });
    const nodeOffline = await ctx.nodes.create({
      name: 'hub-offline',
      endpoint: 'https://offline.example.com',
      accessMode: 'domain',
      domain: 'offline.example.com',
      tokenEnc: await encryptSecret(ctx.env.MASTER_ENC_KEY!, 'tok-offline'),
    });

    const issueRes = await ctx.app.request(
      '/api/v1/certs/issue-dns01',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({
          name: 'wild-sync',
          domains: ['*.example.com'],
          accountId: 'acc_cf1',
        }),
      },
      ctx.env,
    );
    expect(issueRes.status).toBe(201);
    const certId = ((await issueRes.json()) as { certificate: { id: string } }).certificate.id;

    // 两个节点的应用配置都通过 $cert 引用此证书
    await ctx.apps.put(nodeOnline.id, 'caddy-site', {
      config: { sites: [{ name: 'a', domains: ['a.example.com'], tls: { mode: 'manual', cert: { $cert: certId } } }] },
      schemaVersion: 1,
      actor: 'test',
    });
    await ctx.apps.put(nodeOffline.id, 'caddy-site', {
      config: { sites: [{ name: 'b', domains: ['b.example.com'], tls: { mode: 'manual', cert: { $cert: certId } } }] },
      schemaVersion: 1,
      actor: 'test',
    });

    // 1. 查询关联 Hub 与应用
    const usagesRes = await ctx.app.request(
      `/api/v1/certs/${certId}/usages`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    expect(usagesRes.status).toBe(200);
    const usagesBody = (await usagesRes.json()) as {
      usages: Array<{ nodeId: string; nodeName: string; apps: string[] }>;
    };
    expect(usagesBody.usages.map((u) => `${u.nodeName}:${u.apps.join(',')}`)).toEqual([
      'hub-offline:caddy-site',
      'hub-online:caddy-site',
    ]);

    // 2. 手动触发同步：在线节点生效（已解析 $cert 写入 apply），离线节点返回 offline 回执且不阻断其他节点
    ctx.agent.handler = async (_method, path, _body, targetNode) => {
      if (targetNode?.id === nodeOffline.id) throw new Error('ECONNREFUSED');
      if (path === '/apps/caddy-site/apply') return { status: 200, body: { ok: true, appliedRev: 1 } };
      return { status: 200, body: { ok: true } };
    };

    const syncRes = await ctx.app.request(
      `/api/v1/certs/${certId}/sync`,
      { method: 'POST', headers: authHeaders(cookie), body: '{}' },
      ctx.env,
    );
    expect(syncRes.status).toBe(200);
    const syncBody = (await syncRes.json()) as {
      results: Array<{ nodeName: string; status: string; appliedApps: string[]; error: string | null }>;
    };
    expect(syncBody.results).toEqual([
      {
        nodeId: nodeOffline.id,
        nodeName: 'hub-offline',
        status: 'offline',
        appliedApps: [],
        tlsBound: false,
        error: '节点控制通道不可达',
      },
      {
        nodeId: nodeOnline.id,
        nodeName: 'hub-online',
        status: 'synced',
        appliedApps: ['caddy-site'],
        tlsBound: false,
        error: null,
      },
    ]);

    // 3. 开启 autoSync 后再续期：自动下发并返回 syncResults
    const patchRes = await ctx.app.request(
      `/api/v1/certs/${certId}`,
      {
        method: 'PATCH',
        headers: authHeaders(cookie),
        body: JSON.stringify({ autoSync: true }),
      },
      ctx.env,
    );
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as { certificate: { autoSync: boolean } }).certificate.autoSync).toBe(
      true,
    );

    const reqCountBefore = ctx.agent.requests.length;
    const autoRenewRes = await ctx.app.request(
      `/api/v1/certs/${certId}/renew`,
      { method: 'POST', headers: authHeaders(cookie), body: '{}' },
      ctx.env,
    );
    expect(autoRenewRes.status).toBe(200);
    const autoRenewBody = (await autoRenewRes.json()) as {
      certificate: { autoSync: boolean };
      syncResults?: Array<{ nodeName: string; status: string }>;
    };
    expect(autoRenewBody.certificate.autoSync).toBe(true);
    expect(autoRenewBody.syncResults).toHaveLength(2);
    expect(autoRenewBody.syncResults?.find((r) => r.nodeName === 'hub-online')?.status).toBe('synced');
    expect(autoRenewBody.syncResults?.find((r) => r.nodeName === 'hub-offline')?.status).toBe('offline');
    expect(ctx.agent.requests.length).toBeGreaterThan(reqCountBefore);
  });
});
