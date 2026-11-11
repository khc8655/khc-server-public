# UI 变更单 #002：节点层 WireGuard 页（C2）

- 状态：已获主人批准（"全部开始"，2026-10-26）
- 依据：`docs/ui/ui-spec.md` v2.2（§1 作用域、F3/F4、§4 组件）、变更单 #001 外壳
- 路由：`/hubs/:hubId/wireguard`（节点层，T2 列表）；抽屉状态写入 query `?drawer=peer:<name>` / `?drawer=new`

## 1. 作用域

节点层；对象 = 客户端（Peer），父容器 = 节点。不得在全局层出现 Peer 创建/编辑/删除。

## 2. 流程

- **F3 添加客户端**：页头主按钮 → 抽屉；字段：名称、AllowedIPs（默认分配下一个 /32）、Keepalive（默认 25）、公钥（可选，留空由 Agent 生成）。
- **F4 管理客户端**：行内 ⋯ → 编辑 / 导出配置 / 轮换密钥 / 停用 / 删除（L2 确认）。
- **接口配置**：页头「接口设置」→ 抽屉（地址、监听端口、MTU、出口网卡、公网 Endpoint）。
- **换钥**：行内「轮换密钥」→ 生成新配置并显示「等待新设备握手 · 旧密钥仍有效」；提供「取消」「确认完成」；CUTOVER 后显示回滚窗口。
- **导出配置**：客户端配置以 CodeBlock/SecretField 展示，复制 + 下载 `.conf`；二维码后续单（无依赖）。

## 3. 页面与模板

| 路由 | 模板 | 内容 |
|---|---|---|
| `/hubs/:hubId/wireguard` | T2 | 页头（标题 + 作用域标签 + 主按钮「添加客户端」）→ 同步状态 → 客户端表格（名称/地址/状态/最新握手/流量/操作） |
| 接口设置 | Drawer | 表单 + 保存（保存到仓库，不直接 apply） |
| 客户端详情/编辑 | Drawer | 表单 + 保存 |
| 导出配置 | Dialog | CodeBlock + 复制/下载 + 说明 |
| 换钥 | Drawer/Banner | 新配置 + 状态条 + 取消/确认 |

## 4. 动作清单

| id | 标签 | 级别 | 任务 | 审计 |
|---|---|---|---|---|
| `peer.create` | 添加客户端 | L1 | 否 | `peer.created` |
| `peer.update` | 编辑 | L1 | 否 | `peer.updated` |
| `peer.delete` | 删除客户端 | L2 | 否 | `peer.deleted` |
| `peer.disable` | 停用 | L1 | 否 | `peer.disabled` |
| `peer.exportConfig` | 导出配置 | — | 否 | — |
| `peer.rotate` | 轮换密钥 | L2 | 否 | `peer.rotate.started` |
| `peer.confirmRotation` | 确认完成 | L1 | 否 | `peer.rotate.confirmed` |
| `peer.cancelRotation` | 取消 | L1 | 否 | `peer.rotate.canceled` |
| `wg.interface.update` | 接口设置 | L1 | 否 | `wg.interface.updated` |

## 5. 组件

Table、Badge、StatusDot、SyncStatus、Drawer、Dialog/ConfirmDialog、Field、TextInput、NumberInput、PortInput、Select、Toggle、SecretField、CodeBlock、KeyValue、Banner、InlineError、EmptyState、Skeleton、Toast、PageHeader、ScopeChip、Breadcrumb。

## 6. 文案

`i18n/zh.ts`：客户端 / 接口 / 轮换密钥 / 等待新设备握手 / 旧密钥仍然有效 / 已切换 / 回滚 / 确认完成 / 最新握手 / 接收 / 发送。无 Emoji、无括号英文。

## 7. 状态覆盖

- 空：无客户端 → EmptyState + 主按钮；
- 加载：Skeleton；
- 离线：节点不可达 → Banner + 禁用写操作；
- 未应用：D1 rev ≠ agent appliedRev → SyncStatus「有未应用的改动」+ 保存并生效；
- 换钥 pending/cutover/宽限期 → Banner 与行内 Badge；
- 错误：InlineError + 重试。

## 8. 手机

表格转列表行（名称/状态/握手），操作收进 ⋯；抽屉全屏。

## 9. 截图计划

浅色、深色、390 宽各一张（列表 + 抽屉 + 换钥状态）。
