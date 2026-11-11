-- 0.8.1：app_configs 增加明文摘要列，供 GET /nodes 派生节点应用摘要时零解密读取。
-- 只存模式与计数（mode / peers / sites / forwards），禁止写入私钥、证书、密码或哈希；
-- 可空：旧版本 Worker 写入的行此列为 NULL，读取路径回退到解密派生，回填后不再发生。
ALTER TABLE app_configs ADD COLUMN summary_json TEXT;
