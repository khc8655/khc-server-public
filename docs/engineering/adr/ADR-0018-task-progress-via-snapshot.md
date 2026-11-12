# ADR-0018: 任务进度随 10 秒快照下发（2026-11-12 重开：B3 任务快照）

- 归类：决策记录
- 状态：**已接受**（主人 2026-11-12 重开；取代同日「不做」的旧决定）
- 适用范围：`agent/khc/tasks.py`、`agent/khc/state.py`、`packages/contracts/`（`tasks` 可选字段）、`apps/web/src/app/TaskCenter.tsx`、`apps/web/src/data/tasks.ts`
- 最后核验：2026-11-12
- 关联：ADR-0010（10 秒快照）、ADR-0013（发版分层）、`docs/plans/ui-ia-redesign-2026-11-12.md`、`docs/ui-redesign/page-specs.md`

## 背景

长任务（安装、证书签发等）返回 taskId 后，前端各页把 taskId 存在组件 state 里，靠手动「刷新进度」读 `GET /tasks/:id`；离开页面 taskId 就丢失。刷新页面后无法发现之前创建的任务。

同日早先曾拍板「不做」，理由是触碰核心冻结且担心要放宽 60 次轮询上限。重开时明确：**不放宽轮询预算**，任务摘要只作为既有响应的小字段，随现有 10 秒快照下发。

## 选项

| 选项 | 做法 | 利 | 弊 |
|---|---|---|---|
| **A 快照携带任务摘要（选定）** | `build_state` / `build_snapshot` 增加可选 `tasks`；进行中优先、最多 5 条、日志末 4 行、整段 ≤6 KiB | 复用已有轮询；刷新页面第一帧即可补全；不新增接口/请求/轮询 | 触碰 `agent/khc/` 与契约（核心冻结）；需要脱敏与上限 |
| B 恢复 SSE 推送任务 | Agent SSE 帧带任务 | 实时 | 与 ADR-0010 相反，断线语义复杂 |
| C Worker 侧任务表 + 轮询 | D1 记录任务，前端轮询 Worker | 离线也能看历史 | 需长期写 D1 与 Worker 请求；主人已否决 |
| D 纯前端汇总 | 前端保存 taskId 并轮询 `/tasks/:id` | 不改后端 | 刷新/换页即丢 taskId；必须新增请求或轮询，违反本轮约束 |

## 决策

采用 A，并遵守以下硬约束：

1. **不新增接口**：`tasks` 是 `GET /state` 与 `GET /_live/snapshot`（Worker 转发 `/nodes/:id/snapshot` 复用同一 `build_snapshot`）的可选顶层字段。
2. **不新增请求、不新增轮询**：前端只读现有 10 秒快照；**10 分钟 / 60 次封顶不变**，不因任务进行中而放宽。
3. **字段**：`{items:[{id, app, action, state, progress, createdAt, updatedAt, logs, errorCode?, errorMessage?}], total, truncated}`；不返回 `result`、`error.details`、traceback。
4. **上限**：单次最多 5 个任务；`tasks` 序列化后 ≤6 KiB（UTF-8）；超预算时丢弃最旧终态任务，`truncated=true`，`total` 保留真实总数。空任务返回空 `items`，不省略字段。
5. **脱敏**：私钥 PEM 块、`token/password/passwd/secret/api_key/private_key/preshared_key/psk/authorization` 的 key-value、Bearer/Basic、URL userinfo、URL 查询串中的凭据统一替换为 `[REDACTED]`；日志末 4 行、每行 ≤160 字符，错误消息 ≤200 字符。
6. **旧 Agent 兼容**：契约字段 optional；旧 Agent 不返回时前端显示「当前 Agent 不提供任务快照，升级后可见」，不报错。
7. **UI**：顶栏任务入口只在节点上下文出现；全局页（概览 / 节点列表）没有节点上下文时**隐藏**（没有数据源，禁用按钮只会留死控件）。抽屉只读，不提供危险动作。

## 为什么必须动 `agent/khc/` 与 `packages/contracts/`

- 任务状态只存在于 Agent（`TaskManager` 内存 + `tasks/*.json`）。纯前端无法发现刷新前创建的 taskId；方案 D 因此被否。
- 最小改动是在 `agent/khc/tasks.py` 增加只读摘要序列化，并在 `agent/khc/state.py` 挂到既有 `build_state` / `build_snapshot`；不引用应用名，不碰内核编排。
- 契约新增 optional 字段，保证前后端类型一致并允许旧 Agent 缺失；不新建 D1 表、不加迁移、不新增路由。

## 影响 / 迁移 / 回滚

- 无 D1 迁移；旧 Agent 与新面板、新 Agent 与旧面板均兼容。
- `/state` 与快照体积增加有硬上限（≤6 KiB），不改变轮询频率。
- 回滚：移除 `state.py` 的 `tasks` 注入与前端 `TaskCenter` 即可；契约 optional 字段可保留。

## 验证

- Agent 单测：任务字段序列化、日志脱敏、截断、任务数为 0、上限/字节预算、旧内核缺少任务管理器。
- 前端测试：有任务 / 无任务 / 旧 Agent 无字段 / 离线四态；全局页顶栏入口隐藏；打开抽屉不新增请求。
- `./scripts/verify.sh` 全绿。
