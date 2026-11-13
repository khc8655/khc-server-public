# Hub 双模式设计：纯 Caddy 网关 ↔ WireGuard 组网（C4）

> 状态：现行 ｜ 最后核验：2026-11-02 ｜ 关联：docs/design-v3.md §2.1、docs/backup.md
> 范围：节点双模式（wg/caddy/unknown）机制

> **一句话**：**模式只由一个字段决定——`wireguard.config.enabled`**；切换 = "先把目标服务验到健康，再对 WireGuard 做一次可回退的启停"；Caddy 站点与证书在两种模式下配置完全不动，因此**站点零中断**，而 WireGuard 客户端按模式定义会断开（这不是故障，是模式语义）。

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

> 为避免混淆，建议把 F1 步骤 3 的"入口模式"改名为"**节点用途**：WireGuard 组网 Hub / 纯 Caddy 网关"，把 443 归属问题留给代理插件阶段（见归档实现记录 §10 D11）。

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

**明确不采用**：`nodes.mode`（`wg`/`caddy`）列、`caddyOnly` 布尔、或在 `caddy-site` 里存 `mode`。理由：多一处真源就多一处不一致；旧规划曾建议的 `nodes.mode`只作为**派生缓存**（且默认不做），见归档实现记录 §10 D1。

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

> 该函数放 `apps/api/src/lib/mode.ts`，输入全部来自 D1 + `/state`，**不写库、不调动作、不出现应用名**，可直接单测（见归档实现记录 §8.3）。

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
  2. 关闭 Caddy 的 HTTP/3（当前 Agent/Caddy 适配器**没有**这个开关，属后续能力，见归档实现记录 §10 D6）。
- **不允许**自动改端口、自动关 h3：这两件事都改变已生效配置，必须人工确认。

### 3.3 证书

| 项 | 影响 |
|---|---|
| D1 证书库（`certificates` 表） | 无影响 |
| Caddy 自动 HTTPS（ACME HTTP-01 / TLS-ALPN-01） | 无影响：80/443 一直由 Caddy 持有；`caddy` 模式下反代站点照常签发/续期 |
| `$cert` 引用（手动/自签/跨 Hub） | 无影响：证书文件路径不变，Caddy 配置不变 |
| ACME DNS-01 凭据（`settings`） | 无影响 |
| 纯 Caddy 网关无 root 运行 | 与模式正交；见归档实现记录 §5.6 / §10 D9 |

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
| 看门狗线程 | `enabled=false` 时**必须跳过**轮换/接口看守（否则会对不存在的接口执行 `wg set`）；实现见归档实现记录 §5.1 |
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

### 6.3 为什么不新增 D1 列 / 表

- 模式真源在 `app_configs`（不透明 JSON），`enabled` 加字段不需要迁移；
- 模式与"配置是否已应用"分别由 `enabled` 与 `rev/applied_rev` 表达，不需要 `mode_transition` 列；
- 审计沿既有 `app.apply` 事件（若确实需要"模式变更"事件，见归档实现记录 §10 D10）。

---


> Agent 侧实现清单（原 §5）、编排方案对比（原 §6.2）、UI、验收、待拍板与实现记录（原 §7–§13、附录）已移至 `docs/archive/2026-11/dual-mode-impl-notes.md`。
