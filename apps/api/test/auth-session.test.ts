import { describe, expect, it } from 'vitest';
import { signSession } from '../src/lib/session';
import { loginAsAdmin, makeTestContext } from './helpers/context';
import { b64UrlToBytes, bytesToB64Url, stringToBytes } from '../src/lib/encoding';
import { resetRateLimitForTests } from '../src/lib/rate-limit';

const SECRET = 'test-secret-0123456789abcdef0123456789';

describe('会话语义（批次 F）', () => {
  it('过期会话被拒（exp 已过 → 401）', async () => {
    const ctx = makeTestContext();
    const now = Math.floor(Date.now() / 1000);
    const token = await signSession(SECRET, {
      sub: 'admin',
      iat: now - 100,
      exp: now - 10,
    });
    const res = await ctx.app.request(
      '/api/v1/auth/me',
      { headers: { cookie: `khc_sess=${token}` } },
      ctx.env,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('篡改 payload 的会话被 HMAC 拒绝', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const token = cookie.split('=')[1] ?? '';
    const [bodyB64, sig] = token.split('.');
    // 解开 payload，改成别人，再拼回原签名——签名校验必须失败
    const payload = JSON.parse(
      new TextDecoder().decode(b64UrlToBytes(bodyB64 ?? '')),
    ) as { sub: string; iat: number; exp: number };
    payload.sub = 'attacker';
    const forged = `${bytesToB64Url(stringToBytes(JSON.stringify(payload)))}.${sig}`;
    expect(forged).not.toBe(token);
    const res = await ctx.app.request(
      '/api/v1/auth/me',
      { headers: { cookie: `khc_sess=${forged}` } },
      ctx.env,
    );
    expect(res.status).toBe(401);
    // 原始 token 仍然可用（篡改只影响伪造的那份）
    const ok = await ctx.app.request(
      '/api/v1/auth/me',
      { headers: { cookie } },
      ctx.env,
    );
    expect(ok.status).toBe(200);
  });

  it('用非服务端密钥签发的会话被拒（换 secret 后旧会话全部失效）', async () => {
    const ctx = makeTestContext();
    const now = Math.floor(Date.now() / 1000);
    const token = await signSession('wrong-secret-0123456789abcdef0123456', {
      sub: 'admin',
      iat: now,
      exp: now + 3600,
    });
    const res = await ctx.app.request(
      '/api/v1/auth/me',
      { headers: { cookie: `khc_sess=${token}` } },
      ctx.env,
    );
    expect(res.status).toBe(401);
  });

  it('登出清 Cookie；清空后的会话头不可用，重新登录正常', async () => {
    resetRateLimitForTests();
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);

    const logout = await ctx.app.request(
      '/api/v1/auth/logout',
      { method: 'POST', headers: { cookie } },
      ctx.env,
    );
    expect(logout.status).toBe(200);
    const setCookie = logout.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('khc_sess=');
    expect(setCookie).not.toContain(`khc_sess=${cookie.split('=')[1]}`);
    expect(setCookie).toContain('Max-Age=0');

    // 登出响应里给的（已清空的）Cookie 不再能访问受保护接口
    const cleared = setCookie.split(';')[0] ?? '';
    const afterLogout = await ctx.app.request(
      '/api/v1/auth/me',
      { headers: { cookie: cleared } },
      ctx.env,
    );
    expect(afterLogout.status).toBe(401);

    // 紧接着重新登录不受影响（限流计数不因登出/重登被消耗到拒绝）
    const cookie2 = await loginAsAdmin(ctx);
    const me = await ctx.app.request(
      '/api/v1/auth/me',
      { headers: { cookie: cookie2 } },
      ctx.env,
    );
    expect(me.status).toBe(200);
  });
});
