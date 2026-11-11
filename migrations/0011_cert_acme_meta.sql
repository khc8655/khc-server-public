-- PR2：证书库记录 ACME 签发参数，支持一键续期与「签发→安装到节点」的自动化。
-- 只增不改；旧证书（manual/selfsigned）这些列为 NULL，renewable 由仓库计算。
ALTER TABLE certificates ADD COLUMN acme_provider TEXT;
ALTER TABLE certificates ADD COLUMN acme_credential_key TEXT;
ALTER TABLE certificates ADD COLUMN acme_ca TEXT;
ALTER TABLE certificates ADD COLUMN acme_key_type TEXT;
