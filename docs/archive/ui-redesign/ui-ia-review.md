# 面板功能梳理与 UI 信息架构诊断（ui-ia-review）

> 状态：**已归档（历史记录，非现行规范）** ｜ 适用范围：仅用于追溯 2026-11-02 的 IA 审查与方案取舍，不得作为开发依据 ｜ 最后核验：2026-11-05 ｜ 归档日期：2026-11-05
> 取代者：[ui-guidelines.md](../../ui-redesign/ui-guidelines.md)（页面类型 §1–§7、交互细则 §8、布局/字阶/组件 §8.9–§8.11、响应式 §8.13）+ [page-specs.md](../../ui-redesign/page-specs.md)（路由与区块映射）；设计取值 → [tokens.css](../../../apps/web/src/styles/tokens.css)
> 关联：`docs/archive/README.md`、`docs/README.md` §2
> 日期：2026-11-02 · 范围：以仓库实际代码为准（前端 `apps/web/src`、后端 `apps/api/src/routes`、契约 `packages/contracts`、Agent `agent/`、D1 `migrations/`）。
> 性质：审查与方案文档，不改动任何现有源码。配套视觉示意：`docs/archive/ui-redesign/index.html`（**已归档历史示意，非权威**）。
> 现行约束：交互、布局、组件、四态、响应式与文案一律以 `ui-guidelines.md` 与 `page-specs.md` 为准；文中"抽屉内确认""三抽屉"等旧表述已废止（抽屉内禁止叠加 Dialog，危险动作先关闭抽屉再走页面级 ConfirmAction）。

---

## 1. 功能清单（以代码为准）

### 1.1 全局层

| 模块 | 功能 | 入口/路由 | 主要代码 | 使用者 | 频率 |
|---|---|---|---|---|---|
| 认证 | 单用户（固定 admin）登录/登出、session cookie、`GET /auth/me` | `/login` | `apps/api/src/routes/auth.ts`、`pages/LoginPage.tsx` | 管理员 | 低 |
| 全局概览 | 4 项集群指标（节点在线、Peer、站点+转发数、证书数）、"需要处理"分诊条（离线节点+临期证书）、节点矩阵卡（状态/模式/端点/路由/CPU/内存/负载 + 4 个跳转按钮） | `/` | `pages/OverviewPage.tsx` | 管理员 | 高（每次进面板第一眼） |
| 节点管理 | 节点表格（名称/状态/接入地址/路由/最近在线）、创建节点抽屉（名称/endpoint/tunnel/liveEndpoint → token + 安装命令）、删除节点 | `/hubs` | `pages/HubsPage.tsx`、`apps/api/src/routes/nodes.ts` | 管理员 | 低（加机器才用） |
| 全局证书库 | 证书表格（名称/域名/签发方/到期/来源）、签发（ACME）或导入抽屉、导出材料、删除 | `/settings?tab=certs`（嵌入）；另有独立路由 `/certs` | `apps/certificates/page.tsx`、`apps/api/src/routes/certs.ts`、`migrations/0002_c3.sql` | 管理员 | 中低 |
| 系统变量与凭据 | key/JSON value 的加密配置项表（DNS API 凭据等） | `/settings?tab=system` | `pages/SettingsPage.tsx`、`apps/api/src/routes/settings.ts` | 管理员 | 低 |
| 命令面板 | ⌘K：跳节点、跳概览/设置、创建节点、签发证书 | 全局 | `app/AppShell.tsx`、`ui/command.tsx` | 管理员 | 中 |
| 组件样例页 | 开发用 gallery | `/dev/gallery` | `dev/gallery/GalleryPage.tsx` | 开发者 | 不面向用户 |

### 1.2 节点层（/hubs/:id）

| 模块 | 功能 | 入口/路由 | 主要代码 | 频率 |
|---|---|---|---|---|
| 节点概况 | 4 Stat（连接/Caddy 发布/证书/运维）、"应用发布与证书"卡（站点前 5 条+证书+扩展应用摘要）、"运行信息"卡、Peer 组网区（Peer/转发/Peer 运维 3 卡）或未启用卡、最近操作、模式切换抽屉入口 | `/hubs/:id` | `pages/HubOverviewPage.tsx`（490 行） | 高 |
| Caddy 站点 | 站点表格；站点抽屉（8 个分组：基本/反代/静态/重定向/TLS/安全/日志/观测）；Caddy 服务抽屉（状态/reload/校验/导出）；站点 JSON 导入导出；清空站点 | `/hubs/:id/sites` | `apps/caddy/page.tsx`（2291 行） | 高（核心用途） |
| 扩展应用 | 外部应用表格（名称/版本/状态/配置版本/更新时间）+ 内置应用链接卡 | `/hubs/:id/apps` | `pages/HubAppsPage.tsx` | 低（当前仅 node-exporter 一个外部适配器） |
| 应用详情 | Tabs：配置（SchemaForm+SaveBar）/变更 diff/任务/历史（rev 回滚）；动作：保存/plan/apply/install/uninstall | `/hubs/:id/apps/:app` | `pages/AppPage.tsx` | 低 |
| WireGuard Peer | Peer 表格（名称/地址/状态/握手）；Peer 抽屉（新建/编辑，编辑含 Tabs）；接口设置抽屉；导出配置对话框（二维码/.conf）；无损换钥抽屉 | `/hubs/:id/wireguard` | `apps/wireguard/page.tsx`（1601 行） | 中 |
| 端口转发 | 转发表格（名称/监听/目标/协议/状态/备注）+ 编辑抽屉 + apply | `/hubs/:id/forwards` | `apps/forward/page.tsx`（918 行） | 中 |
| Peer 主机运维 | Peer 列表（数据同源自 WG 配置）；行点击抽屉 = PeerOpsPanel（对 Peer 的进程/防火墙/SSH 公钥 + 状态摘要） | `/hubs/:id/peers` | `pages/PeersPage.tsx`、`apps/host-ops/PeerOpsPanel.tsx` | 低 |
| 主机运维（Hub 本机） | 实时通道状态卡、OpsSummary（CPU/内存/磁盘/服务 + 负载/swap/监听端口/DNS/路由/进程/uptime/需重启）、诊断卡、三个操作抽屉（进程/防火墙/SSH 公钥） | `/hubs/:id/ops` | `pages/HubOpsPage.tsx`、`apps/host-ops/*`、`apps/diagnostics/*` | 中 |
| 节点设置 | 节点模式卡（组网 Hub ⇄ 纯 Caddy 网关切换）、Agent 卡（安装/升级/卸载命令）、实时观测 endpoint 卡、SSL 证书摘要卡、备份导出卡、备份导入卡、导入结果卡 | `/hubs/:id/settings` | `apps/node-settings/page.tsx`（460 行） | 低 |
| 节点级证书 | CertificatesPage 按节点过滤 | `/hubs/:id/certs` | `apps/certificates/page.tsx` | 低（无导航入口） |
| 备份/恢复 | 导出节点配置 JSON、导入（预览→确认→结果） | 节点设置页内 | `apps/api/src/routes/backup.ts` | 低 |
| Agent 生命周期 | `/agent/releases`、install/upgrade/uninstall 命令生成、拉取式自升级 | 节点设置页 AgentCard | `apps/api/src/routes/agent_lifecycle.ts` | 低 |
| 诊断 | 只读诊断（连接+Agent 7 个核心码 + 应用来源补充）、知识库 hints | `/hubs/:id/ops` 内 DiagnosticsCard | `apps/api/src/routes/diagnostics.ts`、`apps/api/src/lib/diagnostics/*` | 中（排障时） |
| 审计 | 节点最近操作列表 | 节点概况页内 | `apps/api/src/routes/nodes.ts`（`/nodes/:id/audit`）、`apps/audit/RecentOperations.tsx` | 低 |
| 实时观测 | liveEndpoint + 浏览器直连快照（SSE/live），控制面快照兜底 | 外壳 HubChannelsProvider | `apps/api/src/routes/live.ts`、`app/HubChannelsProvider.tsx` | （基础设施） |
| 节点模式 | wg（组网 Hub）/ caddy（纯网关）编排与预检 | 节点设置 ModeCard + ModeSwitchDrawer | `apps/api/src/routes/mode.ts`、`apps/api/src/lib/mode.ts`、`docs/dual-mode.md` | 很低（一年几次） |

### 1.3 后端能力与数据模型（支撑层）

- **API 路由**（`apps/api/src/routes/`）：`auth`（login/logout/me）、`nodes`（CRUD + state + audit）、`apps`（列表/保存配置/动作转发 plan/apply/rollback/install/uninstall）、`certs`、`settings`、`backup`（export/import）、`diagnostics`、`agent_lifecycle`、`mode`、`live`。
- **D1 表**：`nodes`、`app_configs`、`revisions`、`audit`（0001）+ `certificates`、`settings`（0002）+ live_endpoint / last_apply_error 等增量（0003–0005）。
- **Agent 适配器**（`agent/adapters/`）：`wireguard`、`caddy_site`、`port_forward`、`certificates`、`host_ops`、`node_exporter`；内核 `agent/khc/`（plan/apply/rollback/备份/原子替换/写锁）与具体应用无关。
- **权限**：单用户、无多角色；所有写操作进 audit。

---

## 2. 现状诊断（按严重程度排序）

### P0 — 结构性问题

1. **导航层级过深，分组名抽象**。节点层实际是 3 层：左侧栏节点列表 → HubBar 一级分组（概况/应用发布/内网穿透/服务器运维）→ 胶囊二级页（7 个子页）。用户要记"端口转发在内网穿透下、备份在服务器运维→节点设置与证书下"这类抽象映射，找不到东西。见 `app/AppShell.tsx:111-213`。
2. **同一功能多处入口、多份展示**：
   - Peer 列表同时是 `/wireguard`（管理）和 `/peers`（运维）两个页面的主体，数据源都是 WG 配置 peers；
   - 证书出现在 4 处：`/certs`（无导航入口的暗路由）、`/settings?tab=certs`、`/hubs/:id/certs`（无入口）、节点设置页"SSL 证书与 HTTPS 配置"摘要卡；
   - 概况页重复展示站点列表、Peer 列表、转发列表、负载数据（与各专页重复）。
3. **"节点设置"成为杂项堆砌页**：模式切换 + Agent 命令 + liveEndpoint + 证书摘要 + 备份导出 + 备份导入 + 导入结果，7 个纵向卡片混在一起，备份这类低频但关键的功能埋在页面底部。见 `apps/node-settings/page.tsx:224-458`。
4. **Caddy 站点页单文件 2291 行、抽屉 8 分组**。新建站点要面对基本/反代/静态/重定向/TLS/安全/日志/观测全部铺开，主次不分；低频的"清空站点/导入导出 JSON/服务管理"与高频的"加站点"并列在页头。见 `apps/caddy/page.tsx:1150-1241, 1580-2093`。

### P1 — 入口与可达性

5. **暗路由**：`/certs`（全局）与 `/hubs/:id/certs` 在侧栏和 HubBar 都没有入口（`registry/routes.ts:124-145` 的 globalNav/hubNav 与 `AppShell` 实际渲染的全局 2 项不一致），只能靠命令面板或页面内链接到达。
6. **节点列表 `/hubs` 无一级导航**：全局侧栏只有"概览/设置"，要管理节点（删除、重装命令）必须先进概览再点"管理节点"。
7. **扩展应用占了一级分组的一半**：`/apps` + `/apps/:app` 有完整的 plan/apply/diff/任务/历史体系，但当前外部适配器只有 `node-exporter` 一个（`apps/node-exporter/page.tsx` 仅 4 行 meta），低频功能占据了与"Caddy 站点"平级的一级入口。

### P2 — 命名与一致性

8. **术语不统一**：
   - 同一个页面：`zh.nav.wireguard` = "WireGuard"，分组里叫"Peer 客户端"，概况卡里叫"Peer 管理"；
   - `zh.nav.ops` = "运维"，分组叫"服务器运维"，子项叫"主机监控与运维"；
   - "应用发布"（分组）vs "Caddy 站点"/"扩展应用"（子项）vs "站点"（页头 `zh.nav.sites`）；
   - "节点设置与证书"（子项）vs "节点设置"（页头 `zh.nav.hubSettings`）。
   - 中英混排无规则：WireGuard / Caddy / Peer / Hub 并存。
9. **概况页页头放操作按钮**（"服务器运维""发布站点"），违反 ui-spec T1"不放创建按钮、只负责看和分诊"的模板定位（`docs/ui/ui-spec.md:76-79`），也把运维和推广链接混进第一眼。

---

## 3. 新信息架构方案

### 3.1 总原则

- **两层不变**：全局层 + 节点层（ui-spec §1.1 不变）。
- **节点层压平**：取消 HubBar 二级胶囊，一级导航直接就是页面；4 组 8 页 → 5 页。
- **合并同源页面、降级低频页面、删除暗路由**；能用单页+分段/折叠解决的，不加导航层级。
- **每个页面第一眼 = 状态与待办；操作入口在页头右侧唯一主操作**（沿用 ui-spec T1/T2/T4 模板）。

### 3.2 导航骨架

**全局侧栏（3 项 + 节点直达列表）**

```
概览          /            （矩阵 + 需要处理，保持现状）
节点          /hubs        （恢复一级入口；创建/删除/安装命令）
设置          /settings    （证书库 + 系统变量凭据，保持现状分段）
─────────────────────────
节点（直达）   sg-1 · tyo-1 · hk-1
```

- 删除独立路由 `/certs`（功能已由 `/settings?tab=certs` 完整覆盖；命令面板入口保留）。

**节点层一级导航（5 项，无二级）**

```
概况        /hubs/:id           T1：4 指标 + 需要处理 + 运行信息 + 最近操作
站点        /hubs/:id/sites     T2：站点表为主；页内分段 [站点 | 扩展应用 | 证书]
内网穿透    /hubs/:id/wireguard T2：Peer 表（含行内"运维"抽屉）+ 端口转发卡 + 接口设置入口
主机运维    /hubs/:id/ops       重做交互模型：状态带 + 对象表（服务/进程/防火墙/SSH）+ 统一抽屉（§4）
节点设置    /hubs/:id/settings  T4：Agent 与接入 / 节点模式 / 备份与恢复 / 危险区
```

### 3.3 合并、降级、去除明细

| 现状 | 处置 | 理由 |
|---|---|---|
| `/hubs/:id/peers`（Peer 主机运维页） | **合并**进内网穿透页：Peer 表格行内"运维"按钮直接开 PeerOpsPanel 抽屉 | 与 `/wireguard` 数据源同源（WG peers），两个列表页看同一份数据 |
| `/hubs/:id/forwards`（端口转发页） | **合并**进内网穿透页：Peer 表下方的"端口转发"卡（表格+添加按钮） | 转发目标就是 Peer，强关联；转发数量通常个位数，不配占一页 |
| `/hubs/:id/apps`（扩展应用页） | **降级**为站点页内分段"扩展应用"；`/apps/:app` 详情页保留不动 | 当前仅 node-exporter 一个外部适配器，不配占一级入口的一半 |
| `/hubs/:id/certs`（节点级证书） | **降级**为站点页内分段"证书"（只读摘要 + 跳全局证书库） | 证书的创建/管理是全局功能，节点侧只需知道"绑了哪张" |
| `/certs`（全局独立路由） | **去除**（保留 `/settings?tab=certs`） | 暗路由；两个入口做同一件事 |
| 节点设置页 7 卡纵列 | **重组**为 T4 分区：Agent 与接入（版本/命令/liveEndpoint）· 节点模式 · 备份与恢复 · 危险区（删除节点移入） | 按任务分组；备份不再埋在页面底部 |
| 概况页"应用发布与证书"卡、Peer 区 3 卡 | **精简**：去掉与各专页重复的明细列表，保留 4 指标 + 需要处理 + 运行信息 + 最近操作 | 概况页只回答"正常吗、要处理什么"，明细去专页看 |
| 站点抽屉 8 分组 | **折叠**：基本/反代（或静态/重定向按类型显示其一）/TLS 默认展开；安全/日志/观测收进"高级"折叠区 | 80% 的站点只需域名+上游+TLS |
| 站点页头的清空/导入导出/服务管理 | **折叠**进表格工具栏"高级"或页面底部 | 低频操作不占首屏 |

### 3.4 每个面板第一眼看到什么

| 页面 | 第一眼（首屏上三分之一） | 主操作位置 |
|---|---|---|
| 全局概览 | "需要处理"分诊条（有问题时）+ 节点矩阵 | 页头无创建按钮（保持 S2） |
| 节点概况 | 连接/站点数/Peer 在线/负载 4 指标 + 需要处理 | 无创建按钮；各卡片只放"去管理 →"链接 |
| 站点 | 站点表格（域名/类型/上游/TLS/状态） | 页头右侧唯一主操作"添加站点" |
| 内网穿透 | Peer 表格（名称/地址/状态/握手 + 行内导出/运维） | 页头"添加 Peer"；接口设置收进页头次操作 |
| 主机运维 | 状态带（Agent/CPU/内存/磁盘/服务，异常才变色） | 对象表行内操作 + 统一抽屉（§4） |
| 节点设置 | 分区导航 + 当前分区表单 | 保存条在分区底部（T4 模板） |

### 3.5 关键任务路径对比

| 任务 | 现状路径 | 新路径 | 点击数（约） |
|---|---|---|---|
| 发布一个站点 | 侧栏节点 → 概况 → 应用发布 →（站点子页）→ 添加站点 → 抽屉 8 分组 → 保存并生效 | 侧栏节点 → 站点 → 添加站点 → 抽屉（3 组展开）→ 保存并生效 | 7 → 5 |
| 给手机加 Peer 并拿到配置 | 节点 → 内网穿透 → Peer 客户端 → 添加 Peer → 保存 → 列表点行 → 导出 | 节点 → 内网穿透 → 添加 Peer → 抽屉保存后同屏显示二维码/.conf | 7 → 4 |
| 对 Peer 做主机运维 | 节点 → 内网穿透 → Peer 主机运维 → 点行 → 抽屉 | 节点 → 内网穿透 → 行内"运维"→ 抽屉 | 5 → 4 |
| 加一条端口转发 | 节点 → 内网穿透 → 端口转发 → 添加转发 | 节点 → 内网穿透 →（同页）添加转发 | 4 → 3 |
| 导出节点备份 | 节点 → 服务器运维 → 节点设置与证书 → 滚动到底 → 导出 | 节点 → 节点设置 → 备份与恢复分区 → 导出 | 5 → 4 |
| 签发/查看证书 | 设置 → SSL 证书库 tab（或 ⌘K） | 不变（删除暗路由 `/certs` 后入口唯一） | 2 → 2 |
| 排查节点连不上 | 节点 → 服务器运维 → 主机监控与运维 → 诊断卡 | 节点 → 主机运维 → 状态带红色"离线" → 诊断抽屉 | 4 → 3 |

### 3.6 术语与命名统一表

> 本节已于 2026-11-05 迁入 [ui-guidelines.md](../../ui-redesign/ui-guidelines.md) §8.6（唯一权威表）；下表保留为历史对照，新增/修改文案以 §8.6 为准。

| 统一后（UI 文案） | 替换的现状叫法 | 说明 |
|---|---|---|
| 站点 | 应用发布 / Caddy 站点 | 英文保留 "Sites"；代码标识 `caddy-site` 不动 |
| 扩展应用 | 应用 / apps | 仅指适配器安装的应用；页面标题"扩展应用" |
| 内网穿透 | Peer 客户端 / Peer 组网 / WireGuard 页 | 页面名"内网穿透"；WireGuard 只出现在"接口设置"等技术语境 |
| Peer | Peer 客户端 / Peer 主机 / 客户端 | 对象名统一为 Peer |
| 主机运维 | 服务器运维 / 主机监控与运维 / 运维 | 节点层第 4 项 |
| 节点设置 | 节点设置与证书 | 证书摘要不属于设置页标题 |
| 证书库 | SSL 证书库 / 域名证书 / 域名与证书 | 全局设置下的分区名 |
| 节点 | Hub / 节点 | UI 一律"节点"；代码标识 hubId 不动 |
| 保存并生效 | 保存并应用 / 应用 | 按钮统一"保存并生效"（`zh.common.saveAndApply` 已有） |

### 3.7 现状字段 → 新位置映射（节选）

| 现状位置 | 内容 | 新位置 |
|---|---|---|
| 概况页"应用发布与证书"卡站点列表 | 站点前 5 条 | 删除（去站点页看）；概况只留站点数指标 |
| 概况页 Peer 区 3 卡 | Peer/转发/Peer 运维摘要 | 删除；概况只留"Peer 在线 x/y"指标 |
| `/hubs/:id/peers` 整页 | Peer 列表 + PeerOpsPanel | 内网穿透页 Peer 表 + 行内"运维"抽屉 |
| `/hubs/:id/forwards` 整页 | 转发表格 + 抽屉 | 内网穿透页"端口转发"卡 |
| `/hubs/:id/apps` 整页 | 扩展应用表格 | 站点页"扩展应用"分段 |
| `/hubs/:id/certs` 整页 | 节点证书过滤视图 | 站点页"证书"分段（只读摘要） |
| `/certs` 路由 | 全局证书库 | 删除；用 `/settings?tab=certs` |
| 节点设置页"SSL 证书与 HTTPS 配置"卡 | 证书摘要 | 移到站点页"证书"分段 |
| 节点设置页 ModeCard / AgentCard / liveEndpoint 卡 | 模式/Agent/观测 | 节点设置页分区：节点模式 / Agent 与接入 |
| 节点设置页备份导出/导入/结果卡 | 备份 | 节点设置页"备份与恢复"分区 |
| HubsPage 删除节点 | 行内删除 | 保留 + 节点设置"危险区"也放一份（S11 级联文案） |

### 3.8 与既有规范的关系

- 不冲突：两层作用域、S1–S12、T1–T5 模板、动作注册表机制全部保留。
- 需要同步修订：`docs/ui/ui-spec.md` §1.3 路由总表（删 `/certs`、`/hubs/:id/peers`、`/hubs/:id/forwards`、`/hubs/:id/certs`，或标注为合并后别名）、`registry/routes.ts` 的 hubNav/globalNav。
- 落地前必须按 AGENTS.md 红线 3 提交 UI 变更单（`docs/ui-changes/` 下一个编号）获批后再动代码。

---

## 附：主要证据文件

- 路由与外壳：`apps/web/src/app/router.tsx`、`apps/web/src/app/AppShell.tsx`、`apps/web/src/registry/routes.ts`、`apps/web/src/registry/actions.ts`
- 全局页：`apps/web/src/pages/OverviewPage.tsx`、`HubsPage.tsx`、`SettingsPage.tsx`
- 节点页：`apps/web/src/pages/HubOverviewPage.tsx`、`HubAppsPage.tsx`、`AppPage.tsx`、`PeersPage.tsx`、`HubOpsPage.tsx`
- 应用页：`apps/web/src/apps/caddy/page.tsx`（2291 行）、`apps/wireguard/page.tsx`（1601 行）、`apps/forward/page.tsx`、`apps/certificates/page.tsx`、`apps/node-settings/page.tsx`、`apps/host-ops/*`、`apps/diagnostics/*`
- 后端：`apps/api/src/routes/*.ts`、`migrations/0001-0005`、`agent/adapters/*`
- 文档：`docs/ui/ui-spec.md`、`docs/ui/DECISIONS.md`、`docs/legacy-feature-inventory.md`、`docs/dual-mode.md`、`docs/design-v3.md`

---

## 4. 主机运维页交互设计（2026-11-02 增补，针对"三套体系"吐槽的重做）

### 4.1 现状为什么是"三套体系"（以代码为准）

当前 `/hubs/:id/ops`（[HubOpsPage.tsx](../../../apps/web/src/pages/HubOpsPage.tsx)）自上而下堆了 4 个载体、3 套交互：

| 区块 | 载体 | 操作方式 | 问题 |
|---|---|---|---|
| 实时通道卡 | KeyValue（控制/观测通道/能力/端点/更新时间） | 只读 | 纯基础设施信息占首屏第一卡 |
| 主机状态（OpsSummary） | 4 Stat + 8 项 KeyValue 混排（负载/swap/监听端口/DNS/路由/进程/uptime/需重启） | 只读，不可点 | "进程"一栏是 `caddy 2.1% · khc-agent 0.3%` 拼成的字符串，看不出谁异常，也不能点进去 |
| 诊断卡（DiagnosticsCard） | Badge 汇总 + Banner + 问题表格 | 行点击开 DiagnosticsDrawer | 与上面两块并排，但没有回答"我该先修哪个" |
| 运维操作（HostOpsActions） | 3 个并排按钮 | 各开一套完全不同的抽屉 | 进程=只读表格+**抽屉里再弹 Dialog**；防火墙=编辑表格+apply/confirm 两段式；SSH 公钥=表格+添加抽屉+删除确认 |

即：只读展示两套（Stat/KeyValue + 诊断表），操作入口又是一套（三按钮三抽屉），用户不知道"看"和"做"的边界在哪。关键事实（来自 [khc_host.py](../../../agent/adapters/host_ops/khc_host.py#L95-L105)）：host-ops 白名单动词只有 `status / snapshot / version / fw.show / fw.apply / fw.confirm / keys.list / keys.add / keys.remove`——**没有重启服务**（现状只能在面板里看着 failed 的服务然后自己去 SSH）；进程 kill 已明确移除（[ProcessDrawer.tsx](../../../apps/web/src/apps/host-ops/ProcessDrawer.tsx#L29-L32)）。

### 4.2 单一交互模型：状态带 + 对象表 + 抽屉

整页只有 3 层元素，一套范式贯穿：

```
① 状态带（一条横条，不是 4 张卡）  → 回答"现在正常吗"（异常才变色，可点击下钻）
② 一张对象表（Segmented 切换 服务/进程/防火墙/SSH 公钥）→ 回答"具体是谁"
③ 一个右侧抽屉（全页唯一）        → 所有详情、日志、确认、表单都在这里
```

**交互规则（全页统一）：**
- **看详情** = 点击表格行 → 右侧抽屉（标题=对象名+节点上下文 / 状态徽章 / KeyValue 详情 / 输出 CodeBlock）。禁止抽屉里再弹 Dialog（现状进程详情的二级 Dialog 取消）。
- **做操作** = 行内可见按钮（每行至多 1 个主操作 + 1 个危险操作，其余进 `⋯` 菜单）或抽屉底部按钮；危险动作需关闭抽屉后由页面级 ConfirmAction 确认，禁止在抽屉内叠加窗口；结果在原抽屉反馈。
- **创建入口** = 每个对象分组表头右侧唯一一个 [+ 添加]（仅防火墙/SSH 公钥有；服务、进程不可创建）。
- **危险等级**：L1 普通（刷新/添加公钥）→ 直接执行；L2 危险（重启服务/删除规则/删除公钥）→ 关闭抽屉后页面级 ConfirmAction；L3（删除节点/卸载应用）→ 输入对象名解锁；防火墙整体生效走既有的 `fw.apply` → 60 秒内 `fw.confirm` 否则自动回滚（防锁死），这一机制保留并整合进表格下方的待生效横幅，不改变统一模型。
- **探查型内容**（诊断、服务日志、进程完整命令行）一律在抽屉内出现，不在页面上与状态数据并排。诊断从"页面并列卡片"降级为状态带右侧的入口：全部通过时不显示，有未通过项时显示 `诊断 · N 项未通过 →`，点开是带"影响/建议"的抽屉（沿用现有 hints 知识库）。

### 4.3 首屏状态清单（状态带，按主次排序）

| 状态 | 数据来源 | 正常 | 异常呈现 | 点击行为 |
|---|---|---|---|---|
| Agent 连接 | `state.route` / `channels.control` | 绿 · 在线 · 直连/隧道 + 版本 | 红 · 离线 + 最后在线时间 | 无（诊断入口在右侧） |
| CPU | `ops.cpu.usagePercent` + load1/5/15 | 灰字百分比 | ≥90% 红 | 切到进程分组（按 CPU 排序） |
| 内存 | `ops.mem.percent` | 灰数值 | ≥90% 红 | 切到进程分组（按内存排序） |
| 磁盘 | `ops.disks[0]` | 灰数值 | ≥85% 琥珀 | 无 |
| 服务 | `ops.services` | 绿 · "N 个正常" | 有 failed 单元 → 红 · "N 个失败" | 切到服务分组 |
| 需重启 | `ops.rebootRequired` | "无需重启"并入运行时长 | 琥珀"需重启" | 无 |
| 诊断 | `GET /nodes/:id/diagnostics` | 不显示入口 | 状态带右侧红链接 | 开诊断抽屉 |

次要信息（swap、监听端口数、DNS、默认路由、控制/观测通道细节）不再占首屏，收进诊断抽屉或节点设置页"运行信息"。

### 4.4 操作清单（全部统一入口）

| 操作 | 入口 | 确认 | 后端现状 |
|---|---|---|---|
| 查看进程详情 | 行点击 → 抽屉 | 无 | `snapshot`（只读，kill 已移除，不提供） |
| 重启服务 | 行内 [重启] → 抽屉内 L2 确认 | L2 | **需新增** `svc.restart` 白名单 verb（限定 caddy/wg-quick@wg0/khc-agent/khc-fw 等受管单元），现状面板做不到 |
| 添加防火墙规则 | 分组表头 [+ 添加规则] → 抽屉表单 | 应用时两段确认 | `fw.apply` + `fw.confirm`（沿用） |
| 删除防火墙规则 | 行内 [删除] | 随应用生效 | 同上 |
| 应用防火墙更改 | 表格下方待生效横幅 [应用更改] → 60 秒确认窗 | L2+倒计时 | 沿用现有机制 |
| 添加 / 删除 SSH 公钥 | 表头 [+ 添加] / 行内 [删除] | L1 / L2 | `keys.add` / `keys.remove` |
| 运行诊断 / 看修复指引 | 状态带诊断入口 → 抽屉 | 无 | `diagnostics`（只读，沿用） |

### 4.5 四态

- **加载**：状态带骨架条 + 表格 3 行骨架。
- **空**：进程不存在空态；防火墙空 = "还没有 khc 管理的规则（SSH/WG/8880 默认保留）"+ [添加规则]；SSH 公钥空 = "还没有托管公钥" + [添加公钥]。
- **异常（动词报错）**：表格上方 InlineError（错误码 + 原因 + [重试]），已加载数据保留（沿用 HostOpsErrorBanner 规则）。
- **Agent 离线**：状态带整体置灰、Agent 格变红"离线 · 最后在线 xx"；对象表上方横幅"以下为缓存状态，操作不可用"并给出下一步（诊断抽屉里有连接排查步骤；节点设置里有重装命令）；所有行内操作禁用。诊断在离线时仍可跑控制面侧的连接类检查，因此诊断入口离线时保留。

### 4.6 关键任务路径对比

| 任务 | 现状 | 新模型 | 步数 |
|---|---|---|---|
| CPU 异常定位到进程 | ops 页 → 在 KeyValue 里读"进程"字符串（无排序、不可点）→ 点"进程"按钮开抽屉 → 表格 → 行点击 → **再弹 Dialog** 看命令行 | 状态带 CPU 变红 → 点一下 → 落到按 CPU 排序的进程表（第一名即元凶）→ 行点击抽屉看完整命令 | 5 → 3，且载体从 3 种变 1 种 |
| 重启一个服务 | **面板做不到**：OpsSummary 只读，白名单无 restart verb，只能自己 SSH | 服务分组 → 行内 [重启] → 抽屉确认 | 不可用 → 2（前置：adapter 加 `svc.restart`） |
| 防火墙变更 | ops 页 → 点"防火墙"按钮 → 抽屉里添加/删除 → 应用 → 60 秒内确认 | Segmented 切防火墙 → 同页添加/删除 → 待生效横幅 [应用更改] → 60 秒确认 | 5 → 4，且不再切换上下文 |
| Agent 离线排查 | 通道卡看状态 → 诊断卡显示离线 Banner → 诊断本身跑不了 → 发散到节点设置找命令 | 状态带直接红"离线 · 最后在线 xx" → 诊断入口（控制面侧检查仍可跑）→ 抽屉给排查步骤 + 去节点设置重装 | 发散 → 2-3 步一条线 |

### 4.7 待新增能力（如实标注）

- `svc.restart` 白名单 verb：host_ops 目前无服务重启能力，需新增（限定受管单元列表，沿用 khc-host 白名单模式与 systemd-run 执行）。
- 服务日志查看（`journalctl -u <unit>` 只读 tail）：用于服务详情抽屉的 CodeBlock，可加 `svc.logs` 只读 verb。
- 其余 UI 变化（状态带、Segmented 合并、Dialog 取消、诊断入口降级）均为前端重组，不动后端。

---

## 5. 实施计划（按改造顺序）

> 原则：先收敛导航与路由（用户立刻有感），再逐页替换；每步独立成 PR，均先交 UI 变更单。除步骤 6 外全部为纯前端改动。

### 步骤 1 · 导航与路由收敛

- **做什么**：全局侧栏补"节点"入口；节点层 HubBar 去掉二级胶囊，一级直接 5 页（概况/站点/内网穿透/主机运维/节点设置）；删除暗路由 `/certs`、`/hubs/:id/certs`、`/hubs/:id/peers`、`/hubs/:id/forwards`、`/hubs/:id/apps`（先 302 到合并后的锚点/分段，或直接删）；统一 i18n 术语表。
- **主要文件**：`app/AppShell.tsx`、`registry/routes.ts`、`registry/actions.ts`、`i18n/zh.ts`（术语表 §3.6）。
- **复用**：现有 Sidebar / HubBar / Tabs 组件，仅改配置。
- **需新增**：无。
- **触碰后端**：无。

### 步骤 2 · 全局层三页

- **做什么**：概览页精简（去页头按钮、矩阵卡只留"进入节点"）；节点列表页恢复一级入口、删除节点操作移出；设置页维持分段，删除证书改 L2 抽屉确认；系统变量空态。
- **主要文件**：`pages/OverviewPage.tsx`、`pages/HubsPage.tsx`、`pages/SettingsPage.tsx`、`apps/certificates/page.tsx`。
- **复用**：Stat / Table / Drawer / EmptyState / ConfirmDialog 全部现成。
- **需新增**：无。
- **触碰后端**：无。

### 步骤 3 · 节点概况页精简

- **做什么**：删除"应用发布与证书"明细卡与 Peer 区 3 卡；加"需要处理"卡（数据来源：诊断 + 证书到期 + Peer 停用，均为现有 selector）；模式切换入口移到节点设置。
- **主要文件**：`pages/HubOverviewPage.tsx`。
- **复用**：Stat / KeyValue / RecentOperations。
- **需新增**：`TodoChips` 小组件（约 40 行，纯样式）。
- **触碰后端**：无。

### 步骤 4 · 内网穿透合并页

- **做什么**：`/wireguard` 改名"内网穿透"；转发表格与抽屉从 `apps/forward/page.tsx` 搬入为页内卡；Peer 行内加"运维"按钮开 PeerOpsPanel 抽屉（内容从 `pages/PeersPage.tsx` 搬入）；Peer 抽屉新建成功后同屏显示二维码（现状导出对话框逻辑并入）。
- **主要文件**：`apps/wireguard/page.tsx`（重组为壳）+ 新 `apps/wireguard/ForwardsCard.tsx`；`apps/host-ops/PeerOpsPanel.tsx` 改为抽屉内 Tabs。
- **复用**：wireguard/forward 的表格与抽屉代码原样搬移，PeerOpsPanel 不动内部逻辑。
- **需新增**：抽屉内 Tabs（复用现有 Tabs 组件即可，无新组件）。
- **触碰后端**：无。

### 步骤 5 · 站点页重组

- **做什么**：页内 Segmented [站点 | 扩展应用 | 证书]；站点抽屉 8 分组折叠为 3 展开 + 高级；清空/导入导出收进高级折叠；扩展应用表从 `pages/HubAppsPage.tsx` 搬入；证书分段只读摘要。
- **主要文件**：`apps/caddy/page.tsx`（2291 行拆分：抽屉分组组件化）、`pages/HubAppsPage.tsx`（表搬入后删除该页）。
- **复用**：Segmented / Table / Drawer / Badge。
- **需新增**：抽屉内 `AdvancedSection` 折叠（`<details>` 封装，约 20 行）。
- **触碰后端**：无。

### 步骤 6 · 主机运维页重做 ⚠️ 触碰后端

- **做什么**：按 §4 模型重写 `pages/HubOpsPage.tsx`（状态带 + Segmented 对象表 + 唯一抽屉；诊断降级为状态带入口；取消进程详情二级 Dialog）。
- **主要文件**：`pages/HubOpsPage.tsx`、`apps/host-ops/*`（面板组件重组）、`apps/diagnostics/DiagnosticsCard.tsx` → 抽屉化。
- **需新增**：`StatusBar` 组件（约 80 行，纯 CSS 横条 + 阈值着色）。
- **触碰后端（需单独确认）**：
  - `agent/adapters/host_ops/khc_host.py` 新增 `svc.restart` 白名单 verb（限定受管单元）；
  - 可选新增 `svc.logs` 只读 verb（journalctl tail，供服务详情抽屉）；
  - 两者都需走 adapter 测试（`agent/tests/test_host_ops.py`）与真机验证，属核心冻结例外条款内的适配器改动，但要单独拍板。

### 步骤 7 · 节点设置分区化

- **做什么**：7 卡纵列 → 4 分区（Agent 与接入 / 节点模式 / 备份与恢复 / 危险区）；备份导入三步改抽屉内流程；删除节点从 `/hubs` 移入危险区（L3 输入名称确认）。
- **主要文件**：`apps/node-settings/page.tsx`（460 行重组）、`pages/HubsPage.tsx`（删行内删除）。
- **复用**：Segmented / KeyValue / Drawer / CodeBlock / CopyButton。
- **需新增**：L3 确认抽屉（输入名称解锁按钮，约 30 行，可复用 ConfirmDialog 扩展）。
- **触碰后端**：无。

### 步骤 8 · 应用详情页微调

- **做什么**：AppPage 维持 4 Tab 结构，仅统一按钮文案（保存并生效）、危险操作改抽屉内 L2 确认、页头加状态徽标。
- **主要文件**：`pages/AppPage.tsx`。
- **复用**：全部现成。
- **触碰后端**：无。

### 汇总

| 步骤 | 范围 | 新组件 | 后端改动 |
|---|---|---|---|
| 1 导航收敛 | AppShell/registry/i18n | 无 | 无 |
| 2 全局三页 | Overview/Hubs/Settings | 无 | 无 |
| 3 节点概况 | HubOverviewPage | TodoChips | 无 |
| 4 内网穿透 | wireguard/forward/peers 合并 | 无 | 无 |
| 5 站点页 | caddy 页重组 + apps 搬入 | AdvancedSection | 无 |
| 6 主机运维 | HubOpsPage 重做 | StatusBar | **svc.restart / svc.logs（需确认）** |
| 7 节点设置 | node-settings 分区化 | L3 确认抽屉 | 无 |
| 8 应用详情 | AppPage 微调 | 无 | 无 |

每步验收：`./scripts/verify.sh` 全绿 + UI 变更单 + 浅/深/390 截图（AGENTS.md 红线 3、7）。
