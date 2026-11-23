# plan: VM 接入重构、面板统一证书与节点增删改查闭环

> 状态：已实施 ｜ 最后核验：2026-11-23 ｜ 关联：docs/design-v3.md、docs/cf-dns.md、docs/runbook/node-onboarding.md

## 1. 背景与问题清单

近期真机接入排查暴露出四类结构性断点，导致新建 VM、证书下发与节点增删改查难以走通：

1. **添加 VM 流程臃肿且混入无关动作**：`AccessForm.tsx` 与 `HubsPage.tsx` 在「添加节点」抽屉内混入「安装完成后自动发布 HTTPS / 发布端口 / 上游端口」及「+ 新建解析记录」临时表单，新机既无应用可发，又把域名解析前置动作塞进节点创建弹窗，引入三组端口概念并生成空壳站点。
2. **域名解析与证书签发脱节、强绑节点端 `acme.sh`**：在「设置 → 域名管理」建完解析后没有顺手签发证书；`apps/api/src/lib/agent-commands.ts`（L70–86）生成安装命令时无视面板证书库，硬编码下发 `--acme <域名>`；`agent/install.sh`（L579）执行 `curl -fsSL https://get.acme.sh ... >/dev/null 2>&1` 无超时且吞输出，境内机卡死无提示。
3. **证书绑定与续期链路断层**：`apps/api/src/routes/certs.ts` 的 `findCertUsages` 仅按 `sourceNodeId` 与 Caddy `$cert` 查找关联节点，缺少 `nodes.tls_cert_id` 显式关联，泛域名证书多节点复用无法同步续期；`InstallAndPublishDrawer.tsx` 与 `siteForm.ts` 默认 `tlsMode='auto'`，未优先复用面板证书库已有证书。
4. **节点增删改查（CRUD）割裂**：
   - **改**：`AccessCard.tsx` 修改接入参数后直接关闭抽屉，不生成重装命令也不引导验活；
   - **查/重装**：`AgentCommandDrawer.tsx` 仍暴露包 URL/sha256、需手动点生成、`withCaddy` 默认 `false`、无探活；`HubSettingsPage`（`apps/web/src/apps/node-settings/page.tsx`）与 `AgentCommandDrawer.tsx` 的 `hubQuery` 均设 `enabled: false` 导致刷新后数据空洞；`HubOverviewPage.tsx` 对未上线节点缺少安装引导；
   - **删**：`HubsPage.tsx` 打开删除确认框时 `setDeleteDns(true)` 默认勾选删 DNS，违背「默认保留可复用解析记录」规范。

## 2. 方案对比与推荐

### 2.1 VM 首次安装如何导入面板证书（零 `acme.sh`）

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. 内联 PEM 写进安装命令 | 在安装命令里直接拼接证书和私钥文本 | 无需回连面板拉取 | 私钥进入剪贴板与 shell 命令文本，违背密钥不进命令约定 |
| **B. 节点 HMAC 鉴权引导拉取（推荐）** | 复用用户刚粘贴到 `/etc/khc-agent/token` 的节点 token 对 `GET /api/v1/nodes/:id/bootstrap/tls` 做 HMAC 签名，`install.sh` 用 Python 拉取并 `0600` 落盘 | 私钥零进剪贴板、零 `acme.sh`、零 GitHub 依赖、零入站 80/443、不新增 D1 表 | 需要安装机能出站访问面板 HTTPS（与下载 `agent.tgz` 同源） |
| C. 临时一次性下载 token | 创建节点时生成短期 token 存入 D1 后拉取 | 不依赖节点主 token | 需新增临时表与过期清理逻辑，与现有 HMAC 体系重复 |

**选定方案 B**：签发动作前置收口到「设置 → 域名管理（新建解析顺手签发）与证书库」；引导接口复用节点 HMAC 校验（`±60s` 防重放 + 限流 + `Cache-Control: no-store` + 审计），安装脚本内用标准库 Python 计算签名拉取证书并原子写入 `/etc/khc-agent/tls/{fullchain.pem,key.pem}`。

### 2.2 证书到期续期与自动同步机制

遵循 `AGENTS.md` §1「不做 Cron」原则，不引入 Cloudflare Cron Trigger 或后台常驻轮询：

- **统一签发与默认 `autoSync`**：由面板控制面走 Cloudflare DNS-01 签发和续期（不依赖节点入站 80/443），入库默认开启 `autoSync`。
- **全量同步目标**：`findCertUsages` 合并三类使用方——① `node.tlsCertId === cert.id`（调用 `POST /apps/certificates/install_tls` 热重载 Agent）；② `cert.sourceNodeId`；③ 引用 `$cert` 的 Caddy 站点配置（自动重新 `apply` 并下发 `.crt/.key` 到 `khc-certs/`）。
- **双触发路径**：① 证书库与首页/节点待办芯片提供手动一键「续期并同步」；② 登录打开面板完成探活时，若发现 `cf-dns01` 且 `autoSync=true` 的证书剩余有效期 `≤ 15` 天，前端异步触发 `POST /api/v1/certs/:id/renew`（会话级去重，平时零流量）。

## 3. 范围与不做

| 范围 | 内容 |
|---|---|
| **做** | 1. 「设置 → 域名管理」(`CfDnsAccounts.tsx`) 新建 A/AAAA 记录时默认顺手签发 Cloudflare DNS-01 证书（支持选单域名或 `*.<主域名>`，已被现有泛域名覆盖则提示免签；已有无证记录提供一键补签；签发失败不回滚已建解析）；<br>2. 彻底简化 `AccessForm.tsx` / `HubsPage.tsx`：移除「自动发布 HTTPS / 发布端口 / 上游端口」（含 `publishPlan`/`publishHttps`）和「+ 新建解析记录」临时表单（`quickCreateOpen`），仅保留「选已有解析 / 手动输入域名」+「管理域名记录」跳转 +「刷新记录」；<br>3. 新增 `nodes.tls_cert_id`（迁移 `0016`）与证书 409 引用删除保护；域名模式自动匹配并选用面板证书（精确或泛域名），未匹配时提示跳「域名管理 / 证书库」；<br>4. 安装命令默认带 `--with-caddy` 与 `--tls-bootstrap-url`，`agent/install.sh` 实现零 `acme.sh` 导入；`--acme` 仅作无面板证书时的手工兜底并补齐 `curl` 超时与明确报错；<br>5. 抽取共享 `NodeInstallPanel` 统一建节点、改接入重装、`AgentCard` 重装与探活；修复 `hubQuery` 刷新空洞、`deleteDns` 默认值与未上线概览引导；<br>6. 发布应用与新建站点默认优先选中匹配面板证书（`manual + $cert`），落地 ≤15 天按需自动续期。 |
| **不做** | 1. 不引入 Cron Trigger 或后台定时任务；<br>2. 不删除 IP 直连与 Cloudflare Tunnel 两种接入方式；<br>3. 不删除手工 `--acme` 参数（保留作兜底）；<br>4. 不在节点设置页增加第二处删除节点入口（保持 `/hubs` 行内 L3 删除）。 |

## 4. 目标增删改查（CRUD）闭环设计

- **前置（域名与证书）**：在「设置 → 域名管理」为 VM 新建 A/AAAA 解析时，默认勾选顺手签发 CF DNS-01 证书并启用 `autoSync`；若同一主域已有有效泛域名证书则自动识别覆盖、无需重复签发。
- **增（添加 VM）**：填名称 + 选接入方式；选「域名（HTTPS）」时选择已有解析（或手动域名）并自动匹配选中面板证书库证书（支持切换其他匹配证书；无匹配证书时提示去域名管理/证书库准备）→ 创建后同一抽屉内展示一次性 token 与安装命令（默认 `--with-caddy` + `--tls-bootstrap-url`，无发布端口/上游端口）→ 执行完点「我已完成安装」，自动验证 Agent 在线与 Caddy 就绪，直接进入应用发布。
- **查（概览与设置）**：修复 `HubSettingsPage` 与 `AgentCommandDrawer` 的 `hubQuery` 在刷新直达时为 `undefined` 的问题（允许按需拉取）；`HubOverviewPage` 对未上线节点展示「安装并上线」直达引导；节点概况与证书库双向显示绑定证书与到期天数。
- **改（修改接入/更换证书）**：`AccessCard` 支持变更绑定的面板证书。**仅换证书且节点在线**时保存后直接调用 `cert.bind` 热重载生效；**离线或修改了接入方式/域名/端口**时保存后留在同抽屉切换到 `NodeInstallPanel`，直接生成最新重装命令与探活按钮。`AgentCard` 的「安装 Agent」复用同一面板（默认 `withCaddy=true`、隐藏包 URL/sha 高级项）。
- **删（删除节点/证书）**：`HubsPage` 删除确认框修正 `deleteDns` 默认为 `false`（保留全局解析记录可复用），删除前照常生成卸载脚本。删除证书库记录前检查是否仍被节点 `tlsCertId` 或 Caddy `$cert` 引用，命中则返回 409 提示先解绑。

## 5. 批次拆解（遵循 `release.md` §2.1「先面板，后 Agent」）

| 批次 | 改动范围 | 验收标准 | 必测项 | bump |
|---|---|---|---|---|
| **B1：控制面契约、证书引导与全量同步** | `migrations/0016_node_tls_cert.sql`；`packages/contracts/src/index.ts`；`apps/api/src/{app,db/d1/nodes,domain/repos,lib/agent-commands,lib/node-overview,routes/nodes,routes/certs,routes/agent_lifecycle}.ts` | `nodes.tls_cert_id` 可读写；`GET /nodes/:id/bootstrap/tls` HMAC 鉴权返回加密库中对应 PEM 且 `no-store`、带限流与审计；`issue-dns01` 默认 `autoSync=true`；`agent-commands.ts` 有 `tlsCertId` 时下发 `--tls-bootstrap-url`；`findCertUsages`/`sync` 覆盖 `tlsCertId`；被引用证书删除返回 409 | 契约/路由单测（引导 200/401/404/限流、泛域名同步、409 删证拦截、`agent-commands` 新模板）、`./scripts/verify.sh` | 面板 minor |
| **B2：Agent 安装脚本导入与 ACME 超时修复** | `agent/install.sh`、`agent/khc/util.py`、`agent/tests/` | `--tls-bootstrap-url` 用刚写入的 token 按 `METHOD\|path\|ts\|nonce\|sha256` 签名拉取证书并 0600 落盘，零 `acme.sh` 启动成功；`--check` 预检更新；`--acme` 兜底 `curl` 带 `--connect-timeout 15 --max-time 60` 且失败打印明确报错 | `python3 -m unittest discover -s agent/tests -t agent`、`install.sh --check` 与 `bootstrap/tls` 端到端单测、包复现校验 | Agent minor（联动文档/清单时面板 patch） |
| **B3：前端域名顺手签证、极简 VM 接入与 CRUD 闭环** | `CfDnsAccounts.tsx`、`AccessForm.tsx`、`HubsPage.tsx`、`AccessCard.tsx`、`AgentCard.tsx`、`AgentCommandDrawer.tsx`（含 `NodeInstallPanel`）、`node-settings/page.tsx`、`HubOverviewPage.tsx`、`zh.ts` 及 `page-specs.md` / `node-onboarding.md` / `cf-dns.md` / `design-v3.md` | 域名管理新建解析可顺手签发证书（已覆盖则免签、无证支持补签）；添 VM 抽屉无「自动发布 HTTPS」与「+ 新建解析记录」，自动匹配选用面板证书；`NodeInstallPanel` 统一建节点与改接重装；在线换证直接热重载；`hubQuery` 刷新不空洞、`deleteDns` 默认 `false` | 前端单测与 smoke（域名顺手签证、极简接入、刷新直达、改接重装、删前默认不勾 DNS）、浅色/深色/390 截图与四态说明、`./scripts/verify.sh` | 面板 minor |
| **B4：发布默认复用证书与 ≤15 天按需续期** | `InstallAndPublishDrawer.tsx`、`SiteDrawer.tsx`、`siteForm.ts`、概览/证书页按需续期调度与去重、`docs/runbook/node-onboarding.md` | 库内有匹配域名证书时，安装发布应用与新建站点默认 `manual + $cert`；探活发现 `≤15` 天可续期证书自动异步续期并同步关联 VM 与 Caddy | 前端单测、真机 E2E（域名建解析顺手签证 → 添 VM 零 acme 上线 → 改接入/换证 → 发应用 → 续期同步 → 删节点/409 删证拦截） | 面板 minor |

## 6. 已拍板决策

1. **前置建解析顺手签证 + 极简添 VM**：在「设置 → 域名管理」建解析记录时顺手签发证书（已覆盖则免签）；彻底关闭添加 VM 弹窗内的「+ 新建解析记录」临时建解析与「自动发布 HTTPS / 发布端口 / 上游端口」，添 VM 只完成域名/证书配置并装好 Agent + Caddy。
2. **证书到期机制**：默认 `autoSync=true`，支持手动一键续期，并在打开面板探活时对剩余有效期 `≤ 15` 天的 `cf-dns01` 证书异步自动续期并同步关联节点与 Caddy。
3. **兜底保留**：保留 `install.sh --acme` 作为未绑定面板证书节点的手工兜底参数（补齐超时与报错），不再作为新建节点默认路径。

无待拍板项。
