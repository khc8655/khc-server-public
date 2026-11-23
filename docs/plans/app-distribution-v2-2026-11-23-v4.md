# V4 开工说明：前端通用化——声明驱动的安装、已装应用与应用管理

> 状态：已拍板 ｜ 最后核验：2026-11-23 ｜ 关联：`docs/plans/app-distribution-v2-2026-11-23.md` §5–§7、§11 V4；`docs/verification/2026-11-23/manifest-v2-live.md`

> **给开发 agent**：开工前提：V1–V3 已合入（#151、#154、#152）。先读 `AGENTS.md`、提案、`docs/ui-redesign/ui-guidelines.md`、`docs/ui-redesign/page-specs.md` 与本文全文。本批只改前端与文档，**不改 Worker、契约、Agent**。认为本文有误时在 PR 里提出，不要改 `docs/plans/` 下的文件。

## 0. 速览

| 项 | 值 |
|---|---|
| 分支 | `feat/manifest-v2-web`（从最新 `main` 拉，用独立 worktree） |
| PR 标题 | `feat(web): 应用清单 v2 前端通用化（声明式表单、多端点发布、已装应用生命周期、凭据）` |
| 发版类型 | W（面板逻辑 + UI），面板 **minor**；Agent 不变 |
| 红线 | `apps/web/src` 非测试文件不出现任何应用名，也不出现按参数名判断的逻辑（如 `public_url`）；不新增色板、字号、导航层级；抽屉内不弹 Dialog |

## 1. 现状（2026-11-23 `main` 核实）

| 位置 | 问题 |
|---|---|
| `apps/caddy/InstallAndPublishDrawer.tsx:195-201` | 按参数名 `public_url` 推导发布地址 |
| `apps/caddy/InstallAndPublishDrawer.tsx:806` | 用 `/^https?:\/\//` 在 `access` 里找登录链接 |
| `apps/caddy/InstallAndPublishDrawer.tsx:97`、`InstalledAppsCard.tsx:40` | 各自调 `recipe_installed`，与 `/overview` 里已有的 `app-catalog` 状态重复 |
| `apps/hosted-apps/InstalledAppsCard.tsx:136` | 按安装记录的**键字符串**匹配清单（`magpie/default ≠ magpie`），非默认实例时卸载按钮被禁用（真机证据 §五-1） |
| `apps/hosted-apps/recipes.ts` `toCatalogRecipe` | 把 v2 硬转回 v1 形状：enum 退化为 string、只保留第一个端点 |
| `apps/hosted-apps/AppInstallPanel.tsx` | 已无任何页面引用（只有测试） |
| 全部安装 / 卸载 | 只用 `recipe_install` / `recipe_uninstall`；没有升级、启停、日志、凭据入口 |

## 2. 约定（本批写死，V5 / V6 依赖）

1. **实例**：每个节点每个应用只有一个实例，**前端从不发送 `instance`**；默认实例名 = `manifestId`（Worker 与 Agent 已按此实现）。多实例界面不在本批范围。真机证据 §五-1、§五-3 都是测试时手工传了 `instance: "default"` 造成的，按本约定不会出现。
2. **已装条目定位**：一律用条目里的 `manifestId` 与 `instance` 字段，**不解析键字符串**。
3. **动作选择**：

| 清单 | 安装 | 卸载 | 升级 / 启停 / 日志 |
|---|---|---|---|
| v1（无 `schema`） | `recipe_install` | `recipe_uninstall` | 不提供 |
| v2 | `manifest_install` | `manifest_uninstall` | `manifest_upgrade` / `manifest_control` / `manifest_logs` |

v1 走旧路径，是为了在 0.7.x 节点上继续可用（Worker 对 v1 + `recipe_*` 不做预检）。

4. **能力判断**：节点能力读 `/overview` 回填的 `state.agent.capabilities.appManifest`。v2 清单所需能力 = `requiredAgentFeatures(toManifestV2(def))`（从 `@khc/contracts` 导入，不要自己再写一份）；节点 `schemas` 不含 2 或缺能力时，该应用在向导里置灰，提示「需将节点 Agent 升级到 ≥ `MANIFEST_V2_MIN_AGENT`」，并附「去升级」链接到节点设置 Agent 卡。
5. **已装列表数据源**：读 `stateQuery.data.state.adapters` 中 `name === 'app-catalog'` 的 `status.installedDetail`，不再单独调 `recipe_installed`（沿用 relay-latency B2「工作区单一入口」）。`status` 带 `stale` 时显示「状态可能不是最新」并给手动刷新；为 `{error, pending}` 时显示「状态读取中」。写操作成功后统一 `refreshHubRuntime`。

## 3. 设计

### 3.1 数据层（新增 `apps/web/src/data/manifestApps.ts`，替代 `hosted-apps/recipes.ts` 的 v1 回转）

- `toAppView(item: AppManifest)` → `{id, schema: 1|2, def: AppManifestDefinitionV2, enabled, invalid, error, dynamicScript, requiredFeatures}`。`def` 一律经 `toManifestV2`；`dynamicScript = sources.some(s => !s.pinned)`。
- `installedEntries(state)` → `InstalledApp[]`：`{manifestId, instance, version, schema, units[], lastHealth, facts, endpoints, installedAt, upgradedAt, source}`；`source !== 'manifest'` 的旧 recipe 条目只读展示，不给任何动作（V5 删除）。
- `appStatus(entry)`：`lastHealth.ok === true` 且单元都 active → 运行中（ok）；有失败 → 异常（danger）；无健康也无单元 → 已安装（neutral）；状态过期或读取中 → 未读取（neutral）。口径与 `page-specs.md` 应用状态一致。
- `canUpgrade(view, entry)`：`schema === 2` 且 `entry.version !== view.def.version`，且节点具备 `upgrade` 能力。
- `normalizeResultCards(schema, cards)`：v2 按 `kind` / `primary` 渲染；**v1 兼容**：卡片没有 `kind` 且值以 `http://` 或 `https://` 开头时视为 `kind: 'url'`。这是唯一允许的启发式，函数注释写明「v1 兼容，v1 下线时删除」（ADR-0023 §决策 5）。删除 `taskAccess` 与 `access` 字段读取，改读 `task.result.cards`。
- `manifestErrorView(ApiError)`：把 Worker 的结构化错误映射成可操作提示：

| code | 展示 |
|---|---|
| `agent_upgrade_required` | 缺失能力列表 + 「去升级 Agent」 |
| `preflight_failed` | `details.checks` 逐条列出（`message`），失败项标 danger |
| `secret_not_configured` / `secret_host_not_allowed` | 凭据名 + 「去配置凭据」（跳到设置 → 应用管理 → 该应用抽屉的凭据区） |
| `hook_failed` / `hook_extract_failed` | 阶段 + 第三方状态码 + `details.error`（已截断） |
| `insecure_channel_secret` | 「该节点为明文接入，不能安装带控制面步骤的应用；改为域名或 Tunnel 接入」 |
| `manifest_invalid` / `not_installed` / `health_failed` | 原文 + 健康失败时展示 `details.logs`（单元日志尾部） |

### 3.2 安装并发布向导（`InstallAndPublishDrawer.tsx`）

保持三步结构（选应用 → 配置与发布 → 安装并发布），改为声明驱动：

1. **第 1 步**：列表来自 `toAppView`；`invalid` 的条目不可选；v2 能力不足的置灰（§2-4）；`dynamicScript` 的条目显示「动态脚本」徽标与 `sources` 主机。
2. **第 2 步参数表单**（通用渲染，不认识任何参数名）：
   - `string` / `integer` / `boolean` 沿用现有控件；`enum` 用现有下拉控件，选项 `label`，选项带 `requires` 时在旁边标出「需 ≥ N MB 内存」；
   - `secret: true` → 密码输入 + 显隐切换（沿用「账号」Token 的做法），不进 URL、不写日志、不进 react-query 缓存键；
   - 带 `derive: "endpoint:<id>.publicUrl"` 的参数**不显示**，提交前由该端点的发布计划推导；该端点未选择发布时传空串。
3. **第 2 步发布区**：列出全部端点。
   - `publish: 'caddy'`：可勾选是否发布，默认只勾第一个；每个勾选的端点有自己的对外端口（默认值沿用现有避冲突逻辑），共享同一域名与 TLS 选择；所选端口之间、与 Agent 端口、与本机监听端口均不得冲突（复用现有校验）。
   - `publish: 'direct'`：不建 Caddy 站点，复用 `HostFirewallPortAlert` 的「一键放行」。
   - `publish: 'none'`：只展示，不发布。
   - `bind: 'any'` 且未选 `direct`：info 提示「应用监听所有地址；端口 N 若不打算直接对外，请确认主机防火墙未放行」，若 `fw.show` 显示已放行则改为 warning（不阻断）。
   - 端点 `auth.hint` 显示在端点下方。
4. **第 3 步执行**：按 §2-3 选择动作，参数 `{manifestId, values, runtimeMode?, runtimeUser?, runtimePassword?}`；任务完成后按勾选顺序逐个 `publishProxySite`（沿用现有失败回滚）；失败按 §3.1 错误表展示。
5. **完成页**：渲染 `normalizeResultCards`；`primary` 的 url 卡作为主按钮；每个已发布端点列出 `https://<域名>:<端口><path>`（有 `paths` 时逐条列出）；`secret` 卡默认掩码，可显隐与复制。

### 3.3 已装应用（替换 `InstalledAppsCard.tsx`，位置不变）

- 列表行：名称（清单 `name`，找不到清单时用 `manifestId`）| 版本（可升级时显示「→ 新版本」）| 状态（§3.1 `appStatus`）| 「详情」。整行点击打开**已装应用抽屉**；页面同一时刻只有一个抽屉（沿用 `SiteDrawer` 的页面级抽屉做法，不新增详情入口）。
- 抽屉内容：
  - 概要：版本、安装 / 升级时间、运行身份、健康（`lastHealth`：时间、版本、错误）、`facts`（只展示，标题「安装信息」）、端点列表；
  - 单元：每个单元一行，`active` 状态 + [启动] [停止] [重启]（v2 才有；停止用行内确认）；`lingerDisabled` 时提示「该用户未开启 linger，退出登录后服务会停」；
  - 日志：选择单元 → 按需读取 `manifest_logs`（`lines: 200`，`staleTime: 0`，只在展开时请求），用 `ui/log.tsx` 展示，顶部提示「日志可能包含应用自己打印的敏感信息」；`truncated` 时标明；
  - [升级]（`canUpgrade` 时）：行内确认，确认文案列出新旧版本与「将执行控制面步骤 preUpgrade」（清单声明时）；
  - [卸载]：行内确认（L2）。v2 卸载返回 `hook_failed` / `hook_extract_failed` 时，在原位置出现第二个确认：「跳过控制面步骤强制卸载（第三方资源需人工清理）」，确认后以 `skipHooks: true` 重试。
- 动作成功后 `refreshHubRuntime`；任务轮询沿用现有实现。

### 3.4 设置 → 应用管理（`AppManifests.tsx`）

- 表格「应用」列附徽标：`v2`、`动态脚本`、`格式异常`（已有）。
- 编辑抽屉在 JSON 文本域下方新增三个**只读 / 轻量**区块（已保存的清单才显示）：
  1. **凭据**：调 `GET /app-manifests/:id/secrets`；每项显示 `label`、`hint`、是否已配置、`allowHosts`、更新时间。[设置] / [替换] → 行内表单：值（密码输入）+ 允许主机（逗号分隔，默认填入引用该凭据的 hook 主机）→ `PUT /api/v1/settings/app.<id>.<name>`，值 `{value, allowHosts}`；[删除] → 行内确认 → `DELETE /api/v1/settings/:key`。值永不回显。
  2. **控制面步骤**：每个阶段一行「阶段 · 方法 · 主机」，不显示路径、请求头与请求体。
  3. **外部来源**：`sources` 列表，`pinned: false` 标「动态」。
- 保存响应带 `warnings[]` 时，在抽屉顶部以 warning 展示，不阻断。

### 3.5 删除

- `apps/hosted-apps/AppInstallPanel.tsx` 及其测试（无引用）。
- `recipes.ts` 中被 `manifestApps.ts` 取代的函数；保留仍被引用的纯函数（如 `certMatchesDomain`、`validateValues`）并迁移到新文件或保留原处，PR 说明去向。

## 4. 范围

允许：`apps/web/src/**`、`docs/ui-redesign/page-specs.md`、`docs/ui-redesign/ui-guidelines.md`（仅 §8.6 术语表）、`docs/hosted-apps.md`、`package.json`、`CHANGELOG.md`。禁止：`apps/api/`、`packages/contracts/`、`agent/`、`migrations/`。

## 5. 测试

1. `manifestApps.ts` 单测：v1 / v2 归一化；`dynamicScript`；`installedEntries` 按字段定位（含 `instance ≠ manifestId` 的条目）；`appStatus` 四种状态；`canUpgrade`；`normalizeResultCards` 的 v2 与 v1 兼容分支；`manifestErrorView` 覆盖 §3.1 表中每个 code。
2. 向导：enum 渲染与提交值；secret 掩码且不出现在 DOM 文本中；derive 参数不显示且按端点发布计划提交；多端点勾选与端口冲突校验；`bind: any` 提示；能力不足置灰；v1 用 `recipe_install`、v2 用 `manifest_install`；`preflight_failed` 逐条展示。
3. 已装应用：数据来自 `/overview` state，**不请求 `recipe_installed`**；非默认实例条目可卸载；升级 / 启停 / 日志各发出正确动作与参数；卸载 `hook_failed` → 强制卸载带 `skipHooks: true`；v1 条目无升级 / 启停按钮。
4. 应用管理：凭据列表不出现 value；设置凭据请求体为 `{value, allowHosts}`；`warnings[]` 展示。
5. 源码扫描（参照 relay-latency B2 第 9 项）：`apps/web/src` 非测试文件不含 `magpie`、`khcsearch`、`public_url`、`'recipe_installed'`。
6. 现有 smoke 测试只改夹具不删断言；改断言须在 PR 逐条说明。

## 6. 坑

1. `toManifestV2` 对坏清单会抛错：只对 `invalid !== true` 的条目调用。
2. `app-catalog` 的 `status` 受 B4 截止时间约束，可能是 `stale` 或 `{error, pending}`，两种都要有界面。
3. 凭据输入框不要放进任何 `queryKey`，也不要写进 `localStorage`。
4. 多端点发布是顺序执行的多次 `publishProxySite`：某一个失败时只回滚它自己，已成功的保留，并在完成页如实列出。
5. 不在抽屉里弹 Dialog：所有确认用行内确认。

## 7. 文档、版本、证据

- `page-specs.md`：节点「应用」页「已装应用」与抽屉、向导第 2 步发布区、设置「应用管理」抽屉三区块。
- `ui-guidelines.md` §8.6：新增术语「控制面步骤」「应用凭据」「动态脚本」「端点」。
- `docs/hosted-apps.md`：改写 §2–§5 为 v2 口径（字段、动作、凭据、实例约定、v1 兼容），≤400 行。
- 面板 minor；CHANGELOG 一行。
- 证据：`./scripts/verify.sh` 全绿；在已升级到 0.8.0 的测试节点上用 `ux-` 测试清单（带 enum、secret、两个端点、user unit、http 健康、preInstall hook）走完 安装 → 发布两个端点 → 重启 → 日志 → 升级 → 卸载（含一次 hook 失败后强制卸载）；magpie（v1）安装、卸载回归；浅色 / 深色 / 390 宽截图：向导第 2 步、已装应用抽屉、应用管理抽屉；四态说明。

## 8. 审核清单

- [ ] 改动只在允许范围；源码扫描无应用名、无 `public_url`、无 `recipe_installed`
- [ ] 不发送 `instance`；已装条目按字段定位
- [ ] v1 / v2 动作选择与 §2-3 表一致；能力判断用契约的 `requiredAgentFeatures`
- [ ] 已装列表读 `/overview` state；stale / pending 有界面
- [ ] 参数表单通用渲染（enum、secret、derive）；多端点发布与冲突校验
- [ ] 结果卡片只有一处 v1 兼容启发式，注释写明下线条件
- [ ] 错误码映射覆盖 §3.1 表；强制卸载走 `skipHooks`
- [ ] 凭据值不回显、不进缓存键；保存 `warnings[]` 有展示
- [ ] 文档三处；CHANGELOG；面板 minor；截图与四态
