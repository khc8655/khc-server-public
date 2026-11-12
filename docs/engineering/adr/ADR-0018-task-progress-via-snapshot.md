# ADR-0018: 任务进度随 10 秒快照下发

- 状态：提议
- 日期：2026-11-12
- 决策者：主人
- 关联：`docs/plans/ui-ia-redesign-2026-11-12.md` §4.8、§6、ADR-0010、`agent/khc/tasks.py`、`agent/khc/state.py`、`apps/web/src/data/snapshot.ts`

## 背景

长任务（安装、证书签发等）返回 taskId 后，前端各页把 taskId 存在组件 state 里，靠手动「刷新进度」读 `GET /tasks/:id`；离开页面 taskId 就丢失。
主人定案：面板不与 hub 保持长连接，面板只负责下发写请求并拿回 taskId；观测由浏览器读取。现行观测通道是 ADR-0010 的 10 秒快照轮询（SSE 已停用）。

## 选项

| 选项 | 做法 | 利 | 弊 |
|---|---|---|---|
| A 快照携带任务摘要（推荐） | `build_snapshot` 增加 `tasks`（进行中 + 10 分钟内结束，最多 10 条，日志末 3 行）；前端统一 TaskTracker | 复用已有轮询，直连模式零 Worker 请求；刷新页面后第一帧即可补全；不加接口 | 快照约增 2–4 KB；进度粒度 10 秒 |
| B 恢复 SSE 推送任务 | Agent SSE 帧带任务 | 实时 | 与 ADR-0010 相反，断线语义复杂 |
| C Worker 侧任务表 + 轮询 | D1 记录任务，前端轮询 Worker | 离线也能看历史 | 需长期写 D1 与 Worker 请求；主人已否决 |

## 决策

采用 A（待主人确认）：
1. Agent：`TaskManager.summaries(window_s=600, limit=10, log_tail=3)`，`build_snapshot` 带 `tasks`。不新增 HTTP 接口。
2. 契约：`agentSnapshotSchema.tasks` 为可选字段，旧 Agent 兼容。
3. 前端：TaskTracker 合并本页提交的 taskId 与快照任务；终态时按 app 失效相关查询；顶栏「任务」按节点显示；删除各页「刷新进度」。
4. 有进行中任务时，快照轮询不计入 60 次上限，会话最长 30 分钟（方案 D-3）。
5. 无观测通道的节点：任务下拉提供「查询一次」，经 Worker 读 `GET /tasks/:id` 一次（方案 D-8）。

## 影响 / 迁移 / 回滚

- Agent patch 版本递增；`docs/live-observation.md` 同步。
- 回滚：前端恢复各页 taskId 逻辑；Agent 字段可保留。

## 验证

- Agent 单测：窗口、条数、日志截断、重启后的 `agent_restarted` 任务。
- 前端：`snapshot.test.ts` 解析；`tasks.test.ts` 终态失效；各页 smoke。
- staging：安装一个目录应用，切换页面、刷新浏览器，进度连续可见。
