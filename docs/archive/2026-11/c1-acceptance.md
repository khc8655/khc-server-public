# C1 验收记录

> 日期：2026-10-25　环境：本地 Worker（wrangler dev）+ 真实测试机 `vm1-HK`（203.0.113.12，Debian 12 x86_64）
> 链路：本地面板/API → Worker → 公网 HTTP:8788 → khc-agent → systemd / node_exporter

## 验收项与结果

| # | 场景 | 结果 |
|---|---|---|
| 1 | 创建节点返回一次性 token | ✅ 201，token 43 字符；GET 详情不回显 |
| 2 | Worker → Agent `/state`（HMAC） | ✅ `reachable:true`，返回 host/adapters/ports |
| 3 | 保存配置到 D1（不碰 Hub） | ✅ rev 1，revisions 落库 |
| 4 | `plan` 预览 diff | ✅ 返回 args + unit 两个文件的 diff |
| 5 | `install` 异步任务 | ✅ taskId，日志显示下载 GitHub 包，5.66s 完成 |
| 6 | `apply` 写入并启动 | ✅ appliedRev=1；`systemctl is-active` = active/enabled |
| 7 | 公网访问 node_exporter | ✅ `:9100/metrics` 返回 200 |
| 8 | 改配置 rev2（9100→9101）再 apply | ✅ appliedRev=2；9101 通、9100 关闭 |
| 9 | 回滚到 rev1 | ✅ 生成新 rev3、appliedRev=3；9100 恢复、9101 关闭 |
| 10 | `uninstall --purge` | ✅ 0.82s 完成；unit/文件/端口清理，state 显示 installed=false |
| 11 | 清理测试机 | ✅ 进程/端口/目录/unit 全部清除 |

## 自动化测试

- Worker/前端：`pnpm test` → **35 passed / 9 files**
- Agent：`python3 -m unittest discover -s agent/tests -t agent` → **150 passed**
- 类型检查：`pnpm typecheck` → 3 包全过
- 构建：`pnpm build` → 457 KB JS（141 KB gzip）

## 已知限制（C1）

- Agent 不终结 TLS：只监听 127.0.0.1，由 Caddy/隧道对外（符合设计）。
- 任务取消只有内核 API，暂未暴露 HTTP 路由。
- WireGuard / Caddy 站点 / 端口转发适配器在 C2/C3。

## P0 传输修正复测（2026-10-26）

背景：`fetch()` 对裸 IP 一律 `403 error 1003`（与端口无关）；改为 `fetch + cloudflare:sockets` 双通道。

| # | 场景 | 结果 |
|---|---|---|
| 1 | Node 地址允许裸 IP（`http://203.0.113.12:8880`） | ✅ PATCH 200 |
| 2 | `GET /state` 经 IP + 8880 | ✅ `reachable:true, via:"tcp"` |
| 3 | `GET /state` 经域名 + 8880（sslip.io） | ✅ `reachable:true, via:"fetch"` |
| 4 | `POST /apps/node-exporter/plan` 经 TCP | ✅ 返回 2 条 diff、warnings 正常 |
| 5 | Agent 默认监听 | ✅ `0.0.0.0:8880`（`/health` 公网 200） |

实现：`apps/api/src/lib/tcp-fetch.ts`（HTTP/1.1 手写解析、Content-Length/chunked/close、8s 超时、1MiB 上限）。
