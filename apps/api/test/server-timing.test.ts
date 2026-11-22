import { describe, expect, it, vi } from 'vitest';
import {
  RequestTiming,
  currentTiming,
  instrumentAgent,
  instrumentD1,
  runWithTiming,
  timed,
  unionDuration,
} from '../src/lib/timing';
import { SLOW_REQUEST_LOG_MS } from '../src/middleware/timing';
import { HubUnreachableError } from '../src/lib/node-client';
import { openRawDatabase, toD1 } from './helpers/sqlite-d1';
import { FakeAgentClient, authHeaders, createNode, loginAsAdmin, makeTestContext } from './helpers/context';

describe('server-timing: 纯计时器与并集计算', () => {
  it('1. unionDuration 正确合并重叠、乱序、包含区间并钳零负区间', () => {
    expect(unionDuration([])).toBe(0);
    // 重叠 + 乱序 + 完全包含：[10, 30] ∪ [5, 15] ∪ [12, 18] ∪ [40, 50] => [5, 30](25) + [40, 50](10) = 35
    expect(
      unionDuration([
        [10, 30],
        [40, 50],
        [5, 15],
        [12, 18],
        [60, 55], // 负区间按 0 处理
      ]),
    ).toBe(35);
  });

  it('2. header() 注入时钟后按 auth / d1 / agent / total 固定顺序输出且省略未发生类别', () => {
    let tick = 100;
    const timing = new RequestTiming(() => tick);
    timing.record('agent', 110, 260.46, 'tcp');
    timing.record('d1', 102, 114.24);
    timing.record('d1', 105, 118.25); // 并行交叠 => 并集 118.25 - 102 = 16.25ms
    tick = 300.14;
    expect(timing.header()).toBe(
      'd1;dur=16.3;desc="n=2", agent;dur=150.5;desc="n=1 tcp", total;dur=200.1',
    );
  });

  it('3. 非法 detail token（含引号、逗号、URL 等）被白名单丢弃', () => {
    let tick = 0;
    const timing = new RequestTiming(() => tick);
    timing.record('agent', 10, 20, 'fetch');
    timing.record('agent', 25, 30, 'bad"quote');
    timing.record('agent', 30, 35, 'bad,comma');
    timing.record('agent', 35, 40, 'https://secret.internal/nd_123');
    tick = 50;
    const header = timing.header();
    expect(header).toBe('agent;dur=25.0;desc="n=4 fetch", total;dur=50.0');
    expect(header).not.toContain('secret');
    expect(header).not.toContain('bad');
  });

  it('4. timed：无上下文直通；上下文跨 await 传递；异常仍计时且并发隔离', async () => {
    expect(currentTiming()).toBeUndefined();
    expect(await timed('d1', async () => 42)).toBe(42);

    const runOne = async (delayMs: number, shouldThrow: boolean) => {
      let now = 0;
      const timing = new RequestTiming(() => now);
      return runWithTiming(timing, async () => {
        const exec = timed('auth', async () => {
          await new Promise((r) => setTimeout(r, delayMs));
          now += delayMs;
          if (shouldThrow) throw new Error('boom');
          return delayMs;
        });
        if (shouldThrow) {
          await expect(exec).rejects.toThrow('boom');
        } else {
          await exec;
        }
        return timing.summary();
      });
    };

    const [a, b] = await Promise.all([runOne(15, false), runOne(30, true)]);
    expect(a.auth?.count).toBe(1);
    expect(a.auth?.dur).toBe(15);
    expect(b.auth?.count).toBe(1);
    expect(b.auth?.dur).toBe(30);
    expect(currentTiming()).toBeUndefined();
  });
});

describe('server-timing: instrumentD1 与 instrumentAgent', () => {
  it('5. 包装 sqlite-d1 的 toD1：run/first/all 结果一致且 d1 计数为 3', async () => {
    const raw = openRawDatabase();
    raw.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
    const db = instrumentD1(toD1(raw));

    const timing = new RequestTiming(() => 0);
    await runWithTiming(timing, async () => {
      await db.prepare('INSERT INTO items (id, name) VALUES (?, ?)').bind(1, 'alpha').run();
      const one = await db.prepare('SELECT id, name FROM items WHERE id = ?').bind(1).first<{ id: number; name: string }>();
      const list = await db.prepare('SELECT id, name FROM items').all<{ id: number; name: string }>();
      expect(one).toEqual({ id: 1, name: 'alpha' });
      expect(list.results).toEqual([{ id: 1, name: 'alpha' }]);
    });
    expect(timing.summary().d1?.count).toBe(3);
    raw.close();
  });

  it('6. batch() 传入包装语句时必须解包回原生语句且计数 1', async () => {
    const rawStatements = new WeakSet<object>();
    let batchReceived: unknown[] = [];
    const fakeD1 = {
      prepare(sql: string) {
        const stmt = {
          sql,
          bind: (..._args: unknown[]) => {
            const bound = { sql, rawMarker: true };
            rawStatements.add(bound);
            return bound;
          },
        };
        rawStatements.add(stmt);
        return stmt;
      },
      async batch(statements: unknown[]) {
        batchReceived = statements;
        return statements.map(() => ({ success: true }));
      },
    } as unknown as D1Database;

    const db = instrumentD1(fakeD1);
    const timing = new RequestTiming(() => 0);
    await runWithTiming(timing, async () => {
      const s1 = db.prepare('INSERT 1');
      const s2 = db.prepare('INSERT 2').bind(123);
      await db.batch([s1, s2]);
    });

    expect(batchReceived).toHaveLength(2);
    expect(rawStatements.has(batchReceived[0] as object)).toBe(true);
    expect(rawStatements.has(batchReceived[1] as object)).toBe(true);
    expect(timing.summary().d1?.count).toBe(1);
  });

  it('7. 带 #privateField 的 D1 类与 withSession() 经包装调用不抛 TypeError', async () => {
    class PrivateD1Session {
      #tag = 'session-secret';
      prepare(_sql: string) {
        const tag = this.#tag;
        return {
          bind: () => ({
            first: async () => ({ tag }),
          }),
        };
      }
      async exec(_sql: string) {
        return { count: 1, tag: this.#tag };
      }
      async batch(stmts: unknown[]) {
        return stmts.map(() => ({ tag: this.#tag }));
      }
    }

    class PrivateD1Database {
      #rootTag = 'root-secret';
      prepare(_sql: string) {
        const rootTag = this.#rootTag;
        return {
          all: async () => ({ results: [{ rootTag }] }),
        };
      }
      withSession(_constraint?: string) {
        return new PrivateD1Session();
      }
    }

    const db = instrumentD1(new PrivateD1Database() as unknown as D1Database);
    const timing = new RequestTiming(() => 0);
    await runWithTiming(timing, async () => {
      const rows = await db.prepare('SELECT 1').all<{ rootTag: string }>();
      expect(rows.results).toEqual([{ rootTag: 'root-secret' }]);
      const sess = (db as unknown as { withSession: (s: string) => PrivateD1Session }).withSession('first-unconstrained');
      const row = await sess.prepare('SELECT 2').bind().first();
      expect(row).toEqual({ tag: 'session-secret' });
      const ex = await sess.exec('SELECT 3');
      expect(ex).toEqual({ count: 1, tag: 'session-secret' });
    });
    expect(timing.summary().d1?.count).toBe(3);
  });

  it('8. instrumentD1(undefined) 原样返回 undefined', () => {
    expect(instrumentD1(undefined)).toBeUndefined();
  });

  it('9. instrumentAgent 原样透传参数并记录 via 传输 token', async () => {
    const fake = new FakeAgentClient();
    const wrapped = instrumentAgent(fake);
    const node = {
      id: 'nd_a',
      endpoint: 'https://hub.example.com:8443',
      tunnelEndpoint: null,
      preferredRoute: 'direct' as const,
    };

    const timing = new RequestTiming(() => 0);
    await runWithTiming(timing, async () => {
      const res = await wrapped.call(node, 'tok', 'POST', '/apps/caddy/apply', { a: 1 }, {
        idempotencyKey: 'k1',
        timeoutMs: 4321,
      });
      expect(res.via).toBe('fetch');
    });

    expect(fake.requests).toEqual([
      { method: 'POST', path: '/apps/caddy/apply', body: { a: 1 }, idempotencyKey: 'k1', timeoutMs: 4321 },
    ]);
    expect(timing.summary().agent).toMatchObject({ count: 1, tokens: ['fetch'] });
  });
});

describe('server-timing: 端到端 HTTP 响应头与慢请求日志', () => {
  it('10. /health、401、404、/nodes/:id/state 与 HubUnreachableError 均带合乎规范的 Server-Timing', async () => {
    const ctx = makeTestContext();

    // (a) /api/v1/health：只有 total
    const healthRes = await ctx.app.request('/api/v1/health', {}, ctx.env);
    expect(healthRes.status).toBe(200);
    const healthTiming = healthRes.headers.get('server-timing') ?? '';
    expect(healthTiming).toMatch(/^total;dur=\d+\.\d$/);

    // (b) 未登录 /api/v1/nodes：401 且带 Server-Timing
    const unauthRes = await ctx.app.request('/api/v1/nodes', {}, ctx.env);
    expect(unauthRes.status).toBe(401);
    const unauthTiming = unauthRes.headers.get('server-timing') ?? '';
    expect(unauthTiming).toContain('auth;dur=');
    expect(unauthTiming).toContain('total;dur=');

    // 登录后
    const cookie = await loginAsAdmin(ctx);

    // (c) 未实现接口：404 带 auth
    const notFoundRes = await ctx.app.request('/api/v1/no-such-route', { headers: { cookie } }, ctx.env);
    expect(notFoundRes.status).toBe(404);
    const nfTiming = notFoundRes.headers.get('server-timing') ?? '';
    expect(nfTiming).toContain('auth;dur=');
    expect(nfTiming).toContain('total;dur=');

    // (d) /nodes/:id/state：包含 auth n=1、agent n=1 fetch、total，且不含节点 id 与 endpoint host
    const { id } = await createNode(ctx, cookie);
    const stateRes = await ctx.app.request(`/api/v1/nodes/${id}/state`, { headers: { cookie } }, ctx.env);
    expect(stateRes.status).toBe(200);
    const stateTiming = stateRes.headers.get('server-timing') ?? '';
    expect(stateTiming).toContain('auth;dur=');
    expect(stateTiming).toContain('desc="n=1"');
    expect(stateTiming).toContain('agent;dur=');
    expect(stateTiming).toContain('desc="n=1 fetch"');
    expect(stateTiming).toContain('total;dur=');
    expect(stateTiming).not.toContain(id);
    expect(stateTiming).not.toContain('hub.example.com');

    // (e) Agent 抛 HubUnreachableError：仍记录 agent n=1（无 via token）并带头
    ctx.agent.handler = async () => {
      throw new HubUnreachableError('节点离线', { direct: 'timed out' }, true);
    };
    const errRes = await ctx.app.request(
      `/api/v1/nodes/${id}/state`,
      { headers: authHeaders(cookie) },
      ctx.env,
    );
    const errTiming = errRes.headers.get('server-timing') ?? '';
    expect(errTiming).toContain('agent;dur=');
    expect(errTiming).toContain('desc="n=1"');
    expect(errTiming).toContain('total;dur=');
  });

  it('11. 慢请求日志：正常请求不打印；越过阈值打印且包含固定字段', async () => {
    const ctx = makeTestContext();
    const cookie = await loginAsAdmin(ctx);
    const { id } = await createNode(ctx, cookie);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    try {
      // 正常请求不打慢日志
      await ctx.app.request(`/api/v1/nodes/${id}/state`, { headers: { cookie } }, ctx.env);
      const timingLogsBefore = infoSpy.mock.calls.filter((call) => call[0] === '[timing] slow request');
      expect(timingLogsBefore).toHaveLength(0);

      // 在 Agent 调用期间把 performance.now() 向前推进超过 SLOW_REQUEST_LOG_MS
      let fakeNow = 10_000;
      const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => fakeNow);
      ctx.agent.handler = async () => {
        fakeNow += SLOW_REQUEST_LOG_MS + 120;
        return { status: 200, body: { ok: true } };
      };

      const slowRes = await ctx.app.request(`/api/v1/nodes/${id}/state`, { headers: { cookie } }, ctx.env);
      expect(slowRes.status).toBe(200);
      nowSpy.mockRestore();

      const timingLogsAfter = infoSpy.mock.calls.filter((call) => call[0] === '[timing] slow request');
      expect(timingLogsAfter).toHaveLength(1);
      expect(timingLogsAfter[0]?.[1]).toMatchObject({
        method: 'GET',
        path: `/api/v1/nodes/${id}/state`,
        status: 200,
        serverTiming: expect.stringContaining('total;dur='),
      });
    } finally {
      infoSpy.mockRestore();
    }
  });
});
