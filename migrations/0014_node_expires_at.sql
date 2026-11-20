-- 节点固定到期日期（YYYY-MM-DD，可选；不自动顺延）
ALTER TABLE nodes ADD COLUMN expires_at TEXT;
