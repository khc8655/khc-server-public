# B1 开工说明：Server-Timing 分段计时与中转基线

> 状态：已拍板 ｜ 最后核验：2026-11-22 ｜ 关联：`docs/plans/relay-latency-2026-11-22.md` §4 B1

> **给开发 agent**：本文是 B1 的完整任务说明。开工前读 `AGENTS.md`、提案 §1–§4、本文全文。偏离本文的地方在 PR 里写明原因；认为本文有误时在 PR 里提出，不要改 `docs/plans/` 下的文件。

## 0. 速览

| 项 | 值 |
|---|---|
| 分支 | `feat/server-timing`（从最新 `main` 拉） |
| PR 标题 | `feat(api): Server-Timing 分段计时与中转基线脚本` |
| 发版类型 | A（Worker），面板 **patch**，Agent 不变 |
| 关联 | 提案 `docs/plans/relay-latency-2026-11-22.md` B1 |

## 1. 目标

1. 每个 `/api/*` 响应（包括 401、404、5xx）带 `Server-Timing` 头，分出鉴权、D1、Agent 与 Worker 总耗时。
2. Worker 总耗时 ≥ 1.5s 的请求在 Workers Logs 打一行，兜底「生产入口剥离了响应头」的情况。
3. 一个本地脚本，部署后对生产入口与 `*.workers.dev` 入口各测一轮，输出可直接贴进证据文件的表格。

## 2. 范围

**允许改动**

| 文件 | 动作 |
|---|---|
| `apps/api/src/lib/timing.ts` | 新增：计时核心、D1 包装、Agent 包装 |
| `apps/api/src/node-async-hooks.d.ts` | 新增：`node:async_hooks` 最小类型声明 |
| `apps/api/src/middleware/timing.ts` | 新增：`serverTiming` 中间件 |
| `apps/api/src/app.ts` | 挂中间件、包装 `deps.agent` |
| `apps/api/src/middleware/auth.ts` | `requireAuth` 的会话校验段计入 `auth` |
| `apps/api/src/index.ts` | D1 绑定包装后再注入各仓库 |
| `apps/api/test/server-timing.test.ts` | 新增 |
| `scripts/lib/relay-latency.mjs`、`scripts/relay-latency-baseline.mjs` | 新增：基线纯函数与 CLI |
| `scripts/test/relay-latency.test.ts` | 新增 |
| `scripts/verify.sh` | 把两个新脚本加入 `node --check` 列表 |
| `docs/runbook/troubleshooting.md` | 新增 §12 |
| `package.json`、`CHANGELOG.md` | 版本与条目 |

**禁止**：改任何路由的行为或响应体、`packages/contracts/`、`migrations/`、`agent/`、`apps/web/`。`git diff --stat` 里不应出现这四个目录。

**核心冻结说明（PR 必写）**：`app.ts`、`index.ts`、`middleware/auth.ts` 属 Worker 核心。必要性：计时必须挂在最外层，才能覆盖鉴权失败与错误响应；D1 与 Agent 在注入点统一包装，仓库代码与路由一行不改。

## 3. 设计

### 3.1 响应头格式

```
Server-Timing: auth;dur=12.0;desc="n=1", d1;dur=280.4;desc="n=3", agent;dur=1402.7;desc="n=1 tcp", total;dur=1731.2
```

- 顺序固定 `auth`、`d1`、`agent`、`total`；本次请求没出现的类别省略；`total` 恒有，为中间件入口到出口的时长。
- `dur` 单位毫秒，保留 1 位小数，负值按 0。
- 每类 `dur` = 该类全部区间的**并集长度**：`Promise.all` 并行的两次 D1 只算墙钟时间。类别之间可以重叠（`auth` 内含一次 D1；`/overview` 的 D1 与 Agent 并行），所以各类之和可以大于 `total`，这是预期行为。
- `desc` = `n=<次数>` + 去重后的明细 token（目前只有 Agent 的实际传输 `fetch` / `tcp`）。token 必须匹配 `^[a-z0-9_-]{1,32}$`，不匹配就丢弃。
- 头里**不得**出现 URL、路径、IP、节点 id 或名称、错误文本、凭据。

### 3.2 计时核心 `lib/timing.ts`

- `RequestTiming`：构造时可注入时钟（测试用），`record(metric, start, end, detail?)`、`summary()`、`header(end?)`；每类最多保留 500 个区间（防异常循环）。
- 请求上下文用 `AsyncLocalStorage`（`import { AsyncLocalStorage } from 'node:async_hooks'`，`wrangler.toml` 已开 `nodejs_compat`）。导出 `runWithTiming(timing, fn)`、`currentTiming()`。
- `timed(metric, fn, detailOf?)`：有上下文时记录区间，成功与失败都记，异常原样抛出；**没有上下文时直接执行 `fn`**，单测直接调仓库、后台任务不受影响。
- 类型：`@cloudflare/workers-types` 不含 `AsyncLocalStorage`（已核实），`apps/api/test/node-builtins.d.ts` 只给测试用、不能复用。新增 `apps/api/src/node-async-hooks.d.ts`，只声明 `getStore()` 与 `run()`。

### 3.3 D1 包装 `instrumentD1(db)`

用 `Proxy` 包装 D1 绑定，仓库代码不改：

| 调用 | 处理 |
|---|---|
| `prepare()` | 返回包装后的语句 |
| 语句 `.bind()` | 返回包装后的语句 |
| 语句 `.first/.all/.run/.raw` | `timed('d1', …)` |
| `batch(statements)` | **先把包装过的语句解包回原生对象**再调用，计 1 次 |
| `exec()` | `timed('d1', …)` |
| `withSession()` | 返回同规则包装的会话（给 B3 读副本预留） |
| 其他方法 / 属性 | 方法绑定原对象后返回，属性原样返回 |
| 非对象（未绑定 DB） | 原样返回 |

### 3.4 Agent 包装 `instrumentAgent(client)`

返回同接口对象，`call()` 计入 `agent`，成功时 `detail = response.via`。参数原样透传（单测的 `FakeAgentClient.requests` 必须照常可观察）。

### 3.5 中间件 `middleware/timing.ts`

1. 建 `RequestTiming` → `runWithTiming(timing, () => next())`。
2. 追加 `Server-Timing`；`c.res.headers` 不可变时复制一份 `Response` 再写。
3. `total ≥ 1500ms`（导出常量 `SLOW_REQUEST_LOG_MS`）时 `console.info('[timing] slow request', { method, path, status, serverTiming })`。`path` 取 `c.req.path`（不含 query），含节点 id 可以进日志（Workers Logs 仅主人可见），**不能进响应头**。

### 3.6 接入点

- `app.ts`：`createApp(rawDeps)` 内 `const deps = { ...rawDeps, agent: instrumentAgent(rawDeps.agent) }`；`app.use('/api/*', serverTiming)` 放在 `/api/v1/health` 路由与**所有**中间件之前。
- `middleware/auth.ts`：把 `requireAuth` 里「读 secret → 解析 cookie → `readSessionEpoch` → `verifySession` → `c.set('user')`」整段包进 `timed('auth', …)`，`await next()` 留在外面；已鉴权直接放行的分支不计时。
- `index.ts`：`const db = instrumentD1(env.DB)`，全部 `D1*Repo` 改用 `db`。**`getWorkerRuntime` 的 WeakMap 键仍用原始 `env.DB`**，不能换成包装后的 `db`，否则每个请求都会新建 runtime、冷却与去重全部失效。
- 已知缺口（PR 里写明即可，不在本批修）：登录限流 `allowRequest({ db: c.env.DB })` 直接用原始绑定，这部分 D1 不计入。

### 3.7 基线脚本

`scripts/lib/relay-latency.mjs`（纯函数，便于单测）：`parseServerTiming`、`median`、`summarize`、`renderMarkdown`、`sessionCookie`。

`scripts/relay-latency-baseline.mjs`（CLI，Node 22 内置 `fetch`）：

- 参数：`--base <url>`（可多次）、`--runs <n>`（默认 10）、`--node <id>`（可多次，缺省为全部节点）、`--skip-host-ops`、`--json`。
- 口令只读环境变量 `KHC_PASSWORD`，可选 `KHC_TOTP`；不落盘、不打印。每个入口登录一次（登录限流 10 次 / 5 分钟 / IP）。会话 Cookie 名 `khc_sess`，用 `headers.getSetCookie()` 取。
- 每个入口依次测：`GET /api/v1/nodes`、`GET /api/v1/certs`、`POST /api/v1/nodes/probe`；每个节点再测 `GET …/state`、`GET …/overview`、`GET …/snapshot`（每次间隔 2.1s，避开 Worker 2s 去重）、只读的 host-ops `svc.list`（`POST …/apps/host-ops/call`，body `{ params: { target: 'self', verb: 'svc.list', params: {} }, idempotencyKey: <uuid> }`）。
- 每个接口：第一次单列为「首次」，其余取中位数。列：入口、接口、次数、首次、中位墙钟、Worker total、auth、d1、agent、**网络+边缘（= 墙钟 − total）**、状态码、通道。响应缺头时计数，并在表下提示改看 Workers Logs。
- 文件头注释写清用法与请求量（约 runs × (3 + 4 × 节点数) × 入口数）。

## 4. 测试（全部新增，现有测试必须全绿）

`apps/api/test/server-timing.test.ts`：

1. 区间并集：重叠、乱序、完全包含。
2. `header()`：注入时钟后断言完整字符串（顺序、省略、`total` 在最后、1 位小数）。
3. 非法 token（含引号、逗号、URL）被丢弃。
4. 无上下文时 `timed` 直通；上下文跨 `await` 传递；失败也记录且异常原样抛出；两个并发上下文互不串数。
5. 用 `test/helpers/sqlite-d1.ts` 的 `toD1(openRawDatabase())` 包装：`run/first/all` 结果与原绑定一致，计数 3。
6. `batch` 收到的是原生语句（`WeakSet` 判断），计 1 次。
7. 带 `#私有字段` 的假 D1 类经包装调用不抛错，包括 `withSession()` 返回的会话。
8. `instrumentD1(undefined)` 返回 `undefined`。
9. `instrumentAgent`：参数原样透传，记录 `via`。
10. 端到端（`makeTestContext`）：`/api/v1/health` 只有 `total`；未登录 `/api/v1/nodes` 返回 401 且带头；登录后未实现接口 404 带 `auth`；`/nodes/:id/state` 有 `auth n=1`、`agent n=1 fetch`、`total`，头里不含节点 id 与 endpoint 主机名；Agent 抛 `HubUnreachableError` 时仍带 `agent n=1`。
11. 慢请求日志：正常请求不打；用 `vi.spyOn(performance, 'now')` 在 Agent 调用期间推进时钟越过阈值后打一行，且字段为 `{ method, path, status, serverTiming }`。

`scripts/test/relay-latency.test.ts`：`parseServerTiming`（含缺失与异常项）、`median`（奇偶与空）、`summarize`（首次单列、中位数、edge、状态集合、通道集合、缺头计数）、`renderMarkdown`（缺值显示 `—`、缺头写进状态列）、`sessionCookie`（只取 name=value、忽略空值）。

回归重点：`apps/api/test/index.test.ts`「同一 DB 绑定复用 runtime」必须仍通过（验证 WeakMap 键没被破坏）。

## 5. 坑

1. **Proxy 的 this**：用 `Reflect.get(target, prop, target)` 取值，方法以原对象为 `this` 调用。Workers 的 D1 实现可能依赖私有字段，`this` 变成 Proxy 会抛 `TypeError`。
2. **`batch` 必须解包**，否则 D1 收到的是代理对象。
3. **中间件顺序**：必须在 `/api/v1/*` 全局鉴权之前注册，才能覆盖 401；`onError` 生成的错误响应也要带头，以测试为准。
4. **Response 头可能不可变**：写失败时复制 `Response`。
5. **Workers 计时器只在 I/O 时推进**：量到的是 I/O 等待，纯 CPU 计算不体现。PR 说明里写清。
6. **runtime 缓存键**：见 §3.6。
7. **剥离响应头**：生产入口是否剥离未实证，所以慢日志兜底，基线两个入口都测。
8. 不加 `Timing-Allow-Origin`，同源已足够。

## 6. 文档

- `docs/runbook/troubleshooting.md` 新增 `## 12. 面板 / 节点页面响应慢`：怎么看头（开发者工具 Network → Timing 底部 Server Timing）、各段含义与重叠说明、「浏览器总时长 − total ≈ 网络 + 第三方边缘」、按大头处置（agent → §1/§6；d1 → 记入基线；total 小而总时长大 → 网络或边缘）、看不到头时搜 `[timing] slow request`、基线脚本命令。全文 ≤ 400 行。
- `CHANGELOG.md`：新版本段一行，例如「面板接口响应新增 `Server-Timing` 分段耗时（鉴权 / D1 / Agent / 总计），在浏览器开发者工具即可看出慢在哪一段。」
- 不改 `docs/data-layering.md`、ADR 与提案文件。

## 7. 版本

面板 patch（`package.json` 的 `version` 按合并时 `main` 顺延，`khcRelease` 按发版日）；Agent 不变。

## 8. 交付证据

**PR 内**

1. `./scripts/verify.sh` 全绿（贴末尾输出）。
2. 版本预览 URL 上 `curl -i` 两条：`/api/v1/health`，以及登录后 `/api/v1/nodes`，展示 `Server-Timing` 头。
3. 核心冻结必要性说明（§2）与已知缺口（§3.6）。

**合并部署后（单独开 `docs/` PR）**

4. 对生产入口与 `*.workers.dev` 入口、3 台在线节点跑基线脚本，结果写入 `docs/verification/<日期>/relay-latency-baseline.md`（证据目录，写完不改）。
5. 证据文件末尾写结论：每个接口慢在边缘、D1 还是 Agent；`/nodes` 的 d1 段占 total 的比例；生产入口是否保留了 `Server-Timing` 头。B3 按这份结论选做。

## 9. 审核清单（设计任务逐条核对）

- [ ] `git diff --stat` 无 `packages/contracts/`、`migrations/`、`agent/`、`apps/web/`
- [ ] 中间件在全局鉴权之前；401 / 404 / 5xx 带头有测试
- [ ] 头里无 URL、路径、IP、节点 id、错误文本；desc token 有白名单
- [ ] D1 包装：`this` 为原对象、`batch` 解包、`withSession` 包装、`undefined` 透传，均有测试
- [ ] runtime WeakMap 键仍为原始 `env.DB`，`index.test.ts` 通过
- [ ] 无上下文时计时为空操作；现有测试未改断言
- [ ] 基线脚本口令只读环境变量，不打印；`/snapshot` 间隔 ≥ 2.1s；host-ops 只调只读动词
- [ ] troubleshooting §12、CHANGELOG 一行、面板 patch bump
- [ ] 证据：verify 输出、预览 URL 头、部署后基线证据 PR
