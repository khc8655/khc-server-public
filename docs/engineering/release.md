# 发版与部署

> 状态：现行 ｜ 最后核验：2026-11-13 ｜ 关联：ADR-0013、ADR-0016、ADR-0019

本文是版本规则、发版流程、Agent 发版与回滚的唯一来源。决策理由见 ADR，历史记录见 `docs/archive/2026-11/release-history.md`。

## 1. 环境拓扑

- 生产只有一套 Worker 和一个 D1，身份由 `wrangler.toml` 的 `ENVIRONMENT=production` 表达（ADR-0008）。没有独立预发环境。
- **合并 main = 生产部署**（ADR-0016）。`docs/**` 与 `**/*.md` 的 push 不触发部署；PR 不设路径豁免，纯文档 PR 也会跑测试。
- **`workers_dev` 必须为 `true`**：生产入口是第三方边缘，回源 Host 就是 `*.workers.dev`，关闭会整站 404。CI 的拓扑闸门会阻断这个错误。
- **Cloudflare 侧不得挂 Git 集成（Workers Builds）**，否则两套部署互相覆盖。
- 仓库里的 `wrangler.toml` 只有占位值。CI 用 secrets 渲染临时 `wrangler.ci.toml`，本机应急用 `wrangler.local.toml`，两者都被 gitignore。

## 2. 版本规则（ADR-0013）

| 层 | 是什么 | 在哪 |
|---|---|---|
| 发布单元 | 一次成功的生产部署 | git 标签 `release-<khcRelease>[-N]`，由 CI 自动打 |
| 产物版本 | 面板与 Agent 各自的 semver | 面板：`package.json` 的 `version` + `khcRelease`（唯一来源）；Agent：`agent/khc/util.py` 的 `VERSION` |
| 构建标识 | 线上进程身份 | `wrangler deploy --tag <sha12>` → `GET /api/v1/version` 的 `commit` / `versionId` |

**档位**：新增用户可见能力或向后兼容的字段 → minor；修复、内部改进、文案样式 → patch；破坏 API 或 Agent 协议 → major。

**硬规则**（由脚本卡住，CI 与 `verify.sh` 都会执行）：

| 产物 | 规则 | 门禁 |
|---|---|---|
| 面板 | 改了 `apps/(api\|web)/src` 的非豁免文件，必须 bump `version`；bump 后 CHANGELOG 必须有 `## [<version>]` 段 | `scripts/check-release-consistency.mjs` |
| Agent | 改了 `agent/khc/`、`agent/adapters/`、入口脚本，必须 bump `VERSION` | `scripts/verify-agent-release.mjs` |

- 面板豁免：测试文件、`apps/web/src/i18n/`、`apps/web/public/`、`*.md`、CI 配置、`scripts/`。
- 提交信息含 `[skip-release]` 可跳过面板 bump，只用于纯内部整理，PR 描述必须写理由。
- 代码里不得出现版本号字面量，`version.ts` 只能 import `package.json`。

### 2.1 面板与 Agent 兼容

- Agent 的 `MIN_PANEL_VERSION`（`agent/khc/util.py`）与面板每次请求带的 `X-Khc-Panel-Version` 头由代码强制匹配。面板过旧时 Agent 返回 426 `panel_too_old`。
- **升级顺序：先面板，后 Agent。**
- 破坏协议时同时改：`MIN_PANEL_VERSION`、面板 `signAgentRequest` 的头、CHANGELOG 版本段。

## 3. 发版流程

### 3.1 合并前（执行者）

1. 按 §2 判定档位并 bump 版本；在 CHANGELOG 写版本段（格式见 `CONTRIBUTING.md`）。
2. `./scripts/verify.sh` 全绿。
3. 按 `docs/engineering/testing.md` §5 的发版类型补真机验证，证据写进 PR。
4. 开 PR，CI 全绿后由主人合并。

### 3.2 合并后（CI deploy job 自动执行）

| 步骤 | 作用 | 失败时 |
|---|---|---|
| Check deploy credentials | 缺 secrets 立即退出 | 阻断 |
| Render wrangler.ci.toml | 用 secrets 覆盖占位值，残留占位值即退出 | 阻断 |
| Generate signed agent release | CI 内签包，并带回线上当前版本作为 N-1（§4.2） | 签包失败阻断；取 N-1 失败只告警 |
| Build web | 把 `apps/web/public/agent/` 一起打进 assets | 阻断 |
| Pre-deploy smoke | `wrangler versions upload`（不切流量），用预览 URL 检查 `/api/v1/health` 与 `/api/v1/version` | 阻断 |
| Guard deploy topology | 用 `/cdn-cgi/trace` 实测源站，与 `workers_dev` 交叉校验 | 阻断 |
| Deploy | `wrangler deploy --tag <sha12>` | — |
| Verify production entry | 生产入口健康，且 `commit` / `versionId` 等于本次部署 | 报错，**不自动回滚** |
| Verify deployed agent package | 线上包 sha256 与本次构建一致 | 报错，**不自动回滚** |
| Tag release | 打 `release-<khcRelease>[-N]`，注解记录面板版本、Agent 版本、Version ID、提交 | — |

部署后校验失败时按 §5 人工回滚。

### 3.3 部署后人工复核

1. `GET /api/v1/version`：`commit` 等于合并提交前 12 位。
2. 登录面板，节点列表加载，任一节点拉取状态成功，执行一次 plan（不 apply）。
3. Agent 有版本变化时：`GET /api/v1/agent/releases` 返回新版本，再按需升级节点。

### 3.4 触发路径与 secrets

| 路径 | 触发 | 用途 |
|---|---|---|
| CI 自动 | 合并 main | 默认 |
| CI 手动 | Actions → `Deploy production Worker`（仅 main） | 自动部署失败后补发 |
| 本机应急 | `./scripts/deploy-local.sh` | GitHub Actions 不可用时 |

**Repository secrets**：`CLOUDFLARE_API_TOKEN`（Workers Scripts:Edit + Account Settings:Read）、`CLOUDFLARE_ACCOUNT_ID`、`AGENT_RELEASE_SIGN_KEY`（Ed25519 私钥 PEM），以及渲染配置用的 `KHC_WORKER_NAME`、`KHC_D1_NAME`、`KHC_D1_ID`、`KHC_PANEL_ORIGIN`、`KHC_WORKERS_DEV_ORIGIN`。

**Worker secrets**（`wrangler secret put` 或 Cloudflare 面板）：`ADMIN_PW_HASH`（`node scripts/hash-password.mjs '<口令>'` 生成）、`SESSION_SECRET`、`MASTER_ENC_KEY`、`AGENT_RELEASE_PUBKEY`。`MASTER_ENC_KEY` 丢失则全部加密数据不可恢复，必须离线备份。

### 3.5 本机应急发版

```bash
cp wrangler.toml wrangler.local.toml     # 改 name / database_name / database_id / LIVE_ORIGINS
SIGN_KEY_FILE=<私钥文件路径> PUBLIC_BASE=https://<面板入口>/agent ./scripts/build-agent-release.sh
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
./scripts/deploy-local.sh                # verify → build → deploy --tag
```

本机路径不跑 CI 的冒烟和校验，部署后必须按 §3.3 复核，并手动打 `release-*` 标签。

### 3.6 首次建资源

`npx wrangler d1 create <库名>` → 按 `docs/engineering/d1-migrations.md` 执行迁移 → 配置 §3.4 的 Worker secrets。

## 4. Agent 发版

### 4.1 链条

1. `agent/package.sh` 按 `VERSION` 打 `khc-agent-<VERSION>.tar.gz` 和 `.sha256`。
2. `scripts/build-agent-release.sh` 用 Ed25519 私钥签发布清单 `release-manifest.json`。私钥只接受**文件路径**（`SIGN_KEY_FILE`），不接受环境变量内容或命令行参数。
3. 包与清单放进 `apps/web/public/agent/`，随 Worker assets 一起部署（ADR-0011）。公开仓库不入库这些产物，由 CI 在 build 前现场生成；本地 `verify.sh` 看到目录为空会打印 `SKIP`。
4. Worker 只接受清单内的 `url + sha256`，清单外返回 400 `release_not_in_manifest`。Agent 拉取式升级，下载后自校验；同版本升级会被拒绝。

### 4.2 带回上一版（N-1，ADR-0019）

签包前，脚本读取线上清单并用内置公钥验签，取回当前生产版本的包，新清单里新版本在 `releases[0]`、上一版在 `releases[1]`。取回失败时降级为单条清单继续部署，日志打出：

```
WARN: 本次发版不含 N-1（…），面板回滚将不可用
```

`CARRY_OVER=0` 关闭；`CARRY_OVER_FROM=<origin>` 改取回来源。

### 4.3 包留存

`apps/web/public/agent/` 保留当前 `VERSION`、清单登记的版本和最近若干个，清单登记的包永不删除。`node scripts/prune-agent-packages.mjs --check` 检查，去掉 `--check` 执行退役。

### 4.4 签名密钥

- 生成：`OUT_DIR=<仓库外目录> node scripts/generate-agent-release-key.mjs`，私钥 0600、不入库。
- 换钥：Agent 内置公钥（`agent/khc/release_verify.py`）与 Worker 的 `AGENT_RELEASE_PUBKEY` 必须一起换。新 Agent 只认新钥，回退时 secret 与节点包也要一起回退。
- 2026-11-11 换钥过程与旧钥封存信息见归档 `release-history.md` §7.4。

## 5. 回滚

| 对象 | 方式 |
|---|---|
| Worker | `npx wrangler rollback`，或按 `release-*` 标签对应的提交重新部署。先用 `git tag --list 'release-*'` 找目标，再用 `/api/v1/version` 核对 |
| D1 | 迁移只增不改，通常无需回退；见 `docs/engineering/d1-migrations.md` |
| Agent（自动） | 升级后 30 秒内不健康，看门狗把 `.prev` 换回并重启，结果写入 `/var/lib/khc-agent/upgrade.json` |
| Agent（面板） | 节点设置 → Agent 卡片 → 回滚到上一版（L3）。只在节点当前版本等于 `releases[0]` 且清单有 `releases[1]` 时出现；只能回退一格，且只能回到内置公钥相同的版本 |
| Agent（人工） | `systemctl stop khc-agent` → 安装目录内 `mv khc-agent khc-agent.failed && mv khc-agent.prev khc-agent` → `systemctl start khc-agent` |
| 节点配置 | 应用详情的历史 Tab 回滚 revision，或导入备份 |

同一节点两次升级间隔至少 60 秒（已知问题见 `docs/agent-lifecycle.md` §13）。

回滚后在 CHANGELOG 补一段说明。
