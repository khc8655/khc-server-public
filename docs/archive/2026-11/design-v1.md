# khc-server v1 架构设计

> **项目代号**：`khc-server`
> **定位**：全新一代多节点控制台（Cloudflare Workers + 全新前端 + Python Node Agent + 应用模块）
> **状态**：设计草案 v1（2026-10-25），待主人评审后建仓
> **⚠️ 修订**：连接层（§6/§7 的 Agent 协议、心跳/WS/任务租约）已由 [`design-v2-simple.md`](design-v2-simple.md) 取代；本文件的数据模型、前端、安全模型仍有效。
> **与旧版关系**：**完全独立**。旧 `mgmt-console` / Pages 项目原样保留、继续可用；本项目全新仓库、全新 Workers 项目、全新 D1、全新前端，不做数据迁移、不做兼容层。

---

## 0. 一页摘要

**要解决的问题**（来自主人）：

1. 前后端不分离、配置不分离、模块不分离——改任何东西都要发版动代码。
2. 只能用 WireGuard，想换成不需要 root 的连接方式但换不了。
3. 改 peer 密钥很痛苦。
4. 加应用 = 跑一个一键安装脚本，返回登录地址/token 之类的信息，能在面板展示。

**方案一句话**：

> 控制面搬到 **Cloudflare Workers**，前端用 **React + TypeScript** 重写；节点上跑 **Python Node Agent**（只出站、不监听公网端口、可接管现有配置）；应用以**签名模块包**分发，安装脚本返回结构化结果，面板按 schema 渲染；连接方式抽象成**可替换的 transport**，先支持 WireGuard，后续接非 root 方案。

**已确定的决策**：

| # | 决策 | 结论 |
|---|---|---|
| D1 | 代码形态 | 全新独立仓库 `khc-server`，与旧仓库零耦合 |
| D2 | 控制面 | 新建 Cloudflare Workers 项目（含静态资源），不使用 Pages |
| D3 | 数据库 | **全新 D1** + 干净 schema；不读旧库、不兼容旧 kv |
| D4 | Agent | **继续 Python**（增量改造，不重写 Go）；Hub 侧只跑一个 Python 升级脚本完成接管 |
| D5 | 前端 | **React 19 + TypeScript + Vite**，shadcn/ui + Tailwind，全新写 |
| D6 | 应用模型 | 模块 = `module.json` + 安装/状态/卸载脚本；安装结果按 schema 展示 |
| D7 | 传输 | transport provider 抽象；首期 WireGuard，后续加非 root 方案 |
| D8 | 接管方式 | adopt（只读扫描）→ 渲染 → 脱敏 diff 为 0 → 接管；peer 密钥不变 |

---

## 1. 目标与非目标

### 1.1 目标

- **G1 分层**：前端 / API / 领域逻辑 / 数据访问 / Agent / 模块 六层清晰分离，各自可独立测试。
- **G2 配置分离**：部署配置（Worker env）、业务配置（D1）、模块配置（`module.json`）、Agent 配置（`agent.env`）互不混杂。
- **G3 加应用不发版**：发布模块包 + 上传 R2，面板自动出现；安装/卸载/升级走任务队列。
- **G4 连接方式可替换**：业务只声明"要访问哪个节点的哪个服务"，由 transport 解析地址；后续可加 Tailscale / cloudflared / frp / ssh -R。
- **G5 密钥可轮换**：peer 密钥、Agent token、签名 key 都有明确的版本与轮换流程，双 key 过渡、可回滚。
- **G6 安全默认**：Hub 不暴露管理端口（Agent 只出站）；敏感字段不回显；所有变更进审计。
- **G7 可接管**：新系统能只读扫描现有 Hub 的 WG/Caddy/转发/证书状态，证明"接管后配置不变"再接管。

### 1.2 非目标

- 不做旧数据迁移、不兼容旧 `kv` 结构、不做双写、不做灰度开关。
- 不重写 Go Agent。
- 不做第三方插件市场 / 完整沙箱（模块均为自有、离线签名，先按第一方信任模型）。
- 不做多租户 / 多管理员 RBAC / WebSocket 长连接 / i18n（当前只有中文）。
- 不迁移旧 Pages 的证书/备份历史数据（需要时手工重录，3 台 Hub 成本可接受）。

---

## 2. 总体架构

```
                        ┌──────────────────────────────────────────────┐
                        │         Cloudflare Workers (worker)       │
  浏览器 ── HTTPS ──────▶│  Static Assets (React SPA)                    │
                        │  /api/v1/*  Worker API (Hono + zod)           │
                        │                                               │
                        │  D1   nodes/transports/peers/exposures/...    │
                        │  KV   限流 / 缓存 / 一次性 enroll code         │
                        │  R2   模块包 / Agent 包 / 备份                 │
                        │  Cron 健康巡检 / 证书到期 / 任务清理           │
                        └───────────────▲──────────────────────────────┘
                                        │ 只出站 HTTPS（心跳 / 拉期望 / 领任务 / 回报）
                        ┌───────────────┴──────────────────────────────┐
                        │        Python Node Agent（Hub / Peer）        │
                        │  core：fsguard / render / caddy / wg / fwd    │
                        │  transports：wireguard / tailscale / ...      │
                        │  modules：签名包安装、结果回报                  │
                        │  不监听公网端口（调试仅 doctor 命令）           │
                        └───────────────┬──────────────────────────────┘
                                        │
                     ┌──────────────────┴───────────────────┐
                     │  Hub 本机：wg0 / Caddy / ssh-fwd 单元   │
                     │  Peer 本机：WG 或非 root 传输客户端     │
                     └──────────────────────────────────────┘
```

**核心原则**：

1. **控制面只描述期望状态**，Agent 负责收敛；控制面不直接 SSH、不直接改 Hub 文件。
2. **Agent 只出站**，Hub 不需要开放管理端口；没有入站监听就没有公网管理面。
3. **私钥不离开节点**（服务端 WG 私钥、模块本地密钥）；控制面只存结构与脱敏哈希。
4. **一切变更可回滚**：Agent 保留上一份配置/二进制；控制面保留任务结果与审计。
5. **契约先行**：API 请求/响应 schema 在 `packages/contracts` 定义，前后端共用。

---

## 3. 仓库结构

```
khc-server/
├── apps/
│   ├── api/                    # Cloudflare Worker
│   │   ├── src/
│   │   │   ├── index.ts        # fetch handler + 路由挂载
│   │   │   ├── routes/         # auth / nodes / peers / exposures / apps / tasks / agent
│   │   │   ├── domain/         # 纯领域逻辑（无 IO）
│   │   │   ├── db/             # D1 访问层（每张表一个 repo）
│   │   │   ├── render/         # 期望状态渲染器（WG conf / Caddyfile / 转发单元）
│   │   │   ├── services/       # 编排（adopt、任务、密钥轮换）
│   │   │   └── middleware/     # session、agent auth、rate limit、audit
│   │   └── test/
│   └── web/                    # React SPA
│       ├── src/
│       │   ├── app/            # 布局、路由、鉴权守卫、错误边界
│       │   ├── features/       # nodes / peers / exposures / apps / tasks / audit / onboard
│       │   ├── shared/         # ui / api client / hooks / form renderer
│       │   └── stores/         # 仅 auth、主题
│       └── test/
├── packages/
│   ├── contracts/              # zod schema + TS 类型（前后端共用）
│   └── config-render/          # WG/Caddy/转发 渲染纯函数（Worker 与测试共用）
├── agent/                      # Python Node Agent（纯标准库）
│   ├── khc_agent/
│   │   ├── main.py             # CLI: run / enroll / adopt / doctor / rollback
│   │   ├── protocol.py         # HTTP 客户端 + 重试 + 时钟校验
│   │   ├── reconcile.py        # 调和循环（全局互斥）
│   │   ├── core/
│   │   │   ├── fsguard.py      # 路径白名单 / 原子写 / symlink 防护
│   │   │   ├── wireguard.py    # wg-quick / syncconf / 回滚
│   │   │   ├── caddy.py        # validate / reload / 回滚
│   │   │   ├── forwarding.py   # ssh-fwd 单元
│   │   │   └── certs.py        # 证书扫描（只读）/ reload 看门狗
│   │   ├── transports/         # wireguard / tailscale / cloudflared / frp（按需）
│   │   ├── modules/            # 模块包安装、模板渲染、结果解析
│   │   └── selfupdate.py       # 验签、原子替换、guard 回滚
│   └── packaging/              # 打包/签名脚本（Node CLI）
├── modules/                    # 自有应用模块
│   └── node-exporter/          # 首个试点
│       ├── module.json
│       ├── install.sh
│       └── status.sh
├── migrations/                 # D1 schema（只增）
├── scripts/                    # 本地开发 / 签名 / 发布
├── docs/                       # 本设计 + runbook + ADR
├── wrangler.toml
├── package.json                # pnpm workspace
└── pnpm-workspace.yaml
```

---

## 4. 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| Worker 框架 | **Hono** + `@hono/zod-validator` | 轻量、Workers 原生、类型友好 |
| 契约 | **zod**（`packages/contracts`） | 前后端共用；可导出 OpenAPI（可选） |
| 数据 | **D1**（SQLite） | 关系表；迁移放 `migrations/`，只增 |
| 缓存/限流 | **KV** | 登录限流、catalog 缓存、enroll code |
| 对象存储 | **R2** | 模块包、Agent 包、备份（按需） |
| 定时 | **Cron Triggers** | 每 5 分钟巡检；每天证书/清理 |
| 前端 | **React 19 + TypeScript + Vite** | SPA，构建产物作为 Worker Static Assets |
| 路由/数据 | **TanStack Router + TanStack Query** | URL 即状态；服务端状态缓存 |
| 表单/校验 | **react-hook-form + zod** | 与模块 inputs schema 共用 |
| UI | **Tailwind CSS + shadcn/ui（Radix）** | 可定制、无重型依赖 |
| 表格/图标 | **TanStack Table + lucide-react** | |
| 测试 | **Vitest + Testing Library + MSW**；Worker 用 `@cloudflare/vitest-pool-workers`；e2e 用 **Playwright** | |
| Agent | **Python 3.8+ 标准库** | 零 pip 依赖；验签用系统 `openssl` |
| 包管理 | **pnpm** workspace | 单仓多包；Node 22 |

**主题/界面**：默认深色 + 可切浅色，桌面优先、兼容移动端；中文界面；沿用旧面板的信息密度，但交互重做。

---

## 5. 数据模型（D1，全新 schema）

> 设计原则：表按"资源"拆分，不再出现"一台 Hub 一整块 JSON"；所有外键显式；所有表带 `created_at/updated_at`。

```sql
-- 节点（Hub 与 Peer 统一建模）
CREATE TABLE nodes (
  id            TEXT PRIMARY KEY,              -- 生成：nd_xxx
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('hub','peer')),
  endpoint      TEXT,                          -- 公网入口（IP:port 或域名）
  arch          TEXT,
  os            TEXT,
  status        TEXT NOT NULL DEFAULT 'unknown', -- unknown/online/offline/degraded
  agent_version TEXT,
  adopted       INTEGER NOT NULL DEFAULT 0,     -- 是否已通过 adopt 接管
  last_seen_at  INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 节点传输（一个节点可挂多种传输）
CREATE TABLE node_transports (
  node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  transport   TEXT NOT NULL CHECK (transport IN ('wireguard','tailscale','cloudflared','frp','ssh-reverse')),
  config_json TEXT NOT NULL DEFAULT '{}',
  state       TEXT NOT NULL DEFAULT 'pending',  -- pending/active/degraded/disabled
  is_primary  INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (node_id, transport)
);

-- 节点密钥（私钥永不入库；只存公钥与状态）
CREATE TABLE node_keys (
  node_id    TEXT NOT NULL,
  transport  TEXT NOT NULL,
  kid        TEXT NOT NULL,                    -- key id，如 wg-2026a
  public_key TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'active',   -- active/next/retiring/revoked
  created_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, transport, kid)
);

-- 客户端节点（WireGuard peer / 非 root 传输的客户端）
CREATE TABLE peers (
  id                TEXT PRIMARY KEY,          -- pr_xxx
  node_id           TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  public_key        TEXT NOT NULL,
  private_key_enc   TEXT,                      -- AES-GCM(MASTER_ENC_KEY)，仅用于重新下发客户端配置
  allowed_ips       TEXT NOT NULL,             -- 10.99.0.3/32
  endpoint          TEXT,
  keepalive         INTEGER NOT NULL DEFAULT 25,
  install_token_enc TEXT,                      -- 客户端安装脚本一次性 token（加密）
  status            TEXT NOT NULL DEFAULT 'unknown',
  last_handshake_at INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (node_id, name)
);

-- 对外暴露（Caddy 反代 / TCP·UDP 转发 统一建模）
CREATE TABLE exposures (
  id          TEXT PRIMARY KEY,                -- ex_xxx
  node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('http','tcp','udp')),
  domain      TEXT,                            -- http 时使用
  listen_port INTEGER,                         -- tcp/udp 时使用
  upstream    TEXT NOT NULL,                   -- 10.99.0.3:9119
  tls_mode    TEXT NOT NULL DEFAULT 'auto',    -- auto/manual/off
  cert_id     TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  extra_json  TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE certificates (
  id         TEXT PRIMARY KEY,
  node_id    TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  domains    TEXT NOT NULL,                    -- JSON array
  issuer     TEXT,
  not_after  INTEGER,
  cert_path  TEXT,
  key_path   TEXT,
  source     TEXT NOT NULL DEFAULT 'acme-sh',  -- acme-sh/import/selfsigned
  status     TEXT NOT NULL DEFAULT 'active',
  updated_at INTEGER NOT NULL
);

-- 应用目录（模块包索引）
CREATE TABLE apps (
  id           TEXT PRIMARY KEY,               -- node-exporter
  name         TEXT NOT NULL,
  version      TEXT NOT NULL,                  -- 最新版本
  manifest_json TEXT NOT NULL,                 -- module.json
  package_key  TEXT NOT NULL,                  -- R2 key
  sha256       TEXT NOT NULL,
  signature    TEXT NOT NULL,
  published_at INTEGER NOT NULL
);

-- 应用实例（某节点上装了什么）
CREATE TABLE app_instances (
  id           TEXT PRIMARY KEY,               -- ai_xxx
  node_id      TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  app_id       TEXT NOT NULL,
  version      TEXT NOT NULL,
  config_json  TEXT NOT NULL,                  -- 用户输入（secret 字段为密文）
  result_json  TEXT,                           -- 安装输出（secret 字段为密文）
  state        TEXT NOT NULL DEFAULT 'pending',-- pending/installing/running/failed/stopped
  error        TEXT,
  last_task_id TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (node_id, app_id)
);

-- 任务队列（安装/卸载/升级/轮换/应用配置）
CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,               -- tk_xxx
  node_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,                  -- app.install/app.uninstall/apply/keys.rotate/cert.renew
  payload_json TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'queued', -- queued/leased/running/succeeded/failed/expired
  attempts     INTEGER NOT NULL DEFAULT 0,
  lease_until  INTEGER,
  result_json  TEXT,
  created_by   TEXT,
  created_at   INTEGER NOT NULL,
  finished_at  INTEGER
);
CREATE INDEX idx_tasks_claim ON tasks(node_id, state, created_at);

CREATE TABLE task_events (
  task_id TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  ts      INTEGER NOT NULL,
  level   TEXT NOT NULL,
  msg     TEXT NOT NULL,
  PRIMARY KEY (task_id, seq)
);

CREATE TABLE audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  ip          TEXT,
  action      TEXT NOT NULL,
  node_id     TEXT,
  target      TEXT,
  detail_json TEXT,                            -- 敏感字段打码后写入
  result      TEXT
);
CREATE INDEX idx_audit_ts ON audit(ts DESC);

CREATE TABLE settings (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**说明**：

- `nodes.endpoint` 是"接入点"，不是"管理地址"；管理只走 Agent 出站。
- 服务端 WG 私钥**不入库**，保存在 Hub 本地 `/var/lib/khc-agent/secrets/`；控制面只存公钥与结构。
- `peers.private_key_enc` 是**客户端**私钥（用于重新生成客户端配置），加密存储，仅管理员会话可解密下发；敏感操作进审计。
- 模块输入/输出里的 `secret` 字段统一 AES-GCM 加密；面板默认只显示"已设置"。

---

## 6. API 设计（`/api/v1`）

### 6.1 约定

- 统一前缀 `/api/v1`；JSON；错误格式 `{"error":{"code":"...","message":"...","fields":{}}}`。
- 鉴权：管理员用 **HttpOnly 签名 Cookie**（HMAC-SHA256，`SESSION_SECRET` 必填、fail-closed）；Agent 用 `Authorization: Bearer <node-token>` + `X-Node-Id`。
- 写操作全部**审计**；响应绝不回显凭据（统一 `<token>` 占位）。
- 分页：`?page=&pageSize=`；时间戳为 Unix 秒。
- 幂等：创建类接口支持 `Idempotency-Key`；任务类天然幂等（同 kind 同目标去重）。

### 6.2 路由

| 分组 | 方法与路径 | 说明 |
|---|---|---|
| Auth | `POST /auth/login`、`POST /auth/logout`、`GET /auth/me` | 口令（可选 TOTP） |
| Nodes | `GET/POST /nodes`、`GET/PATCH/DELETE /nodes/:id` | 列表/创建/详情/改名/删除 |
| Enroll | `POST /nodes/:id/enroll-code`、`GET /nodes/:id/install-command` | 一次性 enroll code（KV，10 分钟） |
| Adopt | `POST /nodes/:id/adopt/preview`、`POST /nodes/:id/adopt/commit` | 接管预览/提交（见 §10） |
| Transports | `GET/PUT /nodes/:id/transports/:kind` | 启用/配置传输 |
| Keys | `GET /nodes/:id/keys`、`POST /nodes/:id/keys/rotate` | 双 key 轮换 |
| Peers | `GET/POST /nodes/:id/peers`、`PATCH/DELETE /peers/:id` | 客户端管理 |
| Peer 配置 | `GET /peers/:id/client-config`、`POST /peers/:id/install-command` | 下载/生成客户端配置（审计） |
| Exposures | `GET/POST /nodes/:id/exposures`、`PATCH/DELETE /exposures/:id` | 反代 / 转发 |
| Certificates | `GET /nodes/:id/certificates`、`POST /nodes/:id/certificates/scan` | 先只读，后接管 |
| Apps | `GET /apps`、`POST /nodes/:id/apps`、`PATCH/DELETE /app-instances/:id` | 目录/安装/改配/卸载 |
| App 结果 | `GET /app-instances/:id/result`、`POST /app-instances/:id/reveal` | 掩码展示 / 显式查看（审计） |
| Tasks | `GET /tasks`、`GET /tasks/:id`、`GET /tasks/:id/events?after=` | 任务与日志 |
| Audit | `GET /audit` | 审计查询 |
| Agent | `POST /agent/heartbeat`、`GET /agent/desired`、`POST /agent/apply-result`、`POST /agent/tasks/lease`、`POST /agent/tasks/:id/events`、`POST /agent/tasks/:id/result`、`GET /agent/artifacts/:key` | Agent 专用 |
| System | `GET /health`、`GET /version` | 无鉴权探活 |

### 6.3 期望状态文档（`GET /agent/desired`）

```json
{
  "rev": 12,
  "nodeId": "nd_xxx",
  "agent": { "minVersion": "1.0.0", "update": null },
  "transports": {
    "wireguard": { "enabled": true, "iface": "wg0", "listenPort": 3000, "address": "10.99.0.1/24" }
  },
  "peers": [
    { "name": "gcp", "publicKey": "...", "allowedIPs": "10.99.0.2/32", "keepalive": 25 }
  ],
  "exposures": [
    { "kind": "http", "domain": "a.example.com", "upstream": "10.99.0.2:9119", "tlsMode": "auto" },
    { "kind": "tcp", "listenPort": 7000, "upstream": "10.99.0.2:22" }
  ],
  "apps": [
    { "id": "node-exporter", "version": "1.8.2-1", "config": {...}, "sha256": "..." }
  ]
}
```

- `rev` 单调递增；Agent 回报 `appliedRev`。
- 核心配置由 **Agent 渲染**（私钥在本地），控制面只发结构；模块由 Agent 解包渲染。
- 支持 `If-None-Match: "<rev>"` → 304。

---

## 7. Node Agent 设计（Python）

### 7.1 进程与文件布局

| 路径 | 内容 | 权限 |
|---|---|---|
| `/usr/local/bin/khc-agent` | 启动脚本（`python3 -m khc_agent`） | 0755 |
| `/opt/khc-agent/` | Agent 代码（版本目录 + `current` 软链） | 0755 root |
| `/etc/khc-agent/agent.env` | `CONTROL_PLANE_URL`、`NODE_ID`、`AGENT_TOKEN` | 0600 |
| `/var/lib/khc-agent/state.json` | `appliedRev`、上次结果、adopt 状态 | 0600 |
| `/var/lib/khc-agent/secrets/` | 服务端 WG 私钥、模块本地密钥 | 0700 |
| `/var/lib/khc-agent/modules/<id>/` | 模块运行数据 | 0755 |
| `/var/lib/khc-agent/cache/` | 模块包缓存 | 0700 |
| `/etc/khc-agent/keys/` | 信任公钥（模块签名 + Agent 发布签名） | 0644 |

`khc-agent.service`：

```ini
[Unit]
Description=KHC Node Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/khc-agent/current/bin/khc-agent run
Restart=always
RestartSec=5
EnvironmentFile=/etc/khc-agent/agent.env
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

### 7.2 主循环（只出站）

```
run():
  load config/state → selfupdate.check_boot_health()
  threads: heartbeat_loop (默认 60s；操作后 5s 快速模式 2 分钟) | watchdog (5min) | task_worker (串行)
heartbeat_loop:
  payload = { agentVersion, appliedRev, status, transports, apps, errors }
  POST /agent/heartbeat
  if desiredRev > appliedRev: GET /agent/desired → reconcile
  if tasksPending > 0: lease → execute → result
  if agentUpdate: selfupdate.apply()
reconcile(desired): 全局锁
  1. transports apply（wireguard：syncconf 优先；接口级才重启）
  2. exposures apply（Caddy validate → atomic write → reload；失败回滚）
  3. forwarding apply（ssh-fwd 单元启停）
  4. modules reconcile（安装/配置/停止/卸载）
  5. POST /agent/apply-result {rev, ok, detail}
```

- 控制面不可达：退避重试（5s → 5min），**不做任何删除/停服动作**，看门狗维持现状。
- 时钟偏差 >120s 告警；所有请求带 `serverTime` 校准。
- **不监听任何公网端口**；`khc-agent doctor` 本地输出诊断（无凭据）。

### 7.3 adopt（接管）模式

`khc-agent adopt`（只读，不改任何文件）：

1. 扫描 `/etc/wireguard/*.conf`：接口名、地址、监听端口、peer 公钥/allowedIPs/endpoint/keepalive；私钥只报告"存在 + 指纹"，**不上传私钥**。
2. 扫描 `/etc/caddy/Caddyfile` 原始文本 + 证书文件列表与到期时间。
3. 扫描 `ssh-fwd-*.service` 单元（名称、Exec 命令、启用状态）。
4. 扫描 acme.sh 状态（域名、到期时间）。
5. 把以上内容 + **每个文件的脱敏 sha256**（`PrivateKey` 行替换为 `<local-key>` 后计算）上报。

控制面侧：

1. `adopt/preview`：把上报内容转成资源记录（不落库），用 `packages/config-render` 渲染出期望文件，与上报的脱敏 sha 比对，返回 diff（逐文件）。
2. `adopt/commit`：diff 全为"无变化"才允许落库并置 `adopted=1`；否则只能只读展示，列出差异让人确认。
3. 接管后 Agent 进入正常调和；因为渲染结果与现网一致，**不会触发任何重启/重写**。

> 这是保证"接管后 peer 不断线"的核心门禁，M2 必须先在测试 VM 上跑通。

### 7.4 自更新（防变砖）

- 控制面下发 `release.json`（版本、sha256、签名）；Agent 用内置 release 公钥验签（`openssl pkeyutl -verify -rawin`）。
- 下载 → 校验 → 解包到 `/opt/khc-agent/versions/<ver>/` → 执行 `--version` 自检 → 原子切换 `current` 软链。
- 独立 guard：`khc-agent-guard.service`（20 行 shell，永不升级）监听 `OnFailure`，`current` 启动失败自动切回 `prev`。
- 手工救援：`khc-agent rollback` / `ln -sfn /opt/khc-agent/versions/<prev> /opt/khc-agent/current`。

### 7.5 安全约束

- 路径白名单：`/etc/wireguard/`、`/etc/caddy/`、`/etc/systemd/system/khc-*.service`、模块声明路径；禁止 `/root`、`/etc/ssh`、`/etc/sudoers`、`/etc/cron*`、`/usr/local/bin/khc-agent`。
- 原子写 + `caddy validate` + WG 备份 + 接口变更后 60 秒健康检查失败自动回滚。
- 禁止接收任意代码执行（模块必须签名；Agent 自更新必须验签）。
- 日志脱敏：token/私钥/密码统一 `redact()`。

---

## 8. 传输抽象（Transport Provider）

```python
class Transport:
    id: str                  # wireguard / tailscale / cloudflared / frp / ssh-reverse
    requires_root: bool
    def probe(self) -> dict          # 本机能力探测
    def apply(self, desired, ctx)    # 收敛到期望状态
    def status(self) -> dict
    def rotate_key(self, new_key)    # 双 key 过渡
    def teardown(self)
```

- **首期**：`wireguard`（root，内核，现状）。
- **后续候选（按需）**：
  - `tailscale`：`tailscaled --tun=userspace-networking`，**非 root**；适合给 Peer 做反向可达。
  - `cloudflared`：纯出站，非 root，无公网 IP；适合把 Peer 服务暴露给面板/Hub。
  - `frp` / `ssh -R`：用户态反向隧道。
- 业务层只引用 `exposure.upstream = "node:service"`，由 transport 解析成实际地址；换传输不改 exposure/app 定义。
- **密钥轮换**：`node_keys` 支持 `active → next → retiring → revoked`；轮换时先下发新 key、验证连通，再清理旧 key；Agent 回报状态。

---

## 9. 模块系统（自有应用）

### 9.1 包结构

```
modules/<id>/
  module.json       # 元数据 + inputs/outputs + permissions + scripts
  install.sh        # 安装（stdin 收 JSON，stdout 最后一行 KHC_RESULT）
  status.sh         # 可选：返回状态
  uninstall.sh      # 可选：卸载（数据目录默认保留 7 天）
  README.md
```

打包产物：`<id>-<version>.tar.gz`；包内禁止符号链接/绝对路径/`..`；发布时计算 sha256 并用离线 Ed25519 签名。

### 9.2 `module.json`

```json
{
  "apiVersion": 1,
  "id": "uptime-kuma",
  "name": "Uptime Kuma",
  "version": "1.23.16-1",
  "description": "自托管监控面板",
  "category": "monitoring",
  "requires": { "agent": ">=1.0.0", "transports": ["wireguard"] },
  "inputs": {
    "type": "object",
    "additionalProperties": false,
    "required": ["port"],
    "properties": {
      "port": { "type": "integer", "title": "监听端口", "default": 3001, "minimum": 1024, "maximum": 65535 }
    }
  },
  "outputs": {
    "loginUrl": { "type": "string", "label": "登录地址" },
    "username": { "type": "string", "label": "用户名" },
    "password": { "type": "string", "label": "初始密码", "secret": true }
  },
  "permissions": {
    "runAs": "user",
    "paths": { "rw": ["/var/lib/uptime-kuma"] },
    "ports": [{ "proto": "tcp", "fromConfig": "/port" }]
  },
  "scripts": { "install": "install.sh", "status": "status.sh", "uninstall": "uninstall.sh" }
}
```

### 9.3 安装协议

- Agent 执行：`sh install.sh`，**stdin** 传入：
  ```json
  { "nodeId": "nd_x", "moduleId": "uptime-kuma", "version": "1.23.16-1",
    "inputs": { "port": 3001 },
    "secrets": { "auto": { "password": "..." } },
    "context": { "dataDir": "/var/lib/khc-agent/modules/uptime-kuma", "publicHost": "..." } }
  ```
- 敏感值只走 stdin，不放环境变量；stdout 逐行作为任务日志；
- **最后一行** `KHC_RESULT {"loginUrl":"...","username":"...","password":"..."}` 为结构化结果；
- 退出码 0 成功；非 0 失败；超时（默认 300s）由 Agent 终止并上报。
- 结果按 `outputs` schema 校验：`secret` 字段加密入库，面板掩码展示，`reveal` 需管理员点击并记审计。

### 9.4 执行与沙箱

- `runAs: "user"`：Agent 创建 `khc-<id>` 系统用户，`systemd-run` 以该用户执行；
- `runAs: "root"`：必须声明权限，`systemd-run` 注入 `ProtectSystem=strict`、`ReadWritePaths=声明路径`、`NoNewPrivileges`、`PrivateTmp`、`CapabilityBoundingSet`；
- 权限外路径写入直接拒绝；端口冲突在控制面 `port_claims` 层先拦截；
- 卸载：停服务、删单元、数据目录移到 `.trash/<id>-<ts>`（7 天后清理）。

### 9.5 发布

- `pnpm module:pack <id>` → 打包 + sha256；
- `pnpm module:sign` → 更新 catalog（serial+1）+ 签名（私钥 `~/.khc/keys/module.key`，0600，不在仓库内）；
- `pnpm module:publish` → 打印 `wrangler r2 object put` 命令（由主人执行；脚本不直传）。

---

## 10. 接管 3 台现有 Hub 的 SOP（adopt → diff → commit）

> 前提：M2 已在测试 VM 验证通过；生产旧 Pages 保持在线，随时可退回。

1. **准备**：新 Worker 部署完成；新 D1 建好；节点记录创建（`hub` 类型），生成一次性 enroll code。
2. **安装**：在 Hub 上执行升级脚本（由 Worker 生成）：
   ```bash
   curl -fsSL https://<khc-domain>/api/v1/agent/install.sh | sudo sh -s -- --node <id> --code <one-time-code>
   ```
   脚本只做：装 Agent 到 `/opt/khc-agent`、写 `agent.env`、装 systemd 单元、**不启动**（或启动后只读）。
3. **adopt**：`khc-agent adopt` → 上报现有状态；控制面 `adopt/preview` 返回逐文件 diff。
4. **核对**：diff 全部为"无变化"才允许 commit；同时人工核对 peer 公钥、allowedIPs、Caddy 站点、转发端口。
5. **接管**：`adopt/commit` → `adopted=1` → Agent 进入正常调和（首次 reconcile 应产生 0 变更）。
6. **观察**：24–72h 内检查 `wg show` 握手、Caddy 200、转发端口、证书到期；旧 Pages 仍可打开对照。
7. **回退**：`systemctl disable --now khc-agent && systemctl enable --now wg-hub-agent`（旧 Agent 未删除），旧 Pages 继续管；Hub 配置本来未被改动。
8. 3 台按同样流程逐台进行，每台间隔 ≥1 天。

---

## 11. 前端设计

### 11.1 页面

| 路由 | 页面 | 说明 |
|---|---|---|
| `/login` | 登录 | 口令 + 可选 TOTP |
| `/` | 总览 | 节点健康、最近任务、证书到期、告警 |
| `/nodes` | 节点列表 | 状态、传输、版本、最后心跳 |
| `/nodes/:id` | 节点详情 | Tab：概览 / 传输 / Peers / 暴露（反代+转发）/ 应用 / 任务 / 日志 |
| `/nodes/:id/onboard` | 接管向导 | adopt preview diff → commit |
| `/apps` | 应用目录 | 模块卡片、版本、权限摘要 |
| `/apps/instances/:id` | 应用实例 | 配置、结果（登录地址/token 掩码 + reveal）、日志、卸载 |
| `/tasks` | 任务中心 | 列表 + 实时日志轮询 |
| `/audit` | 审计 | 筛选/导出 |
| `/settings` | 设置 | 主题、账号、签名 key 状态 |

### 11.2 关键实现约定

- **服务端状态**：TanStack Query（`staleTime`、轮询间隔按页面 5–30s）；变更后 invalidate。
- **表单**：`react-hook-form + zod`；模块表单由 `form renderer` 按 `inputs` schema 生成（控件：text/textarea/number/toggle/select/port/secret/list）。
- **结果展示**：按 `outputs` schema 渲染；`secret` 字段显示 `••••` + "查看"（审计）+ "复制"。
- **无全局可变状态**：只有 auth/theme 进 store；Tab/筛选/选中全部进 URL。
- **安全**：Cookie 会话；插件文本纯文本渲染；不在前端持久化任何 token。
- **可访问性/响应式**：Radix 组件保证键盘可达；窄屏折叠侧边栏。

---

## 12. 安全模型

| 资产 | 存放 | 保护 |
|---|---|---|
| 管理员口令 | Worker Secret（`ADMIN_PW_HASH`，PBKDF2/强哈希） | 不落库、不回显 |
| 会话 | HttpOnly + SameSite=Lax Cookie（HMAC） | `SESSION_SECRET` 必填、fail-closed |
| Agent token | D1 存 SHA-256；Hub 本地 `agent.env` 0600 | 每节点独立、可轮换 |
| 服务端 WG 私钥 | 仅 Hub 本地 `secrets/` 0700 | 不出节点、不入库 |
| Peer 私钥 | D1 AES-GCM 密文 | 仅管理员会话可解密下发、审计 |
| 模块结果 secret | D1 AES-GCM 密文 | 掩码 + reveal 审计 |
| 模块签名私钥 | 主人本地离线 | 不进仓库/CI/Worker |
| 模块包 | R2 | 发布时签名，Agent 验签 |

**信任边界**：R2 被篡改 → 验签失败；Worker 被攻破 → 只能下发已签名模块 + 已声明权限；单个 Agent token 泄露 → 只影响该节点。

**红线**：错误响应零凭据回显；不提供任意脚本执行接口；写盘白名单 + symlink 防护；所有状态变更进 `audit`。

---

## 13. 可观测性与运维

- **Cron（每 5 分钟）**：节点心跳超时标记 offline；`applyError` 聚合；证书 <14 天提醒；租约过期任务回收。
- **Cron（每天）**：`task_events` 清理（保留 30 天）；审计摘要；证书扫描。
- **面板**：总览页显示节点在线率、最近失败任务、证书到期。
- **日志**：Worker `console.log` 结构化 + `wrangler tail`；Agent 用 journald；任务日志通过 `task_events` 拉取。
- **告警（可选）**：后续接邮件/Telegram webhook（Worker 内发，不引第三方服务）。

### 13.1 Workers 免费额度预算（重要）

免费额度（同一 Cloudflare 账号共享）：**Worker 请求 100,000/天**；**D1 行读 5,000,000/天、行写 100,000/天**；**KV 读 100,000/天、写 1,000/天**。静态资源请求**免费且不计数**；子请求（subrequest）不计数。

单节点心跳负载：

| 心跳间隔 | 请求/节点/天 |
|---|---|
| 5s（仅操作后快速模式，限 2 分钟） | 24 次/次操作 |
| 30s | 2,880 |
| **60s（默认）** | **1,440** |
| 120s | 720 |

整体预算（按 6 个节点、面板 100 次访问/天估算）：

| 场景 | Worker 请求/天 | 占免费额度 |
|---|---|---|
| 6 节点 @60s + 面板 + Cron | ≈ 10,000 | ~10% |
| 6 节点 @30s + 面板 + Cron | ≈ 19,000 | ~19% |
| 20 节点 @60s + 面板 + Cron | ≈ 30,000 | ~30% |
| 30 节点 @30s | ≈ 87,000 | ~87%（接近上限，建议改 60s 或上 Paid） |

设计约束（必须遵守）：

1. **默认 60s 心跳**，只有"用户操作后"进入 5s 快速模式，2 分钟后回落；可选配置 30–120s。
2. 心跳响应里带 `desiredRev`/`tasksPending`，**状态没变就不拉 desired**；desired 支持 ETag/304。
3. **KV 写只在低频路径**（登录限流、enroll code）；禁止在心跳/会话路径写 KV（1,000 写/天是最紧的额度）。
4. D1 写入按"状态变化 + 60s 节流"落 `hub_live`，不要每次心跳写库。
5. 任务日志按任务批量上报（每任务 1–2 次请求），不要逐行上报。
6. 面板轮询 15–30s，页面隐藏时暂停。
7. 监控用量，60% 时告警；超过时给 Agent 返回 429 并指数退避（Agent 已有退避逻辑）。

> 结论：3–10 个节点完全在免费额度内（≤30%）；真正先撞墙的是 **KV 写入 1,000/天**，只要不让心跳写 KV 就不会有问题。若节点扩到 20+ 或需要更快心跳，$5/月 的 Workers Paid（10M 请求/月）即可解决。

---

## 14. 部署与配置

### 14.1 `wrangler.toml`

```toml
name = "khc-server"
main = "apps/api/src/index.ts"
compatibility_date = "2026-10-01"
compatibility_flags = ["nodejs_compat"]
workers_dev = true

[assets]
directory = "apps/web/dist"
binding = "ASSETS"
not_found_handling = "single-page-application"

[[d1_databases]]
binding = "DB"
database_name = "<d1-name>"
database_id = "<由 wrangler d1 create 生成>"

[[kv_namespaces]]
binding = "KV"
id = "<由 wrangler kv namespace create 生成>"

[[r2_buckets]]
binding = "ARTIFACTS"
bucket_name = "khc-artifacts"

[triggers]
crons = ["*/5 * * * *", "0 3 * * *"]

[vars]
ENVIRONMENT = "production"
```

### 14.2 环境变量 / Secrets

| 名称 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ADMIN_PW_HASH` | Secret | 是 | 管理员口令哈希（PBKDF2-SHA256） |
| `SESSION_SECRET` | Secret | 是 | 会话签名（≥32 字节，缺失 fail-closed） |
| `MASTER_ENC_KEY` | Secret | 是 | AES-GCM 加密敏感字段 |
| `AGENT_TOKEN_PEPPER` | Secret | 否 | Agent token 哈希加盐 |
| `MODULE_PUBKEY` | Var | 是 | 模块签名公钥（base64） |
| `RELEASE_PUBKEY` | Var | 是 | Agent 发布签名公钥 |
| `ENROLL_CODE_TTL` | Var | 否 | 默认 600 秒 |

### 14.3 环境

| 环境 | Worker | D1 | 用途 |
|---|---|---|---|
| dev | `khc-server-dev`（本地 `wrangler dev`） | 本地 D1（miniflare） | 日常开发、单测 |
| staging | `<worker-name>` | `<d1-name>` | 测试 VM、Playwright、adopt 演练 |
| production | `<worker-name>` | `<d1-name>` | 3 台生产 Hub 接管后使用 |

> 上线前 staging 与 production 完全隔离；**生产旧 Pages / 旧 D1 不被新项目读写**。

### 14.4 CI/CD

- GitHub 新仓库 → Workers Builds：`main` push 自动构建部署（`pnpm install && pnpm build && wrangler deploy`）。
- CI：`pnpm lint && pnpm typecheck && pnpm test`；Worker 测试跑在 workerd；前端组件测试 Vitest；e2e 只在 staging 手动/定时。
- 签名在主人本地离线执行，CI 不持有私钥。

---

## 15. 里程碑与验收

| 里程碑 | 内容 | 验收标准 | 估算 |
|---|---|---|---|
| **M0 骨架** | 新仓库、pnpm workspace、wrangler、contracts、CI、本设计 | `pnpm dev` 起得来；`/api/v1/health` 200；空前端可登录 | 2–3 天 |
| **M1 核心 CRUD** | Nodes/Peers/Exposures + 登录 + 新前端骨架 | staging 上增删改查全通；Playwright 冒烟 | 1–2 周 |
| **M2 Adopt 接管** | Agent adopt、渲染-diff、Caddy/转发/证书只读 | 测试 VM 上 adopt diff=0，接管后 peer 握手不变 | 2 周 |
| **M3 模块 v1** | `module.json`、打包/签名、安装/结果展示、任务日志 | node-exporter 在测试 VM 装/升/卸/回滚；UI 显示结果 | 2–3 周 |
| **M4 新 Agent 完整版** | 出站拉取、非 root transport、关 8880、自更新 guard | 测试 VM 无公网管理端口；断网 30 分钟不回滚；坏版本自动回退 | 3–4 周 |
| **M5 生产接管** | 3 台 Hub 逐台 adopt → commit；新 D1 上线 | 每台 diff=0、peer 不断、旧 Pages 可回退 | 每台 <1 小时 |

---

## 16. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **adopt 渲染与现网不一致** | 接管后重写配置 → peer 断线 | 脱敏 diff 必须为 0 才 commit；测试 VM 先行；保留旧 Agent |
| Worker 与 Agent 协议演进不同步 | 节点掉线 | 契约测试（fixtures 双侧共用）；Agent 版本门槛 |
| 模块安装脚本失败/超时 | 应用装坏 | 任务超时 + 日志 + 卸载清理；首次在测试 VM |
| 敏感输出泄露 | 账号密码泄露 | 结果加密 + 掩码 + reveal 审计 + 错误零回显 |
| D1 并发写 | 任务/租约冲突 | 条件更新 + lease；单节点串行任务 |
| Workers 限制（CPU/请求体） | 大包下载失败 | 模块包走 R2 直链/签名 URL；控制面不代理大文件 |
| 自更新变砖 | 节点失联 | guard 单元 + prev 版本 + 手工 rollback + 离线安装包 |
| 3 台 Hub 环境差异 | 行为不一致 | 先测试 VM 覆盖 Debian/Ubuntu；`doctor` 能力探测 |

---

## 17. 从旧设计继承 / 丢弃

**继承（值得保留）**：声明式期望状态、rev + ack、任务队列与事件日志、模块 manifest + 权限声明、签名信任链、出站-only、审计。

**丢弃/简化**：Go Agent 重写、完整 JSON Schema 子集、`systemd-run` 复杂钩子状态机、R2 公共读、lego 证书引擎（先用现有 acme.sh）、多租户/RBAC。

**新增（旧设计没有）**：Workers + Static Assets、adopt 接管门禁、传输 provider 抽象、node_keys 双 key 轮换、模块结果 schema 与 reveal 审计、私钥不出节点。

---

## 18. 待确认（默认值已给）

| # | 事项 | 默认 |
|---|---|---|
| 1 | 仓库托管 | GitHub 新建 `khc-server`（私有） |
| 2 | 域名 | 先 `<worker-name>.<account>.workers.dev`，稳定后绑自定义域 |
| 3 | staging D1 名称 | `<d1-name>`；生产 `<d1-name>` |
| 4 | 首个非 root transport | `cloudflared`（纯出站、无需公网 IP）或 `tailscale`，按使用场景定 |
| 5 | 模块签名 | 先单 key，保留多 `kid` |
| 6 | 2FA | 保留（TOTP），默认关闭 |
| 7 | 前端主题 | 深色默认 + 浅色切换 |
| 8 | 旧 Pages 退役 | 生产接管稳定 ≥30 天后由主人决定 |

---

## 附录 A：与旧系统的对照

| 维度 | 旧（mgmt-console / Pages） | 新（khc-server / Workers） |
|---|---|---|
| 控制面 | Pages Functions + 单文件 `app.js` | Worker + Hono + 分层目录 |
| 数据 | 单表 kv，Hub 整块 JSON | 关系表，按资源拆分 |
| 前端 | 原生 JS，无构建/类型 | React + TS + Vite，契约共享 |
| Agent | Python，被动直推，监听 8880 | Python，只出站，无管理端口 |
| 应用 | 改前后端 + Agent 三处 | 签名模块包，安装脚本返回结果 |
| 传输 | 仅 WireGuard | transport provider，可替换 |
| 密钥 | peer 私钥可派生、轮换困难 | node_keys 版本化、双 key 轮换 |
| 发布 | 合并即部署，改应用要发版 | 应用层不进控制面代码 |

## 附录 B：术语

- **Node**：Hub 或 Peer 的统一称呼。
- **Transport**：节点之间的连接方式（wireguard/tailscale/...）。
- **Exposure**：对外暴露（HTTP 反代 / TCP 转发 / UDP）。
- **Module/App**：可分发的应用包。
- **Adopt**：只读扫描现有节点配置并接管的流程。
- **Desired State**：控制面下发的期望状态文档。
