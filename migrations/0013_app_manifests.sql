-- R1：全局应用清单（架子）。脚本正文与元数据属于配置，符合「D1 只存配置」。
-- 只存定义，不存执行结果、不存凭据；脚本 sha256 在定义体内，与正文成对。
-- enabled=0 仅禁止新安装，不影响节点上已装实例。
CREATE TABLE IF NOT EXISTS app_manifests (
  id TEXT PRIMARY KEY,
  manifest_json TEXT NOT NULL,
  version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
