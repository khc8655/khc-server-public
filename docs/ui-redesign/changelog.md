# ui-redesign 落地变更记录

> 状态：历史记录（**非权威**，仅落地备案） ｜ 适用范围：追溯 2026-11-02 八步落地过程 ｜ 最后核验：2026-11-05 ｜ 关联：`ui-guidelines.md`、`page-specs.md`（现行规范以这两份为准）
> 分支：`feat/ui-redesign` · 完成日期：2026-11-02
> 方案：八步实施（原方案记录 `docs/archive/ui-redesign/ui-ia-review.md` §5，**历史资料，不作为依据**）；本记录为落地备案，现行规范以 `ui-guidelines.md` + `page-specs.md` 为准。
> 规范：落地后的规范以 `ui-guidelines.md` + `page-specs.md` 为准（已与代码对齐）。

## 一、八步实施结果（commit 链）

| 步骤 | 内容 | Commit |
|---|---|---|
| ① 导航/路由收敛 | 取消 HubBar 二级胶囊，节点层一级导航 5 项；术语统一 | `116f8a2` |
| ② 全局三页 | 概览 A 型去操作；`/hubs` 恢复一级入口 + 模式列；设置页术语统一；节点行内删除移出 | `ff8caad` |
| ③ 节点概况 | 4 指标 + 「需要处理」TodoChips + 运行信息/最近操作；删明细卡与页头操作 | `9e195c7` |
| ④ 内网穿透合并 | `/wireguard` 吸收 `/forwards`（端口转发卡）与 `/peers`（行内"运维"抽屉 PeerOpsPanel） | `e78cbc2` |
| ⑤ 站点页重组 | Segmented [站点 | 扩展应用 | 证书] 三段；低频操作收进"高级"折叠 | `f3d2b2e` |
| ⑥ 主机运维重做 | 状态带（Agent/CPU/内存/磁盘/服务/运行）+ 四分段对象表 + 页面唯一抽屉（process/fw-edit/key-add/diag/diag-check）；诊断降级为状态带右侧入口 | `9efee56` |
| ⑦ 节点设置分区化 | Segmented 四分区 [Agent 与接入 | 节点模式 | 备份与恢复 | 危险区]；导入三步抽屉；删除节点 L3 入危险区 | `c4149b2` |
| ⑧ 应用详情微调 | 核验通过，无需改动：`app.apply` 文案已是"保存并生效"；install/uninstall/rollback 均按注册表 L2/L3 ConfirmAction；页头已有 sync 状态徽标 | — |

每步验证：`typecheck` + web 全量 vitest + `@khc/web build` 全绿后提交。

## 二、路由处置（暗路由 → 302 过渡）

删除/合并的旧路由均改为 **302 重定向**而非直接删除（理由：避免书签/外链 404；用户可见导航中已无入口，不构成第二操作入口）。确认无外部引用后可在后续版本删除重定向：

| 旧路由 | 302 去向 |
|---|---|
| `/certs` | `/settings?tab=certs` |
| `/hubs/:id/apps` | `/hubs/:id/sites`（扩展应用分段） |
| `/hubs/:id/forwards` | `/hubs/:id/wireguard`（端口转发卡） |
| `/hubs/:id/peers` | `/hubs/:id/wireguard`（行内"运维"抽屉） |
| `/hubs/:id/certs` | `/hubs/:id/sites`（证书分段） |

## 三、行为变化（相对旧 UI）

1. **诊断修复动作直接执行**：原 DiagnosticsDrawer 中修复动作有 ConfirmAction 二级确认，现改为抽屉内直接执行按钮（loading + fixDone/fixError 反馈），与应用页"保存并生效"同级。依据：抽屉内禁止再弹 Dialog（ui-guidelines §8.3）。
2. **删除节点 L2 → L3**：动作注册表 `hub.delete` 升为 L3（confirmName: hub），确认框内输入节点名解锁；入口从节点列表行内移到节点设置 · 危险区。
3. **备份导入改抽屉内三步**：选择文件 → 预览 → 确认，结果在抽屉内展示；移除原页面内联预览卡与结果卡。
4. **节点设置证书摘要卡删除**：由站点页"证书"分段（只读摘要 + 跳全局证书库）承接。
5. **服务重启为能力占位**：注册 `hostOps.svcRestart` 动作（L2），行内菜单恒禁用并提示"服务重启能力尚未开放，待 Agent 支持后启用"。

## 四、主要文件

- 重写：`pages/HubOpsPage.tsx`、`apps/node-settings/page.tsx`、`apps/diagnostics/DiagnosticsPanel.tsx`（新，替换 DiagnosticsCard/DiagnosticsDrawer）
- 新增：`apps/host-ops/StatusBar.tsx`、`OpsSegments.tsx`、`FirewallSegment.tsx`、`FirewallRulesEditor.tsx`
- 删除：`DiagnosticsCard.tsx`、`DiagnosticsDrawer.tsx`（诊断功能并入 DiagnosticsPanel + HubOpsPage）
- 保留未动：`ProcessDrawer/SshKeysDrawer/HostOpsActions/PeerOpsPanel`（Peer 运维抽屉依赖链）、`AgentCommandDrawer`、`ModeSwitchDrawer`

## 五、遗留待办 / 待用户决策

1. **Agent 能力（待拍板）**：`svc.restart` 白名单 verb（受管单元）与可选 `svc.logs` 只读 verb。落地后仅需放开 `OpsSegments.tsx` 中 `rowActionDisabled` 恒禁用逻辑（动作注册表已就位）。涉及 `agent/adapters/host_ops/` 与 `agent/tests/test_host_ops.py`，属核心冻结例外条款，需单独确认后实施。
2. **302 暗路由移除时机**：观察一段时间确认无外部引用后，删除 `app/router.tsx` 中 5 个重定向路由（见上表）。
3. **构建体积**：`@khc/web` 产物单 chunk 约 814 KB（gzip 244 KB），已有 chunk >500 KB 警告；后续可考虑路由级代码分割（非本次范围，遵循"不加新依赖"）。
4. **截图**：浅/深/390 三态截图待 PR 附上（AGENTS.md 红线 7）。

## 2026-11-05 规范补齐（仅文档）

- `ui-guidelines.md` 新增 §8.9 布局与栅格、§8.10 字阶与行高、§8.11 组件清单与四态、§8.12 交互约束、§8.13 响应式、§8.14 动效与反馈、§10 PR 自检清单、§11 参考样例。
- 修正内容最大宽度 1120px → `--content-max`（1200px），并补令牌引用规则。
- 术语统一表由 `ui-ia-review.md` §3.6 迁入 `ui-guidelines.md` §8.6；原文件已归档至 `docs/archive/ui-redesign/ui-ia-review.md`（历史资料）。
- 消除两处矛盾：抽屉内禁止叠加 Dialog；证书/变量删除改为关闭抽屉后的页面级 L2 ConfirmAction。
- 四页 Demo 归档到 `docs/ui-redesign/examples/2026-11-05/`，标注为样例、非权威。
- 旧 UI 规范载体统一归档到 `docs/archive/ui-redesign/`：`index.html`（自带色板）、`ui-ia-review.md`（IA 审查/旧术语表）、`audit-icons.md`、`audit-2026-11-02/`、`audit-2026-11-03/`；仓库内不再保留第二份色板/字阶。
- **未改动 `apps/web/` 生产 UI 代码。**（本 PR 合并后由 CI 自动部署，属既有流程。）
