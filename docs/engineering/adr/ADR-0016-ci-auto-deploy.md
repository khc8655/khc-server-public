# ADR-0016: 恢复 CI 自动部署（合并 main 即上线），签名私钥与 CF token 放 GitHub Secrets

- 归类：决策记录
- 状态：已接受（主人 2026-11-11 拍板 A：GitHub Actions 自动部署）
- 适用范围：`.github/workflows/ci.yml`、`scripts/build-agent-release.sh`、`docs/engineering/release.md`、`AGENTS.md`、GitHub repository secrets、Cloudflare Workers Builds 配置
- 最后核验：2026-11-11
- 关联：ADR-0015（被本 ADR 取代）、ADR-0008（生产复用 staging）、ADR-0011（清单随部署发布）、ADR-0013（发版分层）、`docs/engineering/release.md`

## 背景

ADR-0015（同日）把发版改成「本机 `deploy-local.sh` 人工执行」，理由是公开库不携带签名产物、也不应长期持有生产 token 与发布私钥。落地后暴露两个问题：

1. **每次发版都依赖主人的那台机器**：本机不在、网络受限或忘记执行，都表现为「代码已合并但线上没变」，而 main 的 CI 依旧全绿，很难发现。
2. **「main 绿」与「线上是什么」脱钩**：发布单元（tag）、构建标识（`--tag` 的 commit）只能靠人工纪律保证，ADR-0013 想要的可追溯性被削弱。

同时确认：Cloudflare 侧的 **Workers Builds（Git 集成）会自行部署生产**，且不带 `--tag`。2026-11-11 实测：同一 commit `87690828c1f9` 先被 Workers Builds 部署（`41350d26`），2 分 20 秒后又被 GitHub Actions 部署（`355ab9e3`）；旧库纯文档提交 `80a742e5` 只被 Git 集成部署，导致线上 `/api/v1/version` 的 `commit` 为空——这正是「线上与本地不一致」的根因。该集成已由主人在 dashboard 断开。

## 选项

| 选项 | 做法 | 利 | 弊 | 结论 |
|---|---|---|---|---|
| A. CI 自动部署 + CI 内签包 | `push main` 触发 deploy job：私钥从 secret 落 `mktemp` 0600 文件 → `build-agent-release.sh` → `pnpm build` → 预发冒烟 → `wrangler deploy --tag` | 合并即上线；发布单元/构建标识由流水线保证；不依赖本机 | 生产 token 与发布私钥常驻 GitHub Secrets | **采纳** |
| B. 维持本机人工发版 | 保持 ADR-0015 | 钥匙不离开本机 | 依赖人工；易出现「合并了但没上线」 | 否 |
| C. 用 Cloudflare Workers Builds（Git 集成）部署 | 让 CF 直接拉仓库构建 | 少配 secrets | 无法注入签名私钥与 D1/域名配置；不带 `--tag`；与 GitHub Actions 争抢生产（已实测） | 否 |

## 决策

1. **deploy job 恢复 `push main` 触发**，`workflow_dispatch`（仅 main）保留为补发手段；缺任一凭据时 fail-closed（打印缺项并 `exit 1`）。
2. **签名在 CI 内完成**：`AGENT_RELEASE_SIGN_KEY` 只落盘到 `mktemp` 生成的 0600 文件，步骤结束 `trap` 删除；脚本只接受 `SIGN_KEY_FILE` **路径**，不接收私钥内容、不打印 PEM。`PUBLIC_BASE` 由 `KHC_PANEL_ORIGIN` 派生（`<origin>/agent`）。
3. **部署配置由 secrets 现场渲染**：`cp wrangler.toml wrangler.ci.toml`（已 gitignore）→ 用 `KHC_WORKER_NAME` / `KHC_D1_NAME` / `KHC_D1_ID` / `KHC_PANEL_ORIGIN` / `KHC_WORKERS_DEV_ORIGIN` 覆盖 → 自检残留占位值 → 所有 wrangler 命令显式 `--config wrangler.ci.toml`。仓库内 `wrangler.toml` 永远只是占位模板。
4. **Cloudflare Git 集成必须保持断开**：Worker 不连接任何 GitHub 仓库；这是本 ADR 的硬前提（不是建议）。

## 风险论证：私钥与 token 放 GitHub Secrets 是否扩大攻击面

**关键论点：能触发部署的人，本来就已经拥有 main 写权限。**

- 部署只发生在 `push main`（或 main 上的手动 dispatch）。要走到这一步，必须能合并/推送 main；而能写 main 的人本来就可以直接改 Worker 代码、改 workflow、改 D1 迁移——发布私钥与部署 token 不给他任何**新增**的生产改写能力。
- PR 工作流（含 fork PR）**不注入 secrets**：`pull_request` 事件下 GitHub 不提供 repository secrets，恶意 PR 拿不到钥匙。
- 钥匙的作用域被压到最小：CF token 仅 `Workers Scripts:Edit` + `Account Settings:Read`；签名私钥只能签「某个版本的 Agent 包清单」，不能改 Worker 代码、不能读 D1。
- 剩余风险与缓解：① 仓库被完全接管 → 与「main 写权限被接管」同级，靠 2FA/分支保护/必需检查兜底；② secret 被日志回显 → workflow 全程禁止 `set -x`，私钥只写文件不 echo，GitHub 对 secret 自动打码；③ 离职/轮换 → 轮换 Ed25519 密钥对并更新 `AGENT_RELEASE_PUBKEY`（`docs/backup.md` 的轮换 SOP），CF token 直接在 dashboard 吊销重建。
- 与 ADR-0015 的取舍差异：ADR-0015 把「钥匙不离开本机」当作最高优先级；本 ADR 认为**部署可靠性**优先级更高，且写权限已等价于部署能力，故接受该风险。

## 影响 / 迁移

- ADR-0015 状态改为「已被取代」，其 B2 结论（PR 不设文档路径豁免）继续有效并被保留。
- 新增 secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`AGENT_RELEASE_SIGN_KEY`；沿用已有 5 个 `KHC_*`。
- `scripts/build-agent-release.sh` 的 `git add` 改为 `stage_if_tracked()`：产物被 `.gitignore` 排除时跳过入库，未排除时行为不变（公开库发版不再被 `git add` 阻断）。
- 本机 `deploy-local.sh` 不删除，降级为**应急通道**（GitHub Actions 不可用时）。

## 回退

1. 代码层：revert 本 ADR 对应的 workflow 改动（deploy job 改回仅 `workflow_dispatch`），即回到 ADR-0015 的人工路径；`wrangler.local.toml` 与本机私钥仍可用。
2. 生产层：`npx wrangler rollback --config wrangler.local.toml`（或 dashboard 选上一版本）。
3. 凭据层：吊销 CF token、从 repository secrets 删除三项；本机私钥文件保留为唯一离线副本。

## 验证

- 本地模拟 CI：临时私钥文件 → `build-agent-release.sh`（产物 + 验签通过）→ `pnpm build`（dist 内含 agent 包）→ `wrangler deploy --dry-run --config wrangler.ci.toml`（bindings 正确，不上传）。
- `./scripts/verify.sh` 全绿。
- 真实上线后：`GET /api/v1/version` 的 `commit` 等于本次提交 sha12、`versionId` 与 deploy 输出一致；`GET /api/v1/agent/releases` 与本次包一致；deploy job 自动创建 `release-<khcRelease>` 标签。
