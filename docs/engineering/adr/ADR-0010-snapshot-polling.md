# ADR-0010: 可见时 10s 快照轮询（收敛 SSE）

- 状态：已接受（验证分支 `feat/snapshot-polling`；未合并、未部署）
- 日期：2026-11-04
- 决策者：主人
- 关联：`docs/live-observation.md`、`docs/data-layering.md`、`docs/ui-redesign/page-specs.md`
- 取代：ADR-0009 中「观测面只能直连、任何轮询都不允许」的约束（其余结论保留）

## 背景

ADR-0009 为避免 Worker 配额被持续消耗，选择了「SSE 直连 + 打开页面只探测一次」，
并禁止任何周期轮询。实际使用暴露两个问题：

1. 没有可信 HTTPS 域名的节点（裸 IP）浏览器无法直连，页面没有任何运行时数据；
2. SSE 使用一次性 ticket、断线不自动重连，短暂网络抖动后必须人工点「重新连接」；
3. 主机指标需要的是低频趋势（10s 足够），1s 推送的 SSE 维护成本与断线语义都偏重。

主人拍板方案 A：**页面可见时 10s 轮询，隐藏即停，10 分钟/60 次硬上限**。

## 选项

| 选项 | 做法 | 利 | 弊 |
|---|---|---|---|
| A 10s 可见轮询（选定） | 直连 `/_live/snapshot`；无域名经 Worker `/nodes/:id/snapshot`；2s 去重 | 有域名/无域名都能用；断线自动恢复；请求量可算且有上限 | 无域名时每 10s 消耗 1 个 Worker 请求（有 10min/60 次上限） |
| B 保留 SSE | 修复重连与 IP 直连 | 实时性 1s | 断线语义复杂；一次性 ticket 每次重连都要 Worker 请求；与低频趋势需求不匹配 |
| C 纯手动刷新 | 永远不自动 | Worker 请求最少 | 打开页面后数据不更新，运维判断失真 |

## 决策

1. **Agent**：新增 HMAC 保护的 `GET /snapshot`，只读 `/proc` + `statvfs`，返回
   CPU/内存/磁盘/负载/uptime；CPU 用计数器差分，首次或间隔 >30s 时请求内双采样 1 秒；
   不引入常驻线程/定时器。
2. **浏览器直连**：有可信 HTTPS 域名时 `GET https://<domain>/_live/snapshot?ticket=`；
   ticket scope=`snap`、TTL 15 分钟、有效期内可复用（不重复换票）；
   Agent 回 CORS 与 `Access-Control-Max-Age: 600`（简单 GET 本不触发预检，作为兜底）。
3. **无域名**：`GET /api/v1/nodes/:id/snapshot` 经 Worker 转发 HMAC `/snapshot`；
   Worker 内存 2 秒去重为**单 isolate 内尽力而为**：命中时共享同一 Agent 采集，
   未命中（跨 isolate / 冷启动 / 错峰）时按标签页各自采集；不承诺多标签页不放大。
   Worker 请求数始终按标签页计。
4. **前端**：打开页面拉 1 次；`visibilitychange` 隐藏立即清定时器；切回按剩余间隔恢复，
   任意时刻只有一个 `setTimeout`；硬上限 10 分钟或 60 次（二者等价）；到顶显示
   「已停止自动刷新 · 数据截至 xx:xx」并提供手动刷新（只补一次，不重启自动循环）。
   图表/历史数据只进本地环形缓冲（120 点），不落库、不新建中间存储。
5. **多标签（直连）**：同一浏览器同源标签页经 `BroadcastChannel` 共享一个 10s 计时器
   与最近快照：最早加入的存活标签为 leader 并独占请求，其余标签只读广播值；
   leader 关闭后由存活标签自动接管；任一标签可见才继续。leader 选举带 100ms 启动
   稳定期，避免新标签抢跑多一次请求。转发模式不启用该协调（浏览器无法跨标签共享
   Worker isolate 的内存去重）。
6. **SSE 停用**：前端不再引用 `data/live.ts`（代码保留但不可达）；
   Agent `/_live/` SSE 代码保留，Caddy 路由不变，仅作为历史兼容。
7. **UI 文案**：`实时（10s）` / `无域名 · 仅快照` / `已停止自动刷新 · 数据截至 xx:xx` /
   失败时追加「将按 10s 节奏自动重试」。不新增页面范式与导航层级。

## 影响 / 迁移 / 回滚

- 契约：`liveTicketRequestSchema.scope` 增加 `snap`；响应增加可选 `snapshotPath`；
  新增 `agentSnapshotSchema` / `nodeSnapshotResponseSchema`。
- 页面：CPU/内存/磁盘指标改用 10s 快照；适配器运行态、服务/进程、端口等重数据
  仍来自打开工作区时的一次性 `/state`，写操作后沿用既有 `state` 失效重取。
- 回滚：停止引用 `useHubSnapshot`、恢复 `useLiveHub` 即可；Worker 路由与 Agent 端点可保留。

## 请求预算（相对 ADR-0009）

| 场景 | Worker 请求 |
|---|---|
| 有可信域名（直连） | 打开 1 次票据 + 最多 60 次直连（不占 Worker）；10 分钟后停 |
| 无域名（转发） | 打开 1 次票据不需要；每 10s 1 次，最多 60 次，然后停 |
| 多标签页（直连） | 只有 leader 发请求（1 路 10s 节奏）；leader 关闭后接管继续，仍受 60 次上限 |
| 多标签页（转发） | Worker 请求按标签页计；2s 去重命中时共享一次 Agent 采集，未命中时按标签页各自采集（单 isolate 内存 Map，尽力而为） |
| 隐藏 / 到顶 | 0 |

## 验证

- 单测：`SnapshotLoop`（节奏/可见性/上限/环形缓冲/失败恢复）、多标签共享
  （两标签只发一路 / leader 退出接管 / 全部隐藏停止，`snapshot-shared.test.ts`）、
  Worker 快照转发与去重、Agent 快照采样与 HMAC、snap 票复用与 CORS。
- 真机：node-test-2 临时 Agent（非生产实例）连续 30 分钟可见 + 30 分钟隐藏，
  记录请求数、资源曲线、断网/重启恢复与 `top`/`free` 对照；
  结论见 `docs/verification/2026-11-04/snapshot-stability.md`（本分支未合并、未部署）。
