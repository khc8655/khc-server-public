# plan: 线上实测缺陷修复与产品瘦身（T1–T4）

> 状态：已拍板 ｜ 最后核验：2026-11-22 ｜ 关联：docs/ui-redesign/page-specs.md、docs/hosted-apps.md、docs/cf-dns.md

## 1. 背景

基于 2026-11-21 至 2026-11-22 对生产站点（`v0.28.0`）的三路独立浏览器真机全链路实测（设置/流程 1、应用安装发布/流程 2、双轨证书/全站审计），发现 mock 门禁虽绿，但真机仍存在 2 处 P0 阻断缺陷、多处 P1 红线违规/反馈断裂，以及与「**服务器运维遥控器 + 配置仓库，一个月大约只打开 10 次**」定位冲突的重度设计：

1. **P0-1 向导装完丢失卸载入口**：通过「安装并发布应用」成功安装 `magpie` 后，Agent `recipe_installed` 返回 `{}`，前端「已安装的托管应用」显示空且第 1 步无已安装角标，界面无卸载入口；另向导第 2 步强制要求输入 `nologin` 应用账号密码。
2. **P0-2 控制面 CF DNS-01 签发 100% 失败（`NXDOMAIN`）**：`acme-dns01.ts` 创建 `_acme-challenge` TXT 后仅固定 `sleep(1500)` 即请求校验，实测 3/3 均在 ~6s 报 `NXDOMAIN`；另全局导入 PEM 跳过 `notAfter` 解析，到期显示「未设置」。
3. **P1 交互红线与页面反馈**：3 处违反「抽屉内不弹 Dialog」（编辑站点、证书详情删除、添加节点添加域名）；向导第 2 步缺失与 Agent 端口冲突校验且默认预填节点域名与 `443`；添加节点在手填与已有记录切换间状态串台、错误藏于禁用按钮 `title`、自动发布 HTTPS 未防 `上游端口 = 发布端口/Agent 端口`；站点保存失败报错被抽屉遮挡且脏草稿入 D1；确认弹窗滞留不关；390px 移动端 `/settings`、证书详情与账号卡溢出坍塌；深色模式主按钮视觉呈灰调；「系统变量」暴露 `cf_dns_accounts` 并可误删。
4. **产品过重项**：面向月用 10 次的遥控器，建议砍掉冗余入口与企业级反代细项，收敛主链路。

## 2. 方案与减法清单

### 2.1 P0/P1 核心修复

- **Agent 清单状态统一**：`run_manifest("install")` 在元数据文件记录 `installedAt` / `manifestId` / `instance` / `version`，`action_recipe_installed` 与 `status` 合并返回 `app-manifests` 与旧 `recipes` 安装记录，卸载后移除；`mode="create"` 下新建 `nologin` 应用账号允许省略 `runtime_password`（跳过 `chpasswd` 保持锁定）。
- **控制面 DNS-01 传播轮询与 PEM 解析**：`doh.ts` 支持 TXT 记录及双公共 DoH（Cloudflare + Google）查询，`acme-dns01.ts` 写入 TXT 后短间隔轮询生效并留稳定缓冲再触发校验，`NXDOMAIN` 失败附加可操作中文指引；`POST /certs` 导入未显式传 `notAfter` 时解析叶证书 `notAfter`。
- **交互规范与移动端/深色收敛**：全站消除抽屉内弹 Dialog（改行内确认或先关抽屉/页内跳转）；统一字段下方内联报错；修复 390px 横向溢出与深色主题主按钮视觉对比度；端口冲突拦截 `publishPort === nodeAgentPort` 与 `upstreamPort === publishPort/agentPort`。

### 2.2 产品瘦身清单

| 位置 | 保留 | 砍掉 / 合并 |
|---|---|---|
| 设置首页 | 6 分段：账号、域名管理、证书库、隧道、应用管理、SSH 公钥 | **砍掉「系统变量」Tab**（避免暴露与误删 `cf_dns_accounts`）；Token 改密码框；单 Zone 加凭据直接关闭；删除「查看域名」假跳转与独立「添加域名」弹窗（Zone 启用全归「账号 → 编辑凭据」） |
| 证书库 | 「面板签发（CF DNS-01）」「导入」「自签」；自动同步乐观开关与列表状态 | **砍掉「节点 ACME」分栏**与手工凭据键引用；移除 0 证书时外层重复按钮与孤立搜索框；DoH 检出改语义色标签 |
| 应用向导与站点 | 安装并发布 3 步向导（无系统用户密码、`public_url` 自动推导、关闭 TLS 选项、带 `?k=` 直达登录按钮）；精简版站点抽屉 | **砍掉**系统用户必填密码、`Caddy 发布后的对外地址`、`站点名称（可选）`、负载均衡、健康检查、仅 TLS 1.3、最大请求体、日志路径、页底导入导出 JSON、抽屉重复删除按钮、默认占位外部块（`—`）与自反代 `caddy` 监听端口建议 |
| 概览与节点设置 | 首页单行状态摘要 +「需要处理」+ Hub 卡片；节点设置 3 分段 | **砍掉**首页 4 张大 KPI 卡、左下角 `控制面已连接`、节点设置独立「节点模式」Tab（并入「网络」开关）、`到期日期`卡片、Install 命令「启用 Agent 自签 HTTPS（Worker 不信任）」陷阱复选框、HostOps 重复「新增任务」按钮；对齐 WG 横幅与诊断待生效提示 |

## 3. 范围与不做

- **不做**：不新增 D1 迁移文件（保留 `expires_at` 等既有列以维持接口兼容）；不改变「IP 直连 / 域名 HTTPS / CF Tunnel」三种节点接入模式及协议兼容；不修改 Caddy 运行时协议。

## 4. 分批计划

| 批次 | 范围 | 验收标准 | 必测项 | 版本 Bump |
|---|---|---|---|---|
| **T1** | Agent `recipe_installed` + 免密码系统用户；API DoH TXT 传播轮询 + 全局导入解析 `notAfter` | 安装 manifest 后 `recipe_installed` 与 `status` 立即可见且可卸载；`acme-dns01` 轮询 DoH 可见后再触发校验；导入 PEM 自动写入 `notAfter` | Agent `test_app_manifests` / `test_app_catalog`、API `acme-dns01` / `certs` 单测、`verify.sh` | Agent `0.6.4 → 0.6.5`；面板 `0.28.0 → 0.29.0` |
| **T2** | 设置（砍系统变量/假跳转/加域弹窗）、证书（砍节点 ACME/乐观开关/行内删）、添加节点（状态不串台/内联报错/全端口拦截/回跳） | 无抽屉内 Dialog；Token 掩码；`manage` 删除不关抽屉仅刷当前 Zone；添加节点切换来源与端口冲突拦截完备 | Settings / Certs / Hubs / AccessForm 单测与冒烟、`verify.sh` | 面板 minor（`0.29.0 → 0.30.0`），Agent 不动 |
| **T3** | 向导（去密码/自动 `public_url`/防撞 `nodeAgentPort`/直达登录）与站点抽屉/列表大瘦身 | 无密码可装、默认避开 Agent 端口、`nodeAgentPort` 强校验、编辑失败不滞留弹窗不掩盖报错、加载骨架与过滤占位块 | `InstallAndPublishDrawer` / `SiteDrawer` / `caddy.smoke`、`verify.sh` | 面板 minor（`0.30.0 → 0.31.0`），Agent 不动 |
| **T4** | 390px/深色 CSS 修复、首页 KPI 收敛、节点模式并入网络、砍到期/自签陷阱、WG/诊断对齐 | 390px 零横向溢出、深色主按钮高对比、无「节点模式」Tab 与陷阱复选框、诊断标明具体待生效模块 | Overview / Shell / Mode / HubSettings / Diagnostics 单测、`verify.sh` | 面板 minor（`0.31.0 → 0.32.0`），Agent 不动 |

## 5. 已拍板结论

- 主人已确认「全部开始」：按 **T1 → T2 → T3 → T4** 逐批开发合入 `main`，全部上线后升级测试 Hub `aws-hui-us` Agent 至 `0.6.5` 并在生产站点复测两个 P0 闭环与核心 UX。
