-- 数据分层：运行快照不再写入 D1。
-- 旧版本曾把完整 Agent /state 写入 nodes.last_state_json；这里清除历史数据，
-- 列保留为空并停止使用，避免已有部署迁移时重建表。
UPDATE nodes SET last_state_json = NULL;
