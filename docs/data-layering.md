# 数据分层：控制面与观测面

> 状态：现行 ｜ 最后核验：2026-11-04 ｜ 关联：docs/design-v3.md §2.3、docs/live-observation.md §8、ADR-0010
> 范围：D1/Agent 数据归属边界（配置 vs 运行快照）

本文件定义 khc-server 的数据归属，避免“实时状态”和“可恢复配置”混在一起。

## 1. 两条数据链路

```text
A. 浏览器 → Worker/D1      控制面：配置、动作、审计、回滚
B. Worker → Hub            控制面的节点 RPC
C. 浏览器 → Hub /_live/snapshot   观测面：10s 只读指标（有可信域名）
D. 浏览器 → Worker /nodes/:id/snapshot → Agent /snapshot   无域名时的只读转发（2s 去重）
```

- 控制面是**唯一写入口**，承载配置、动作与审计；`/state` 只在打开工作区时探测一次，
  提供适配器/端口/服务/进程等重数据，**不做周期轮询**。
- 观测面只提供**轻量指标**（CPU/内存/磁盘/负载/uptime），页面可见时 10s 一次、
  隐藏即停、10 分钟/60 次上限（ADR-0010）；连不上/到顶时页面保留上一帧并给出状态文案。
- 观测面永远只读；浏览器不持有节点 token，不直接写 Hub。
- snap ticket 由 Worker 用节点 token HMAC 签发，15 分钟、有效期内可复用、绑定 origin；
  live/nudge ticket 仍为 60 秒一次性（SSE 已停用但代码保留）。

## 2. D1 中保留什么

| 数据 | 位置 | 原因 |
|---|---|---|
| 节点身份、endpoint、tunnel/live endpoint、preferred route | `nodes` | 连接配置，必须可恢复 |
| 节点 token 密文 | `nodes.token_enc` | 控制面 RPC 凭据 |
| 应用期望配置 | `app_configs.config_json` | 用户意图，必须持久化 |
| 配置版本 / 已应用版本 / apply 失败摘要 | `app_configs.rev/applied_rev/last_apply_error` | 控制状态，不含运行快照 |
| 配置历史 | `revisions` | 回滚、审计 |
| 证书和私钥密文 | `certificates` | 配置资产 |
| DNS/全局凭据 | `settings` | 配置资产 |
| 操作审计 | `audit` | 安全与追责 |
| 最近可达租约 | `nodes.last_seen_at` | 仅表示「最近一次成功探测」（300s 窗口）；`unknown`=未探测/租约过期，`offline` 只由前端实际探测失败产生 |

`nodes.last_state_json` 已停止使用。旧版本写入的完整 `/state` 快照由
`migrations/0005_clear_runtime_state.sql` 清空。

## 3. D1 中不保留什么

以下数据只在浏览器内存 / React Query 中存在，页面关闭即丢弃：

- Agent `/state` 的完整快照
- CPU、内存、磁盘、负载、进程、服务、监听端口、DNS、路由、uptime（含 10s 快照与本地环形缓冲）
- WireGuard 握手、peer 在线状态、rx/tx
- Caddy 站点健康、validate/reload 结果
- port-forward unit 运行状态、socat 版本
- 诊断结果
- live SSE state 帧
- 当前实时 ticket（只存在内存；审计里只记录签发事件）

`GET /nodes/:id/state` 仅用于「打开工作区时探测一次」控制面可达性、更新
`last_seen_at` 租约与写闸门，并作为适配器/端口/服务/进程等重数据的一次性来源；
**没有周期性 ops 轮询**。`GET /nodes/:id/snapshot`（或浏览器直连）只返回轻量指标，
`Cache-Control: no-store`，不写运行快照。

## 4. 通道状态

```ts
interface HubChannels {
  control: { reachable: boolean | null; error: string | null };
   live: { status: 'disabled' | 'live' | 'stopped' | 'fallback'; lastFrameAt: number | null };
   presence: 'managed-online' | 'live-only' | 'offline' | 'unknown';
   canSave: boolean;   // 保存配置/节点字段（纯 D1 写），永远 true
   canApply: boolean;  // 执行类动作（plan/apply/rollback），= control.reachable
   readSource: 'direct' | 'forward' | 'none';  // 直连快照 / 控制面转发快照 / 无
}
```

派生规则：

```text
control.reachable === true       → presence = managed-online, canApply = true
control.reachable !== true && 有快照数据（live/stopped/fallback 且有上一帧）
                                 → presence = live-only, canApply = false
两边都不可达                     → presence = offline, canApply = false
探测中                           → presence = unknown, canApply = false
canSave 恒为 true（保存只写 D1，与通道无关，见 docs/design-v3.md §1.2）
```

- live 成功**不能**把节点标成“在线可管理”。
- **写闸门分两级**（2026-11-01 拆分）：保存类（PUT 应用配置/节点字段）永远允许；执行类由 `canApply` 决定。
- `readSource` 只影响观测数据来源（direct/forward/none），不影响配置 authority。

## 5. 失败矩阵

| 浏览器→Worker | Worker→Hub | 浏览器→Hub | 结果 |
|---|---|---|---|
| ✅ | ✅ | ✅ | 可管理；实时观测 |
| ✅ | ✅ | ❌ | 可管理；**运维数据不可用**（显示「实时观测未连接」，不回退快照） |
| ✅ | ❌ | ✅ | 仅观测可达；执行类禁用；**配置仍可保存**（待应用） |
| ✅ | ❌ | ❌ | 配置可看可存（待应用）；运行状态未知 |
| ❌ | — | — | 无法登录/取 ticket；不能直连 Hub |

## 6. 约束

1. 不把运行数据写入 D1，不用 D1 做“上次状态”兜底。
2. 不通过 live 通道（SSE）发送写命令。
3. 不允许浏览器直接调用 Hub 的写 API。
4. 不允许节点 token 进入浏览器。
5. 配置以 D1 为 authority；运维数据只以浏览器直连 live 为来源，未连接即不展示（不回退控制面快照）。

## 7. Worker 请求预算（2026-11-04）

- **刷新策略**：打开页面拉一次 + 手动刷新。`QueryClient` 默认
  `retry: false`、`refetchOnWindowFocus: false`、`refetchOnReconnect: false`；全仓无
  `refetchInterval`。
- **不做按节点 fan-out**：概览页只拉 `/nodes` + `/certificates`；`/hubs` 打开不探测，
  [刷新状态] 才 1 + N 次（单次、手动）；证书站点占用只在打开详情/删除确认时按需拉取。
- **页内进度回执**：host-ops 任务 1→2→4→8s 退避（≤120s 约 16 次）；模式切换
  2→4→8→10s（≤60s 约 7 次）；均有硬超时与取消信号，随抽屉关闭终止。
- **服务端**：无 Cron、定时探测、心跳；`last_seen_at` 只由真实探测更新。
- 典型使用（每月约 10 次打开）每月 < 200 次 Worker 请求；放大场景均有上界。
  详细预算表见 `docs/engineering/adr/ADR-0009-ops-data-live-only.md` §请求预算。
