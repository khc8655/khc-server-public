-- D6：记录最近一次 apply 失败摘要（JSON: {code, message, at?}）
-- 成功 apply 或重新保存配置后由 Worker 清空；旧行保持 NULL（向后兼容）。
ALTER TABLE app_configs ADD COLUMN last_apply_error TEXT;
