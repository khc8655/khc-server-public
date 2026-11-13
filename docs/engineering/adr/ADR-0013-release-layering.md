# ADR-0013: 发版分层（发布单元 / 产物版本 / 构建标识）与版本号单一来源

- 归类：决策记录
- 状态：已接受（主人 2026-11-07 拍板选 C 档「完整发版分层」）
- 适用范围：`package.json`、`apps/web/src/version.ts`、`apps/api/src/version.ts`、`packages/contracts`（health/version 响应）、`wrangler.toml`、`.github/workflows/ci.yml`、`scripts/check-release-consistency.mjs`、`scripts/prune-agent-packages.mjs`；**不改** Agent 运行时（`VERSION` 保持 0.1.20）
- 最后核验：2026-11-07
- 关联：`docs/archive/2026-11/release-versioning.md`、`docs/engineering/release.md`、`docs/agent-releases.md`、`scripts/verify-agent-release.mjs`、ADR-0008（生产复用 staging）、ADR-0011（清单随部署发布）

## 背景

**症状**：面板与 Agent 两个产物的版本号行为完全相反，且都不满足"可追溯"。

- **Agent 侧**：`scripts/verify-agent-release.mjs` 规则 1/2 强卡——改了 `agent/` 运行时代码就必须 bump `VERSION`，bump 了就必须出包入库。执行到位，但**粒度是提交级**：2026-10-25 至 11-07 的 13 天里出了 19 个版本（0.1.0→0.1.20），其中 11-06 发 0.1.19、11-07 又发 0.1.20。每次 bump 都与"是否一次已验收的发布"无关，只与"这次提交有没有碰 agent 代码"有关。
- **面板侧**：`apps/web/src/version.ts` 的 `PANEL_VERSION` 与 `apps/api/src/app.ts` 的 `APP_VERSION` **两处硬编码**，`docs/archive/2026-11/release-versioning.md` 写了 5 步发版检查，但 `ci.yml` 与 `verify.sh` 里**没有任何一行校验**（grep `PANEL_VERSION|APP_VERSION|CHANGELOG` 零命中）。实际结果是：`version.ts` 自 2026-10-31 创建（`9181420`）后**再未修改**，之后 8 天的功能改动（C3/C4、UI v2.2、TOTP、接入方案化改造）全部压在 `v0.2.0 · 2026-10-31` 下。

**后果**：线上出问题时无法回答"这是哪个提交"。仓库 `git tag` 数量为 **0**，CHANGELOG 只有 `[Unreleased]` 与 `[0.1.0]` 两段（0.1.1–0.1.20 全堆在 Unreleased），线上唯一标识是 Cloudflare Worker Version ID（如 `<worker-version-id>…`），与提交没有映射关系。回滚只能靠猜。

**根因判定**：不是"谁随意改版本号"，而是规则**只覆盖一半产物**，且**版本号绑定在提交而不是发布**——缺少"发布单元"这一层。

## 决策：三层模型

| 层 | 语义 | 载体 | 现状 |
|---|---|---|---|
| **L1 发布单元** | 一次已验收的发布 = 一个标签 + 一段发布说明 + 一次生产部署 | `release-<khcRelease>` git 标签（注解含面板版本/Agent 版本/Worker Version ID/提交）；CHANGELOG 的 `## [x.y.z] - 日期` 段 | 本 ADR 新增（此前 0 tag） |
| **L2 产物版本** | 每个可独立升级的产物各自 semver | 面板 = `package.json` 的 `version`（**唯一来源**，web 与 api 都从它读）；Agent = `agent/khc/util.py` 的 `VERSION`（已有门禁） | 面板本 ADR 收敛为单一来源 |
| **L3 构建标识** | 线上进程自身的身份 | `wrangler deploy --tag <commit sha 前 12 位>` → Cloudflare 官方 `[version_metadata]` binding → `/api/v1/version` 的 `commit` / `builtAt` / `versionId` | 本 ADR 新增 |

### semver 语义（面板与 Agent 同口径）

| 变化 | 档位 | 例子 |
|---|---|---|
| 新增用户可见能力、新增接口/字段（向后兼容） | **minor** | 新增 TOTP、新增构建溯源字段 |
| 行为修复、内部改进、性能、文案/样式修正 | **patch** | 修复 415 误判、UI 令牌收敛 |
| 破坏契约：API 不兼容、Agent 协议不兼容、需同步升级两端 | **major** | 改 HMAC 签名头、改 Agent 状态结构 |

> 关键约束：**不再用 patch 位装新功能**。§3 批次把"recipe 引擎、SSE→10s 轮询、iptables 自动放行"塞进 0.1.x 的 patch 位，属历史违规；新改动按上表执行。

### 两条硬规则（与 Agent 侧对称）

| 产物 | 规则 | 执行点 |
|---|---|---|
| Agent | 改 `agent/` 运行时代码 ⇒ `VERSION` 必须变；变 ⇒ 包必须入库 | `verify-agent-release.mjs`（已有） |
| 面板 | 改 `apps/(api|web)/src` 非豁免文件 ⇒ `package.json` `version` 必须变；变 ⇒ CHANGELOG 必须有对应版本段 | `scripts/check-release-consistency.mjs`（本 ADR 新增） |

豁免范围（不算功能改动，不要求 bump）：`*.test.ts(x)`、`*.smoke.test.tsx`、`apps/web/src/i18n/`（纯文案）、`apps/web/public/`（Agent 包走自己的规则）、`*.md`、CI 配置、脚本。纯内部整理可用提交信息 `[skip-release]` 一次性豁免（**需在 PR 描述里说明理由**）。

## 选项与被否方案

| 选项 | 做法 | 利 | 弊 | 结论 |
|---|---|---|---|---|
| A 只补构建溯源 | 加 commit/versionId，版本号仍两处硬编码 | 改动最小 | 面板版本继续冻死，问题未解决 | 否 |
| B A + 面板 bump 门禁 | 对称 agent 侧规则 | 解决漂移 | 仍无发布单元，一天可能多个"版本"，回滚无锚点 | 否 |
| **C 三层模型（选定）** | L1 标签 + L2 单一来源 + L3 构建标识，配套门禁与包退役 | 线上可溯源、回滚有锚点、两产物规则对称 | 改动面覆盖 CI/契约/脚本/文档，需一次迁移 | **采纳** |
| D 引入 changesets / semantic-release 等工具 | 用现成版本管理工具 | 生态成熟 | 当前是 pnpm workspace + Workers + Python Agent 混合产物，工具需要大量适配；引入后规则分散在工具的隐式约定里，与本仓"显式脚本 + 可读门禁"风格冲突 | 否（保留为未来选项） |

### 为什么 L3 用 Cloudflare version metadata 而不是构建期生成文件

候选做法有三种：构建时生成 `build-info.generated.ts`（需在 typecheck 前跑生成、要处理 gitignore 与首次 clone 缺失）、`--define` 注入（wrangler dev / vitest / tsc 三处都要各自传值）、或官方 `[version_metadata]` binding。

选第三种：**运行时由 Cloudflare 提供，零生成文件、零构建注入**，`wrangler deploy --tag` 直接把提交 sha 写进版本元数据；本地 `wrangler dev` 与单测中 binding 缺失时字段为空，接口按 optional 处理，不会因溯源信息缺失而失败。

## 后果

**正面**

1. 线上 `/api/v1/version` 能回答"哪个提交、哪个 Worker 版本、什么时候构建"，与 `git tag` 注解、CHANGELOG 版本段三者对齐。
2. 面板版本漂移在 CI 被拦（PR 阶段，不是部署后）。
3. 发布有锚点：`git tag --list 'release-*'` 即发布史；回滚可精确到提交。
4. 面板与 Agent 规则对称，不再出现"一边天天涨、一边冻死"。
5. 产物留存受控：`apps/web/public/agent` 由 18 个包 / 3.3MB 收敛到 3 个包 / 652KB。

**负面 / 代价**

1. 面板改动必须 bump —— 包括小样式修补。豁免靠 `[skip-release]`，需要人工判断并在 PR 说明。
2. CI 增加两个步骤（约 3 秒），deploy job 需要 `contents: write` 以推送标签。
3. 同日多次生产部署会产生 `release-2026-11-07`、`-2`、`-3` 多个标签，发布史变密；这是真实情况的可视化，不是噪声。
4. 已退役的 15 个历史包不可再从仓库取；如需回归旧版本，从 `git show <tag>:apps/web/public/agent/...` 或 CI artifact 取。**已装在节点上的旧版本不受影响**（升级只向新版本走）。

## 未做 / 后续

- **面板↔Agent 兼容矩阵**目前只写在 `docs/engineering/release.md`（人工维护），未做机器校验。若将来 Agent 协议有破坏性变更，再考虑在包内加 `MIN_PANEL_VERSION` 并由 Agent 自检。
- **发布说明自动生成**（从 PR 标题归类到 Added/Changed/Fixed）未做，当前靠人工写 CHANGELOG 段——门禁只保证"段存在且版本号对得上"。
- CI 的 `version upload` 预发版本尚未打 tag，只在最终 `deploy` 打；若将来需要"预发版本也能溯源"，再加 `--tag`。
