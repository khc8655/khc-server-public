# PR 决策抢救清单（2026-11-11）

> 状态：现行（一次性整理记录） ｜ 适用范围：旧私有库全部 116 个 PR（111 merged / 3 closed / 2 open）、main 直接提交信息、9 个含评论/评审的 PR；以及未入库的两份 2026-11-08 报告与未合并 PR #128 中的测试工作单 ｜ 最后核验：2026-11-11 ｜ 关联：`docs/verification/2026-11-11/public-repo-readiness-audit.md`、`docs/engineering/adr/`、`docs/verification/2026-11-08/e2e-acceptance-report.md`、`docs/verification/2026-11-08/ux-interaction-audit.md`、`docs/verification/2026-11-10/preprod-test-report.md`

**目的**：旧仓库保持私有、新仓库不带历史。本清单确认哪些设计决策/取舍/踩坑只存在于 PR 讨论或 commit message，并把它们落进 `docs/`，避免随历史一起丢失。**只整理已发生的事实，不新增未批准的决策。**

---

## 1. 方法与判定

1. `gh pr list --state all` 枚举 116 个 PR：111 MERGED、3 CLOSED（#4/#5/#59）、2 OPEN（#128/#129）。
2. 读取全部 PR body（约 198 KB），按「决策/拍板/取舍/不做/放弃/改为/原因/理由/因此/否则/踩坑/教训/结论/方案/红线/冻结」抽取候选句。
3. 读取 9 个有评论或评审的 PR（#4/#5/#56/#57/#58/#59/#66/#67/#72），确认讨论中是否另有决策。
4. 扫描 main 上非 merge 的 commit message，筛出可能承载决策的提交。
5. 对每条候选，在 `docs/` 与 `docs/engineering/adr/` 中查证是否已覆盖；**已覆盖的不重复写**。

---

## 2. 结论

- **没有发现"只存在于 PR/commit、且尚未进入 docs"的架构级决策**。18 类主要决策均已被 ADR-0001…0013 或设计/规范/运维文档覆盖（见 §3）。
- 真正需要抢救的是**证据型内容**：
  1. 两份 2026-11-08 报告只存在于工作区、未入库，且被 `docs/verification/2026-11-10/preprod-test-report.md` 引用 → 已脱敏并入 `docs/verification/2026-11-08/`。
  2. 未合并 PR #128 的测试工作单中含 F1–F6 决策与 N1–N10 遗留项；其中 **N6（CI 自动回滚）、N8（D1 定时备份/Time Travel SOP）、N9（前端拆包）未在任何 docs 中出现** → 已补进 `docs/production-readiness.md` §2。
  3. N1 指出的 AGENTS.md 口径过时 → 已修正迁移数量与红线 5 的自动部署表述。
- 未新增 ADR：所有架构决策都已有 ADR 或等价设计文档；再写 ADR 属于重复，不符合「已有文档已覆盖的不要重复」。

---

## 3. 决策覆盖矩阵

| # | 决策 / 取舍 | 来源 | 已落地文档 |
|---|---|---|---|
| 1 | 单一生产环境；main 合并即部署，删除 staging 配置 | #61 / ADR-0008 | `docs/engineering/adr/ADR-0008*.md`、`docs/engineering/release.md` |
| 2 | 运维数据只实时获取、不落库（不存监控历史） | #56 / ADR-0009 | `docs/engineering/adr/ADR-0009*.md` |
| 3 | 快照轮询：页面可见 10s、隐藏即停；单 isolate best-effort | #56 / #66 / ADR-0010 | `docs/engineering/adr/ADR-0010-snapshot-polling.md` |
| 4 | 发布清单随部署生成、签名密钥缺失时回落 | #39 / ADR-0011 | `docs/engineering/adr/ADR-0011*.md`、`docs/agent-releases.md` |
| 5 | 三种接入方式并列、节点选定其一、失败即报错、无跨方案回退 | #87 / ADR-0012 | `docs/engineering/adr/ADR-0012*.md`、`docs/runbook/node-onboarding.md` |
| 6 | 发版分层（面板 / Agent / 协议兼容） | #88 / ADR-0013 | `docs/engineering/adr/ADR-0013*.md` |
| 7 | 主机运维边界、防锁死、nft 回滚与备份 | #6 / #8 / #19 / ADR-0007 | `docs/engineering/adr/ADR-0007*.md`、`docs/host-ops.md` |
| 8 | 保存即生效 + 显式应用（写闸门拆分） | #56 | `docs/plan-gate-split.md`、`docs/plan-v4.md` §5.1 |
| 9 | D-1 面板 TOTP 暂缓、D-4 不做响应 HMAC、D-6 删除 staging 配置 | #60 | `docs/plans/arch-review-remediation-2026-11-03.md`、ADR-0008 |
| 10 | Caddy 接管规则、影子预览、全局域名/隧道、ACME、sourcePeer/sourcePort | #112 / #113 / #118 / #121 / #136 | `docs/caddy-management.md` |
| 11 | 安装令牌经 stdin 不回显、证书前置校验 | #35 / #37 / #103 | `docs/agent-lifecycle.md`、`docs/runbook/node-onboarding.md` §4.1 |
| 12 | 打开即探测、三态、无周期轮询、最多 3 次、首屏 3 请求预算 | #62 / #65 / #75 / #92–#98 / #120 | `docs/ui-redesign/page-specs.md`（状态带与探测节奏） |
| 13 | 六类页面范式、全页唯一抽屉、SaveBar、ConfirmAction | #57 / #58 / #68–#71 / #110 | `docs/ui-redesign/ui-guidelines.md`、`docs/ui-redesign/page-specs.md` |
| 14 | TLS 过载只断连，不做分层准入 | #130 | `docs/security-boundaries.md` §4.1 |
| 15 | P5 三项「不做」：D1 状态对齐、直连观测改协议、P2 隧道完整实现 | #85 / #86 | `docs/TODO-2026-11-06.md` §2 P5、`docs/verification/2026-11-07/p0-closeout.md` §4 |
| 16 | 版本协商 426 `panel_too_old` + 兼容矩阵 | #90 / #91 | `docs/engineering/release.md` §1.1 |
| 17 | 发布签名密钥轮换、封存与销毁 | #137 / #138 / #139 | `docs/engineering/release.md` §7.4 |
| 18 | 存量手工安装应用可见/接管、`summary_json` 编排层 | #132 / #133 | `AGENTS.md` 编排层例外、`docs/caddy-management.md` |

---

## 4. 本次实际改动

| 动作 | 文件 |
|---|---|
| 新增（脱敏并入） | `docs/verification/2026-11-08/e2e-acceptance-report.md` |
| 新增（脱敏并入） | `docs/verification/2026-11-08/ux-interaction-audit.md` |
| 新增（本清单） | `docs/verification/2026-11-11/pr-decision-salvage.md` |
| 更新引用与补充说明 | `docs/verification/2026-11-10/preprod-test-report.md`（F-05/F-09 与两处路径） |
| 补 N6/N8/N9 遗留项 | `docs/production-readiness.md` §2 |
| 修正过时口径 | `AGENTS.md`（迁移数 0012；红线 5 与 ADR-0008 对齐） |
| 索引登记 | `docs/README.md` |

---

## 5. 判定为无价值 / 不复刻的内容

| 内容 | 来源 | 判定依据 |
|---|---|---|
| 一次性执行编排：机器占用规则、派发提示词、8 条 track 的逐条步骤、逐用例预期 | PR #128 | 属于当时的执行细节，且含真实机器信息；其结论已进入 `preprod-test-report.md`，长期无复用价值 |
| 关闭 PR #4「C3 初始化」 | #4 | 关闭原因注记为"已包含在 main"，无独有决策 |
| 关闭 PR #5「live WS」 | #5 | 方案已被 ADR-0009/0010 的 SSE + 快照轮询取代；正文无仍有效结论 |
| 关闭 PR #59「banner 语气/布局」 | #59 | 被 #58 UI 重构取代；无独有决策 |
| 打开 PR #129「untrack .workbuddy」 | #129 | 本次阶段 3 直接执行，无需文档 |
| 纯实现型 PR body（#6/#8/#19/#26 等） | 多个 | 内容已被 ADR/runbook 覆盖，复刻只会产生第二份真相 |
| 已验证后已关闭的 P5 三项 | #85/#86 | 结论已在 TODO-2026-11-06 §2 P5，重复无收益 |

---

## 6. 未决口径（只记录，不擅自改）

- `AGENTS.md` 红线 8「单仓库只在 `khc8655/khc-server`」需在新 public 仓库确定后更新（阶段 5 处理）。
- 生产 2FA（TOTP）、D1 定时备份/Time Travel SOP、CI 自动回滚仍是待主人拍板的余项，见 `docs/production-readiness.md` §2。
- 旧私有库的 tag/版本号与新 public 仓库的版本起点是否需要对齐，留待阶段 5 与主人确认。
