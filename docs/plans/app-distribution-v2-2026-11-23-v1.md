# V1 开工说明：清单 v2 契约、模板语法与 ADR-0023

> 状态：已拍板 ｜ 最后核验：2026-11-23 ｜ 关联：`docs/plans/app-distribution-v2-2026-11-23.md` §5–§7、§11 V1

> **给开发 agent**：本文是 V1 的完整任务说明。开工前读 `AGENTS.md`、提案全文、本文全文。V1 **只新增契约与文档，不改任何运行行为**：现有 CRUD、安装、前端继续只认 v1。认为本文有误时在 PR 里提出，不要改 `docs/plans/` 下的文件。

## 0. 速览

| 项 | 值 |
|---|---|
| 分支 | `feat/manifest-v2-contracts`（从最新 `main` 拉） |
| PR 标题 | `feat(contracts): 应用清单 v2 契约、模板语法与 ADR-0023` |
| 发版类型 | X（契约），面板 **minor**；Agent 不变 |
| 后续 | V2（Worker）与 V3（Agent）以本批导出的 schema 与测试向量为准 |

## 1. 范围

**允许改动**

| 文件 | 动作 |
|---|---|
| `packages/contracts/src/manifest-v2.ts` | 新增：v2 schema、模板语法、v1→v2 归一化、推导所需能力 |
| `packages/contracts/src/index.ts` | `export * from './manifest-v2'`；`resultCardSchema` 加两个可选字段；`agentSelfSchema` 加可选 `capabilities` |
| `packages/contracts/test-vectors/manifest-template.json` | 新增：模板渲染测试向量（TS 与 Python 共用） |
| `packages/contracts/test/manifest-v2.test.ts` | 新增（`packages/contracts` 目前没有 test 目录；根 `vitest.config.ts` 已包含 `packages/**/test/**/*.test.ts`） |
| `docs/engineering/adr/ADR-0023-app-manifest-v2.md`、`docs/engineering/adr/README.md` | 新增 ADR 并登记索引 |
| `package.json`、`CHANGELOG.md` | 版本与条目 |

**禁止**：修改 `appManifestDefinitionSchema`、`createAppManifestRequestSchema`、`updateAppManifestRequestSchema`、`appManifestSchema`、`manifestActionParamsSchema` 的现有定义（V2 才切换）；改 `apps/`、`agent/`、`migrations/`。

## 2. v2 清单 schema（`appManifestDefinitionV2Schema`）

整体 `.strict()`，未知字段一律拒绝。字段上限是硬性要求，写进 schema。

```ts
{
  schema: z.literal(2),
  name, version,                     // 同 v1
  runtime,                           // 复用 appManifestRuntimeSchema
  params: paramV2[] (≤32),
  requires?: requirements,
  secrets?: secretDecl[] (≤8),
  hooks?: { preInstall?, preUpgrade?, preUninstall? }: hookStep,
  scripts: { install, uninstall, upgrade? },   // 每段 ≤64KB
  sha256:  { install, uninstall, upgrade? },   // 与 scripts 键一一对应
  writes: string[] (≤32),            // 同 v1
  units?: unit[] (≤4),
  health?: health,
  endpoints?: endpoint[] (≤8),
  sources?: source[] (≤8),
}
```

| 子结构 | 定义 |
|---|---|
| `paramV2` | v1 参数字段 + `type` 增加 `'enum'`；`options?: {value: /^[a-z0-9][a-z0-9_.-]{0,63}$/i, label: 1–64, requires?: {memMB?, diskMB?}}[]`（2–16 项）；`derive?: /^endpoint:[a-z][a-z0-9-]{0,31}\.publicUrl$/` |
| `requirements` | `arch?: ('amd64'\|'arm64')[]`、`os?: ('debian'\|'ubuntu'\|'rhel')[]`、`memMB?: 1–65536`、`diskMB?: 1–1048576`、`commands?: /^[a-z0-9][a-z0-9._+-]{0,63}$/[]`（≤16） |
| `secretDecl` | `{name: /^[a-z][a-z0-9_]{0,31}$/, label: 1–64, hint?: ≤200}` |
| `hookStep` | `{method: 'GET'\|'POST'\|'PUT'\|'DELETE', url: 模板串 ≤512, headers?: Record<header名, 模板串 ≤1024>（≤8）, body?: JSON（字符串叶子可含模板，序列化 ≤8KB，深度 ≤4）, extract?: Record</^[a-z][a-z0-9_]{0,31}$/, JSON Pointer ≤128>（≤8）, public?: string[], expectStatus?: int[]（默认 200–299）}` |
| `unit` | `{name: /^[a-z0-9][a-z0-9@._-]{0,62}$/（允许含 `{{instance}}`）, scope: 'system'\|'user'}` |
| `health` | 判别联合：`{type:'http', url: 模板串, expectStatus?: int（默认 200）, versionPointer?: JSON Pointer, graceSec?: 0–600（默认 60）, intervalSec?: 1–30（默认 3）, timeoutMs?: 100–5000（默认 1000）}` \| `{type:'tcp', port?: int, portParam?: string, graceSec?, intervalSec?, timeoutMs?}` \| `{type:'unit', graceSec?, intervalSec?}` |
| `endpoint` | `{id: /^[a-z][a-z0-9-]{0,31}$/, label: 1–64, protocol: 'http'\|'tcp', port?: 1–65535, portParam?: string, bind?: 'loopback'\|'any'（默认 loopback）, paths?: string[]（以 `/` 开头，≤8）, publish?: 'caddy'\|'direct'\|'none'（http 默认 caddy，tcp 默认 none）, auth?: {type: 'none'\|'key-in-url'\|'bearer'\|'basic', hint?: ≤200}}` |
| `source` | `{host: 主机名（不含协议、端口、路径）, purpose: 1–120, pinned: boolean}` |

**`superRefine` 交叉校验**（每条都要有测试）：

1. `sha256` 的键集合等于 `scripts` 的键集合，值是 64 位 hex（格式与 v1 `appManifestSha256Schema` 一致）。正文与哈希是否一致需要异步计算，不在 schema 里做：Worker 写入时由 `apps/api/src/lib/app-manifests.ts` 校验（V2 把它扩展到 `upgrade` 键），Agent 落盘前再校验一次。
2. `options` 仅在 `type: 'enum'` 时出现且必填；enum 的 `default` 必须是某个 `value`。
3. `derive` 仅允许 `type: 'string'`、不能同时 `secret: true`，引用的 endpoint id 必须存在。
4. `portParam`（endpoint、health）引用的参数必须存在且 `type: 'integer'`；`port` 与 `portParam` 恰好一个。
5. endpoint `id` 唯一；`publish: 'caddy'` 只允许 `protocol: 'http'`。
6. `scope: 'system'` 的 unit 要求 `runtime.mode === 'root'`；`scope: 'user'` 要求 `runtime.mode === 'create'`。
7. 模板里的 `{{secret.x}}` 只能出现在 hook 的 `headers` 与 `body`（**不能在 url**），且 `x` 必须在 `secrets[]` 里声明。
8. `public` 里的每个键必须在 `extract` 里。
9. `health.type === 'http'` 的 url 渲染前缀必须是 `http://127.0.0.1:` 或 `http://[::1]:`（模板只能出现在端口与路径部分）。
10. hook `url` 必须以 `https://` 开头，主机部分不能含模板。

## 3. 模板语法（Worker 与 Agent 必须一致）

- 唯一形式：`{{ <变量> }}`，变量两侧可有空格。正则：`/\{\{\s*(node\.(?:id|name)|instance|params\.[a-z][a-z0-9_]*|secret\.[a-z][a-z0-9_]*|facts\.[a-z][a-z0-9_]*)\s*\}\}/g`。
- 出现其他 `{{…}}`（含 `{{ }}`、未知变量、嵌套）→ **schema 校验失败**，不是渲染时报错。
- 可用范围：

| 变量 | hook | health / unit |
|---|---|---|
| `node.id`、`node.name` | ✓ | ✗ |
| `instance` | ✓ | ✓ |
| `params.<key>` | ✓ | ✓ |
| `secret.<name>` | 仅 headers / body | ✗ |
| `facts.<key>` | 仅 preUpgrade / preUninstall | ✗ |

- 渲染：值转字符串原样替换，**不做转义**；body 中只替换字符串叶子，不改变 JSON 结构；未提供的变量 → 渲染错误 `template_missing_var`（带变量名，不带值）。
- 导出纯函数：`listTemplateVars(text)`、`renderTemplate(text, vars)`。
- 测试向量 `packages/contracts/test-vectors/manifest-template.json`：`[{template, vars, expect | error}]`，至少 20 条，覆盖正常替换、空格、重复变量、缺变量、非法变量、`{{` 不闭合、相邻两个变量、中文、URL 端口位。V3 的 Python 实现用同一个文件做测试。

## 4. v1 → v2 归一化（`toManifestV2(def)`）

输入 v1 或 v2，输出 v2。**纯函数、不改输入**。v2 原样返回（深拷贝）。v1 的规则：

| v1 | v2 |
|---|---|
| 无 `schema` | `schema: 2` |
| `publish {label, host, portParam\|port}` | `endpoints: [{id: 'web', label: publish.label ?? 'Web', protocol: 'http', portParam\|port, bind: host 是 127.0.0.1 / ::1 时为 'loopback'，否则 'any', publish: 'caddy'}]` |
| 参数 `key === 'public_url'` 且有 `publish` | 该参数加 `derive: 'endpoint:web.publicUrl'`（v1 兼容规则，ADR 写明，v1 支持下线时一并删除） |
| 其余字段 | 原样 |

测试：仓库 `apps/manifests/magpie/manifest.json` 归一化后通过 v2 schema；快照断言 endpoints 与 derive；输入对象未被修改。

## 5. 所需能力推导（`requiredAgentFeatures(defV2)`）

返回排序去重的字符串数组，供 V2 版本协商：

| 清单用到 | 需要的能力 |
|---|---|
| 任何 v2 清单 | `schema2` |
| `scripts.upgrade` 或 `hooks.preUpgrade` | `upgrade` |
| `units` 非空 | `units` |
| `health.type` | `health.http` / `health.tcp` / `health.unit` |
| `requires` | `preflight` |
| `hooks` 任一（节点需接收 `KHC_HOOK_*`） | `hookEnv` |
| 参数 `type: 'enum'` | `params.enum` |

能力名常量导出为 `AGENT_MANIFEST_FEATURES`（只读数组）。

## 6. 其他契约改动（全部可选、向后兼容）

- `resultCardSchema` 增加 `kind?: 'url' | 'secret' | 'text' | 'command'`、`primary?: boolean`。
- `agentSelfSchema` 增加 `capabilities?: { appManifest?: { schemas: number[]; features: string[] } }`（仍 passthrough）。
- 新增 `appSecretValueSchema = { value: string 1–4096, allowHosts: 主机名[] 1–8 }` 与 `appSecretKey(manifestId, name)` → `app.<manifestId>.<name>`（满足现有 `settingKeySchema`）。
- 新增 `appManifestAnyDefinitionSchema = union([v1, v2])`，**本批不接入任何路由**。

## 7. ADR-0023

`docs/engineering/adr/ADR-0023-app-manifest-v2.md`，状态「已接受」（提案已拍板），按 ADR 模板写：背景（提案 §1.3 七个卡点 + khcsearch 需求）、选项（提案 §3 三方案）、决策（三层边界 L0 / L1 / L2、模板语法、凭据 `allowHosts`、动态脚本口径、v1 兼容与下线条件）、影响（批次 V1–V6、旧 recipe 删除）、验证。登记到 `docs/engineering/adr/README.md` 索引。

## 8. 测试（`packages/contracts/test/manifest-v2.test.ts`）

1. §2 交叉校验 1–10 每条一正一反。
2. 上限：params 33 个、endpoints 9 个、脚本 64KB+1、body 8KB+1、深度 5 → 拒绝。
3. 模板：测试向量全部通过；schema 层拒绝未知变量与 url 中的 secret。
4. 归一化：magpie 快照；纯函数；v2 输入原样。
5. 能力推导：最小 v2 清单只得 `['schema2']`；全量清单得到全部能力。
6. 现有契约测试与 `apps/` 测试全部不改、全部通过（证明 V1 无行为变化）。

## 9. 坑

1. zod 的判别联合与 `superRefine` 组合时，错误路径要指到具体字段（`path`），V4 的编辑器靠它标红。
2. JSON Pointer 按 RFC 6901：`~1` 是 `/`，`~0` 是 `~`；空串表示根，这里禁止用根。
3. 不要用 `new Function` 或任何动态求值实现模板。
4. 测试向量文件不能被 Worker 打包；放在 `packages/contracts/test-vectors/`，不从 `src/` 导入。

## 10. 版本与证据

- 面板 minor；CHANGELOG 一行，例如「新增应用清单 v2 契约（声明式参数、控制面步骤、健康检查与多端点），尚未对外启用。」
- 证据：`./scripts/verify.sh` 全绿；`git diff --stat` 只含 §1 列出的文件。

## 11. 审核清单

- [ ] 现有 v1 schema 与路由完全未动；`apps/`、`agent/` 无改动
- [ ] §2 字段与上限逐项一致；交叉校验 1–10 都有正反测试
- [ ] 模板正则与可用范围表一致；测试向量 ≥20 条且独立成文件
- [ ] `toManifestV2` 纯函数，magpie 快照通过
- [ ] `requiredAgentFeatures` 与 §5 表一致，常量已导出
- [ ] ADR-0023 与索引；CHANGELOG 一行；面板 minor
