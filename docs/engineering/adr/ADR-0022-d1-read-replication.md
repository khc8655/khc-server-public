# ADR-0022: 接入 D1 Read Replication 与读己之写书签

- 状态：提议
- 日期：2026-11-23
- 决策者：主人
- 关联：`docs/design-v3.md`、`docs/data-layering.md`、`docs/security-boundaries.md`、`apps/api/src/middleware/d1-session.ts`

## 背景

在统一单控制面通道（ADR-0021）并上线分段 `Server-Timing`（B1）与节点缓存优化（B3-①②）后，生产环境（经全球代理边缘回源 Cloudflare Worker，D1 主库位于北美）的实测显示，纯读多写少的控制面接口仍有较高 D1 往返耗时：

- `GET /api/v1/nodes`：Worker 总耗时中位数 219ms，D1 段 219ms（占 100%）；
- `GET /api/v1/certs`：Worker 总耗时中位数 213ms，D1 段 213ms（占 100%）；
- 即便节点 `/state`、`/overview` 在 isolate 节点缓存命中后，认证轮转校验或设置读取仍需跨区访问单一主库。

根据 Cloudflare 官方文档，**D1 Read Replication**（Public Beta）可在北美/欧洲/亚太/大洋洲自动维护全球只读副本，配合 Workers Sessions API（`env.DB.withSession`）按就近副本路由只读查询；该能力包含在标准 D1 Rows Read / Rows Written / Storage 计费内，不另收副本费用。

## 选项

| 选项 | 做法 | 利 | 弊 |
|---|---|---|---|
| A 仅继续扩大 isolate 内存缓存 | 在节点外进一步缓存列表/证书/设置 | 不依赖平台特性 | 跨 isolate 无法共享，冷请求或切边缘仍需跨区读主库；配置易不一致 |
| **B D1 Read Replication + `khc_d1bm` 书签（选定）** | 开启数据库只读复制，Worker 在 `/api/*` 中间件为每个请求创建 `withSession(...)`，经 `AsyncLocalStorage` 透明路由 `D1Database`，并用 `khc_d1bm` Cookie 传递 bookmark | 无需修改 8 个 D1 仓储；读请求自动命中就近副本；单浏览器保证顺序一致；不改前端契约 | 跨浏览器之间存在短暂副本同步延迟（通常数秒内） |

## 决策

1. **按请求开启 D1 会话（`apps/api/src/middleware/d1-session.ts`）**：
   - 若请求带有效 `khc_d1bm` Cookie（过滤空白、控制字符与 `first-*` 保留关键词），调用 `env.DB.withSession(bookmark)`，确保本次读或写至少能看到该浏览器此前确认的最新状态；
   - 无合法书签时，`GET` / `HEAD` 调用 `withSession('first-unconstrained')`（就近副本优先），写方法（`POST`/`PUT`/`PATCH`/`DELETE` 等）调用 `withSession('first-primary')`（直连主库并获取新书签）；
   - 请求完成后若 `session.getBookmark()` 非空，通过追加 `Set-Cookie: khc_d1bm=<bookmark>; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800`（HTTPS 加 `Secure`，不设 `Domain`）回写浏览器。不触发 D1 查询的接口（如 `/api/v1/health`）不回写该 Cookie。
2. **异步上下文透明代理（`apps/api/src/lib/d1-session.ts`）**：
   - 在 `apps/api/src/index.ts` 通过 `instrumentD1(createSessionAwareD1(env.DB))` 注入仓储：`prepare`、`batch` 与（若会话实现则包括）`exec` 自动转发到当前 `AsyncLocalStorage` 会话，不挂载在 isolate 单例状态上，无请求上下文时直接回退原生 `env.DB`。
3. **直连主库例外**：
   - 登录防爆破限流（`apps/api/src/routes/auth.ts` 的 `allowRequest({ db: c.env.DB })`）继续使用原始 `c.env.DB` 原子 upsert，不经读副本会话。
4. **一致性边界**：
   - 单个浏览器在同一会话期内通过 `khc_d1bm` 书签获得**顺序一致（Read-Your-Writes）**体验；不同浏览器/设备之间对刚提交的配置可能出现几秒内副本复制滞后，结合本系统“低频单运维遥控器”定位属于可接受权衡。

## 影响 / 迁移 / 回滚

- **D1 Schema / 前端 / Agent 契约**：零改动；既有 `khc_sess` 属性与 `/api/v1/*` 载荷不变。`Path=/api` 且无 `Domain`，不污染静态资源缓存。
- **回滚**：
  - 即时降级：在 Cloudflare Dashboard 关闭该 D1 数据库的 Read Replication，`withSession` 自动回到主库，无需代码发版；
  - 代码回滚：移除 `app.ts` 中的 `d1Session` 中间件与 `index.ts` 的 `createSessionAwareD1` 包装并重新部署 Worker，立即恢复全部主库直连，无任何数据迁移或兼容性遗留。

## 验证

- 单测（`apps/api/test/d1-session.test.ts` + `apps/api/test/helpers/sqlite-d1.ts`）：验证 GET/HEAD 走 `first-unconstrained`、写请求走 `first-primary`、带合法 `khc_d1bm` 复用书签、畸形/保留字符串被忽略、`khc_sess` 与 `khc_d1bm` 共存不互相覆盖、限流直连主库、`prepare`/`batch`/`exec` 与无请求上下文回退、以及 `Server-Timing` `d1` 计时正确；
- `./scripts/verify.sh && node scripts/docs-lint.mjs --strict` 全绿；
- 生产部署后实测 `khc_d1bm` 下发属性与 `GET /api/v1/nodes`、`GET /api/v1/certs` 等接口 `Server-Timing` 的 `d1` 耗时变化并归档验证报告。
