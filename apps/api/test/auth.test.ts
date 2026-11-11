import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimitForTests } from '../src/lib/rate-limit';
import { makeTestContext, loginAsAdmin, authHeaders } from './helpers/context';
import { totpAt, TOTP_PERIOD } from '../src/lib/totp';
import { TOTP_SECRET_KEY, TOTP_PENDING_KEY, SESSION_EPOCH_KEY } from '../src/lib/session';

beforeEach(() => resetRateLimitForTests());

const nowSec = () => Math.floor(Date.now() / 1000);

function loginRequest(
  ctx: ReturnType<typeof makeTestContext>,
  body: Record<string, unknown>,
) {
  return ctx.app.request(
    '/api/v1/auth/login',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    ctx.env,
  );
}

describe('auth', () => {
  it('错误口令返回 401，且不回显任何凭据', async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.request(
      '/api/v1/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('invalid_credentials');
    expect(JSON.stringify(body)).not.toContain('test-pass');
  });

  it('正确口令签发 HttpOnly Cookie，并可访问 /auth/me', async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.request(
      '/api/v1/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'test-pass' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('khc_sess=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const me = await ctx.app.request(
      '/api/v1/auth/me',
      { headers: { cookie: setCookie.split(';')[0] ?? '' } },
      ctx.env,
    );
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { user: { name: string } };
    expect(meBody.user.name).toBe('admin');
  });

  it('未登录访问受保护接口返回 401', async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.request('/api/v1/nodes', {}, ctx.env);
    expect(res.status).toBe(401);
  });

  it('SESSION_SECRET 缺失时登录 fail-closed（503）', async () => {
    const ctx = makeTestContext();
    const env = { ...ctx.env, SESSION_SECRET: '' } as typeof ctx.env;
    const res = await ctx.app.request(
      '/api/v1/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'test-pass' }),
      },
      env,
    );
    expect(res.status).toBe(503);
  });
});

describe('A-3：/api/v1/* 默认鉴权 + 白名单', () => {
  it('附录 A-4 探针：/agent/releases 无 cookie → 401（此前公开返回 200）', async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.request('/api/v1/agent/releases', {}, ctx.env);
    expect(res.status).toBe(401);
  });

  it('登录后 /agent/releases → 200', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/agent/releases',
      { headers: { cookie } },
      ctx.env,
    );
    expect(res.status).toBe(200);
  });

  it('白名单放行：health/version 无 cookie 仍可访问', async () => {
    const ctx = makeTestContext();
    const health = await ctx.app.request('/api/v1/health', {}, ctx.env);
    expect(health.status).toBe(200);
    const version = await ctx.app.request('/api/v1/version', {}, ctx.env);
    expect(version.status).toBe(200);
  });

  it('logout 幂等清 cookie：无有效会话也可登出（200）', async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.request(
      '/api/v1/auth/logout',
      { method: 'POST' },
      ctx.env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('khc_sess=');
  });

  it('未实现路径同受默认鉴权保护（401 而非 404 泄漏路径信息）', async () => {
    const ctx = makeTestContext();
    const res = await ctx.app.request('/api/v1/not-a-route', {}, ctx.env);
    expect(res.status).toBe(401);
  });
});

describe('A-2：写请求 Origin/Sec-Fetch-Site + content-type 校验', () => {
  it('附录 A-4 探针：登录后 POST /nodes 带 text/plain body → 415（此前 201）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'text/plain' },
        body: JSON.stringify({ name: 'x', endpoint: 'http://1.2.3.4:8880' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unsupported_media_type');
  });

  it('零长度 body 的写请求（浏览器无 body 的 POST）不判 415', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/nodes/probe',
      { method: 'POST', headers: { cookie }, body: new Uint8Array(0) },
      ctx.env,
    );
    expect(res.status).toBe(200);
  });

  it('真无 body 的写请求（raw.body === null）不判 415', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request('/api/v1/nodes/probe', { method: 'POST', headers: { cookie } }, ctx.env);
    expect(res.status).toBe(200);
  });

  it('跨站 Origin 写请求 → 403 cross_origin_blocked', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x', endpoint: 'http://1.2.3.4:8880' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('cross_origin_blocked');
  });

  it('未配置 LIVE_ORIGINS 时，非同一 host 的 Origin 仍 403（默认行为不变）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: { cookie, origin: 'https://panel.example.com', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x', endpoint: 'http://1.2.3.4:8880' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(403);
  });

  it('配置 LIVE_ORIGINS 后白名单 Origin 放行，跨站伪造仍 403', async () => {
    const ctx = makeTestContext();
    ctx.env.LIVE_ORIGINS = 'https://panel.example.com';
    const cookie = await loginAsAdmin(ctx);
    const ok = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: { cookie, origin: 'https://panel.example.com', 'content-type': 'application/json' },
        body: JSON.stringify({ name: '白名单节点', endpoint: 'http://127.0.0.1:8880' }),
      },
      ctx.env,
    );
    expect(ok.status).toBe(201);

    const forged = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ name: '伪造节点', endpoint: 'http://127.0.0.1:8880' }),
      },
      ctx.env,
    );
    expect(forged.status).toBe(403);
  });

  it('Sec-Fetch-Site: cross-site 写请求（无 Origin 头）→ 403', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: { cookie, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x', endpoint: 'http://1.2.3.4:8880' }),
      },
      ctx.env,
    );
    expect(res.status).toBe(403);
  });

  it('同源 Origin + application/json → 正常处理；curl（两者皆缺省）不受影响', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const sameOrigin = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: { cookie, origin: 'http://localhost', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'same-origin-ok', endpoint: 'http://1.2.3.4:8880' }),
      },
      ctx.env,
    );
    expect(sameOrigin.status).toBe(201);
    // curl 形态：无 Origin/Sec-Fetch-Site，content-type json
    const curlLike = await ctx.app.request(
      '/api/v1/nodes',
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'curl-ok', endpoint: 'http://1.2.3.4:8880' }),
      },
      ctx.env,
    );
    expect(curlLike.status).toBe(201);
  });

  it('无 body 的写请求不校验 content-type：logout 裸 POST 仍 200', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/auth/logout',
      { method: 'POST', headers: { cookie } },
      ctx.env,
    );
    expect(res.status).toBe(200);
  });

  it('GET 不受写校验影响：跨站 Origin 的 GET 仍走正常处理', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/nodes',
      { headers: { cookie, origin: 'https://evil.example' } },
      ctx.env,
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// §3.4：TOTP 二次验证 + 会话撤销
// ---------------------------------------------------------------------------

const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

describe('TOTP 二次验证：登录', () => {
  it('未启用 TOTP：带/不带 totp 字段均 200（行为不变）', async () => {
    const ctx = makeTestContext();
    expect((await loginRequest(ctx, { password: 'test-pass' })).status).toBe(200);
    expect((await loginRequest(ctx, { password: 'test-pass', totp: '123456' })).status).toBe(200);
  });

  it('启用后缺 code → 401 invalid_credentials，零凭据回显', async () => {
    const ctx = makeTestContext();
    await ctx.settings.put(TOTP_SECRET_KEY, TOTP_SECRET);
    const res = await loginRequest(ctx, { password: 'test-pass' });
    expect(res.status).toBe(401);
    const raw = await res.text();
    expect(errorCode(JSON.parse(raw))).toBe('invalid_credentials');
    expect(raw).not.toContain(TOTP_SECRET);
    expect(raw).not.toContain('totp');
  });

  it('启用后错误 code → 401 invalid_credentials', async () => {
    const ctx = makeTestContext();
    await ctx.settings.put(TOTP_SECRET_KEY, TOTP_SECRET);
    const wrong = await totpAt(TOTP_SECRET, nowSec() + 10 * TOTP_PERIOD);
    const res = await loginRequest(ctx, { password: 'test-pass', totp: wrong });
    expect(res.status).toBe(401);
    expect(errorCode(await res.json())).toBe('invalid_credentials');
  });

  it('启用后正确 code → 200 且 /auth/me 可用', async () => {
    const ctx = makeTestContext();
    await ctx.settings.put(TOTP_SECRET_KEY, TOTP_SECRET);
    const code = await totpAt(TOTP_SECRET, nowSec());
    const res = await loginRequest(ctx, { password: 'test-pass', totp: code });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
    const me = await ctx.app.request('/api/v1/auth/me', { headers: { cookie } }, ctx.env);
    expect(me.status).toBe(200);
  });

  it('口令错误仍优先 401，不枚举 TOTP 状态', async () => {
    const ctx = makeTestContext();
    await ctx.settings.put(TOTP_SECRET_KEY, TOTP_SECRET);
    const res = await loginRequest(ctx, { password: 'wrong' });
    expect(res.status).toBe(401);
    expect(errorCode(await res.json())).toBe('invalid_credentials');
  });
});

describe('TOTP 管理端点与会话撤销', () => {
  it('setup → enable → 旧会话失效 → 重新登录需 TOTP → disable', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);

    // setup：一次性 secret + otpauth URI，pending 加密落库，尚未启用
    const setup = await ctx.app.request(
      '/api/v1/auth/totp/setup',
      { headers: { cookie } },
      ctx.env,
    );
    expect(setup.status).toBe(200);
    const setupBody = (await setup.json()) as { secret: string; otpauthUri: string };
    expect(setupBody.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setupBody.otpauthUri).toContain('otpauth://totp/');
    expect(await ctx.settings.getValue(TOTP_PENDING_KEY)).toBe(setupBody.secret);
    expect(await ctx.settings.getValue(TOTP_SECRET_KEY)).toBeNull();

    // enable 错误 code → 401，secret 未转正
    const badCode = await totpAt(setupBody.secret, nowSec() + 10 * TOTP_PERIOD);
    const bad = await ctx.app.request(
      '/api/v1/auth/totp/enable',
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({ code: badCode }) },
      ctx.env,
    );
    expect(bad.status).toBe(401);
    expect(await ctx.settings.getValue(TOTP_SECRET_KEY)).toBeNull();

    // enable 正确 code → 200：secret 转正、pending 清除、epoch 递增，响应零回显
    const code = await totpAt(setupBody.secret, nowSec());
    const enable = await ctx.app.request(
      '/api/v1/auth/totp/enable',
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({ code }) },
      ctx.env,
    );
    expect(enable.status).toBe(200);
    expect(JSON.stringify(await enable.json())).not.toContain(setupBody.secret);
    expect(await ctx.settings.getValue(TOTP_SECRET_KEY)).toBe(setupBody.secret);
    expect(await ctx.settings.getValue(TOTP_PENDING_KEY)).toBeNull();
    expect(await ctx.settings.getValue(SESSION_EPOCH_KEY)).toBe(1);

    // 会话撤销：enable 前的旧 cookie 立即失效
    const oldMe = await ctx.app.request('/api/v1/auth/me', { headers: { cookie } }, ctx.env);
    expect(oldMe.status).toBe(401);

    // 重新登录：缺 code 401，带正确 code 200（新 token ver=1）
    expect((await loginRequest(ctx, { password: 'test-pass' })).status).toBe(401);
    const relogin = await loginRequest(ctx, {
      password: 'test-pass',
      totp: await totpAt(setupBody.secret, nowSec()),
    });
    expect(relogin.status).toBe(200);
    const cookie2 = relogin.headers.get('set-cookie')?.split(';')[0] ?? '';
    const me2 = await ctx.app.request('/api/v1/auth/me', { headers: { cookie: cookie2 } }, ctx.env);
    expect(me2.status).toBe(200);

    // disable 正确 code → 200：secret 清除、epoch 再递增
    const disable = await ctx.app.request(
      '/api/v1/auth/totp/disable',
      {
        method: 'POST',
        headers: authHeaders(cookie2),
        body: JSON.stringify({ code: await totpAt(setupBody.secret, nowSec()) }),
      },
      ctx.env,
    );
    expect(disable.status).toBe(200);
    expect(JSON.stringify(await disable.json())).not.toContain(setupBody.secret);
    expect(await ctx.settings.getValue(TOTP_SECRET_KEY)).toBeNull();
    expect(await ctx.settings.getValue(SESSION_EPOCH_KEY)).toBe(2);
  });

  it('已启用时 setup/enable 拒绝（409）；未启用时 disable 拒绝（400）', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const disableBefore = await ctx.app.request(
      '/api/v1/auth/totp/disable',
      { method: 'POST', headers: authHeaders(cookie), body: JSON.stringify({ code: '000000' }) },
      ctx.env,
    );
    expect(disableBefore.status).toBe(400);

    const setup = await ctx.app.request('/api/v1/auth/totp/setup', { headers: { cookie } }, ctx.env);
    const { secret } = (await setup.json()) as { secret: string };
    const enable = await ctx.app.request(
      '/api/v1/auth/totp/enable',
      {
        method: 'POST',
        headers: authHeaders(cookie),
        body: JSON.stringify({ code: await totpAt(secret, nowSec()) }),
      },
      ctx.env,
    );
    expect(enable.status).toBe(200);

    // enable 递增 epoch 后旧 cookie 失效；重新登录拿新 cookie 再校验 409
    const relogin = await loginRequest(ctx, {
      password: 'test-pass',
      totp: await totpAt(secret, nowSec()),
    });
    const cookie2 = relogin.headers.get('set-cookie')?.split(';')[0] ?? '';
    const setup2 = await ctx.app.request(
      '/api/v1/auth/totp/setup',
      { headers: { cookie: cookie2 } },
      ctx.env,
    );
    expect(setup2.status).toBe(409);
    const enable2 = await ctx.app.request(
      '/api/v1/auth/totp/enable',
      { method: 'POST', headers: authHeaders(cookie2), body: JSON.stringify({ code: '000000' }) },
      ctx.env,
    );
    expect(enable2.status).toBe(409);
  });

  it('POST /auth/logout-all 递增 epoch，使所有既有会话失效', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const res = await ctx.app.request(
      '/api/v1/auth/logout-all',
      { method: 'POST', headers: { cookie } },
      ctx.env,
    );
    expect(res.status).toBe(200);
    expect(await ctx.settings.getValue(SESSION_EPOCH_KEY)).toBe(1);
    const me = await ctx.app.request('/api/v1/auth/me', { headers: { cookie } }, ctx.env);
    expect(me.status).toBe(401);
  });
});
