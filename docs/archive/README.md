# 文档归档索引（docs/archive）

> 状态：现行（作为归档区唯一索引维护） ｜ 适用范围：`docs/archive/` 全部内容 ｜ 最后核验：2026-11-05（登记 ui-redesign 旧规范载体与 UI 走查产物归档） ｜ 关联：`docs/README.md` §2–§3、AGENTS.md 红线 9
>
> **archive 内文档不得作为开发依据**（AGENTS.md 红线 9c）。需要复活某文档：迁回原路径或新路径、状态块改回"现行"、刷新核验日期、登记 `docs/README.md`，走 PR + 主人批准。
> 归档只 `git mv` 不删除，保留 git 历史。

## 归档清单

| 原路径 | 归档路径 | 归档日期 | 原因 | 取代者 |
|---|---|---|---|---|
| `docs/ui/`（整目录：ui-spec / README / DECISIONS / SOURCE / gallery / proto / shots） | `docs/archive/ui-v2.2/` | 2026-11-02 | UI v2.2 规范体系已被 ui-redesign 取代（PR #58 落地） | `docs/ui-redesign/ui-guidelines.md` + `page-specs.md`；设计令牌 → `apps/web/src/styles/tokens.css` |
| `docs/ui-changes/`（001–016） | `docs/archive/ui-changes/`（含索引 README） | 2026-11-02 | 16 张变更单全部落地；变更单流程废止，并入 PR 模板 | `.github/pull_request_template.md` UI 自检清单 |
| `docs/design-v1.md` | `docs/archive/2026-11/design-v1.md` | 2026-11-02 | 连接层被 v2 取代、其余被 v3 取代（文件头已自标注） | `docs/design-v3.md` |
| `docs/design-v2-simple.md` | `docs/archive/2026-11/design-v2-simple.md` | 2026-11-02 | 接口清单被 v3 取代 | `docs/design-v3.md` |
| `docs/study-openagents-connection.md` | `docs/archive/2026-11/study-openagents-connection.md` | 2026-11-02 | 研究资料，结论已落入 v2/v3 设计 | `docs/design-v3.md` |
| `docs/c1-acceptance.md` | `docs/archive/2026-11/c1-acceptance.md` | 2026-11-02 | 一次性验收证据（2026-10-25/26） | 无（历史记录） |
| `docs/c2-acceptance.md` | `docs/archive/2026-11/c2-acceptance.md` | 2026-11-02 | 一次性验收证据（2026-10-26/27） | 无（历史记录） |
| `docs/c3-acceptance.md` | `docs/archive/2026-11/c3-acceptance.md` | 2026-11-02 | 一次性验收证据（2026-10-26/27） | 无（历史记录） |
| `docs/c3-plan.md` | `docs/archive/2026-11/c3-plan.md` | 2026-11-02 | C3 执行前设计稿，已实现 | `docs/caddy-management.md` 等 |
| `docs/plan-waves.md` | `docs/archive/2026-11/plan-waves.md` | 2026-11-02 | 一次性多 agent 排期，波次已结束 | `docs/plan-v4.md` |
| `docs/ui-redesign/index.html` | `docs/archive/ui-redesign/index.html` | 2026-11-05 | 早期全站视觉示意，自带色板/字阶/宽度（232px 侧栏、460px 抽屉）与现行令牌冲突，不能作为实现依据 | `docs/ui-redesign/ui-guidelines.md` §8.8–§8.10（令牌/布局/字阶）+ `apps/web/src/styles/tokens.css` |
| `docs/ui-redesign/ui-ia-review.md` | `docs/archive/ui-redesign/ui-ia-review.md` | 2026-11-05 | 2026-11-02 IA 审查与方案；术语表已迁入 ui-guidelines §8.6，页面范式已由 §1–§7 覆盖，旧"抽屉内确认"表述已废止 | `docs/ui-redesign/ui-guidelines.md` §1–§8、`docs/ui-redesign/page-specs.md` |
| `docs/ui-redesign/audit-icons.md` | `docs/archive/ui-redesign/audit-icons.md` | 2026-11-05 | 一次性线上 UI 图标走查；缺陷已闭环，规则已沉淀为 §8.7 | `docs/ui-redesign/ui-guidelines.md` §8.7、§8.11 |
| `docs/ui-redesign/audit-2026-11-02/`（30+ 截图） | `docs/archive/ui-redesign/audit-2026-11-02/` | 2026-11-05 | 一次性走查截图证据，随 audit-icons.md 归档 | 无（历史证据） |
| `docs/ui-redesign/audit-2026-11-03/`（clicks-audit.md + 49 截图） | `docs/archive/ui-redesign/audit-2026-11-03/` | 2026-11-05 | 一次性线上点击流走查证据；阻断/P0/P1 已修复上线，结论已入现行规范 | `docs/ui-redesign/ui-guidelines.md`、`docs/ui-redesign/page-specs.md` |

## 归档区内的审计/走查记录（一次性产物，随产生随存）

| 路径 | 内容 | 日期 |
|---|---|---|
| `docs/archive/audit-2026-11-02/`（根文件） | 全仓文档×代码一致性审计、UI 文档审计、归档方案（`docs-code-audit.md`、`ui-docs-audit.md`、`archive-plan.md`）；UI 走查截图与问题清单见 `docs/archive/ui-redesign/audit-2026-11-02/`，图标走查报告 `docs/archive/ui-redesign/audit-icons.md` | 2026-11-02（UI 走查产物 2026-11-05 归档） |
| `docs/archive/audit-2026-11-02/architecture-review/2026-11-02/review.md` | 架构专项深度审查（Hub 稳健性 / peer 密钥轮换 / 双通道），头部附 2026-11-03 修复状态表（R1/R2/R3/T1/H3 已修；token 轮换拍板为手动 SOP；MASTER_ENC_KEY 备份沉淀至 `docs/backup.md` §7–§8） | 2026-11-02（归档 11-03） |
| `docs/archive/audit-2026-11-02/feature-gap/2026-11-02/gap-analysis.md` | 用户流程 × 功能缺口对照 + CF DNS 方案建议，头部附 2026-11-03 修复状态表（B1–B4/E1–E3/E5/L4 已修；E4/L1–L3/L5 未做） | 2026-11-02（归档 11-03） |
| `docs/archive/audit-2026-11-02/flow-walkthrough/2026-11-02/`（walkthrough.md + 32 张截图） | 生产环境真实流程走查记录；卡点 #1/#2/#4/#5/#6 已修（见其头部修复状态） | 2026-11-02（归档 11-03） |
| `docs/archive/audit-2026-11-02/test-coverage/2026-11-02/coverage-review.md` | 测试覆盖评估；第一优先级空白已由批次 F 补齐（`6eac34f`） | 2026-11-02（归档 11-03） |
| `docs/archive/audit-2026-11-02/server-test/2026-11-02/`（report / test-plan / setup-notes） | 服务端端到端测试证据（P0/P1 修复实测复验）；操作知识已沉淀进 `docs/runbook/*` | 2026-11-02（归档 11-03） |

## 归档规则（摘要）

- 判定标准与流程见 `docs/README.md` §3（文档门禁）与 AGENTS.md 红线 9。
- ADR（`docs/engineering/adr/`）永不归档，废弃只改状态字段。
- 图片等资产随所属文档一起归档，不留孤儿。
