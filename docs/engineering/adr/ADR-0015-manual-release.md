# ADR-0015: 发版改为人工触发（公开仓库不持有发布私钥与生产 token）

- 归类：决策记录
- 状态：**已被取代**（2026-11-11 同日由 ADR-0016 取代：「合并 main 即上线」，CI 内签包；B2「PR 不设文档路径豁免」结论继续有效）
- 适用范围：`.github/workflows/ci.yml`（`pull_request` 触发、deploy job）、`scripts/deploy-local.sh`、`docs/engineering/release.md`、`AGENTS.md` §3/§5/§7；**不改** Worker 运行时、D1 schema、Agent 内核
- 最后核验：2026-11-11（被取代，仅作历史记录；现行流程见 ADR-0016 与 `docs/engineering/release.md` §3）
- 关联：ADR-0008（生产复用 staging）、ADR-0011（清单随部署发布）、ADR-0013（发版分层）、**ADR-0016（取代本 ADR）**、`docs/engineering/release.md`、`docs/archive/2026-11/auto-deploy.md`

> **取代说明**：本 ADR 的「deploy 仅 `workflow_dispatch`」与「发版只走本机」两条已被 ADR-0016 推翻；「PR 不设文档路径豁免（B2）」「deploy-local.sh 读 wrangler.local.toml」保留。以下内容为决策历史，不再作为开发依据。

## 背景

2026-11-11 项目迁入公开仓库 `khc8655/khc-server-public`（旧私有库 `khc-server` 已归档），迁移带来三个硬约束：

1. **公开库不携带发布产物**：`apps/web/public/agent/` 下的 `khc-agent-*.tar.gz`、`.sha256`、`release-manifest.json` 由发布私钥签名，按主人决定**不进公开库**，改由本机发版时生成并注入（见 `docs/engineering/release.md` §7.1）。
2. **CI 无法在缺产物的情况下部署**：`pnpm build` 会把 `apps/web/public/agent/` 打进 Worker assets；deploy job 末尾的 `Verify deployed agent package` 还要求仓库内存在 `khc-agent-<VERSION>.tar.gz.sha256`。只配 token 而不解决产物来源，部署必然失败（或上线一个没有可用 Agent 包的站点）。
3. **公开仓库不应长期持有生产凭据**：CI 部署需要 `CLOUDFLARE_API_TOKEN`（Workers Scripts:Edit 级别）。把它常驻公开仓库 secrets，等于把生产写权限挂在一个人人可 fork 的仓库上；若再把发布私钥也放进 secrets（为了让 CI 现场签名），风险更高。

ADR-0008 原本规定「main 合并即生产部署」，在私有库 + 全产物入库的前提下成立；上述约束使其不再成立。

实测证据（2026-11-11）：迁移后首次 main 合并（PR #2，run `42969510547`）`agent` ✅、`verify` ✅、`deploy` ❌——失败原因即仓库未配置 `CLOUDFLARE_API_TOKEN`。也就是说，维持旧模型时 main 会长期红。

另有一个独立缺陷：`ci.yml` 的 `pull_request` 带 `paths-ignore: docs/**, **/*.md`，纯文档 PR 不触发 workflow；而 main 分支保护要求 `Agent tests (Python)` 与 `Typecheck / Test / Build` 两个检查，导致文档 PR 永远停在 `BLOCKED`，只能管理员绕过。

## 选项

### 部署触发方式

| 选项 | 做法 | 利 | 弊 |
|---|---|---|---|
| A 保持 CI 部署 | 新建最小权限 CF token（Workers Scripts:Edit + Account Settings:Read）+ Account ID 写入公开库 secrets；产物由本机签发后上传 R2，CI 用只读凭据拉取再 build | 保持「合并即上线」；发布记录集中 | 公开库常驻生产写权限；需新增 R2 桶、只读凭据与 workflow 下载步骤；产物与代码版本存在错配窗口 |
| A1 变体（CI 内签名） | 发布私钥写入 GitHub secrets，CI 现场出包签名 | 流程最短 | **不可接受**：私钥进入第三方云端，公开仓库场景下泄露面最大 |
| **B 人工发版（选定）** | deploy job 改为仅 `workflow_dispatch`；发版由主人本机跑 `./scripts/deploy-local.sh`，构建前注入签名产物 | 公开库零生产凭据、零私钥；发布动作与「谁批准」天然绑定 | 合并不会自动上线，需要记得手动发版；发布责任集中在主人本机 |

### 文档 PR 的检查策略

| 选项 | 做法 | 利 | 弊 |
|---|---|---|---|
| B1 管理员绕过 | 保留 `paths-ignore`，文档 PR 用 admin merge | 不跑无意义 CI | 每次都要绕过分支保护，审计上等于「保护可被随手关闭」 |
| **B2 PR 不设路径豁免（选定）** | `pull_request` 去掉 `paths-ignore`，所有 PR 都跑 `agent` + `verify`；`push` 的文档过滤保留 | 保护规则一致、可审计；文档 PR 也验证脚本/文档引用 | 文档 PR 多花约 2 分钟 CI（public 仓不计费） |

## 决策

1. **部署改为人工触发**：`ci.yml` 的 deploy job 条件改为 `github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'`，不再由 `push main` 触发；job 本体保留为可选路径（例如临时无本机环境时手动 dispatch），并在第一步做凭据预检——缺 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 时打印中文提示并 `exit 1`，**不静默跳过**。
2. **发版走本机**：`scripts/deploy-local.sh` 优先读 `wrangler.local.toml`（已 gitignore，含真实 Worker 名、D1、`LIVE_ORIGINS`），缺失时回落 `wrangler.toml` 并告警；部署命令改为 `wrangler deploy --config <config> --tag <sha12> --message ...`，不再用 `--name` 单独覆盖。脚本在 build 之前预检三类发布产物（tgz / `.sha256` / `release-manifest.json`），缺失即失败并提示签名命令。
3. **PR 不设文档豁免**（B2），保证纯文档 PR 也能拿到两个必需检查。
4. **公开库不配置** `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`；已有的 5 个 `KHC_*` secrets 仅服务于「手动 dispatch deploy job」这条可选路径，保留与否由主人决定。

## 影响 / 迁移 / 回滚

### 对 ADR-0008 的影响（部分取代）

- ADR-0008 中「生产与 staging 复用同一 Worker/D1」「配置唯一来源 `wrangler.toml`」仍然有效。
- 其中「**main 合并即生产部署**」一条自本 ADR 起失效：main 合并 = 过 CI；生产部署 = 主人本机执行 `./scripts/deploy-local.sh`（或手动 dispatch deploy job）。
- 发布锚点（ADR-0013 L1）改为**人工打标签**：发版成功后由主人 `git tag -a release-<khcRelease> -m ...` 并 push；CI 手动部署路径仍会自动打标签。

### 迁移步骤（已完成 / 待主人执行）

- 已完成（代码与文档）：`ci.yml` 触发与 deploy job 条件、凭据预检；`deploy-local.sh` 配置与产物预检；本 ADR、`release.md`、`AGENTS.md` 同步。
- 待主人执行（不在本 ADR 的代码范围内）：
  1. 本机创建 `wrangler.local.toml`（可从 `wrangler.toml` 复制后改 `name` / `database_name` / `database_id` / `LIVE_ORIGINS`），确认已 gitignore；
  2. 发版前用发布私钥生成 Agent 包与签名清单（`SIGN_KEY_FILE=... PUBLIC_BASE=... ./scripts/build-agent-release.sh`）；
  3. 发版时 export `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 并执行 `./scripts/deploy-local.sh`。

### 回退方式

- **代码层**：revert 本 ADR 对应的提交并合并，deploy job 条件恢复为 `push` + `workflow_dispatch`；若同时重新配置 CF 凭据即可回到 ADR-0008 的旧行为。
- **发布层**：`npx wrangler rollback`（回到上一 Worker 版本）或按 `release-*` 标签重新部署；Agent 侧保留 `.prev` 目录。
- **凭据层**：本方案未新增任何凭据，回退无需轮换。

## 验证

- `./scripts/verify.sh` 全绿（本机）。
- 公开库 PR 验证：纯文档 PR（`docs/dead-links`）在 B2 生效后触发 `Agent tests (Python)` 与 `Typecheck / Test / Build` 并通过，`mergeStateStatus = CLEAN`，无需 admin 绕过。
- main 验证：本改动合并后，main 的 CI 只跑 `agent` + `verify`，结论为 success（deploy 不再自动运行）。
- `deploy-local.sh` 语义检查：只做配置选择、产物预检、verify、build、deploy；不自动部署、不写任何凭据到文件。
