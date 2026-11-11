-- 6.4a：节点观测层入口（浏览器直连 Hub 的 HTTPS 域名）
ALTER TABLE nodes ADD COLUMN live_endpoint TEXT;
