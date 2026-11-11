-- C3：全局证书库 + 全局设置（DNS 凭据等）
-- 只新增；不改 0001。所有私钥/凭据均以 AES-GCM 密文保存（Worker 加解密）。

CREATE TABLE certificates (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  domains_json   TEXT NOT NULL,
  issuer         TEXT,
  not_after      INTEGER,
  cert_pem_enc   TEXT NOT NULL,
  key_pem_enc    TEXT NOT NULL,
  source_node_id TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_enc  TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_certificates_not_after ON certificates(not_after);
