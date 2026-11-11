import { describe, expect, it } from 'vitest';
import { healthResponseSchema, versionResponseSchema } from '@khc/contracts';
import { loginAsAdmin, makeTestContext } from './helpers/context';

describe('api: health & version', () => {
  it('GET /api/v1/health 返回符合契约的响应', async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.request('/api/v1/health', {}, ctx.env);
    expect(res.status).toBe(200);
    const parsed = healthResponseSchema.parse(await res.json());
    expect(parsed.ok).toBe(true);
    expect(parsed.service).toBe('khc-server');
    expect(parsed.env).toBe('development');
  });

  it('GET /api/v1/version 返回 API 版本', async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.request('/api/v1/version', {}, ctx.env);
    expect(res.status).toBe(200);
    const body = versionResponseSchema.parse(await res.json());
    expect(body.apiVersion).toBe('v1');
  });

  it('未实现的 API 受默认鉴权保护：无会话 401（不泄漏路径信息）', async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.request('/api/v1/nope', {}, ctx.env);
    expect(res.status).toBe(401);
  });

  it('未实现的 API 登录后返回 404 JSON，而不是 SPA 页面', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request('/api/v1/nope', { headers: { cookie } }, ctx.env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('not_found');
  });
});

describe('app: 静态资源安全头（A-1）', () => {
  it('HTML 响应带 frame-ancestors/nosniff/HSTS + no-cache', async () => {
    const ctx = makeTestContext();
    (ctx.env as { ASSETS?: unknown }).ASSETS = {
      fetch: async () =>
        new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
    };
    const res = await ctx.app.request('/', {}, ctx.env);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(res.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(res.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate');
  });

  it('非 HTML 静态资源也带三个安全头，但保留原 Cache-Control（不走 no-cache）', async () => {
    const ctx = makeTestContext();
    (ctx.env as { ASSETS?: unknown }).ASSETS = {
      fetch: async () =>
        new Response('console.log(1)', {
          headers: { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=31536000, immutable' },
        }),
    };
    const res = await ctx.app.request('/assets/app-abc123.js', {}, ctx.env);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(res.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });
});
