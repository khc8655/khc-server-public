# UI 变更单 #001：外壳基础（U1–U2）

- 状态：已获主人批准（"全部开始"，2026-10-26）
- 依据：`docs/ui/ui-spec.md` v2.2（§1–§4、§7）、`docs/ui/DECISIONS.md`

## 1. 作用域

全局层 + 节点层的外壳；涉及对象：节点（Hub）容器。本单**不新增业务对象**。

## 2. 流程

- F1 添加节点（全局层 T5 向导）：本单只做入口与最小表单（名称/地址/端口），完整向导后续单。
- F2 进入与切换节点（侧栏节点切换卡 + 面包屑）。

## 3. 页面与模板

| 路由 | 层 | 模板 | 本单范围 |
|---|---|---|---|
| `/login` | 全局 | 独立 | 用令牌重绘登录页 |
| `/` | 全局 | T1 概览 | 骨架：统计条 + 节点快捷入口（数据后续接） |
| `/hubs` | 全局 | T2 列表 | 节点列表 + 添加节点（现有功能） |
| `/hubs/:hubId` | 节点 | T1 概况 | 骨架：节点信息 + 应用列表（现有数据） |
| `/hubs/:hubId/apps/:app` | 节点 | T3 详情 | 保留现有应用页（后续单重做） |
| `/hubs/:hubId/*`（wireguard/sites/forwards/certs/activity/settings） | 节点 | T2/T4 | 本单只放占位页 |

## 4. 入口

- 添加节点：`/hubs` 页头右侧唯一主按钮（S1）。
- 节点内对象创建入口后续单再加。

## 5. 动作清单

| id | 标签 | 级别 | 任务 | 审计 |
|---|---|---|---|---|
| `hub.create` | 添加节点 | L1 | 否 | `hub.created` |
| `hub.open` | 打开 | — | 否 | — |
| `hub.delete` | 删除节点 | L2 | 否 | `hub.deleted` |

## 6. 组件

只用规范第 4 章组件：Button、Badge、StatusDot、SyncStatus、Tag、Card、Table、Tabs、Field、TextInput、NumberInput、Select、Toggle、Drawer、Dialog、Toast/Banner、PageHeader、Sidebar、Topbar、Breadcrumb、EmptyState、Skeleton、Steps。本单新建这些基础组件（`ui/`）。

## 7. 文案

来自 `i18n/zh.ts`；术语：节点/客户端/站点/转发/证书/应用；无 Emoji、无括号英文。

## 8. 状态覆盖

空（无节点）、加载（Skeleton）、错误（InlineError）、离线（Badge 离线 + 提示）、同步（后续应用页）。

## 9. 手机

完整支持侧栏折叠、表格横向滚动、抽屉全屏。

## 10. 截图计划

浅色、深色、390 宽各一张（实现后补；先建 `dev/gallery`）。
