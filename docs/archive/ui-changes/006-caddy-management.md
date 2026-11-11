# UI 变更单 #006：Caddy 管理完整能力

- 状态：已实现（2026-10-26，staging 真机）
- 路由：`/hubs/$hubId/sites`（节点 T2）与站点抽屉/服务抽屉
- 依据：`docs/caddy-management.md`、UI 规范 v2.2

## 1. 流程

- F7 添加站点：页头「添加站点」→ 抽屉；先选类型（反代/静态/跳转），字段随类型显示。
- F8 编辑/启停/删除：行内操作；删除 L2。
- F9 Caddy 服务：页头「Caddy 服务」→ 抽屉：状态、validate、reload、导出配置。
- 清空站点：页头次操作，L2 确认，保存空列表并 apply。

## 2. 页面/动作

| 动作 id | 标签 | 级别 | 任务 |
|---|---|---|---|
| `site.create` | 添加站点 | L1 | 否 |
| `site.update` | 保存 | L1 | 否 |
| `site.delete` | 删除站点 | L2 | 否 |
| `site.toggle` | 启用/停用 | L1 | 否 |
| `site.clear` | 清空站点 | L2 | 否 |
| `caddy.reload` | 重载 Caddy | L2 | 否 |
| `caddy.export` | 导出配置 | L2 | 否 |

## 3. 表单分组

基础（类型/域名/端口/启用）；反代（上游多值、负载均衡、健康 URI、路径路由）；静态（root/browse/SPA/index）；跳转（目标/状态码）；TLS（auto/manual/internal/off + 证书选择 + TLS1.3）；安全（BasicAuth、headers、HSTS、安全头、压缩、最大请求体、IP 允许/拒绝）；日志；观测入口（liveGateway）。

## 4. 状态

空/加载/离线/未应用/validate 失败（错误 details）/健康状态四态（正常/告警/不可用/未知）。

## 5. 手机

分组折叠为顺序区块；表格列表行显示域名/类型/健康/操作。
