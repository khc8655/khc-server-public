# 方案：写闸门拆分（离线保存 / 在线应用）

> 状态：**待主人拍板**（2026-11-01 提出）
> 适用范围：写闸门拆分设计（保存永远允许 + SSE） ｜ 最后核验：2026-11-02（docs consolidation） ｜ 关联：docs/live-observation.md、PR #56
> 关联：`docs/data-layering.md`、`docs/live-observation.md` §7-3（nudge→desired 欠账）、UI 规范 §7.1（变更单门禁）
> 依据：主人拍板的分层模型——**配置域**（D1 authority，始终同步，与通道无关）与**实时域**（plan/apply、live 观测、host-ops 等必须走直连通道）。

---

## 0. 问题

前端闸门 `channels.ts` 的 `canMutate = (controlReachable === true)` 把所有写操作一刀切：Worker→Hub RPC 不通时，**保存配置（纯 D1 写）也被禁用**。而数据层早已支持离线保存——离线保存能力被 UI 锁死。

| 操作 | 应有的约束 | 现状 |
|---|---|---|
| 保存配置（`PUT /nodes/:id/apps/:app`，只写 D1，rev+1） | 永远允许 | 被禁 ❌ |
| apply / plan / rollback（RPC 到 Hub） | 需要通道 | 被禁 ✅ |

## 1. 已验证的事实（冒烟证据）

新增 `apps/api/test/smoke-offline-save.test.ts`（已通过；全套 287/287 绿）：

| # | 场景 | 结果 |
|---|---|---|
| 1 | Hub 不可达时 `PUT` 保存 | ✅ 200，rev 2，`appliedRev` 保持 1 |
| 2 | Hub 不可达时 `apply` | ✅ 失败（不挂起），`last_apply_error` 记录错误码 |
| 3 | Hub 恢复后 `apply` | ✅ 携带 `expectRev=2`（离线保存的 desired 自动生效），`appliedRev` 回写 2 |

**结论：后端两级模型天然成立，git-ops 语义（rev 领先 applied_rev = 已保存待应用）无需任何服务端改动。改动范围仅前端闸门与展示。**

关键代码锚点：
- 保存路径只写 D1：`apps/api/src/routes/apps.ts:161`（注释原文「只写 D1 + revisions，不碰 Hub」）
- apply 回写：`apps/api/src/routes/apps.ts:259`（`appliedRev ?? rev ?? expectRev`）
- 闸门现状：`apps/web/src/data/channels.ts:52`、`apps/web/src/data/writeGuard.ts`（按 URL 前缀拦所有 mutating）
- 页面使用：wireguard / caddy / forward / node-settings / peers / hub-ops 共 6 处 `actionsDisabled={!channels.canMutate}`

---

## 2. 方案 A：前端闸门拆分 +「已保存未应用」标识（推荐，最小改动）

**原则：保存永远允许；执行（apply/plan/rollback/自定义动作）才需要通道。**

### 2.1 闸门拆分

`channels.ts`：

```ts
canSave: true,                       // 保存（写 D1）永远允许
canApply: controlReachable === true, // 执行类动作需要控制面可达
```

`writeGuard.ts` 按路径细分：

| 请求 | 处理 |
|---|---|
| `PUT /api/v1/nodes/:id/apps/:app`（保存配置） | 放行 |
| `POST /api/v1/nodes/:id/apps/:app/:action`（plan/apply/rollback/自定义动作） | 维持拦截 |
| 其余节点级 mutating（host-ops、转发新建、WG peer CRUD 等即时执行类） | 维持拦截 |

> 注意：peer CRUD / 转发新建等**即时执行类**操作虽然也写 D1，但同时立刻 RPC 到 Hub，离线时必然失败，维持禁用是诚实的。仅「保存-应用」两段式的配置编辑解锁离线保存。

### 2.2 「已保存未应用」标识

数据全部现成（`rev` / `appliedRev` / `lastApplyError`），只差展示：

- 配置编辑页 SaveBar：`rev > appliedRev` 时显示徽标「已保存 · 待应用」；保存成功 toast 文案区分「已保存，待应用」vs「已保存并应用」
- 应用列表行：`rev !== appliedRev` 的行加徽标；`lastApplyError` 非空的行加错误徽标（点击进诊断）
- Hub 恢复在线时：待应用行出现「应用」快捷按钮（复用现有 apply 动作）

### 2.3 防误会设计（本方案的核心风险）

用户离线改配置容易误以为「保存 = 生效」。三道防线：

1. 保存 toast 明示「已保存，**尚未应用**——节点可达后点击应用」
2. 徽标持续可见（不是一次性提示）
3. 离开页面再回来，徽标仍在（数据来自 D1，天然持久）

### 2.4 涉及文件

| 文件 | 改动 |
|---|---|
| `apps/web/src/data/channels.ts` | `canMutate` 拆为 `canSave` + `canApply`（保留 `canMutate` 兼容别名过渡） |
| `apps/web/src/data/writeGuard.ts` | 按 2.1 表细分放行/拦截；单测同步 |
| 6 个页面 | 保存按钮与执行按钮分别绑 `canSave` / `canApply` |
| `apps/web/src/data/channels.test.ts` 等 | 断言更新 |
| UI 变更单 | 按 §7.1 提交（草案见第 5 章） |

工作量估计：1 个 PR，前端为主，无契约/表结构/Agent 改动。

---

## 3. 方案 B：A + nudge→desired 闭环（Hub 恢复自动收敛）

在 A 之上补完 `live-observation.md` §7-3 欠账：Hub 恢复在线或收到 nudge 时，Agent 主动拉取 desired 并自动 apply。手机改完配置 → Hub 自动收敛，无需人工补 apply。

**需要单独论证的安全点（本方案暂不拍板的原因）：**

1. **自动 apply 的安全边界**：离线期间可能改了多条配置，恢复后一把全应用。要不要「自动应用开关」（节点级，默认关）？要不要先 plan 汇总 diff 给用户确认？
2. **冲突处理**：Hub 本地被手工改过（drift）时，自动 apply 会覆盖手工修改——需要 drift 检测（`expectRev` 比对已有，Agent 返回 drift 时降级为人工确认）。
3. **nudge 触发链**：Worker 保存配置后，若该节点 live 通道在线则推 nudge（现架构已支持 scope=nudge，Agent 端 `on_nudge` 目前仅 `LOG.info`，见 `agent/khc_agent.py:138`）；live 不在线则靠 Hub 恢复时的自检（需要 Agent 增加启动/重连后对账逻辑）。

建议作为独立 PR 排在 A 之后（P2），先 A 拿到「人工补 apply」的可用闭环，B 只是把最后一步自动化。

## 4. 方案 C：仅提示不改闸门（对照项，不推荐）

离线时提示「当前只读，配置查看不受影响」，保存按钮维持禁用。不解决主人要的「通道不通也能改配置」能力，仅列出作对照。

---

## 5. UI 变更单草案（方案 A 的，编号待登记）

```
UI 变更单 #NNN（草案，随方案 A 一并拍板）
1. 作用域：节点层；涉及对象=应用配置编辑页（wireguard/caddy/forward/node-settings）与应用列表行
2. 流程：F12 模板新增「离线保存」分支：保存成功 → 徽标「已保存待应用」→ 在线后应用
3. 页面与模板：T4 配置（编辑页 SaveBar）+ T2 列表（应用行徽标）
4. 入口：不新增入口；「应用」快捷按钮出现在已保存待应用的行上（在线时）
5. 动作清单：保存（L1，审计 app.config.put 已有）；应用（L2，审计 app.apply 已有）；无新动作
6. 组件：Badge（已有）、SaveBar（已有）、Toast（已有）；无新组件
7. 新文案：zh.apps.savedPendingApply=已保存，待应用；zh.apps.appliedRevBadge=待应用；zh.apps.applyNow=立即应用
8. 状态覆盖：离线态=保存可用+执行禁用（原因文案 controlUnavailableDesc）；同步态=徽标+快捷应用；错误态=lastApplyError 徽标进诊断
9. 手机：完整支持（控制面数据，无直连依赖——符合移动端定位）
10. 截图计划：浅/深/390 各两张（离线编辑页、待应用列表行）
```

---

## 6. 验收（方案 A）

- [ ] Hub 离线：保存成功、徽标出现、执行按钮禁用并显示原因
- [ ] Hub 恢复：徽标行的「立即应用」可用；apply 后徽标消失
- [ ] apply 失败：`lastApplyError` 徽标 + 错误码可进诊断
- [ ] 现有 287 测试全绿 + 新增闸门单测（writeGuard 放行 PUT / 拦截 POST）
- [ ] VM 端真机：本地 agent 验证（主人侧执行）——断网改配置 → 恢复 → 应用

## 7. 已知取舍

| 取舍 | 理由 |
|---|---|
| 保存与执行之间可能长时间悬空（rev 领先） | 这正是 git-ops 语义，徽标消除误会 |
| 离线保存的配置未经 plan 校验 | 与现状一致（plan 本来就在线）；风险由「在线后先 plan 再 apply」的既有流程兜底 |
| peer CRUD 等即时执行类不解锁 | 它们不是两段式，离线必失败，解锁无意义 |
