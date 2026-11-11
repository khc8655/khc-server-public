# ADR-0009: 运维数据只走浏览器直连观测，控制面不承载快照

- 状态：被 ADR-0010 部分取代（2026-11-04：允许可见时 10s 快照轮询、无域名时经控制面转发轻量快照；
  「不周期拉取 `/state`、重数据不进控制面」的结论仍有效）
- 日期：2026-11-04
- 决策者：主人

## 背景

`docs/design-v3.md` 的原始定位是「遥控器 + 配置仓库」：面板不监控，只在用的时候连一次。
但 10-26 至 11-01 的几次改动让运行时数据回流控制面：

- `f8bd7cf` 在 `docs/live-observation.md` §1 写入「观测层断开时页面回退控制面快照」；
- `a60e110` 把「控制面快照」写进 `docs/data-layering.md` §5 失败矩阵；
- `c944f64` 给 `HubChannelsProvider` 的 `/state` 查询加 5s 轮询；
- `88be79b`/`748e687` 给 WireGuard/Caddy/转发的运行态查询加 3s/5s 轮询。

后果：浏览器无法直连 Hub 时，CPU/进程/服务/握手等大数据仍会经 Worker→Hub 往返，
实时性差且持续消耗 Worker 请求额度；同时与「面板不是监控系统」的定位冲突。

## 选项

| 选项 | 做法 | 利 | 弊 |
|---|---|---|---|
| A 保留控制面快照回退 + 周期轮询 | live 断开时页面用 `/state` 快照，继续 3–5s 轮询 | 观测入口坏了仍有数据 | 不实时；大量运维数据压到 Worker 配额；继续偏离定位 |
| **B 观测面唯一来源（选定）** | live 断开显示「实时观测未连接」+ 手动重连；`/state` 只在打开工作区时探测一次 | 实时数据不经过 Worker；配额可预期；与定位一致 | 直连不可用时页面没有运维数据（可接受：本来就不该由控制面承担） |
| C 全量关闭运维页面 | 只保留配置页 | 最简单 | 失去已验收的运维能力，回退产品范围 |

## 决策

采用 **B**：

1. **数据通道**：运维实时数据只来自浏览器直连 Hub `/_live/`。删除 `/state` 的周期性轮询
   （`HubChannelsProvider`、WireGuard/Caddy/端口转发运行态、Peer 运维缓存）；
   `/state` 仅在打开工作区时探测一次（控制面可达 + 写闸门 + `last_seen_at` 租约），
   另提供用户手动「重试/重新连接」。
2. **失败行为**：live 断开不回退控制面快照，主机运维页显示「实时观测未连接」并停止取数；
   连接失败不自动周期重试（避免浏览器无法直连时持续请求 Worker 票据）。
3. **观测入口**：`liveEndpoint` 由节点 `domain` 自动推导为 `https://<domain>`；
   创建表单删除死字段，设置页删除手填表单。存量显式 `liveEndpoint` 继续作为覆盖值。
4. **卸载与删除**：卸载命令不再要求用户填写包地址/sha256（Worker 用已签名最新发布包注入）；
   删除节点入口回到 `/hubs` 行内（L3 输入节点名），确认框可选「同时生成卸载 Agent 脚本」，
   删除记录后脚本仍可复制/下载；设置页不再提供危险区。

## 影响 / 迁移 / 回滚

- 契约：`agentUninstallCommandRequestSchema` 的 `packageUrl`/`sha256` 改为可选；
  未传且无发布清单时返回 `503 release_unavailable`。
- UI：`/hubs` 行内操作（进入节点、删除节点）保持 ≤2；节点设置由 4 分区收敛为 3 分区。
- 文档：`live-observation.md`、`data-layering.md`、`design-v3.md`、`page-specs.md` 同步；
  本文为唯一决策记录。
- 回滚：若需恢复快照回退，必须同时恢复文档与轮询实现，并重新评估 Worker 配额；不建议局部回滚。

## 请求预算（2026-11-04 硬约束）

验收条件：**不得把 Worker 请求额度用光**。实现遵循「打开页面拉一次 + 手动刷新」：

| 场景 | Worker 请求 | 说明 |
|---|---|---|
| 打开 `/` 概览 | 2（`/nodes`、`/certificates`） | 已删除按节点 fan-out 的 `/apps`、`/mode`、`/state` |
| 打开 `/hubs` | 1（`/nodes`） | 不自动探测；点 [刷新状态] 才 1 + N（N=节点数），单次 |
| 打开节点工作区 `/hubs/:id` | 1（节点）+ 1（`/state` 探测）+ 2–3（该页配置） | 单节点、按导航发生 |
| 打开 `/settings` | 3（设置、节点、证书） | 证书→站点占用映射只在打开证书详情/删除确认时按需拉取 |
| 浏览器直连 live | 0（票据 1 次） | SSE 直连 Hub，不占 Worker 请求 |
| host-ops 任务进度 | 1（提交）+ 退避回执 | 1→2→4→8s，≤120s 约 16 次；可取消，随抽屉关闭终止 |
| 模式切换收敛确认 | 1 + 退避回执 | 2→4→8→10s，≤60s 约 7 次；仅用户主动切换时 |

- 全局无自动重试：`QueryClient` 默认 `retry: false`、`refetchOnWindowFocus: false`、
  `refetchOnReconnect: false`；无 `refetchInterval`。
- 典型使用（每月约 10 次打开）：每次个位数到十几请求，**每月 < 200 次**，远低于额度。
- 可能放大且已设上界：手动刷新状态（1+N，一次点击一次）、写操作进度回执（退避 + 硬超时）。
- 服务端不引入 Cron / 定时探测 / 心跳；`nodes.last_seen_at` 只由真实探测更新。

## 验证

- 前端单测：`channels.test.ts` 断言 `readSource` 仅为 `live`/`none`；
  `hubsStatus.smoke.test.tsx` 覆盖 `/hubs` 删除入口（L3 + 卸载脚本）；
  `c3.smoke.test.tsx`、`forwards-card.smoke.test.tsx`、`wireguard.smoke.test.tsx`
  的运行态改由直连观测事件驱动。
- Worker 单测：卸载命令不传包信息 → `503 release_unavailable`；显式包信息路径保持。
- 线上：合并后在浏览器核对——删除入口、卸载抽屉无包字段、live 正常时无周期 `/state` 请求、
  live 断开显示「实时观测未连接」。
