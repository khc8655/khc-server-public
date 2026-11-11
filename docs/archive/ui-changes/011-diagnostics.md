# UI 变更单 #011：节点活动与诊断

> **2026-10-29 更新（#49）**：诊断已精简为 7 个核心码 + 适配器 `problems`；本单中的 `deepCheck` / `depth=basic|full` / OK 行 / 摘要计数已废弃，以 `docs/diagnostics.md` 为准。

- **状态**：草案（2026-10-26，待主人批准后实现；Wave 2）
- **路由**：**不新增**。落地在节点概况 `T1 /hubs/$hubId` 的「活动与诊断」卡片 + 错误详情抽屉；关联跳转 `/hubs/$hubId/activity`
- **依据**：`docs/diagnostics.md`（错误码目录 / API 形状 / 修复边界）、`docs/ui/ui-spec.md` v2.2（§1 作用域、§4 组件、§5 交互、§7.1 变更单）
- **设计原则**：诊断是"看一眼、知道怎么办"，不是监控面板；修复动作必须 L2 确认且来自动作注册表。

---

## 1. 作用域

- **层**：节点层（S4：页头已有 ScopeChip，卡片内不重复放节点切换）。
- **对象**：节点本身（诊断结论属于节点，不属于某个应用）；卡片内的行可以指向某个应用/站点/证书。
- **父容器**：节点。不新增对象类型，不需要在 `ui-spec` §1.2 新增 S 规则。
- **与既有卡片的关系**：`活动与诊断` 是节点概况里的**只读诊断卡**，不替代「实时观测」「主机运维」卡片；三者边界：
  - 实时观测：数据新鲜度与连接状态；
  - 主机运维：CPU/内存/进程/防火墙等**写操作**；
  - 活动与诊断：**错误归因 + 修复入口**。

## 2. 流程（新增 F13，按 F12 模板）

> 实现 PR 需同时把 F13 补进 `docs/ui/ui-spec.md` §2（规范变更，随 PR 评审）。

```
F13 查看诊断并修复（层：节点；形式：页面内卡片 + 抽屉）
入口（唯一）：/hubs/:hubId 概况页「活动与诊断」卡片；卡片内「查看」打开错误详情抽屉。
前置条件与未满足时的空状态：
  - 节点存在 → 正常；
  - 首次进入且检查未完成 → 卡片 Skeleton「正在检查…」；
  - 节点离线 → 卡片顶部 neutral 提示，仍展示上次结果，修复按钮禁用。
步骤（每步：内容、主按钮、何时可继续）：
  1) 卡片展示摘要（正常 / 需关注 n / 需处理 n / 无法检查 n）与问题列表；
  2) 点某一行「查看」→ 抽屉：错误码、根因、影响、可能原因、检查步骤（只读命令可复制）、技术信息、关联日志；
  3) 点修复动作 → L2 确认（影响 + 时长 + 可回滚）→ 执行（同步动作 15s 内；任务动作打开 TaskView）；
  4) 成功后自动重新检查，卡片回到 ok 或下一项；失败留在抽屉内展示 InlineError（含错误码）。
中途退出与草稿：
  - 抽屉无草稿；Esc/遮罩关闭；修复执行中关闭抽屉不取消动作（任务动作有「取消任务」）。
异常与恢复（每种异常：显示位置、文案、恢复动作）：
  - 面板级错误（401/404/503/网络）→ 卡片 danger Banner「无法完成检查」+「重试」；
  - 节点离线 → neutral Banner「节点离线，显示上次检查结果」；修复按钮 disabled + disabledReason「节点离线」；
  - 检查超时（>4s）→ 该次检查不完整，卡片显示「部分项目无法检查」，可点「重新检查」；
  - 修复失败 → 抽屉底部 danger Banner（含错误码与「查看日志」）；
  - 修复后仍失败 → 保留抽屉，提示「问题仍在，建议按检查步骤人工确认」。
完成落点：停留在节点概况；抽屉关闭，卡片行高亮 2 秒（与列表页一致）。
审计事件：诊断读取**不写审计**；修复动作沿用其自身审计（`app.apply`、`caddy.reload`、`cert.issue` 等）。
手机：完整支持「查看诊断 + 只读修复入口」；修复动作底部通栏，详情全屏。
```

## 3. 页面与模板

| 项 | 规定 |
|---|---|
| 页面 | `/hubs/$hubId`（既有 T1 节点概况），**不新增路由** |
| 卡片位置 | PageHeader → 现有离线/不可达 Banner → 实时观测卡 → 统计条 → **「活动与诊断」卡片** → 节点信息/主机 → 主机运维 → 端口 → 适配器 → 应用表 |
| 卡片模板 | `Card`（标题 + 右侧刷新 icon button）；内部用 `Stack` 组合摘要行 + 问题列表；**禁止卡片嵌卡片** |
| 问题列表 | 桌面用 `Table`（4 列：检查项 / 状态 / 说明 / 操作）；手机转 list-row（§6.2） |
| 详情 | `Drawer` 480（手机全屏），单视图；不含 Tabs |
| 抽屉底栏 | 左侧后果说明（12px text-3）；右侧 ≤2 个按钮：「复制诊断报告」（default sm）+ 主修复动作（primary/danger） |
| 抽屉体内 | 分区顺序：状态徽章 + 根因 → 影响 → 可能原因 → 检查步骤 → 技术信息 → 关联日志 |

## 4. 入口（唯一）

| 入口 | 说明 |
|---|---|
| 节点概况卡片 | 唯一诊断入口；不在侧栏/顶栏/命令面板新增入口 |
| 错误行「查看」 | 打开该 check 对应的 Hint 抽屉 |
| 「查看活动」 | `Link` 到 `/hubs/$hubId/activity`（活动页数据源见 §13 不在本单范围） |
| 全局「需要处理」 | 后续在概览页复用同一抽屉；**本单不做**（避免跨节点扇出） |

## 5. 动作清单

| id | 标签 | 级别 | 任务 | 审计 | 说明 |
|---|---|---|---|---|---|
| `node.diagnostics.check` | 重新检查 | 只读（无级别） | 否 | 无 | 调 `GET /nodes/:id/diagnostics?depth=basic` |
| `node.diagnostics.deepCheck` | 深入检查 | 只读 | 否 | 无 | `depth=full`，调 `/adapters` |
| `node.diagnostics.copyReport` | 复制诊断报告 | 只读 | 否 | 无 | 前端格式化复制，不含证据原文以外的数据 |
| `node.diagnostics.openHint` | 查看 | 只读 | 否 | 无 | 打开详情抽屉 |
| `app.apply`（复用） | 重试应用配置 | L2 | 否 | 既有 `app.apply` | 前置：节点可达、D1 有配置、无运行中任务 |
| `wg.apply`（复用） | 重新应用 WireGuard | L2 | 否 | 既有 `wg.apply` | 后果：隧道可能中断 1–2 秒 |
| `caddy.reload`（复用） | 重新加载 Caddy | L2 | 否 | 既有 | 后果：站点短暂不可用 <1 秒 |
| `caddy.service`（复用） | 启动 Caddy | L2 | 否 | 既有 | 后果：站点中断数秒 |
| `peer.cancelRotation`（复用） | 取消换钥 | L2 | 否 | 既有 `peer.cancelRotation` | 仅对 PENDING 轮换 |
| `cert.issueAcme`（**新增**） | 重新签发证书 | L2 | 是 | `cert.issue` | 复用 `POST /apps/certificates/issue_acme`；ACME 有频率限制 |
| `node.preferDirect`（**新增**） | 改走直连 | L1 | 否 | `node.prefer_direct` | 仅改 `preferred_route`，不影响业务，Toast 带撤销 |
| `hostOps.probe`（复用） | 连通探测 | 只读 | 否 | 既有 | 用于 host-ops 错误 |
| `hostOps.onboard`（复用） | 重新接入 | L2 | 否 | 既有 | 替换 Peer 受限公钥与脚本 |

> 动作必须在 `registry/actions.ts` 登记后才允许在卡片/抽屉中出现；页面只引用 `ActionRef`，不自己拼按钮（ui-spec §7.4）。新增 `cert.issueAcme`、`node.preferDirect`、`node.diagnostics.*` 是**本单的代码交付物之一**。

**级别判定（对照 §5.4）**：

- `preferDirect` 只改控制面的路由偏好，10 秒内可撤销 → **L1**；
- 其它写动作会中断连接/服务或使旧配置失效 → **L2**；
- 本单**没有 L3**（诊断不删除任何对象）。

## 6. 使用的组件（只列第 4 章已有组件）

| 组件 | 用途 |
|---|---|
| `Card` | 卡片容器 |
| `Badge` | 摘要状态（ok/warn/danger/neutral）与抽屉错误级别 |
| `StatusDot` | 问题行状态点（必须与文字相邻） |
| `Table` | 桌面问题列表（`name/status/text/actions` 四类列） |
| `Button` | 重新检查、深入检查（sm ghost/default）、修复动作 |
| `Link` | 「查看活动」 |
| `Banner` | 离线、面板级错误、修复失败 |
| `EmptyState` | **不用**（全 ok 用摘要行表达，不用插画空状态） |
| `Skeleton` | 首次检查中 |
| `Row` / `Stack` / `Grid` | 布局 |
| `KeyValue` | 抽屉「影响 / 技术信息」 |
| `CodeBlock` | 只读命令（仅复制，不执行） |
| `LogViewer` | 关联任务日志（有任务时） |
| `Drawer` | 错误详情 |
| `ConfirmDialog`（经 `ConfirmAction`） | L2 确认 |
| `TaskView` | 任务型修复（证书签发等） |
| `SyncStatus` | **不用**（诊断不表达"下发中"；避免与配置同步混淆） |

> 不需要新组件；若实现时发现必须新增，按 ui-spec §4 格式补完整条目并重新评审。

## 7. 新文案（`i18n/zh.ts` → `diagnostics` 段）

| key | 中文 |
|---|---|
| `title` | 活动与诊断 |
| `summaryOk` | 未发现需要处理的问题 |
| `summaryIssues` | {count} 项需要处理 |
| `summaryWarn` | {count} 项需要关注 |
| `summaryUnknown` | {count} 项无法检查 |
| `lastChecked` | 最近检查 {time} |
| `neverChecked` | 尚未检查 |
| `recheck` | 重新检查 |
| `deepCheck` | 深入检查 |
| `checking` | 正在检查 |
| `partial` | 部分项目无法检查 |
| `stale` | 数据来自 {minutes} 分钟前 |
| `offlineTitle` | 节点离线 |
| `offlineHint` | 显示上次检查结果，恢复连接后可重新检查 |
| `loadError` | 无法完成检查 |
| `loadErrorHint` | 控制面暂时无法获取诊断结果，请重试 |
| `view` | 查看 |
| `viewAll` | 显示全部 {count} 项 |
| `onlyIssues` | 只看需要处理 |
| `viewActivity` | 查看活动 |
| `drawerContext` | 节点 {hub} · 诊断详情 |
| `impact` | 影响 |
| `causes` | 可能原因 |
| `steps` | 检查步骤 |
| `readonlyHint` | 以下命令只读，复制到节点上执行 |
| `evidence` | 技术信息 |
| `relatedLog` | 相关日志 |
| `fixes` | 可以这样处理 |
| `copyReport` | 复制诊断报告 |
| `reportCopied` | 已复制诊断报告 |
| `fixRunning` | 处理中 |
| `fixFailed` | 处理失败，问题仍在 |
| `fixDone` | 已处理，正在重新检查 |
| `disabledOffline` | 节点离线，无法执行 |
| `disabledBusy` | 节点正在执行其它任务 |
| `noFix` | 这类问题需要在节点上人工处理 |

> 术语遵循 ui-spec §6.1：状态码只进「技术信息」；不出现 desired/reconcile/rev 等实现词；不出现括号英文；无 Emoji。

## 8. 状态覆盖

| 状态 | 卡片 | 抽屉 |
|---|---|---|
| **空**（首次） | Skeleton 2 行，高 96 | — |
| **加载**（刷新） | 保留旧数据 + 标题右侧 14px 旋转环；「重新检查」loading | 修复后自动刷新时，抽屉保持打开 |
| **全 ok** | `Badge tone=ok`「未发现需要处理的问题」+ 最近检查时间 + 「深入检查」 | — |
| **有 warn/error** | 摘要 Badge（warn/danger）+ 前 5 行问题；超过显示「显示全部 N 项」 | 点击行打开 |
| **离线** | 顶部 neutral Banner「节点离线」；行仍可打开看上次结论；修复按钮 disabled | 修复按钮 disabled + 原因 |
| **面板级错误** | danger Banner「无法完成检查」+「重试」；不显示旧结果时用空摘要 | 不出现 |
| **部分 unknown** | 摘要「{count} 项无法检查」，unknown 行排最后 | 抽屉显示证据缺失原因 |
| **权限** | 401 由全局会话过期遮罩处理，卡片不单独提示 | — |
| **修复中** | 卡片只读（不重复发起）；按钮 loading | 按钮 loading；任务型切 `TaskView` |
| **修复失败** | 该行保持原状态并高亮 | 底部 danger Banner + 「查看日志」 |

**"四态"验收口径**：空 / 加载 / 错误 / 离线必须各有截图与实现；"同步四态"不适用于本卡（用诊断 severity 代替）。

## 9. 手机（390 宽，完整支持）

- 卡片全宽；摘要一行 + **最多 3 行**问题（名称 + 状态徽章 + 一行说明），行高 ≥56；「显示全部」展开为全屏列表（沿用列表页）。
- 点行 → **全屏抽屉**（不是底部弹层）：顶部返回「‹ 返回节点」+ 标题；正文单列；`CodeBlock` 自动换行；`KeyValue` 上下堆叠；技术信息默认折叠。
- 底栏固定：`[重新检查]`（default）+ 主修复动作（primary/danger），高 40、点击区 ≥44；`复制诊断报告` 移入顶栏 ⋯。
- 「深入检查」「查看活动」进 ⋯ 菜单（避免底栏超过 2 个按钮）。
- 修复确认框为全屏宽度 Dialog；L2 文案不截断。
- 降级：无。诊断在手机上完整可用（只读 + 修复触发），与 ui-spec §6.2 的手机宜做清单一致。

## 10. 截图计划

| # | 场景 | 尺寸 |
|---|---|---|
| 1 | 卡片：有 2 项问题（1 warn + 1 error） | 桌面浅色 / 深色 |
| 2 | 卡片：全 ok | 桌面浅色 |
| 3 | 错误详情抽屉（含检查步骤与只读命令） | 桌面浅色 / 深色 |
| 4 | L2 确认框（重新应用 WireGuard） | 桌面浅色 |
| 5 | 离线态卡片（修复禁用） | 桌面浅色 |
| 6 | 手机：卡片 + 全屏抽屉 | 390 宽 |

> 截图存放 `docs/ui/shots/011-*.png`；PR 内附前后对比。

## 11. 能力暴露表（ui-spec §7.7）

| 能力 | 档 | 理由 |
|---|---|---|
| 诊断摘要/问题列表 | **A 主路径** | 打开节点第一眼要知道"哪里不对" |
| 错误标题/根因/影响 | **A** | 决定要不要处理 |
| 检查步骤与只读命令 | **B 偶尔调整** | 需要人工排查时才看，默认折叠在抽屉 |
| 技术信息（evidence） | **C 只看不改** | 判断用，不参与决策 |
| 修复动作 | **A（推荐项）/ B（其它项）** | 只有一个主推荐；其余在「可以这样处理」里 |
| 活动列表 | **D（本期不暴露）** | 数据源未实现（见 §13） |
| 全部错误码目录 | **D** | 只在 API；UI 只展示命中的码 |
| 原始 Agent 响应 | **D** | 只进白名单 evidence，不透传 |

## 12. 注册表与数据层改动（实现清单）

| 文件 | 改动 |
|---|---|
| `registry/routes.ts` | **不改**（无新路由） |
| `registry/actions.ts` | 新增 `node.diagnostics.check` / `deepCheck` / `copyReport` / `openHint`（只读）、`cert.issueAcme`（L2/task）、`node.preferDirect`（L1） |
| `data/diagnostics.ts`（新） | `fetchHints()`、`fetchNodeDiagnostics(hubId, depth)`；react-query options（`staleTime=10s`、`retry=0`） |
| `data/diagnostics.test.ts`（新） | 成功/超时/401/空 checks 的解析用例 |
| `pages/HubOverviewPage.tsx` | 插入 `<DiagnosticsCard hubId={hubId} />` |
| `pages/diagnostics/`（新目录） | `DiagnosticsCard.tsx`、`DiagnosticsDrawer.tsx`、`useFixAction.ts`（只组合 `ui/` + `patterns/` + `data/`） |
| `i18n/zh.ts` | §7 文案 |
| `docs/ui/ui-spec.md` | 补 F13（同 PR，规范变更） |

## 13. 不在本单范围（明确不做）

- ❌ 不新增 `/hubs/:hubId/diagnostics` 页面或侧栏入口；
- ❌ 不做节点活动列表的数据源（需 `AuditRepo.list` + `GET /nodes/:id/activity`，另开任务；本单只放「查看活动」链接）；
- ❌ 不做跨节点「需要处理」聚合（概览页后续复用抽屉，另行设计）；
- ❌ 不做自动修复、自动刷新轮询、告警推送；
- ❌ 不做 Web Shell、命令执行、日志全量拉取；
- ❌ 不在诊断抽屉里编辑配置（只跳转）；
- ❌ 不做历史趋势/图表；
- ❌ 不新增组件、不新增颜色/图标（只用封闭集）。

## 14. 验收清单（对照 ui-spec §7.8）

- [ ] 已附本变更单编号（#011）与能力暴露表
- [ ] 作用域：节点层，无新 S 规则违反；卡片内不出现创建入口
- [ ] 只用第 4 章组件与封闭列类型；无新样式/新颜色/新图标
- [ ] 表格行高 44 不被撑开；长 detail 用 Truncate（`end`）；域名用 `middle`
- [ ] 无 Emoji、无内联 svg、无括号英文；文案全部来自 `i18n/zh.ts`
- [ ] 所有动作来自注册表并标注级别；L2 用 `ConfirmAction`；L1 有 Toast 撤销
- [ ] 空 / 加载 / 错误 / 离线 / 部分未知 / 修复中 / 修复失败 均已实现
- [ ] 机密值不出现；证据已脱敏；诊断报告不含敏感字段
- [ ] 浅色、深色、390 宽截图已附
- [ ] 键盘可达：卡片行可 Tab 打开，抽屉焦点锁定，Esc 关闭
- [ ] `./scripts/verify.sh` 全绿（typecheck + vitest + agent + build）
- [ ] 手机：抽屉全屏、底栏 ≤2 按钮、点击区 ≥44

## 15. 依赖与风险

| 项 | 说明 |
|---|---|
| 依赖 `docs/diagnostics.md` 的 API | 未实现前本单不可开工；hints/诊断响应字段以该文档为准 |
| 依赖 D6/D7 决策 | `last_apply_error` 列与 `/state` 的 `agent.version/serverTime` 若不加，对应行显示 `unknown`（可接受） |
| 风险：误报 | 用 `unknown` 兜底而不是 error；阈值集中在 `evaluate.ts` 便于调 |
| 风险：抽屉信息过载 | 检查步骤默认折叠；技术信息折叠；正文不超过 3 个分区可见 |
| 风险：手机修复误触 | 修复动作只能在抽屉底栏/正文显式按钮触发；卡片行点击只打开详情 |
