# UI 变更单 #012：节点模式（组网 Hub / 纯 Caddy 网关）

- 状态：已实现（2026-10-26，staging 往返验证；截图 docs/ui/shots/mode-*.png）
- **2026-10-29（#50）已被 #015 精简**：四视图改为了一屏，状态只留 3 态；本单的进度/结果/切回部分不再适用。
- 路由：`/hubs/$hubId/settings` 新增「节点模式」分区；不新增路由/侧栏
- 依据：`docs/dual-mode.md` §6/§7

## 1. 入口与布局

| 位置 | 内容 |
|---|---|
| 节点设置 | Card：「节点模式」+ 当前徽章（组网 Hub / Caddy 网关 / 未初始化 / 切换中 / 降级）+ 两模式说明 + 「切换模式」按钮 |
| 节点概况 | PageHeader 摘要追加只读模式徽章 |
| WireGuard 页 | caddy 模式：Banner「当前是 Caddy 网关模式，WireGuard 已停用」+ 表单只读、保存/应用禁用 |
| 转发页 | caddy 模式：Banner「端口转发依赖 WireGuard，当前不可用」+ 去设置链接 |

## 2. 切换抽屉（四视图，L2）

1. 预检：模式摘要 + blockers（禁用下一步 + 修复入口）+ warnings（可勾选确认）+ counts；
2. 确认：后果清单（断开客户端数/停用转发数/依赖 WG 的站点数；证书与站点不受影响）；
3. 进度：保存配置 → apply → 轮询状态；「在后台运行」仅关闭抽屉，不取消操作；
4. 结果：成功（新徽章/切回按钮）或失败（错误码/重试/撤销/查看诊断）。

## 3. 动作/状态

- 读：`GET /api/v1/nodes/:id/mode`（staleTime 10s）；切换沿用 `PUT /apps/wireguard` + `plan/apply` + `/state`。
- 动作：`node.mode.open`、`node.mode.switch`（L2）；不新增后端执行动作。
- 四态：未配置/加载/错误/离线；blocker 不可绕过；切换中不可重复进入。
- 手机：设置卡纵向；抽屉全屏；按钮 ≤2；后果清单不折叠。
- 组件：Card、Badge、Banner、Button、Drawer、Steps、ConfirmAction、CodeBlock；不新增组件/样式/依赖。

## 4. 验收

- 预检/确认/进度/结果四视图；blocker 禁用；L2 后果数量正确；成功自动刷新模式徽章；失败可重试/撤销；
- caddy 模式下 WireGuard/转发页只读；390 宽可用；截图 浅/深/390。
