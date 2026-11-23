# V2 开工说明：Worker 编排——预检、控制面步骤、应用凭据与版本协商

> 状态：已拍板 ｜ 最后核验：2026-11-23 ｜ 关联：`docs/archive/plans/app-distribution-v2-2026-11-23.md` §5–§7、§11 V2；V1 开工说明

> **给开发 agent**：开工前提：**V1 已合入**。先读 `AGENTS.md`、提案、V1 与本文全文。本批让 Worker 接受 v2 清单并编排安装 / 升级 / 卸载；Agent 侧能力由 V3 提供，两批可并行开发，按本文 §3 的动作接口对齐。认为本文有误时在 PR 里提出，不要改 `docs/plans/` 下的文件。

## 0. 速览

| 项 | 值 |
|---|---|
| 分支 | `feat/manifest-v2-worker`（从最新 `main` 拉） |
| PR 标题 | `feat(api): 应用清单 v2 编排（预检、控制面步骤、应用凭据、版本协商）` |
| 发版类型 | A（Worker + 契约接入），面板 **minor**；Agent 不变 |
| 红线 | 路由与 lib 里不得出现任何应用名；凭据值不进日志、审计、响应、D1 清单行 |

## 1. 范围

**允许改动**

| 文件 | 动作 |
|---|---|
| `packages/contracts/src/index.ts` | `appManifestSchema.manifest`、`create/updateAppManifestRequestSchema.manifest` 改为 `appManifestAnyDefinitionSchema`；`manifestActionParamsSchema` 增加 `skipHooks?: boolean`；新增 §5 的响应 schema |
| `apps/api/src/lib/app-manifests.ts` | sha256 校验扩展到 `upgrade` 键；`resolveManifestParams` 改为调用新编排 |
| `apps/api/src/lib/manifest-lifecycle.ts` | 新增：生命周期编排（§3） |
| `apps/api/src/lib/manifest-hooks.ts` | 新增：控制面步骤执行器（§4） |
| `apps/api/src/routes/apps.ts` | 动作路由调用编排；不新增按应用名的分支 |
| `apps/api/src/routes/appManifests.ts` | 新增凭据状态接口（§5） |
| `apps/api/src/routes/settings.ts` | `app.` 前缀键的值校验（§5） |
| `apps/api/src/types.ts` | `AppDeps.hookFetch?`（测试注入，同 `cfFetch` 写法） |
| `apps/api/src/lib/timing.ts` | 新增 `ext` 计时段（第三方调用） |
| `apps/web/src/apps/hosted-apps/recipes.ts`、`apps/web/src/apps/settings/AppManifests.tsx`、`apps/web/src/apps/settings/appPublish.ts` | **最小适配**：读清单一律先 `toManifestV2()`，v1 行为不变（§6） |
| `apps/api/test/*`、`apps/web/src/**/*.test.*` | 测试 |
| `docs/design-v3.md`、`docs/security-boundaries.md`、`package.json`、`CHANGELOG.md` | 文档与版本 |

**禁止**：`agent/`、`migrations/`、新增表；前端新功能（表单 enum、多端点、卡片新样式属于 V4）。

## 2. 写入路径

- `POST/PUT /api/v1/app-manifests` 接受 v1 或 v2。sha256 校验覆盖 `scripts` 的全部键。
- `GET /api/v1/app-manifests`：D1 里某条记录既不符合 v1 也不符合 v2（旧数据、手工写坏）时，**不得让整个列表 500**：该条以 `{id, enabled, invalid: true, error: <首条 issue 的 path + message>}` 返回，manifest 字段缺省；契约 `appManifestSchema` 相应加可选 `invalid` / `error`，`manifest` 改为可选。安装此类记录 → 400 `manifest_invalid`。
- v2 写入额外检查：`secrets[]` 声明的每个名字，若 settings 中已有 `app.<id>.<name>`，其 `allowHosts` 必须覆盖所有引用它的 hook url 主机，否则在响应 `warnings[]` 里提示（**不阻断保存**，安装时才阻断）。
- 审计沿用现有 `app-manifest.*`，detail 增加 `schema` 与各脚本 sha256。

## 3. 生命周期编排（`manifest-lifecycle.ts`）

只在 `params.manifestId` 存在、且动作属于下表时触发。表按**动作名**区分生命周期阶段，不认识应用名。

| 动作（app = `app-catalog`） | 阶段 | Agent 侧（V3 提供） |
|---|---|---|
| `manifest_install`（v1 旧名 `recipe_install`） | install | 任务 |
| `manifest_upgrade` | upgrade | 任务 |
| `manifest_uninstall`（v1 旧名 `recipe_uninstall`） | uninstall | 任务 |
| `manifest_control`（参数 `{op, unit}`，`unit` 必填）、`manifest_logs`（`{unit, lines?}`）、`manifest_installed` | 无编排，只注入清单 + 版本协商 | 同步 |

流程（v2 清单；v1 清单保持现状，不预检、不跑 hooks，保证旧 Agent 可用）：

1. 读 D1 清单 → `toManifestV2` → 所需能力 = `requiredAgentFeatures(清单)` ∪ 本次动作所需：`manifest_upgrade` 加 `upgrade`；`manifest_control` / `manifest_logs` 加 `units`；其余动作不加。`toManifestV2` 抛错（D1 里个别旧记录无法转换）→ 400 `manifest_invalid`，details 带第一条 zod issue 的 path 与 message。
2. **预检**：同步调用 Agent `POST /apps/app-catalog/manifest_preflight`，body `{params: {manifest, manifestId, instance, values, stage}}`，超时 10s。Agent 返回：

   ```jsonc
   { "ok": true, "capabilities": { "schemas": [1, 2], "features": ["..."] },
     "checks": [{ "name": "memMB", "ok": false, "message": "可用内存 512 MiB（要求 >= 800 MiB）" }],
     "installed": { "version": "…", "schema": 2, "facts": { "hub_node_id": "…" } } | null }
   ```

   以上为 V3 实际实现的形状（以 `feat/manifest-v2-agent` 为准）：`checks[].name` 取值 `arch`、`os`、`memMB`、`diskMB`、`command:<名>`、`port:<端口>`；清单在节点侧校验失败时返回 `ok: false` 且只有一条 `{name: "manifest"}`。

   - Agent 返回 4xx 未知动作，或 `capabilities` 缺少所需能力 → 409 `agent_upgrade_required`，`details: {missing: [...], minAgentVersion: MANIFEST_V2_MIN_AGENT}`（常量 `'0.8.0'`，V3 的 Agent 版本）。
   - 存在 `name === "manifest"` 的失败项 → 400 `manifest_invalid`（Worker 与 Agent 校验不一致，属缺陷，`console.warn` 记录 manifestId）。
   - 其余 `checks` 有失败（只在 install / upgrade 阶段检查）→ 422 `preflight_failed`，`details.checks` 原样返回。
   - upgrade / uninstall 时 `installed === null` → 409 `not_installed`。
   - `manifest_control` / `manifest_logs` / `manifest_installed` 不调用预检，版本判断改读 `/state` 缓存的 `agent.capabilities.appManifest`：Worker 侧先 `getNodeCached`，若已缓存的最近一次 `/state` 不可用，则直接转发，由 Agent 对未知动作返回 4xx，Worker 转成 409 `agent_upgrade_required`。
3. **控制面步骤**：install → `hooks.preInstall`；upgrade → `hooks.preUpgrade`（未声明则不执行，不回退到 preInstall）；uninstall → `hooks.preUninstall`。变量见 V1 §3：`node.id`、`node.name`、`instance`、`params.*`（用户值合并参数默认值）、`secret.*`、`facts.*`（来自第 2 步 `installed.facts`）。
   - 仅 uninstall 接受 `skipHooks: true`：跳过 `preUninstall`，审计记 `app.hook.skipped`，任务结果卡片由 V3 提示「第三方需人工处理」（Worker 在转发参数里加 `hooksSkipped: true`）。
4. **转发**：参数为 `{manifest: 归一化后的 v2, manifestId, instance, values, runtime*, hookOutputs, hookFacts, hooksSkipped?}`；`hookOutputs` 为全部提取值，`hookFacts` 为其中 `public` 子集。
5. **保密通道**：本次要执行的控制面步骤声明了 `extract`（即会产生 `hookOutputs`）时，**在执行步骤之前**按 `assertSecureChannelForRawSecrets` 口径检查（明文通道拒绝，development 豁免），避免第三方已签发资源后才被拒绝。即 IP 明文接入的节点不能安装带控制面步骤的应用；错误信息要写清原因与改法（换域名或 Tunnel 接入）。

## 4. 控制面步骤执行器（`manifest-hooks.ts`）

| 规则 | 要求 |
|---|---|
| 渲染 | 用 V1 的 `renderTemplate`；缺变量 → 400 `template_missing_var`（只带变量名） |
| 凭据 | `{{secret.x}}` → 读 settings `app.<manifestId>.x`，按 `appSecretValueSchema` 解析；不存在 → 400 `secret_not_configured {name}`；url 主机（小写、去端口）不在 `allowHosts`（精确匹配）→ 403 `secret_host_not_allowed {name, host}` |
| 出站 | 仅 https；`redirect: 'manual'`，3xx 视为失败；`AbortSignal.timeout(10_000)`；响应体读取上限 64KB（超出即中止并失败）；不重试 |
| 请求头 | 用户声明的头 + `content-type: application/json`（有 body 时）；不转发任何浏览器头或会话 Cookie |
| 判定 | 状态码在 `expectStatus`（默认 200–299）内为成功 |
| 提取 | 响应须为 JSON；按 JSON Pointer 取值，值必须是字符串 / 数字 / 布尔，每项 ≤4KB；缺失 → 502 `hook_extract_failed {key}` |
| 失败 | 502 `hook_failed {stage, status, error}`：`error` 只取第三方 JSON 响应里的 `error` 字符串字段，截断 200 字符；**不回显**请求 url 的查询串、请求头、请求体、响应体 |
| 审计 | `app.hook` `{manifestId, instance, stage, host, status, durationMs}`；不含任何值 |
| 计时 | 包进 `timed('ext', …)`，`Server-Timing` 出现 `ext` 段 |
| 注入 | `deps.hookFetch ?? fetch`，测试用假实现，绝不访问外网 |

## 5. 应用凭据

- 存储：settings 键 `app.<manifestId>.<name>`，值 `appSecretValueSchema`（`{value, allowHosts}`），复用现有加密仓库，不新增表。
- `PUT /api/v1/settings/:key`：键以 `app.` 开头时，值必须通过 `appSecretValueSchema`，否则 400；审计照旧只记键。
- 新增 `GET /api/v1/app-manifests/:id/secrets` → `{secrets: [{name, label, hint?, configured, allowHosts: string[], updatedAt: number | null}]}`，按清单 `secrets[]` 声明列出，**不返回 value**。契约新增 `appManifestSecretsResponseSchema`；登记到 `docs/design-v3.md` 的 API 表。
- 写凭据仍用 `PUT /settings/:key`（V4 做界面）。

## 6. 前端最小适配（必须做，否则契约改成 union 后类型检查不过）

- 凡读 `appManifest.manifest` 的地方先 `toManifestV2()`，再映射回现有视图：`endpoints[0]` 当作原来的 `publish`，带 `derive` 的参数不显示在表单、按原 `public_url` 逻辑推导。
- v2 独有能力（enum、多端点、hooks、units）本批不展示，也不报错；应用管理编辑器能保存 v2 JSON。
- 断言：现有前端测试全部不改、全部通过。

## 7. 测试（`apps/api/test/manifest-v2-*.test.ts`）

1. 写入：v2 合法清单 201；`upgrade` 脚本 sha256 不符 400；v1 照旧。
2. 编排顺序：预检 → hook → 转发，用假 Agent 与假 `hookFetch` 记录调用序列；预检失败时 hook 未被调用。
3. 版本协商：Agent 回未知动作 → 409 且带 `minAgentVersion`；缺能力 → 409 列出 `missing`；v1 清单不调用预检。
4. 预检失败 422 原样返回 checks；upgrade 未安装 409。
5. 模板：变量替换正确；缺变量 400；facts 只在 upgrade / uninstall 可用。
6. 凭据：未配置 400；主机不在 `allowHosts` 403 且**未发出请求**；凭据值不出现在任何响应、审计、`console.*` 输出中（spy 全部输出做断言）。
7. 出站：http url 被 schema 拒；3xx 失败；超时失败；65KB 响应失败；非 JSON 时提取失败；状态码不在 `expectStatus` 失败；错误响应只含截断后的 `error` 字段。
8. 输出：`hookOutputs` 全量、`hookFacts` 只含 public；明文通道且有 `hookOutputs` 时拒绝。
9. `skipHooks`：只在 uninstall 生效，审计 `app.hook.skipped`；install 带 `skipHooks` 400。
10. `/app-manifests/:id/secrets` 不含 value；`PUT /settings/app.x.y` 值格式错误 400。
11. 源码扫描：`apps/api/src` 不出现 `magpie`、`khcsearch` 等应用名（参照 relay-latency B2 的扫描写法）。
12. 所需能力：v1 清单不预检；最小 v2 清单 + `manifest_upgrade` 时 `missing` 含 `upgrade`；`manifest_control` 时含 `units`。
13. 列表容错：D1 插入一条非法 manifest_json，`GET /app-manifests` 仍 200，该条 `invalid: true`；对它发起安装 400 `manifest_invalid`。
14. 预检返回 `{name: "manifest", ok: false}` → 400 `manifest_invalid`，hook 未调用。

## 8. 坑

1. `fetch` 的 `redirect: 'manual'` 在 Workers 返回 3xx 原响应，要显式判定为失败。
2. 读响应体要流式计数，不要先 `text()` 再判断长度。
3. hook 有副作用（签发票据），**不能**在重试、幂等重放时重复执行：同一 `idempotencyKey` 的重复请求，若 Agent 已受理（`callWithSyncPoll` 已有机制），不得再次调用 hook。实现前先读 `routes/apps.ts` 现有幂等逻辑，在 PR 里说明怎么保证。
4. D1 读副本：编排里读清单与凭据走当前会话即可，不需要强一致。
5. 预检超时（10s）不计入节点冷却以外的副作用；预检失败不要写 `recordApplyFailure`（那是 apply 专用）。

## 9. 文档、版本、证据

- `docs/design-v3.md`：API 表新增凭据状态接口，动作表新增 `manifest_*`。
- `docs/security-boundaries.md`：新增「控制面步骤与应用凭据」一节（出站约束、`allowHosts`、不回显、明文通道限制）。
- `docs/hosted-apps.md` 本批不改（v2 尚无界面），V4 / V5 统一改写。
- 面板 minor；CHANGELOG 一行。
- 证据：`./scripts/verify.sh` 全绿；预览 URL 上用一份只回显参数的 v2 测试清单 + 指向 `https://httpbin.org/post` 之类公开回显服务的 hook 做一次真机安装（**V3 部署到测试节点后再做**；若 V3 未就绪，附预检返回 409 `agent_upgrade_required` 的截图即可）。

## 10. 审核清单

- [ ] 路由与 lib 无应用名；编排只按动作名与字段识别
- [ ] v1 清单路径完全不变（不预检、不跑 hook），旧 Agent 可用
- [ ] 预检 → hook → 转发顺序；预检失败不调 hook
- [ ] 出站约束五项（https、无重定向、10s、64KB、不重试）都有测试
- [ ] 凭据 `allowHosts` 精确匹配，越界时请求未发出；值不进任何输出
- [ ] 幂等重放不重复执行 hook（§8 第 3 条有说明与测试）
- [ ] 明文通道拒绝带 hookOutputs 的转发
- [ ] 前端只做最小适配，现有前端测试不改
- [ ] design-v3、security-boundaries、CHANGELOG、面板 minor
