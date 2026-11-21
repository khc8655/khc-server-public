import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { authHeaders, loginAsAdmin, makeTestContext } from './helpers/context';

/**
 * 解析检测（DoH）：只校验路由层口径 —— 是否已生效、如何映射失败。
 * DoH 的 HTTP 调用在这里被 stub，不触达真实网络。
 */

beforeEach(() => resetRateLimitForTests());
afterEach(() => vi.unstubAllGlobals());

function stubDoh(body: unknown, status = 200) {
  const mock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/dns-json' },
      }),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('POST /api/v1/cf-dns/resolve-check', () => {
  it('未鉴权 → 401', async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.request(
      '/api/v1/cf-dns/resolve-check',
      { method: 'POST', body: JSON.stringify({ name: 'app.example.com' }) },
      ctx.env,
    );
    expect(res.status).toBe(401);
  });

  it('NOERROR 且有同类型应答 → resolved=true，只回同类型答案', async () => {
    const doh = stubDoh({
      Status: 0,
      Answer: [
        { type: 5, data: 'app.example.com.cdn.example.net.' },
        { type: 1, data: '198.51.100.10' },
      ],
    });
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/cf-dns/resolve-check',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ name: 'App.Example.com.', type: 'A' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      type: string;
      resolved: boolean;
      answers: string[];
      status: number;
    };
    // 入参归一：小写、去尾点
    expect(body.name).toBe('app.example.com');
    expect(body.type).toBe('A');
    expect(body.resolved).toBe(true);
    expect(body.status).toBe(0);
    // CNAME 中间结果不得混进 A 应答，否则「生效没有」无法判断
    expect(body.answers).toEqual(['198.51.100.10']);
    expect(String(doh.mock.calls[0]?.[0])).toContain('name=app.example.com');
    expect(String(doh.mock.calls[0]?.[0])).toContain('type=A');
  });

  it('NXDOMAIN（无应答）→ resolved=false，仍 200（结论本身是「没有解析」）', async () => {
    stubDoh({ Status: 3 });
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/cf-dns/resolve-check',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ name: 'missing.example.com', type: 'AAAA' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resolved: boolean; answers: string[]; status: number };
    expect(body.resolved).toBe(false);
    expect(body.answers).toEqual([]);
    expect(body.status).toBe(3);
  });

  it('DoH 自身失败 → 502 dns_resolve_failed（不伪造「无解析」）', async () => {
    stubDoh({}, 503);
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/cf-dns/resolve-check',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ name: 'app.example.com' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('dns_resolve_failed');
  });

  it('名字太短 → 400 参数校验', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/cf-dns/resolve-check',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ name: 'a' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; fields?: Record<string, string> } };
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.fields?.name).toBeTruthy();
  });
});
