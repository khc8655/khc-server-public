interface WindowRecord {
  count: number;
  resetAt: number;
}

const memory = new Map<string, WindowRecord>();

/** 限流可用的存储：D1（生产主路径）与 KV（可选兼容），都缺省时退化为进程内 Map */
export interface RateLimitStores {
  db?: D1Database;
  kv?: KVNamespace;
}

/**
 * 固定窗口限流：
 * - 有 D1 时用单语句原子 upsert（跨 isolate 计数；生产未绑 KV，P1-C 起为主路径）
 * - 无 D1 但绑了 KV 时用 KV（最终一致，够用于登录防爆破）
 * - 两者都不可用/异常时退化为进程内 Map（本地 dev、单测）
 */
export async function allowRequest(
  stores: RateLimitStores,
  key: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const resetAt = now + windowSec;

  if (stores.db) {
    try {
      // 单语句完成"窗口过期重置 + 计数 +1"，D1 保证原子性，避免读改写竞态
      const row = await stores.db
        .prepare(
          `INSERT INTO rate_limit (key, count, reset_at) VALUES (?1, 1, ?3)
           ON CONFLICT(key) DO UPDATE SET
             count = CASE WHEN rate_limit.reset_at <= ?2 THEN 1 ELSE rate_limit.count + 1 END,
             reset_at = CASE WHEN rate_limit.reset_at <= ?2 THEN ?3 ELSE rate_limit.reset_at END
           RETURNING count`,
        )
        .bind(key, now, resetAt)
        .first<{ count: number }>();
      if (row && Number.isFinite(row.count)) return row.count <= limit;
    } catch {
      // 存储异常时继续尝试 KV/内存，避免阻塞登录主路径
    }
  }

  if (stores.kv) {
    try {
      const storageKey = `rl:${key}`;
      const raw = await stores.kv.get(storageKey);
      let record: WindowRecord = raw
        ? (JSON.parse(raw) as WindowRecord)
        : { count: 0, resetAt };
      if (record.resetAt <= now) record = { count: 0, resetAt };
      record.count += 1;
      await stores.kv.put(storageKey, JSON.stringify(record), {
        expirationTtl: Math.max(60, windowSec),
      });
      return record.count <= limit;
    } catch {
      // 存储异常时退回内存限流，避免阻塞登录主路径
    }
  }

  const record = memory.get(key);
  if (!record || record.resetAt <= now) {
    memory.set(key, { count: 1, resetAt });
    return true;
  }
  record.count += 1;
  return record.count <= limit;
}

/** 仅供测试使用 */
export function resetRateLimitForTests(): void {
  memory.clear();
}
