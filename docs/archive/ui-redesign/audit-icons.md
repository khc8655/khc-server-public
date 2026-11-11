# 面板 UI 走查报告：图标与位置（2026-11-02）

> 状态：**已归档（历史记录，一次性走查产物，非现行规范）** ｜ 适用范围：仅用于追溯 2026-11-02 的线上 UI 走查证据，不得作为开发依据 ｜ 最后核验：2026-11-05 ｜ 归档日期：2026-11-05
> 取代者：[ui-guidelines.md](../../ui-redesign/ui-guidelines.md) §8.7 图标与徽标、§8.11 组件清单；走查发现的缺陷已闭环（见 [clicks-audit.md](audit-2026-11-03/clicks-audit.md)）
> 截图目录：`docs/archive/ui-redesign/audit-2026-11-02/`

- 对象：https://panel.example.com/（线上生产，ui-redesign 合并后版本，面板 v0.2.0）
- 方法：ego-browser 真实浏览器走查；桌面 1024px 全页面 + 关键页 390×844@2x 一轮
- 范围：登录页；全局三页（概览/节点/设置）；节点层五页（概况/站点/内网穿透/主机运维/节点设置）；站点三段、Peer 抽屉两 tab、主机运维四分段与两个抽屉、节点设置四分区、应用详情
- 样本节点：sp-vm-aws（在线）、peer2-user-mode-test（离线）、vm1-HK（3 Peer）
- 限制：所有节点组网 Peer 为 0/0，Peer 运维仅看到离线态；节点模式切换未实际点击（避免副作用）；未做暗色主题走查
- 截图目录：`docs/archive/ui-redesign/audit-2026-11-02/`

## 截图文件映射

| 文件 | 页面 / 状态 |
|---|---|
| 01-login.png | 登录页 |
| 02-overview.png | 概览（全局 A 页） |
| 03-hubs.png | 节点列表 |
| 04-settings.png | 全局设置 · 证书库段 |
| 05-hub-overview.png | 节点概况 |
| 06-sites-seg-sites.png | 站点页 · 站点段 |
| 07-sites-seg-apps.png | 站点页 · 扩展应用段 |
| 08-sites-seg-certs.png | 站点页 · 证书段（空态） |
| 09-sites-advanced.png | 站点页 · 高级展开（导出/导入/清空） |
| 10-wireguard.png | 内网穿透（sp-vm-aws 空态） |
| 11-wireguard-peers-offline.png | 内网穿透（peer2 离线，4 条横幅） |
| 12-wireguard-peers.png | 内网穿透（vm1-HK，3 Peer + 转发） |
| 13-peer-menu.png | Peer 行内"更多操作"菜单 |
| 14-peer-drawer.png | Peer 抽屉 · 配置 tab |
| 15-peer-drawer-ops.png | Peer 抽屉 · 运维 tab |
| 16-ops-services.png | 主机运维 · 服务段（状态带） |
| 17-ops-svc-menu.png | 服务行内菜单（重启 disabled + 提示） |
| 18-ops-diag-drawer.png | 诊断与操作抽屉 · 列表 |
| 19-ops-diag-detail.png | 诊断详情（ACME 环境不可用） |
| 20-ops-processes.png | 主机运维 · 进程段 |
| 21-ops-process-drawer.png | 进程详情抽屉 |
| 22-ops-firewall.png | 主机运维 · 防火墙段 |
| 23-ops-fw-edit-drawer.png | 编辑防火墙抽屉 |
| 24-ops-keys.png | 主机运维 · SSH 公钥段（空态） |
| 25-hub-settings-agent.png | 节点设置 · Agent 与接入 |
| 26-hub-settings-mode.png | 节点设置 · 节点模式（用户参考截图对应处） |
| 27-hub-settings-backup.png | 节点设置 · 备份与恢复 |
| 28-hub-settings-danger.png | 节点设置 · 危险区 |
| 29-site-drawer.png | 编辑站点抽屉 |
| 30-app-detail.png | 应用详情（node-exporter，C 型页） |
| m1-overview-390.png | 390px 概览 |
| m2-hubs-390.png | 390px 节点列表 |
| m3-ops-390.png | 390px 主机运维 |
| m4-sites-390.png | 390px 站点页 |
| m5-wireguard-390.png | 390px 内网穿透 |
| m6-hub-settings-390.png | 390px 节点设置 |

---

## P0（语义错误 / 明显误导，建议立即修）

### P0-1 Banner 图标映射语义错误（根因单点：`apps/web/src/ui/feedback.tsx` `bannerIcon`）—— ✅ 已修复（2026-11-02，fix/banner-icons）

- **页面/元素**：所有 `Banner` 组件。修复前映射 `info → shield`（渲染成空心圆"○"样）、`neutral → pause`（渲染成双竖线"||"），与"信息/中性"语义完全不符。
- **截图**：26（节点模式选项卡"||"）、27（"备份范围"蓝横幅"○"、导出备份说明卡"||"）、18/19（诊断抽屉灰色信息卡"||"）、11（"待上线后生效"chip"||"）、22/23（防火墙蓝横幅"○"）、m4/m5（站点/内网穿透蓝色提示横幅"○"）
- **修复说明**：`bannerIcon` 改为 `info/neutral → 'info'`（封闭图标集新增圆圈 i 图标，24 网格 / 1.75 描边，见 `apps/web/src/ui/icons.ts`）；`ok/warn/danger` 维持 `check/alert/alert`。新增 `apps/web/src/ui/feedback.test.ts` 锁定映射与封闭集完整性。修复后渲染确认截图：`audit-2026-11-02/fix-banner-icons/gallery-banners-desktop.png`、`gallery-banners-390.png`。
- **复核结论**：全部 100+ 处 `Banner` 调用的 tone 使用语义正确，无需改 tone 的位置；两处记录待后续定夺（非本 bug）：① 诊断抽屉 `fixDone` 用 `info`，语义上更接近 `ok`（DiagnosticsPanel.tsx:460）；② `SyncStatus` 的 queued 态用 `pause` 图标（"待上线后生效"chip）属独立组件、语义为"排队等待"，可接受，不在本次映射修复范围。
- **期望（已达成）**：`info`/`neutral` 用圆圈 i 信息图标，靠蓝/灰色区分强调级别。

### P0-2 节点模式选项卡无语义图标、无选中态

- **页面/元素**：节点设置 · 节点模式分段，"组网节点 / Caddy 网关"两张选项卡
- **截图**：26-hub-settings-mode.png
- **问题**：① 两张卡左侧图标同为灰色"||"（P0-1 的受害者），组网与网关无任何视觉区分；② 当前模式仅靠卡片外上方一枚绿色"组网节点"徽章表示，选项卡本身无选中高亮、无勾选，第一眼看不出哪张是"当前"。这正是用户参考截图圈出的位置。
- **期望**：组网用网状/节点类图标、网关用 globe/服务器类图标；选中卡加高亮边框或右上角勾选标记，徽章与选中态二选一。

### P0-3 离线节点内网穿透页横幅堆叠 4 条 + 英文错误原文直出

- **页面/元素**：内网穿透（peer2-user-mode-test 离线）
- **截图**：11-wireguard-peers-offline.png
- **问题**：自上而下单页堆了 4 条横幅——"控制面不可达"（红，标题上方）、"节点不可达"（红）、"节点未上报 WireGuard 适配器"（黄）、"节点未上报端口转发适配器"（黄，端口转发区内）；其中"节点不可达"把 transport 层英文原文（"direct: TCP 直连失败: proxy request failed, cannot connect to the specified address"）直接当描述渲染。信息层级失控，次要信息完全抢占视线，且原始错误对用户无意义。
- **期望**：同类"不可达"合并为一条状态带级横幅（页面级一条），适配器未上报类的黄条合并或降级为区块内提示；英文错误细节收进"查看详情"折叠，不直接展示。

---

## P1（一致性问题，本阶段内修）

### P1-1 分段标题与卡片标题重复

- **页面/元素**：① 设置页"证书库"出现三次（面包屑"设置"→ Segmented"证书库"→ 卡片标题"证书库"）；② 站点页 Segmented"扩展应用"与卡片标题"扩展应用"、"证书"与"证书"重复；③ 应用详情页 Tab"配置"与卡片标题"配置"重复；④ 390px 下面包屑"站点"+ H1"站点"+ Segmented"站点"三叠（内网穿透同理）
- **截图**：04、07、08、30、m4、m5
- **期望**：卡片标题与分段名相同时省略卡片标题（规范层面补一条去重规则）。

### P1-2 分页组件样式不统一（规范偏差）

- **页面/元素**：应用详情页用下划线 Tabs（配置/变更预览/任务/版本历史），站点页、主机运维、节点设置、全局设置均用 Segmented 药丸
- **截图**：30 vs 06/16/25/04
- **期望**：统一为 Segmented 药丸（ui-guidelines 的既定范式），应用详情页的 4 个 tab 改造。

### P1-3 SSH 公钥空态"添加公钥"双入口且样式不一致

- **页面/元素**：主机运维 · SSH 公钥段空态：卡片内居中小蓝按钮"添加公钥"，卡片外左下又有"刷新 / + 添加公钥"主按钮
- **截图**：24-ops-keys.png
- **期望**：空态只保留一个主按钮（卡片内居中大按钮），卡片外保留"刷新"即可。

### P1-4 诊断抽屉计数徽章冗余

- **页面/元素**：诊断与操作抽屉顶部并列两个红色徽章"1 项需要处理 / 1 项错误"，语义重叠
- **截图**：18-ops-diag-drawer.png
- **期望**：合并为一个摘要徽章（如"1 项待处理"），分级靠列表内状态列表达。

### P1-5 诊断详情"影响"与"根因/建议"文本重复

- **页面/元素**：诊断详情区"影响"字段与下方说明文本内容几乎相同
- **截图**：19-ops-diag-detail.png
- **期望**：数据层去重，或 UI 上"影响"只保留一句话、细节放建议区。

---

## P2（细节打磨，可排期）

| # | 页面/元素 | 截图 | 问题 | 期望 |
|---|---|---|---|---|
| 1 | 各表格行内"更多操作"ghost icon-only 按钮 | 03/06/12/16 | 对比度过低，缩放下远看像"—"，容易被当成空列 | 提高图标对比度，或统一用 kebab"⋯"并保证可辨识 |
| 2 | 概览页箭头 | 02 | chip 内用"→"，卡片角标用"↗"，两种箭头混用 | 统一一种跳转箭头 |
| 3 | 进程表数字列 | 20 | PID/CPU/内存列左对齐 | 数字列右对齐，等宽字体更佳 |
| 4 | 主机运维状态带"运行 6 天" | 16/18 | 用 warn 橙色；正常运行时长不是警告（除非 rebootRequired 为真） | 确认数据来源；无警告语义时改 neutral |
| 5 | 移动端服务列表行 | m3 | 行名称下方多一行"—"占位 | 空值不渲染该行 |
| 6 | Peer 抽屉运维 tab | 15 | "获取状态"出现两次；"运维"小 pill 冗余 | 保留一个获取状态入口，去掉重复 pill |
| 7 | 实时观测输入框 | 25/m6 | placeholder"https://hub.example.com"与下方示例（节点真实地址）不一致 | placeholder 直接用示例地址或留空 |
| 8 | warn / danger 横幅图标 | 11/m4/m5/m6 | 两者同用三角图标，仅靠颜色区分 | 形状也区分（如 danger 用圆叉/八角），色弱友好 |

---

## 与 ui-guidelines / page-specs 的规范偏差（单列）

1. **P1-2**：应用详情页 Tab 样式违反"必须复用既有组件与交互范式"（Segmented 分段）。
2. 其余结构检查**符合规范**：行内按钮 ≤2、全页唯一抽屉、抽屉内无 Dialog、危险操作确认分级（17 重启 disabled + 提示、13 删除 Peer disabled 带 title）、术语统一（节点/站点/内网穿透/Peer/保存并生效）、六类页面归类正确。
3. 建议往 ui-guidelines 增补两条规则：① Banner tone→图标映射表作为令牌登记；② 分段名与卡片标题去重规则。

## 修复顺序建议

1. **P0-1**（feedback.tsx 一处映射）——收益最大，一次消除全站大部分错误图标。
2. **P0-2**（节点模式选项卡图标 + 选中态）——用户点名位置。
3. **P0-3**（离线横幅合并 + 错误信息折叠）——信息层级。
4. P1 一组（标题去重、Tab 统一、双入口、徽章合并）可合并为一个 UI 一致性 PR。
5. P2 随日常迭代捎带。
