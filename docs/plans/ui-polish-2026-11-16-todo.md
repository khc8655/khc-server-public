# 节点工作区体验修正：开发任务清单（todo）

> 状态：草案 ｜ 最后核验：2026-11-16 ｜ 关联：`docs/plans/ui-polish-2026-11-16.md`、PR #64、PR #63

给开发 Agent 用：照本清单开分支、写代码、测试、发版。「为什么这么改」看提案对应小节，这里只写做什么、改哪里、怎么验收。

## 0. 开工前提

1. **按推荐拍板**：本清单假定提案 §8 的 P-1 至 P-7 全部按推荐（P-1 A、P-3 A、P-4 A，其余同意）。主人改了某一条，以主人的结论为准，由设计任务同步改本清单。
2. **PR #63 先合并**：#63 改了 `agent/adapters/host_ops.py`、`apps/web/src/data/hostOps.ts`、`apps/web/src/apps/host-ops/OpsSegments.tsx`。U1、U2 都要碰这些文件，必须基于合入 #63 之后的 main 开分支，S0 的计时也要在 #63 之后测，否则测的是旧瓶颈。
3. **每个批次一个 PR**，从最新 main 拉分支，按 PR 模板填写。提交前 `./scripts/verify.sh` 全绿；修缺陷先补会失败的测试。
4. **真机证据**写到 `docs/verification/<日期>/<主题>.md`，测试节点用 oracle-x86-2。动现有节点前先导出备份（`docs/engineering/testing.md`）。

## 1. 顺序与依赖

```
#63 合并 ─┬─ U1（纯前端，可立即开工）
          ├─ S0（只出证据）─┬─ U2（失败单元）
          │                 └─ U4（提速，按 S0 结论另行出方案）
          └─ S0 第 ③④ 项 ── U3（Peer 网络策略）
```

U1 与 S0 可以并行。U2、U3 等 S0 对应项有数据再开工。U4 不在本清单范围，S0 出结果后由设计任务补方案。

## 2. 核查时发现、提案没写到的点（开发必须照做）

| # | 问题 | 处理 |
|---|---|---|
| N-1 | 提案要把「异常」改成「失败」，但 `ui-guidelines.md` 第 189 行「状态词只用」的列表里没有「失败」，只在 §8.1 颜色表里出现 | U1 同一 PR 把「失败」加进该列表，否则改完仍算违规 |
| N-2 | Peer 侧的主机运维脚本不能由 Hub 远程更新（`host_ops.py` 文件头），Peer 可用写动词只有 `svc.restart`（`PEER_SAFE_WRITE_VERBS`） | U2 的 `svc.reset-failed` 先只对 Hub 自身开放；Peer 上显示「脚本需更新」引导，不加入 `PEER_SAFE_WRITE_VERBS` |
| N-3 | U1 的「写操作成功后立即重新拉取」如果重新拉 `/state`，失败计数在 U2 之前就能归零 | U1 写操作成功后同时失效服务列表和 `/state` 查询；U2 再把来源换成快照 |
| N-4 | 「需要处理」只放受管单元，要有一份单元名单（`khc-*`、`caddy`、`wg-quick@*`、`khc-app-*`） | 名单只写在一处常量里（放 `apps/web/src/data/` 下），带单测；页面里不得散写应用名 |
| N-5 | WireGuard 允许用户自定义 `interface.postUp`。自定义后，适配器渲染的 FORWARD 规则会和用户规则冲突或被覆盖 | U3 检测到自定义 `postUp` 时不强制策略：保存时返回明确错误或警示，页面说明「自定义 PostUp 时网络策略不生效」 |
| N-6 | 存量 Peer 要保持全通 | 不做 D1 迁移：Peer 配置里没有网络策略字段时一律按「Hub + 所有 Peer」处理；只有面板新建的 Peer 才显式写「仅 Hub」 |
| N-7 | 提案 P-3b 写「L1 确认」，但 `ui-guidelines.md` §8.2 的 L1 是直接执行、不弹确认，重启服务属于 L2 | `svc.reset-failed` 按 L2 处理（确认框），与重启同级 |

## 3. S0 实测（只出证据）

- 分支：`docs/s0-ui-polish-measure`；不改代码，不 bump。
- 证据文件：`docs/verification/<日期>/ui-polish-s0.md`。

| 项 | 要测什么 | 记录 |
|---|---|---|
| ① | 主机运维各类调用的耗时，分三段：浏览器→Worker→Agent 往返、Agent 执行命令、Peer 经 SSH 跳转。动词至少覆盖 `svc.list`、`svc.restart`、`logs.errors`、防火墙列表，Hub 和 Peer 各测 | 每个动词每段耗时，取 5 次的中位数和最大值 |
| ② | 在测试节点上手动执行 `systemctl list-units --state=failed --no-legend --plain` 的耗时 | 中位数、最大值；判断能否每 10 秒执行一次 |
| ③ | 测试 Peer 把 `AllowedIPs` 改成 `0.0.0.0/0` 后：它自己公网 IP 上的 SSH 是否断开；DNS 走哪里 | 结论、复现命令、恢复步骤 |
| ④ | 在 Hub 上手动加 `wg0→wg0` 默认 DROP、按对放行的 FORWARD 规则后：现有端口转发、Caddy 站点上游、Peer 到 Hub 是否正常 | 每项通过 / 失败；测完删除规则 |

验收：四项都有实测数据；测完节点恢复原状，证据里写明恢复步骤。

## 4. U1 纯前端体验修正

- 分支：`feat/ui-polish-u1`；面板 minor；不改 Agent、契约、迁移。
- 改动范围：`apps/web/src/`、`docs/ui-redesign/page-specs.md`、`docs/ui-redesign/ui-guidelines.md`、CHANGELOG。

任务：

- [ ] **节点栏去掉地址**（提案 §1，P-1 A）：`ui/shell.tsx` 的 `HubBar` 不再渲染 `endpoint`，删除 `.ui-hubbar-node-endpoint` 样式；节点名在 390 宽下不截断（放不下时整体换行或省略节点栏其他次要元素，不截节点名）。
- [ ] **地址只出现一次**：`HubOverviewPage.tsx` 标题下用灰色纯文本显示主机名（去掉 `https://`），悬停出现复制按钮。删除第 481 行「实时状态」卡片 hint 里的地址（保留 Agent 版本）和第 535 行页脚里的地址。
- [ ] **概况「对外服务」改列名字**（§2）：网页服务、远程访问、Peer 三组各最多 5 行，超出加「全部 N 个 ›」；整行可点，悬停出现灰色「›」，不用蓝色链接。计数只留在上方指标卡。
- [ ] **状态词与颜色**（§2，N-1）：`grep -rn "异常" apps/web/src` 结果里所有面向用户的文案改为「失败」或规范内的词（代码注释可保留）；`StatusDot` 与 Badge 按 `ui-guidelines.md` §8.1 统一：导航和列表用圆点，状态列用 Badge。PR 里贴改前、改后的 grep 结果。
- [ ] **「需要处理」只放受管单元**（§3，P-3 A，N-4）：`TodoChips` 只收受管单元；其他失败单元在「主机与服务」卡片显示一行灰色「系统服务 N 个失败 ›」，点击进主机运维页。
- [ ] **写操作后重新拉取**（§5，N-3）：重启等写操作成功后，失效服务列表和 `/state`，状态带计数随之更新。
- [ ] **日志错误改名分组**（§5）：「系统错误（近 24 小时）」改为「近 24 小时日志错误」，加说明「历史记录，修复后不会立即消失」；按单元分组，组标题显示该单元当前状态（如「khc-r3-driver · 当前：运行中」）。
- [ ] **统一连接指示**（§4，P-4 A）：节点栏一个指示，三态「实时 · 直连」「实时 · 经控制面」「离线」；点开列出每类数据走哪条通道（指标 / 主机运维 / 服务清单）。去掉「实时状态」卡片上单独的「直连」标签。主机运维页不因没有域名而关闭。
- [ ] 登记 `page-specs.md`；若新增文案词，同步 `ui-guidelines.md`。

验收：
- 以上每项都有前端单测；计数刷新那条要有「重启成功后状态带计数变化」的测试。
- 截图：概况页、主机运维页，各附浅色、深色、390 宽；四态（加载、空、错误、正常）说明。
- `grep -rn "异常" apps/web/src` 不再出现面向用户的文案。
- 真机：在 oracle-x86-2 上重启一个失败单元，状态带计数在操作成功后更新。

## 5. U2 失败单元进快照

- 分支：`feat/ui-polish-u2`；Agent minor、面板 patch。
- 改动范围：`agent/khc/ops.py`（冻结核心，PR 里写明必要性：失败单元现在只在 `/state` 采集，10 秒快照不含，页面只能拿到打开时的旧值）、`agent/adapters/host_ops.py`、`packages/contracts`（快照字段）、前端、`docs/live-observation.md`、`docs/host-ops.md`。
- 前提：S0 第 ② 项表明每 10 秒执行一次的耗时可以接受；不可接受时停下，由设计任务改方案（例如降频或缓存）。

任务：

- [ ] `collect_snapshot` 带上 `failedUnits`（复用 `ops.py` 第 273 行附近已有的采集逻辑，不重复写），上限 10 条与 `/state` 保持一致。
- [ ] 契约新增快照字段 `failedUnits`，旧 Agent 不返回时前端退回读 `/state`。
- [ ] 状态带、概况页、「需要处理」改读快照。
- [ ] 新增写动词 `svc.reset-failed <unit>`（P-3b）：白名单校验单元名、写审计、L2 确认框（重启类在 `ui-guidelines.md` §8.2 是 L2，这里同级）；只对 Hub 自身开放（N-2）。
- [ ] 主机运维「服务」列表对失败单元显示「清除失败状态」。

验收：
- 重启或清除失败状态成功后，10 秒内状态带和概况页计数归零（真机录证据）。
- 旧 Agent（不带 `failedUnits`）下页面仍正常显示。
- `svc.reset-failed` 拒绝非法单元名、在 Peer 上被拒绝，均有测试；审计有记录。

## 6. U3 Peer 网络策略

- 分支：`feat/ui-polish-u3`；Agent minor、面板 minor。
- 改动范围：`packages/contracts`（Peer 网络字段）、`agent/adapters/wireguard.py`、前端 Peer 抽屉、`docs/security-boundaries.md`、`docs/design-v3.md`（若涉及数据模型）。
- 前提：S0 第 ③④ 项完成。第 ④ 项如发现现有转发或站点受影响，停下，由设计任务改方案。

任务：

- [ ] 契约：Peer 新增 `reach`（`hub` / `peers` / `all`）、`reachPeers`（`reach=peers` 时的 Peer 名列表）、`egress`（`internal` / `all`）。字段缺失按 `reach=all`、`egress=internal`（N-6）。
- [ ] 适配器渲染 FORWARD：`wg0→wg0` 先按 Peer 对双向放行，再默认 DROP；`wg0→外网` 只对 `egress=all` 的 Peer 放行。规则可重复 apply 不叠加，PostDown 对称删除。
- [ ] 自定义 `postUp` 时按 N-5 处理。
- [ ] 客户端配置 `AllowedIPs` 跟随策略：仅 Hub → Hub 的 /32；指定 Peer → 再加对方 /32；所有 Peer → 整个网段；全部流量 → `0.0.0.0/0`。
- [ ] Peer 抽屉新增「网络」区：可达范围、出网方式两项。选「全部流量走 Hub」时弹 L2 确认框，必须勾选「我已了解」，风险文案用提案 §6 的四条。
- [ ] 面板新建 Peer 时显式写 `reach=hub`。

验收：
- 新 Peer 默认 ping 不通其他 Peer；指定互通后双向可通；选「全部流量走 Hub」必须确认；存量 Peer 连通性不变（真机，至少两个 Peer）。
- 单测覆盖规则渲染、幂等 apply、PostDown 对称、自定义 `postUp`、字段缺失的默认值。
- `security-boundaries.md` 写明默认隔离与「全部流量走 Hub」的风险。

## 7. 发版

每个 PR 按 `docs/engineering/release.md` 处理，版本号以脚本为准，本清单不写具体数字：

- U1：面板 minor。
- U2：Agent minor + 面板 patch；先发面板，后升级 Agent。
- U3：Agent minor + 面板 minor；同上。
- 合并后在 oracle-x86-2 上升级 Agent，并在 PR 里补一条升级后冒烟结果（打开概况页、主机运维页、Peer 页各一次）。

## 8. 不做

- U4 主机运维提速：等 S0 出数据，另写方案。
- 「忽略失败单元」功能（提案 §3 的 B），本次选了 A。
- 只读动词改走直连（提案 §4 的 B）。
