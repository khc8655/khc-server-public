# UI 变更单 #013：Agent 安装/升级/卸载命令

- 状态：已实现（2026-10-26，C5 阶段一；截图 docs/ui/shots/agent-lifecycle.png）
- 路由：`/hubs/$hubId/settings` 新增「Agent」卡片；不新增路由/侧栏
- 依据：`docs/agent-lifecycle.md`

## 1. 内容

- Card：Agent 版本/运行模式/最后在线（`/state.agent` + node）；按钮「安装/升级/卸载」。
- 抽屉：模式（system/user）、packageUrl、sha256、purge（卸载）；生成命令 → CodeBlock + 复制；安装响应单独展示 token，命令通过 stdin 读取；提示长期密钥。
- 动作：`agent.installCommand` / `agent.upgradeCommand` / `agent.uninstallCommand`（只读，L1）。
- 状态：空/加载/错误（URL/sha/模式）/离线；手机全屏。
- 组件：Card、Badge、Drawer、Field、TextInput、Toggle、Button、CodeBlock、InlineError；不新增组件/样式。
