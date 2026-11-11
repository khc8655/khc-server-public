# UI 变更单 #016：写闸门拆分（保存 / 应用）+ 观测层 SSE

> 依据：`docs/plan-gate-split.md`（方案 A，主人 2026-11-01 拍板）；
> 观测通道 WS → SSE 见 `docs/live-observation.md` §3 修订。
> 关联：`docs/data-layering.md`（控制面/观测面双通道）、`docs/ui-changes/005-live-observation.md`。

1. **作用域**：节点层；涉及对象=应用配置编辑页（`/hubs/:hubId/apps/:app`）与节点设置页（`/hubs/:hubId/settings`）。
2. **流程**：F12 模板新增「离线保存」分支：保存成功 → Banner「已保存，待应用」→ 节点可达后点击应用。
3. **页面与模板**：T4 配置（SaveBar 保存不受通道限制）、T4 设置（实时观测入口保存解锁）；PageHeader sync 状态新增 queued 派生（rev > appliedRev）。
4. **入口**：不新增入口；保存入口维持 SaveBar 与动作区 `app.save`。
5. **动作清单**：
   - `app.save`（L1，审计 `app.config.put` 已有）：保存永远允许（纯 D1 写）；
   - `app.apply` / `app.plan` / `app.install` / `app.uninstall`（L2，审计已有）：需控制面可达（canApply）；
   - 节点设置「保存实时观测入口」（L1）：永远允许（PUT 节点字段，纯 D1 写）。
6. **组件**：Banner（已有）、SaveBar（已有）、Toast（已有）；无新组件。
7. **新文案**（`i18n/zh.ts`）：
   - `apps.pendingApplyTitle` =「已保存，待应用」；
   - `apps.pendingApplyDesc` =「配置已保存到仓库，但尚未下发到节点；节点可达后点击应用即可生效。」；
   - `toast.configSavedPending` =「配置已保存，尚未应用——节点可达后请点击应用」；
   - `channels.liveOnlyDesc` 修订：执行类暂停、配置保存不受影响。
8. **状态覆盖**：
   - 离线态：SaveBar 保存可用；动作区执行类禁用（原因 `controlUnavailableDesc`）；
   - 同步态：`rev > appliedRev` 时 Banner + PageHeader `sync: queued`；toast 用 `configSavedPending`；
   - 错误态：维持 `lastApplyError` 诊断路径（无改动）；
   - live-only：Banner 描述改为「执行类操作暂停，配置保存不受影响」。
9. **手机**：完整支持（控制面数据，无直连依赖——符合「移动端不直连 Hub」决策）。
10. **截图计划**：浅/深/390 各两张（离线编辑页保存成功 + 待应用 Banner），由本地 agent 在 VM 端验证时补齐。

## SSE 迁移（同 PR，无 UI 新增）

- `data/live.ts`：WebSocket → EventSource（`buildLiveSseUrl`，ticket 走查询串）；
- `data/channels.ts`：`canMutate` 拆为 `canSave`（恒真）+ `canApply`（= 控制面可达），保留 `canMutate` 兼容别名；
- `data/writeGuard.ts`：放行保存类 PUT（`/nodes/:id/apps/:app`、`/nodes/:id`），拦截执行类 POST；
- 契约：`liveTicketResponse.wsPath` → `livePath`（`@khc/contracts`）；
- Agent：`agent/khc/live.py` 重写为 SSE + `POST /_live/nudge`。
