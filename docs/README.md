# 文档索引

> 状态：现行 ｜ 最后核验：2026-11-13 ｜ 关联：`AGENTS.md` §5

这里只列现行文档，每类信息只有一个权威来源。目录规则见 `AGENTS.md` §5：`docs/plans/` 是提案，`docs/verification/` 是证据，`docs/archive/` 是历史，三者都不登记在这里，也不能作为规范依据。

## 入口

| 文档 | 内容 |
|---|---|
| `README.md` | 项目介绍与快速开始 |
| `AGENTS.md` | 红线、协作流程、文档规则 |
| `CONTRIBUTING.md` | 提交、PR 与 CHANGELOG 格式 |
| `CHANGELOG.md` | 版本变更 |
| `docs/plans/backlog.md` | 唯一的待办清单 |

## 架构与机制

| 文档 | 内容 |
|---|---|
| `docs/design-v3.md` | 冻结核心、适配器、连接、数据模型 |
| `docs/engineering/adr/` | 架构决策记录 |
| `docs/data-layering.md` | D1 只存配置，运行快照不落库 |
| `docs/live-observation.md` | 10s 快照轮询与观测票据 |
| `docs/dual-mode.md` | 节点双模式（wg / caddy） |
| `docs/diagnostics.md` | 7 个核心诊断码与 API |
| `docs/security-boundaries.md` | 沙箱、写盘白名单、鉴权、签名 |
| `docs/legacy-feature-inventory.md` | 旧系统功能对照 |

## 功能

| 文档 | 内容 |
|---|---|
| `docs/caddy-management.md` | Caddy 站点与服务 |
| `docs/port-forward.md` | 端口转发 |
| `docs/cf-dns.md` | Cloudflare DNS 集成 |
| `docs/host-ops.md` | 主机运维（含 `host-ops-async.md` 长动作） |
| `docs/host-ops-e2e.md` | 主机运维真机 E2E 步骤 |
| `docs/backup.md` | 备份恢复与密钥轮换 |
| `docs/agent-lifecycle.md` | Agent 安装、升级、卸载命令 |
| `docs/agent-releases.md` | Agent 发布包与签名 |
| `docs/install.md` | 安装预检与用户模式 |
| `agent/README.md` | Agent 内核与适配器契约 |
| `agent/adapters/host_ops/README.md` | host-ops 脚本加载方式 |

## UI

| 文档 | 内容 |
|---|---|
| `docs/ui-redesign/ui-guidelines.md` | 页面类型、交互范式、四态、文案 |
| `docs/ui-redesign/page-specs.md` | 路由与区块映射 |
| `apps/web/src/styles/tokens.css` | 设计令牌（唯一取值来源） |

`docs/ui-redesign/examples/` 是静态样例，不作为规范依据。

## 工程与运维

| 文档 | 内容 |
|---|---|
| `docs/engineering/release.md` | 版本规则、发版、回滚 |
| `docs/engineering/testing.md` | 测试分层与发版必测项 |
| `docs/engineering/d1-migrations.md` | D1 迁移执行与核对 |
| `docs/runbook/node-onboarding.md` | 节点接入 |
| `docs/runbook/troubleshooting.md` | 按症状排障 |
| `docs/runbook/disaster-recovery.md` | 控制面丢失后的重建 |
