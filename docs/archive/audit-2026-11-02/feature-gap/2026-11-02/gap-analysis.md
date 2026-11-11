# 用户使用流程 vs 现有功能：缺口分析与"域名统一服务"建议

> 状态：已归档（历史记录；一次性评估产物，不得作为开发依据，AGENTS.md 红线 9c）
> 适用范围：全仓库功能对照（只读分析，未改任何代码）
> 最后核验: 2026-11-03（修复状态复核）
> 关联：docs/design-v3.md、docs/agent-lifecycle.md、docs/host-ops.md、docs/dual-mode.md、docs/caddy-management.md

## 0.1 修复状态（2026-11-03 复核，feat/server-capabilities 分支）

| 缺口 | 状态 | 修复位置 |
|---|---|---|
| B1 系统包代装 | **已修** | `2e6e76c`（install.sh `--with-caddy/--with-wireguard/--with-socat/--with`，白名单仅 wireguard-tools/caddy/socat） |
| B2 Peer 一键安装脚本 | **已修** | `2e6e76c`（`peer_install_script` 动作：装工具→写 conf→启用→回连验证；导出抽屉 conf/脚本双 Tab） |
| B3 安装脚本不装 Caddy + 自签 | **已修** | `2e6e76c`（`--with-caddy` + certificates `issue_selfsigned` 既有能力编排） |
| B4 Agent 无 TLS | **已修** | `2e6e76c`（install.sh `--tls` 生成自签证书同端口启用 HTTPS，`--tls-cn` 可指定 CN） |
| E1 svc.restart/svc.logs | **已修** | `629a949`（svc.list/logs/restart 受控管理接入面板） |
| E2 cron | **已修** | `629a949`（cron 受控管理接入面板） |
| E3 远程升级 UI | **已修** | `629a949`（AgentCard 远程自升级替换命令复制） |
| E5 删除 peer 侧服务残留 | **已修** | `01cdd8f`（khc-host `cleanup` 动词；删除节点/Peer 确认框"同时清理本机服务"，残留阻止删除） |
| L4 / §2 方案 A：面板托管 CF DNS | **已修（第一期受限版）** | `e57357e`（设置卡片 + 节点代建 A/AAAA + 联动删除；用法见 `docs/cf-dns.md`） |
| §1.1 "面板管 CF DNS" | **已修** | 同上 `e57357e` |
| E4 应用凭据回传、L1 singbox、L2 自制应用分发、L3 批量分发、L5 结束进程 | **未做**（按需后续，走 AGENTS.md §6.1 新增适配器流程） | — |
| 走查另发现：发布链路漂移（线上包 0.1.4 ≠ main 构建） | **已修** | `5165cad`（Agent 0.1.7、包入库、CI 版本一致性检查；0.1.5/0.1.6 打包后未发布、先后被取代；见 `docs/engineering/release.md` §6） |

---

## 0. 结论速览

- **用户 12 条流程项中：4 条可用、7 条半可用、3 条没有**（详见 §1 对照表）。
- **当前走不通的关键步**：① 安装脚本不装 Caddy/WireGuard（只装 Agent）；② WireGuard/Peer 无一键安装（WG 工具链要手装、peer 只给 .conf）；③ Agent 自身无 TLS（HTTPS 域名需有效证书、HTTPS 自签 IP 需自建前置代理）。
- **域名统一服务推荐：方案 A（受限版）**——面板只托管 CF DNS 的 A/AAAA 记录创建与展示，证书沿用现有 certificates 适配器 + Caddy TLS；需要用户提供**最小权限 CF API Token（单 Zone 的 DNS Edit）**。不想给 Token 则退回方案 B（现状已基本可用，零改动）。
- **最该补的 5 个缺口**：系统包代装、peer 一键安装脚本、安装脚本顺带 Caddy+自签、svc.restart/svc.logs/cron、应用凭据回传展示（+ singbox 适配器示范）。

---

## 1. 逐条对照表

可用性定义：**可用** = 按用户期望走通；**半可用** = 有实现但与期望有明显差距；**没有** = 缺失或明确报错要求手动操作。

### 一、添加 VM

#### 1.1 通过 IP 或域名添加（倾向 HTTPS 域名 / HTTPS 自签 IP）——**半可用**

| 子项 | 现状 | 证据 |
| --- | --- | --- |
| 域名添加 | ✅ 支持。`endpoint` 契约允许 http(s):// 域名或裸 IP | [index.ts](../../../packages/contracts/src/index.ts#L94-L108)；[nodes.ts](../../../apps/api/src/routes/nodes.ts#L32-L53) |
| IP 直连 | ✅ 裸 IP 一律走 `cloudflare:sockets` TCP（绕开 CF fetch 403/1003） | [tcp-fetch.ts](../../../apps/api/src/lib/tcp-fetch.ts#L28-L35) |
| HTTPS 域名 | ⚠️ 域名优先走 CF `fetch()`，**会校验证书**：自签证书走域名不可用，需有效证书（CF 代理 或 ACME） | [tcp-fetch.ts](../../../apps/api/src/lib/tcp-fetch.ts#L29-L35)；[node-client.ts](../../../apps/api/src/lib/node-client.ts#L156-L178) |
| HTTPS 自签 IP | ⚠️ TCP socket 路径 `secureTransport:'on'` 不校验证书（自签可用），**但 Agent 本身只监听 HTTP**（agent/khc 无任何 TLS 代码），要上 HTTPS 必须在 VM 前置反代 | [tcp-fetch.ts](../../../apps/api/src/lib/tcp-fetch.ts#L112-L127)；`grep ssl/TLS agent/khc/` 无匹配 |
| 面板管 CF DNS | ❌ 全仓库无任何 Cloudflare DNS API 代码（`api.cloudflare.com`/`dns_records` 零匹配） | grep 全仓库（2026-11-02） |

**差距**：用户想要的"面板直接托管 CF 域名的 DNS 与证书、VM 不再单独配域名"目前完全没有；HTTPS 需要用户自己在 VM 上配 Caddy + 证书。安全设计（IP 走 socket、域名走 fetch）本身是完整的。

#### 1.2 一键安装链接，装好 Caddy 与自签证书服务——**半可用（Agent 有、Caddy/证书没有）**

| 子项 | 现状 | 证据 |
| --- | --- | --- |
| 一键安装命令 | ✅ 创建节点后自动生成"下载→校验 sha256→写 token→install.sh"命令（含一次性 token，system/user 两种模式） | [agent_lifecycle.ts](../../../apps/api/src/routes/agent_lifecycle.ts#L72-L101)；[HubsPage.tsx](../../../apps/web/src/pages/HubsPage.tsx#L69-L109)（创建成功即自动加载安装命令） |
| 安装脚本内容 | ⚠️ install.sh **只装 Agent**（Python 3.11+ 标准库 + systemd unit），不装 Caddy、不装 WG、不配证书 | [install.sh](../../../agent/install.sh#L1-L58) |
| Caddy 安装 | ❌ `caddy-site` 适配器 `install()` 只检测 caddy 是否存在，缺失时报错并提示**手动** `apt-get install -y caddy` | [caddy_site.py](../../../agent/adapters/caddy_site.py#L2030-L2034) |
| 自签证书服务 | ✅（面板可签发）`certificates` 适配器支持 `issue_selfsigned`（自签）与 `issue_acme`（acme.sh DNS-01，支持 cloudflare/route53 凭据），签发后 PEM 入库 D1，Caddy 站点 `tls.mode=manual` 可引用 | [certificates.py](../../../agent/adapters/certificates.py#L1-L89)；[caddy_site.py](../../../agent/adapters/caddy_site.py#L15-L17)；[certificates/page.tsx](../../../apps/web/src/apps/certificates/page.tsx#L59-L76)（三模式签发 UI：selfsigned/acme/manual） |

**差距**：用户期望"跑完一条命令，Caddy + 自签证书全部就绪"；现状是装完 Agent 后还要 ① 手装 caddy、② 面板装 caddy-site 适配应用、③ 面板签发自签证书、④ 建站点引用证书，共 3~4 步。

#### 3.1 常规应用分发（自制应用 / singbox 等，一键安装 + 展示访问地址/用户名/密码）——**半可用**

| 子项 | 现状 | 证据 |
| --- | --- | --- |
| 应用安装框架 | ✅ AppPage 统一 plan/apply/install/uninstall（install 为后台任务）；Worker 转发 `/nodes/:id/apps/:app/:action` 到 Agent | [AppPage.tsx](../../../apps/web/src/pages/AppPage.tsx#L152-L190)、[apps.ts](../../../apps/api/src/routes/apps.ts#L182-L208)、[kernel.py](../../../agent/khc/kernel.py#L673-L737) |
| 安装完展示访问地址 | ✅ 已有先例：node_exporter 安装后返回 "Metrics 地址" 卡片（可复制） | [node_exporter.py](../../../agent/adapters/node_exporter.py#L360-L363) |
| 展示用户名/密码 | ❌ 无任何适配器生成/回传凭据（cards 框架能力上支持，但没有先例与规范） | 全部 6 个适配器中 grep 凭据字段无匹配 |
| 自制应用 / singbox | ❌ 无适配器。现有仅 6 个：caddy_site / certificates / host_ops / node_exporter / port_forward / wireguard | `ls agent/adapters/`（2026-11-02） |
| 批量分发到多节点 | ❌ 无，只能逐节点逐应用操作 | [apps.ts](../../../apps/api/src/routes/apps.ts)（路由按节点维度） |

**差距**：分发框架成熟（含任务、审计、错误信封、卸载），但"应用目录"只有 node_exporter 一个可分发样例；用户点名的 singbox、自制应用需要新增适配器（AGENTS.md §6.1 有标准流程）。

#### 3.2 服务器运维（CPU 排查 / 防火墙 / SSH 密钥 / cron）——**半可用**

| 子项 | 现状 | 证据 |
| --- | --- | --- |
| CPU 高的服务排查 | ✅ 进程快照 `snapshot`/`processes`，可按 CPU/内存排序（limit 200），状态带下钻；但**结束进程能力已移除**（只读） | [OpsSegments.tsx](../../../apps/web/src/apps/host-ops/OpsSegments.tsx#L93-L125)、[ProcessDrawer.tsx](../../../apps/web/src/apps/host-ops/ProcessDrawer.tsx#L29-L32) |
| 防火墙 | ✅ `fw.show`/`fw.apply`/`fw.confirm` + 60 秒确认与自动回滚（`__fw_rollback`） | [FirewallDrawer.tsx](../../../apps/web/src/apps/host-ops/FirewallDrawer.tsx#L181-L258)、[khc_host.py](../../../agent/adapters/host_ops/khc_host.py#L1388-L1487) |
| SSH 密钥 | ✅ `keys.list`/`keys.add`/`keys.remove`（规范化 + 指纹校验） | [SshKeysDrawer.tsx](../../../apps/web/src/apps/host-ops/SshKeysDrawer.tsx#L59-L125) |
| 服务重启 | ❌ UI 占位恒禁用（"svc.restart 待 Agent 拍板"）——**即用户记忆中已挂起的待确认项** | [OpsSegments.tsx](../../../apps/web/src/apps/host-ops/OpsSegments.tsx#L38-L41) |
| 服务日志 svc.logs | ❌ khc-host 白名单无此动词 | [khc_host.py](../../../agent/adapters/host_ops/khc_host.py#L93-L106) |
| cron 定时任务读+管 | ❌ 白名单动词只有 version/status/snapshot/processes/fw.*/keys.*，**无 cron** | [khc_host.py](../../../agent/adapters/host_ops/khc_host.py#L1520-L1531) |

**差距**：进程/防火墙/密钥三项与期望一致且有安全设计（写动词需 root、防火墙双阶段确认）；服务级运维（重启/日志）与 cron 完全缺失，这两项正是用户"CPU 占用高的服务排查"闭环的最后一步。

#### 3.3 Hub 自身管理（升级 / 版本维护）——**半可用**

| 子项 | 现状 | 证据 |
| --- | --- | --- |
| 版本展示 | ✅ AgentCard 显示版本/运行模式/最后在线 | [AgentCard.tsx](../../../apps/web/src/apps/node-settings/AgentCard.tsx#L78-L96) |
| 升级 | ⚠️ UI 只有"生成升级命令→复制粘贴"（install/upgrade/uninstall 三命令）；**远程拉取式自升级 API 已存在**（`POST /nodes/:id/agent/upgrade`，Agent 202 + detached 重启）但 UI 未接入 | [AgentCard.tsx](../../../apps/web/src/apps/node-settings/AgentCard.tsx#L43-L47)、[agent_lifecycle.ts](../../../apps/api/src/routes/agent_lifecycle.ts#L162-L205)、web 中 grep `agent/upgrade` 仅测试引用（待验证是否有其他入口） |
| 面板自身升级 | ✅ main 推送 → CI 自动部署生产（ADR-0008），非面板内操作 | AGENTS.md §5、docs/engineering/auto-deploy.md |

**差距**：升级体验是"命令生成"而非"点一下"；远程升级能力后端已备好，只差 UI 按钮 + 发布清单选择。

### 二、安装 WireGuard

#### 2.1 下发安装指令（而非用户手动安装）——**没有**

- `wireguard` 适配器 `install()` 只检查 `wg`/`wg-quick` 是否存在，**缺失时报错并提示用户手动 `apt-get install -y wireguard-tools`**，不下发安装。
- 证据：[wireguard.py](../../../agent/adapters/wireguard.py#L1683-L1701)

#### 2.2 创建 peer + 一键安装脚本；默认不全量走 WG——**半可用**

| 子项 | 现状 | 证据 |
| --- | --- | --- |
| 创建 peer | ✅ 表单（名称/allowedIps/keepalive/公钥/启用），保存后自动导出客户端配置 | [page.tsx](../../../apps/web/src/apps/wireguard/page.tsx#L401-L451)、L444-L445（新建后同屏展示 .conf） |
| 一键安装脚本 | ❌ 只有 `.conf` 下载/复制（`client_config` 动作返回 conf 文本 + 私钥回写 D1）；**没有**"peer 机器跑完即连"的安装脚本 | [wireguard.py](../../../agent/adapters/wireguard.py#L1758-L1781)、[page.tsx](../../../apps/web/src/apps/wireguard/page.tsx#L514-L529)（openExport） |
| 默认网络策略 | ✅ **符合期望**：默认 `AllowedIPs` 取 hub 接口网段，兜底 `DEFAULT_ROUTE = 10.99.0.0/24`（仅 WG 子网分流，**不是** 0.0.0.0/0 全隧道）；且可按 peer 在面板改 | [wireguard.py](../../../agent/adapters/wireguard.py#L230-L237)、L59（DEFAULT_ROUTE）、[page.tsx](../../../apps/web/src/apps/wireguard/page.tsx#L135-L190)（allowedIps 表单） |
| peer 无损换钥 | ✅（超出期望）：rotate_peer 状态机 + 宽限期 | [wireguard.py](../../../agent/adapters/wireguard.py#L1786-L1790) |

**差距**：peer 侧需要用户自己装 WG 工具、自己导入 conf（或 wg-quick up / NetworkManager）。面板没有生成"curl 一条命令装好并连接"的脚本。

#### 2.3 Hub 端应用配置与端口转发——**可用**

- `port-forward` 适配器：socat 监听 Hub 端口 → 转发到 WG Peer（文档定位即"Hub → WireGuard Peer 的按需端口映射"）；wireguard 页有 ForwardsCard，目标下拉直接选 peer。
- 证据：[port_forward.py](../../../agent/adapters/port_forward.py#L2-L15)、L151-L199；[page.tsx](../../../apps/web/src/apps/wireguard/page.tsx#L1040-L1050)
- 注意：hub 端 Caddy 模式与 WG 模式互斥（dual-mode，wg 页在 caddy 模式只读），转公网流量走 caddy-site，内网穿透走 port-forward + wireguard。

#### 2.4 Peer 的运维操作与 hub 端一致——**半可用**

| 子项 | 现状 | 证据 |
| --- | --- | --- |
| peer 纳管 | ✅ host-ops `onboard` 生成 peer **一键接入命令**（内联 base64 脚本 + 受限 authorized_keys + khc-host 脚本），hub 经 SSH over WG 隧道调用 | [host_ops.py](../../../agent/adapters/host_ops.py#L283-L297)、[PeerOpsPanel.tsx](../../../apps/web/src/apps/host-ops/PeerOpsPanel.tsx#L48-L52) |
| 能力与 hub 一致 | ⚠️ peer 与 hub self 走**同一 khc-host 白名单**：version/status/snapshot/processes/fw.show/fw.apply/fw.confirm/keys.list/keys.add/keys.remove——覆盖进程/防火墙/密钥三项，与 hub 本机完全一致；但 svc/cron 两边都没有 | [khc_host.py](../../../agent/adapters/host_ops/khc_host.py#L93-L106)、[PeerOpsPanel.tsx](../../../apps/web/src/apps/host-ops/PeerOpsPanel.tsx#L135-L159)（snapshot 一次 SSH 取 version+status） |
| peer 升级/版本 | ✅ 版本比对 + 脚本过期提示（E_SCRIPT_OLD）+ 更新命令 | [PeerOpsPanel.tsx](../../../apps/web/src/apps/host-ops/PeerOpsPanel.tsx#L125-L133) |

### 三、卸载

| 用户期望 | 现状 | 可用性 | 证据 |
| --- | --- | --- | --- |
| 一键/远程下发卸载 peer（host-ops 通道） | ✅ onboard 同时返回 peer 卸载命令（清理 khc-host + 受限 authorized_keys），面板有卸载入口 | 可用 | [host_ops.py](../../../agent/adapters/host_ops.py#L948-L1021)、PeerOpsPanel 的 showUninstall 状态（L105） |
| 删除 peer 时把服务清掉（hub 侧） | ✅ 删除 peer = 配置移除 + apply 同步内核接口（P1-A 修复后无残留） | 可用 | [page.tsx](../../../apps/web/src/apps/wireguard/page.tsx#L715-L729)；docs/archive/audit-2026-11-02/server-test/2026-11-02/report.md P1-A 复验记录 |
| 删除 peer 时清掉 **peer 机器上的 WG 服务** | ❌ peer 侧 WG 客户端配置/服务不会被清理（peer 不装 Agent；host-ops 卸载只清 khc-host 通道，不动 WG）。peer 断连但服务残留 | 半可用 | 全仓库无 peer 侧 WG 卸载逻辑（待验证：是否可接受为设计取舍） |
| 删除 hub 时把服务关掉 | ⚠️ 两段：**WG/Caddy 等应用**可通过面板远程 `uninstall` 动作停服务（wireguard uninstall 会 stop/disable wg-quick、删 conf、可选 purge）；**Agent 本体**卸载只有"命令生成"（复制粘贴 uninstall.sh，需人在 VM 上跑） | 半可用 | [wireguard.py](../../../agent/adapters/wireguard.py#L1719-L1736)、[agent_lifecycle.ts](../../../apps/api/src/routes/agent_lifecycle.ts#L133-L160)（仅生成命令，注释明确"不远程执行"） |

---

## 2. DNS / 证书统一服务：决策建议

### 现状基础（三个方案共同的起点）

- 证书签发与消费链路**已经存在**：certificates 适配器（自签 + ACME DNS-01，acme.sh，支持 cloudflare/route53 凭据）→ PEM 入 D1 → Caddy 站点 `tls.mode=manual` 引用；Caddy 也有 `auto`（公网域名自动 HTTPS）与 `internal`（Caddy 自签）模式。
- **缺的是 DNS 记录这一环**：域名 → VM 的 A/AAAA 记录目前完全由用户手工操作（无论域名在 CF 还是别家）。
- 面板本身跑在 Cloudflare Worker 上，天然具备调 CF API 的网络与运行时条件（免费额度内，Workers 标准请求计量，无新增计费项）。

### 方案 A：面板托管 CF DNS 记录（受限版，推荐）

**实现范围（严格受限，不做完整 DNS 管理面板）**：
1. 设置页新增"Cloudflare DNS"卡片：存 CF API Token + Zone ID + 目标域名（沿用 settings + secret 加密存储模式）。
2. 节点创建/编辑时可选"自动建 A/AAAA 记录"：面板调 `POST /zones/{zone}/dns_records` 写 `<节点名>.<域名>` → VM IP；节点删除时联动删记录。
3. 一个只读列表展示面板托管的记录（防漂移：与 D1 记录比对）。
4. 证书不变：继续用 certificates 适配器 ACME DNS-01（凭据可复用同一个 Token，需加 Zone 读权限）或 Caddy auto。

**前置条件**：
- 用户提供 CF API Token，**最小权限 = 单 Zone 的 `Zone → DNS → Edit` + `Zone → Zone → Read`**（ACME DNS-01 复用则再加 `Zone → DNS Read`，已包含）。绝不要 Account 级 Token。
- 域名必须已托管在 CF（用户现状满足）。

**安全风险与对策**：
- Token 落库泄露 = 攻击者可改整个 Zone 的 DNS（钓鱼/劫持风险）。对策：复用现有 MASTER_ENC_KEY 加密存储（同 nodeToken 模式）、审计日志只记 host、UI 永不回显明文（同密码/私钥处理惯例）。
- 误删记录：删除动作走 L2 确认；记录删除失败不阻断节点删除（只告警）。
- 与用户手工记录冲突：只管理面板自己创建的记录（D1 记 source=khc），不碰用户手建记录。

**免费额度与成本**：CF DNS 记录免费额度 1000 条/Zone，本项目节点数个位数，零成本；Worker 调 CF API 属标准 fetch 请求，不新增付费资源（符合红线：不创建任何付费资源）。

**迁移与回滚**：纯增量（新设置卡片 + 节点表单一个可选开关 + D1 settings 新 key + 一张 dns_records 登记表可选）；关掉开关即回到手工 DNS，面板托管的记录可一键导出后手工重建。回滚 = 删设置里的 Token。

**对现有代码的改动量**：**中**。Worker：settings 扩展 + 1 个新路由组（DNS 记录 CRUD 走编排层，参照 `lib/mode.ts` 的编排层例外放应用知识的先例）+ CF API client（纯 fetch）；契约：settings schema + 节点创建可选字段；UI：设置页卡片 + 节点表单开关。不动 Agent、不动核心表结构。

### 方案 B：VM 侧自签/ACME，面板只做分发与校验（现状增强）

**实现范围**：
1. `agent/install.sh` 增加可选 `--with-caddy`：装 Agent 顺带 apt 装 caddy（或官方仓库二进制）。
2. Agent 首次上线后，面板引导（已有 caddy-site/certificates 流程）一键完成：签发自签证书（certificates `issue_selfsigned` 已有）→ 建本地站点引用。
3. 域名解析完全由用户手工做（或在 VM 上跑 ddns 脚本，面板不管）。

**前置条件**：无（零凭据）。ACME 公网证书继续走 Caddy `auto` 或 DNS-01（DNS-01 仍需 CF Token，但只存在 Agent 侧 env，面板不存）。

**安全风险**：最低。面板不持有任何 DNS 凭据；自签证书仅适合"浏览器手动信任"或内部场景。

**免费额度与成本**：零。

**迁移与回滚**：install.sh 加一个 flag，随时可退。

**改动量**：**小**。但没解决核心痛点——用户仍要去 CF 面板手工加 A 记录，"VM 上不再单独配域名"的诉求只满足一半（TLS 满足、DNS 不满足）。

### 方案 C：可插拔 DNS Provider 抽象（先 CF 后腾讯云）

**实现范围**：contracts 定义 `DnsProvider` 接口（list/create/delete + health），Worker 侧 provider 适配注册表，UI 统一"域名服务"页；CF 为首个实现，腾讯云 DNSPod 为第二个。

**前置条件**：同 A（CF Token），未来每接一家要一份该家凭据。

**安全风险**：同 A，但凭据种类 ×N，泄露面更大；抽象层本身引入"接口漂移"维护成本。

**免费额度与成本**：CF 免费；腾讯云 DNSPod 私有域名免费额度有限（公网解析免费版有线路/记录数限制，需按用户实际域名确认，**待验证**）。

**迁移与回滚**：抽象层一旦定下，改接口 = 动契约（红线 1，每次都要方案确认）。

**改动量**：**大**（契约 + Worker 编排层 + UI + 每个 provider 的测试矩阵）。与项目"面板 = 低频遥控器，不做平台"的定位（AGENTS.md §1）和用户"简单轻量"偏好冲突。

### 推荐与理由

**推荐方案 A（受限版）**，一句理由：用户域名本来就在 CF、面板本来就在 CF，补上"面板代建 A 记录"这一环就能让"加 VM = 填个名字"成立，改动中等、零成本、Token 最小权限可控；B 是不想给 Token 时的零风险兜底（且 B 的第 1 条——安装脚本顺带装 Caddy——无论选哪个方案都建议做）；C 在只有一个真实 provider 的现状下是过度设计。

**分期建议**：第一期 = A 的 1+2+3（DNS 记录托管）；第二期再看是否需要泛域名/多 Zone；腾讯云等别家 provider 等真的有第二家域名再说（届时 C 只是 A 的 provider 参数化，不必预先抽象）。

---

## 3. 缺口清单（按三档）

### 3.1 阻断用户流程（不补则该步走不通/明显违背预期）

| # | 缺口 | 建议实现方式 | 工作量 |
| --- | --- | --- | --- |
| B1 | **系统包代装**：wireguard/caddy `install()` 只检查不安装，缺包直接报错让用户手装 | 适配器 install 增加可选"代装"分支：`apt-get install -y wireguard-tools` / caddy（写动作 + root + 明确风险提示；需主人拍板"Agent 允许 apt 装系统包"这一安全边界） | 中 |
| B2 | **Peer 一键安装脚本**：现在只有 .conf 下载 | 面板生成 `curl … \| sudo bash` 脚本：装 wireguard-tools → 写 conf → `wg-quick up` + enable（模板渲染纯函数 + 单测，走 Agent 静态文件或 Worker 直接下发） | 小–中 |
| B3 | **安装脚本不装 Caddy + 自签证书**（用户 1.2 的字面诉求） | `install.sh --with-caddy`（同 B1 的 caddy 分支）+ 首次上线引导卡片（certificates `issue_selfsigned` 已有，只差编排与文档） | 中 |
| B4 | **Agent 无 TLS**：HTTPS 域名要有效证书、HTTPS 自签 IP 要自建反代 | 最轻路径：B3 之后，安装引导顺带建 `agent.<节点名>.<域名>` 反代站点（Caddy 终止 TLS → 127.0.0.1:8880）；Agent 本体不加 TLS（保持标准库轻量） | 中（依赖 B1/B3 与方案 A 的 DNS） |

### 3.2 体验差（能走通但绕/手动）

| # | 缺口 | 建议实现方式 | 工作量 |
| --- | --- | --- | --- |
| E1 | svc.restart / svc.logs 缺失（UI 已留占位） | khc-host 白名单加 `svc.restart`/`svc.logs`（unit 白名单 + journalctl 尾读）；UI 解除禁用。**即先前已挂起的"待 Agent 拍板"项** | 中 |
| E2 | cron 读取与管理缺失 | khc-host 加 `cron.list`/`cron.set`（写 /etc/cron.d/khc-* 白名单目录）；UI 在主机运维页加分段 | 中 |
| E3 | 远程升级 API 有、UI 无入口 | AgentCard 加"远程升级"按钮（调 `POST /nodes/:id/agent/upgrade`，选发布清单版本；Agent 已支持 detached 自重启） | 小 |
| E4 | 应用凭据（用户名/密码）回传展示无先例 | 新适配器（如 singbox）示范：install 返回 cards 携带访问地址 + 初始凭据；引用 secret-refs/redact 现有机制，凭据只在安装结果抽屉展示一次 + 可重新生成 | 小（随新适配器） |
| E5 | 删除 peer 后 peer 机器 WG 服务残留 | peer 删除确认抽屉里联动展示"peer 侧卸载命令"（host-ops onboard 的 uninstallCommand 已有，纯 UI 联动） | 小 |

### 3.3 缺失但可后续

| # | 缺口 | 建议实现方式 | 工作量 |
| --- | --- | --- | --- |
| L1 | singbox 代理适配器 | 按 AGENTS.md §6.1 标准流程：`agent/adapters/singbox.py` + `apps/web/src/apps/singbox/page.tsx` + 测试（render/plan/apply/回滚/端口冲突） | 中–大 |
| L2 | 自制应用（用户自有程序）分发 | 适配器工厂：通用 "下载 tar.gz → systemd unit → 端口注册" 模板适配器；先做手动注册版本 | 中–大 |
| L3 | 批量应用分发到多节点 | Worker 批量动作编排（逐节点串行转发 + 汇总信封）；依赖 L1/L2 先有可分发的应用 | 大 |
| L4 | DNS 统一服务（方案 A） | 见 §2；第一期 DNS 记录托管 | 中 |
| L5 | 结束进程能力（当前只读） | khc-host `proc.kill`（白名单信号 + root）；安全评审后做 | 小–中 |

---

## 4. 需要主人拍板的点

1. **CF API Token（方案 A 的开关）**：是否愿意提供一个**最小权限 Token（单 Zone：DNS Edit + Zone Read）**存入面板？给了 → 方案 A；不给 → 方案 B（现状 + 安装脚本增强）。这是本报告唯一影响架构方向的决策。
2. **Agent 代装系统包的安全边界**（B1/B3）：Agent 目前 install 动作会联网下载（node_exporter 已有先例），但 **apt-get 装系统包是新的安全面**（供应链 + 系统状态变更）。是否授权？若授权，建议限定白名单包（wireguard-tools/caddy/socat）。
3. **svc.restart / svc.logs / cron 动词**（E1/E2）：khc-host 白名单扩展，属 Agent 能力变更（先前会话已标记"待用户拍板"），本次一并确认。
4. **WG 默认策略确认**：现状默认 `AllowedIPs = 10.99.0.0/24`（仅 WG 子网分流，符合"默认不全量走 WG"的期望）——确认保持，且 peer 一键脚本（B2）沿用同一默认。
5. **删除 peer 是否要求清理 peer 侧服务**（B/3.1-E5）：现状设计为"hub 侧断连即止"；若要求 peer 侧也卸载，走 host-ops 卸载命令联动即可，但要接受"peer 必须先 onboard 过 khc-host"这个前提。

---

## 附：证据文件索引（本报告全部引用）

- 契约：packages/contracts/src/index.ts（endpoint/节点创建 L94-108）
- Worker：apps/api/src/routes/nodes.ts、agent_lifecycle.ts（L72-205）、apps.ts（L182-284）；lib/tcp-fetch.ts（L28-35、L112-127）、node-client.ts（L156-178）、mode.ts
- Agent：agent/install.sh；khc/kernel.py（L673-737）；adapters/wireguard.py（L59、L197-260、L1683-1736、L1758-1781）、caddy_site.py（L15-17、L2030-2034）、certificates.py（L1-89）、host_ops.py（L272-321、L948-1021）、host_ops/khc_host.py（L93-106、L1520-1531）、port_forward.py（L2-15、L151-199）、node_exporter.py（L251-302、L360-363）
- 前端：pages/HubsPage.tsx（L69-109）、AppPage.tsx（L152-190）；apps/wireguard/page.tsx（L401-451、L514-529、L715-729）、host-ops/OpsSegments.tsx（L38-41、L93-125）、host-ops/PeerOpsPanel.tsx（L48-52、L135-159）、node-settings/AgentCard.tsx（L43-47）、certificates/page.tsx（L59-76）
