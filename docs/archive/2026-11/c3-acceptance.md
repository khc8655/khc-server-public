# C3 验收记录（Caddy 站点 + 证书库）

> 日期：2026-10-26　环境：staging Worker + vm1-HK（Debian 12，Caddy 2.6.2）
> 链路：面板 → Worker（TCP，IP:8880）→ Agent（caddy-site / certificates）

## 已完成

| # | 场景 | 结果 |
|---|---|---|
| 1 | 自签证书签发（Agent `issue_selfsigned`） | ✅ 返回 certPem/keyPem/notAfter=`2027-01-23T18:03:49Z` |
| 2 | 证书入库（`POST /api/v1/certs`） | ✅ 列表/详情不回显 PEM；D1 密文 |
| 3 | 证书导出（`/certs/:id/material`） | ✅ 返回 PEM/KEY（审计 cert.material） |
| 4 | 设置写入/列表 | ✅ 列表只回显 key/updatedAt，无凭据泄漏 |
| 5 | `$cert` 密钥引用 | ✅ `plan/apply` 前解析为 `{certPem,keyPem,domains}`；缺失 400 |
| 6 | 站点保存 + plan | ✅ 生成 cert/key/Caddy 片段/Caddyfile import 变更 |
| 7 | 站点 apply | ✅ Caddy reload 成功；`caddy validate` Valid；HTTPS `https://site.test:8443` 返回 200 |
| 8 | 证书文件权限 | ✅ `caddy:caddy 0600`（内核 File owner 支持） |
| 9 | 私钥脱敏 | ✅ plan/apply diff 中私钥 PEM 替换为 `[已隐藏私钥]`，WireGuard `PrivateKey` 替换 |
| 10 | `hash_password` + BasicAuth | ✅ bcrypt `$2a$14$...`；升级测试机 Caddy 2.8.4 后 apply，无凭据 401、带凭据 200 |
| 11 | `inspect` | ✅ 到期/SAN 解析 |
| 12 | 状态 | ✅ caddy-site status：unit active、sites=1、validate ok、lastReloadOk=true |
| 13 | UI | ✅ 证书页（签发/列表/导出/删除）、设置页（DNS 凭据）、站点页（列表/添加/编辑/保存并生效）；截图 `docs/ui/shots/c3-*.png` |
| 14 | 自动化 | ✅ Agent 334 项、Worker/前端 63 项、typecheck/build/verify 全绿 |

### 真实 ACME DNS-01（2026-10-27，已通过）

- Hub 安装 acme.sh v3.1.7；用 Cloudflare DNS token + zone（仅环境变量/请求内存，未落仓库/日志）对 `acme-test.example.com` 生产签发。
- `issue_acme` 任务：done，ECDSA 证书，notAfter `2027-01-24T23:03:11Z`，SAN 正确；`POST /certs` 入库成功，列表不回显 PEM/KEY；测试证书已删除。
- 真实凭据验证完成；自动续期编排仍按 acme.sh cron（已安装），面板一键续期待后续。

## 待补

- ~~真实 ACME DNS-01~~（已通过）。
- ✅ 站点导入/导出前端已实现（预览/校验，保存不自动 apply）。
- ⏳ 证书二维码、面板内自动续期编排仍未做（acme.sh cron 已装）；非本期阻塞项。
- BasicAuth 已在 Caddy 2.8.4 真机验证；生产需 Caddy ≥2.8（2.6 只支持旧 `basicauth`）。
- Caddy 端口登记已通过内核 `port_claims(config)` 钩子接入（caddy-site 数组端口）；老适配器无影响。

## 关键命令

```bash
# 签发（经节点 Agent，无需应用配置）
POST /api/v1/nodes/:id/apps/certificates/issue_selfsigned  {"params":{"domains":["site.test"]}}
# 入库
POST /api/v1/certs  {name,domains,issuer,certPem,keyPem,notAfter}
# 站点引用
PUT /api/v1/nodes/:id/apps/caddy-site  {"config":{"sites":[{"domain":"site.test","listenPort":8443,"upstream":"127.0.0.1:18080","tls":{"mode":"manual","cert":{"$cert":"cert_..."}}}]}}
POST /api/v1/nodes/:id/apps/caddy-site/apply
```
