-- PR1：把「接入方式」从节点表单里的零散字段收敛为显式模式，
-- 并把 Cloudflare Tunnel 的域名/源站端口/Token 提升为全局配置，供节点引用。
-- 只增不改：存量节点 access_mode 保持 NULL（读取时按 endpoint/preferred_route 推导）。
ALTER TABLE nodes ADD COLUMN access_mode TEXT;
ALTER TABLE nodes ADD COLUMN tunnel_id TEXT;
ALTER TABLE nodes ADD COLUMN allow_insecure INTEGER NOT NULL DEFAULT 0;

-- 全局隧道配置：面板只存配置（不调用 Cloudflare API 做 CRUD），安装命令据此生成。
CREATE TABLE IF NOT EXISTS tunnels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL UNIQUE,
  origin_port INTEGER NOT NULL,
  token_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
