-- 0015: 全局证书增加自动同步到关联 Hub 开关（默认关闭，S4）
ALTER TABLE certificates ADD COLUMN auto_sync INTEGER NOT NULL DEFAULT 0;
