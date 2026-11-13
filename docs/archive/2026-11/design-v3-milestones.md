# design-v3 已完成章节（归档）

> 状态：历史 ｜ 最后核验：2026-11-13 ｜ 关联：`docs/design-v3.md`

从 `docs/design-v3.md` 原样移出的 §6–§10（对现有代码的处理、里程碑、不做的事、已拍板、二期）。

## 6. 对现有代码的处理

| 现有 | 处理 |
|---|---|
| Hono、登录/会话、错误格式、contracts 基础部分、CI、React 外壳 | 保留 |
| `peers` / `exposures` 的 CRUD 路由、仓库、测试 | 删除，改由 `app_configs` + 通用路由承担 |
| `migrations/0001_init.sql`（12 张表） | 尚未上线，直接改写为 §2.3 的 4 张表 |
| README / design-v1 中的 KV、R2、Cron、DO、WS、签名模块、transports | 标记为作废，避免本地 Agent 照旧文档把这些加回来 |

## 7. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **C1 核心** | Worker 通用路由 + 4 张表；Agent 内核（鉴权、任务、原子写回滚、端口、Caddy 片段）；外壳 + 共享组件 + 通用 Schema 表单 | §3.4 用 node-exporter 演练：只加两个文件即可跑通全流程 |
| **C2 WireGuard** | wireguard 适配器 + 页面 + 5.3 轮换状态机 | 测试 VM 上：手机轮换，切换间隙 ≤2s；PENDING 期间旧钥流量不中断；回滚可用；Agent 重启后轮换状态恢复 |
| **C3 常用软件** | caddy-site、port-forward、chisel；其余应用待定 | 每个应用只新增两个文件 |

## 8. 不做的事

服务器监控、告警、指标图表（已有大量现成工具）；心跳和后台同步；离线命令队列；签名插件市场；多用户和权限系统。

## 9. 已拍板（2026-10-25）

| # | 问题 | 决定 |
|---|---|---|
| 1 | Hub 入口 | Caddy 高位端口 + HMAC（历史决定）；**2026-11-06 口径修订**：三种并列接入方案、节点选定其一、不做主备切换（见 §1.1） |
| 2 | 手机类 peer 私钥 | 加密存入 D1（`secrets_enc`），以便重新下载配置 |
| 3 | 轮换时限 | 宽限期 24h，PENDING 超时 7 天 |
| 4 | Agent / 适配器语言 | 一期使用 Python（只用标准库）；**单文件 Go Agent 放到二期** |
| 5 | 无 root peer | 默认用 chisel（WSS），wireproxy 作为可选 |
| 6 | 直连端口/证书 | 默认 8443 + 橙云 + Cloudflare Origin CA；灰云任意端口 + acme.sh；`compatibility_date ≥ 2024-09-02` |
| 7 | 无 root peer 控制通道 | 用户态 cloudflared 直连 Worker（核心不加代理）；chisel 仅数据面 |

## 10. 二期（不在本期范围）

- Agent 改写为单文件 Go 二进制。适配器接口 `api` 保持不变，Python 适配器通过子进程方式继续兼容，或逐个迁移。
- 具体常用软件的适配器清单（待定）。
