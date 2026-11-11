# UI 变更单 #009：端口转发

- 状态：已实现（2026-10-26，staging 真机；截图 docs/ui/shots/port-forward*.png）
- 路由：`/hubs/$hubId/forwards`（节点 T2），替换占位页
- 依据：`docs/port-forward.md`、UI 规范 v2.2

## 1. 作用域与流程

- 节点层；对象为“转发规则”。
- 列表 → 添加/编辑抽屉 → 保存并生效；删除 L2；启停 L1。
- 固定安全警示：“转发端口没有应用层鉴权，请只暴露必要的服务。”

## 2. 页面

- 页头：标题 + 节点作用域 + 摘要 + 主操作「添加转发」。
- 表格：名称、协议、监听端口、目标、状态（生效/待应用/失败/停用）、备注、操作。
- 空状态：说明 + 添加。
- 抽屉：名称、协议（tcp/udp）、监听端口、目标主机、目标端口、启用、备注；保存/保存并生效。
- 手机：行显示名称/监听/目标/状态，其余详情；抽屉全屏。

## 3. 组件/文案/状态

- 组件：PageHeader、Banner、Card、Table、Drawer、Field、TextInput、Select、Toggle、Button、ConfirmAction、SaveBar、EmptyState。
- 不新增路由/侧栏；不新增组件/样式。
- 覆盖空/加载/离线/未应用/应用失败/停用。
