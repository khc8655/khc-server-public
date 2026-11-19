# 面板逐模块真机冒烟与问题清单（2026-11-20）

> 状态：历史（证据）｜ 关联：`agent/adapters/wireguard.py`、`apps/web/src/apps/wireguard/page.tsx`

## 1. 目的与方法

上一轮修掉 WireGuard 安装恒失败（Agent 0.6.1 / 面板 0.19.1）后，按模块把面板在真机上走一遍，
确认「装得好、用得对」，并把走查中发现的问题分成「已修」与「待定」。

- 环境：生产面板 `https://a.18888.bond`（面板 0.19.2），节点 aws-hui-us = `nd_fd816cd3b1193b7d`
  （测试机，Agent 0.6.2）、oracle-x86-2 = `nd_0500a03d6af5639b`（对照组，Agent 0.6.0）。
- 工具：ego-browser（`/Users/xk/.local/bin/ego-browser`，v2.2.1），真实点击 / 填表 / 菜单，
  不注入、不改接口调用顺序；只读接口用页面内 `fetch` 取原始响应做交叉验证。
- 路由按 `apps/web/src/app/router.tsx` 的真实结构访问（`/hubs/$hubId/<子页>`）；
  `/peers`、`/forwards`、`/certs`、`/apps` 是既有 302 暗路由，不是 404。

## 2. 通过项

| 模块 | 实测内容 | 结果 |
| --- | --- | --- |
| 概览 `/` | 节点矩阵、探测、全局证书计数、刷新状态 | 通过（刷新后「最近探测 0 秒前」） |
| 节点列表 `/hubs` | 3 节点在线、直连地址、添加节点抽屉（域名/Tunnel/IP 直连 + Zone） | 通过 |
| 节点概况 `/hubs/:id` | 实时快照、站点/反代/Peer 计数、对外服务、主机卡、系统服务失败入口 | 通过 |
| 对外服务 | 转发与站点两个空态与入口 | 通过（socat 未装，见 §3-4） |
| 内网穿透 | 接口设置抽屉；添加 Peer → 保存并生效（配置 rev 25 写入并 apply，`已同步`）；Peer 行菜单（编辑/发布为站点/导出配置/停用/删除 Peer）；删除 Peer → `已删除 e2e-peer`、回到 0 Peer 且 `已同步` | 通过 |
| 站点 | 列表（托管 1 站点 + 未托管外部块「第 11–23 行 / 需手工处理」）；添加站点（反代 127.0.0.1:9099、端口 80、关闭 TLS）→ 二次确认「应用站点配置？」→ `2 个站点 · 已同步`，Caddy `validate` 通过并平滑重载（`appliedRev 36`、`siteHealth` 含 `e2e.test`）；删除站点回到 1 站点；Caddy 服务抽屉（版本 2.6.2、重新校验、导出配置、重载） | 通过 |
| 站点分段 | 扩展应用（app-catalog / node-exporter 未安装）、证书（本节点无关联证书） | 通过 |
| 主机运维 | 服务（5 单元，3 failed 真实上报）、进程（按 CPU/内存 + 业务/全部切换）、防火墙（22/51820/443 锁定规则 + 编辑/放弃/应用）、SSH 公钥（ed25519 指纹）、定时任务（另有 3 个面板外 cron 文件只读展示） | 通过 |
| 节点设置 | Agent 与接入、修改接入方式（域名/Tunnel/IP 直连 + Zone + 端口）、安装/卸载 Agent 命令抽屉、远程升级、回滚 Agent（要求输入版本号确认）、节点模式（组网 ↔ Caddy 网关）、备份与恢复（导出/导入） | 通过 |
| 全局设置 `/settings` | 证书库、域名（2 条 CF 凭据）、隧道（空态）、应用管理（空态）、应用目录、SSH 公钥（空态）、系统变量（`cf_dns_accounts`） | 通过（应用目录见 §3-3） |
| 任务中心 | 最近 5/8 个任务、进度与日志、失败原因直显 | 通过 |
| 命令面板 ⌘K | 节点可搜（`aws`）、全局动作可搜（`证书` → 签发证书） | 通过（应用不可搜，见 §3-2） |

## 3. 发现的问题

### 3.1【已修，本批】【P1】WireGuard `installed` 把「配置已保存但未应用」当成「未安装」

- 复现：aws-hui-us 安装任务 `done · 100%` 后，`/state` 仍返回 `installed:false`、`running:false`，
  内网穿透页继续显示「节点上尚未安装 WireGuard + 安装 wireguard-tools」，节点概况的「组网节点」
  入口也消失。
- 数据：配置 `rev 24 / appliedRev 7`，`/etc/wireguard/khc0.conf` 不在、接口未起；
  `agent/adapters/wireguard.py` 的「有配置」分支写的是 `installed = conf 存在 or dump 成功`，
  而同函数「无配置」分支是 `installed = _tools_installed(ctx)`，注释也写明 `installed` 指工具链。
- 修复：`installed` 统一为 `_tools_installed(ctx)`；`running` 改为 `dump 成功 or（conf 存在且 unit active）`；
  新增 `StatusInstalledSemanticsTests` 三例，并做反向验证（还原旧实现 → 用例失败）。
- 修复后实测：升到 Agent 0.6.2 后 `/state` = `installed:true, running:true, appliedRev:24`，
  内网穿透页无「安装 wireguard-tools」按钮、无「尚未安装」横幅；oracle-x86-2（Agent 0.6.0，
  已装已跑、1 Peer 在线）状态不变，无回归。

### 3.2【待定，P3】命令面板承诺「搜索应用」，但索引里没有应用

- 输入框提示「搜索节点、应用或动作」，实际索引只有节点、导航与两个全局动作（签发证书、添加证书）。
- 复现：⌘K → 输入 `wireguard` → 「没有匹配结果」；输入 `删除` 同样无结果；`aws`、`证书` 正常。
- 出处：`apps/web/src/app/AppShell.tsx` 的 `paletteGroups`（`hub:` / `nav:` / 两个 `action:`）。
- 建议：要么补节点内应用条目，要么把占位文案改成「搜索节点或动作」。

### 3.3【待定，P2/运维】应用目录为空，但节点已声明 3 个 recipe

- `/settings?tab=catalog` 显示「目录为空 / Agent 包中没有可用的 recipe」，
  而 aws-hui-us 的 `app-catalog.status.recipes` = `demo-echo`、`generic-service`、`sing-box`。
- 原因：`GET /api/v1/app-manifests` 返回 `{"appManifests":[]}`（D1 `app_manifests` 无记录），
  与节点侧 recipe 无关。
- 结论：不是渲染缺陷，是清单未播种；需要一次清单发布/导入，或在文档里写清「先发布清单」的前置步骤。

### 3.4【待定，P3】端口转发缺 socat 时无面板内安装入口

- 文案「转发服务尚未就绪 … 若 socat 未安装，请先在节点上安装」，页面上没有任何按钮；
  对照 WireGuard 有「安装 wireguard-tools」（依据 `capabilities.pkgInstall`）。
- `agent/adapters/port_forward.py` 已实现 `install()`，但适配器没声明 `pkgInstall`，所以入口不会出现。

### 3.5【待定，P3】「公网地址（可选）」与实际要求不符

- 接口设置里「公网地址（可选）」留空时：页面顶部出现警告「Peer 需要可连的公网地址」，
  且新增 Peer 后自动弹出的导出抽屉直接失败：「`interface.publicEndpoint` 未配置，无法生成客户端配置」。
- 建议：把这句标签改成「Peer 连接需要」，或在没有 publicEndpoint 时先提示、不要自动打开导出抽屉。

### 3.6【待定，P3】进程「业务视图」可能被系统进程挤空

- 进程列表按 CPU/内存取前 20 再过滤系统进程；aws-hui-us 前 19 个全是内核线程与守护进程
  （含 Agent 自身），于是显示「当前没有业务进程」，而实际有 caddy 在跑（CPU 0%，被 limit 截掉）。
- 属交互取舍，不是数据错误；若要让业务视图可用，建议后端先过滤再截断，或调高 limit。

### 3.7【信息，非缺陷】「系统服务 3 个失败」是真实 OS 单元

- aws-hui-us 的 `ops.services.failedUnits` = `apt-daily-upgrade.service`、`fwupd-refresh.service`、
  `fwupd.service`（最小化 EC2 镜像常见），与面板无关；`系统服务 2 / 2` 指受管单元。
- 若想让「需要处理」更有信号量，可考虑对未受管的固件/定时器类失败降噪或提供「忽略」。

## 4. 交叉验证的关键原始数据

- `/api/v1/nodes/nd_fd816cd3b1193b7d/apps/port-forward` → `404 {"code":"not_found","message":"该应用尚未配置"}`，
  前端 `fetchAppConfig` 已把 404 转成 `null`，页面按「无配置」渲染，不是未处理错误。
- `host-ops call { target: 'host', verb: 'svc.list' }` → `E_NOT_ONBOARDED: Peer 未接入或已停用: host`；
  Hub 本机的正确 target 是 `self`（`processes`/`snapshot`/`fw.show` 均以 `self` 成功）。
- 站点应用后 `caddy-site.status`：`appliedRev 36`、`sites 2`、`lastReloadOk true`、`lastError null`；
  `siteHealth` 对 `e2e.test` 给出 `warn / HTTP 404`，与既有 `khc9099.test` 一致（上游本身回 404）。

## 5. 门禁

- Agent 单测 1164 passed；前端 vitest 97 files / 927 passed；`pnpm -r typecheck` 全绿；
  `check-release-consistency --repo` OK；`docs-lint` OK（CHANGELOG 按 AGENTS.md §7 归档到
  `docs/archive/changelog/before-0.12.4.md`）。
