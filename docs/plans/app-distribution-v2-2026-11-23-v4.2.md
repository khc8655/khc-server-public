# V4.2 开工说明：升级 / 卸载的控制面步骤引用无默认值参数

> 状态：已拍板 ｜ 最后核验：2026-11-23 ｜ 关联：`docs/plans/app-distribution-v2-2026-11-23.md` §15.3；`docs/plans/app-distribution-v2-2026-11-23-v4.1.md`；`docs/verification/2026-11-23/manifest-upgrade-values.md` §四

> **给开发 agent**：开工前提：V4.1 已合入（#162），其真机证据已合入（#164）。本批只改 **Worker + 一处前端文案布局 + 文档**，不改契约与 Agent。认为本文有误时在 PR 里提出，不要改 `docs/plans/` 下的文件。

## 0. 速览

| 项 | 值 |
|---|---|
| 分支 | `fix/manifest-hook-param-refs`（从最新 `main` 拉，独立 worktree） |
| PR 标题 | `fix: 升级/卸载控制面步骤禁止引用无默认值参数（V4.2）` |
| 发版类型 | A + W，面板 **patch → 0.41.2**；Agent 不变 |

## 1. 问题（V4.1 真机证据 §四-1，已核实）

`hooks.preUpgrade` / `hooks.preUninstall` 在 Worker 渲染，Worker 永远拿不到节点上的安装值（提案 §15.1）。若它们引用**无默认值**的 `{{params.<key>}}`：

- 升级：用户不填该参数时 Worker 返回 400 `template_missing_var`（`details.variable`），不带 `details.field`，前端折叠区不展开，用户没有补填入口；
- 卸载：同样在 Worker 就失败；`template_missing_var` 不是 `hook_failed`，抽屉也不给「跳过控制面步骤强制卸载」，**应用卸不掉**（V5b 也救不了，因为问题在 Worker）。

保存提醒（V4.1 §2-4）只是提示，挡不住这种清单。

## 2. Worker

1. **保存时拒绝**（`apps/api/src/routes/appManifests.ts`，`POST` 与 `PUT`）：`preUpgrade` 或 `preUninstall` 的 `url` / `headers` / `body` 引用 `{{params.<key>}}`，且该参数在清单 `params` 里**没有 `default`**（含 `derive` 参数）→ 400 `manifest_invalid`，`message` 写明阶段与参数名，例如「preUninstall 引用了无默认值的参数 tag：升级 / 卸载时控制面步骤拿不到安装值，请为该参数设置默认值，或改为在 preInstall 里使用」，`fields` 指向 `manifest.hooks.<stage>`。引用**有默认值**的参数仍只给现有 warning。`preInstall` 不受限。实现与现有 `checkManifestParamRefWarnings` 共用变量收集逻辑，不改契约。
2. **执行时兜底**（`apps/api/src/lib/manifest-hooks.ts` `mapTemplateError`）：D1 里已有的旧清单绕过了第 1 条。`TemplateRenderError` 的 `variable` 形如 `params.<key>` 时，改为抛 400 `param_invalid`，`details: { field: '<key>', variable: 'params.<key>' }`（`code` 与 V5b Agent 的参数错误一致）；其他变量（`secret.*`、`hook.*`、`node.*`）保持 `template_missing_var` 不变。
3. 测试：保存——preUpgrade / preUninstall 引用无默认值参数 → 400（POST、PUT 各一）；引用有默认值参数 → 201/200 + warning；preInstall 引用无默认值参数 → 正常保存。执行——旧清单（直接写 D1 绕过校验）升级不填参数 → 400 `param_invalid` + `details.field`；填了 → 正常；`secret.*` 缺失仍为 `template_missing_var`。

## 3. 前端

1. 升级：`InstalledAppDrawer.tsx` 已按 `details.field` 处理，**同步错误（`runAppAction` 抛出的 ApiError）与任务失败两条路径都要走到同一段定位逻辑**——核对现实现对 ApiError 是否生效（V4.1 证据 d-1 里确认条被关闭），不生效就修，并补一条测试：`runAppAction` 直接抛 `ApiError(400, 'param_invalid', …, { field: 'tag' })` → 折叠区展开、`tag` 标红、确认条保持打开。
2. 卸载：`param_invalid` 时在错误下方加一句「该应用清单的卸载步骤缺少参数 X：到『设置 → 应用管理』为它设置默认值后重试」，并给 `?manifest=<id>` 跳转链接（复用 `ManifestErrorAlert` 的修复入口样式）。不在卸载里加参数表单。
3. 390 宽：升级确认里「Agent < 0.8.1」提示与确认标题被截断（证据 §四-3）。把长句放进 `Banner` 的 `description`（可换行），`title` 只留短句；确认标题同理。
4. 测试按上面各一条；源码扫描继续通过。

## 4. 文档、版本、证据

- `docs/hosted-apps.md` §2 清单字段处写明规则：preUpgrade / preUninstall 只能引用有默认值的参数；§6 排障补 `param_invalid` 一句。
- CHANGELOG 0.41.2 `### Fixed`；`package.json` 0.41.2。
- 证据（可简化，写入 `docs/verification/<日期>/manifest-hook-param-refs.md`）：`verify.sh` 输出；真机：保存引用无默认值参数的清单被拒（截图）；390 宽升级确认截图（提示完整可读）。

## 5. 审核清单

- [ ] 保存拒绝只针对 preUpgrade / preUninstall + 无默认值参数；有默认值仍是 warning；preInstall 不受限
- [ ] 执行兜底：`params.*` → `param_invalid` + `details.field`；其他变量不变
- [ ] 升级同步错误也能定位字段、确认条不关；卸载给出修复入口
- [ ] 390 宽提示完整
- [ ] 未改契约与 Agent；0.41.2；CHANGELOG；文档两处
