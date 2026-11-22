# 中转链路提速与刷新减负（提案）

> 状态：已拍板 ｜ 最后核验：2026-11-22 ｜ 关联：`docs/data-layering.md`、ADR-0021、`docs/archive/plans/single-channel-perf-2026-11-22.md`

> **执行者须知**：坚持 ADR-0021 单控制面通道（浏览器 → Worker → Agent），任何批次都不得恢复浏览器直连、不得改 HMAC 签名串、不得新增表/迁移、不得引入周期轮询 / Cron / KV / DO。一个批次一个 PR。**开发前先读对应批次的开工说明（§8）**，本文只写决策与验收口径。

## 1. 背景

面板 `0.37.0` / Agent `0.7.0`（PR #136、#137）已去掉重复鉴权、加了 `session_epoch` 缓存、`lastSeenAt` 60s 写节流、5s 超时冷却、前端 30s 缓存，以及 Agent 并发采集与 `siteHealth` SWR。剩余问题有两类：**看不到时间花在哪**，以及**结构性的重复请求**。

### 1.1 已知基线（`0.36.2` 前，来自已归档提案 §1）

| 接口 | 耗时 | 备注 |
|---|---|---|
| `GET /nodes`（只读 D1，不连节点） | 1174–1180ms | 固定开销异常大 |
| `GET /certs` | 519ms | |
| `POST /nodes/probe` | 1831–2499ms | 3 台节点 |
| `GET /nodes/:id/state` 热态 | 1534–1783ms | |
| `GET /nodes/:id/snapshot` 热态 | 1427–1719ms | |

`0.37.0` 之后没有分段数据。不连节点的 `/nodes` 也要 1.1s 以上，大头可能在**第三方边缘回源 `workers.dev`** 与 **Worker → D1 跨洲 RTT**，目前无法证实。

### 1.2 剩余问题与证据

| # | 问题 | 证据 |
|---|---|---|
| R1 | 没有分段计时，优化只能靠猜 | `apps/api/src` 无 `Server-Timing`，无按请求的 D1/Agent 耗时 |
| R2 | 运维分段不缓存：服务 / 定时任务 / 日志 / 进程 / SSH 公钥每次切段都走一遍 浏览器 → Worker → D1 → Agent | `apps/host-ops/OpsSegments.tsx` 用组件内 state + `callHostOps`；分段在 `HubOpsPage.tsx` 按条件渲染，切走即卸载 |
| R3 | 概况与其他页签各一个缓存键：`/overview` 回填 `/state`，反向不会；页签切换会在 `/overview` 与 `/state` 之间来回启用 | `app/HubChannelsProvider.tsx` 的 `useOverview` 分支、`app/AppShell.tsx` 的 `isOverviewRoute` |
| R4 | 写后刷新过重：重启一个服务也带 `force=1` 重拉整份 `/state` | `apps/host-ops/refreshAfterWrite.ts` |
| R5 | 只有 `/snapshot` 有节点读取缓存，其余路由每次查 D1 读节点 | `routes/snapshot.ts` `getSnapshotNode`；`routes/helpers.ts` `requireNode` |
| R6 | 批量探测按 4 个一批串行等待，最慢节点拖住下一批 | `routes/nodes.ts` `POST /nodes/probe` 的 `concurrency = 4` 循环 |
| R7 | Agent `/state` 取决于最慢的适配器：并发了，但没有截止时间 | `agent/khc/kernel.py` `adapter_state_entries` 的 `future.result()` 与 `with ThreadPoolExecutor` |

已核实的事实（开工说明里按此施工）：

- `/snapshot` 的 `failedUnits` 每次调用都现采（`agent/khc/ops.py` `collect_snapshot` → `_failed_units()`），**不受** ops 5s 缓存影响；运维页与概况页都优先读快照里的失败单元（`data/failedUnits.ts` `pickFailedUnits`）。
- Worker 的 `/snapshot` 有 2s 同节点去重（`routes/snapshot.ts` `DEDUPE_MS`）。
- `adapterStateSchema.status` 是 `z.record(z.string(), z.unknown())`，在 `status` 内加字段不需要改契约。
- 进程内缓存（冷却、去重、`session_epoch`、节点缓存）只在单个 isolate 内有效；面板每月约 10 次打开，冷 isolate 占比高，**不能把 isolate 缓存当成主要手段**。
- Cloudflare 已放宽并发连接限制：6 条上限只约束「等待响应头」阶段（2026-04 changelog）。

## 2. 目标与不做

**目标**

1. 每个 `/api/*` 响应都能看到鉴权、D1、Agent 各段耗时（B1）。
2. 节点工作区内切页签、切运维分段，缓存有效期内 **0 次额外 Worker 请求**（B2）。
3. 写操作后只刷新受影响的数据，不再默认重拉整份 `/state`（B2）。
4. Worker 侧 D1 与探测耗时按 B1 基线下降（B3）。
5. 单个慢适配器不再拖慢 `/state`（B4）。

**不做**

- 不恢复浏览器直连 Agent，不新增第二条通道。
- 不改 HMAC 签名串与 token 存放方式；token 不进浏览器。
- 不新增表、迁移、Cron、KV、DO、心跳；不加 `refetchInterval`；不改 ADR-0010 的 10s 快照规则。
- 不改页面结构与视觉（「刷新中」提示、统一状态入口等交互改动另立 UI 提案）。
- 不在本提案内改生产入口拓扑；`workers_dev` 保持 `true`（`release.md` §1）。
- 不改已被取代的 ADR-0009；请求预算以 `docs/data-layering.md` §7 为准。

## 3. 方案对比

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A 单通道 + 分层减负（推荐）** | 先测量，再分别减少前端请求、Worker D1 往返、Agent 慢适配器 | 不动安全边界与契约；每批可独立验收、回滚 | 第三方边缘的固定开销不在代码层解决 | 采用 |
| B 域名节点恢复浏览器直连 | 有可信证书的节点让浏览器直连 Agent | 少一跳 | IP / 自签节点仍要走 Worker，又成两套通道；需要票据与 CORS，ADR-0021 刚下线 | 否决 |
| C 引入 KV / DO 常驻缓存 | Worker 侧跨 isolate 缓存节点状态 | 命中率高 | 违反 `AGENTS.md` §1「不做 KV/R2/DO」；运行态会落入中间存储 | 否决 |

## 4. 批次

| 批次 | 内容 | 类型 / 版本 | 开工条件 |
|---|---|---|---|
| B1 测量 | `Server-Timing`（auth / d1 / agent / total）+ 慢请求日志 + 本地基线脚本；部署后产出基线证据 | A，面板 patch | 提案合入 |
| B2 前端减少请求 | 工作区统一走 `/overview`；运维分段接入 React Query（30s）；写后精确刷新（服务类只刷分段 + 快照） | W，面板 minor | 提案合入（与 B1 并行） |
| B3 Worker 降延迟 | ① 探测滑动并发（无条件）；② 节点读取缓存统一（按数据）；③ D1 读副本 + bookmark（按数据）；④ 边缘拓扑只出结论 | A，面板 patch | B1 基线证据合入 |
| B4 Agent 截止时间 | 每个适配器 `status()` 共用 2s 截止时间，超时返回上次成功结果并标 `stale`；守护线程 + in-flight 去重 | G，Agent patch | 提案合入（独立） |

各批的改动范围、设计细节、必测项、证据与审核清单见 §8 的开工说明。

### 4.1 验收口径（摘要）

- **B1**：每个 `/api/*` 响应（含 401 / 404 / 5xx）带 `Server-Timing`，不含 URL、IP、节点 id 或凭据；基线证据覆盖生产入口与 `*.workers.dev` 入口、3 台在线节点，能回答每个接口「慢在边缘 / D1 / Agent 哪一段」。
- **B2**：进入工作区后切全部页签只发 1 次 `/overview`、0 次 `/state`；运维分段 30s 内每个读动词只调用 1 次；重启服务成功后额外请求 ≤ 2（`svc.list` + `/snapshot`）。
- **B3**：逐项附 B1 同条件（同入口、同节点、各 10 次中位数）的前后对比；节点编辑后立即执行动作不读旧 endpoint。
- **B4**：慢适配器下 `/state` 中位数 ≤ 截止时间 + 网络 RTT；Agent 停止 / 升级不被卡住的 status 线程阻塞。

## 5. 顺序与依赖

```
B1 测量 ──▶ B3 Worker（②③ 按数据选做）
B2 前端 （与 B1 并行，不依赖数据）
B4 Agent（独立，可并行）
```

建议合并顺序：B1 → B2 → B4 → B3。版本号按合并时 `main` 顺延（档位见上表）。升级顺序仍是先面板后 Agent（`release.md` §2.1）。

## 6. 请求预算影响

| 场景 | 现在 | 改后 |
|---|---|---|
| 进入节点并切全部页签 | `/overview` 与 `/state` 随页签切换各打 1 次以上，另有 `/nodes/:id` | `/overview` 1 次 |
| 运维 5 个分段来回切 | 每切 1 次 = 1 次请求 | 每分段首次 1 次，30s 内复用 |
| 重启一个服务 | `svc.restart` + `svc.list` + `/state?force=1` | `svc.restart` + `svc.list` + `/snapshot` |
| 首页探测 | 1 次 Worker 请求（内部 N 次 Agent 调用） | 不变，总耗时下降 |

整体请求只减不增，`data-layering.md` §7「每月 < 200 次 Worker 请求」不受影响。

## 7. 拍板结果（2026-11-22）

| # | 事项 | 结论 |
|---|---|---|
| 1 | B2 工作区单一入口 | **采用**：所有页签统一走 `/overview` |
| 2 | B3-③ D1 读副本 | **待 B1 数据**：D1 段占 `/nodes` total ≥ 30% 时再提请主人在控制台开启 |
| 3 | B4 截止时间默认值 | **2s**，保留 `--status-deadline` 参数可调 |
| 4 | 侧栏节点悬停预取 `/overview` | **不做** |
| 5 | 第三方边缘拓扑调整 | **待 B1 数据**：若证实为主要瓶颈，另立提案，涉及 `workers_dev` 红线须单独拍板 |

第 2、5 项不阻塞开工：B1、B2、B4 可直接派发；B3 在 B1 证据合入后派发。

## 8. 批次开工说明

| 批次 | 开工说明（交给开发 agent 直接读） |
|---|---|
| B1 | `docs/plans/relay-latency-2026-11-22-b1.md` |
| B2 | `docs/plans/relay-latency-2026-11-22-b2.md` |
| B3 | `docs/plans/relay-latency-2026-11-22-b3.md` |
| B4 | `docs/plans/relay-latency-2026-11-22-b4.md` |

开发中发现提案或开工说明有误，在 PR 里提出，由设计任务修订；开发 PR 不修改 `docs/plans/` 下的文件。全部批次合入后，设计任务把本文与四份开工说明一并移入 `docs/archive/plans/`，未完成项转入 backlog。
