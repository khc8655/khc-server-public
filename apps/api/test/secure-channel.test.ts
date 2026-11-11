import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { AppError } from '../src/lib/errors';
import { assertSecureChannelForSecrets, containsSecretRefs } from '../src/lib/secure-channel';
import { deriveLiveEndpoint } from '../src/routes/helpers';
import { authHeaders, loginAsAdmin, makeTestContext, type TestContext } from './helpers/context';

beforeEach(() => resetRateLimitForTests());

describe('containsSecretRefs', () => {
  it('识别嵌套对象与数组里的 $cert / $dnsCred', () => {
    expect(containsSecretRefs({ a: { b: [{ $cert: 'cert_1' }] } })).toBe(true);
    expect(containsSecretRefs({ dns: { $dnsCred: 'dns.cf' } })).toBe(true);
  });

  it('普通配置与非字符串引用不算', () => {
    expect(containsSecretRefs({ port: 9100, peers: [{ name: 'a' }] })).toBe(false);
    expect(containsSecretRefs({ $cert: 123 })).toBe(false);
    expect(containsSecretRefs(null)).toBe(false);
    expect(containsSecretRefs('$cert')).toBe(false);
  });
});

describe('assertSecureChannelForSecrets', () => {
  const secret = { site: { cert: { $cert: 'cert_1' } } };
  const https = { endpoint: 'https://h.example.com:9443', tunnelEndpoint: null };
  const http = { endpoint: 'http://10.0.0.5:8880', tunnelEndpoint: null };

  it('全 https 通道放行', () => {
    expect(() => assertSecureChannelForSecrets({ ENVIRONMENT: 'production' }, https, secret)).not.toThrow();
  });

  it('直连入口是明文 http 时拒绝', () => {
    expect(() => assertSecureChannelForSecrets({ ENVIRONMENT: 'production' }, http, secret)).toThrowError(
      expect.objectContaining({ status: 400, code: 'insecure_channel_secret' }) as unknown as AppError,
    );
  });

  it('隧道入口是明文 http 同样拒绝（回退时可能走到它）', () => {
    const node = { endpoint: 'https://h.example.com:9443', tunnelEndpoint: 'http://t.example.com' };
    expect(() => assertSecureChannelForSecrets({ ENVIRONMENT: 'production' }, node, secret)).toThrow();
  });

  it('配置里没有密钥引用时，明文节点不受影响', () => {
    expect(() =>
      assertSecureChannelForSecrets({ ENVIRONMENT: 'production' }, http, { port: 9100 }, {}),
    ).not.toThrow();
  });

  it('params 里的引用也会触发', () => {
    expect(() =>
      assertSecureChannelForSecrets({ ENVIRONMENT: 'production' }, http, {}, { token: { $dnsCred: 'dns.cf' } }),
    ).toThrow();
  });

  it('development 环境放行（本机 http://127.0.0.1 调试）', () => {
    expect(() => assertSecureChannelForSecrets({ ENVIRONMENT: 'development' }, http, secret)).not.toThrow();
  });
});

describe('apply 路由：明文通道不下发密钥材料', () => {
  async function setupNode(endpoint: string, environment: string) {
    const ctx: TestContext = makeTestContext();
    ctx.env = { ...ctx.env, ENVIRONMENT: environment } as typeof ctx.env;
    // 登录走 development 的明文口令校验；登录后再切环境不影响会话
    const devCtx = { ...ctx, env: { ...ctx.env, ENVIRONMENT: 'development' } as typeof ctx.env };
    const cookie = await loginAsAdmin(devCtx);
    const created = await ctx.app.request(
      '/api/v1/nodes',
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({ name: 'n', endpoint }) },
      devCtx.env,
    );
    expect(created.status).toBe(201);
    const nodeId = ((await created.json()) as { node: { id: string } }).node.id;
    const put = await ctx.app.request(
      `/api/v1/nodes/${nodeId}/apps/caddy-site`,
      {
        method: 'PUT',
        headers: authHeaders(cookie),
        body: JSON.stringify({ config: { sites: [{ cert: { $cert: 'cert_missing' } }] } }),
      },
      devCtx.env,
    );
    expect(put.status).toBe(200);
    const apply = () =>
      ctx.app.request(
        `/api/v1/nodes/${nodeId}/apps/caddy-site/apply`,
        { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({}) },
        { ...ctx.env, ENVIRONMENT: environment } as typeof ctx.env,
      );
    return { ctx, apply };
  }

  it('production + http 节点：400 insecure_channel_secret，且根本没有调用 Agent', async () => {
    const { ctx, apply } = await setupNode('http://10.0.0.5:8880', 'production');
    const res = await apply();
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('insecure_channel_secret');
    expect(ctx.agent.requests).toHaveLength(0);
  });

  it('production + https 节点：不被该规则拦截（走到引用解析，缺失证书是另一个错误）', async () => {
    const { ctx, apply } = await setupNode('https://h.example.com:9443', 'production');
    const res = await apply();
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).not.toBe('insecure_channel_secret');
    expect(ctx.agent.requests).toHaveLength(0);
  });

  it('development + http 节点：放行到引用解析', async () => {
    const { apply } = await setupNode('http://127.0.0.1:8880', 'development');
    const res = await apply();
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).not.toBe('insecure_channel_secret');
  });
});

describe('deriveLiveEndpoint', () => {
  it('显式配置优先', () => {
    expect(
      deriveLiveEndpoint({
        liveEndpoint: 'https://live.example.com',
        endpoint: 'https://h.example.com:9443',
        domain: 'h.example.com',
      }),
    ).toBe('https://live.example.com');
  });

  it('https 控制入口：同源同端口（9443 不再被错推成 443）', () => {
    expect(
      deriveLiveEndpoint({
        liveEndpoint: null,
        endpoint: 'https://h.example.com:9443',
        domain: 'h.example.com',
      }),
    ).toBe('https://h.example.com:9443');
  });

  it('https 控制入口无显式端口时是 origin 本身', () => {
    expect(
      deriveLiveEndpoint({ liveEndpoint: null, endpoint: 'https://h.example.com', domain: null }),
    ).toBe('https://h.example.com');
  });

  it('明文入口 + 绑定域名：沿用旧的 Caddy 443 推导', () => {
    expect(
      deriveLiveEndpoint({ liveEndpoint: null, endpoint: 'http://1.2.3.4:8880', domain: 'h.example.com' }),
    ).toBe('https://h.example.com');
  });

  it('明文入口且无域名：null（走 Worker 转发）', () => {
    expect(
      deriveLiveEndpoint({ liveEndpoint: null, endpoint: 'http://1.2.3.4:8880', domain: null }),
    ).toBeNull();
  });
});
