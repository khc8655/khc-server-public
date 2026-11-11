# UI 变更单 #003：全局证书页（C3）

- 状态：已获主人批准（C3 开始，2026-10-26）
- 路由：`/certs`（全局层，T2）；抽屉 query `?drawer=issue|import`、`?drawer=cert:<id>`
- 依据：UI 规范 v2.2 §1.2 全局对象、T2、§4

## 作用域与流程
- 全局层对象 = 证书；证书可被任意节点的站点引用。
- F5 签发证书：页头主按钮 → 抽屉（自签 / ACME DNS-01 / 手动导入三选一）。
- F6 证书详情/导出：行内查看元数据、导出 PEM/KEY（L2 确认 + 管理员）。
- 删除：L2 确认；被站点引用时提示先解除。

## 页面/动作
| 路由 | 模板 | 内容 |
|---|---|---|
| `/certs` | T2 | 页头 + 证书表格（名称/域名/签发方式/到期/来源/操作） |
| 签发抽屉 | Drawer | 自签（域名/天数/密钥类型）→ 调节点 Agent `issue_selfsigned` → POST /certs |
| ACME 抽屉 | Drawer | 域名/Provider/凭据选择（来自 `/settings`，只显示键）/CA → Agent `issue_acme` 任务 → 轮询 → POST /certs |
| 导入抽屉 | Drawer | name/domains/certPem/keyPem/notAfter（可从 `inspect` 自动解析） |
| 详情/导出 | Dialog | 元数据 + CodeBlock 导出（复制/下载） |

动作：`cert.issue`（L1）、`cert.import`（L1）、`cert.export`（L2）、`cert.delete`（L2）。

## 组件/状态/手机
Table、Badge（签发方式/到期状态）、StatusDot、Drawer、Dialog、Field、TextInput、Select、Textarea、CodeBlock、SecretField、InlineError、EmptyState、Skeleton；空/加载/错误/离线（签发需要选定节点在线）；手机列表行。

## 数据契约
`GET/POST/DELETE /api/v1/certs`、`GET /certs/:id/material`；Agent 动作经 `/nodes/:id/apps/certificates/<action>`（无配置也可调用）。
