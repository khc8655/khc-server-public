# khc-server

服务器运维遥控器 + 配置仓库：Cloudflare Worker 控制面 + React 面板 + 节点上的 Python Agent。

## 设计原则

- **按需连接**：面板打开才发请求，平时零流量；节点上的 Agent 只被动等待。
- **核心冻结 + 应用适配器**：加一个软件只加 `agent/adapters/<app>.py` 和 `apps/web/src/apps/<app>/page.tsx`，不改路由、表和契约。
- **配置仓库**：D1 存配置与版本，Worker 不解析应用配置；节点按 plan → apply → 回滚执行。
- **不剪断自己的线**：控制通道走公网 HTTPS，不走 WireGuard。

## 架构

```
面板（React，作为 Worker 静态资源）
   │
Cloudflare Worker + D1 ──HMAC + HTTPS──▶ 节点 khc-agent（Python 标准库）
                                          内核：鉴权 / plan-apply-回滚 / 原子写 / 端口登记 / 任务
                                          适配器：wireguard、caddy-site、certificates、port-forward、host-ops、app-catalog、node-exporter
```

节点接入方式三选一：域名 + 可信证书直连、Cloudflare Tunnel、IP 直连（明文，需显式确认）。见 `docs/runbook/node-onboarding.md`。

## 快速开始

```bash
pnpm install                      # 本机没 pnpm 时：npx pnpm@9.15.0 install
cp .dev.vars.example .dev.vars
pnpm db:migrate:local
pnpm dev:api                      # http://127.0.0.1:8787
pnpm dev:web                      # http://127.0.0.1:5173
./scripts/verify.sh               # 全量校验
```

节点上的 Agent 用面板「节点设置 → 安装 Agent」生成的命令安装，不要手工下载包。

## 目录

```
apps/api/            Worker（Hono + D1）
apps/web/            React 面板；src/apps/<app>/ 是应用页面
packages/contracts/  zod 契约（前后端唯一接口定义）
agent/               节点 Agent：khc/ 内核、adapters/ 适配器、tests/
migrations/          D1 schema（只增不改）
docs/                文档，索引见 docs/README.md
scripts/             verify、发版、测试脚本
```

## 文档

- 协作规则：`AGENTS.md`
- 文档索引：`docs/README.md`
- 发版与部署：`docs/engineering/release.md`（合并 main 即生产部署）
