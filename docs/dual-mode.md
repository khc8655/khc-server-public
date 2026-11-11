# Hub 双模式设计：纯 Caddy 网关 ↔ WireGuard 组网（C4）

> 状态：**已实现（2026-10-26）**；按默认决策 D1/D2/D7/D15 落地，staging 完成 wg → caddy/caddy → wg 往返验证。
> 适用范围：节点双模式（wg/caddy/unknown）机制 ｜ 最后核验：2026-11-02（docs consolidation） ｜ 关联：docs/design-v3.md §2.1、docs/backup.md

> 状态：**已实现（2026-10-26）**；按默认决策 D1/D2/D7/D15 落地，staging 完成 wg → caddy/caddy → wg 往返验证。

> **状态**：设计稿（2026-10-26，待主人拍板；实现前需先交 UI 变更单 #012）
> **唯一权威范围**：双模式的状态模型、切换顺序与编排、兼容性约束（端口/证书/站点/转发/防火墙）、Agent 侧改动清单、预检 API、观测与验收。UI 细节待 #012。
> **输入**：`docs/design-v3.md`（适配器/内核/apply 语义、§5 换钥）、`docs/legacy-feature-inventory.md`（C4 双模式）、`docs/plan-v4.md`（C4 范围与 `wireguard.enabled`）、`agent/khc/kernel.py`（apply/rollback/端口登记/健康检查）、`agent/adapters/wireguard.py`（C2）、`agent/adapters/caddy_site.py` 与 `docs/caddy-management.md`（C3）、`docs/port-forward.md`（C4）。
> **一句话**：**模式只由一个字段决定——`wireguard.config.enabled`**；切换 = "先把目标服务验到健康，再对 WireGuard 做一次可回退的启停"；Caddy 站点与证书在两种模式下配置完全不动，因此**站点零中断**，而 WireGuard 客户端按模式定义会断开（这不是故障，是模式语义）。

---

## 0. 三句话

1. **不新增模式表、不新增 `nodes.mode` 真源**：`wireguard.config.enabled`（默认 `true`，缺失即视为开启）是唯一真源；"当前模式"是从 D1 配置 + Agent `/state` **派生**出来的。
2. **切换不是"搬 80/443"**：默认端口布局下，Caddy 占 `tcp/80`、`tcp/443`（HTTP/3 时另有 `udp/443`），WireGuard 占 `udp/51820`，两者不冲突。切换真正改变的是 **WG 接口的启停**；"先让 Caddy 接管/健康、再停 WG"是**门禁顺序**，只有 `udp/443` 这类端口重叠时才变成真正的手工交接。
3. **无中断的边界要说清**：Caddy 站点、证书、ACME 续期、Caddy 监听端口全程不受影响（切换不触发 Caddy reload）；WireGuard 客户端会按模式断开/重连。UI 确认框必须列出断开的客户端数、会失效的依赖项。

---

## 1. 概念边界

### 1.1 两种节点模式

| 模式 | 语义 | `wireguard.enabled` | 运行态 | 典型用途 |
|---|---|---|---|---|
| **WireGuard 组网 Hub**（`wg`） | 节点同时是 VPN 网关 + Caddy 反代/站点 | `true`（默认） | `wg0` 接口 up；peers 可握手；端口转发可用；Caddy 站点可反代 Peer 内网 | 内网穿透、家庭/公司组网、SSH 转发 |
| **纯 Caddy 网关**（`caddy`） | 只做公网 HTTP/HTTPS 反代与证书托管，不开 VPN | `false` | 无 `wg0`；无 peers 握手；端口转发停用；Caddy 站点/证书照常 | 公网建站、仅需 TLS 反代、无 root 的机器 |

两种模式共用同一个 Agent、同一套 Caddy 配置、同一份证书库、同一份备份；**WireGuard 的配置（接口、Peer、密钥）在 `caddy` 模式下保留不删**，切回时原样恢复。

### 1.2 与"入口模式（站点优先 / 代理优先）"不是一回事

| 概念 | 含义 | 归属 | 本期 |
|---|---|---|---|
| **节点模式**（本文） | 是否启用 WireGuard 组网（`wireguard.enabled`） | C4 | **实现** |
| **入口模式**（`ui-spec` F1 步骤 3 里写的"站点优先/代理优先"） | 谁占 `443/tcp`：Caddy 还是代理内核（sing-box/Xray） | v0.5 代理插件阶段 | **不在本期**；当前没有代理内核适配器 |

> 为避免混淆，建议把 F1 步骤 3 的"入口模式"改名为"**节点用途**：WireGuard 组网 Hub / 纯 Caddy 网关"，把 443 归属问题留给代理插件阶段（见 §10 D11）。

### 1.3 "无中断"的准确含义

| 对象 | 切换时是否中断 | 说明 |
|---|---|---|
| Caddy 站点（HTTP/HTTPS） | **零中断** | 切换不修改 `caddy-site` 配置、不 reload Caddy；`caddy.service` 不重启 |
| 证书（D1 vault / Caddy 自动 HTTPS / `$cert` 引用） | **零中断** | 证书文件、ACME 账户、续期状态都在原位；80/443 始终由 Caddy 持有 |
| Caddy 监听端口（80/443、站点自定义端口） | **不变** | 端口登记不变；不释放、不重绑 |
| WireGuard 客户端 | **按模式断开** | 关闭 WG = 所有 Peer 掉线；重新开启后凭原配置自动重连 |
| 依赖 WG 的端口转发 | **失效** | 目标通常是 Peer 内网 IP；`caddy` 模式下应停用（见 §3.5） |
| 依赖 WG 上游的 Caddy 站点 | **失效** | 上游写的是 Peer 的 `10.99.x.x`；预检会列出并要求确认（见 §3.4） |

**所以"无中断"= Caddy 侧无中断，不是"什么都不受影响"。** 确认框必须区分这两类后果。

---

## 2. 状态模型

### 2.1 单一真源

```
D1: app_configs(node_id, app='wireguard').config.enabled : boolean（默认 true）
```

- **缺失 = true**（向后兼容：v3 已有 WireGuard 配置、旧备份、旧前端都不带此字段）。
- 新增字段走 Agent 适配器 schema 的 `default: true`，**不改 D1 表、不加迁移**。
- `caddy-site` 配置**不需要**任何模式字段：Caddy 在两种模式下都照常 apply。
- `port-forward` 配置也不加字段：`caddy` 模式下由用户停用/预检拦截（见 §3.5）。

**明确不采用**：`nodes.mode`（`wg`/`caddy`）列、`caddyOnly` 布尔、或在 `caddy-site` 里存 `mode`。理由：多一处真源就多一处不一致；`plan-v4` §3 里的 `nodes.mode` 建议只作为**派生缓存**（且默认不做），见 §10 D1。

### 2.2 派生状态（3 态）

> 2026-10-29（#50）精简：7 态 + 13 个预检码 → 3 态 + 4 个阻断 + 1 条影响摘要。

由 D1 `enabled`（唯一真源）× Agent `/state` 是否可达推出：

| mode | 条件 | 含义 | UI 呈现 |
|---|---|---|---|
| `wg` | `enabled=true` 且 Agent 可达 | 组网 Hub | 绿色徽章「组网 Hub」 |
| `caddy` | `enabled=false` 且 Agent 可达 | 纯网关 | 蓝色/中性徽章「Caddy 网关」 |
| `unknown` | Agent 不可达，或没有 `wireguard` 配置行 | 无法确认/未初始化 | 中性徽章「未确认」+ 不可切换 |

- **不再有 `switching_*`**：切换就是一次 apply，进行中由切换按钮 loading 表达。
- **不再有 `degraded_*`**：apply 失败本来就自动回滚并返回错误；运行健康问题归诊断（`docs/diagnostics.md`）。
- 阻断/影响与模式正交；旧版过渡态判断（`rev > appliedRev` 显示"下发中"）已删除。

### 2.3 数据表达示例

**WireGuard 组网（默认）**：

```json
{
  "enabled": true,
  "interface": { "name": "wg0", "address": "10.99.0.1/24", "listenPort": 51820, "...": "..." },
  "peers": [ { "name": "phone", "publicKey": "...", "allowedIps": ["10.99.0.2/32"], "enabled": true } ]
}
```

**纯 Caddy 网关**（同一份配置，只把 `enabled` 置 false；peers 保留）：

```json
{
  "enabled": false,
  "interface": { "name": "wg0", "address": "10.99.0.1/24", "listenPort": 51820, "...": "..." },
  "peers": [ { "name": "phone", "publicKey": "...", "allowedIps": ["10.99.0.2/32"], "enabled": true } ]
}
```

- **不删** interface/peers/密钥；Agent 的 keystore（`wireguard-keys.json`）、运行时快照、换钥状态都保留（`enabled=false` 不清 keystore）。
- `caddy-site` 的 `sites[]`、`tls`、`$cert` 引用完全不变。
- 旧备份导入：不带 `enabled` → 默认 true；带 `enabled=false` 的备份导入后显示"待生效"，不会在导入时自动切模式。

### 2.4 状态推导伪代码（Worker 纯函数）

```ts
function deriveMode(input: {
  desired: 'wg' | 'caddy' | null;       // 由路由从 D1 enabled 读取
  reachable: boolean;                    // Agent /state 是否可达
  impacts: ModeImpactContribution[];     // 各适配器 status().modeImpact
  configDirty: boolean;                  // 任一应用 rev > appliedRev
  basePath: string;
}): {
  mode: 'wg' | 'caddy' | 'unknown';
  target: 'wg' | 'caddy' | null;
  blockers: ModeIssue[];
  warnings: ModeIssue[];
} {
  const mode = !input.reachable || input.desired === null ? 'unknown' : input.desired;
  const target = mode === 'wg' ? 'caddy' : mode === 'caddy' ? 'wg' : null;
  // 只汇总 target 方向的 blockers/summary；configDirty 恒阻断
  // 影响片段拼成唯一一条 MODE_WARN_IMPACT
}
```

> 该函数放 `apps/api/src/lib/mode.ts`，输入全部来自 D1 + `/state`，**不写库、不调动作、不出现应用名**，可直接单测（见 §8.3）。

---

## 3. 兼容性：端口、证书、站点、转发、防火墙

### 3.1 端口矩阵

| 组件 | 协议/端口 | 谁登记 | `wg` 模式 | `caddy` 模式 |
|---|---|---|---|---|
| Caddy 站点 | `tcp/<site.listenPort>`（默认 443；可 80/8443/自定义） | `caddy-site.port_claims()` | 占用 | **占用（不变）** |
| Caddy HTTP/3 | `udp/443`（Caddy 2.6+ 默认开启，Agent 不显式管理） | 未登记（已知缺口） | 占用 | **占用（不变）** |
| WireGuard | `udp/<interface.listenPort>`（默认 51820） | `wireguard` 端口声明（需改为 `port_claims()`） | 占用 | **释放** |
| 端口转发 | `tcp|udp/<forward.listenPort>` | `port-forward` | 占用 | 应停用（否则 socat 空转/重启） |
| Agent | `tcp/8880`（控制通道） | 无 | 占用 | 占用（不随模式变化） |
| 站点自定义监听 | 任意 `tcp` | 同上 | 占用 | 占用 |

**冲突规则**（沿用内核 `PortRegistry`）：

- 同一 `proto/port` 只能属于一个 app；冲突在 apply 时返回 `409 port_conflict`（`details.occupiedBy`）。
- Caddy 站点在 plan/apply 前额外只读 `/proc/net/tcp{,6}` 做真实监听检查：端口已被 Agent 等非 Caddy 进程占用时提前报 `port_conflict`（Caddy 自身监听不报），避免等到 `caddy validate` 才失败。
- 切换前用预检 API 提前发现，**不靠 apply 失败兜底**。
- `caddy` 模式释放 `udp/<wg-port>` 后，该端口可被其它应用使用；切回 WG 前预检会重新检查占用（若被占用则阻断，要求改端口）。

### 3.2 特例：WG 使用 `udp/443`（与 Caddy HTTP/3 冲突）

- 有些环境为了穿透会把 WG 的 `listenPort` 设为 **443/udp**；而 Caddy 2.6+ 默认在 443/udp 上开 HTTP/3，**内核端口表只登记 TCP 端口，发现不了这个真实冲突**。
- 处理：**硬阻断**。预检并入 `MODE_BLOCKED_PORT_CONFLICT`（`details` 带 `{proto:"udp", port:443, reason:"http3"}`），提示二选一：
  1. 把 WireGuard 监听端口改成 51820/其它高位端口（推荐）；
  2. 关闭 Caddy 的 HTTP/3（当前 Agent/Caddy 适配器**没有**这个开关，属后续能力，见 §10 D6）。
- **不允许**自动改端口、自动关 h3：这两件事都改变已生效配置，必须人工确认。

### 3.3 证书

| 项 | 影响 |
|---|---|
| D1 证书库（`certificates` 表） | 无影响 |
| Caddy 自动 HTTPS（ACME HTTP-01 / TLS-ALPN-01） | 无影响：80/443 一直由 Caddy 持有；`caddy` 模式下反代站点照常签发/续期 |
| `$cert` 引用（手动/自签/跨 Hub） | 无影响：证书文件路径不变，Caddy 配置不变 |
| ACME DNS-01 凭据（`settings`） | 无影响 |
| 纯 Caddy 网关无 root 运行 | 与模式正交；见 §5.6 / §10 D9 |

> 唯一相关风险：如果 `wg` 模式下 Caddy 已经处于 `inactive`（很久没 reload/挂过），切到 `caddy` 模式前必须先修 Caddy（预检 `MODE_BLOCKED_CADDY_NOT_RUNNING`），否则"切到网关"等于切到一个坏的网关。

### 3.4 Caddy 站点依赖 WireGuard 上游

站点 `upstreams` 如果写的是 Peer 的 WireGuard 内网地址（`10.99.x.x` 等），`caddy` 模式下该上游不可达：

- 由 `caddy-site` 适配器 `status().modeImpact` 扫描 enabled 站点，与已生效的组网网段比对。
- 命中 → 计入**影响摘要**（一条 warning）：「K 个站点的上游在内网（站点名…），切换后不可用」，确认框勾选一次即可。
- **不再硬阻断**（包括"全部站点都依赖 WG"的旧特例）：用户可能就是要临时切网关。
- 切回 `wg` 后自动恢复，无需改站点配置。

### 3.5 端口转发依赖 WireGuard

`port-forward` 的 `targetHost` 通常是 Peer 的内网 IP（或域名），`caddy` 模式下必然失败。

- `port-forward` 适配器 `status().modeImpact` 上报 enabled 转发条数，计入影响摘要：「L 条端口转发会停止」。
- **不再阻断**（旧版要求先手动停用）；切换后由用户决定是否停用，避免 socat 重启刷日志属于操作建议，不拦切换。

### 3.6 防火墙 / 安全组

- **Agent 不管理主机防火墙，也不改云安全组**（与 `docs/port-forward.md` 一致；host-ops 的防火墙动作是独立功能，不参与模式切换，避免把自己锁在门外）。
- 切换前后需要人工确认的安全组规则（写进确认页清单）：

| 方向 | 需要放行 | 何时 |
|---|---|---|
| 切到 `wg` | 入站 `UDP/<wg.listenPort>`（默认 51820） | **切换前**；否则接口起来了但 Peer 握不上手 |
| 切到 `caddy` | 入站 `TCP/80`、`TCP/443`（站点端口） | 一直需要；切换不改变 |
| 切到 `caddy` 后（可选） | 关闭入站 `UDP/<旧 wg 端口>` | 切换成功后手工做，属安全收益，不阻塞流程 |

- 预检只能做"提示 + 复制检查命令"，**无法从 Worker 验证入站 UDP 是否放行**（没有入站探测能力）。验收时用真实 Peer 握手证明。

### 3.7 Peer、换钥与看门狗

| 项 | 规则 |
|---|---|
| PENDING 换钥 | **硬阻断**（`MODE_BLOCKED_ROTATION_PENDING`）：关闭 WG 会中断等待握手的流程，可能造成"新钥没握上、旧钥被删"的坏结果；要求先 `confirm_rotation` 或 `cancel_rotation` |
| CUTOVER 宽限期 | 允许切换，但提示"宽限期内切到网关，回滚窗口仍在 D1/Agent 本地，切回后可继续" |
| Peer 全部离线 | 允许（warn），不影响切换 |
| 看门狗线程 | `enabled=false` 时**必须跳过**轮换/接口看守（否则会对不存在的接口执行 `wg set`）；实现见 §5.1 |
| 节点重启 | `wg-quick@wg0` 在 `caddy` 模式下处于 disabled，不会自启；切回时 apply 会 enable + start |

---

## 4. 切换 SOP

> 所有"保存/应用"都走既有接口：`PUT /api/v1/nodes/:id/apps/wireguard`（只写 D1 + revision）→ `POST /api/v1/nodes/:id/apps/wireguard/apply`（携带 `Idempotency-Key`，同步 ≤15s）。Worker 在 apply 时把 D1 里最新 `config` 与 `expectRev` 一并发给 Agent，前端不直接构造配置。

### 4.1 WireGuard 组网 → 纯 Caddy 网关（目标服务先健康，再停 WG）

| 步 | 动作 | 接口 / 检查 | 超时 | 失败怎么办 |
|---|---|---|---|---|
| **S0 预检** | 只读收集：配置、运行态、依赖项、阻断项 | `GET /api/v1/nodes/:id/mode`（§6） | 4s | 有 blocker → 按钮禁用，展示原因与修复入口 |
| **S1 确认** | L2 确认框：列出将断开的 Peer 数、将停用的转发数、将失效的依赖站点 | UI | — | 取消即结束，无副作用 |
| **S2 Caddy 门禁** | 确认 Caddy 正在接管 80/443 且健康：`active=true`、`validate.ok=true`、`siteHealth` 无 `down` | `/state`（已含） | 3s | 不健康 → 中止，先去站点页/Caddy 服务修好；**绝不"先停 WG 再修 Caddy"** |
| **S3 依赖清理** | （本期人工）停用 enabled 的端口转发；确认 WG 依赖站点已知晓 | 转发页；确认框勾选 | — | 未处理 → 预检阻断（§3.5） |
| **S4 保存期望** | `PUT` wireguard 配置，`enabled=false`（其余字段原样回传），`rev+1` | `PUT .../apps/wireguard` | 3s | 失败：D1 未变，重试即可 |
| **S5 应用** | `POST .../apps/wireguard/apply`（幂等键）；Agent：render 返回空 → `after_apply` 停止并禁用 `wg-quick@wg0`、释放 `udp/<port>` 登记 | apply | 15s | Worker 超时不代表失败；进入 S6 用 `/state` 判定，必要时用同一幂等键重试一次 |
| **S6 验证** | 轮询 `/state` 直到 `wireguard.running=false`（最多 60s）；同时确认 Caddy `active`、`lastReloadAt` **未变化**、`siteHealth` 与切换前一致 | `/state` × up to 20 | 60s | 60s 未收敛 → 进入补偿（§4.4） |
| **S7 完成** | 徽章变「Caddy 网关」；Toast「已切换到 Caddy 网关」；提示可手动关闭云安全组 `UDP/<wg 端口>` | — | — | — |

**为什么 S2 在 S5 之前**：任务要求的"先 Caddy 接管 80/443，再停 WG"在本架构里就落成这条门禁——Caddy 原本就在 80/443 上，切换**不会**让它放手；S2 是确认"接管的这一侧是健康的"，否则停 WG 只是把一个坏网关暴露出来。真正的端口交接只在 `udp/443` 重叠时存在，且按 §3.2 硬阻断、人工处理。

### 4.2 纯 Caddy 网关 → WireGuard 组网（先起 WG 并健康，再确认模式）

| 步 | 动作 | 接口 / 检查 | 超时 | 失败怎么办 |
|---|---|---|---|---|
| **S0 预检** | 端口占用（`udp/<listenPort>`、443 特例）、非 root、换钥 PENDING、配置是否干净、安全组提醒 | `GET /nodes/:id/mode` | 4s | blocker → 禁用按钮 |
| **S1 确认** | L2：将开启 VPN 网关、占用 `udp/<port>`、Peer 凭原配置重连；提示先放行云安全组 | UI | — | 取消无副作用 |
| **S2 保存期望** | `PUT` wireguard 配置 `enabled=true`（interface/peers 不变） | `PUT` | 3s | 失败：D1 未变 |
| **S3 应用** | `POST apply`；Agent：render 接口 conf + unit → 内核 enable/start `wg-quick@wg0` → `after_apply` 做接口级启动/`syncconf` → 内核健康检查 | apply | 15s | 失败：内核自动回滚文件并返回 `apply_failed`（含 stage） |
| **S4 验证** | 轮询 `/state` 直到 `wireguard.running=true`；确认 `udp/<port>` 出现在 `state.ports`；Caddy 指标与切换前一致 | `/state` × up to 20 | 60s | 60s 未收敛 → 补偿回 caddy |
| **S5 Peer 验证（可选）** | 已在线 Peer 的 `latestHandshake` 在 60s 内更新；不在线 Peer 只警告 | `/state` peers | 60s | 握手失败先查安全组，不回滚模式（本机接口已起） |
| **S6 完成** | 徽章变「组网 Hub」；提示"若 Peer 仍连不上，检查安全组 UDP 与对端配置" | — | — | — |

> "反向先起 WG 健康后再切回"在本架构里 = **先让接口 up + 端口登记成功 + 健康检查通过，再把模式判定为 `wg`**；Caddy 全程不参与，也不停止。模式判定不依赖"点击完成"，而是由 S4 的 `/state` 收敛自动完成。

### 4.3 切换时序图

```
WG → Caddy:
  UI ──GET /mode──▶ Worker ──/state(3s)──▶ Agent        （预检：只读）
  UI ──L2 confirm──▶ 用户
  UI ──PUT wireguard(enabled=false)──▶ Worker ──D1 rev+1
  UI ──POST apply──▶ Worker ──HMAC /apps/wireguard/apply──▶ Agent
                                                    ├ render() → []（不写文件）
                                                    ├ after_apply → systemctl disable --now wg-quick@wg0
                                                    ├ ports.register(wireguard, [])  → 释放 udp/51820
                                                    └ 返回 {ok, appliedRev}
  UI ──GET /state×N──▶ Worker ──▶ Agent                 （验证 running=false）
  UI: 徽章 = Caddy 网关

Caddy → WG:
  UI ──GET /mode──▶ Worker（预检：端口/root/rotation/SG 提醒）
  UI ──L2 confirm──▶ 用户
  UI ──PUT enabled=true──▶ Worker（D1 rev+1）
  UI ──POST apply──▶ Agent ─ render(conf+unit) → 写 conf → systemctl enable --now wg-quick@wg0
                              → after_apply（首次 apply 不 down/up）→ health（unit active）
  UI ──GET /state×N──▶ 验证 running=true + 端口登记
  UI: 徽章 = 组网 Hub
```

### 4.4 回滚 / 补偿矩阵

| 失败点 | 现场状态 | 补偿动作 | 目标状态 |
|---|---|---|---|
| S4 保存失败 | D1 未变 | 无（重试 PUT） | 原模式 |
| S5 apply 失败（内核已自动回滚文件） | D1 期望=caddy，Agent 仍在 wg | `PUT enabled=true`（rev+2）→ `apply` → 验证 running=true | 回到 `wg` |
| S5 Worker 超时 / 结果未知 | 同上 | 先 `/state` 判实际；若仍 wg → 补偿；若已 caddy → 视为成功 | 收敛 |
| S6 验证未收敛且实际 wg | 同 S5 失败 | 同 S5 失败补偿 | `wg` |
| S2 保存失败（反向） | D1 未变 | 无 | 原模式 |
| S3 apply 失败（反向，内核已回滚） | D1 期望=wg，Agent 仍在 caddy | `PUT enabled=false`（rev+2）→ `apply` → 验证 running=false | 回到 `caddy` |
| 补偿本身失败 | 配置与运行态不一致 | **停止自动重试**；界面显示「需要人工处理」+ 只读检查命令 | 人工 |

**两层回滚，不要混淆**：

1. **内核级**（自动）：单次 `apply` 内部——写临时文件 → validate → 备份 → 原子替换 → reload/restart → 健康检查（默认 10 次 × 0.4s）失败 → 用备份恢复文件并重启 unit。**仅当本次 apply 有文件变更时才有备份**。
2. **编排级**（补偿）：模式切换失败后，把 D1 配置改回原值并再 apply 一次；这是**新的 revision**，不是 `/rollback`。

> ⚠️ **不要用 `POST .../rollback` 回滚模式**：`enabled=false` 的 apply 走"无文件变更"的快速路径（render 为空 → `changes=[]` → 不创建 backup），因此该次 apply 没有备份可回滚。模式回滚只能用"改配置 + apply"。

### 4.5 断点恢复（刷新 / 关页面 / Worker 超时 / Agent 重启）

| 场景 | 现象 | 恢复 |
|---|---|---|
| 用户关掉页面 | D1 已改，可能未 apply | 下次打开节点：`rev > appliedRev` → 显示「切换未完成」+「继续」（再 apply）或「撤销」（PUT 回原值 + apply） |
| apply 请求超时（15s）但 Agent 仍在执行 | Worker 返回错误 | 用**同一 `Idempotency-Key`** 重试一次；仍未知则只读轮询 `/state` 直到收敛（60s） |
| Agent 进程中途重启 | apply 中断 | 文件可能已替换、内核状态可能未提交；重新 apply（幂等，会重新走完整流程）；检查 `/var/lib/khc-agent/` 备份目录 |
| 节点重启 | `caddy` 模式下 `wg-quick@wg0` 已 disabled，不会自启；`wg` 模式下自动起 | 打开面板看 `/state` 是否与配置一致；不一致按「继续/撤销」 |
| 两人同时操作 | 第二个 apply 返回 `409 busy` | 等第一个结束；UI 串行化并禁用按钮 |
| 配置已保存但未 apply | 预检 `MODE_BLOCKED_CONFIG_DIRTY` | 面板提示先应用或撤销，阻断切换 |

### 4.6 禁止事项（评审红线）

- ❌ 用"卸载 WireGuard 应用"来实现关闭模式（会删配置/密钥，切回成本高；且 `uninstall` 清 snippet/runtime）。
- ❌ 在换钥 PENDING 时切换模式（§3.7）。
- ❌ 在切换过程中修改 peers / interface / 站点 / 转发（会与 apply 竞争；Agent 有写锁但会 409，体验混乱）。
- ❌ 由 Agent 自动改云安全组或主机防火墙。
- ❌ 自动改 WG 监听端口来规避 443/udp 冲突。
- ❌ 在 Caddy 不健康时切到 `caddy` 模式。
- ❌ 把"切换失败"做成自动重试循环（每次 apply 都是一次网络写操作，重试上限 1 次 + 人工决定）。

---

## 5. Agent 侧实现（只改适配器，不改内核）

### 5.1 `agent/adapters/wireguard.py` 改动清单

| # | 改动 | 现状 | 目标 |
|---|---|---|---|
| A1 | schema 增加 `enabled` | 无 | `"enabled": {"type": "boolean", "default": true}`（顶层；旧配置/旧备份缺省 true） |
| A2 | 端口声明改为条件式 | `ports = [("udp", "interface.listenPort")]` 静态声明 | **删除静态 `ports`**，改为 `def port_claims(config)`：`enabled=false` 返回 `[]`；否则返回 `[{"proto":"udp","port":listenPort}]`（内核已支持该钩子，Caddy 同款） |
| A3 | `render()` 支持关闭 | 总是返回 conf + unit | `enabled=false` → 返回 `[]`（不写文件、不碰已有 conf；配置与密钥保留，便于切回） |
| A4 | `after_apply()` 处理启停转换 | 首次 apply 直接 return；接口级变更 restart；peer-only `syncconf` | 读 `config.enabled` 与 `previous`：① 关闭：`ctx.unit_stop(unit)` + `ctx.unit_disable(unit)`，确认不再 active，写 runtime `{enabled:false,...}`；② 开启且之前 disabled：`ctx.unit_start(unit)`（`changes=[]` 的快速路径也能启动）；③ 其余保持现有逻辑；④ 关闭时**跳过** `_save_runtime` 的 peers 覆盖，只写 `enabled` 标记 |
| A5 | `health()` 支持关闭 | `_load_effective` 为空 → False | runtime `enabled=false` 时：`return not ctx.unit_active(unit)`（停止即健康）；开启时按现有逻辑（unit active 或 `wg show dump` rc=0） |
| A6 | `status()` 支持关闭 | 无 enabled 字段 | `{"installed": true, "enabled": false, "running": false, "interface": name, "peers": [], "rotations": [...]}`；**不要**把 peers 列为"离线告警"（诊断会误报） |
| A7 | 看门狗跳过 | 换钥看守线程每 1s 轮询 | `enabled=false` 或无接口时直接 sleep 跳过，避免对不存在的接口 `wg set` |
| A8 | 换钥保护 | `rotate_peer` 不检查 enabled | 关闭状态下 `rotate_peer` 返回 `409`/`ok:false` "WireGuard 已停用" |
| A9 | runtime 快照 | `{interface, peers}` | 增加 `enabled` 布尔；`_load_effective` 兼容旧快照（缺省 true） |
| A10 | 测试 | 现有 1564 行适配器测试 | 新增 ≥12 例（见 §5.7） |

**内核不需要改**：`render()` 返回空 → `_changes()` 为空 → `_apply()` 走"无文件变更"快速路径，仍会调用 `after_apply` 并执行 `ports.register(app, [])`；`PortRegistry.register` 是"替换该 app 的全部声明"，因此传空列表即释放端口。

### 5.2 apply 语义与已知细节

```
apply(enabled=false)：
  render → []
  changes = []                       ← 无文件变更
  after_apply(changes=[], config)    ← 唯一执行点：stop + disable unit
  ports.register('wireguard', [])    ← 释放 udp/51820
  store.set_applied(rev, config)     ← D1 的 applied_rev 对齐
  返回 {ok:true, rev, appliedRev, changes:[], warnings:[]}
```

- **无备份**：快速路径不创建 backup（§4.4）。关闭动作本身的幂等性由 `after_apply` 保证（先查 active 再 stop）。
- **异常**：`after_apply` 抛错会让本次 apply 失败并把错误返回 Worker；因为 `changes=[]`，内核没有可回滚内容。因此 `after_apply` 必须：先 `unit_stop(check=False)`，再 `unit_disable(check=False)`，最后重新读 active 校验；仍 active 才抛 `CommandFailed`（附带 `systemctl status` 摘要）。
- **开启**：若 conf 内容与上次完全一致（最常见：之前只是 disabled，配置没动），`changes` 也为空 → 走快速路径 → `after_apply` 检测到 `previous.enabled === false` 与 `config.enabled === true` → `unit_start`；否则 `_apply_units` 会因 `Unit(content=None)` 执行 start。
- **plan 盲点**：`render()` 返回空时 `_plan()` 的 diff 为空，面板"预览"会显示"无变更"，但 apply 实际会停接口。**本期 UI 的模式切换向导不依赖 plan 页**；是否给内核加 `adapter.warnings(ctx, config)` 钩子见 §10 D3。

### 5.3 健康检查与时序（沿用内核默认）

| 阶段 | 内核行为 | 预期耗时 |
|---|---|---|
| 文件写入 | 临时文件 + `os.replace` + chmod | <50ms |
| `validate` | `wg-quick strip` 校验（仅开启且有变更时） | <200ms |
| Caddy 片段 | `caddy validate` → reload（wireguard 不产生片段，不影响） | 0 |
| unit 启停 | `systemctl enable/start/stop/disable` | 0.3–3s |
| `after_apply` | 关闭：stop+disable；开启：首次 start / peer-only `syncconf` | 0.2–2s |
| `health` | 10 次 × 0.4s（默认） | ≤4s |
| Worker 侧 | 同步 apply 超时 15s | — |

> 关闭模式下 `health()` 只查 unit 不 active，通常第一次就通过。

### 5.4 两层回滚的边界

| 层 | 触发 | 覆盖范围 | 失败后果 |
|---|---|---|---|
| 内核 apply 回滚 | 单次 apply 中 validate/写文件/unit/health 失败 | 仅本次有变更的文件 + 重启过的 unit | 返回 `apply_failed`（`details.rolledBack`） |
| 编排补偿 | 步骤失败/验证不收敛 | D1 配置回原值 + 再 apply | 补偿失败 → 人工处理 |

### 5.5 与"换钥看守"的交互

- 关闭 WG 时若存在 PENDING 轮换：预检已阻断（§3.7）；即使绕过（直接改 API），`after_apply` 关闭后看守线程会跳过，轮换记录留在本地，切回后继续（前提是未超 7 天）。
- `install` 动作在 `caddy` 模式下仍可执行（只检查 `wg`/`wg-quick` 是否存在），但不要求；安装脚本/UI 不应在 caddy-only 节点强制安装 `wireguard-tools`（§10 D8）。

### 5.6 纯 Caddy 网关与无 root

- `wireguard` 适配器 `requires_root = True`，内核会在 user 模式 apply 时给 warning（`_warnings`：`需要 root，user 模式下不能 apply/install`）。
- **切到 `wg` 的前置**：Agent 必须以 root/system 模式运行（或具备 `CAP_NET_ADMIN`）。预检无法从 `/state` 直接判断运行模式（见 §10 D7）；本期以 apply 失败信息兜底：若 apply 返回"需要 root"，保留原模式并提示失败原因。
- **切到 `caddy`**：无 root 的 user 模式可正常完成（Caddy 若监听 <1024 需要 capabilities，属 C3 既有约束）。

### 5.7 测试清单（Agent，≥12 例）

- [ ] schema：缺省 `enabled=true`；显式 false 可解析；旧配置/旧备份（无字段）行为不变
- [ ] `port_claims`：enabled=true → 返回 udp/listenPort；false → `[]`
- [ ] `render(enabled=false)` → `[]`；磁盘上已有 conf 不被删除
- [ ] `after_apply` 关闭 → `unit_stop`/`unit_disable` 被调用且顺序正确；已停止时幂等
- [ ] `after_apply` 关闭时 stop 失败 → 抛 `CommandFailed`（apply 返回失败）
- [ ] `after_apply` 开启但 `changes=[]`（conf 未变）→ `unit_start` 被调用
- [ ] `health()`：enabled=false 且 unit inactive → True；unit 仍 active → False
- [ ] `status()`：enabled=false → `running=false`、peers 为空、不产生离线告警
- [ ] 看门狗：enabled=false 时 `tick` 不执行 `wg set`
- [ ] `rotate_peer`：enabled=false → `ok:false`（不生成新钥）
- [ ] runtime 兼容：旧快照无 `enabled` → 视为 true
- [ ] 内核集成（若已有 kernel 测试夹具）：apply 后 `PortRegistry` 中该 app 声明被清空

---

## 6. Worker：预检 API 与编排取舍

### 6.1 `GET /api/v1/nodes/:id/mode`（只读预检）

| 项 | 规定 |
|---|---|
| 鉴权 | `requireAuth`（同 `/nodes/*`） |
| 副作用 | **无**：不写 D1、不更新 `last_seen_at`、不写 audit；`/state` 调用失败只影响 `reachable` |
| 超时 | `/state` 3s；整体 ≤4s |
| 缓存 | `Cache-Control: no-store`；UI `staleTime=10s` |
| 错误 | 401/404 用 HTTP 错误；节点不可达仍 **200**（`mode=unknown`） |

响应（契约在 `packages/contracts`）：

```ts
export const modeIssueSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  fixRoute: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const nodeModeSchema = z.object({
  nodeId: z.string(),
  mode: z.enum(['wg', 'caddy', 'unknown']),
  target: z.enum(['wg', 'caddy']).nullable(),
  reachable: z.boolean(),
  blockers: z.array(modeIssueSchema),
  warnings: z.array(modeIssueSchema),   // 最多 1 条影响摘要
  checkedAt: z.number().int(),
});
```

**阻断只有 4 个**（`apps/api/src/lib/mode.ts` 只排序、不判断应用）：

| code | 条件 | `details` | 处置 |
|---|---|---|---|
| `MODE_BLOCKED_ROTATION_PENDING` | `wireguard.status.rotations[]` 有 `state=pending` | `{ peers }` | 先确认/取消换钥 |
| `MODE_BLOCKED_PORT_CONFLICT` | 切到 wg 时 `udp/<listenPort>` 被其它应用登记，或 `listenPort===443` | `{ proto, port, occupiedBy? / reason:"http3" }` | 改 WG 端口 |
| `MODE_BLOCKED_CONFIG_DIRTY` | 任一应用 `rev > appliedRev` | — | 先应用或撤销 |
| `MODE_BLOCKED_CADDY_NOT_RUNNING` | 切到 caddy 且 `caddy.active=false` | — | 先修 Caddy |

**其余全部合并为一条影响摘要**：

| code | 条件 | 文案来源 |
|---|---|---|
| `MODE_WARN_IMPACT` | 目标方向有任一影响片段 | 适配器 `status().modeImpact[].summary` |

片段示例：断开 N 个客户端（M 在线）、K 个站点依赖内网上游、J 台 Peer 的远程运维会失联、L 条端口转发会停止。UI 展示一句话 + 一个确认框。

已删除的码：`MODE_WARN_FIREWALL`、`MODE_WARN_ROOT_UNKNOWN`、`MODE_WARN_TASK_UNKNOWN`、`MODE_BLOCKED_PORT_443_UDP`、`MODE_BLOCKED_FORWARDS_ENABLED`、`MODE_BLOCKED_CADDY_UNHEALTHY`、`MODE_WARN_WG_DEPENDENT_SITES`、`MODE_WARN_ALL_SITES_DEPEND_ON_WG`、`MODE_WARN_PEERS_OFFLINE`、`MODE_WARN_HOSTOPS_PEERS`。

**判定位置**：应用相关知识只在适配器 `status().modeImpact`：

- `wireguard`：换钥阻断、端口冲突、客户端断开计数；
- `caddy-site`：Caddy 未运行阻断、依赖内网上游的站点；
- `port-forward`：会停止的转发条数；
- `host-ops`：会失联的 Peer 数量。

核心 `mode.ts` 只按 `target` 筛选、排序、拼接；路由负责读 D1 的 `enabled` 与 `configDirty`。

### 6.2 编排方案对比

| 方案 | 做法 | 风险 | 工时 | 回退成本 | 对生产影响 | 结论 |
|---|---|---|---|---|---|---|
| **O1 UI 顺序编排（推荐）** | 预检 GET + 前端沿用既有 PUT/apply/state；按钮 loading 表示进行中，模式以 D1 `enabled` 为准 | 低（无新执行通道；每步可单独重试） | 2–3 人日 | 低：PUT 回原值 + apply | 低：中间态不影响 Caddy | **采用** |
| O2 Worker 单接口编排 | `POST /nodes/:id/mode` 在 Worker 内顺序做两次 apply + 补偿 | 中（单请求可能 >30s；隧道下易 524；需持久化过渡状态） | 3–4 人日 | 中：需额外补偿接口 | 中：一次请求失败后结果未知 | 若 UI 必须"一键"再做 |
| O3 Agent 内核原子编排 | 内核新增 `mode/switch`，锁内跨适配器 apply + 统一回滚 | 高（改冻结内核；跨适配器事务语义复杂） | 5–7 人日 | 高 | 中 | **不做** |

**推荐 O1 的理由**：模式切换是低频动作（一个月约 10 次打开面板，切换可能一年几次），不值得为它改内核；两个 app 的 apply 本身已各自原子；在"目标先健康、旧模式后停"的顺序下，任何中间态都不会让 Caddy 掉线。O2 的"一键"体验可以在 UI 里用连续步骤实现，不需要新执行通道。

### 6.3 为什么不新增 D1 列 / 表

- 模式真源在 `app_configs`（不透明 JSON），`enabled` 加字段不需要迁移；
- 模式与"配置是否已应用"分别由 `enabled` 与 `rev/applied_rev` 表达，不需要 `mode_transition` 列；
- 审计沿既有 `app.apply` 事件（若确实需要"模式变更"事件，见 §10 D10）。

---

## 7. UI 设计（原变更单 #012，已落地）

> 本文件只定"要什么"，视觉与交互细节以 `docs/ui-redesign/ui-guidelines.md` + `docs/ui-redesign/page-specs.md` 为准（原 v2.2 变更单 #012 与旧规范已归档，历史资料，不作为依据）。后续 UI 改动流程见 `.github/pull_request_template.md`。

### 7.1 入口与信息架构

| 位置 | 内容 | 模板/组件 |
|---|---|---|
| `/hubs/:hubId/settings` | 新增「节点模式」分区：当前模式徽章 + 两个模式说明 + 「切换模式」按钮 | T4 + `Card` / `Badge` / `Segmented` / `Button` |
| `/hubs/:hubId` 概况 | 页头副标题追加模式徽章（只读，不重复入口） | `PageHeader.summary` / `Badge` |
| `/hubs/:hubId/wireguard` | `caddy` 模式时顶部 neutral Banner「当前是 Caddy 网关模式，WireGuard 已停用」；表单只读，保存/应用禁用 | `Banner` / 既有页面 |
| `/hubs/:hubId/forwards` | `caddy` 模式时 Banner「端口转发依赖 WireGuard，当前不可用」；提供去设置切换的链接 | `Banner` / `Link` |
| F1 添加节点 · 步骤 3 | 增加「节点用途」：组网 Hub / 纯 Caddy 网关；选择网关时隐藏 WG 端口/子网字段 | 向导 T5（需同步 ui-spec F1） |

> **不新增顶级导航、不新增路由**；「节点模式」是节点设置里的一个分区。

### 7.2 切换流程（一屏抽屉）

```
当前模式徽章 → 阻断列表（带修复入口）→ 影响摘要（一条 warning + 一个确认框）→ [取消] [确认切换]
```

- 抽屉宽 480（手机全屏），底部按钮 ≤2；切换中按钮 loading，成功/失败都在同一屏用 Banner 展示。
- 有阻断时切换按钮禁用并显示 `disabledReason`；**不提供"强制切换"**。
- 有影响摘要时必须勾选「我已了解以上影响」才能切换；没有影响则直接可切。
- **不再有**独立的「确认 / 进度 Steps / 结果」视图，也没有「切回」按钮；失败时保留原配置，可重试并查看诊断。
- 确认级别仍是 L2（会中断在用连接/改变对外暴露面，但可回退）。

### 7.3 状态展示

| mode | 徽章 | 附加提示 |
|---|---|---|
| `wg` | ok「组网 Hub」 | — |
| `caddy` | info/neutral「Caddy 网关」 | — |
| `unknown` | neutral「未确认」 | 「Agent 不可达或还没有网络配置」；切换按钮禁用 |

- 四态：空（未配置网络）/ 加载（预检中 Skeleton）/ 错误（预检失败 Banner + 重试）/ 离线（节点不可达 → 只读 + 切换禁用）。
- 切换中不禁止修改其它与模式无关的配置；apply 期间 Agent 写锁仍会返回 409。

### 7.4 手机（390 宽）

- 设置页纵向卡片；Segmented 两个选项可点；「切换模式」为底部通栏按钮。
- 抽屉全屏：当前模式 / 阻断 / 影响摘要纵向堆叠；确认框与底部切换按钮可用。
- 切换允许在手机上完成（无复杂表单）；若预检 warning 较多，提示"建议在电脑上确认"但不阻断。
- 截图计划（#012）：浅色/深色各 1 张设置卡；预检/确认/进度/结果各 1 张；390 宽 2 张。

### 7.5 需要同步的规范与文档

- `docs/ui/ui-spec.md`（现归档于 `docs/archive/ui-v2.2/ui-spec.md`）：F1 步骤 3 增加「节点用途」；新增 **F14「切换节点模式」**（按 F12 模板填写）；§1.3 路由不变。
- `docs/ui-changes/012-dual-mode.md`（现归档于 `docs/archive/ui-changes/`）：本设计的 UI 落地单（已落地）。
- `docs/plan-v4.md`：C4 状态从"待做"改为"设计中"。
- `docs/diagnostics.md`（#49 后）：`wireguard.interface_down` 是适配器问题，`enabled=false` 不产生问题；Peer 离线已从诊断移除，只在 WG 页面展示。
- `docs/backup.md`：导入含 `enabled=false` 的配置时，预览显示"节点为 Caddy 网关模式"，不自动 apply。

---

## 8. 观测指标与验收

### 8.1 切换过程中必须采集（真机验收时手工记录）

| 指标 | 采集方式 | 通过标准 |
|---|---|---|
| Caddy 站点可用性 | 另一台机器 `while true; curl -s -o /dev/null -w '%{http_code}' https://<站点>; sleep 1` | 全程 200，0 次失败 |
| Caddy 是否被重启/reload | `/state` 的 `caddy.lastReloadAt`、`caddy.version`；`systemctl show caddy -p NRestarts` | 切换前后 **不变** |
| Caddy 站点健康 | `siteHealth[].state` | 切换前后一致（除已知 WG 依赖站点） |
| 每步耗时 | 浏览器 Network / Worker 日志 | PUT ≤1s；apply ≤15s；验证 ≤60s；整流程 ≤90s |
| apply 错误 | 响应 `ok/error` | 0 个未预期错误 |
| WG 状态收敛 | `/state.wireguard.running` | 关闭后 60s 内 false；开启后 60s 内 true |
| 端口 | `/state.ports`、节点 `ss -lunp` | 关闭后无 udp/51820；开启后出现 |
| Peer 重连 | `latestHandshake` | 开启后 60s 内在线的客户端恢复握手 |
| 证书 | `certificates.not_after`、Caddy 证书文件 mtime | 完全不变 |

### 8.2 切换后持续观测（24h）

- 模式徽章稳定，只有 `wg` / `caddy` / `unknown`；
- 无重复 apply / 无 `409 busy` 堆积；
- 转发页、站点页、诊断卡片无新增 error；
- 节点重启一次（可选，真机验收项）：`caddy` 模式重启后 WG 不自启；`wg` 模式重启后接口自启、Peer 可握手。

### 8.3 验收清单（实现完成定义）

**Agent**

- [ ] `enabled` schema 默认 true；旧配置/旧备份行为不变（C2 全量测试仍绿）
- [ ] `port_claims` 条件声明；关闭后端口登记释放（真机 `ss` 验证）
- [ ] 关闭后 `wg-quick@wg0` 为 `inactive` + `disabled`；conf 与 keystore 保留
- [ ] 开启后 unit active、`wg show` 正常；peer-only 变更仍走 `syncconf`（不回归）
- [ ] 看门狗在关闭态不执行 `wg set`；`rotate_peer` 在关闭态被拒绝
- [ ] §5.7 的 ≥12 条单测全绿；`python3 -m unittest discover -s agent/tests` 全绿

**Worker**

- [ ] `GET /nodes/:id/mode` 鉴权/404/不可达 200 语义正确；≤4s；无写操作（测试断言 repo 未写）
- [ ] 3 态推导单测（wg/caddy/unknown + 边界）
- [ ] 4 个阻断 + 1 条影响摘要单测；核心 `lib/mode.ts` 不出现应用名
- [ ] 适配器 `status().modeImpact` 单测（wireguard/caddy-site/port-forward/host-ops 各 1 例）
- [ ] 路由只做通用汇总（读 enabled/configDirty），不判断端口/站点/转发

**UI（#012）**

- [ ] 设置页「节点模式」分区；一屏抽屉：当前模式/阻断/影响摘要/确认/切换
- [ ] 切换按钮 loading；失败同屏显示错误码 + 重试 + 诊断
- [ ] `caddy` 模式下 WireGuard/转发页 Banner 与只读态
- [ ] 空/加载/错误/离线四态 + 浅/深/390 截图
- [ ] `./scripts/verify.sh` 全绿

**真机（staging VM + 至少 1 台测试 Hub）**

- [ ] `wg → caddy`：外部 HTTPS 探测 10 分钟 0 失败；Caddy 未 reload；60s 内 WG 停；端口释放
- [ ] `caddy → wg`：同上；WG up；安全组放行后手机/Peer 60s 内握手
- [ ] 往返各 2 次，配置/密钥/证书/站点完全不变
- [ ] 失败注入：① 占用 udp 端口 → 预检阻断；② Caddy 未运行 → 切到网关阻断；③ 换钥 PENDING → 阻断；④ 非 root Agent → apply 失败且回退且提示清晰
- [ ] 断点：apply 中刷新/关闭页面 → 重新打开后模式以 D1 `enabled` 为准，可再次切换/重试
- [ ] 回归：备份导出/导入（含 enabled=false）、`/state`、诊断卡片、host-ops、端口转发均正常

---

## 9. 已知限制与风险

### 9.1 限制（设计上接受）

| # | 限制 | 影响 | 规避 |
|---|---|---|---|
| L1 | 没有跨 app 事务 | 两步之间可能中断 | 顺序保证可用性（Caddy 先健康、WG 后停）；补偿 + 断点恢复 |
| L2 | `enabled=false` 的 apply 没有内核备份 | 不能用 `/rollback` 回退模式 | 用"改配置 + apply"补偿（§4.4） |
| L3 | plan 预览看不到"将停止接口" | 用户可能误会"无变更" | 模式切换走专用向导，不依赖 plan；可选内核 hook（D3） |
| L4 | Agent 不管防火墙/安全组 | 开启 WG 后可能 Peer 连不上 | 确认页固定提示 + 验收用真实握手确认 |
| L5 | 没有 Caddy HTTP/3 开关 | `udp/443` 冲突只能改 WG 端口 | 硬阻断 + 提示改端口 |
| L6 | 非 root 不能开 WG | user 模式节点不能切到 `wg` | 预检/apply 报错兜底；C5 再补运行模式上报 |
| L7 | 旧备份无 `enabled` 字段 | 导入后默认组网 | 默认值 = true 与旧行为一致，属预期 |
| L8 | 切换不迁移证书 | 无影响（证书与模式无关） | — |

### 9.2 风险登记

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| 站点上游依赖 WG，切换后站点 502 | 中 | 高 | 预检列出 + 确认勾选；全部依赖时阻断 |
| 端口转发在 caddy 模式重启风暴 | 中 | 中 | 预检要求先停用（本期）；阶段二自动停用 |
| 换钥 PENDING 时切换导致新旧钥都不可用 | 低 | 高 | 硬阻断（§3.7） |
| WG 用 udp/443 与 Caddy h3 冲突 | 低 | 高 | 硬阻断 + 提示改端口 |
| 云安全组未放行 UDP，开启后"看起来成功但连不上" | 中 | 中 | 确认页提示；验收用真实握手；失败不回滚模式（接口已起，问题在外部） |
| 用户保存了开关但没 apply，误以为已切换 | 中 | 低 | 徽章显示「下发中/待生效」；5 分钟提示 |
| 切换中关页面 | 中 | 低 | 断点恢复（§4.5） |
| 补偿失败留下不一致 | 低 | 高 | 只读命令 + 人工；不自动重试 |
| 旧备份导入把网关节点变回组网 | 低 | 中 | 导入预览显示模式差异，需确认 apply |
| Caddy 已坏时切到网关 | 低 | 高 | 预检阻断 |

---

## 10. 待拍板决策

| # | 决策 | 默认建议 | 备选 | 影响 |
|---|---|---|---|---|
| D1 | 模式真源 | **`wireguard.config.enabled` 单字段**；`nodes.mode` 不引入 | 增加 `nodes.mode` 列做缓存/索引 | 双源一致性 vs 查询便利 |
| D2 | 是否加 D1 迁移 | **不加**（过渡态派生） | 加 `mode_transition` 列 | 断点恢复更直观，但多一处状态 |
| D3 | 是否给内核加 `adapter.warnings()` | **不加**；切换向导不依赖 plan | 加 ~10 行钩子，plan 显示"将停止接口" | 体验 vs 冻结内核 |
| D4 | 依赖转发处理 | **本期人工停用 + 预检阻断** | 切换时自动停用并记录、切回恢复 | 体验 vs 复杂度 |
| D5 | 依赖 WG 的站点 | **warning+勾选**；全部依赖时阻断 | 一律warning / 一律阻断 | 安全 vs 灵活 |
| D6 | `udp/443` 冲突 | **硬阻断，手工改端口** | 增加 Caddy h3 开关（新适配器能力） | 功能 vs 范围 |
| D7 | `/state` 增加 `agent:{mode,version,serverTime}` | **本期可加**（可选字段）用于非 root 预检 | 不加，靠 apply 报错兜底 | 预检精度 |
| D8 | 新建节点选"纯网关" | **写入 `wireguard` 配置行 `enabled=false`**（不安装 WG 工具） | 不建 WG 配置，等切换时再建 | 模式显式 vs 配置干净 |
| D9 | `caddy` 模式下 WG/转发页 | **保留导航 + Banner + 只读** | 隐藏导航项 | 规范改动量 vs 清晰度 |
| D10 | 是否记 `node.mode.changed` 审计 | **不新增**，沿用 `app.apply` 审计 | 新增一个"记录完成"接口/事件 | 审计可读性 vs 新接口 |
| D11 | F1 "入口模式"措辞 | **改为「节点用途：组网 Hub / 纯 Caddy 网关」** | 保持原文，另加一行 | 概念混淆 |
| D12 | 是否提供"随时切回" | **提供**（任意时间，L2，无需回滚窗口） | 仅切换后 N 分钟内可回退 | 操作自由 vs 误操作 |
| D13 | 开启 WG 的确认级别 | **L2** | L1（开启不影响 Caddy） | 一致性 vs 摩擦 |
| D14 | 手机是否允许切换 | **允许**（只读+确认） | 仅桌面 | 手机规范 §6.2 |
| D15 | 是否给 Agent 增加 `GET /tasks`（列表） | **本期不加**；预检不判断忙闲，靠 apply 的 409 busy 兜底 | 加只读列表接口，预检可精确阻断 | 多一个核心只读接口 vs 预检精度 |

---

## 11. 落地拆分与依赖

| PR | 内容 | 预估 | 依赖 |
|---|---|---|---|
| PR1 | `agent/adapters/wireguard.py` 的 `enabled` 支持（A1–A9）+ `agent/tests/test_wireguard.py` ≥12 例 | 1.5–2 人日 | 本设计 D1–D4 |
| PR2 | `GET /nodes/:id/mode` + `apps/api/src/lib/mode.ts` 纯函数 + 契约 + 单测 | 1 人日 | PR1 的字段定义 |
| PR3 | UI #012（设置分区 + 四视图抽屉 + Banner + 截图） | 1.5–2 人日 | PR2；#012 获批 |
| PR4 | staging 真机往返切换 + 失败注入 + 验收记录 + 文档同步 | 1 人日 | PR1–PR3 |

**总预估 5–6 人日**（不含代理插件阶段的"入口模式"）。

**文档同步清单**：`docs/design-v3.md` §2.1（新增 `GET /mode`）、`docs/backup.md`（enabled 字段）、`docs/diagnostics.md`（关闭态 severity）、`docs/ui/ui-spec.md`（F1 措辞 + F14，现归档于 `docs/archive/ui-v2.2/`）、`docs/plan-v4.md`（C4 状态）、`CHANGELOG.md`。

---

## 附录 A：预检响应示例

```json
{
  "nodeId": "vm1-hk",
  "mode": "wg",
  "target": "caddy",
  "reachable": true,
  "blockers": [],
  "warnings": [
    {
      "code": "MODE_WARN_IMPACT",
      "message": "切换后：3 个客户端会断开（其中 1 个在线）；1 个站点的上游在内网（blog），切换后不可用；2 条端口转发会停止；1 台 Peer 的主机运维会失联。"
    }
  ],
  "checkedAt": 1761470000
}
```

有阻断时的示例：

```json
{
  "blockers": [
    {
      "code": "MODE_BLOCKED_PORT_CONFLICT",
      "message": "udp/443 会与 Caddy 的 HTTP/3 冲突，请把 WireGuard 监听端口改成其它高位端口。",
      "fixRoute": "/hubs/vm1-hk/wireguard",
      "details": { "proto": "udp", "port": 443, "reason": "http3" }
    }
  ]
}
```

## 附录 B：切换命令序列（占位符；与 §4 对应，供实现/验收对照）

```bash
# 0) 预检（只读）
curl -fsS https://<console>/api/v1/nodes/<node-id>/mode \
  -H 'cookie: <session>' | jq .

# 1) 读取当前 wireguard 配置（已有接口）
curl -fsS https://<console>/api/v1/nodes/<node-id>/apps/wireguard \
  -H 'cookie: <session>' | jq '.app.config'

# 2) 保存期望：在配置 JSON 上改 enabled=false（其余字段原样）
curl -fsS -X PUT https://<console>/api/v1/nodes/<node-id>/apps/wireguard \
  -H 'cookie: <session>' -H 'content-type: application/json' \
  -d '{"config":{...原配置...,"enabled":false},"schemaVersion":1,"note":"switch to caddy"}' | jq .

# 3) 应用（幂等键见响应/客户端生成）
curl -fsS -X POST https://<console>/api/v1/nodes/<node-id>/apps/wireguard/apply \
  -H 'cookie: <session>' -H 'content-type: application/json' \
  -d '{"idempotencyKey":"<uuid>"}' | jq .

# 4) 验证（轮询，直到 running 符合期望）
watch -n 3 "curl -fsS https://<console>/api/v1/nodes/<node-id>/state \
  -H 'cookie: <session>' | jq '{reachable, wg: (.state.adapters[]?|select(.name==\"wireguard\").status.running), caddy: (.state.adapters[]?|select(.name==\"caddy-site\").status.active)}'"
```

## 附录 C：节点上的人工只读检查（切换前后用；不执行写操作）

```bash
# WireGuard 状态
sudo wg show all
sudo systemctl status 'wg-quick@*' --no-pager
ss -lunp | grep -E ':(51820|443)\b' || true

# Caddy 状态（注意：不要在这里重启 Caddy）
sudo systemctl status caddy --no-pager
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
ss -lntp | grep -E ':(80|443|8443)\b' || true

# 端口占用与转发
sudo ss -lntup | grep -E 'khc-forward|socat' || true
systemctl list-units 'khc-forward-*' --no-pager

# 证书与站点（只读）
sudo ls -l /var/lib/caddy/.local/share/caddy/certificates 2>/dev/null || true
```

---

**文档结束。** 实现前需主人对 §10 的 D1–D15 拍板；#012 UI 变更单获批后再动前端代码。




## 11. 实现记录（2026-10-26）

- WireGuard 适配器：`enabled` 默认 true；关闭 release 端口、render=[]、stop+disable、status/health 关闭态、看门狗/rotate 拒绝；90 项 WG 测试。
- Worker：`GET /nodes/:id/mode`（7 态/12 码、只读、不可达 200）；D7 `/state.agent{version,serverTime,mode}`；D6 `app_configs.last_apply_error`（migration 0004）。
- UI：节点设置「节点模式」卡、四视图切换抽屉、概况徽章、caddy 模式 WireGuard/转发 Banner；截图 `docs/archive/ui-v2.2/shots/mode-*.png`。
- staging（vm1-HK）：`wg → caddy` 后 `wg-quick@wg0 inactive/disabled`、udp/51820 释放、conf/证书保留、Caddy 站点 200；`caddy → wg` 后 unit active、51820 恢复、Caddy 站点 200；mode API 两次正确派生。
- 未做/限制：D3 warnings 钩子、D6 udp/443 自动改端口；`/state` 不可达时 state 用 switching_* + ROOT_UNKNOWN；#14 独立 Peer 真机仍未执行。


## 12. host-ops 预检（#34，2026-10-27）

- `GET /nodes/:id/mode` 在切到 Caddy 时增加 `MODE_WARN_HOSTOPS_PEERS`：列出依赖 WireGuard 的 host-ops Peer 数量。
- 文案提示：进程/防火墙/SSH 钥匙将不可用；若有未确认的 `fw.apply` 先确认或等待回滚。
- 当前不把它升级为 blocker（Peer 状态需要逐台探测，避免预检超时）；确认框需人工确认。


## 13. #50 精简（2026-10-29）

- 7 态 → 3 态（`wg`/`caddy`/`unknown`），删除 switching/degraded；删除旧过渡态判断。
- 13 个预检码 → 4 个阻断（换钥/端口冲突/未应用配置/Caddy 未运行）+ 1 条影响摘要。
- 判定逻辑移入 `wireguard`/`caddy-site`/`port-forward`/`host-ops` 的 `status().modeImpact`；`apps/api/src/lib/mode.ts` 不再出现应用名。
- UI 切为一屏抽屉（当前模式/阻断/影响摘要/确认/切换），失败同屏展示。
- 契约：`mode: 'wg'|'caddy'|'unknown'` + `target` + `reachable` + `blockers` + `warnings`；删除 `state`/`desired`/`effective`/`counts`。
