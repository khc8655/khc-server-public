-- khc-server v3 初始 schema：4 张表
-- 尚未上线，直接替换旧的 12 张表设计（design-v1 作废）。

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS task_events;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS app_instances;
DROP TABLE IF EXISTS apps;
DROP TABLE IF EXISTS certificates;
DROP TABLE IF EXISTS exposures;
DROP TABLE IF EXISTS peers;
DROP TABLE IF EXISTS node_keys;
DROP TABLE IF EXISTS node_transports;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS audit;
DROP TABLE IF EXISTS revisions;
DROP TABLE IF EXISTS app_configs;
DROP TABLE IF EXISTS nodes;

CREATE TABLE nodes (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  endpoint         TEXT NOT NULL,                 -- https://hub-a.example.com:8443
  tunnel_endpoint  TEXT,                          -- 可选：cloudflared 兜底地址
  preferred_route  TEXT NOT NULL DEFAULT 'direct'
                   CHECK (preferred_route IN ('direct', 'tunnel')),
  token_enc        TEXT NOT NULL,                 -- AES-GCM(token)，Worker 解密后用于 HMAC
  last_seen_at     INTEGER,
  last_state_json  TEXT,                          -- deprecated: 运行快照不落库; 0005 清空
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE app_configs (
  node_id         TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  app             TEXT NOT NULL,                  -- 'node-exporter' / 'wireguard' / ...
  schema_version  INTEGER NOT NULL,
  config_json     TEXT NOT NULL,                  -- 不透明 JSON，Worker 不解析
  secrets_enc     TEXT,                           -- 可选：需要回显给用户的密钥（AES-GCM）
  rev             INTEGER NOT NULL,
  applied_rev     INTEGER,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (node_id, app)
);

CREATE TABLE revisions (
  node_id      TEXT NOT NULL,
  app          TEXT NOT NULL,
  rev          INTEGER NOT NULL,
  config_json  TEXT NOT NULL,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (node_id, app, rev)
);

CREATE TABLE audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  actor       TEXT,
  node_id     TEXT,
  app         TEXT,
  action      TEXT,
  detail_json TEXT
);

CREATE INDEX idx_app_configs_node ON app_configs(node_id);
CREATE INDEX idx_revisions_lookup ON revisions(node_id, app, rev DESC);
CREATE INDEX idx_audit_at ON audit(at DESC);
