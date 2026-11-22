# B2 开工说明：工作区单一入口、运维分段缓存与写后精确刷新

> 状态：已拍板 ｜ 最后核验：2026-11-22 ｜ 关联：`docs/plans/relay-latency-2026-11-22.md` §4 B2、`docs/data-layering.md` §7

> **给开发 agent**：本文是 B2 的完整任务说明。开工前读 `AGENTS.md`、提案 §1–§4、本文全文。偏离本文的地方在 PR 里写明原因；认为本文有误时在 PR 里提出，不要改 `docs/plans/` 下的文件。

## 0. 速览

| 项 | 值 |
|---|---|
| 分支 | `feat/web-fewer-requests`（从最新 `main` 拉） |
| PR 标题 | `feat(web): 工作区单一入口、运维分段缓存与写后精确刷新` |
| 发版类型 | W（面板逻辑），面板 **minor**，Agent 不变 |
| 范围 | 只改 `apps/web/src` 与 `docs/data-layering.md`；不碰 `apps/api`、契约、Agent |

## 1. 目标

1. 进入节点工作区后，在概况、应用（`sites`）、网络（`wireguard`）、运维（`ops`）、设置（`settings`）、应用详情（`apps/:app`）之间切换，**只发 1 次 `/overview`，0 次 `/state`、0 次 `/nodes/:id`**。
2. 运维页的服务、定时任务、进程、SSH 公钥、日志分段，30s 内来回切换**每个读动词只调用 1 次**。
3. 重启服务 / 清除失败状态成功后，额外请求 ≤ 2（`svc.list` + `/snapshot`），不再重拉 `/state`。
4. 页面视觉不变；刷新期间保留旧内容，骨架屏只在首次无数据时出现。

## 2. 现状（已核实，行号以 2026-11-22 `main` 为准）

| 位置 | 现状 |
|---|---|
| `app/AppShell.tsx:60-64` | `isOverviewRoute` 为假时另发一次 `/nodes/:id`（`hubQueryOptions`） |
| `app/AppShell.tsx:310` | `<HubChannelsProvider useOverview={isOverviewRoute}>`：概况走 `/overview`，其他页签走 `/state`，切换页签会在两者间来回启用 |
| `app/HubChannelsProvider.tsx` | 概况分支回填 `['hubs', id]` 与 `['hubs', id, 'state']`；非概况分支另有 `hubQuery` |
| `data/channels.ts:106-151` | D-03 自动补探（最多 3 次）只挂在 `/state` 查询上，概况路由下不生效 |
| `apps/host-ops/OpsSegments.tsx` | 服务 `:87 svc.list`、定时任务 `:279 cron.list`、日志抽屉 `:548 svc.logs`、进程 `:624 snapshot`、SSH 公钥 `:803-804 version + keys.list`、错误日志 `:1104 logs.errors`，全部是组件内 state + `callHostOps` |
| `pages/HubOpsPage.tsx:459-497` | 分段按条件渲染，切走即卸载，切回重新请求 |
| `pages/HubOpsPage.tsx:83-84, 291, 322` | 公钥 / 定时任务抽屉写成功后靠 `reloadToken` 触发重拉 |
| `apps/host-ops/refreshAfterWrite.ts` | 服务写成功后 `fetchHubState(force)` 重拉整份 `/state`（`OpsSegments.tsx:109, 127`） |
| `apps/node-settings/AgentCard.tsx:50` | 自己 `useQuery(hubStateQueryOptions)` |

写后失效 `['hubs', id, 'state']` 的 9 处：`AppPage.tsx:121`、`PeerOpsPanel.tsx:266`、`ModeSwitchDrawer.tsx:102`、`ComponentsCard.tsx:108, 138`、`InstalledAppsCard.tsx:100`、`ForwardsCard.tsx:239`、`wireguard/page.tsx:403`、`caddy/page.tsx:637`。直接 `stateQuery.refetch()` 的 3 处：`ForwardsCard.tsx:184, 202`、`AgentCard.tsx:135`。

Agent 与 Worker 侧事实：`/snapshot` 的 `failedUnits` 每次现采，不受 ops 5s 缓存影响（`agent/khc/ops.py` `collect_snapshot`）；运维页与概况页都优先读快照的失败单元（`data/failedUnits.ts`）；Worker `/snapshot` 有 2s 同节点去重。

## 3. 设计

### 3.1 工作区单一入口（已拍板：统一走 `/overview`）

1. **Provider 只用一个取数查询**：去掉 `useOverview` 属性，`HubChannelsProvider` 始终用 `hubOverviewQueryOptions` 取数。保留现有回填逻辑（queryFn 内回填 + `useEffect` 同步回填），回填 `['hubs', id]` 与 `['hubs', id, 'state']`。
2. **`stateQuery` 改为只读订阅**：context 仍暴露 `stateQuery`，供页面读 `.data`（兼容现有 10+ 处读法），实现为 `useQuery({ ...hubStateQueryOptions(hubId), enabled: false })`。新增 context 字段：
   - `runtimePending`：`overviewQuery.isPending`（替代页面里的 `stateQuery.isLoading`）
   - `runtimeError`：`overviewQuery.error`
   - `refreshRuntime(opts?: { force?: boolean })`：重拉 `/overview`（`force` 透传 `fetchHubOverview`）
   页面**不得**再调用 `stateQuery.refetch()`（disabled 查询的 `refetch` 仍会直接打 `/state`）。
3. **D-03 自动补探迁到 overview 查询**：语义不变（最多 3 次；请求失败 1.5s 后补探；节点不可达时需快照出现新帧才补探），`shouldRetryControlProbe` 复用。`data/channels.ts` 中只为 Provider 服务的 `/state` 查询分支删除（已核实 `useHubChannels` 只有 Provider 调用）。
4. **不再单独请求 `/nodes/:id`**：`AppShell.tsx` 在工作区内 `hubQuery` 改为 `enabled: false`，只读 overview 回填的缓存；回填前活动节点名退回 `hubs` 列表（AppShell 已有 `hubsQuery`）。Provider 内的 `hubQuery` 删除，`knownStatus` 取 `overview.node ?? hubs 列表`。
5. **AgentCard** 改为读 context（`stateQuery.data`、`runtimePending`、`runtimeError`、`refreshRuntime`），不再自己发 `/state`。
6. **统一的写后刷新**：`data/queries.ts` 新增 `refreshHubRuntime(queryClient, hubId, opts?)`，内部失效 `['hubs', hubId, 'overview']`（Provider 挂载中会立即重拉并回填 state）。替换 §2 列出的 9 处失效与 `ForwardsCard` 的 2 处 `stateQuery.refetch()`。
7. **不在本批范围**：全局证书页 `apps/certificates/page.tsx:255` 的 `/state` 查询（不在工作区内）；`data/mode.ts:186` 模式切换进度轮询；`pages/HubsPage.tsx:371` 新建节点后等待上线。这三处保持直接调 `/state`。

### 3.2 运维分段接入 React Query

1. `data/hostOps.ts` 新增 `hostOpsQueryOptions(hubId, target, verb, params)`：
   - `queryKey: ['hubs', hubId, 'host-ops', target, verb, params]`；`params` 用固定结构的普通对象，保证同参数命中同一缓存。
   - `queryFn` 调 `callHostOps`；`result.ok === false` 时**抛出**携带 `HostOpsError` 的错误（新增 `HostOpsQueryError`），不能把失败结果当成功缓存。
   - `staleTime: 30_000`；`enabled` 由调用方传 `!disabled`。
   - 读请求仍每次生成新的 `idempotencyKey`（现状），**不要**把它放进 `queryKey`。
2. 改造的读动词：`svc.list`、`cron.list`、`svc.logs`（`{ unit, lines }`）、`snapshot`（进程，含排序参数）、`version` + `keys.list`（公钥分段两个查询）、`logs.errors`。
3. 展示：骨架屏只在 `isPending && !data`；有数据时刷新保留旧行；「刷新」按钮调 `refetch()`；错误沿用 `HostOpsErrorBanner` 与 `hostOpsErrorTitle`。
4. 删除 `reloadToken`：`HubOpsPage` 的公钥 / 定时任务抽屉写成功后，改为失效对应分段的 key。
5. **不在本批范围**：`FirewallSegment` / `useFirewallState`（有草稿与 `baseRev` 乐观并发，缓存旧规则会让应用时报冲突）；Peer 侧抽屉（`FirewallDrawer`、`SshKeysDrawer`、`ProcessDrawer`、`PeerOpsPanel`）；`HostFirewallPortAlert`（已有 30s 查询）。

### 3.3 写后精确刷新

| 写操作 | 改后刷新 |
|---|---|
| `svc.restart`、`svc.reset-failed` | ① 失效 `svc.list` 的 key；② 调 `live.refresh()` 刷新失败计数。若距 `live.lastAt` 不足 2_100ms，延迟到满 2.1s 再调，避开 Worker 2s 去重返回旧帧。**不再**请求 `/state` 或 `/overview` |
| `cron.set` | 只失效 `cron.list` |
| `keys.add`、`keys.remove` | 只失效 `keys.list` |
| caddy / wireguard / 转发 / 组件 / 托管应用 / 模式切换 / Peer 运维的 apply 类 | `refreshHubRuntime`（行为等价于原来重拉 `/state`，改为经 `/overview`） |

`refreshAfterWrite.ts` 删除或改写为服务类的新函数，原注释里的缺陷链说明（U1：失败计数冻结）迁入新函数注释；对应测试同步改写，不得只删不补。`ServicesSegment` 通过 `useHubChannelsContext().live` 拿到快照对象。

## 4. 测试

现有 18 个测试文件引用 `/state`（如 `shell.smoke`、`caddy.smoke`、`wireguard.smoke`、`hostops.smoke`、`agent.smoke`、`mode.smoke`、`refreshAfterWrite.test`），工作区页面相关的改为模拟 `/overview`；`data/mode.test.ts`、`failedUnits.test.ts` 等数据层测试不受影响。**只改夹具，不删断言**；确需改断言时在 PR 里逐条说明。

新增（vitest + jsdom + testing-library，按现有 smoke 测试的写法计数请求）：

1. 进入 `/hubs/:id`，依次切到 `sites`、`wireguard`、`ops`、`settings`、`apps/:app` 再回概况：`/overview` 恰好 1 次，`/state` 0 次，`/nodes/:id` 0 次。
2. 深链直接进入 `/hubs/:id/ops`：同样只有 1 次 `/overview`。
3. caddy apply 成功：恰好 1 次 `/overview` 重拉，`['hubs', id, 'state']` 被回填为新值。
4. D-03：`/overview` 返回 `reachable: false` 后快照出现新帧 → 补探 1 次；最多 3 次。
5. 运维分段：服务 → 定时任务 → 进程 → 公钥 → 服务来回切，30s 内每个读动词只调 1 次；假时钟推进 30s 后再进入会重拉。
6. 读失败不缓存：`svc.list` 返回 `ok: false` → 显示错误条；切走再切回会重新请求。
7. 重启服务成功后：请求序列只有 `svc.list` ×1 与 `/snapshot` ×1，没有 `/state` 与 `/overview`；距上次快照不足 2.1s 时快照请求延迟到 2.1s。
8. 有旧数据时刷新：旧行仍在、无骨架屏。
9. 源码断言（参考 `scripts/test/ui-control-size.test.ts` 的扫描写法）：`apps/web/src` 非测试文件中，除 `HubChannelsProvider.tsx` 外不出现 `stateQuery.refetch`、`stateQuery.isLoading`、`stateQuery.error`，且不出现对 `['hubs', hubId, 'state']` 的 `invalidateQueries`。

## 5. 坑

1. `invalidateQueries` **不会**重拉 disabled 查询：state 订阅是 disabled 的，必须失效 overview，不能失效 state。
2. disabled 查询的 `refetch()` 会无视 `enabled` 直接打 `/state`，所以页面禁止调用。
3. `queryKey` 里的 `params` 结构要稳定，不然缓存永远不命中。
4. 全局 `retry: false`、`refetchOnWindowFocus: false`、`refetchOnReconnect: false` 保持不变；不要加 `refetchInterval`。
5. `live.refresh()` 只补一次请求，不重启 10s 轮询；轮询到顶（60 次）后仍可用。
6. Provider 在同一节点内切页签不卸载，所以页签切换天然 0 请求；离开再进入同一节点时按 `staleTime` 30s 判断。
7. 退出登录时 `queryClient.clear()` 已覆盖新 key，无需额外处理。
8. 离线节点：`/overview` 仍返回 D1 部分与 `reachable: false`，写闸门（`setHubWriteGuard`）改为从 overview 派生，行为与现在一致。

## 6. 文档

- `docs/data-layering.md` §7「刷新策略」改为：进入工作区拉一次 `/overview` + 写后 / 手动刷新；工作区内切页签不请求；运维分段读结果缓存 30s；服务类写操作只刷新分段与快照。更新状态块的最后核验日期。§1 中「`/state` 只在打开工作区时探测一次」相应改为 `/overview`。
- 不改 ADR-0009（已被取代）；不改提案文件。
- `CHANGELOG.md`：新版本段，例如「节点工作区内切换页签与运维分段不再重复请求节点，重启服务后只刷新服务列表与失败计数。」

## 7. 版本

面板 minor（按合并时 `main` 顺延）；Agent 不变。

## 8. 交付证据

1. `./scripts/verify.sh` 全绿。
2. 1 台测试 Hub 真机走主链路：进入节点 → 切全部页签 → 运维 5 个分段来回切 → 重启一个 `ux-*` 测试服务 → 修改一条 `ux-*` 定时任务。附开发者工具 Network 的 `/api/v1` 请求序列（录屏或 HAR 摘要，只列方法、路径、状态码）。
3. 运维页服务分段浅色、深色、390 宽截图各一张（证明无视觉回归），四态说明写明「加载态只在首次无数据时出现」。
4. 版本预览 URL 冒烟。

## 9. 审核清单（设计任务逐条核对）

- [ ] `git diff --stat` 只在 `apps/web/src`、`docs/data-layering.md`、`package.json`、`CHANGELOG.md`
- [ ] Provider 只有一个取数查询；`useOverview` 属性与 Provider 内 `hubQuery` 已删除
- [ ] 页面无 `stateQuery.refetch / isLoading / error`；9 处失效与 2 处 refetch 全部改为 `refreshHubRuntime`
- [ ] D-03 自动补探在 overview 查询上生效，有测试
- [ ] 运维读动词走 `hostOpsQueryOptions`；失败抛错不缓存；`idempotencyKey` 不在 key 里
- [ ] 防火墙与 Peer 抽屉未改
- [ ] 服务类写后无 `/state`、`/overview`；快照刷新避开 2s 去重
- [ ] 测试 1–9 齐全；smoke 测试只改夹具
- [ ] `data-layering.md` §1、§7 已更新；CHANGELOG 一行；面板 minor
- [ ] 证据：请求序列、三张截图、四态说明
