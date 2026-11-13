# ADR-0012: 接入方案选定（三种并列方案、无跨方案回退）与 Worker client 单例

- 归类：决策记录
- 状态：已接受（主人 2026-11-07 拍板；实现于分支 `feat/todo-closeout-2026-11-07`，基线 `2668075`，未合并、未部署）
- 适用范围：`apps/api/src/lib/node-client.ts`、`apps/api/src/index.ts` 及其单测；不改 `packages/contracts` 契约、不改 Agent 内核、不改 D1 schema
- 最后核验：2026-11-07
- 关联：`docs/archive/2026-11/TODO-2026-11-06.md` §3.8 / §3.1、`docs/design-v3.md` §1.1、`docs/runbook/node-onboarding.md`、ADR-0001（双通道传输）、ADR-0010（单 isolate 内存去重口径）、ADR-0009（Worker 配额约束）
- 备注：按 AGENTS.md 红线 9a，`docs/README.md` 索引登记由同一 PR 的并行代理负责，本改动不触碰索引文件

## 背景

**§3.8 选路语义错位。** 历史实现（`orderedRoutes()` + `onRouteSuccess`）把 `direct` / `tunnel` 当作「主 + 备」：先走一条，失败（连接层失败、5xx 非 Agent 信封）就 `continue` 换另一条；成功时把 `preferred_route` 回写 D1，于是 `preferred_route` 实际含义是「上次成功的那条路」。这与已拍板的目标口径冲突——三种接入方案（A 可信证书直连 / B Cloudflare Tunnel / C 自签）是**并列方案**，节点创建/配置时选定其一，运行时只走该方案，失败即返回明确错误，**无主备、无跨方案回退、不自动改写 `preferred_route`**。跨方案重试还会让写动作在两条路上各执行一次（幂等键只能去重同一 Agent，不能阻止「换路」重复执行），且静默改写配置掩盖真实故障。

**§3.1 单例缺失。** `apps/api/src/index.ts` 此前每次请求都 `new HttpAgentClient(...)` + `createApp(...)`，导致 `node-client.ts` 的失败冷却 Map 与 snapshot 转发的 inflight 去重都只活在一次请求内，跨请求不生效：节点彻底不可达时每次请求都重新打满超时预算。

## 选项

### §3.8 选路

| 选项 | 做法 | 利 | 弊 |
|---|---|---|---|
| A 保留主备回退 | 维持双路由 + 自动写回 `preferred_route` | 弱网时自动切路、无需人工介入 | 与「节点选定方案」口径冲突；写动作跨路重复执行；运行时静默改写配置；错误被掩盖 |
| **B 选定单方案、无跨方案回退（选定）** | `orderedRoutes()` 只返回选定目标；失败明确报错；删除写回回调 | 语义清晰、失败可诊断、不改写配置、无重复执行 | 单方案故障不再自动自愈，需人工在面板显式改选 |
| C 主备 + 显式开关 | 保留回退但加开关 | 兼容旧行为 | 两套语义并存，复杂度高，仍保留隐式跨方案回退 |

### §3.1 client 生命周期

| 选项 | 做法 | 利 | 弊 |
|---|---|---|---|
| A 每请求新建（历史） | `fetch()` 内 new | 实现简单 | cooldown / inflight 不跨请求生效 |
| **B 按 env 绑定引用 WeakMap 缓存（选定）** | 模块级 `WeakMap`，以 `env.DB` 为键缓存 `{ agent, app }` | 单 isolate 内跨请求共享；零新依赖；不影响 `createApp` 直接构造的测试夹具 | 跨 isolate / 冷启动不共享（尽力而为） |
| C KV / Durable Objects | 全局共享状态 | 跨 isolate 一致 | 引入 KV/DO 新依赖，违反 AGENTS.md 红线 1「不做 KV/R2/DO/Cron」 |

## 决策

1. **§3.8 选路改造**（`node-client.ts`）
   - `orderedRoutes()` 只返回 `preferred_route` 选定方案对应的**单一**目标；`preferred_route` 语义由「上次成功的路」改为「选定方案」，**值仍为 `direct` / `tunnel`，不改契约**。运行时按这两类目标择一：直连类方案走 `endpoint`，隧道方案走 `tunnelEndpoint`；三种方案在节点配置层区分，控制面不改变其取值集合。
   - 删除 `call()` 内跨路由 `continue` 重试（含「5xx 非 Agent 信封换路由」分支）；只处理选定方案这一个目标，失败即抛 `HubUnreachableError`。
   - 删除 `onRouteSuccess` 回调：类字段、构造参数、`call()` 内调用点，以及 `index.ts` 里写回 D1 的回调一律移除，**运行时不再改写 `preferred_route`**。
   - 错误信息改为「按选定方案接入失败」，不暗示「切换另一条路 / 直连与隧道均失败」；选定 `tunnel` 却未配置隧道地址时明确报错，不悄悄降级到 `direct`。
   - **保留**：选定方案内部的 `fetch()` → `cloudflare:sockets` TCP 回退（域名 fetch 失败或边缘 403 拦截时，用 TCP 重试**同一 URL**）。这是**单方案内的双传输通道，不是跨方案回退**，按 ADR-0001 / T1 保留。
   - **保留不动**：请求侧 HMAC 签名与每次传输尝试重签（F-M1）、幂等键、5xx Agent 错误信封分类（R-1）、403 边缘拦截分类、fetch/TCP 超时预算、`timedOut` 标记（R-3）、30s 失败冷却、自签证书人话提示、非 JSON 兜底信封。

2. **§3.1 client 单例**（`index.ts`）
   - 模块级 `WeakMap<object, { agent, app }>`，以 `env.DB` 绑定引用为键（未绑定时回退到 `env` 本身）。Workers 每次请求的 `env` 可能是新对象，但绑定实例在同一 isolate 内稳定，故按绑定引用缓存更稳妥。
   - `default.fetch` 改为 `getWorkerRuntime(env).app.fetch(...)`，同一 isolate 内跨请求复用同一 `HttpAgentClient`，cooldown Map 与 snapshot inflight 去重随之跨请求生效。
   - **不引入** KV / Durable Objects / 任何新依赖。测试仍可用 `createApp` 直接构造（夹具不受影响）；`getWorkerRuntime` 另留可选传输注入参数仅供单测。

3. **本次不做加密/签名批次**（主人 2026-11-07 决定暂缓）：不涉及 AES-GCM、`x-khc-enc`、响应 HMAC、`agent/khc/crypto.py`、`agent-crypto.ts`；仅保留既有请求侧 HMAC 签名。

## 影响 / 迁移 / 兼容性 / 回滚

- **行为变化**：直连失败不再自动切隧道；`preferred_route` 不再被运行时改写（新建节点默认 `direct`，需要隧道必须显式配置）。
- **契约不变**：`packages/contracts` 未改，`PreferredRoute` 仍为 `'direct' | 'tunnel'`；`AgentResponse.route` / `via` 字段不变；错误码仍为 `hub_unreachable`，仅 message 文案调整。
- **数据不变**：无 D1 schema 变更、无 migration；存量 `preferred_route` 值原样读取，仅按「选定方案」重新解释。
- **错误语义**：5xx 且响应体不是合法 Agent 错误信封（网关/代理错误页）由「换路由重试」改为「该方案未触达节点 → 抛 `HubUnreachableError`」；5xx 合法 Agent 信封仍按普通响应原样返回（R-1）。
- **冷却共享范围**：单 isolate 内跨请求生效；跨 isolate / 冷启动各自独立，属「单 isolate 内存尽力而为」，与 ADR-0010 快照去重同口径，不承诺全局一致。
- **回滚**：恢复 `orderedRoutes()` 双路由 + `onRouteSuccess` 回写即可；单例可退回每请求 `new`。二者相互独立，可分拆回滚。

## 取舍与风险

- **单方案故障不再自愈**：这是「方案选定」口径的必然代价，换来的是可诊断的明确错误与写动作不重复执行；恢复路径是人工改选方案，而非隐式换路。
- **WeakMap 键的假设**：依赖「同一 isolate 内 `env.DB` 绑定引用稳定」。若 Workers 运行时对每次请求重建绑定对象，缓存会退化为每请求新建——功能仍正确，只是失去 cooldown 跨请求收益。未用 KV/DO 换取全局一致性，是遵循红线 1 的主动取舍。
- **5xx 非信封语义收紧**：若线上存在依赖旧「静默换路」恢复的网关错误页场景，会改为显式报错，需上线后观察面板错误分布。

## 验证

- `pnpm exec vitest run apps/api/test/node-client.test.ts`：27 用例通过。原「直连失败切隧道」「5xx 切隧道」「preferred_route 回写」「onRouteSuccess 异常隔离」用例改为「选定方案不切换」「失败明确报错」；新增覆盖「选定 direct 时 tunnel 不被调用」「选定 tunnel 时 direct 不被调用」「单方案内 fetch→TCP 回退仍生效」「tunnel 缺地址不降级」。
- `pnpm exec vitest run apps/api/test/index.test.ts`：3 用例通过（两次 fetch 复用同一 client/app、不同绑定隔离、失败后第二次命中 cooldown 快速失败且不再发起传输）。
- 回归：`apps.test.ts` / `nodes-probe.test.ts` / `snapshot.test.ts` 共 17 用例通过（确认真实 `HttpAgentClient` 注入路径与构造函数签名改动未破坏既有集成）。
- `pnpm exec tsc --noEmit -p apps/api/tsconfig.json`：通过（exit 0）。
- 未执行 `./scripts/verify.sh` / `pnpm build` / 全量 `pnpm test`（按本次多代理分工禁令，由收口方统一执行）。
