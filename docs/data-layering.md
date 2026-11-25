# 数据分层：控制面与快照

> 状态：现行 ｜ 最后核验：2026-11-25 ｜ 关联：docs/design-v3.md §2.3、ADR-0010、ADR-0021
> 范围：D1/Agent 数据归属边界（配置 vs 运行快照）

本文件定义 khc-server 的数据归属，避免“实时状态”和“可恢复配置”混在一起。

## 1. 统一数据链路（ADR-0021）

```text
A. 浏览器 ──同源 Cookie──▶ Worker/D1                        配置、审计、回滚
B. 浏览器 → Worker /nodes/:id/* ──HMAC──▶ Agent 主端口     控制面 RPC（/overview、/apps、/tasks）
C. 浏览器 → Worker /nodes/:id/snapshot ──HMAC──▶ Agent /snapshot  10s 轻量指标（2s 去重）
```

- 控制面是**唯一入口**，浏览器不再直连 Agent（`live-ticket`、8899 端口与 `/_live/snapshot` 已下线）；进入节点工作区时仅在 `HubChannelsProvider` 拉取一次 `/overview`（聚合节点详情、控制面 `/state` 与 D1 投影并回填共享缓存），工作区内切换子页不再发 `/state` 或 `/nodes/:id`，**不做周期轮询**。
- 轻量快照只提供 **CPU/内存/磁盘/负载/uptime/tasks**，页面可见时每 10s 轮询一次、隐藏即停、支持 `BroadcastChannel` 多标签页共享、单次 10 分钟/60 次上限（ADR-0010）；连不上/到顶时页面保留上一帧并给出状态文案。
- 浏览器不持有节点 token 与直连票据。

## 2. D1 中保留什么

| 数据 | 位置 | 原因 |
|---|---|---|
| 节点身份、endpoint、tunnel endpoint、preferred route | `nodes` | 连接配置，必须可恢复（`live_endpoint` 历史列保留为 NULL） |
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

`GET /nodes/:id/overview`（及节点证书作用域内的 `/state` 共享缓存）仅用于「打开工作区时探测一次」控制面可达性、更新
`last_seen_at` 租约与写闸门，并作为适配器/端口/服务/进程等重数据的一次性来源；
**没有周期性 ops 轮询**。`GET /nodes/:id/snapshot` 只返回轻量指标，
`Cache-Control: no-store`，不写运行快照。

## 4. 通道状态

```ts
interface HubChannels {
  control: { reachable: boolean | null; error: string | null };
  presence: 'managed-online' | 'offline' | 'unknown';
  canSave: boolean;   // 保存配置/节点字段（纯 D1 写），永远 true
  canApply: boolean;  // 执行类动作（plan/apply/rollback），= control.reachable
  readSource: 'forward' | 'none';
}
```

派生规则：

```text
control.reachable === true   → presence = managed-online, canApply = true, readSource = 'forward'
control.reachable === false  → presence = offline, canApply = false
control.reachable === null   → presence = unknown, canApply = false
canSave 恒为 true（保存只写 D1，与通道无关，见 docs/design-v3.md §1.2）
```

- **写闸门分两级**：保存类（PUT 应用配置/节点字段）永远允许；执行类由 `canApply` 决定。

## 5. 失败矩阵

| 浏览器→Worker | Worker→Hub | 结果 |
|---|---|---|
| ✅ | ✅ | 可管理；10s 快照自动刷新 |
| ✅ | ❌ | 节点离线（执行类禁用）；**配置仍可看可存**（待应用） |
| ❌ | — | 无法访问面板与控制面 |

## 6. 约束

1. 不把运行数据写入 D1，不用 D1 做“上次状态”兜底。
2. 不通过 live 通道（SSE）发送写命令。
3. 不允许浏览器直接调用 Hub 的写 API。
4. 不允许节点 token 进入浏览器。
5. 配置以 D1 为 authority；运行态观测数据不落 D1，未连通时保留上一帧或提示离线（见 §1）。

## 7. Worker 请求预算

- **刷新策略**：打开页面拉一次 + 写后/手动刷新。`QueryClient` 默认
  `retry: false`、`refetchOnWindowFocus: false`、`refetchOnReconnect: false`；全仓无
  `refetchInterval`。
- **工作区单一入口与分段缓存**：进入节点工作区只请求一次 `/overview` 并回填节点与运行态缓存，切换工作区页签不重发 `/state` 或 `/nodes/:id`（写操作后由 `refreshHubRuntime` 按需刷新 `/overview`）。节点栏右侧「刷新状态」会同时强制重拉 `/overview?force=1`（更新 Peer 在线、站点与服务）并重启 10s 快照自动轮询（`live.restart()`）。主机运维页各分段（服务、进程、定时任务、SSH 公钥、日志错误）读结果缓存 30s（失败不缓存，手动刷新可重拉）；服务类写操作后只刷新 `svc.list` 与 `/snapshot`（2.1s 内避开 Worker 2s 去重窗口）。
- **不做按节点 fan-out**：概览页只拉 `/nodes` + `/certificates`；`/hubs` 打开不探测，
  [刷新状态] 才 1 + N 次（单次、手动）；证书站点占用只在打开详情/删除确认时按需拉取。
- **页内进度回执**：host-ops 任务 1→2→4→8s 退避（≤120s 约 16 次）；模式切换
  2→4→8→10s（≤60s 约 7 次）；均有硬超时与取消信号，随抽屉关闭终止。
- **服务端**：无 Cron、定时探测、心跳；`last_seen_at` 只由真实探测更新。
- 典型使用（每月约 10 次打开）每月 < 200 次 Worker 请求；放大场景均有上界。
  详细预算表见 `docs/engineering/adr/ADR-0009-ops-data-live-only.md` §请求预算。
