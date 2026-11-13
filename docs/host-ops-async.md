# host-ops 长耗时动作任务化（issue #17）— 并行契约

> 状态：现行 ｜ 最后核验：2026-11-02 ｜ 关联：docs/host-ops.md
> 范围：host-ops 长动作（call_task）异步化
> 目的：`fw.apply` 可能超过 6 秒同步窗口。固定 `call_task` 契约，后端与 UI 可并行实现。
> 2026-10-29（#50）：`kill` 动词已移除，`call_task` 只剩 `fw.apply` 使用。

## 动作

- 保留 `call`（sync）给读动作和短写动作（version/status/processes/fw.show/keys.list/keys.add/keys.remove）。
- 新增 `call_task`：**mode=task, write=true**，参数与 `call` 完全相同：
  ```json
  { "target": "self|<peerId>", "verb": "fw.apply", "params": {...} }
  ```
- Agent 返回 task 信封：`{ "ok": true, "taskId": "..." }`。
- Worker 现有 `POST /nodes/:id/apps/host-ops/call_task` 透传；响应为 Agent envelope（含 taskId）。
- UI 轮询 `GET /api/v1/nodes/:id/tasks/:taskId`，直到 `state` 为 `done|error|canceled`。
  - `done` → `task.result` 即适配器 `call` 的返回（`{ok,v,data,error,target,verb,write,...}`）
  - `error` → `task.error`
  - 推荐 1s 间隔、120s 上限；取消/关闭抽屉时停止轮询。
- 后端 `HostOps` 增加 `actions` 元数据 `call_task: {mode:"task",write:true}` 与 `action_call_task()`；实现应复用现有 `_call` 逻辑，避免两份行为。
- 测试：task 模式提交返回 taskId；worker 轮询结果；UI data 层 `callHostOpsTask` 轮询 done/error。

## UI 使用范围

- FirewallDrawer：`fw.apply` 用 `call_task`（拿到 task 后再从结果取 token，进入 60s 确认倒计时）。
- 其他动作不变。


## 实现记录

- 后端：`agent/adapters/host_ops.py` 增加 `call_task`（task/write）+ `action_call_task`；`call` 行为不变。
- UI：`callHostOpsTask` 提交 + 1s 轮询（120s 上限，AbortSignal）；仅 FirewallDrawer `fw.apply` 使用。
- staging：`call_task fw.apply` 返回 taskId，轮询 done 得到 token，confirm 成功；测试规则已清空。
