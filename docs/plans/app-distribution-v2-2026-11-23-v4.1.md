# V4.1 开工说明：升级沿用安装参数（前端 + Worker）与 V4 真机发现修复

> 状态：已拍板 ｜ 最后核验：2026-11-23 ｜ 关联：`docs/plans/app-distribution-v2-2026-11-23.md` §15；`docs/plans/app-distribution-v2-2026-11-23-v4.md`；`docs/verification/2026-11-23/manifest-v2-web.md` §五

> **给开发 agent**：开工前提：V4 已合入（#158），V4 真机证据已合入（#160）。先读 `AGENTS.md`、提案 §15、V4 开工说明与本文全文。本批改**前端 + Worker + 文档**，**不改契约（`packages/contracts`）与 Agent**；Agent 侧的「安装记录保存参数值」在 V5b（V5 §8.2）做。认为本文有误时在 PR 里提出，不要改 `docs/plans/` 下的文件。

## 0. 速览

| 项 | 值 |
|---|---|
| 分支 | `fix/manifest-upgrade-values`（从最新 `main` 拉，用独立 worktree） |
| PR 标题 | `fix: 应用升级沿用安装参数、单元状态与 v1 条目显示（V4.1）` |
| 发版类型 | A + W，面板 **patch → 0.41.1**；Agent 不变 |
| 红线 | 同 V4：`apps/web/src` 非测试文件不出现应用名、不按参数名分支、不发送 `instance`；抽屉内不弹 Dialog；secret 参数值不进 `queryKey` / `localStorage` / 日志 |

## 1. 要修的问题（真机证据 §五，已对照代码核实）

| # | 现象 | 根因 | 本批处置 |
|---|---|---|---|
| 1 | 抽屉「升级」报 `缺少参数 public_url` | ① `InstalledAppDrawer.tsx` `runUpgrade` 固定发 `values: {}`；② Worker `manifest-lifecycle.ts` 对 upgrade 也用 `mergeParamDefaults` 把**清单默认值**补进 `values` 再转发；③ Agent 安装记录不保存参数值（V5b 修）。结果：无默认值的参数必报缺失；有默认值但安装时改过的参数（如端口）升级后**被静默改回默认值** | §2 Worker 转发原值；§3.1 升级时可选修改参数 |
| 3 | 单元状态永远「未知」 | Agent 上报 `{name, scope, active: <bool>, state: "<is-active 文本>"}`，V3 开工说明 §7 示例误写成 `active: "active"`；前端 `parseUnits` 只认字符串，丢掉了布尔值 | §3.2 前端兼容实际形状（V3 文档示例已由设计任务改正） |
| 4 | magpie（v1 清单）显示 `v2` 徽标、出现 v2 动作、卸载走 `manifest_uninstall` | Agent 0.8.0 把 v1 归一后执行，记录一律写 `schema: 2`；抽屉按 `entry.schema` 判断 | §3.3 按 D1 清单的 schema 判断 |

## 2. Worker（`apps/api/src/lib/manifest-lifecycle.ts`）

1. **upgrade 转发原值**：`manifest_upgrade` 转发给 Agent 的 `actionParams.values` 改为请求里的**原始 `values`**（不合并清单默认值）。理由：默认值由 Agent 补（`_validate_values_both` 已有 `raw.get(key, spec.get("default"))`），0.8.0 节点行为不变；0.8.1 起 Agent 按「本次值 > 安装记录值 > 清单默认值」合并，Worker 预先塞默认值会盖掉安装记录值。
2. **hooks 渲染不变**：`preUpgrade` / `preUninstall` 的模板渲染仍用 `mergeParamDefaults(defV2, values)`（Worker 拿不到节点上的安装值）。install 的转发与渲染都不变。
3. **幂等重放**：`getHookReplay` 命中时转发的 `values` 与第 1 条一致（同一个变量，别一处改一处漏）。
4. **保存提醒**：`POST` / `PUT /app-manifests` 返回的 `warnings[]` 增加一条：`hooks.preUpgrade` 或 `hooks.preUninstall` 的 `url` / `headers` / `body` 引用了 `{{params.*}}` 时，提示「升级 / 卸载时控制面步骤只能拿到清单默认值和本次填写的值，拿不到安装时填的值」。实现放 Worker，**不改契约**。
5. 测试（`apps/api` vitest）：upgrade 请求 `values: {}` → 转发给 Agent 的 `values` 为 `{}`（不含默认值）；`values: {port: 9000}` → 原样转发；preUpgrade 模板里 `{{params.port}}` 渲染为默认值（未填时）/ 本次值（填了时）；install 行为快照不变；warning 正反各一。

## 3. 前端

### 3.1 升级时可选修改参数（`InstalledAppDrawer.tsx`）

- 行内升级确认（现有）里加一个折叠区「修改参数（可选）」，默认收起。
- 内容：按**新版本清单**的 `params` 通用渲染，每项默认「保持原值」，只提交用户实际改动的键：
  - string / integer / secret：空输入 = 保持原值；secret 用遮罩输入 + 显示切换（复用 V4 向导组件），占位文案「留空保持原值」；
  - enum：下拉首项「保持原值」；
  - boolean：三态下拉「保持原值 / 是 / 否」（不能用复选框，复选框表达不了「不改」）；
  - `derive` 参数也显示（标注「安装时自动推导，升级不会重新推导」），否则 0.8.0 安装的旧记录卡在缺失上无法自救。
- 校验复用 `validateManifestValues`，但**只校验用户填了的键**（未填不算缺失，缺失由 Agent 判定）。
- 提交：`manifest_upgrade` 的 `values` 只含改动键；不发 `instance`。
- 失败处理：任务失败且 `task.error.details.field` 是字符串时，自动展开折叠区、在对应字段上显示错误、确认按钮文案变为「补填后重试升级」。0.8.0 的 `缺少参数 X` 错误 `code` 是 `internal_error`，**只认 `details.field`，不要按 `code` 或 message 文本判断**。
- 一次性值场景（如应用要求每次升级换新票据）就是在这里填，不另开入口。

### 3.2 单元状态（`data/manifestApps.ts`、`InstalledAppDrawer.tsx`）

- `InstalledUnit` 改为 `{ name, scope, active?: boolean, state?: string }`；`parseUnits` 接受 `active` 为布尔；**兼容字符串**（`active: "active"` → `active: true, state: "active"`，防旧数据）。
- 显示：有 `state` 显示 `state`（active / inactive / failed / activating…），否则按 `active` 显示「运行中 / 未运行」，都没有才显示「未知」。色调：`active === true` → ok；`state === 'failed'` → danger；其余 neutral。
- `appStatus`：单元失败 = `active === false`；全部运行 = 每个单元 `active === true`。口径其余不变。
- `manifest_control` 返回体里的 `active` / `state` 只用于 toast 文案，列表仍以刷新后的 `/overview` 为准。

### 3.3 v1 条目显示（`InstalledAppDrawer.tsx`、`InstalledAppsCard.tsx`）

- 新增 `effectiveSchema = view?.schema ?? entry.schema`（`view` = D1 中同 `manifestId` 的清单视图）。徽标、`isV2`、卸载动作（`uninstallActionForSchema`）、启停 / 日志 / 升级按钮全部用 `effectiveSchema`，与 V4 §2-3 表一致：v1 清单 → `recipe_uninstall`，无启停 / 日志 / 升级。
- 找不到清单（已被删除）时退回 `entry.schema`。
- `docs/hosted-apps.md` §5 现有「v1 走 `recipe_uninstall`」的写法保持，与修复后行为一致。

## 4. 范围

| 允许改 | 不改 |
|---|---|
| `apps/api/src/lib/manifest-lifecycle.ts`、`apps/api/src/routes/` 中 app-manifests 保存提醒所在文件及其测试 | `packages/contracts`、`agent/` |
| `apps/web/src/apps/hosted-apps/*`、`apps/web/src/data/manifestApps.ts`、`apps/web/src/i18n/zh.ts` 及测试 | 向导安装流程（`InstallAndPublishDrawer.tsx`）除非复用组件需要抽取 |
| `docs/hosted-apps.md`、`docs/ui-redesign/page-specs.md`、CHANGELOG、`package.json` | `docs/plans/` |

## 5. 测试

1. `manifestApps.test.ts`：`parseUnits` 布尔 / 字符串 / 缺失三种；`appStatus` 用布尔形状覆盖四态；`effectiveSchema` 取值（有清单 / 无清单）。
2. `InstalledAppsCard.test.tsx`（或抽屉测试）：
   - 升级不展开参数 → 请求 `values: {}`；
   - 展开后只改一个 integer 和一个 secret → `values` 只含这两个键，secret 值不出现在任何 `queryKey`；
   - boolean「保持原值」不出现在 `values`；
   - 任务失败带 `details.field: 'public_url'` → 折叠区自动展开且该字段有错误提示；补填后重试请求含该键；
   - v1 清单（D1 schema 1）+ 记录 `schema: 2` 的条目：徽标 v1、卸载发 `recipe_uninstall`、无启停 / 升级按钮；
   - 单元 `active: false, state: 'failed'` 显示 failed 与 danger 色调。
3. Worker 测试见 §2-5。
4. 源码扫描测试继续通过；`./scripts/verify.sh` 全绿。

## 6. 坑

1. 0.8.0 节点在 V5b 之前仍然**不记得安装值**：本批修好后，无默认值参数升级仍会失败，但用户能在折叠区补填自救；有默认值且安装时改过的参数，0.8.0 上升级时用户必须在折叠区填回原值，否则会被默认值覆盖——在升级确认里加一行提示：「节点 Agent < 0.8.1 时不会记住安装参数；安装时改过的参数请在下面填回」（按 `state.agent.version` 判断，比较用现有版本比较工具，不要手写字符串比较）。
2. 不要把用户填的 secret 值放进组件外状态或 toast。
3. `details.field` 可能不在新版本清单的 params 里（参数被删了）：此时只显示错误原文，不展开不存在的字段。

## 7. 文档、版本、证据

- `docs/hosted-apps.md` §5 升级一条改写：升级时 Agent 按「本次值 > 安装值 > 默认值」合并（安装值需 Agent ≥ 0.8.1）；抽屉可选修改参数；控制面步骤只能拿到默认值与本次值。
- `docs/ui-redesign/page-specs.md`：已装应用抽屉升级确认加「修改参数（可选）」。
- CHANGELOG 0.41.1 `### Fixed` 三条；`package.json` 0.41.1。
- 证据（写入 `docs/verification/<日期>/manifest-upgrade-values.md`，可与 V5b 证据合并做）：`verify.sh` 输出；测试节点（0.8.0）上用 `ux-` 清单（含一个无默认值参数、一个改过默认值的端口参数）安装 → 不展开升级报缺失 → 折叠区自动展开 → 补填后升级成功、健康检查端口未变；magpie 抽屉显示 v1、卸载发 `recipe_uninstall`；单元区显示 `active`；截图：升级折叠区展开（浅色 / 深色 / 390 宽）。

## 8. 审核清单

- [ ] Worker upgrade 转发原始 `values`（含幂等重放分支）；hooks 渲染仍合并默认值；install 不变
- [ ] 保存提醒覆盖 preUpgrade / preUninstall 引用 `params.*`
- [ ] 升级折叠区：只提交改动键；boolean 三态；derive 可填；secret 遮罩、不进缓存键
- [ ] 失败按 `details.field` 自动展开；Agent < 0.8.1 提示
- [ ] 单元状态布尔兼容，四态口径正确
- [ ] v1 条目按 D1 schema 选徽标与动作
- [ ] 未改契约与 Agent；红线扫描通过；0.41.1；CHANGELOG；文档两处；证据
