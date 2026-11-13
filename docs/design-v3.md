# khc-server v3：冻结核心 + 应用适配器 + 无损密钥轮换

> 状态：现行 ｜ 最后核验：2026-11-06 ｜ 关联：ADR-0001、ADR-0012、docs/data-layering.md
> 范围：架构与冻结契约（核心/适配器/连接/数据模型）
> **取代**：`design-v1.md`（现 `docs/archive/2026-11/design-v1.md`）的连接层、插件包、transports 抽象；`design-v2-simple.md`（现 `docs/archive/2026-11/design-v2-simple.md`）的接口清单。v2 的原则（按需连接、无心跳、失败要快）继续有效。
> **定位**：面板**不是监控面板**，是"替我安装 / 卸载 / 配置常用软件"的遥控器 + 配置仓库。一个月大约打开 10 次。
> **数据边界**：面板只做配置读写与按需动作，**不承载重运维数据**；页面可见时以 10s 轮询轻量快照（有域名浏览器直连 `/_live/snapshot`，无域名经 Worker `/nodes/:id/snapshot` 转发，2s 去重），隐藏即停、10 分钟/60 次上限；适配器/端口/服务/进程等重数据仍来自打开工作区时的一次性 `/state`（ADR-0010）。

---

## 0. 三句话

1. **核心冻结**：Worker、D1 schema、Agent 内核、前端外壳写一次就不再动。所有"跟某个软件有关的知识"只出现在**适配器**里。
2. **加一个软件 = 一个适配文件 + 一个页面**：`agent/adapters/<app>.py` + `apps/web/src/apps/<app>/page.tsx`。不改路由、不改表、不改契约。
3. **WireGuard 换密钥不再失联**：禁止"原地改密钥"，改成**先加后删 + 握手确认后切换**，控制通道永远不走它要改的那条隧道。

---

## 1. 总体架构

```
┌──────────── Cloudflare Worker（核心，冻结）────────────┐
│ React 外壳 + 应用页面（静态资源）                         │
│ /api/v1/auth/*        登录/会话                          │
│ /api/v1/nodes/*       节点 CRUD + 节点 token            │
│ /api/v1/nodes/:id/apps/:app            读/存应用配置（D1）│
│ /api/v1/nodes/:id/apps/:app/:action    转发给 Agent      │
│ /api/v1/nodes/:id/state                转发给 Agent      │
│ /api/v1/nodes/:id/tasks/:tid           转发给 Agent      │
│ D1：nodes / app_configs / revisions / audit（核心 4 表，      │
│     另有 certificates / settings 扩展表，见 §2.3）            │
│ 不用 KV / R2 / DO / Cron / Queue / WS                    │
└───────────────┬──────────────────────────────────────────┘
                │ HTTPS + HMAC 签名，按需调用（面板关闭时零流量）
                ▼
┌──────────── Hub：khc-agent（内核冻结，适配器可插）─────────┐
│ Agent :8880（默认直连）/ Caddy :8443 / cloudflared（可选）│
│ 内核：鉴权 / 任务执行器 / 原子写+回滚 / systemd / 端口登记  │
│       / Caddy 片段装配 / 适配器加载                         │
│ adapters/wireguard.py  caddy-site.py  sing-box.py  ...    │
└───────────────────────────────────────────────────────────┘
```

**Worker 对应用一无所知**：应用配置在 Worker 里只是一个不透明的 JSON 字段 `config`，带 `schemaVersion`。由 Agent 上的适配器做权威校验，前端页面做输入校验。Worker 只负责鉴权、存储、版本快照和转发，因此加应用永远不需要改 Worker。

### 1.1 连接与鉴权（核心，一次定死）

- **传输双通道（必须，见 ADR-0001）**：Worker 出站有两条路——
  1. **原生 `fetch()`**：域名可用自定义端口（`compatibility_date >= 2024-09-02` 或 `allow_custom_ports`）；但**裸 IP 一律返回 Cloudflare `403 error 1003`**（已实测：IP 的 80/8880/8788 全部失败），不能用于 IP 直连。
  2. **`cloudflare:sockets` `connect()` 手写 HTTP/1.1（可选 TLS）**：支持**任意 IP / 任意端口**，用于 IP 直连、非标端口、未备案 Host 绕过；即旧系统 `directTcpFetch()` 的方案。
  选路（同一接入方案内部）：域名走 `fetch`，裸 IP / 非标端口走 TCP socket；两条通道属于同一次连接尝试，失败即返回明确错误，**不跨接入方案切换**。适配器不感知传输差异。
- **接入方案口径（2026-11-06 修订，取代 D-3「直连首选 / Tunnel 备用」）**：控制通道有**三种并列的接入方案**，每台节点在创建/配置时**选定其一**，运行时只走该方案，失败即报错，**不存在主备关系，也不做跨方案回退**：
  1. **方案 A：https + 域名 + 公网可信证书直连**。节点配域名证书或 IP 证书，`endpoint` 填 `https://<域名或IP>:<端口>`；TLS 由平台强制校验证书（fetch 与 TCP 通道均无跳过校验开关）。
  2. **方案 B：Cloudflare Tunnel**。Hub 常驻 `cloudflared` 出站、Agent 绑 `127.0.0.1`、`tunnel_endpoint` 填隧道域名；Worker 只连 Cloudflare 可信边缘，节点侧零公网入站端口。备案/端口限制或不想暴露入站端口时**直接选本方案**，不是 A 失败后的兜底。
  3. **方案 C：https + 域名 + 自签证书**。Worker 直连自签在平台侧**不可行**（`fetch()` / `cloudflare:sockets` 一律校验证书，无 `rejectUnauthorized:false` 或自定义 CA）；可行的落地形态是把自签放在 Tunnel 源站段（cloudflared `caPool` / `originServerName`）或 Workers VPC 私有服务段，Worker 侧始终面对可信证书。
  三种方案均为既有能力组合，不引入 provider 抽象；引导见 `docs/runbook/node-onboarding.md` §4.1。
  > **已按 ADR-0012 落地（2026-11-07）**：三种并列方案、节点选定其一、无跨方案回退；同方案内 `fetch` / TCP 双通道保留。`orderedRoutes()` 只返回选定方案的单一目标，跨路由重试与 `onRouteSuccess` 自动回写 `preferred_route` 已删除，运行时不改写配置、失败即报明确错误；决策与迁移见 `docs/engineering/adr/ADR-0012-connection-scheme-selection.md`。
- **P1 直连传输加固（2026-11-06 实施）**：
  - **Agent TLS 监听**：Agent 支持直接 TLS 监听（`--tls-cert` / `--tls-key` 参数），主端口复用，无需 Caddy 前置。证书路径约定：优先读命令行参数，兜底读 `/etc/khc-agent/tls.{crt,key}`。
  - **证书热重载**：Agent 响应 `SIGHUP` 信号重新加载 TLS 证书，`acme.sh` / `certbot` 续期后可 `kill -HUP $PID` 无缝切换，无需重启服务。面板侧 `certificates/install_tls` 动作会先校验 PEM 配对、以 0600 原子写入 `<config_dir>/tls/{fullchain.pem,key.pem}`，再自动向自身发 `SIGHUP`；Agent 未以 `--tls-cert` 启动时返回 `restartRequired`（证书已写入，重启后生效）。
  - **证书到期上报**：`/state` 响应在 `agent.tls.notAfter` 上报证书到期时间（Unix 时间戳，另有 `agent.tls.enabled` / `agent.tls.names`；见 `agent/khc/http.py` 的 `_CertInfoCache`），便于提前告警续期。早期文档写作 `tlsCertExpiry`，**以 `agent.tls.notAfter` 为准**；该字段仅在 Agent 自身 `--tls-cert` 启用 TLS 时出现，方案 A 由 Caddy 终止 TLS 时 Agent 不上报。
  - **安全通道检查**：Worker 侧新增 `secure-channel.ts`，拒绝在明文 `http://` 通道下发证书私钥（`$cert` 引用）或 DNS 凭据（`$dnsCred` 引用），返回 400 `insecure_channel_secret`。`ENVIRONMENT=development` 豁免，方便本地调试。
  - **安装脚本适配**：`install.sh` 新增 `--tls-cert <路径>` / `--tls-key <路径>` / `--insecure-http`（仅回环）三个参数；Worker 生成安装命令时根据入口协议自动带上对应参数（https → 证书路径，http → --insecure-http）。
  - **看门狗适配**：Agent 看门狗 (`upgrade.py`) 的健康自检改为 HTTPS（当启用 TLS 时），避免证书问题误触发回滚。
  - **版本**：Agent 0.1.18 → 0.1.19，测试增加 37 项（TLS 传输 18 项 + 安全通道 16 项 + 预检 3 项）。
- **主入口（直连，默认）**：Agent 监听 `0.0.0.0:8880`，Worker 用 `http://<IP 或域名>:8880` 调用（HMAC 鉴权）。8880 属 Cloudflare 支持的 HTTP 端口；IP 由 TCP socket 访问。未配可信证书时为明文 HTTP（HMAC 只防请求篡改，无传输机密性）——按上文所选方案 + P1 实现升级为 TLS 直连。
- **端口与 DNS 模式**：Cloudflare 代理支持的 HTTP 端口为 80 / 8080 / 8880 / 2052 / 2082 / 2086 / 2095，HTTPS 端口为 443 / 8443 / 2053 / 2083 / 2087 / 2096；灰云（DNS only）任意端口。**默认 `http://<IP 或域名>:8880`**（走 TCP socket 或 fetch）；方案 A 建议 `https://<域名>:<HTTPS 白名单端口>`（可信证书直连）。
- **证书**：橙云 → **Cloudflare Origin CA** 证书（Caddy `tls cert key` 即可，无需 DNS 插件/自编译）；灰云 → `acme.sh` DNS-01 公网证书；纯 IP（无域名）→ IP 证书（如 ZeroSSL/IP 类 CA）后走 TCP 通道 TLS。
- **备案边界**：备案只约束大陆机房 80/443；海外 Hub 不受影响。大陆机器用高位端口 + 域名证书；若备案/端口导致方案 A 不可用，建节点时**直接选方案 B**，不是运行时切换。
- **方案 B：cloudflared 隧道**（节点创建/配置时选定，不是主入口的兜底）。Hub 上的 `cloudflared` 常驻出站连接，把 `127.0.0.1:8880` 暴露为 `https://<node>-t.<domain>`。不经过公网入站端口，适用于无入站端口、备案受限或主动不暴露端口的节点。前置条件与费用：域名托管在 Cloudflare（Free 计划即可）、Tunnel 本体免费（自托管 connector，无按量费用）；进阶可在隧道入口挂 Access Service Token（免费计划 50 用户额度内）。
- **选路规则（2026-11-07 已按 ADR-0012 落地）**：`orderedRoutes()` 只返回 `preferred_route` 选定方案对应的**单一**目标（直连类走 `endpoint`、隧道类走 `tunnel_endpoint`），`preferred_route` 语义由「上次成功的路」改为「选定方案」（值仍为 `direct` / `tunnel`，不改契约）；删除跨路由 `continue` 重试与 `onRouteSuccess` 自动回写，运行时**不再改写 `preferred_route`**。节点选定其一，失败即抛明确错误（`HubUnreachableError`），**无跨方案回退、无主备**；同一方案内部的 `fetch` / TCP 双通道保留（域名走 `fetch`，裸 IP / 非标端口走 TCP socket，属实现细节）。三种并列方案、节点选定其一、无跨方案回退的权威口径见 ADR-0012 与上文。
- 鉴权：每个节点一个随机 token（Agent 本地明文保存，D1 只存加密值供 Worker 签名用）。请求头带 `X-Khc-Ts`、`X-Khc-Nonce`、`X-Khc-Sig = HMAC-SHA256(token, method|path|ts|nonce|sha256(body))`。Agent 校验 ±60s 时间窗，nonce 在内存里保留 120s 防重放。
- **HMAC 规范化**：签名路径用 **Agent 路径**（不是 Worker 路径），query 不参与签名，GET 的 body hash 用空串 `sha256("")`。
- **节点 token 轮换（双窗口）**：Worker 生成新 token → 经旧通道下发 `rotate_token` → Agent 同时接受新旧（旧 token 保留 24h）→ Worker 切换签名 token → 过期后删除旧 token。任一步失败可回滚，不会把 Worker 自己锁在门外。
  **【2026-11-03 状态更新：此机制经拍板不实现（自动轮换下马）；token 疑似泄露时按 `docs/backup.md` §8 的手动轮换 SOP 处理（导出备份 → 删除重建节点 → 写新 token → 导入恢复）。保留本条仅作历史设计记录。】**
- 超时：`state` 3s，同步 action 15s，网络错误重试 1 次（action 带 `idempotencyKey`）。超过 15s 的操作一律走任务。
- **铁律：控制通道不走 WireGuard。** Worker→Agent 走公网 HTTPS，所以改 WG 永远不会把自己的遥控线剪断（这是 §5 的前提）。

### 1.2 打开面板的体验（前端约定）

- 先用 D1 渲染（毫秒级），再并发拉各节点 `/state` 填充状态，单节点失败只影响它自己那一行。
- 节点 `/state` 返回每个应用当前已生效的 `rev`。与 D1 不一致时，页面显示「有未应用的改动」，不需要任何同步机制。

---

## 2. 核心接口（冻结的契约）

### 2.1 Worker API

| 路由 | 说明 |
|---|---|
| `GET/POST /nodes`，`GET/PATCH/DELETE /nodes/:id` | 节点（名称、endpoint、绑定域名 `domain`、`accessMode`（domain/tunnel/ip）、`tunnelId`、`allowInsecure`、token 轮换）；tunnel 模式的 endpoint 由隧道域名推导，IP 直连必须显式 `allowInsecure`。`GET /nodes` 与 `GET /nodes/:id` 额外携带 `summary`（D1 期望配置派生的模式/Peer/站点/转发计数，零节点连接；有配置行但条数为 0 时返回 0，未配置为 null；派生逻辑在 `lib/node-summary.ts`，读取走 `AppConfigRepo.listSummaries` 的明文 `summary_json`，旧行 NULL 才回退 `listForSummary` 解密） |
| `POST /nodes/probe` | 一次请求探测全部节点（Agent `GET /state`，单片 4 并发、10s 超时；成功才写 `lastSeenAt`，失败项 `reachable:false`，整体始终 200）。响应可选 `apps: [{name,installed,running}]`（只含名称与布尔值、不含 secrets），供首页并列表达「实装未纳管」与「D1 有、实装无」；`/state` 超时或结构不合法时该项缺失/空数组，不影响 `reachable` |
| `GET /nodes/:id/state` | 转发 Agent `/state`（3s） |
| `GET /nodes/:id/apps` | 已安装应用 + Agent 上可用适配器列表（含版本） |
| `GET/PUT /nodes/:id/apps/:app` | 读/存应用配置（只写 D1 + revisions，不碰 Hub） |
| `POST /nodes/:id/apps/:app/:action` | 转发 Agent；`action ∈ {plan, apply, install, uninstall, 以及适配器自定义动作}` |
| `GET /nodes/:id/tasks/:tid` | 转发任务状态/日志 |
| `GET /nodes/:id/apps/:app/revisions`，`POST .../rollback/:rev` | 版本历史与回滚（回滚 = 把旧 config 再 apply 一次） |

上表为**冻结核心**路由。核心之外，`apps/api/src/routes/` 还存在以下编排/扩展路由（以代码为唯一事实来源，此处仅索引）：

| 路由 | 说明 | 文件 |
|---|---|---|
| `GET /nodes/:id/mode` | 节点模式（wg/caddy/unknown，见 `docs/dual-mode.md`） | `mode.ts` |
| `GET /nodes/:id/audit` | 节点操作审计查询 | `nodes.ts` |
| `GET /diagnostics/hints`，`GET /nodes/:id/diagnostics` | 诊断（7 核心码，见 `docs/diagnostics.md`） | `diagnostics.ts` |
| `POST /nodes/:id/live-ticket` | 观测层 ticket（`snap` 15min 可复用；`live/nudge` 60s 一次性，SSE 已停用） | `live.ts` |
| `GET /nodes/:id/snapshot` | 无域名节点的轻量快照转发（2s 去重，见 `docs/live-observation.md` §8） | `snapshot.ts` |
| `GET /settings`，`PUT/DELETE /settings/:key` | 全局设置（DNS 凭据等，0002） | `settings.ts` |
| `GET/POST /cf-dns/accounts`，`PUT/DELETE /cf-dns/accounts/:id`，`POST /cf-dns/accounts/:id/refresh` | DNS 多凭据（Token 密文存 `settings.cf_dns_accounts`，只写不回显） | `cfDns.ts` |
| `GET /cf-dns/zones`，`GET /cf-dns/records?zoneId=`，`POST /cf-dns/records`，`POST /cf-dns/records/:zoneId`，`PATCH/DELETE /cf-dns/records/:zoneId/:recordId`，`DELETE /cf-dns/records/:nodeId` | 跨凭据启用 Zone 汇总；列出现有 A/AAAA/CNAME；全局域名管理可新增/改/删单条记录（设置页）；按 Zone+子域名代建记录并写 `nodes.domain`；按节点联动删除 | `cfDns.ts` |
| `GET/POST /tunnels`，`PATCH/DELETE /tunnels/:id` | 全局隧道配置（名称、对外域名、源站端口、cloudflared Token 密文）。面板只存配置，不做 Cloudflare Tunnel CRUD；被节点引用时禁止删除 | `tunnels.ts` |
| `GET/PUT /cf-dns`，`POST /cf-dns/test` | 旧版单 Token + 单 Zone 端点（兼容保留，首次多凭据写入时迁移） | `cfDns.ts` |
| `GET/POST /certs`，`PUT/DELETE /certs/:id`，`GET /certs/:id/material`，`POST /certs/:id/bind` | 全局证书库（0002，见 ADR-0006）；`PUT` 用于续期材料原位替换，`bind` 把 PEM/私钥安装到节点 Agent TLS 目录并热重载（明文节点拒绝，见 §1.1 安全通道检查） | `certs.ts` |
| `GET/POST /ssh-keys`，`PATCH/DELETE /ssh-keys/:id` | 全局 SSH 公钥库（0009；只存公钥，Worker 侧规范化并计算 `SHA256:` 指纹，重复指纹 409） | `sshKeys.ts` |
| `GET /nodes/:id/export`，`POST /nodes/:id/import` | 备份导出/导入（见 `docs/backup.md`） | `backup.ts` |
| `GET /agent/releases`；`POST /nodes/:id/agent/install-command|upgrade-command|uninstall-command|upgrade` | Agent 生命周期命令与升级（见 `docs/agent-lifecycle.md`、`docs/agent-releases.md`） | `agent_lifecycle.ts`（命令组装在 `lib/agent-commands.ts`，发布包校验在 `lib/agent-releases.ts`） |

`apply` 时 Worker 把 D1 里该应用最新的 `config` 和 `rev` 一起带给 Agent，前端不直接传配置给 Hub，保证"仓库是唯一事实来源"。

### 2.2 Agent API

以下路径均以 `/api/v1` 为前缀的 Worker 路由转发，签名与超时见 §1.1。

| 端点 | 说明 |
|---|---|
| `GET /health` | 无鉴权，`{ok, version}` |
| `GET /state` | 主机基本信息 + 每个已装应用的 `adapter.status()` 和已生效 rev（打开工作区一次性）；可选 `tasks` 任务摘要（ADR-0018） |
| `GET /snapshot` | 轻量指标：CPU/内存/磁盘/负载/uptime + 可选 `tasks` 任务摘要（10s 轮询，不含适配器/端口/服务进程） |
| `GET /adapters` | 可用适配器 `{name, version, api, schema, actions, requires_root, capabilities, description}` |
| `POST /apps/:app/:action` | 同步动作直接返回；`install/uninstall/长动作` 返回 `{taskId}` |
| `GET /tasks/:tid` | `{state, progress, logs[], result, error}` |

**统一响应信封**（任何动作都一样，前端通用组件据此渲染）：

```json
{ "ok": true, "rev": 12, "changes": [{"path": "/etc/wireguard/wg0.conf", "diff": "..."}],
  "result": { "cards": [{"title": "登录地址", "value": "https://...", "copy": true, "qr": false}] },
  "warnings": [], "error": null }
```

`result.cards` 是安装结果的标准形态（地址、账号、token、二维码），通用 UI 直接展示，不需要每个应用自己写结果页。

失败时：`{ "ok": false, "error": { "code": "apply_failed", "message": "...", "details": {...} } }`。

**返回结构（冻结）**

- `GET /state` → `{ host: { hostname, os, kernel, uptime, load, disk, mem }, adapters: [{ name, version, appliedRev, status }], ports: [{ proto, port, app }] }`
- `tasks`（可选，ADR-0018）→ `{ items: [{ id, app, action, state, progress, createdAt, updatedAt, logs[], errorCode?, errorMessage? }], total, truncated }`：进行中优先、最多 5 条、日志末 4 行（每行 ≤160 字符）、整段 ≤6 KiB、已脱敏；旧 Agent 不返回该字段
- `GET /adapters` → `[{ name, version, api, schema, actions, requires_root }]`
- 任务状态机：`pending → running → done | error | canceled`；任务状态落盘（`<data>/tasks/<id>.json`，0600），Agent 重启后 `/tasks/:id` 仍可查历史任务，未完成任务一律改写为 `error(agent_restarted)`；记录按数量上限与保留期（7 天）清理
- 端口登记：Agent 本地 `ports.json`（`{proto,port} → app`），冲突返回 `409 busy` 并说明占用者
- 并发写锁：同一节点同一时间只允许一个写动作；冲突返回 `409 busy`
- 幂等键：写动作必须带 `Idempotency-Key`，Agent 保留 10 分钟内的结果，重复请求直接回放
- **rev epoch（纪元，D-2/R-2）**：节点记录带 `rev_epoch`（创建时生成；节点重建/恢复 =
  新节点行 = 新纪元；迁移 0007 为存量节点回填）。Worker 在 apply 载荷携带当前纪元；
  Agent 持久化并在 `/state` 与 apply 响应回传。Agent 发现纪元不一致即判定"旧纪元"：
  清除全部应用的 `appliedRev` 基线（保留配置快照），控制面重建/恢复后重新计数低 rev
  的下发不再 409（rev 分叉导致 peer 失联/永久 apply 失败的根因）；Agent 本地无纪元
  （新装/在线升级）则直接采纳、不清基线，现有节点升级零感知。Worker 在 `/state`
  对比 Agent 回传纪元，不一致时响应带 `epochStale:true`（旧 Agent 不回传则按待升级
  处理，不判定）。

### 2.3 D1（核心 4 表 + C3/观测层扩展）

核心 4 表（`migrations/0001_init.sql`，冻结）：

```sql
CREATE TABLE nodes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, endpoint TEXT NOT NULL,      -- https://hub-a.example.com:8443
  tunnel_endpoint TEXT,                    -- 选定方案 B 后填：https://hub-a-t.example.com（cloudflared 隧道）
  preferred_route TEXT NOT NULL DEFAULT 'direct' CHECK (preferred_route IN ('direct','tunnel')),
  token_enc TEXT NOT NULL, last_seen_at INTEGER,  -- 轻量可达租约；运行快照不落库
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE app_configs (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  app TEXT NOT NULL,                       -- 'wireguard' / 'sing-box' / ...
  schema_version INTEGER NOT NULL,
  config_json TEXT NOT NULL,               -- AES-GCM 密文；Worker 仅在写入时用明文派生 summary_json
  summary_json TEXT,                       -- 明文摘要：只含模式与计数，禁止私钥/证书/密码/哈希
  secrets_enc TEXT,                        -- 可选：需要回显给用户的密钥（如客户端私钥），AES-GCM
  rev INTEGER NOT NULL, applied_rev INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, app)
);
CREATE TABLE revisions (
  node_id TEXT NOT NULL, app TEXT NOT NULL, rev INTEGER NOT NULL,
  config_json TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, app, rev)
);
CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
  actor TEXT, node_id TEXT, app TEXT, action TEXT, detail_json TEXT);
```

Peers、反代站点、端口转发不再单独建表，都是各自应用 `config_json` 的字段。登录限流改用 D1（或内存兜底），去掉 KV。

核心之外的扩展表/列（迁移只增，详见 `docs/engineering/d1-migrations.md`）：

| 迁移 | 内容 |
|---|---|
| `0002_c3.sql` | `certificates`（全局证书库，私钥 AES-GCM 密文）、`settings`（全局设置，DNS 凭据等）两表；契约见 ADR-0006 |
| `0003_live_endpoint.sql` | `nodes` 加 `live_endpoint` 列（6.4a 观测层入口） |
| `0004_last_apply_error.sql` | `app_configs` 加 `last_apply_error` 列（最近一次 apply 失败摘要，成功后清空） |
| `0005_clear_runtime_state.sql` | 清空 `nodes.last_state_json` 历史数据（数据分层：运行快照不落库，见 `docs/data-layering.md`），列保留为空 |
| `0006_rate_limit.sql` | `rate_limit` 表（登录限流落 D1，见 ADR-0003 口径） |
| `0007_rev_epoch.sql` | `nodes` 加 `rev_epoch` 列并为存量节点回填随机纪元（D-2/R-2 rev 纪元，见 §2.2） |
| `0008_node_domain.sql` | `nodes` 加 `domain` 列（CF DNS 代建记录后写入的域名；未绑定为 NULL，见 `docs/cf-dns.md`） |
| `0009_ssh_keys.sql` | 新增 `ssh_keys`（全局 SSH 公钥库，只存公钥） |
| `0010_node_access.sql` | `nodes` 加 `access_mode` / `tunnel_id` / `allow_insecure`；新增 `tunnels`（全局隧道配置） |
| `0011_cert_acme_meta.sql` | `certificates` 加 ACME 元数据列（provider / 凭据设置键 / CA / 密钥类型），供一键续期 |
| `0012_app_configs_summary.sql` | `app_configs` 加可空 `summary_json`（明文摘要，只含模式与计数），让 `GET /nodes` 摘要派生零解密；旧行 NULL 时读取路径回退解密，一次性回填后不再发生 |

**rev 语义（冻结）**：`PUT` 配置时 Worker 将 `rev = max+1`；`apply` 必须带 `expectRev`，Agent 成功返回 `appliedRev`，不匹配返回 `409 conflict`；`rollback` = 用旧 config 生成**新 rev** 再 apply，不直接改 `applied_rev`。节点重建/恢复后 rev 从低重新计数时，由 `rev_epoch` 纪元判定旧纪元并自动重置 Agent 的 `appliedRev` 基线（§2.2），`409 conflict` 不再永久卡死恢复流程。

---

## 3. 适配器（以后只动这里）

### 3.1 Agent 端：`agent/adapters/<app>.py`

```python
# agent/adapters/sing_box.py
from khc import Adapter, Ctx, File, Unit

class SingBox(Adapter):
    name = "sing-box"
    version = "1.0.0"
    api = 1                      # 适配器接口版本，内核据此判断兼容性
    schema = {...}               # JSON Schema，内核用它校验 config
    ports = [("tcp", "config.port")]       # 声明端口，内核做冲突检查（含 443 共存）

    def install(self, ctx: Ctx, params) -> dict:      # 任务内执行，ctx.log() 实时日志
        ctx.download("https://github.com/.../sing-box-linux-amd64.tar.gz", sha256=...)
        ...
        return {"cards": [{"title": "订阅地址", "value": ..., "copy": True, "qr": True}]}

    def render(self, ctx: Ctx, config) -> list[File | Unit]:   # 纯函数：配置 → 文件
        return [File("/etc/sing-box/config.json", json.dumps(...), mode=0o600),
                Unit("sing-box.service", restart=True)]

    def validate(self, ctx: Ctx, files) -> None:      # 可选：sing-box check -c
        ctx.run(["sing-box", "check", "-c", files[0].tmp_path])

    def status(self, ctx: Ctx) -> dict:
        return {"running": ctx.unit_active("sing-box"), "version": ...}

    def uninstall(self, ctx: Ctx, purge: bool) -> None: ...

    actions = {}                 # 自定义动作，如 wireguard 的 rotate_peer
```

**内核替适配器做掉的事**（适配器不许自己做）：

- `plan`：调 `render()`，与现网文件做 diff 并返回，不落盘。
- `apply`：`render()` → 写临时文件 → `validate()` → 备份旧文件 → 原子替换 → 重启/重载声明的 unit → 健康检查 → 失败**自动回滚**到备份。适配器只写 `render()`，回滚和幂等由内核统一保证。
- 端口登记与冲突检查；Caddy 片段装配：适配器返回 `CaddySnippet(...)`，内核写到 `/etc/caddy/khc.d/<app>.caddy`，主 Caddyfile 只有 `import khc.d/*`，`caddy validate` 通过才 reload。
- 下载校验 sha256、任务日志、超时、并发锁（同一节点同一时间只执行一个写动作）。

### 3.2 前端：`apps/web/src/apps/<app>/page.tsx`

```tsx
export const meta = { app: "sing-box", title: "sing-box", adapter: ">=1.0.0 <2" };
export const schema = z.object({ ... });           // 输入校验；与适配器 schema 同源字段
export default function Page({ config, save, run, state }: AppPageProps) { ... }
```

- 外壳用 `import.meta.glob('./apps/*/page.tsx')` 自动注册，**加页面不改路由、不改菜单代码**。
- 没写专属页面的应用，外壳根据 `/adapters` 返回的 JSON Schema 渲染一个通用表单，先能用。
- 共享组件库（外壳提供，冻结）：表单字段、`ApplyBar`（保存 / 预览 diff / 应用）、任务日志抽屉、结果卡片（复制 / 二维码）、版本历史对比、确认弹窗。专属页面只负责布局和交互细节。
- `meta.adapter` 与 Agent 报告的适配器版本不兼容时，页面顶部提示"请先升级 Agent"，不允许 apply。

### 3.3 版本与分发

- Agent = 内核 + `adapters/` 目录，打成一个 tar 包（附 sha256），放在 Worker 的静态资源里。`POST /apps/agent/upgrade` 任务负责下载、校验、替换、重启，失败回退到旧版本目录。
- 一期交付物是 **tar.gz（内核 + adapters）**，不是单文件；安装脚本落 `/opt/khc-agent`，卸载脚本必须清理 `/opt/khc-agent`、`/etc/khc-agent`、`/var/lib/khc-agent`、systemd unit 和 Caddy 片段（`--purge` 时连 token 一起删）。单文件 Go Agent 放二期。
- 适配器接口 `api` 只做加法；必须破坏兼容时 `api` 升到 2，内核同时支持 1 和 2 一个大版本周期。

### 3.4 "核心冻结"的验收标准

用一个全新应用（建议 node_exporter）做演练：**只新增两个文件**，就能完成 安装 → 配置 → 预览 diff → 应用 → 回滚 → 卸载 全流程，`git diff --stat` 里不出现 `apps/api/`、`migrations/`、`packages/contracts/`、`agent/khc/`。做不到就说明核心还没设计完，继续改核心，直到做到为止。

### 3.5 受控装包与 recipe 目录（P1）

两个新增的**知识层**能力，仍然不改 Worker 路由/D1：

1. **受控系统包安装**（`agent/khc/pkg.py`，仅 system profile / root）
   - 白名单固定：`caddy`、`wireguard-tools`、`socat`；其他包名一律拒绝。
   - 自动识别 `apt-get` / `dnf` / `yum` / `apk`；命令全部是 argv 列表，经 `ctx.run()`，不拼 shell。
   - 超时：探测 15s、`apt-get update` 180s、安装 300s；输出只保留尾部。
   - 失败回滚：安装前记录二进制是否存在；安装失败或装后二进制不可用 → 尝试卸载并报 `pkg_install_failed`。
   - 适配器通过 `capabilities: {"pkgInstall": true}` 声明能力；面板只在看到该能力时展示「一键安装」，旧 Agent 不露按钮。

2. **recipe 引擎**（`agent/khc/recipes.py` + `agent/adapters/app_catalog.py`）
   - 清单 `agent/recipes/catalog.json` 随 Agent 包发布；面板只能选已发布 recipe id，不能上传任意 shell。
   - 参数经 `KHC_PARAM_<KEY>` 环境变量传入；未知参数/类型/范围在 Agent 侧校验。
   - 脚本最后输出 `KHC_RESULT={"access":[...],"cards":[...]}`；结果写入 `<data>/recipes/results/<id>.<action>.json`，权限 0600，密码类参数不进任务日志。
   - 清单 `writes` 必须在白名单根（`/etc/khc-recipes`、`/opt/khc-recipes`、`/var/lib/khc-recipes`、`/etc/systemd/system/khc-*`）下，且目标/父级不能是符号链接。
   - 安装/卸载是后台任务：`POST /apps/app-catalog/recipe_install|recipe_uninstall`，参数 `{recipeId, values}`；已安装清单落 `<data>/recipes/installed.json`（0600）。
   - `POST /apps/app-catalog/recipe_install` 返回 `{taskId}`；任务结果里的 `cards`/`access` 不写 D1、不进审计。

---

## 4. 首批适配器

| 适配器 | 说明 |
|---|---|
| `wireguard` | 接口 + peers；自定义动作 `rotate_peer`、`confirm_rotation`、`cancel_rotation`、`client_config`（见 §5） |
| `caddy-site` | 反代/静态站点，产出 Caddy 片段 |
| `port-forward` | socat/nftables 转发单元 |
| `node-exporter` | 演练用（§3.4） |
| `chisel-server` / `chisel-client` | 无 root peer 接入（§5A） |
| `app-catalog` | 应用目录：recipe 安装/卸载任务 + 已安装清单（§3.5） |
| 其他常用软件 | 待定 |

---

## 5. WireGuard 改密钥不失联

### 5.1 为什么会失联

WireGuard 用**公钥识别 peer**。在面板上"把 peer 的密钥改掉"，等于 Hub 删掉旧 peer、加了一个新 peer，而对端设备手里还是旧私钥。从 apply 的那一刻起，对端就再也握不上手了。几个放大因素：

1. **原地修改**：旧密钥立刻作废，中间没有任何过渡期。
2. **对端无法自动更新**：手机、笔记本只能人工导入新配置；有 Agent 的远端机器，如果遥控线本身走的是这条 WG 隧道，就形成先有鸡还是先有蛋的问题。
3. **AllowedIPs 不能重叠**：同一个 `/32` 不能同时挂在两个 peer 上（后写入的会把前一个的抢走），所以"新旧两把钥匙并存"不能简单地加两条 peer。
4. **重载方式粗暴**：`wg-quick down/up` 或 `wg setconf` 会重置所有会话，波及其他 peer。

### 5.2 业内做法

- **Tailscale / NetBird / Netmaker**：密钥由设备**本地生成**，私钥不离开设备；控制面只分发公钥，走独立的 HTTPS/gRPC 控制通道（不经过 WG 数据面）；换钥时新钥注册到控制面，再推送给所有相关 peer，旧钥在过渡期后才失效。核心是"控制面与数据面分离 + 先加后删"。
- **网络设备的 commit confirmed**（Junos `commit confirmed`、`netplan try`、MikroTik Safe Mode）：变更先生效，在规定时间内没有得到确认就自动回滚。核心是"不确认就回退"。
- **WireGuard 协议本身**：会话密钥每 2 分钟左右自动重协商，已具备前向保密。**静态密钥不需要定期轮换**，只在设备丢失、密钥泄露、换手机时才需要换。这意味着轮换是低频动作，可以设计得稳妥一些、慢一点。

### 5.3 本项目方案：握手确认后切换（make-before-break）

关键事实：**WireGuard 握手不依赖 AllowedIPs**。一个 AllowedIPs 为空的 peer 也能完成握手，Hub 能看到它的 `latest-handshake`，只是不转发它的流量。利用这一点：

```
状态机（存于 wireguard 的 config_json.peers[i].rotation）

 ACTIVE ──rotate_peer──▶ PENDING ──新钥握手──▶ CUTOVER ──宽限期结束/确认──▶ ACTIVE（新钥）
                           │                     │
                           └──cancel / 超时──▶ ACTIVE（旧钥，零影响）
                                                 └──回滚──▶ ACTIVE（旧钥）
```

**步骤：**

1. **rotate_peer（准备，零影响）**
   - 生成新密钥对。私钥在哪里生成取决于对端类型（见 5.4）。
   - Hub 执行 `wg set wg0 peer <NEW_PUB> allowed-ips ""`（必要时带 preshared-key）。**旧 peer 一个字不动，仍在正常工作。**
   - 面板显示新的客户端配置和二维码，状态显示「等待新密钥握手」。配置文件里的 Address 与旧配置相同。
2. **对端切换**：用户在手机上导入新配置（或远端 Agent 自动切换）。对端用新钥发起握手，握手成功。
3. **CUTOVER（Agent 自动，秒级）**
   - Agent 的轮换看守线程每 1s 查一次 `wg show wg0 latest-handshakes`。发现 `<NEW_PUB>` 的握手时间晚于轮换开始时间，就执行 `wg set wg0 peer <NEW_PUB> allowed-ips <原 IP>`。这一步会把 IP 从旧 peer 上"抢"过来，切换是原子的。
   - 旧 peer 保留（AllowedIPs 已为空）进入宽限期（默认 24h）。宽限期内可一键回滚：把 IP 挪回旧 peer 即可。
   - 从对端导入新配置到流量恢复，中间最多只有约 1s 的间隙。
4. **收尾**：宽限期结束或用户点「确认完成」后，删除旧 peer，写回 `wg0.conf`，`rev+1`。
5. **超时与取消**：PENDING 超过设定时间（默认 7 天）没有握手，或用户点取消，就删除新 peer，旧钥一直正常工作。

**实现约束（写进 wireguard 适配器）：**

- 只用 `wg set` 和 `wg syncconf` 做增量变更，**禁止** `wg-quick down/up` 和 `wg setconf`；`wg0.conf` 只作为落盘持久化，由 `wg-quick save` 或内核渲染。
- 看守线程只在有 PENDING 轮换时运行，没有轮换时零开销。它运行在 Agent 本地，**不依赖面板是否打开**，用户在手机上导入后即使关了面板也会自动切换。
- 轮换状态同时保存在 Agent 本地（`/var/lib/khc-agent/wg-rotation.json`，重启后恢复）和 D1（面板展示）。以 Agent 为准，`/state` 上报。
- 同一个 peer 同一时间只允许一个进行中的轮换。

### 5.4 按对端类型区分

| 对端 | 私钥在哪生成 | 流程 |
|---|---|---|
| **手机 / 笔记本**（无 Agent） | Hub 上的 Agent 生成，私钥通过响应返回一次给面板，用于显示二维码；如需以后重新下载，存入 `secrets_enc` | 5.3 全流程，用户扫码导入即自动切换 |
| **有 Agent 的远端机器**（家里的服务器、另一台 Hub） | **对端 Agent 本地生成**，只上报公钥，私钥永不离开该机器 | Worker 编排：① Hub 加 PENDING 新 peer → ② 对端 Agent 切到新私钥（`wg set wg0 private-key`，对端自带 30s commit-confirmed：30s 内没握上就切回旧私钥）→ ③ Hub 看到握手后 CUTOVER。全程走公网 HTTPS 控制通道 |
| **Hub 自己的接口密钥**（影响所有 peer） | 尽量不换 | 必须换时：在新端口起 `wg1`（新密钥），用 5.3 的方式逐个把 peer 迁过去，全部迁完再停 `wg0`。不做"一次性换掉所有人" |

### 5.5 面板交互

- Peer 详情页**没有可编辑的密钥字段**，只有「轮换密钥」按钮。
- 点击后：显示新二维码和配置；状态条显示「等待新设备握手 · 旧密钥仍然有效」；握手成功后变为「已切换 · 24 小时内可回滚」，并显示「回滚」「确认完成」两个按钮。
- 列表上用徽章标出进行中的轮换。
- 删除 peer、修改 AllowedIPs 这类必然断开的操作，弹窗明确写出"该设备会立即断开"。

### 5.6 跨节点迁移（2026-11-07）

把一个 Peer 从节点 A 迁到节点 B，复用既有动作，不新增 Agent 动作：

1. 面板读取 B 的 wireguard 配置，按目标网段分配新地址，创建同名（重名自动追加 `-2`）且密钥留空的 Peer；
2. 保存并 `apply` B 的配置，由 **B 的 Agent 现场生成新密钥**（不复用 A 上的任何密钥）；
3. 调用 B 的 `peer_install_script`，输出覆盖客户端 `/etc/wireguard/khc0.conf` 的一键脚本；
4. 源节点 A 的 Peer 不自动删除，设备确认连上 B 后由用户手动删除。

客户端接口名固定 `khc0`，因此迁移脚本与节点无关；每次迁移都是新密钥，不涉及跨节点密钥搬运。

---

## 5A. 没有 root 的 peer

### 5A.1 结论

**chisel 不能替代 WireGuard**：它是端口隧道（HTTP/WebSocket 上跑 SSH），不是三层组网。但对**没有 root 权限的 peer** 来说，它是最稳的接入方式。分层如下：

| 节点类型 | 传输方式 | 说明 |
|---|---|---|
| Hub、有 root 的 peer | WireGuard 内核版 | 维持 §5 的握手后切换流程 |
| 无 root peer（默认） | **chisel 客户端 → Hub 上的 chisel server（WSS，挂在 Caddy 后面）** | 只转发声明过的端口；走 HTTPS，UDP 被限速或封锁的网络也能用 |
| 无 root peer（可选） | **wireproxy**（用户态 WireGuard） | 只需映射少量 TCP 端口、又想留在同一个 WG 网络里时使用；Hub 不用改，直接套用 §5 的换钥流程 |

不引入 Tailscale 用户态（需要 headscale 协调服务器，太重），也不引入 frp/rathole（和 chisel 定位相同，没有必要再加一种）。

### 5A.2 方案对比

| | chisel | wireproxy | WireGuard 内核版 |
|---|---|---|---|
| 本质 | TCP/UDP 端口隧道，WebSocket + SSH | 用户态 WG 客户端（wireguard-go + 用户态网络栈） | 三层虚拟网卡 |
| root | 不需要 | 不需要 | 需要（或 CAP_NET_ADMIN） |
| 穿透 | HTTPS/WSS，可以放在 Caddy 或 CF CDN 后面；自带指数退避重连和 keepalive 超时检测 | 仍然是 WG UDP | WG UDP |
| 反向暴露 peer 上的服务 | `R:` 反向转发 | `TCPServerTunnel` | 原生 |
| 鉴权和换钥 | authfile（`user:pass` → 地址正则白名单），**热加载**：删掉的用户立即不能再建新隧道，已经建立的隧道不受影响 | 与 WG 相同 | §5 |
| 不足 | 不是网卡，只能转发声明过的端口 | SOCKS5 的 UDP、UDP 静态路由尚未支持；仓库换过几次维护者 | 没有 root 用不了 |

### 5A.3 chisel 落地（两个适配器，核心不动）

- `chisel-server`（Hub）：监听 `127.0.0.1:<port>`，由 Caddy 在高位端口上做 WSS 反代（`/_tunnel/*`）。启动参数 `--reverse --authfile /etc/khc/chisel-users.json`，并用 `--keyfile` 固定服务端密钥，客户端用 `--fingerprint` 校验。
- `chisel-client`（peer）：普通用户运行，配置项为 server URL、fingerprint、`--auth`、remotes 列表（如 `R:127.0.0.1:2201:localhost:22`）。
- **authfile 正则必须写锚点**（`^R:127\.0\.0\.1:2201$`），否则会被前缀匹配越权。由适配器生成，不允许手写。
- 反向端口由内核的端口登记统一分配，只绑定 Hub 的 `127.0.0.1`，再由 Caddy 或转发单元决定是否对外暴露。
- **换钥（同样是先加后删）**：① authfile 新增 `user:新密码`，热加载；② peer 端 Agent 换成新凭据并重启客户端，确认重连成功；③ 删除旧用户。失败就停在 ① 之后，旧凭据仍然可用。

### 5A.4 对核心的影响：Agent 支持普通用户运行（控制面不加代理）

- 安装脚本检测到没有 root 时，进入 user 模式：程序在 `~/.local/share/khc-agent`，配置在 `~/.config/khc-agent`，用 `systemd --user` 管理（并提示执行 `loginctl enable-linger`）；没有 systemd 时退化为 nohup 加 crontab `@reboot`。
- `/adapters` 返回每个适配器的 `requires_root`。user 模式下，面板把需要 root 的应用置灰，并说明原因。
- 无 root peer 的控制通道：优先让 peer 自己跑**用户态 cloudflared**（出站隧道），Worker 直接访问 `<peer>-t.<domain>`，与 Hub 走同一套 HMAC，**核心不需要新增代理端点**。chisel 只负责数据面端口转发（§5A.3），控制面不经过它。
- 如果将来必须复用 Hub 的 chisel 反向端口做控制通道，需要在核心加一个**通用代理端点**（含鉴权、超时、审计），这属于核心变更，不在本期范围。
- 这类 peer 改 chisel 数据面配置时仍要带 30s commit-confirmed：重连失败自动回退旧配置（与 §5.4 对远端 WG 机器的规则相同）。

---

## 6. 不做的事

服务器监控、告警、指标图表；心跳和后台同步；离线命令队列；签名插件市场；多用户和权限系统。

> 原 §6–§10（对现有代码的处理、里程碑、已拍板、二期）已移至 `docs/archive/2026-11/design-v3-milestones.md`。
