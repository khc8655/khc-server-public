# 文档 × 代码一致性审计（2026-11-02）

> 范围：全仓库 73 份受 git 跟踪的 Markdown 文档（docs/ 下 64 份，含 ui-changes 16 份；根目录与 .github 等 9 份）。
> 方法：只读核查。逐份对照 `apps/api`、`apps/web`、`agent/`、`packages/contracts`、`migrations/`、`scripts/`、`.github/workflows/`、wrangler 配置实际内容；测试数量以实跑为准（agent `unittest` 736 项、vitest 298 项/40 文件，均退出码 0）。
> 本审计不涉及 UI 走查（另有并行审计），不修改任何文档与代码。

## 0. 结论（一句话）

文档总量 73 份、整体结构健康，核心机制类文档（diagnostics / dual-mode / live-observation / data-layering / host-ops / ADR）与代码高度一致；但**运维入口类文档（README、AGENTS.md、release/auto-deploy/production-readiness、design-v3 的接口与表章节）存在系统性过时**，最严重的是「生产复用 staging Worker/D1」这一已执行的架构决策（commit `60cdb91`）在所有发版文档中均无记录，且多份文档仍以「未上线、需建生产资源」为前提。

---

## 1. 文档清单（路径 / 用途 / 最后变更 / 是否仍有效）

### 根目录与工程入口

| 路径 | 用途 | 最后变更 | 判定 |
|---|---|---|---|
| `README.md` | 项目定位、快速开始 | 2026-11-01 | ⚠️ 部分过时（测试数） |
| `AGENTS.md` | 工作协议、红线、命令 | 2026-11-02 | ⚠️ 部分过时（迁移数、测试数、UI 规范引用矛盾） |
| `CHANGELOG.md` | 版本变更记录 | 2026-11-02 | ✅ 有效，与 git log 同步 |
| `CONTRIBUTING.md` | 贡献指南 | 2026-10-25 | ✅ 有效 |
| `.github/pull_request_template.md`、`ISSUE_TEMPLATE/*.md` | PR/issue 模板 | 2026-10-25 | ✅ 有效 |

### docs/ 顶层（设计 / 规划 / 验收）

| 路径 | 用途 | 最后变更 | 判定 |
|---|---|---|---|
| `docs/README.md` | 文档地图 | 2026-11-01 | ⚠️ 失准（未收录 ui-redesign 等新文档，仍列旧 UI 规范为强制） |
| `docs/design-v3.md` | 冻结核心设计 | 2026-10-31 | ⚠️ §2.1 路由表、§2.3 D1 表已落后于代码 |
| `docs/design-v1.md`、`docs/design-v2-simple.md` | 历史设计 | 2026-10-25 | 📦 历史参考（docs/README 已标注），建议移入 archive |
| `docs/plan-v4.md` | 当前阶段与决策 | 2026-10-26 | ⚠️ 有效但 P0/C2/C3 已完成，未折叠 |
| `docs/plan-waves.md` | Wave 计划 | 2026-10-29 | 📦 各 Wave 均已标注完成，建议归档 |
| `docs/plan-gate-split.md` | 写闸门拆分方案 | 2026-11-01 | ✅ 有效（已落地） |
| `docs/c1/c2/c3-acceptance.md`、`docs/c3-plan.md` | 阶段验收/计划 | 2026-10-25~27 | 📦 已完成，建议归档 |
| `docs/production-readiness.md` | 上线门禁 | 2026-10-27 | ❌ 整体过时（前提「未上线」已不成立，详见 §2-P0-4） |
| `docs/release-versioning.md` | 版本策略 | 2026-10-31 | ⚠️ 与 release.md、package.json 实际不一致 |
| `docs/auto-deploy.md` | CI 自动部署 | 2026-11-01 | ❌ 多处过时（占位 id、临时停用段落） |
| `docs/engineering/release.md` | 发版流程 | 2026-10-25 | ❌ 多处过时（版本源、迁移步骤、生产配置假设） |
| `docs/engineering/testing.md` | 测试金字塔 | 2026-10-25 | ✅ 有效（命令与 verify.sh/CI 一致） |
| `docs/legacy-feature-inventory.md` | 旧系统功能对照 | 2026-10-25 | ✅ 有效（对照清单性质） |
| `docs/study-openagents-connection.md` | 研究笔记 | 2026-10-25 | 📦 历史参考（含不存在的 `0002_events.sql` 提及，低危） |

### docs/ 机制类（与代码一致性高）

| 路径 | 用途 | 最后变更 | 判定 |
|---|---|---|---|
| `docs/diagnostics.md` | 诊断契约（7 核心码） | 2026-10-29 | ✅ 与 `lib/diagnostics` 一致 |
| `docs/dual-mode.md` | 双模式推导 | 2026-10-29 | ✅ 与 `lib/mode.ts` 一致 |
| `docs/live-observation.md` | 观测层 ticket/SSE | 2026-11-01 | ✅ 与 `routes/live.ts` 一致 |
| `docs/data-layering.md` | 数据分层（含 0005） | 2026-11-01 | ✅ 有效 |
| `docs/host-ops.md` / `host-ops-async.md` / `host-ops-e2e.md` | 主机运维 | 2026-10-29 | ⚠️ 机制一致；测试数快照过时 |
| `docs/port-forward.md`、`docs/caddy-management.md`、`docs/backup.md` | 适配器机制 | 2026-10-27~31 | ⚠️ 机制一致；测试数快照过时 |
| `docs/agent-lifecycle.md`、`docs/agent-releases.md` | Agent 生命周期/发版 | 2026-10-27 | ✅ 与 `khc/upgrade.py`、`routes/agent-*.ts` 一致 |
| `docs/install.md` | Agent 安装预检 | 2026-10-27 | ✅ 有效（`scripts/install-preflight-test.sh` 存在） |
| `docs/engineering/adr/ADR-0001~0007` | 架构决策 | 2026-10-25~29 | ✅ 有效 |
| `docs/ui-changes/001~016` | UI 变更单 | 2026-10-25~11-01 | ✅ 编号连续无缺号，作为历史追溯有效 |
| `docs/ui/*`（ui-spec、DECISIONS、SOURCE、gallery、README） | 旧 UI 规范 | 2026-10-25~29 | ❌ 与 §6.4 新规范双轨矛盾，应降级标注 |
| `docs/ui-redesign/*` | 新 UI 规范（唯一来源） | 2026-11-02 | ✅ 有效，但未被 docs/README 地图收录 |

### 代码目录内 README

| 路径 | 用途 | 最后变更 | 判定 |
|---|---|---|---|
| `agent/README.md` | Agent 内核+适配器说明 | 2026-10-26 | ⚠️ 适配器清单、测试数、TLS 环境变量过时 |
| `agent/adapters/host_ops/README.md` | host-ops 适配器 | 2026-10-26 | ✅ 有效 |

> apps/api、apps/web、packages/contracts 无独立 README（不算缺失，仓库地图由根 README/docs 承担）。

---

## 2. 过时 / 错误项（含证据）

### P0（误导运维/发版，必须优先修）

| # | 位置 | 文档说法 | 代码/配置实际情况 |
|---|---|---|---|
| P0-1 | `docs/engineering/release.md` §3–4（L17–43）、`docs/auto-deploy.md` L10/L22、`docs/production-readiness.md` B1（L21） | staging 与生产是两套资源；生产需「创建 `<d1-name>`、替换 wrangler.toml 占位 D1 id」 | commit `60cdb91`「生产复用 <worker-name> Worker/D1」后，`wrangler.toml` 与 `wrangler.staging.toml` **内容相同**（同名 Worker `<worker-name>`、同一 D1 id `<d1-id>`），占位检查（ci.yml L75–80）已成永远通过的死代码。该决策无任何文档/ADR 记录 |
| P0-2 | `docs/auto-deploy.md` L26–38「2026-10-31 临时停用自动部署」 | 「ci.yml 注释掉 push/PR 触发，过渡期用 deploy-local.sh」 | 当前 `.github/workflows/ci.yml` L4–8 push/PR 触发**已恢复**，main 推送即自动部署生产（2026-11-02 PR #59 合并后实际部署成功）。临时停用段落未更新 |
| P0-3 | `docs/production-readiness.md` 全文（尤其 L3–4、B1–B6） | 「代码达上线候选水平，6 项硬门禁完成前不应切生产流量」 | 生产已上线运行（CI 部署 + 冒烟通过）。B1（占位 id）、B3（迁移只列到 0004，现有 0005）、测试数（Agent 713/前端 271 → 实测 736/298）全部过时 |
| P0-4 | `docs/design-v3.md` §2.3（L122）「D1（4 张表）」 | 核心表 = nodes/app_configs/revisions/audit | `migrations/` 现有 0001–0005：0002 新增 `certificates`、`settings` 两表，0003 加 `nodes.live_endpoint`，0004 加 `app_configs.last_apply_error`，0005 清 `last_state_json`。即实际 6 表 + 2 新增列 |
| P0-5 | `docs/design-v3.md` §2.1（L77–85）Worker API 路由表 | 仅 7 组核心路由 | `apps/api/src/routes/` 实际 12 个文件：`agent_lifecycle / agent-commands / agent-releases / backup / certs / diagnostics / live / mode / settings` 等均未在路由表中体现（作为「冻结核心」清单可接受缺编排层路由，但应显式注明「另有扩展路由见 routes/ 目录」，否则会误导契约评审） |

### P1（活跃文档中的硬错误）

| # | 位置 | 文档说法 | 实际情况 |
|---|---|---|---|
| P1-1 | `AGENTS.md` §2 仓库地图 | 「migrations/ D1 schema（只增；当前 0001）」 | 当前已到 `0005_clear_runtime_state.sql` |
| P1-2 | `README.md` L57、`AGENTS.md` §5（L72） | 「Agent 150 项」 | 实测 `python3 -m unittest discover -s agent/tests -t agent` = **736 项**；vitest = **298 项**/40 文件 |
| P1-3 | `agent/README.md` L19 | 「tests/ # 231 项 unittest」 | 736 项（21 个测试文件） |
| P1-4 | `agent/README.md` L17–18 目录树 | 适配器只列 `node_exporter.py`、`wireguard.py` | `agent/adapters/` 实际 6 个：`caddy_site / certificates / host_ops / node_exporter / port_forward / wireguard` |
| P1-5 | `agent/README.md` L240 | 「可选 TLS（`AGENT_TLS_CERT/KEY`）」 | agent 内核（`khc_agent.py`、`khc/http.py`）**无任何 TLS 实现**，该环境变量不存在；HTTPS 只能经 Caddy 反代或 cloudflared |
| P1-6 | `docs/engineering/release.md` §1（L5） | 「当前 `0.1.x`（C1/P0），`package.json` 为版本源」 | 根 `package.json` version = `0.0.0`，无 git tag；版本实际分散在 `CHANGELOG.md`（[0.1.0]）与 Agent 版本号（0.1.4），「版本源」说法不成立 |
| P1-7 | `docs/engineering/release.md` §3（L27）staging 首建步骤 | 只执行 `migrations/0001_init.sql` | 缺 0002–0005；且根 `package.json` 的 `db:migrate:local/remote` 脚本同样只跑 0001（代码侧隐患，文档未给完整迁移序列） |
| P1-8 | `docs/host-ops.md` L226、`docs/port-forward.md` L54、`docs/backup.md` L50、`docs/c2-acceptance.md` L18 | 各测试数快照（572/643/123/231+52 等） | 全部过时（现 736/298）。验收类文档可作历史快照保留，但 host-ops/port-forward/backup 是机制文档，快照数字建议改为「以 verify.sh 实测为准」 |

### P2（低危 / 历史文档）

| # | 位置 | 问题 |
|---|---|---|
| P2-1 | `docs/study-openagents-connection.md` L234 | 提及 `migrations/0002_events.sql`（不存在）；研究笔记性质，建议加「历史研究」标注 |
| P2-2 | `docs/plan-v4.md` | P0/C2/C3 已完成但未折叠/归档标注，与 C5 计划混排 |
| P2-3 | `AGENTS.md` §5 verify.sh 描述顺序 | 实际顺序为 typecheck → vitest → build → compileall → agent unittest → shell 语法（verify.sh L11–22），描述把 agent 测试写在 build 前，顺序不符（命令本身全部可执行） |

---

## 3. 矛盾项（双轨 / 互相打架）

| # | 矛盾双方 | 证据 |
|---|---|---|
| C-1 | **UI 规范双轨**：`AGENTS.md` §0 必读第 6 条与 §3 红线第 3 条仍要求遵守 `docs/ui/ui-spec.md`（§7.1–7.4）；而 §6.4 声明 ui-redesign 落地后唯一来源是 `docs/ui-redesign/ui-guidelines.md` + `page-specs.md`。`docs/README.md` L12 也把 `docs/ui/ui-spec.md` 列为「UI 规范（强制）」 | AGENTS.md L16–24、L45–50 vs L103–111；docs/README.md L12–13。新人会同时读到两套「强制」规范 |
| C-2 | **版本源**：`release.md` §1 说 package.json 是版本源（0.1.x），实际 package.json=0.0.0，CHANGELOG 有 [0.1.0]，Agent 0.1.4，`docs/release-versioning.md` 又是另一套叙述 | 三处口径不一致 |
| C-3 | **生产资源假设**：release.md/auto-deploy.md/production-readiness.md（两套资源 + 占位 id）vs wrangler.toml 实际（生产=staging，60cdb91） | 见 P0-1 |
| C-4 | **自动部署状态**：auto-deploy.md「临时停用」vs ci.yml 触发器已恢复 | 见 P0-2 |

---

## 4. 缺失的文档 / 记录

| # | 缺失项 | 说明 | 关键度 |
|---|---|---|---|
| M-1 | **「生产复用 staging Worker/D1」决策记录** | commit `60cdb91` 改变了整套发版拓扑（无独立生产 Worker/D1、占位检查失效），但无 ADR、无 release/auto-deploy 更新。这是当前最重要的文档缺口 | 高 |
| M-2 | **D1 迁移执行 runbook** | 0002–0005 如何按序应用到 staging/生产、如何核对表结构、失败如何处理，无任何文档；`db:migrate:*` 脚本只跑 0001 也无人提示 | 高 |
| M-3 | **docs/README.md 地图未收录的现存文档** | `docs/ui-redesign/*`（新强制规范）、`plan-gate-split`、`diagnostics`、`dual-mode`、`backup`、`port-forward`、`caddy-management`、`install`、`auto-deploy`、`data-layering`、`agent-lifecycle`、`agent-releases`、`production-readiness`、`release-versioning`、`plan-waves`、`c2/c3-acceptance` 等约 18 份未在地图中，「每类信息唯一来源」规则实际无法执行 | 高 |
| M-4 | **Agent 能力边界独立文档** | `svc.restart`/`svc.logs` 等待确认能力只在 `docs/ui-redesign/page-specs.md` L148 以「能力占位」提及；写盘白名单、防符号链接逃逸等安全边界散落在 AGENTS.md 红线与 agent 代码注释中，无单一说明 | 中 |
| M-5 | **限流/权限现状说明** | 登录限流用 isolate 内存、KV 未绑定的现状只在已过时的 production-readiness B6 中提及 | 中 |
| M-6 | **docs/design-v1/v2 归档** | 已被 docs/README 标注为「研究/背景」，但仍与设计主文档同目录平铺；建议移入 `docs/archive/` 并在文首加作废标注（docs/README 维护规则本身要求「显式标注作废」） | 低 |

---

## 5. 处理建议（按严重度排序）

1. **先补 M-1 + 修 P0-1/P0-2/C-3/C-4（一批改）**：为「生产复用 staging」补一篇 ADR（或直接在 release.md 记决策），同步重写 release.md §3–4、auto-deploy.md（删掉临时停用段落、改掉占位 id 说法）、production-readiness.md（标注「已上线，本文存档」或按现状重写门禁状态）。这批改动相互依赖，应同一个 PR 完成。
2. **修 P0-4/P0-5 + P1-1（design-v3 与 AGENTS.md 仓库地图）**：design-v3 §2.3 表清单补 certificates/settings 与 0003/0004 列（或注明「核心 4 表 + C3 扩展见 migrations/0002+」），§2.1 路由表注明扩展路由出处；AGENTS.md 「当前 0001」改为「当前 0005，只增」。
3. **解 C-1（UI 规范双轨）**：AGENTS.md §0/§3 与 docs/README.md 中 `docs/ui/ui-spec.md` 的引用改为指向 `docs/ui-redesign/`，旧 `docs/ui/` 文首加「已被替代」标注。
4. **补 M-2（迁移 runbook）**：在 release.md §5 展开 0001→0005 的顺序执行命令与核对点；顺手修 `package.json` 的 `db:migrate:*`（代码改动，需单独评估）。
5. **刷新 P1-2/P1-3/P1-8 测试数口径**：建议统一改为「以 `./scripts/verify.sh` 实测为准」+ 当前值，避免再次腐烂。
6. **修 P1-4/P1-5（agent/README）**：补全 6 个适配器清单；删除或更正 TLS 环境变量表述（内核不支持 TLS，HTTPS 靠 Caddy/cloudflared）。
7. **解 C-2（版本源）**：三处统一口径——要么 package.json 开始打真实版本，要么明确「版本源 = CHANGELOG + Agent 内嵌版本号」。
8. **归档批（P2 + M-6）**：design-v1/v2、plan-waves、c1/c2/c3-acceptance、c3-plan 移入 `docs/archive/` 并加作废标注；docs/README.md 地图同步补全 M-3 清单。

---

## 附：核查方法备查

- 测试实测：`python3 -m unittest discover -s agent/tests -t agent` → 736 项 OK；`npx vitest run` → 298 项/40 文件 OK（2026-11-02 本地）。
- 迁移实测：`ls migrations/` = 0001_init / 0002_c3 / 0003_live_endpoint / 0004_last_apply_error / 0005_clear_runtime_state；`grep CREATE TABLE` 确认 6 表。
- 路由实测：`ls apps/api/src/routes/` = 12 文件。
- 适配器实测：`ls agent/adapters/` = 6 个适配器（+ host_ops/ 目录）。
- wrangler 实测：`wrangler.toml` 与 `wrangler.staging.toml` 内容相同（diff 无差异项），git log 确认 `60cdb91 chore: 生产复用 <worker-name> Worker/D1`。
- TLS 实测：`grep -r TLS agent/khc/ agent/khc_agent.py` 无 TLS 服务端实现。

---

## 6. 整改执行记录（2026-11-02，分支 docs/consolidation）

主人批准按审计建议默认值直接执行（不开 PR）。默认口径的落地方式与裁量决定：

### 三条默认口径如何落地

1. **UI 规范分工**：执行为「整目录归档」而非「收窄」。`docs/ui/` 全套（ui-spec/README/DECISIONS/SOURCE/gallery/proto/shots）→ `docs/archive/ui-v2.2/`（文首加取代声明）；令牌权威 = `apps/web/src/styles/tokens.css`（代码为源，同步规则写入 `docs/ui-redesign/ui-guidelines.md` §8.8）；页面/交互范式唯一来源 = `docs/ui-redesign/ui-guidelines.md` + `page-specs.md`。理由：ui-spec 的组件/模板/流程章节与 ui-redesign 范式冲突，保留半本「现行」会延续双轨；其仍有价值的决策（DECISIONS）已归档可查。
2. **变更单流程**：废止。`docs/ui-changes/001–016` → `docs/archive/ui-changes/`（新增索引 README：编号/主题/状态）；流程并入 `.github/pull_request_template.md`（UI 自检清单）与 `.github/ISSUE_TEMPLATE/ui-change.md`（改写为 UI 改动提案模板，按六类页面范式组织）。
3. **归档原则**：只 `git mv` 不删除，保留 git 历史；归档索引集中登记在 `docs/archive/README.md`。

### 裁量决定（保守处理，待主人追认）

- **归档范围扩展**：除用户点名的 docs/ui/ 与 docs/ui-changes/ 外，另将 design-v1、design-v2-simple、study-openagents-connection、c1/c2/c3-acceptance、c3-plan、plan-waves 归档到 `docs/archive/2026-11/`（依据审计建议 8 与并行归档方案）；`plan-gate-split.md` 保留现行（PR #56 设计依据）。
- **CHANGELOG 历史条目不改**：L176 等 `docs/ui/shots/...` 字样为当时记录，保持原样（changelog 不回写）；现行文档中的同类引用已改为归档后路径。
- **wrangler.staging.toml 不删除**（未获授权删文件）：在 ADR-0008、release.md、AGENTS.md §5、README.md 四处写明脚枪警示。
- **测试数口径**：统一改为「以 `./scripts/verify.sh` 实测为准」，不写死数字（避免再次腐烂）。设计/验收文档中作为历史记录的具体数字（如「34 项测试」）保留原样，仅入口文档改口径。
- **归档文档内部路径**：归档件中对 `docs/ui/` 的引用属历史记录，未逐一改写；现行文档中的引用已全部指向归档位置或新规范。
