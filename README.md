# khc-server

服务器运维遥控器 + 配置仓库：**Cloudflare Workers 控制面 + React 面板 + Hub 上的 Python Agent**。

> **状态**：已上线（生产与"staging"复用同一 Worker/D1，见 ADR-0008）；C1–C3 + 6.4a + VM 运维 + Caddy + host-ops（含 call_task）+ 端口转发/备份恢复 + 诊断 + 双模式 + Agent 生命周期命令 + 全站 UI 统一改造（ui-redesign）已实现。
> **与旧项目的关系**：完全独立。旧 `mgmt-console` / Cloudflare Pages 继续保留可用；本项目不使用旧 D1、不迁移旧数据。

## 设计原则

- **按需连接**：面板打开才发请求；平时零流量，Hub 上的 Agent 只被动等待。
- **核心冻结 + 应用适配器**：加一个软件 = `agent/adapters/<app>.py` + `apps/web/src/apps/<app>/page.tsx`，不改路由/表/契约。
- **配置仓库**：D1 存配置与版本（`app_configs` + `revisions`），Worker 不解析 config。
- **不会剪断自己的线**：控制通道走公网 HTTPS，不走 WireGuard；改 WG 密钥用「先加后删 + 握手确认」。

## 架构

```
面板（React，Worker 静态资源）
   │  打开：并发拉各节点 /state（3s 超时）
   │  应用：Worker → Hub Agent（HMAC，直连 8880 或 cloudflared 兜底）
   ▼
Cloudflare Worker + D1（nodes / app_configs / revisions / audit）
   ▼
Hub：khc-agent（Python 标准库，默认监听 0.0.0.0:8880；隧道模式可收敛到 127.0.0.1）
     内核：鉴权 / plan-apply-回滚 / 原子写 / 端口登记 / 任务 / Caddy 片段
     adapters/：node-exporter、wireguard、caddy-site、certificates、port-forward、host-ops
```

不使用 KV / R2 / Durable Object / Cron / Queue / WebSocket。

## 文档

- 📐 **[架构设计 v3（当前，定稿）](docs/design-v3.md)**
- 🗺️ **[v4 实施规划（待拍板：传输修正 / 功能对齐 / UI 规范）](docs/plan-v4.md)**
- 🎨 **[UI 规范（ui-redesign，强制）](docs/ui-redesign/ui-guidelines.md)** ＋ [路由与区块映射](docs/ui-redesign/page-specs.md)（设计令牌：`apps/web/src/styles/tokens.css`）
- 📋 **[旧系统功能清单与 v3 归属](docs/legacy-feature-inventory.md)**
- 📚 **[文档地图（现行权威表 + 归档索引）](docs/README.md)**

历史文档（v1/v2 设计、验收记录、UI v2.2 规范、变更单 001–016 等）见 `docs/archive/`。

## 快速开始

```bash
pnpm install                      # 本机没 pnpm 时：npx pnpm@9.15.0 install
cp .dev.vars.example .dev.vars    # 填 ENVIRONMENT / ADMIN_PASSWORD / SESSION_SECRET / MASTER_ENC_KEY
pnpm db:migrate:local
pnpm dev:api                      # http://127.0.0.1:8787
pnpm dev:web                      # http://127.0.0.1:5173
```

校验：

```bash
pnpm typecheck
pnpm test                         # Worker/前端 vitest
python3 -m unittest discover -s agent/tests -t agent   # Agent 单测
```

全量校验用 `./scripts/verify.sh`；**测试数量以 verify.sh 实测输出为准**，文档不写死数字。

## 部署与环境

- 部署走 CI 自动部署（`.github/workflows/ci.yml` 的 `deploy` job，`main` 合并即发版）。
- **生产与 "staging" 复用同一个 Worker（`<worker-name>`）与同一个 D1（`<d1-name>`），配置唯一来源是 `wrangler.toml`（`ENVIRONMENT=production`，见 [ADR-0008](docs/engineering/adr/ADR-0008-production-reuses-staging.md)）。** 上线前冒烟走 `npx wrangler versions upload` + 预览 URL（不切生产流量），流程见 [release.md §4](docs/engineering/release.md)；原 `wrangler.staging.toml` 已于 2026-11-03 删除。
- D1 迁移操作见 [docs/engineering/d1-migrations.md](docs/engineering/d1-migrations.md)。
- 节点地址必须是**域名**（Workers 原生 fetch 不能访问裸 IP，会返回 403 error 1003；裸 IP 走 `cloudflare:sockets`）。

## Hub 上安装 Agent

```bash
tar xzf khc-agent-0.1.0.tar.gz && cd khc-agent
sudo ./install.sh --port 8880           # 系统模式；无 root 用 --user
KHC_TOKEN=<面板创建节点时返回的 token>   # 写入 /etc/khc-agent/agent.env 后重启
sudo ./uninstall.sh --purge             # 一条命令清干净
```

默认直连 `http://<IP 或域名>:8880`（HMAC 鉴权）；需要 TLS 时用 Caddy 8443 反代或 cloudflared 隧道。

## 目录结构

```
apps/api/           # Cloudflare Worker（Hono + D1）
apps/web/           # React 面板（TanStack Router/Query + Tailwind）
apps/web/src/apps/  # 应用页面（加应用只加这里 + agent/adapters）
packages/contracts/ # zod 契约 + TS 类型（前后端共用）
agent/              # Hub Agent（Python 标准库）+ 适配器 + 安装/卸载脚本 + 测试
migrations/         # D1 schema（已应用 0001–0011；业务表 9 张：nodes/app_configs/revisions/audit/certificates/settings/rate_limit/ssh_keys/tunnels）
docs/               # 设计 / 规范 / 工程流程（历史文档见 docs/archive/）
wrangler.toml
```

## 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| C1 | Worker 4 表 + 通用路由 + Agent 内核 + node-exporter 全流程 | ✅ 已完成 |
| C2 | wireguard 适配器 + 无损换钥状态机 + 客户端配置（二维码待补） | ✅ 已完成 |
| C3 | caddy-site / 证书库 / port-forward | ✅ 已完成 |

## 开发约定

- Node 22+ / pnpm 9+ / Python 3.11+；不提交真实凭据（`.dev.vars`、私钥目录已 gitignore）。
- 生产操作只由主人执行；Agent 与 Worker 不自动部署生产。


## CI 缓存

- Actions cache 通过 `.github/workflows/cache-cleanup.yml` 每天清理超过 7 天的条目。
- 默认 GitHub cache 的 7 天未访问回收仍然有效；主动清理避免共享存储配额被旧 pnpm store 占用。
