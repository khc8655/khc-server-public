# ADR-0008: 生产复用 <worker-name> Worker 与 D1

- 状态：已接受（补记）
- 日期：2026-10-31（决策执行于 commit `60cdb91`，本 ADR 于 2026-11-02 文档整改时补记）
- 决策者：主人

## 背景

原设计（`docs/engineering/release.md` 旧版）为两套资源：staging Worker `<worker-name>` + `<d1-name>`，生产另建 `<worker-name>` + `<d1-name>`（`wrangler.toml` 用占位 D1 id，替换后才可部署）。2026-10-31 前后，主人确认**不再单独创建生产资源**：本面板为单用户个人项目，流量极低（月打开约 10 次），维护两套 Worker/D1 的成本与收益不成比例；且当时 GitHub Actions 账单/额度耗尽（见 `docs/archive/2026-11/auto-deploy.md`），部署路径需要收敛。

## 选项

| 选项 | 做法 | 利 | 弊 |
|---|---|---|---|
| A 两套资源（原方案） | 生产独立 Worker + 独立 D1，staging 先行验证 | 隔离彻底，staging 可随意试验 | 双倍资源维护；个人项目无真实 staging 流量，隔离收益低 |
| **B 生产复用 staging（选定）** | `wrangler.toml` 直接指向 `<worker-name>` Worker 与 `<d1-name>`，仅 `ENVIRONMENT=production` | 零新增资源；部署路径唯一（CI）；配置不会漂移 | 无独立预发环境：每次部署直接上生产；配置来源必须唯一（`wrangler.toml`） |

## 决策

采用 **B**。生产与"staging"是**同一个 Worker（`<worker-name>`）与同一个 D1（`<d1-name>`）**，生产身份仅由 `wrangler.toml` 的 `ENVIRONMENT=production` 表达；自定义域名在 Cloudflare 面板绑定（不在 wrangler 配置内）。

## 影响 / 迁移 / 回滚

- `.github/workflows/ci.yml` 原有的"占位 D1 id 检查"成为永远通过的死代码，已随文档整改移除。
- ~~`wrangler.staging.toml` 成为高危脚枪~~：**该文件已于 2026-11-03 删除**（D-6 拍板）。它与 `wrangler.toml` 指向同一 Worker，执行 `npx wrangler deploy --config wrangler.staging.toml` 会把生产 Worker 的 `ENVIRONMENT` 翻成 `staging`。配置唯一来源自此为 `wrangler.toml`。
- 上线前验证改走 **版本预览**：`npx wrangler versions upload` → 预览 URL 冒烟 → 主人确认后部署（流程见 `docs/engineering/release.md` §4）；不切生产流量、不新建独立 Worker。
- CI 部署（main 推送 / workflow_dispatch）即生产部署；"staging E2E 验证后再上线"的旧流程不再存在，验证改在本地 `./scripts/verify.sh` + 预览版本冒烟 + 合并后线上冒烟。
- 后续若要改名 Worker 或换自定义域名，必须同步更新 `AGENT_RELEASE_MANIFEST` 里的包 URL（`wrangler.toml` 头部注释）。
- 回滚方式不变：`wrangler rollback` 或重新部署上一 commit；D1 迁移回滚见 `docs/engineering/d1-migrations.md`。

## 验证

- commit `60cdb91` 合并后 CI 部署成功，生产域名（面板）冒烟通过（2026-11-02 UI 重构上线验证，PR #58）。

## 补记（2026-11-03，D-6）

- `wrangler.staging.toml` 已删除；全仓库不再保留该配置。
- 实测 `npx wrangler versions upload` 可用：输出预览 URL（形如 `https://<versionId 前 8 位>-<worker-name>.<账号子域>.workers.dev`），不切生产流量；预览 URL 依赖 Worker 的 `workers_dev = true`（`wrangler.toml` 已启用），无需面板额外开关。证据见 `docs/verification/2026-11-03/report.md` §20。
- 实删时附带发现：当时生产活动版本的 `ENVIRONMENT` 实为 `staging`（`/api/v1/health` 返回 `env: staging`），说明该脚枪此前确被触发过一次；下一次生产部署（CI `wrangler deploy`）会恢复为 `production`。
