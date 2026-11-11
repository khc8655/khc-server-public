import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowRequest, resetRateLimitForTests } from '../src/lib/rate-limit';
import { makeTestContext } from './helpers/context';

/** 模拟 D1 rate_limit 表的单语句 upsert 语义（key 计数 + 窗口过期重置） */
class FakeD1 {
  readonly statements: Array<{ sql: string; params: unknown[] }> = [];
  fail = false;
  private rows = new Map<string, { count: number; resetAt: number }>();

  prepare(sql: string) {
    const self = this;
    return {
      bind: (...params: unknown[]) => ({
        first: async <T>() => {
          self.statements.push({ sql, params });
          if (self.fail) throw new Error('d1 unavailable');
          const [key, now, resetAt] = params as [string, number, number];
          const row = self.rows.get(key);
          if (!row || row.resetAt <= now) {
            self.rows.set(key, { count: 1, resetAt });
            return { count: 1 } as T;
          }
          row.count += 1;
          return { count: row.count } as T;
        },
      }),
    };
  }
}

/** 模拟 KV（get/put JSON） */
class FakeKV {
  private entries = new Map<string, string>();
  fail = false;

  async get(key: string): Promise<string | null> {
    if (this.fail) throw new Error('kv unavailable');
    return this.entries.get(key) ?? null;
  }

  async put(key: string, value: string, _opts?: { expirationTtl?: number }): Promise<void> {
    if (this.fail) throw new Error('kv unavailable');
    this.entries.set(key, value);
  }
}

beforeEach(() => resetRateLimitForTests());
afterEach(() => resetRateLimitForTests());

describe('rate-limit（P1-C：D1 固定窗口计数）', () => {
  it('D1 路径：窗口内累计计数，超限后拒绝', async () => {
    const db = new FakeD1();
    const stores = { db: db as unknown as D1Database };
    for (let i = 1; i <= 10; i += 1) {
      expect(await allowRequest(stores, 'login:1.2.3.4', 10, 300)).toBe(true);
    }
    expect(await allowRequest(stores, 'login:1.2.3.4', 10, 300)).toBe(false);
    // 不同 key 互不影响
    expect(await allowRequest(stores, 'login:5.6.7.8', 10, 300)).toBe(true);
    // 单语句 upsert（含 RETURNING count），绑定参数 (key, now, resetAt)
    expect(db.statements).toHaveLength(12);
    const first = db.statements[0];
    expect(first?.sql).toContain('RETURNING count');
    expect(first?.sql).toContain('ON CONFLICT(key)');
  });

  it('D1 异常时退化为内存限流，不阻塞登录主路径', async () => {
    const db = new FakeD1();
    db.fail = true;
    const stores = { db: db as unknown as D1Database };
    for (let i = 1; i <= 10; i += 1) {
      expect(await allowRequest(stores, 'login:1.2.3.4', 10, 300)).toBe(true);
    }
    expect(await allowRequest(stores, 'login:1.2.3.4', 10, 300)).toBe(false);
  });

  it('无 D1 有 KV 时走 KV 计数', async () => {
    const kv = new FakeKV();
    const stores = { kv: kv as unknown as KVNamespace };
    for (let i = 1; i <= 3; i += 1) {
      expect(await allowRequest(stores, 'login:1.2.3.4', 3, 300)).toBe(true);
    }
    expect(await allowRequest(stores, 'login:1.2.3.4', 3, 300)).toBe(false);
  });

  it('KV 异常时退化为内存限流', async () => {
    const kv = new FakeKV();
    kv.fail = true;
    const stores = { kv: kv as unknown as KVNamespace };
    expect(await allowRequest(stores, 'login:1.2.3.4', 1, 300)).toBe(true);
    expect(await allowRequest(stores, 'login:1.2.3.4', 1, 300)).toBe(false);
  });

  it('两者都缺省时内存限流仍生效', async () => {
    expect(await allowRequest({}, 'login:x', 2, 300)).toBe(true);
    expect(await allowRequest({}, 'login:x', 2, 300)).toBe(true);
    expect(await allowRequest({}, 'login:x', 2, 300)).toBe(false);
  });

  it('登录集成：D1 计数下第 11 次错误口令返回 429，正常登录同窗口内仍可用', async () => {
    const ctx = makeTestContext();
    const env = { ...ctx.env, DB: new FakeD1() as unknown as D1Database } as typeof ctx.env;
    const request = (password: string) =>
      ctx.app.request(
        '/api/v1/auth/login',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password }),
        },
        env,
      );

    for (let i = 1; i <= 10; i += 1) {
      const res = await request('wrong-pass');
      expect(res.status).toBe(401);
    }
    // 第 11 次请求（即使口令正确）在窗口内被限流拒绝
    const blocked = await request('test-pass');
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error: { code: string } };
    expect(body.error.code).toBe('too_many_attempts');
    // 不同来源 IP 不受影响（cf-connecting-ip 区分）
    const other = await ctx.app.request(
      '/api/v1/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '9.9.9.9' },
        body: JSON.stringify({ password: 'test-pass' }),
      },
      env,
    );
    expect(other.status).toBe(200);
  });
});
