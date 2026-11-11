# C3 设计：Caddy 站点 + 证书库

> 状态：已获主人批准开始（2026-10-26）。依据 plan-v4 与 UI 规范 v2.2。

## 1. 范围

- **证书库（全局）**：签发（ACME DNS-01 / 自签）、手动导入、元数据/到期、跨 Hub 复用、导出、删除。
- **Caddy 站点（节点层）**：域名/监听端口/上游/证书引用/TLS 模式/BasicAuth/Header/TLS1.3/启用；`caddy validate` 门禁 + 平滑 reload。
- **不在本期**：证书自动续期的控制面编排（acme.sh 自身 cron 续期 + reloadcmd 保留）、多用户权限、证书透明度日志。

## 2. 数据模型（migration 0002）

```sql
CREATE TABLE certificates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domains_json TEXT NOT NULL,
  issuer TEXT,                      -- acme / selfsigned / manual
  not_after INTEGER,
  cert_pem_enc TEXT NOT NULL,       -- AES-GCM
  key_pem_enc TEXT NOT NULL,        -- AES-GCM
  source_node_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,             -- 如 dns.cloudflare
  value_enc TEXT NOT NULL,          -- AES-GCM JSON（只写不读）
  updated_at INTEGER NOT NULL
);
```
- 证书 PEM/KEY 与 DNS 凭据都加密；`MASTER_ENC_KEY` 丢失不可恢复。
- 迁移只新增 0002，不改 0001。

## 3. 密钥引用（核心，对适配器透明）

应用配置里可写占位符：

```json
{ "$cert": "cert_xxx", "$dnsCred": "dns.cloudflare" }
```

- Worker 在转发 `plan/apply/自定义动作` 前递归解析：
  - `$cert` → `{ "certPem": "...", "keyPem": "...", "domains": [...] }`
  - `$dnsCred` → 解密后的凭据对象（仅注入到动作 payload，不落 config）
- 缺失/解密失败 → 400 `cert_not_found` / `secret_not_found`，不调用 Agent。
- GET 配置仍返回占位符；UI 用证书下拉选择，不读取私钥。

## 4. Worker API

| 路由 | 说明 |
|---|---|
| `GET /api/v1/certs` | 列表（不含 PEM） |
| `POST /api/v1/certs` | 创建/导入（name/domains/issuer/notAfter/certPem/keyPem/sourceNodeId） |
| `DELETE /api/v1/certs/:id` | 删除；被站点引用时返回 409 |
| `GET /api/v1/certs/:id/material` | 管理员导出 PEM/KEY（审计） |
| `GET /api/v1/settings` | 设置键列表（脱敏） |
| `PUT /api/v1/settings/:key` | 写入（value 任意 JSON，加密） |
| `DELETE /api/v1/settings/:key` | 删除 |

## 5. Agent 适配器契约

### 5.1 `caddy-site`
配置：
```json
{
  "sites": [{
    "name": "blog",
    "domain": "blog.example.com",
    "listenPort": 443,
    "upstream": "10.99.0.2:8080",
    "tls": { "mode": "auto|manual|off", "cert": {"$cert": "cert_x"} },
    "basicauth": { "user": "u", "password": "p" },
    "headers": {"X-Frame-Options": "DENY"},
    "forceTls13": true,
    "enabled": true
  }]
}
```
- render `CaddySnippet` → `/etc/caddy/khc.d/caddy-site.caddy`（`import khc.d/*` 缺失时追加一次）；
- `caddy validate` 失败不 reload；reload 失败回滚；
- 端口登记 tcp/443 或 tcp/8443；
- 自带文件证书写入 `/etc/caddy/certs/<domain>.crt/.key`（0600），`manual` 模式引用；
- `status`：站点数、Caddy active、最近错误；
- `after_apply`：`caddy reload`。

### 5.2 `certificates`
动作（async task）：
- `issue_selfsigned` params `{domains[], days?}` → 返回 `{certPem,keyPem,notAfter,issuer:"selfsigned"}`；
- `issue_acme` params `{domains[], provider, credentials, ca?, keyType?}` → 调用 acme.sh DNS-01；返回 PEM；进度/日志；
- `inspect` params `{certPem}` → 解析到期/域名（openssl）。
- 不负责持久化：面板拿到 PEM 后 POST `/api/v1/certs` 入库。

## 6. UI

- 全局「证书」页（T2）：列表（域名/签发方式/到期/来源）、签发抽屉（ACME/自签/导入）、导出、删除。
- 节点「站点」页（T2）：列表、添加站点抽屉（域名/端口/上游/证书选择/TLS/BasicAuth/Header）、保存并生效、状态探测。
- 变更单 #003（证书）、#004（站点）另行提交。

## 7. 验收

- 自签证书：签发→入库→站点引用→apply→HTTPS 可访问。
- 手动导入：PEM/KEY 校验配对→入库→站点引用→apply。
- 坏配置：`caddy validate` 失败不 reload、旧 Caddyfile 不变。
- 跨 Hub：证书从 A 导出/在 B 的站点引用（同一 D1 vault）。
- ACME 用 mock 走通任务/错误分支（真实 DNS 凭据由主人后续提供）。
