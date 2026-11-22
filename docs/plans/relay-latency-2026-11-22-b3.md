# B3 开工说明：Worker 降延迟

> 状态：已拍板 ｜ 最后核验：2026-11-22 ｜ 关联：`docs/plans/relay-latency-2026-11-22.md` §4 B3、B1 基线证据

> **给开发 agent**：本文是 B3 的完整任务说明。**开工前提：B1 已合入并部署，`docs/verification/<日期>/relay-latency-baseline.md` 已合入。** 先读 `AGENTS.md`、提案、B1 基线证据和本文全文。哪几项要做由 §1 的门槛决定，门槛不满足的项不做，在 PR 里写明数据。认为本文有误时在 PR 里提出，不要改 `docs/plans/` 下的文件。

## 0. 速览

| 项 | 值 |
|---|---|
| 分支 | `feat/worker-latency`（从最新 `main` 拉） |
| PR 标题 | `feat(api): 探测滑动并发与 Worker 侧 D1 往返优化` |
| 发版类型 | A（Worker），面板 **patch**；③ 落地时同 PR 附 ADR |
| 拆 PR | ①② 一个 PR；③ 单独一个 PR（含 ADR，需主人先在控制台开启读复制） |

## 1. 做哪几项（按 B1 基线判定）

| 项 | 门槛 | 依据（取 B1 证据里生产入口的中位数） |
|---|---|---|
| ① 探测滑动并发 | **无条件做** | 改动小、只减不增 |
| ② 节点读取缓存统一 | `/state` 或 `/overview` 的 `d1` 段中位数 ≥ 150ms | 每次都要 `requireNode` 读一次 D1 |
| ③ D1 读副本 + bookmark | `GET /nodes` 的 `d1` 段 ≥ 其 `total` 的 30%（主人已拍板的门槛） | 只读 D1 的接口固定开销 |
| ④ 第三方边缘 | 「网络+边缘」列是多数接口的最大项 | 不改代码，只出结论 |

建议顺序：① → ③ → 重新测量 → 再判断 ②（读副本生效后 ② 可能不再需要）。

## 2. ① 探测滑动并发

**位置**：`apps/api/src/routes/nodes.ts` `POST /nodes/probe`（`:527` 起），现为每 4 个节点一批 `Promise.all`，等这一批最慢的结束才开始下一批（`:544-545` 注释与 `concurrency = 4`）。

**改法**：

- 改为并发池：上限 **6**，任意一个完成即补位下一个节点；单节点逻辑（`/state` 调用、10s 预算、`bypassCooldown: true`、TLS 分类、投影、`lastSeenAt` 60s 节流）**原样保留**，抽成一个函数后由并发池调用。
- 结果数组顺序必须与 `deps.nodes.list()` 的节点顺序一致（不是完成顺序）。
- 更新 `:544` 的注释：Cloudflare 现在的 6 条限制只约束「等待响应头」阶段（2026-04 changelog），上限 6 是保守取值；`cloudflare:sockets` 的 TCP 连接同样计入。

**测试**（`apps/api/test/nodes-probe.test.ts` 补充）：

1. 8 个节点、假 Agent 让第 1 个延迟 300ms、其余 50ms：总耗时明显小于「两批各取最大」（用假时钟或宽松上界断言），且结果顺序等于节点顺序。
2. 同时在途的 Agent 调用数从不超过 6（假 Agent 内计数取最大值）。
3. 单节点抛错或返回非 2xx 只影响自己那一行，其余照常；现有用例全部通过。

## 3. ② 节点读取缓存统一（满足门槛才做）

**现状**：`routes/snapshot.ts` 有 15s isolate 内节点缓存 `getSnapshotNode`（按 `NodeRepo` 实例的 `WeakMap`）；其他路由都用 `routes/helpers.ts` 的 `requireNode` 每次读 D1。

**改法**：

1. 把缓存移到 `routes/helpers.ts`：`getNodeCached(deps, id)`（15s，按 `deps.nodes` 实例隔离）与 `forgetNode(deps, id)`。`snapshot.ts` 改用它。
2. **只用于只读路由**：`GET /nodes/:id/snapshot`、`GET /nodes/:id/state`、`GET /nodes/:id/overview`。所有写路由与动作路由（`apps.ts` 的 plan/apply/rollback/call、`mode.ts`、`agent_lifecycle.ts`、`backup.ts`、`certs.ts`、`cfDns.ts`、`diagnostics.ts`）继续用 `requireNode` 读主库。
3. 改节点后在本 isolate 内清缓存：`nodes.ts` PATCH（`:471` 后）与 DELETE（`:506` 后）、`tunnels.ts:101`、`cfDns.ts:693` 与 `:763`。
4. `lastSeenAt` 写入后同步更新缓存里的对象（`snapshot.ts:114-115` 已是这样做的），`fetchNodeState` 与 `/probe` 的节流判断也读同一对象，避免节流失效导致每次都写 D1。
5. 风险写进 PR：其他 isolate 最多 15s 读到旧 endpoint，只影响只读路由；动作路由不受影响。

**测试**：同 isolate 内 PATCH endpoint 后立刻 `GET /state` 用新 endpoint；15s 内重复 `GET /state` 只读 1 次 D1（假仓库计数）；DELETE 后 `GET /state` 返回 404；`lastSeenAt` 节流在缓存命中时仍生效。

## 4. ③ D1 读副本 + bookmark（满足门槛、主人开启后才做；单独 PR）

**开工前**：查 Cloudflare 官方文档确认 D1 读复制当前的可用状态与计费，写进 PR；由主人在 Cloudflare 控制台为该数据库开启读复制（具体操作以官方文档为准）。

**设计**：

1. **按请求选会话**：在 B1 的计时中间件旁边新增一个 `/api/*` 中间件，用 `AsyncLocalStorage` 保存本请求的 D1 会话：
   - 请求带 `khc_d1bm` Cookie → `env.DB.withSession(<bookmark>)`；
   - 否则 `GET` / `HEAD` → `withSession('first-unconstrained')`；写方法 → `withSession('first-primary')`。
2. **仓库不改**：`index.ts` 里把 `env.DB` 换成一个解析代理，`prepare/batch/exec` 转发给「当前请求的会话 ?? `env.DB`」，再套 B1 的 `instrumentD1`。没有请求上下文时直接用 `env.DB`。开工时先确认没有仓库在构造函数里预先 `prepare` 语句。
3. **读己之写**：响应时把 `session.getBookmark()` 写回 Cookie `khc_d1bm`（`HttpOnly`、`Secure`、`SameSite=Strict`、`Path=/api`、`Max-Age` 与会话一致 8h）。同一浏览器的下一个请求带着 bookmark，保证读到自己刚写的数据。前端不用改。
4. **不经过会话的路径**：登录限流 `allowRequest({ db: c.env.DB })` 保持直连主库。
5. **ADR**：新写 `docs/engineering/adr/ADR-0022-d1-read-replication.md`（模板见 ADR README），写清一致性模型（每个浏览器顺序一致、跨浏览器可能短暂读旧）、回滚方式（删掉中间件即回到主库），并登记到 ADR 索引；状态「提议」，主人拍板后改「已接受」。
6. `docs/security-boundaries.md` 会话一节补一句新 Cookie `khc_d1bm`（不含敏感信息，只用于读一致性）。

**测试**：`test/helpers/sqlite-d1.ts` 增加假的 `withSession`（记录约束参数、返回带 `getBookmark()` 的会话）。断言：GET 用 `first-unconstrained`；写方法用 `first-primary`；带 Cookie 时用 bookmark；响应写回 Cookie 且属性齐全；无请求上下文时走原绑定；`batch` 与 `exec` 也走会话。

## 5. ④ 第三方边缘（不改代码）

若 B1 显示「网络+边缘」是多数接口的最大项：本批只在 PR 或证据里写结论（各接口边缘耗时中位数、生产入口与 `workers.dev` 入口的差值），并请设计任务在 `docs/plans/backlog.md` 登记「评估给 Worker 挂 Cloudflare 自定义域名并调整第三方边缘源站」。该项涉及 `workers_dev` 红线（`release.md` §1），**不得**在本批改 `wrangler.toml`。

## 6. 范围与禁止

- 允许：`apps/api/src`（上面列出的文件；③ 另含 `index.ts` 与新中间件）、`apps/api/test`、`docs/security-boundaries.md`（③）、ADR（③）、`package.json`、`CHANGELOG.md`。
- 禁止：`packages/contracts/`、`migrations/`、`agent/`、`apps/web/`、`wrangler.toml`。
- 核心冻结说明（PR 必写）：`nodes.ts`、`helpers.ts`、`index.ts` 属 Worker 核心，说明每项改动对应的 B1 数据。

## 7. 坑

1. 并发池不要用「每批 `Promise.all`」的变体，要真正的补位；结果按节点顺序写回预分配数组。
2. 节点缓存只能进只读路由；动作路由读旧 endpoint 会把写动作发到错的地址。
3. `lastSeenAt` 节流依赖节点对象上的 `lastSeenAt`，缓存命中时必须是同一个对象。
4. ③ 的会话必须按请求隔离，不能挂在 isolate 单例上（`getWorkerRuntime` 是 isolate 级缓存）。
5. ③ 的 Cookie 不能带 `Domain`，`Path` 限 `/api`，避免影响静态资源缓存。

## 8. 文档与版本

- `CHANGELOG.md` 各一行，例如「首页节点探测改为滑动并发，节点多时整体返回更快。」/「读多写少的接口改走 D1 就近只读副本（同一浏览器保证读到自己的写入）。」
- 面板 patch；Agent 不变。

## 9. 交付证据

1. `./scripts/verify.sh` 全绿。
2. 前后对比：用 `scripts/relay-latency-baseline.mjs` 在与 B1 相同的入口、节点、次数下重测，表格对比改动涉及的接口（中位数与各段）。写入 `docs/verification/<日期>/relay-latency-b3.md`。
3. 门槛判定表：§1 每一项的实测值与「做 / 不做」结论。
4. 1 台测试 Hub + 1 台 Peer：节点编辑 endpoint 后立即执行一次 plan，确认用的是新地址。

## 10. 审核清单（设计任务逐条核对）

- [ ] §1 门槛判定有数据支撑；未达门槛的项未实施
- [ ] ① 并发上限 6、真正补位、结果按节点顺序；单节点逻辑未改；注释已更新
- [ ] ② 缓存只进三个只读路由；五处写入后清缓存；`lastSeenAt` 节流有测试
- [ ] ③ 会话按请求隔离；bookmark Cookie 属性正确；ADR-0022 与索引；security-boundaries 已补
- [ ] 无 `wrangler.toml`、契约、迁移、前端、Agent 改动
- [ ] 前后对比证据与门槛判定表齐全
