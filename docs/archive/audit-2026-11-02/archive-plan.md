# 文档归档方案（archive-plan）

> 状态：历史记录（方案已执行——2026-11-02 于 docs/consolidation 分支落地，归档结构与迁移清单以 docs/archive/README.md 为准）· 日期：2026-11-02
> 范围：`docs/` 全部文档的归类、归档结构、管理规则与迁移清单。
> 约束：本文件只做设计，不移动/删除任何现有文档；执行需主人批准后进行。

---

## 1. 现状判断（现行 vs 历史）

### 1.1 现行有效（agent 开发时可作依据）

| 类别 | 文件 |
|---|---|
| 工作协议 | `AGENTS.md`、`README.md`、`docs/README.md` |
| 架构与规划 | `docs/design-v3.md`、`docs/plan-v4.md`、`docs/legacy-feature-inventory.md` |
| UI 规范 | `docs/ui-redesign/ui-guidelines.md`、`docs/ui-redesign/page-specs.md`（AGENTS.md §6.4 唯一来源）；`docs/ui/ui-spec.md`（组件/令牌/变更单流程，与 §6.4 并存，见 §6 冲突项） |
| 功能设计（均已实现，各自领域权威） | `diagnostics.md`、`host-ops.md`、`host-ops-async.md`、`host-ops-e2e.md`、`caddy-management.md`、`port-forward.md`、`backup.md`、`dual-mode.md`、`agent-lifecycle.md`、`agent-releases.md`、`install.md`、`live-observation.md`、`data-layering.md` |
| 工程流程 | `docs/engineering/`（testing、release、adr/）、`docs/auto-deploy.md`、`docs/release-versioning.md`、`docs/production-readiness.md` |

### 1.2 历史 / 已取代 / 一次性产物

| 文件 | 原因 |
|---|---|
| `design-v1.md`、`design-v2-simple.md` | 已被 design-v3 取代（文件头已自标注） |
| `study-openagents-connection.md` | 研究资料，结论已落入 v2/v3 |
| `c1-acceptance.md`、`c2-acceptance.md`、`c3-acceptance.md` | 一次性验收证据 |
| `c3-plan.md` | 设计稿，已实现，内容已由 `caddy-management.md` 承接 |
| `plan-waves.md` | 一次性多 agent 排期，波次已结束 |
| `plan-gate-split.md` | 待拍板提案（特殊状态，见 §4.3） |
| `docs/ui-changes/001–016` | 变更单，功能均已落地；留档不再更新 |
| `docs/ui-redesign/ui-ia-review.md`、`index.html` | 审查方案与静态示意，已落地（changelog.md 留现行区作记录） |
| `docs/ui-redesign/audit-2026-11-02/`（截图）、`audit-icons.md` | 走查记录，一次性 |
| `docs/ui/proto/`、`docs/ui/shots/`、`docs/ui/gallery.md` | 旧规范 v2.2 样稿与截图；ui-redesign 落地后仅作历史 |

### 1.3 发现的冲突（迁移时必须解决）

- AGENTS.md §0 必读顺序第 6 条仍指向 `docs/ui/ui-spec.md`，红线 3 与 §6.3 也引用它；而 §6.4 说 UI 规范唯一来源是 ui-redesign 两份文件。**两处并存，需拍板分工**（建议：ui-spec.md 保留为令牌/组件详规 + 变更单流程载体，页面/交互范式以 ui-redesign 为准，§0 与红线 3 改写为同时指向两边并说明分工）。
- `docs/ui/SOURCE.md` 说 ui/ 目录是旧仓库副本"不再作为开发来源"，与红线 3 的引用自相矛盾。

---

## 2. 归档方案

### 2.1 目录结构

```
docs/
  README.md                  # 唯一索引：现行表 + 归档表（§3）
  <现行文档>.md               # 平铺，维持现状，不再按版本号新增
  engineering/               # 现行：流程与 ADR（ADR 永不归档，只改状态字段）
  ui-redesign/               # 现行：UI 规范两份 + changelog.md
  ui/                        # 现行：ui-spec.md（组件/令牌/变更单）；proto|shots|gallery 移出后只留规范本体
  archive/                   # 历史区：只进不出（除非迁回，见 §4.4）
    README.md                # 归档索引：原路径 | 归档日期 | 原因 | 取代者
    2026-11/<原名>.md         # 按归档年月分一层目录，文件名保持原样
    2026-11/ui-changes/…
    2026-11/ui-proto/…
    2026-11/ui-shots/…
    2026-11/ui-redesign-ia/…
```

规则：
- 归档目录按 `YYYY-MM` 分层（本项目文档量约 60 个文件，按年太粗、按日太碎，按月正好）。
- 归档时文件名不改，保持 git 历史可追溯（`git mv`）。
- 图片随所属文档一起归档，不留孤儿资产。
- `docs/engineering/adr/` 不进 archive；废弃 ADR 只把状态改为"已废弃/被取代"，符合 ADR 惯例。

### 2.2 文档头部信息（必备状态块）

所有 `docs/**/*.md`（ADR 沿用其既有格式除外）顶部统一 4 行块：

```markdown
> 状态：现行 ｜ 已取代（由 docs/xxx.md 取代）｜ 历史记录（一次性，不再更新）｜ 提案（待拍板）
> 适用范围：本文件约束什么（一句话）
> 最后核验：YYYY-MM-DD（核验方式：PR 号 / verify.sh / 真机）
> 关联：AGENTS.md §x、docs/yyy.md（无则写"无"）
```

- "最后核验"在每次行为变更 PR 中顺手刷新；超过 6 个月未核验的现行文档在索引里标 `⚠ 待复核`，不自动归档。
- 已取代/历史记录两类必须写清"取代者"或"一次性事由"，防止 agent 误当现行依据。

### 2.3 索引与检索

- `docs/README.md` 改为两张表：
  1. **现行权威文档**：主题 | 文件 | 状态 | 最后核验；
  2. **归档速览**：只写一行"已归档文档见 `docs/archive/README.md`（N 篇）"，不逐条列，避免索引膨胀。
- `docs/archive/README.md` 是归档全量表：原路径 | 归档后路径 | 日期 | 原因 | 取代者。查旧方案只查这一个文件。
- 判定"能不能用"只看两点：在现行表内 + 状态块为"现行"。不满足即不得作为开发依据。

### 2.4 归档判定标准与批准

满足任一即应归档：
1. 文档头部自标"被 X 取代"或新文档声明取代它；
2. 对应功能已下线或路由/接口已删除；
3. 一次性产物已完成使命（验收记录、排期、审查方案、走查报告、变更单）；
4. 连续两次"待复核"周期（约 12 个月）无人核验且无代码引用。

流程：agent 在 PR 中提出（`git mv` + 更新两个索引 + 改头部状态块），**主人批准后合入**。禁止 agent 自行删除文档；删除只允许主人显式指令，且优先用 `git rm` 留历史。

### 2.5 迁回（复活）规则

旧方案要重新作依据时：从 archive 移回原路径或新路径、状态块改回"现行"、刷新核验日期、登记索引，走普通 PR + 主人批准。禁止直接在 archive 内编辑后引用。

---

## 3. 建议 AGENTS.md 新增条款（§3 红线追加，编号 9；或并入红线 6）

可直接落地的短条款：

> **9. 文档门禁**：
> a) 新增 `docs/**/*.md` 必须先归类（现行规范 / 工程流程 / 决策记录 / 提案 / 历史资料），带状态块（状态/适用范围/最后核验/关联），并在同一 PR 登记 `docs/README.md` 索引；缺任一不予合入。
> b) 文档被取代或成为一次性产物时，不删除：`git mv` 入 `docs/archive/YYYY-MM/`、状态块改为"已取代/历史记录"、同步两个索引。
> c) `docs/archive/` 内文档不得作为开发依据引用；需复活先迁出并恢复"现行"状态（PR + 主人批准）。
> d) 未列入 `docs/README.md` 现行表的文档一律视为非权威。

同时小改两处（解决 §1.3 冲突）：
- §0 必读顺序第 6 条改为："`docs/ui-redesign/ui-guidelines.md` + `page-specs.md`（页面/交互范式，强制）；`docs/ui/ui-spec.md`（令牌/组件详规/变更单流程）"。
- 红线 3 的"UI 规范"引用同步改为上述分工表述。

---

## 4. 迁移执行清单（分阶段）

### 阶段 0：定规则（先行，独立小 PR）
- 本方案获批；AGENTS.md 加上述条款并改 §0/红线 3；`docs/README.md` 改版为两表结构；建 `docs/archive/README.md` 空索引。
- 风险：**低**。无文件移动；唯一风险是两处 UI 规范分工表述拍板不当，回退成本也只是改文档。

### 阶段 1：纯移动历史文档（一个 PR 或按目录拆 2–3 个）
- `git mv`：`design-v1.md`、`design-v2-simple.md`、`study-openagents-connection.md`、`c1/c2/c3-acceptance.md`、`c3-plan.md`、`plan-waves.md` → `archive/2026-11/`；
- `docs/ui-changes/` 整体 → `archive/2026-11/ui-changes/`；
- `docs/ui/proto/`、`docs/ui/shots/`、`docs/ui/gallery.md` → `archive/2026-11/ui-proto|ui-shots/`；
- `docs/ui-redesign/ui-ia-review.md`、`index.html`、`audit-2026-11-02/`、`audit-icons.md` → `archive/2026-11/ui-redesign-ia/`；
- 每个文件头部补状态块；更新两个索引。
- 风险：**中低**。① 文档间相对链接会断 —— 移动后全仓 grep 原路径并修正（主要为 docs 内互链，代码内不引用这些路径）；② 外部书签/旧 PR 描述中的 GitHub 链接 404 —— 可接受，git 历史可查；③ `host-ops.md` 等现行文档引用了 ui-changes/#008 编号 —— 编号保留即可，只在索引注明归档位置。

### 阶段 2：合并与冲突消解（需主人逐项拍板）
- `docs/ui/ui-spec.md` 与 ui-redesign 分工落字（按 §1.3 建议）；`docs/ui/SOURCE.md` 改写或归档；
- `plan-v4.md` 刷新状态（C2 已完成等过期描述），或拍板整体归档、以 CHANGELOG + 新规划取代；
- `plan-gate-split.md`：拍板则转设计文档（现行），否决则归档并标"提案未采纳"；
- `production-readiness.md` 6 项门禁若已完成则归档为历史记录。
- 风险：**中**。涉及内容取舍，不能机械执行；每项单独 commit 便于回退。

### 阶段 3：全量补状态块 + 核验日期（机械批处理，可拆多 PR）
- 对剩余现行文档逐个补 4 行状态块；核验日期取该文档最近相关 PR 日期。
- 风险：**低**；工作量分散，建议按目录分批。

### 删除策略
- 本方案全程**不删除任何文件**。归档满 12 个月后由主人决定是否清理；agent 不得提议批量删除。

---

## 5. 防复活/防乱增机制小结

- 新增文档 = 状态块 + 索引登记 + PR，缺一退回（AGENTS.md 条款 9a）；
- 归档文档不得引用（条款 9c），索引现行表是白名单（条款 9d）；
- "已取代"必须写明取代者，旧方案自然失去权威；
- 一次性产物（验收/走查/排期）完成即归档，现行区只留长期规范。
