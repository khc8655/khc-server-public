# 文档瘦身与协作流程（提案）

> 状态：历史（已实施，2026-11-13） ｜ 最后核验：2026-11-13 ｜ 关联：`AGENTS.md` §4–§5、`scripts/docs-lint.mjs`

## 1. 问题

数据取自 main `0c3207d`。

| 对象 | 现状 | 问题 |
|---|---|---|
| `AGENTS.md` | 148 行 / 13 KB | 每个 Agent 每次会话都要整篇读入。混入易变事实（部署步骤、secret 名、迁移编号、仓库迁移史）。部署流程在红线 5、§5、§7 写了三遍。已有错误或矛盾：开头写唯一仓库是 `khc8655/khc-server`，红线 8 写 `khc-server-public`；§1、§8 仍写默认入口 `http:8880`；§0.1 排在 §0 之前 |
| `CHANGELOG.md` | 1314 行 / 139 KB，54 个版本段，跨度约 10 天 | 每段平均约 24 行，写成了复盘：根因、实现细节、文件名都在里面，和 PR 描述重复。新库 28 个提交里有 14 个改了它，并行 PR 容易冲突 |
| 发版与部署 | `release.md` 337 行、`release-versioning.md` 105 行、`auto-deploy.md` 74 行，另有 `testing.md` §5、`AGENTS.md` 三处、ADR-0013/0015/0016/0019 | 同一套流程写了七处以上。`release-versioning.md` 的示例还停在 0.3.0。`release.md` 混着历史内容：§4.1 旧手工预览、§7.2 的 0.1.7 实例、§7.4 换钥记录。`ci.yml` 423 行，其中 61 行注释，记的是事故经过 |
| 状态块 | `release.md` 的状态块 504 字符，`TODO-2026-11-06.md` 343 字符 | 「最后核验」后面的括号写成了变更记录 |
| `docs/README.md` | 115 行 | 「现行权威」表里混了 9 份一次性验证报告和 4 份已完成或过时的计划，有的说明长达数百字 |
| 状态失真 | 例如 `plan-gate-split.md` 状态块写「待主人拍板」，索引写「已随 #56 落地」；`plan-v4.md` 状态块写「C2 进行中」 | 文档没有退出机制，完成后不会更新状态，也不会归档 |
| 超长单文档 | `dual-mode.md` 782 行，`design-v3.md` 477 行 | 设计、实现清单、测试清单、原 UI 变更单、已完成的里程碑混在一起 |

**根因**：现行文档和过程记录没有分开。每次改动都把"怎么走到这里"追加进现行文档，却从不删除。其实 git log、PR 和 ADR 已经记下了过程。文档门禁（红线 9）要求每份文档都登记索引、写状态块、归档时同时改两份索引，连一次性报告也要往索引里塞说明，门禁本身也在制造臃肿。

## 2. 原则

1. **现行文档只写现状和做法**：系统现在是什么样、该怎么操作。演变过程留在 git log、PR 和 ADR 里。
2. **一件事只写在一个地方**，其他文档只放链接。
3. **目录决定文档类别**，不靠登记索引（见 §4.5）。
4. **易变事实不写进文档**：版本号、迁移编号、secret 名以代码和配置为准，文档只写文件路径。
5. **用体积预算加脚本检查防止复发**，不靠自觉。

## 3. 方案对比

| 方案 | 内容 | 成本 | 防复发 |
|---|---|---|---|
| A 只修错 | 修正 §1 列出的错误口径，手工删一些冗余段落 | 约 1 小时 | 否，两周后回到原样 |
| **B 结构治理（推荐）** | 重定目录语义和门禁，合并重复文档，限制 CHANGELOG 格式，加体积预算检查脚本，同时写定新的协作流程 | 3 批，每批 1–3 小时 | 是 |
| C 全面重写 | 重建整个文档体系，或引入文档站 | 数天 | 是，但会打断开发，迁移风险高 |

推荐 B。

## 4. 目标形态（方案 B）

### 4.1 AGENTS.md（≤ 100 行）

只保留以下 7 节，每条规则写一行，细节放链接：

1. 项目一句话定位与「不做」清单
2. 必读链接（≤ 5 个）
3. 红线（≤ 10 条）
4. 协作流程（§5，含规划者、执行者、主人三种角色）
5. 常用命令（verify、dev、test）
6. 高频坑（只留仍然有效的）
7. 核心冻结与编排层例外（压缩成规则加文件清单）

移出的内容：部署机制挪到 `release.md`；仓库迁移史挪到归档；迁移编号和默认端口直接删除，以代码为准。

### 4.2 CHANGELOG

- 每条一行，≤ 120 字，只写用户能感知的变化。根因、实现方式和文件名写在 PR 描述里。
- 每个版本段 ≤ 8 条。分类沿用 Keep a Changelog 的 Added / Changed / Fixed / Removed。
- 根文件 ≤ 400 行。超出时把最旧的版本段整段原样移到 `docs/archive/changelog/<YYYY-MM>.md`，不改写历史条目。
- `check-release-consistency.mjs` 只检查最新版本段，迁移旧段不影响这个门禁。

### 4.3 发版文档合并为一份

- `docs/engineering/release.md`（≤ 200 行）作为唯一的发版文档。它吸收 `release-versioning.md`（版本规则）和 `auto-deploy.md`（CI 行为），结构为：版本规则 → 发版流程 → 兼容矩阵 → 回滚 → 检查表。
- 历史内容（§4.1、§7.2 实例、§7.4 换钥记录、`auto-deploy.md` 的事故记录）移入归档。决策本身已经在 ADR 里。
- `testing.md` §5.1「发版 8 步」改成链接到 `release.md`。
- `agent-releases.md`、`agent-lifecycle.md` 只描述 Agent 机制，其中重复的发版步骤改为链接。
- `ci.yml` 每个 step 的注释 ≤ 3 行，写明做什么并引用 ADR 编号，删掉事故经过的叙述。

### 4.4 状态块

统一为一行，≤ 200 字符：

```
> 状态：现行｜提案（草案/已拍板/已实施）｜历史 ｜ 最后核验：YYYY-MM-DD ｜ 关联：最多 3 个链接
```

「最后核验」后面只写日期，不加括号说明。「适用范围」改为正文第一段的一句话。

### 4.5 目录语义与门禁（替换红线 9）

| 目录 | 类别 | 规则 |
|---|---|---|
| `docs/`（除下面三个目录） | 现行 | 必须登记在 `docs/README.md`；只写现状 |
| `docs/plans/` | 提案 | 状态块写提案状态；不登记索引；实施完成或被否决后移入 `docs/archive/plans/` |
| `docs/verification/<日期>/` | 证据 | 写完不再修改；不登记索引；不能作为规范依据 |
| `docs/archive/` | 历史 | `git mv` 移入即完成归档，不逐条登记。`archive/README.md` 只保留规则说明 |

另设 `docs/plans/backlog.md`，作为唯一的待办清单（≤ 60 行，每项一行加链接）。它吸收 `production-readiness.md` §2、`TODO-2026-11-06.md` 的遗留项、`arch-review` §9。

`docs/README.md` 精简到 ≤ 80 行：只列现行文档，每条说明 ≤ 30 字。

### 4.6 归档清单（批次 1 执行）

| 文档 | 理由 |
|---|---|
| `docs/TODO-2026-11-06.md` | 已无可开工项，遗留项转入 backlog |
| `docs/plan-v4.md` | 路线图已完成；已拍板的决策在 ADR-0004 |
| `docs/plan-gate-split.md` | 已随 #56 落地 |
| `docs/production-readiness.md` | 余项转入 backlog |
| `docs/plans/arch-review-remediation-2026-11-03.md` | 批次已落地，§9 转入 backlog |
| `docs/plans/server-docs-plan.md` | runbook 已落地，剩余条目转入 backlog |
| `docs/plans/preprod-fix-plan-2026-11-10.md`、`docs/plans/ui-ia-redesign-2026-11-12.md` | 执行者先核对批次是否全部合入；全部合入则归档，未完成的批次转入 backlog |
| `docs/ui-redesign/changelog.md`、`visual-walkthrough-2026-11-07.md`、`audit-2026-11-08.md` | 本身就是记录，不是规范 |

### 4.7 超长文档拆分（批次 3）

- `dual-mode.md` 只保留概念、状态模型、兼容性、切换 SOP 和预检 API，目标 ≤ 300 行。§5.7 测试清单、§6.2 编排方案对比、§7 原 UI 变更单移入归档。
- `design-v3.md` 的 §6–§10（对现有代码的处理、里程碑、已拍板、二期）移入归档；§1.1 中按日期叠加的修订说明合并成现状描述。

### 4.8 检查脚本 `scripts/docs-lint.mjs`

接入 `verify.sh`，前两周只告警，之后改为报错。检查项：

- 行数上限：`AGENTS.md` ≤ 100、`docs/README.md` ≤ 80、`CHANGELOG.md` ≤ 400；其他现行文档 ≤ 400 行（超出的放进脚本里的白名单，并注明原因）
- `CHANGELOG.md` 单条 ≤ 160 字符
- 状态块 ≤ 200 字符
- 现行文档不得链接 `docs/archive/`
- 现行文档里的相对链接必须指向存在的文件
- `docs/` 下除 plans、verification、archive 外的每个 `.md` 都必须出现在 `docs/README.md` 中

## 5. 协作流程（写入新 AGENTS.md）

| 角色 | 职责 |
|---|---|
| 规划者 | 写提案 PR、拆分批次、给出验收标准；在执行 PR 中审核并验收；维护 backlog |
| 执行者（Codex 等） | 按提案的一个批次开一个 PR；不修改提案文件；发现提案有误时在 PR 里提出，由规划者修改提案 |
| 主人 | 拍板提案、派发批次、合并 PR |

流程：

1. 规划者开提案 PR：`docs/plans/<主题>-<YYYY-MM-DD>.md`，标题以 `plan:` 开头。提案 ≤ 300 行，包括背景、方案对比与推荐、范围与不做、批次、待拍板项。每个批次写明改动范围、验收标准、必测项，以及是否需要升版本号。
2. 主人拍板，合并提案 PR，状态改为「已拍板」。
3. 执行者一个批次一个 PR，PR 描述写明「关联提案 / 批次」「偏离提案之处」「证据」。
4. 规划者审核 diff 和证据，在 PR 评论里给出「通过」或「退回 + 原因」。
5. 全部批次合入后，规划者把提案状态改为「已实施」并移入归档，未完成的项转入 backlog。

PR 模板（`.github/pull_request_template.md`）增加「关联提案 / 批次」「偏离提案之处」两栏。

## 6. 执行批次

**注意**：`.md` 文件在 CI 的 `paths-ignore` 内，改文档不会触发部署。批次 2 改 `ci.yml` 会触发一次部署（应用代码不变）。

### 批次 1：协作规则与清理（只改文档）

- 按 §4.1 重写 `AGENTS.md`，写入 §5 协作流程，修正 §1 列出的错误口径
- 按 §4.5 重写红线 9、`docs/README.md`、`docs/archive/README.md`
- 按 §4.6 归档，新建 `docs/plans/backlog.md`
- PR 模板增加两栏

验收：

- `AGENTS.md` ≤ 100 行，`docs/README.md` ≤ 80 行
- 现行文档的相对链接全部有效（执行者在 PR 里附检查命令和输出）
- PR 描述附「删除内容 → 去向」对照表：每条删掉的规则或事实，要么已存在于某份现行文档（写出文件和章节），要么已移入归档（写出路径），要么明确说明已过时
- 不修改任何代码和配置

### 批次 2：发版文档与 CHANGELOG

- 按 §4.3 合并发版文档并收敛 `ci.yml` 注释
- 按 §4.2 迁出旧版本段，把 CHANGELOG 格式规则写进 `CONTRIBUTING.md`

验收：

- `release.md` ≤ 200 行；`release-versioning.md`、`auto-deploy.md` 已归档；全仓除 `release.md` 和 ADR 外，不再有完整的部署步骤描述（用 grep `versions upload` 验证）
- `CHANGELOG.md` ≤ 400 行；`./scripts/verify.sh` 全绿（含 `check-release-consistency`）
- `ci.yml` 的改动只涉及注释，`git diff -w` 中不出现非注释行的变化
- 合并后核对 CI deploy job 成功，`/api/v1/version` 的 commit 与合并提交一致

### 批次 3：检查脚本与超长文档

- 按 §4.8 新增 `docs-lint.mjs` 并接入 `verify.sh`（告警模式）
- 按 §4.7 拆分 `dual-mode.md`、`design-v3.md`

验收：

- `node scripts/docs-lint.mjs` 在当前 main 上无报错；故意构造超限文件时能报出告警
- `dual-mode.md` ≤ 300 行
- `verify.sh` 全绿

## 7. 待拍板

1. 是否采用方案 B。
2. CHANGELOG 根文件的保留规则：推荐「≤ 400 行，超出整段迁出」，备选「只保留最近 30 天」。
3. `docs-lint` 的接入方式：推荐先只接 `verify.sh` 告警两周再改报错；备选是新增一个纯文档 CI job，这样只改文档的 PR 也会检查。
4. backlog 的载体：推荐 `docs/plans/backlog.md`，任何执行者都能直接读；备选 GitHub Issues，需要执行者有 gh 权限。
5. 确认 §4.6 的归档清单。
6. 批次 2 改 `ci.yml` 会触发一次部署：可以接受，或把注释收敛并入下一次功能发版。

## 8. 实施记录（2026-11-13）

主人决定由规划者直接实施三个批次，§7 待拍板项按推荐值执行。与提案的偏离：

| 项 | 提案 | 实际 | 原因 |
|---|---|---|---|
| `dual-mode.md` | ≤ 300 行 | 385 行 | 保留 §0–§4 与预检 API 后无法再删而不丢机制；仍在通用上限 400 内 |
| `design-v3.md`、`ui-guidelines.md` | ≤ 400 行 | 445 / 427 行，列入 `docs-lint.mjs` 白名单 | 契约与 UI 规范需要集中在一份 |
| `docs-lint` | 先告警两周 | 直接以 `--strict` 接入 `verify.sh` | 实施后当前 main 零问题，没有需要过渡的存量 |
| `ci.yml` 注释收敛 | 批次 2 | 未做，转入 backlog | 改 `ci.yml` 会触发部署，并入下次功能发版 |
| CHANGELOG 迁出 | 按月份 | 0.7.6 及更早整体迁入 `docs/archive/changelog/before-0.7.7.md` | 0.3.0 一段横跨 10 月至 11 月，按月拆会切断条目 |
| 代码注释中的旧文档路径 | 未提 | 未改，转入 backlog | 改 `apps/*/src` 会触发面板 bump |
