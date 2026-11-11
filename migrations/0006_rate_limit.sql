-- P1-C：登录限流计数（固定窗口）。
-- 生产 wrangler.toml 未绑定 KV，此前限流退化为单 isolate 内存计数（阶段一报告 P1-5）；
-- 改用现有 D1 做跨 isolate 计数，单语句原子 upsert（见 apps/api/src/lib/rate-limit.ts）。
CREATE TABLE IF NOT EXISTS rate_limit (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);
