# UI 变更单 #010：节点备份与恢复

- 状态：已实现（2026-10-26，staging 真机；截图 docs/ui/shots/backup-settings.png）
- 路由：`/hubs/$hubId/settings`（T4），替换占位页
- 依据：`docs/backup.md`

## 1. 作用域与流程

- 节点层；对象为“节点备份”。
- 导出：点按钮立即下载 JSON。
- 导入：选择文件 → 预览应用/配置版本 → 确认 → 显示每个应用的新 rev；提示“配置已导入，需逐项应用”。

## 2. 页面

- 页头：标题 + 节点作用域 + 摘要。
- 「备份与恢复」卡片：
  - 导出按钮 + 说明（不含 token/证书私钥）
  - 文件选择 + 预览（应用名、schemaVersion）+ 确认导入
  - 成功结果列表；失败 InlineError（格式/版本/后端错误）
- 无新路由/侧栏/组件；手机纵向。

## 3. 组件/状态

PageHeader、Card、Banner、Button、Table、FileInput/CopyButton、InlineError、EmptyState；空/加载/成功/失败/无效文件。
