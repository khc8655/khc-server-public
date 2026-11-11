-- 需求 1：面板代建 DNS 时把选定域名写进节点（安装命令据此自动带 --tls-cn）。
-- 可空列，存量节点保持 NULL（未绑定域名），无需回填。
ALTER TABLE nodes ADD COLUMN domain TEXT;
