import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AppBindings, Env } from '../src/types';
import { getWorkerRuntime } from '../src/index';
import {
  D1_BOOKMARK_COOKIE,
  buildD1BookmarkCookie,
  createSessionAwareD1,
  currentD1Session,
  isValidD1Bookmark,
  readD1BookmarkCookie,
  runWithD1Session,
} from '../src/lib/d1-session';
import { RequestTiming, instrumentD1, runWithTiming } from '../src/lib/timing';
import { d1Session } from '../src/middleware/d1-session';
import { serverTiming } from '../src/middleware/timing';
import { applyMigrations, openRawDatabase, toD1 } from './helpers/sqlite-d1';

const EXEC_CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function makeMiniApp(db: D1Database): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  const wrappedDb = instrumentD1(createSessionAwareD1(db));
  app.use('/api/*', serverTiming);
  app.use('/api/*', d1Session);
  app.get('/api/v1/health', (c) => c.json({ ok: true }));
  app.all('/api/v1/items', async (c) => {
    const row = await wrappedDb.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    return c.json({ method: c.req.method, row });
  });
  app.get('/api/v1/immutable', async () => {
    await wrappedDb.prepare('SELECT 1 AS ok').first();
    const res = new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    });
    // 模拟部分运行时的只读 headers（触发克隆回退分支）
    Object.defineProperty(res, 'headers', {
      value: new Headers(res.headers),
      writable: false,
    });
    Object.defineProperty(res.headers, 'append', {
      value: () => {
        throw new TypeError("Can't modify immutable headers");
      },
    });
    return res;
  });
  return app;
}

describe('d1-session: 书签校验与请求级 Session 代理', () => {
  it('1. 校验与 Cookie 构造/解析符合规则（无 Domain、Path=/api、Max-Age=28800）', () => {
    expect(isValidD1Bookmark('0000007b-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b')).toBe(
      true,
    );
    expect(isValidD1Bookmark('bm-123_abc+def/ghi=')).toBe(true);
    expect(isValidD1Bookmark('first-unconstrained')).toBe(false);
    expect(isValidD1Bookmark('first-primary')).toBe(false);
    expect(isValidD1Bookmark('')).toBe(false);
    expect(isValidD1Bookmark('bad;cookie')).toBe(false);
    expect(isValidD1Bookmark('bad cookie')).toBe(false);
    expect(isValidD1Bookmark('a'.repeat(257))).toBe(false);

    expect(
      readD1BookmarkCookie('khc_sess=abc; khc_d1bm=00000001-00000000-00000000-00000005'),
    ).toBe('00000001-00000000-00000000-00000005');
    expect(readD1BookmarkCookie('khc_d1bm=first-unconstrained')).toBeNull();
    expect(readD1BookmarkCookie('khc_d1bm=bad%20space')).toBeNull();

    const httpsCookie = buildD1BookmarkCookie('bm-42', true);
    expect(httpsCookie).toBe(
      `${D1_BOOKMARK_COOKIE}=bm-42; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800; Secure`,
    );
    expect(httpsCookie).not.toContain('Domain=');

    const httpCookie = buildD1BookmarkCookie('bm-42', false);
    expect(httpCookie).toBe(
      `${D1_BOOKMARK_COOKIE}=bm-42; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800`,
    );
    expect(() => buildD1BookmarkCookie('bad;bm', true)).toThrow();
  });

  it('2. 无 cookie 时 GET/HEAD 选 first-unconstrained，写方法选 first-primary；带合法 cookie 复用 bookmark', async () => {
    const raw = openRawDatabase();
    try {
      const seenConstraints: Array<string | undefined> = [];
      const db = toD1(raw, {
        onWithSession: (arg) => seenConstraints.push(arg),
      });
      const app = makeMiniApp(db);
      const env = { DB: db } as unknown as Env;

      const getRes = await app.request('/api/v1/items', { method: 'GET' }, env);
      expect(getRes.status).toBe(200);
      expect(seenConstraints[0]).toBe('first-unconstrained');
      const bm1 = getRes.headers.getSetCookie()[0]?.split(';')[0]?.split('=')[1];
      expect(bm1).toBeTruthy();

      const headRes = await app.request('/api/v1/items', { method: 'HEAD' }, env);
      expect(headRes.status).toBe(200);
      expect(seenConstraints[1]).toBe('first-unconstrained');

      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const writeRes = await app.request('/api/v1/items', { method }, env);
        expect(writeRes.status).toBe(200);
      }
      expect(seenConstraints.slice(2, 6)).toEqual([
        'first-primary',
        'first-primary',
        'first-primary',
        'first-primary',
      ]);

      // 带合法 bookmark 时不论读/写都复用该 bookmark
      const bmCookie = `${D1_BOOKMARK_COOKIE}=${bm1}`;
      await app.request('/api/v1/items', { method: 'GET', headers: { cookie: bmCookie } }, env);
      await app.request('/api/v1/items', { method: 'POST', headers: { cookie: bmCookie } }, env);
      expect(seenConstraints[6]).toBe(bm1);
      expect(seenConstraints[7]).toBe(bm1);

      // 伪造/畸形 cookie 忽略并回退安全约束
      await app.request(
        '/api/v1/items',
        { method: 'POST', headers: { cookie: `${D1_BOOKMARK_COOKIE}=first-unconstrained` } },
        env,
      );
      await app.request(
        '/api/v1/items',
        { method: 'GET', headers: { cookie: `${D1_BOOKMARK_COOKIE}=bad%20bm` } },
        env,
      );
      expect(seenConstraints[8]).toBe('first-primary');
      expect(seenConstraints[9]).toBe('first-unconstrained');
    } finally {
      raw.close();
    }
  });

  it('3. 响应 Set-Cookie 属性齐全、无 D1 查询不发书签，且支持只读 headers 回退', async () => {
    const raw = openRawDatabase();
    try {
      const db = toD1(raw);
      const app = makeMiniApp(db);
      const env = { DB: db } as unknown as Env;

      // /health 不查 D1 -> getBookmark() === null -> 不写 khc_d1bm
      const health = await app.request('https://panel.example.com/api/v1/health', {}, env);
      expect(health.status).toBe(200);
      expect(health.headers.getSetCookie()).toEqual([]);

      // HTTPS 请求写入 Secure，无 Domain
      const httpsRes = await app.request('https://panel.example.com/api/v1/items', {}, env);
      const httpsSetCookies = httpsRes.headers.getSetCookie();
      expect(httpsSetCookies).toHaveLength(1);
      expect(httpsSetCookies[0]).toMatch(
        /^khc_d1bm=00000001-00000000-00000000-\d{8}; HttpOnly; SameSite=Strict; Path=\/api; Max-Age=28800; Secure$/,
      );
      expect(httpsSetCookies[0]).not.toContain('Domain=');

      // x-forwarded-proto: https 同样写入 Secure
      const fwdRes = await app.request(
        'http://panel.local/api/v1/items',
        { headers: { 'x-forwarded-proto': 'https, http' } },
        env,
      );
      expect(fwdRes.headers.getSetCookie()[0]).toContain('; Secure');

      // 明文 HTTP 省略 Secure
      const httpRes = await app.request('http://127.0.0.1:8787/api/v1/items', {}, env);
      expect(httpRes.headers.getSetCookie()[0]).not.toContain('; Secure');

      // 只读 Response.headers 回退克隆路径也能写入 Set-Cookie 与 Server-Timing
      const immRes = await app.request('https://panel.example.com/api/v1/immutable', {}, env);
      expect(immRes.headers.getSetCookie()[0]).toContain('khc_d1bm=');
      expect(immRes.headers.get('server-timing')).toContain('d1;dur=');
    } finally {
      raw.close();
    }
  });

  it('4. prepare / batch / exec 在会话内走 session、无会话回退原绑定，并与 instrumentD1 协同', async () => {
    const raw = openRawDatabase();
    try {
      raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)');
      const rootCalls: string[] = [];
      const sessionCalls: string[] = [];

      const base = toD1(raw);
      const fakeDb: D1Database = {
        prepare: (sql) => {
          rootCalls.push(`prepare:${sql}`);
          return base.prepare(sql);
        },
        batch: (stmts) => {
          rootCalls.push(`batch:${stmts.length}`);
          return base.batch(stmts);
        },
        exec: (sql) => {
          rootCalls.push(`exec:${sql}`);
          return base.exec(sql);
        },
        dump: () => Promise.resolve(new ArrayBuffer(0)),
        withSession: () =>
          ({
            prepare: (sql: string) => {
              sessionCalls.push(`prepare:${sql}`);
              return base.prepare(sql);
            },
            batch: (stmts: D1PreparedStatement[]) => {
              sessionCalls.push(`batch:${stmts.length}`);
              return base.batch(stmts);
            },
            exec: (sql: string) => {
              sessionCalls.push(`exec:${sql}`);
              return base.exec(sql);
            },
            getBookmark: () => 'bm-sess-1',
          }) as unknown as D1DatabaseSession,
      };

      const instrumented = instrumentD1(createSessionAwareD1(fakeDb));

      // (a) 无请求上下文：prepare / batch / exec 全部直接命中 rawDb
      expect(currentD1Session()).toBeUndefined();
      await instrumented.prepare('INSERT INTO t (val) VALUES (?)').bind('outside').run();
      await instrumented.batch([
        instrumented.prepare('INSERT INTO t (val) VALUES (?)').bind('outside-b1'),
        instrumented.prepare('INSERT INTO t (val) VALUES (?)').bind('outside-b2'),
      ]);
      await instrumented.exec("INSERT INTO t (val) VALUES ('outside-exec')");
      expect(rootCalls).toEqual([
        'prepare:INSERT INTO t (val) VALUES (?)',
        'prepare:INSERT INTO t (val) VALUES (?)',
        'prepare:INSERT INTO t (val) VALUES (?)',
        'batch:2',
        "exec:INSERT INTO t (val) VALUES ('outside-exec')",
      ]);
      expect(sessionCalls).toEqual([]);

      // (b) 会话上下文内：prepare / batch / exec 全走 session，且 Server-Timing 正常计数
      const timing = new RequestTiming(() => 10);
      const sess = fakeDb.withSession('first-primary');
      await runWithTiming(timing, () =>
        runWithD1Session(sess, async () => {
          await instrumented.prepare('INSERT INTO t (val) VALUES (?)').bind('inside').run();
          await instrumented.batch([
            instrumented.prepare('INSERT INTO t (val) VALUES (?)').bind('inside-b1'),
          ]);
          await instrumented.exec("INSERT INTO t (val) VALUES ('inside-exec')");
        }),
      );
      expect(sessionCalls).toEqual([
        'prepare:INSERT INTO t (val) VALUES (?)',
        'prepare:INSERT INTO t (val) VALUES (?)',
        'batch:1',
        "exec:INSERT INTO t (val) VALUES ('inside-exec')",
      ]);
      expect(timing.summary().d1?.count).toBe(3);

      // (c) session 没有 exec（对齐真实 Cloudflare D1DatabaseSession）时 exec 安全回退 rawDb.exec
      const cfLikeSession = {
        prepare: (sql: string) => base.prepare(sql),
        batch: (stmts: D1PreparedStatement[]) => base.batch(stmts),
        getBookmark: () => 'bm-cf-1',
      } as unknown as D1DatabaseSession;
      await runWithD1Session(cfLikeSession, async () => {
        const res = await instrumented.exec('SELECT 1');
        expect(res.count).toBe(1);
      });
      expect(rootCalls.at(-1)).toBe('exec:SELECT 1');
    } finally {
      raw.close();
    }
  });

  it('5. 端到端真实 Worker 运行时：登录同发 khc_sess+khc_d1bm、限流直连主库、写后带书签立即可读', async () => {
    const raw = openRawDatabase();
    try {
      applyMigrations(raw);
      const withSessionCalls: Array<string | undefined> = [];
      const rawPrepareSqls: string[] = [];

      const baseD1 = toD1(raw, {
        onWithSession: (arg) => withSessionCalls.push(arg),
      });
      const spiedDb: D1Database = {
        prepare: (sql) => {
          rawPrepareSqls.push(sql);
          return baseD1.prepare(sql);
        },
        batch: (stmts) => baseD1.batch(stmts),
        exec: (sql) => baseD1.exec(sql),
        dump: () => baseD1.dump(),
        withSession: (constraintOrBookmark) => baseD1.withSession(constraintOrBookmark),
      };

      const env = {
        DB: spiedDb,
        ENVIRONMENT: 'development',
        ADMIN_PASSWORD: 'test-password-1234',
        SESSION_SECRET: 'test-secret-0123456789abcdef0123456789',
        MASTER_ENC_KEY: 'test-master-key-0123456789',
        ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
      } as unknown as Env;

      const runtime = getWorkerRuntime(env);

      // 1) POST /auth/login：限流直连 c.env.DB，设置 khc_sess + khc_d1bm 互不覆盖
      const loginRes = await runtime.app.fetch(
        new Request('https://panel.example.com/api/v1/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password: 'test-password-1234' }),
        }),
        env,
        EXEC_CTX,
      );
      expect(loginRes.status).toBe(200);
      expect(withSessionCalls[0]).toBe('first-primary');
      // 限流直接命中 raw env.DB（rate_limit upsert），未通过 session.prepare
      expect(rawPrepareSqls.some((sql) => sql.includes('INTO rate_limit'))).toBe(true);
      // 业务查询（settings）全部通过 session.prepare，未走 rawPrepareSqls
      expect(rawPrepareSqls.some((sql) => sql.includes('FROM settings'))).toBe(false);

      const loginCookies = loginRes.headers.getSetCookie();
      expect(loginCookies).toHaveLength(2);
      const sessPair = loginCookies.find((c) => c.startsWith('khc_sess='))?.split(';')[0];
      const bmCookie1 = loginCookies.find((c) => c.startsWith('khc_d1bm='));
      const bmPair1 = bmCookie1?.split(';')[0];
      const bmVal1 = bmPair1?.split('=')[1];
      expect(sessPair).toBeTruthy();
      expect(bmCookie1).toContain('HttpOnly');
      expect(bmCookie1).toContain('SameSite=Strict');
      expect(bmCookie1).toContain('Path=/api');
      expect(bmCookie1).toContain('Max-Age=28800');
      expect(bmCookie1).toContain('Secure');
      expect(bmCookie1).not.toContain('Domain=');
      expect(bmVal1).toBeTruthy();

      // 2) POST /nodes：携带 khc_sess + khc_d1bm 写入节点并拿回推进后的书签
      const createRes = await runtime.app.fetch(
        new Request('https://panel.example.com/api/v1/nodes', {
          method: 'POST',
          headers: {
            cookie: `${sessPair}; ${bmPair1}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: 'replica-test-node',
            endpoint: 'https://hub.example.com:8443',
          }),
        }),
        env,
        EXEC_CTX,
      );
      expect(createRes.status).toBe(201);
      expect(withSessionCalls[1]).toBe(bmVal1);
      const bmPair2 = createRes.headers
        .getSetCookie()
        .find((c) => c.startsWith('khc_d1bm='))
        ?.split(';')[0];
      const bmVal2 = bmPair2?.split('=')[1];
      expect(bmVal2).toBeTruthy();
      expect(bmVal2).not.toBe(bmVal1);

      // 3) GET /nodes：携带写后书签，withSession(<bm2>) 读己之写且输出 Server-Timing d1
      const listRes = await runtime.app.fetch(
        new Request('https://panel.example.com/api/v1/nodes', {
          method: 'GET',
          headers: { cookie: `${sessPair}; ${bmPair2}` },
        }),
        env,
        EXEC_CTX,
      );
      expect(listRes.status).toBe(200);
      expect(withSessionCalls[2]).toBe(bmVal2);
      const listBody = (await listRes.json()) as { nodes: Array<{ name: string }> };
      expect(listBody.nodes.map((n) => n.name)).toEqual(['replica-test-node']);
      expect(listRes.headers.get('server-timing')).toContain('d1;dur=');
    } finally {
      raw.close();
    }
  });
});
