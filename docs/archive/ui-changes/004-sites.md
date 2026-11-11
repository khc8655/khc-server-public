# UI 变更单 #004：节点站点页（C3）

- 状态：已获主人批准（C3 开始，2026-10-26）
- 路由：`/hubs/:hubId/sites`（节点层，T2）；抽屉 `?drawer=site:new|site:<name>`
- 依据：UI 规范 v2.2 T2/F5、`docs/c3-plan.md` §5.1

## 作用域与流程
- 节点层对象 = 站点；站点可引用全局证书。
- 添加/编辑站点：域名、监听端口（443/8443/80）、上游、TLS 模式（auto/manual/off）、证书选择、BasicAuth（用户名 + 密码→Agent `hash_password`）、Header、TLS1.3、启用。
- 保存（只写 D1）与「保存并生效」（PUT + apply）。
- 行内：编辑、启用/停用、删除（L2）、状态（Caddy active / 最近错误）。

## 页面/动作
| 路由 | 模板 | 内容 |
|---|---|---|
| `/hubs/:hubId/sites` | T2 | 页头 + 同步状态 + 站点表格（域名/端口/上游/TLS/证书/状态/操作） |
| 站点抽屉 | Drawer | 表单 + 校验 + 保存/保存并生效 |
| 证书选择 | Select | 来自 `GET /certs`；显示域名与到期 |
| 删除 | ConfirmDialog | 写明站点立即下线 |

动作：`site.create`（L1）、`site.update`（L1）、`site.delete`（L2）、`site.toggle`（L1）。

## 组件/状态/手机
Table、SyncStatus、Drawer、Dialog、Field、TextInput、PortInput、Select、Toggle、SecretField、KeyValue、Banner、InlineError、EmptyState、Skeleton；空/加载/离线/未应用/校验失败（caddy validate 错误展示 details）；手机列表行。

## 数据契约
配置 `PUT /nodes/:id/apps/caddy-site`（config.sites[]，证书用 `{"$cert":"id"}`）；动作 `plan/apply`、`hash_password`；状态 `GET /nodes/:id/state` 的 caddy-site adapter status。
