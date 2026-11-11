# UI 文档与历史遗留考古报告（2026-11-02）

> 任务：只读审计（2026-11-02；报告随后随文档整理一并入库）。未修改任何现有文档/代码。
> 现行规范基准：`docs/ui-redesign/ui-guidelines.md` + `docs/ui-redesign/page-specs.md` + `AGENTS.md` §6.4。

## 0. 结论摘要

1. **仓库里同时存在两套"UI 权威"**：旧 v2.2 体系（`docs/ui/`，含 ui-spec/DECISIONS/proto/shots）与新 ui-redesign 体系（`docs/ui-redesign/`）。新体系已于 2026-11-02 随 PR #58 落地并被 AGENTS.md §6.4 定为唯一来源，但**文档地图（docs/README.md）与 AGENTS.md 红线 3 仍把旧 ui-spec 标为强制规范**——新 agent 按图索骥会被引向已被取代的文档。
2. **旧体系体量不小**：`docs/ui/` 共 53 个文件（5 份 md + 13 个 proto 样稿 + 35 张旧截图），`docs/ui-changes/` 16 份变更单；全部内容仍有效力声明（"前端任何改动以此为准"），但实际已被取代。
3. **冲突共 11 项：文档过时 10 项，代码偏离规范 1 项**（全局 `/certs` 缺 302 过渡，page-specs 路由总表第 6 行承诺了但代码没有）。代码实现本身与新规范高度一致（与 11-02 浏览器走查结论互证）。
4. 最优先处理的不是删旧文档，而是**先修正入口层指向**（docs/README.md、AGENTS.md 红线 3），否则旧文档留着也会被误当权威。

---

## 1. 文档资产清单

### 1.1 现行有效（新规范体系）

| 路径 | 最后变更 | 状态 | 说明 |
|---|---|---|---|
| `docs/ui-redesign/ui-guidelines.md` | 2026-11-02 | ✅ 现行规范 | 六类页面 A/B/C/D/E/L + 交互范式 |
| `docs/ui-redesign/page-specs.md` | 2026-11-02 | ✅ 现行规范 | 路由总表 + 逐页区块映射 |
| `docs/ui-redesign/changelog.md` | 2026-11-02 | ✅ 有效 | 八步落地备案 + 302 路由处置表 |
| `docs/ui-redesign/audit-icons.md` | 未提交 | ✅ 有效 | 走查报告（P0-1 已标记修复） |
| `docs/ui-redesign/audit-2026-11-02/`（38 张 png） | 未提交 | ✅ 有效 | 走查 + 修复证据截图 |
| `AGENTS.md` §6.4 | 2026-11-02 | ✅ 有效 | 六类页面强制约束 |

### 1.2 已被取代但效力声明仍在（旧 v2.2 体系）

| 路径 | 最后变更 | 状态 | 说明 |
|---|---|---|---|
| `docs/ui/ui-spec.md` | 2026-10-29 | ⚠️ 被取代 | 自称"前端任何改动以此为准"；§1.3 路由总表、§1.4 模板 T1–T5、§2 流程 F1–Fn 与新范式不符 |
| `docs/ui/README.md` | 2026-10-25 | ⚠️ 被取代 | 仍声明 ui-spec 为准、proto/tokens.css 为令牌唯一来源 |
| `docs/ui/SOURCE.md` | 2026-10-26 | ⚠️ 自相矛盾 | 称"规范以来源仓库 wireguard 为准、改规范须双向同步"，与 AGENTS.md"旧仓库已冻结"直接冲突 |
| `docs/ui/DECISIONS.md` | 2026-10-25 | ⚠️ 部分失效 | U6（节点层侧栏导航）已被 redesign 的一级压平导航推翻；U1/U2/U4 等仍有效 |
| `docs/engineering/adr/ADR-0002-ui-spec-v2.2.md` | 2026-10-26 | ⚠️ 部分失效 | "按 v2.2 重写"决策已被 redesign 范式部分取代，且无后续 ADR 接续 |
| `docs/ui/proto/`（13 个文件：10 样稿 html + tokens.css + components.css + icons.js） | 2026-10-25/26 | 🗂 历史样稿 | v2.2 配套原型；tokens.css 已与实现漂移（见 2.4） |
| `docs/ui/shots/`（35 张 png） | 2026-10-26~29 | 🗂 历史截图 | 对应旧版页面，与新 UI 不符 |
| `docs/ui/gallery.md` | 2026-10-29 | ⚠️ 过时 | 截图索引；引用了不存在的 `shots/login.png` |

### 1.3 历史记录（内容真实、应归档而非删除）

| 路径 | 最后变更 | 状态 | 说明 |
|---|---|---|---|
| `docs/ui-changes/001`–`016`（16 份） | 2026-10-26~29 | 🗂 历史变更单 | 每份对应一个已落地功能；011 引用的 DiagnosticsCard/Drawer 已在 #58 删除 |
| `docs/ui-redesign/ui-ia-review.md` | 2026-11-02 | 🗂 方案存档 | redesign 的评审与八步方案；§186 列了未执行的文档收尾动作 |
| `docs/ui-redesign/index.html` | 2026-11-02 | 🗂 示意稿 | redesign 规划期的全站示意，落地后转历史 |
| `docs/design-v1.md` / `docs/design-v2-simple.md` | 2026-10-25 | 🗂 历史参考 | docs/README 已标注"非当前规范"（处理正确的范例） |
| `docs/legacy-feature-inventory.md` | 2026-10-25 | ✅ 仍有效 | 旧系统功能对照，AGENTS.md 必读项，与 UI 范式无关 |

---

## 2. 历史遗留问题清单

| # | 来源 | 现状（代码/事实） | 影响 | 建议处置 |
|---|---|---|---|---|
| 2.1 | `docs/README.md` 文档地图（11-01） | 仍写"UI 规范（强制）= docs/ui/ui-spec.md"，全表未收录 ui-redesign 三文档 | **新 agent 被引向已取代规范**，是最危险的单点 | 修文档：改指向 + 收录新规范 |
| 2.2 | `AGENTS.md` 红线 3 vs §6.4 | 红线 3 要求按 `ui-spec §7.1` 交变更单、按 `§7.2–7.4` 分层；§6.4 说唯一来源是 ui-redesign | 同一文件两套权威，门禁依据模糊 | 修文档：红线 3 改指新规范（变更单流程是否保留需主人拍板） |
| 2.3 | `docs/ui-redesign/ui-ia-review.md:186` | 方案自己写明"需同步修订 `ui-spec.md §1.3` 路由总表"；#58 已合入但未执行 | 已知欠账，旧路由表（/activity、节点层 /forwards /certs /peers /apps）仍在"强制规范"里 | 归档 ui-spec 时整体标注取代，或按该清单补标 |
| 2.4 | `docs/ui/proto/tokens.css` 自称"令牌唯一来源" | 实现 `apps/web/src/styles/tokens.css` 已有 38 个令牌，proto 只有 31 个（缺 --bg-elevated/--danger-line/--fg/--line/--s-2/--shadow-sm 等 7 个） | "唯一来源"名存实亡，真实来源已是 apps/web | 归档 proto；权威改为实现侧 tokens.css |
| 2.5 | `ui-spec §1.3/F1`：`/hubs/new` 添加节点向导（T5 四步） | 代码从未实现（git -S "hubs/new" 无记录）；现状是 HubsPage 抽屉（符合新 B 型范式） | 文档描述不存在的流程 | 随 ui-spec 一并归档标注 |
| 2.6 | `ui-spec §1.3`：`/activity`、节点层 `/activity` 路由 | PR #26 已拍板"不做活动页"（最近操作并入节点概况） | 文档与已拍板决策矛盾 | 随 ui-spec 归档标注 |
| 2.7 | ui-redesign 范式决策 | 属重大架构决策，但 `docs/engineering/adr/` 停在 ADR-0007，无对应 ADR（AGENTS.md §7 要求新决策必须补 ADR） | 决策链断档 | 补 ADR-0008（六类页面范式） |
| 2.8 | `apps/web/src/registry/routes.ts` 头注与 `PageTemplate = T1–T5` | 注释引用 "ui-spec §7.4/§1.3"，模板枚举仍是旧 T 体系；页面类型 A–E/L 只活在文档里 | 代码内引用被取代文档（注释/类型命名层） | 低优先：改注释或把模板枚举改名对齐新代号 |
| 2.9 | `docs/ui/SOURCE.md` 双向同步规则 | 与 AGENTS.md"旧仓库冻结、仅历史来源"矛盾 | 规则不可执行 | 随 docs/ui/ 归档时作废 |
| 2.10 | PR 模板要求"UI 变更单 `docs/ui-changes/NNN.md`" | 016 之后无新单；#58 以 ui-redesign 三文档代替变更单并在 changelog 注明 | 流程事实漂移，下一单编号/是否还开单无依据 | 主人拍板：变更单流程保留/简化/废止，写回 AGENTS.md |
| 2.11 | `docs/ui/gallery.md` 引用 `shots/login.png` | 文件不存在（"如存在"字样）；shots/ 全部截图为旧 UI | 索引失真 | 随 docs/ui/ 归档 |

---

## 3. 与现行规范的冲突点分类

### A. 文档过时（10 项）
上表 2.1–2.6、2.8–2.11（2.8 为代码注释引用过时文档，归入此类）。

### B. 代码偏离规范（1 项，另有 1 项走查已知）
- **全局 `/certs` 缺 302 过渡**：`page-specs.md` 路由总表第 6 行承诺 `/certs` → `/settings?tab=certs` 302；代码 `router.tsx` 只有 `/hubs/$hubId/certs` 的 302，全局 `/certs` 路由在 #58 中被直接删除（git -S 证实曾存在于 748e687）。书签/外链会 404。
- （走查已记录，不重复计）应用详情页下划线 Tabs 与其余页 Segmented 药丸不统一 = audit-icons.md P1-2。

### 互证结论
代码主体与新规范一致（302 过渡、术语、抽屉范式均已落地）；问题几乎全在**文档层没有跟上代码**。

---

## 4. 建议归档顺序

1. **入口层先行**：修 `docs/README.md`（指向 ui-redesign、收录三文档）+ 消解 `AGENTS.md` 红线 3 与 §6.4 的双权威——不改这两处，后面归档再多也会被误引。
2. **补 ADR-0008**（六类页面范式 + 302 过渡决策），把决策链接上。
3. **整目录归档 `docs/ui/`**（ui-spec/README/SOURCE/DECISIONS/proto/shots/gallery.md → `docs/archive/ui-v2.2/`），在原文位置留一行取代声明；`docs/ui-changes/` 加 README 索引后作为历史批次一并归档。
4. **令牌权威转移**：声明 `apps/web/src/styles/tokens.css` 为唯一来源，proto/tokens.css 随归档。
5. **收尾 code 层小项**：全局 `/certs` 补 302；routes.ts 注释/模板枚举对齐新代号。
6. **明确变更单流程去向**（主人拍板），写回 AGENTS.md 与 PR 模板。
7. 302 暗路由确认无引用后删除，并同步 page-specs 路由总表"调整后"列改为现状。

---

## 5. 证据（实际查过的文件与提交）

**文件**：docs/README.md、AGENTS.md（工作区规则）、docs/ui/{README,SOURCE,DECISIONS,ui-spec,gallery}.md、docs/ui/proto/tokens.css、docs/ui-changes/001/011/016、docs/ui-redesign/{ui-guidelines,page-specs,ui-ia-review,changelog}.md、index.html、docs/engineering/adr/（0001–0007 目录 + ADR-0002 全文）、docs/legacy-feature-inventory.md、docs/design-v1/v2-simple、apps/web/src/styles/tokens.css、apps/web/src/registry/routes.ts、apps/web/src/app/router.tsx、apps/web/src/pages/HubsPage.tsx、apps/web/src/main.tsx、.github/pull_request_template.md

**git / PR**：`git log` 逐文件最后变更日期；`git log --diff-filter=D`（#58 删 DiagnosticsCard/DiagnosticsDrawer/PeersPage；ce74b18 删 features/ 旧前端；be3e25a 删 App.tsx）；`git log -S "hubs/new"`（无记录）、`git log -S "path: '/certs'"`（748e687 引入、62a0cdd 移除无 302）；`gh pr list --state merged`（#51 UI 一致性修复、#55–#58 范式演进链）
