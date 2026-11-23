-- 节点绑定全局证书库记录（https 域名接入直连时，首次安装直接拉取导入，续期自动同步）
ALTER TABLE nodes ADD COLUMN tls_cert_id TEXT;
