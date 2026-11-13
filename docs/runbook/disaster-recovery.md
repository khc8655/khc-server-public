# 控制面全丢重建 runbook（Worker / D1 / 主密钥）

> 状态：现行 ｜ 最后核验：2026-11-10 ｜ 关联：`docs/backup.md` §7/§8、`docs/engineering/d1-migrations.md`、`docs/engineering/release.md` §3
> 范围：生产 Worker 部署、D1 数据、`MASTER_ENC_KEY` 等控制面凭据全部或部分丢失后的重建与验证

本页只管"控制面怎么重建"；日常备份清单与密钥轮换 SOP 仍以 `docs/backup.md` 为权威。

## 0. 先判断损失到哪一层

| 层 | 判定方法 | 影响 |
|---|---|---|
| Worker 部署 | `curl https://panel.example.com/api/v1/health` 非 200，或 `npx wrangler deployments list` 为空 | 面板与 API 全不可用；**节点上的 Agent 与业务服务照常运行** |
| D1 数据 | `/api/v1/health` 的 `ok:true` 但 `/api/v1/nodes` 为空 / 500 | 节点、配置、审计、证书库丢失；**节点本机已应用配置不丢** |
| `MASTER_ENC_KEY` | 节点列表有记录但全部 `token 解密失败`，写入类操作报 `misconfigured` | 所有加密字段永久不可读（见 §1.2） |
| `SESSION_SECRET` / `ADMIN_PW_HASH` | 登录失败或每次刷新都掉线 | 只是登不进去，数据无损失 |
| Cloudflare 账号 / CI 凭据 | `wrangler whoami` 失败、GitHub Actions 无法部署 | 无法部署，但线上仍按最后一次部署运行 |

## 1. 各类丢失的实际后果（不要假设"节点会挂"）

### 1.1 D1 丢失
- 面板看到 0 个节点、0 条配置、0 条审计；证书库、DNS 凭据、SSH 公钥库全空。
- **Agent 不会停**：它按磁盘上已应用的配置继续跑（wireguard/caddy/端口转发都不依赖 Worker）。
- 恢复物只有导出物（`backups/*.sql`）；没有导出物则只能重建面板记录并逐节点重新接管。

### 1.2 `MASTER_ENC_KEY` 丢失（最麻烦的一类）
加密算法为 AES-GCM，密钥 = `SHA-256(MASTER_ENC_KEY)`（`apps/api/src/lib/crypto.ts`）。密钥丢了，以下**密文永久不可解**，没有后门：

- `nodes.token_enc`：面板无法再对任何节点签名 → 所有节点显示离线，升级/配置/运维动作全部不可用；
- `app_configs.config_json`：面板读不出配置（节点上的实际配置文件还在，可人工回填）；
- `certificates.cert_pem_enc/key_pem_enc`：证书库条目的内容不可读（服务器上的证书文件不受影响）；
- `settings`（CF DNS 凭据等）与 `tunnels.token_enc`：DNS 代建、隧道模式失效。

处置只有一条路：**换新钥 + 逐节点重建 token**（§4）。

### 1.3 `SESSION_SECRET` 丢失
仅使现有会话失效（所有人重新登录）；轮换即可，无数据影响。

### 1.4 `ADMIN_PW_HASH` 丢失
无法登录。用 `node scripts/hash-password.mjs '<新密码>'` 重新生成并写入 secret 即可。

### 1.5 `AGENT_RELEASE_PUBKEY` 丢失
安装/升级接口在 `ENVIRONMENT=production` 下 fail-closed（503）。公钥可从仓库常量 `agent/khc/release_verify.py` 与既有清单推出；私钥在仓库外 `<home>/Documents/alivm/.khc-local/release-keys/agent-release-private.pem`（见 `docs/agent-releases.md`）。

## 2. 重建前必须准备好的离线资料

- 最近一次 D1 导出物（`npx wrangler d1 export`，见 §3.2）；
- `MASTER_ENC_KEY` 离线副本（**与 D1 导出物分开存放**，见 `docs/backup.md` §7）；
- `ADMIN_PW_HASH` / `SESSION_SECRET` / `AGENT_RELEASE_PUBKEY` 的离线副本或再生成所需的私钥；
- Cloudflare：账户 ID、API Token（`Workers Scripts:Edit` + `D1:Edit`）；
- 入口拓扑：`panel.example.com` 为第三方边缘，**回源就是 `<worker-name>.<subdomain>.workers.dev`**（见 wrangler.toml 注释与 `docs/verification/2026-11-07/incident-workers-dev-as-origin.md`）。

## 3. 重建步骤

### 3.1 重建 Worker
```bash
cd /path/to/khc-server
git switch main && git pull
npx wrangler whoami                      # 确认账号
npx wrangler deploy                      # 或推 main 让 CI 的 deploy job 执行
npx wrangler secret put ADMIN_PW_HASH    # 见 §1.4
npx wrangler secret put SESSION_SECRET   # openssl rand -base64 32
npx wrangler secret put MASTER_ENC_KEY   # 优先用离线副本；确无副本才新生成（后果见 §1.2）
npx wrangler secret put AGENT_RELEASE_PUBKEY
```
`workers_dev` 必须保持 `true`（生产入口源站是 workers.dev，置 false 会整站 404/1042）。

### 3.2 重建 D1 并恢复数据

**回放前自检（必做）**：确认 dump 的 `enc:v2:<keyId>:` 与手上的密钥匹配，再决定是否回放。

```bash
export MASTER_ENC_KEY='<离线副本>'            # 仅在当前 shell，勿落盘
export MASTER_ENC_KEY_ID='<离线记录>'         # 缺省 k1
node scripts/verify-backup.mjs backups/*.sql --key-id "$MASTER_ENC_KEY_ID"
# 失败 = 密钥/keyId 不匹配：先解决密钥托管，不要急着回放
```

```bash
# 先确认还有没有导出物（没有就只能空库重建）
ls -lh backups/*.sql

# 建库（名字沿用 <d1-name>，id 会变，必须回写 wrangler.toml）
npx wrangler d1 create my-khc-db
# 把输出里的 database_id 写入 wrangler.toml 的 [[d1_databases]]

# 路线 A：有导出物 —— 导出物内含 CREATE TABLE + INSERT，可整库回放
npx wrangler d1 execute DB --remote --file=backups/khc-db-YYYYMMDD-HHMMSS.sql

# 路线 B：没有导出物 —— 空库全量建表（0001–0011 按序，见 d1-migrations.md）
for f in migrations/00*.sql; do npx wrangler d1 execute DB --remote --file="$f"; done
```
重新执行 `npx wrangler deploy`，让 Worker 绑定新的 `database_id`。

### 3.3 恢复入口
- `wrangler.toml` 的 `workers_dev = true`、`LIVE_ORIGINS` 含两个入口（`panel.example.com` 与 workers.dev）；
- 第三方边缘的源站保持指向 `<worker-name>.<subdomain>.workers.dev`；
- 部署后按 `docs/engineering/release.md` §3.2 的部署后校验核对 `/cdn-cgi/trace` 的 `h=` 与 `/api/v1/health`。

## 4. 主密钥真丢了的补救（逐节点重建 token）

前提：节点仍在线且 Agent 仍在跑。**不要卸载 Agent、不要勾选"清理本机服务"**，否则节点上已生效的配置会被清掉。

1. 生成新钥：`openssl rand -base64 32` → `npx wrangler secret put MASTER_ENC_KEY`（同时记录到离线备份）；
2. 面板删除旧节点记录（**取消勾选"同时清理本机服务"**）；
3. 重新创建同名节点，保存一次性返回的新 token；
4. 到节点写入新 token 并重启 Agent（保持原端口/监听地址不变）：
   ```bash
   sudo sh -c 'umask 077; printf "%s" "<新 token>" > /etc/khc-agent/token'
   sudo systemctl restart khc-agent
   curl -s http://127.0.0.1:<端口>/health     # 期望 {"ok":true,...}
   ```
5. 用 `/state` 里 `adapters[].config` 的现状回填面板配置，再逐个 `apply` 确认幂等（Hub 本机无变化）；
6. 重新录入证书库条目、CF DNS 凭据（`settings.cf_dns_accounts`）、隧道 Token、SSH 公钥——这些旧密文已不可解，只能人工重填。

## 5. 验证清单（全部通过才算恢复）

```bash
curl -s https://panel.example.com/api/v1/health          # ok:true, env=production
curl -s https://panel.example.com/api/v1/version         # version 与 commit 为本次部署
# 登录后：
#   GET /api/v1/nodes            → 节点数与预期一致，状态 online
#   GET /api/v1/nodes/:id/state  → reachable=true，adapters 与节点实际一致
#   GET /api/v1/certs            → 证书库条数正确、可打开
#   GET /api/v1/cf-dns/accounts  → DNS 凭据条数正确
#   设置页保存一次配置（写入审计）→ GET /api/v1/audit 新增一条
```
节点侧再核对一次 `/health` 版本回显与 `systemctl is-active khc-agent`；远程升级入口按 `docs/runbook/troubleshooting.md` §11 的纪律操作。

## 6. 演练建议

每季度用最近一次导出物在本地跑一遍"空库回放 + 只读核对"（`npx wrangler d1 execute DB --local --file=...`），确认导出物本身可用——**没有演练过的备份不算备份**。
