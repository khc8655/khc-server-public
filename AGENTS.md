# AGENTS.md — 接手本项目的 Agent 必读

> 目标：任何 Agent 读完本文件 + `docs/README.md`，就能按同一套规范继续开发，不需要再问"从哪开始"。
> 本文件是**工作协议**；具体技术设计见 `docs/design-v3.md` 与 `docs/plan-v4.md`。
>
> **仓库唯一来源：`khc8655/khc-server`。** 旧仓库 `khc8655/wireguard` 已冻结，仅作历史资料；不得再从旧仓库读取 PR/设计/代码作为开发依据。

## 0.1 协作基线（多 Agent）

- **GitHub `main` 是唯一协作基线**：所有 Agent 开工前先 `git fetch origin && git switch main && git pull`。
- 功能分支只从 `main` 拉出，命名 `feat/<scope>`；完成后走 PR/验证，再合入 `main`。
- 已同步进 `main` 的特性分支/PR 不再继续开发；避免在旧分支上叠加提交。
- 本地工作区必须干净后再同步；禁止把未提交改动留给下一个 Agent。
- 旧仓库 `khc8655/wireguard` 已冻结，仅历史来源。

## 0. 必读顺序（15 分钟）

1. `README.md` — 项目是什么、当前状态、快速开始
2. `AGENTS.md`（本文件）— 红线、流程、命令
3. `docs/README.md` — 文档地图与"每类信息的唯一来源"
4. `docs/design-v3.md` — 冻结核心 + 适配器架构
5. `docs/plan-v4.md` — 当前阶段与已拍板决策
6. `docs/ui-redesign/ui-guidelines.md` + `docs/ui-redesign/page-specs.md` — **所有 UI/交互改动必须遵守**（六类页面范式）；设计令牌唯一权威为 `apps/web/src/styles/tokens.css`
7. `docs/legacy-feature-inventory.md` — 旧系统功能对照（防止漏功能）

## 1. 项目定位

- 面板不是监控系统，是「服务器运维遥控器 + 配置仓库」：一个月打开约 10 次，平时零流量。
- 架构：Cloudflare Worker（控制面 + D1）+ React 面板 + Hub 上的 Python Agent（按需 HTTPS 调用）。
- 当前默认入口：`http://<IP 或域名>:8880`（用户已拍板；国内 8443 不可用）。传输 = `fetch()` + `cloudflare:sockets` 双通道。
- **不做**：旧数据迁移、心跳/WebSocket、KV/R2/DO/Cron、签名插件市场、多用户权限系统。

## 2. 仓库地图

```
apps/api/            Worker（Hono + D1）：routes/ = HTTP，domain/ = 仓库接口，db/d1/ = 实现，lib/ = 传输/加密/错误
apps/web/            React 面板；src/apps/<app>/ 是应用页面（加页面只加这里）
packages/contracts/  zod 契约 + TS 类型（前后端唯一接口定义）
agent/               Hub Agent：khc/ 内核 + adapters/ 适配器 + tests/（Python 标准库）
migrations/          D1 schema（只增不改；当前已应用到 0012，执行见 docs/engineering/d1-migrations.md）
docs/                设计、规范、规划、UI、ADR、工程流程
scripts/             hash-password、verify.sh
```

## 3. 红线（违反即退回）

1. **方案确认门禁**：涉及架构、契约、数据模型、UI 的改动，先给方案（至少 2 个选项 + 推荐），等主人明确同意再写代码。小 bug 修复可直接做，但要在汇报里说明。
2. **核心冻结**：Worker 路由/契约/D1 核心表/Agent 内核改动必须说明必要性；"跟某个软件有关的知识"只能进 `agent/adapters/<app>.py` 与 `apps/web/src/apps/<app>/page.tsx`。
3. **UI 规范**：所有界面改动必须遵守 `docs/ui-redesign/ui-guidelines.md` 与 `docs/ui-redesign/page-specs.md`（先归类六类页面类型、复用既有组件与范式，见 §6.4）；设计令牌唯一来源为 `apps/web/src/styles/tokens.css`，不新增色板与字号；UI 方案仍属红线 1 的确认范围。PR 模板含 UI 自检清单（浅/深/390 截图 + 四态）。
4. **安全**：不提交真实凭据；错误响应零凭据回显；写盘白名单/防符号链接逃逸；私钥 0600；Agent 升级只允许拉取式。
5. **不破坏生产**：main 合并即生产部署（ADR-0008），禁止其他分支/本地脚本自动部署；生产操作只由主人执行；上线前用 `wrangler versions upload` + 预览 URL 冒烟。
6. **文档同步**：改 API/契约/配置/流程，必须同步更新对应文档与本文件（如适用）。
7. **测试**：提交前 `./scripts/verify.sh` 全绿；UI 改动附浅/深/390 截图。
8. **单仓库**：所有开发、设计、PR、验证只在 `khc8655/khc-server`；旧 `khc8655/wireguard` 只允许作为历史来源引用，不得驱动新实现。需要旧设计时，先迁入本仓库再引用。
9. **文档门禁**：
   a) 新增 `docs/**/*.md` 必须先归类（现行规范 / 工程流程 / 决策记录 / 提案 / 历史资料），头部带状态块（状态 / 适用范围 / 最后核验 / 关联），并在同一 PR 登记 `docs/README.md` 索引；缺任一不予合入。
   b) 文档被取代或成为一次性产物时不删除：`git mv` 入 `docs/archive/`，状态块改为"已取代/历史记录"并写明取代者，同步更新两个索引（`docs/README.md` 与 `docs/archive/README.md`）。
   c) `docs/archive/` 内文档不得作为开发依据引用；需复活先迁出并恢复"现行"状态块（PR + 主人批准）。
   d) 未列入 `docs/README.md` 现行表的文档一律视为非权威。

## 4. 工作流（标准步骤）

```
1) 读需求 → 查 docs/README.md 找唯一来源 → 给方案（含取舍/风险）
2) 等主人确认（架构/契约/UI 必须；小修复可说明后直接做）
3) 建分支：feat/<scope> / fix/<scope> / docs/<scope> / chore/<scope>
4) 实现 + 测试（先契约/单测，再页面；Agent 先纯函数单测，再真机）
5) ./scripts/verify.sh
6) 更新 docs / CHANGELOG（如有行为变化）
7) PR：按 .github/pull_request_template.md；UI 改动附浅/深/390 截图与四态说明
8) 汇报：做了什么、证据（命令/输出/URL）、风险、下一步
```

## 5. 常用命令

```bash
./scripts/verify.sh                 # 全量：typecheck + vitest + build + compileall + agent 单测 + shell 语法（测试数量以实跑为准）
pnpm dev:api                        # Worker http://127.0.0.1:8787
pnpm dev:web                        # 前端 http://127.0.0.1:5173
pnpm typecheck && pnpm test && pnpm build
python3 -m unittest discover -s agent/tests -t agent -v
# 部署：合并 main 后 CI 自动部署（即生产，ADR-0008）；本地兜底 ./scripts/deploy-local.sh
# 上线前冒烟：npx wrangler versions upload → 预览 URL（不切生产流量）；配置唯一来源 wrangler.toml
```

## 6. 加东西怎么做

### 6.1 新增应用适配器（核心不动）
1. `agent/adapters/<app>.py`：实现 `Adapter`（name/version/api/schema/ports/render/validate/status/install/uninstall）；
2. `apps/web/src/apps/<app>/page.tsx`：`export const meta = { title, defaults }`（可选专属表单）；
3. 加 `agent/tests/test_<app>.py`（render/plan/apply/回滚/端口冲突）；
4. 跑 `./scripts/verify.sh`；真机 plan→apply→回滚→uninstall；
5. 验收标准：`git diff --stat` 不出现 `apps/api/`、`migrations/`、`packages/contracts/`、`agent/khc/`。

### 6.2 新增 Worker API / 表
1. 先改 `packages/contracts`（schema + 类型）；
2. `apps/api/src/routes/` + `domain/repos.ts` + `db/d1/`；
3. 补 `apps/api/test/`（路由 + 仓库 + 传输 mock）；
4. 迁移只新增 `migrations/000N_*.sql`，不改已应用迁移；
5. 更新 `docs/design-v3.md` 的接口/表章节。

### 6.3 新增 UI 页面
1. 按 §6.4 归类页面类型，并同步更新 `docs/ui-redesign/page-specs.md` 的路由总表与区块映射；
2. `pages/` 只组合 `ui/` + `patterns/` + `data/`，不新增第二种交互范式；
3. 路由与动作登记到 `registry/routes.ts` / `registry/actions.ts`；
4. 四态（空/加载/错误/离线）+ 浅/深/390 截图；
5. PR 按 `.github/pull_request_template.md` 的 UI 自检清单核对。

### 6.4 UI 统一范式（ui-redesign 落地后的强制约束）

规范唯一来源：`docs/ui-redesign/ui-guidelines.md`（页面类型与交互范式）+ `docs/ui-redesign/page-specs.md`（路由与区块映射）；设计令牌唯一权威为 `apps/web/src/styles/tokens.css`（改令牌 = 改该文件，不新建文档）。任何新增页面或功能：

1. **必须先归类**到六类页面类型之一（A 分诊概览 / B 列表对象 / C 单对象详情 / D 配置表单 / E 运维动作 / L 登录），并同步更新 page-specs.md 的路由总表与区块映射；
2. **必须复用**既有组件与交互范式（`ui/` 组件、状态带/对象表/全页唯一抽屉、SaveBar、ConfirmAction），行内按钮 ≤2、危险操作按动作注册表 L2/L3 确认、术语按统一表（节点/站点/内网穿透/Peer/保存并生效）；
3. **禁止**新增导航层级、第二种详情/操作入口、新 UI 运行时依赖、抽屉内再弹 Dialog。

不符合上述规范的新增功能不予合入。

## 7. 验收与发版

- 每阶段验收标准见 `docs/plan-v4.md`；测试与验收步骤见 `docs/engineering/testing.md`。
- 发版流程（版本、部署、回滚、secrets）见 `docs/engineering/release.md`；D1 迁移执行见 `docs/engineering/d1-migrations.md`。
- 生产与"staging"复用同一 Worker/D1（ADR-0008）：main 推送即生产部署，无独立预发环境；配置唯一来源是 `wrangler.toml`（原 `wrangler.staging.toml` 已于 2026-11-03 删除）。上线前冒烟用 `npx wrangler versions upload` + 预览 URL，见 `docs/engineering/release.md` §4。
- 架构决策记录见 `docs/engineering/adr/`；新决策必须补 ADR。

## 8. 高频坑（别重复踩）

- **Cloudflare `fetch()` 对裸 IP 一律 403 error 1003**（80/8880/8788 都实测过）。IP 直连必须走 `cloudflare:sockets` 的 `connect()`（见 `apps/api/src/lib/tcp-fetch.ts`）。
- 域名 + 自定义端口需要 `compatibility_date >= 2024-09-02`（或 `allow_custom_ports`）。
- Cloudflare 代理端口：HTTP 80/8080/8880/2052/2082/2086/2095；HTTPS 443/8443/2053/2083/2087/2096。
- Agent 默认 `0.0.0.0:8880`（用户拍板）；内部可用 `127.0.0.1:8787` + 隧道。
- HMAC 签名串：`METHOD|path|ts|nonce|sha256hex(body)`，path 不含 query；GET body hash 用空串。
- 不要用 `pkill -f <含自身命令行的串>`，会杀掉 SSH 会话；按 PID 或 `fuser` 处理。
- macOS `/tmp` 会被清理：SSH 的 askpass/known_hosts 不要长期依赖。
- 测试/脚本不要依赖 root、不要联网（install 用 mock fixture）。


## 核心冻结的编排层例外（#33，2026-10-27）

- `agent/khc/` 不引用具体应用名；应用状态通过适配器可选 `state_summary()` 汇总。
- `apps/api/src/lib/mode.ts` 属于**编排/知识层**，允许引用 `wireguard`/`caddy-site`/`port-forward`/`host-ops` 等应用名用于预检。
- `apps/api/src/lib/node-summary.ts` 同属**编排/知识层**（2026-11-10 经主人批准新增）：集中持有应用名（`wireguard`/`caddy-site`/`port-forward`）与配置形状知识，从 D1 期望配置派生节点应用摘要（模式/Peer/站点/转发计数），供 `GET /nodes` 与 `GET /nodes/:id` 的 `summary` 字段使用；`desiredMode` 唯一真源也在此。
  - **职责边界**：纯派生，输入是 D1 配置行或其最小投影，不连节点、不写库、不依赖 Hono；只读 `node_id/app/config_json`，不读取也不返回任何 secrets。
  - **不得扩散到路由**：应用名与配置形状只允许留在此文件；`routes/nodes.ts` 只做按 node 分组与调用，禁止在路由里写 `app === 'wireguard'` 这类判断，否则新增应用就要改核心路由，违反核心冻结。
- `apps/api/src/lib/diagnostics/*` 自 #49 起**只保留连接与 Agent 的 7 个核心码**，不得出现任何应用名（有 grep 测试）；应用问题由适配器 `status().problems` 上报，控制面补充来源放 `apps/api/src/lib/app-diagnostics/`。
- 路由、契约、D1 schema 仍按核心冻结管理；新增应用知识优先放适配器或编排层，不得扩散到核心路由。
