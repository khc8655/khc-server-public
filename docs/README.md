# 文档地图（Documentation Index）

> 状态：现行 ｜ 适用范围：全仓文档的权威索引与归档入口 ｜ 最后核验：2026-11-12（登记 UI 重组方案与 ADR-0014/0017/0018 的最终状态） ｜ 关联：AGENTS.md §3 红线 9「文档门禁」
>
> 规则：每类信息只有一个权威来源；改信息先改权威来源，再同步引用方。
> **UI 唯一权威**：页面类型/路由/区块 → `docs/ui-redesign/page-specs.md`；设计取值 → `apps/web/src/styles/tokens.css`；其余全部 UI 规则 → `docs/ui-redesign/ui-guidelines.md`。不得出现第二份"设计规范"或第二套色板/字阶。
> 判定"能不能作为开发依据"只看两点：**在下方现行表内 + 文档头部状态块为「现行」**。不满足即不得作为依据。
> 历史文档统一在 `docs/archive/`（见文末归档速览），archive 内文档不得作为开发依据。
> **公开版截图说明（2026-11-11）**：本公开仓库不包含任何 UI 截图——历史截图均取自真实生产面板，页面头部会带出真实节点名与访问地址，无法逐张可靠脱敏；截图仅保留在私有归档仓库。文档中出现的 `*.png` 文件名是原截图清单，不再对应仓库内文件。

## 1. 现行权威文档

### 工作协议与入口

| 主题 | 权威文档 | 说明 |
|---|---|---|
| 项目定位 / 快速开始 | `README.md` | 对外第一入口 |
| Agent 工作协议 / 红线 / 流程 | `AGENTS.md` | **接手必读** |
| 变更记录 | `CHANGELOG.md` | Keep a Changelog 格式 |
| 贡献指南 | `CONTRIBUTING.md` | PR / commit 规范 |

### 架构与规划

| 主题 | 权威文档 | 说明 |
|---|---|---|
| 架构与冻结契约 | `docs/design-v3.md` | 核心/适配器/连接/数据模型 |
| 当前阶段与决策 | `docs/plan-v4.md` | 路线与已拍板决策 |
| 写闸门拆分设计 | `docs/plan-gate-split.md` | 已随 #56 落地（保存永远允许 + SSE） |
| 旧系统功能对照 | `docs/legacy-feature-inventory.md` | 防止漏功能 |
| 服务端文档补齐计划（提案） | `docs/plans/server-docs-plan.md` | 盘点与提纲；runbook 部分已落地 |
| 架构审查与整改计划（执行中，2026-11-03） | `docs/plans/arch-review-remediation-2026-11-03.md` | 架构评审结论（P0/P1/P2/P3）+ 批次任务；D-1…D-6 已全部拍板（§5.1），批次 1/2/3 已落地，未开工遗留项见 §9 待办表 |
| 2026-11-06 待办与多 Agent 交接 | `docs/TODO-2026-11-06.md` | §1 已完成、§2 过时项已清理、P1 加密暂缓；§3 挂账 8 项中 7 项已落地，**3.7（关闭 workers_dev）已回滚**——生产入口源站就是 workers.dev，关闭即整站 404，详见上线事故记录 |
| 上生产前缺陷分型与修复方案（提案，2026-11-10） | `docs/plans/preprod-fix-plan-2026-11-10.md` | 把测试报告 S2/S3 的 13 项归并为 R1–R7 七组根因（动作参数契约 R1、校验单一权威 R2、诊断修复闭环 R3、传输准入 R4、阈值文档 R5、备份脱敏/主密钥 R6/R7），逐项给 A/B 两案与推荐；PP-E-03 按"设计保护/缺陷"两种情形分别给结论；含 6 批顺序、验证方式、bump 与 6 项待拍板 |
| 面板 UI 重组方案（已拍板，2026-11-12） | `docs/plans/ui-ia-redesign-2026-11-12.md` | 6 批串行：视觉收敛、规范对齐（ADR-0014 打开即探测，1+3 次预算）、按需安装中性显示、站点表「后端」列、`/hubs/:id/services`「对外服务」页（网页服务 + 远程访问，复用既有抽屉，零新增请求）、概况/内网穿透/添加节点流程。明确不做：任务快照（ADR-0018 废弃）、SSE、托管安装、Agent/契约/迁移改动。不含截图，页面结构用文字线框 |

### UI 规范（ui-redesign，2026-11-02 起唯一来源）

> UI 权威只有三份：范式 → `ui-guidelines.md`；路由与区块 → `page-specs.md`；取值 → `tokens.css`。

| 主题 | 权威文档 | 说明 |
|---|---|---|
| 页面类型与交互范式 | `docs/ui-redesign/ui-guidelines.md` | 六类页面范式、布局/字阶/组件/四态/交互/响应式/动效/文案（含术语统一表 §8.6）、PR 自检清单 |
| 路由与区块映射 | `docs/ui-redesign/page-specs.md` | 路由总表与"现状→调整后"映射，新增页面必须同步登记 |
| 设计令牌（取值） | `apps/web/src/styles/tokens.css` | **令牌唯一权威在代码**；修改令牌 = 改该文件，不新建文档 |

**非权威参考**（仅用于走查/备案；冲突时以上三份为准）：`docs/ui-redesign/changelog.md`（落地备案，历史记录）、`docs/ui-redesign/examples/2026-11-05/demo.html`（静态样例，见 ui-guidelines §11）、`docs/ui-redesign/visual-walkthrough-2026-11-07.md`（PR2–PR5 截图与四态走查记录）、`docs/ui-redesign/audit-2026-11-08.md`（规范与实现一致性审计记录，问题清单与修订建议，需主人拍板后才转成规范）。

### 功能机制（各自领域权威）

| 主题 | 权威文档 |
|---|---|
| 诊断（7 核心码 + API） | `docs/diagnostics.md` |
| 双模式（wg/caddy/unknown） | `docs/dual-mode.md` |
| 观测层（10s 快照轮询；SSE 已停用） | `docs/live-observation.md` |
| 数据分层（D1 只存配置，运行快照不落库） | `docs/data-layering.md` |
| 主机运维（host-ops） | `docs/host-ops.md`、`docs/host-ops-async.md`、`docs/host-ops-e2e.md` |
| 端口转发 | `docs/port-forward.md` |
| Caddy 站点管理 | `docs/caddy-management.md` |
| Cloudflare DNS 集成 | `docs/cf-dns.md` |
| 备份与恢复（含控制面灾备与密钥轮换 SOP） | `docs/backup.md` |
| Agent 生命周期（安装/升级/看门狗） | `docs/agent-lifecycle.md` |
| Agent 发布包与签名 | `docs/agent-releases.md` |
| Agent 安装预检与用户模式 | `docs/install.md` |

### 工程流程

| 主题 | 权威文档 | 说明 |
|---|---|---|
| 测试与验收 | `docs/engineering/testing.md` | 测试分层、平台功能矩阵、分模块用例、发版类型必测矩阵、缺口计划与验收清单（2026-11-08 扩充） |
| 快照轮询稳定性结论（2026-11-04） | `docs/verification/2026-11-04/snapshot-stability.md` | 验证分支 30min 可见 + 30min 隐藏 + 重启恢复实测；未合并、未部署 |
| UI CSS 令牌收敛盘点（2026-11-05） | `docs/verification/2026-11-05/ui-css-token-audit.md` | 第一批 47 条无损 + 第二批 7 令牌/99 等值/13 就近归一（PR #69 `d919921`）+ 第三步 9 令牌/28 条尺寸等值（PR #70 `47beb2f`），均已合并部署；设计属性 px 239→59（`global.css` 归零），剩余 59 条为有意保留（原因见 §9.3） |
| 服务端能力复验记录（2026-11-03） | `docs/verification/2026-11-03/report.md` | feat/server-capabilities 批次 I–Q 复验证据：F-1/F-2/F-3 与 F-L1/L2/L3 闭环、两次上线部署复验；F-M1（/state 瞬时报"格式不合法"）已于批次 N 根治上线并复验（回退重签 + 超时放宽 + 401/403 归鉴权类），peer 一键脚本实机验证，见 §12；批次 O peer 卸载脚本 + Agent 0.1.10 见 §13；批次 P 走查缺陷修复（B-1/P0-1/P1）见 §14；批次 Q 删除清理默认值修复 + 最终一致性核对见 §15 |
| P0 收口核验与 P5 三项评估（2026-11-07） | `docs/verification/2026-11-07/p0-closeout.md` | apply 幂等（同 key 两次响应一致、`exec_counter` 不变）/失败自动回滚（`rolledBack:true`、文件恢复 ORIGINAL）、证书过期与主机名不匹配报错、断隧道 530 实测通过；Access 403 与 `caPool` / 默认校验未测（缺 CF 账号 / 具名隧道 / Service Token 凭据）；P5 三项「不做」结论、加密批次暂缓 |
| 上线事故：`workers_dev=false` 整站 404（2026-11-07） | `docs/verification/2026-11-07/incident-workers-dev-as-origin.md` | 生产入口 `panel.example.com` 实为第三方边缘、回源 Host 就是 workers.dev（`/cdn-cgi/trace` 的 `h=` 实测），关闭 `workers_dev` 导致全站 404/1042；已回滚为 `true` 并新增「部署前拓扑闸门 + 部署后生产入口校验」两道门禁 |
| 上生产前完整测试报告（2026-11-10） | `docs/verification/2026-11-10/preprod-test-report.md` | 面板 0.7.12（`acd9b41c`）/ Agent 0.1.35 的 A–H 八轨 126 条用例：75 通过、12 部分通过、9 失败、8 阻塞、1 跳过、21 未执行；结论 No-Go（S2：PP-F-08 cron 白名单、PP-C-05 Caddyfile 接管）；生产请求 40 次（只读 29、写入 11，逐类明细见报告 §6.2） |
| Public 仓库开放前隐私与凭据审计（2026-11-11） | `docs/verification/2026-11-11/public-repo-readiness-audit.md` | 全历史 423 提交/96 分支引用/45 tag 只读扫描：1 项已泄露 WireGuard Peer 私钥（截图）须轮换、2 个一次性安装令牌须确认失效、20+ 文件含真实 IP/域名/资源标识；结论"处理后安全"，推荐新建干净 public 仓库而非直接公开历史 |
| PR 决策抢救清单（2026-11-11） | `docs/verification/2026-11-11/pr-decision-salvage.md` | 116 个 PR + commit message 全量盘点：18 类架构决策已全部落在 ADR/设计文档，无需新增 ADR；抢救两份 2026-11-08 报告与 PR #128 的 N6/N8/N9 遗留项，并列出判定为无价值/不复刻的讨论及依据 |
| 端到端验收报告（2026-11-08） | `docs/verification/2026-11-08/e2e-acceptance-report.md` | 三种接入方式/Caddy/WireGuard/端口转发端到端验收；真实地址已脱敏，结论与证据保持原样 |
| 面板交互测试与优化报告（2026-11-08） | `docs/verification/2026-11-08/ux-interaction-audit.md` | 状态一致性、门控、文案、展示与操作成本审计；真实地址已脱敏，结论与证据保持原样 |
| 发版与部署 | `docs/engineering/release.md` | 版本、分层、CI 自动发版（合并 main 即上线，CI 内签包）、本机应急发版、部署前冒烟、回滚（ADR-0016；ADR-0015 已被取代） |
| D1 迁移 runbook | `docs/engineering/d1-migrations.md` | 0001–0012 顺序、命令与核对点 |
| 版本策略 | `docs/release-versioning.md` | 面板 + Agent 统一发版规范：三层模型（发布单元/产物版本/构建标识）、semver 语义、两条硬规则（面板 `package.json` bump / Agent `VERSION` bump）、包留存、验收命令（ADR-0013） |
| 生产就绪状态 | `docs/production-readiness.md` | 已上线后的余项跟踪 |
| 架构决策记录 | `docs/engineering/adr/` | ADR 永不归档，只改状态字段；ADR-0010（2026-11-04）拍板可见时 10s 快照轮询并部分取代 ADR-0009；ADR-0011（2026-11-05）拍板发布清单随部署发布、secret 仅兜底；ADR-0012（2026-11-07）拍板三种并列接入方案（A 可信证书直连 / B Cloudflare Tunnel / C 自签）与 client 单例；ADR-0013（2026-11-07）拍板发版分层（发布单元 / 产物版本 / 构建标识）与面板版本单一来源；ADR-0015（2026-11-11）已由 ADR-0016 取代；ADR-0016（2026-11-11）拍板恢复「合并 main 即上线」，CI 内签包、secrets 渲染临时配置，并明确 Cloudflare Workers Builds 必须保持断开；ADR-0014 / 0017 / 0018（2026-11-12）：ADR-0014 已接受，打开页面即探测节点并写明 1+3 次预算；ADR-0017 已接受，站点表「后端」列 + `/services`「对外服务」页（纯前端推导，不新增数据模型）；ADR-0018 已废弃，任务快照方案不做，维持 10 分钟 / 60 次轮询 |

### 运维 Runbook 与安全边界

| 主题 | 权威文档 | 说明 |
|---|---|---|
| 节点接入 Runbook | `docs/runbook/node-onboarding.md` | 干净机器从建节点到上线的端到端步骤 |
| 故障排查手册 | `docs/runbook/troubleshooting.md` | 按症状组织（离线/防火墙/证书/peer/HMAC/超时/Agent 升级纪律） |
| 控制面全丢重建（Worker / D1 / 主密钥） | `docs/runbook/disaster-recovery.md` | 分层判定损失、各类丢失的实际后果、D1 导出回放、主密钥丢失后的逐节点重建与验证清单 |
| 安全与边界说明 | `docs/security-boundaries.md` | 沙箱/写盘白名单/HMAC/签名清单/防火墙安全网 |

### 代码内 README

| 主题 | 权威文档 |
|---|---|
| Agent 内核与适配器 | `agent/README.md` |
| host-ops 适配器 | `agent/adapters/host_ops/README.md` |

## 2. 归档

已归档文档（旧版设计、验收记录、UI v2.2 规范、UI 变更单 001–016、研究资料等）统一登记在 **`docs/archive/README.md`**（原路径 | 归档路径 | 日期 | 原因 | 取代者）。本索引只保留入口，不重复列出归档明细；`docs/archive/` 内文档不得作为开发依据。

## 3. 文档维护规则（文档门禁）

- **新增文档**：必须先归类（现行规范 / 工程流程 / 决策记录 / 提案 / 历史资料），头部带状态块（状态 / 适用范围 / 最后核验 / 关联），并在同一 PR 登记本索引；缺任一不予合入。
- **文档被取代或成为一次性产物**：不删除——`git mv` 入 `docs/archive/`，状态块改为"已取代/历史记录"并写明取代者，同步更新本索引与 `docs/archive/README.md`。
- **`docs/archive/` 内文档不得作为开发依据**；需复活先迁出、恢复"现行"状态块并登记索引（PR + 主人批准）。
- **未列入本索引现行表的文档一律视为非权威。**
- 行为/接口/配置/流程变化：同 PR 更新权威文档 + `CHANGELOG.md`。
- 新增重大决策：在 `docs/engineering/adr/` 建 `ADR-000N-*.md`（模板见该目录 README）。
- "最后核验"在行为变更 PR 中顺手刷新；超过 6 个月未核验的现行文档在索引中标 `⚠ 待复核`，不自动归档。
