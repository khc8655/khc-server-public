# 发版规范（面板 + Agent）

> 状态：现行 ｜ 适用范围：两个产物（面板 Worker/Web、Node Agent）的版本号、发布单元、构建溯源与门禁 ｜ 最后核验：2026-11-07 ｜ 关联：`package.json`、`agent/khc/util.py`、`.github/workflows/ci.yml`、`scripts/check-release-consistency.mjs`、`scripts/verify-agent-release.mjs`、`scripts/prune-agent-packages.mjs`、ADR-0013、`docs/engineering/release.md`

**先读结论**：版本号分三层，面板与 Agent 各自独立版本，**改动必须 bump、发布必须有锚点**，两条都由脚本卡住，不靠人记。

## 0. 三层模型（ADR-0013）

| 层 | 是什么 | 在哪 |
|---|---|---|
| **L1 发布单元** | 一次已验收的发布 | git 标签 `release-<日期>` + CHANGELOG 的 `## [x.y.z] - 日期` 段 |
| **L2 产物版本** | 每个可独立升级产物的 semver | 面板 `package.json` 的 `version`（唯一来源）；Agent `agent/khc/util.py` 的 `VERSION` |
| **L3 构建标识** | 线上进程的身份 | `wrangler deploy --tag <commit sha12>` → `[version_metadata]` binding → `/api/v1/version` 的 `commit` / `builtAt` / `versionId` |

## 1. 面板版本（唯一来源）

```jsonc
// package.json（仓库根）
{
  "version": "0.3.0",        // 面板版本，唯一来源
  "khcRelease": "2026-11-07" // 本次发布日期
}
```

`apps/web/src/version.ts` 与 `apps/api/src/version.ts` 都从它 import：

```ts
import pkg from '../../../package.json';
export const PANEL_VERSION: string = pkg.version;
export const PANEL_RELEASE_DATE: string = pkg.khcRelease;
```

**禁止**再在代码里写版本字面量——门禁 `--repo` 会检查两个版本来源文件必须 `import package.json`，且不得出现 `PANEL_VERSION = '0.2.0'` 这类硬编码（防双写回潮）。

首页展示 `面板 v0.3.0 · 2026-11-07`（`PANEL_VERSION_LABEL`），服务端 `GET /api/v1/version` 返回同版号外加 L3 字段。

## 2. semver 语义（面板与 Agent 同口径）

| 变化类型 | 档位 | 例 |
|---|---|---|
| 新增用户可见能力 / 新增向后兼容的接口字段 | **minor** `0.x.0` | 新增 TOTP、新增构建溯源字段 |
| 行为修复、内部改进、性能、文案/样式修正 | **patch** `0.0.x` | 修复 415 误判、UI 令牌收敛 |
| 破坏契约（API 不兼容、Agent 协议不兼容、需两端同升） | **major** `x.0.0` | 改 HMAC 签名头、改 Agent 状态结构 |

**不要把新功能塞进 patch 位。** 历史上 0.1.x 混入了 recipe 引擎、SSE→轮询、iptables 放行，属违规；新改动按上表。

## 3. 两条硬规则（谁改了就必须做什么）

| 产物 | 规则 | 门禁 |
|---|---|---|
| **Agent** | 改 `agent/khc/`、`agent/adapters/`、入口脚本 ⇒ `VERSION` 必须变；变 ⇒ `apps/web/public/agent/khc-agent-<ver>.tar.gz` 必须已出包入库 | `scripts/verify-agent-release.mjs --diff`（CI + `verify.sh`） |
| **面板** | 改 `apps/(api|web)/src` 的非豁免文件 ⇒ `package.json` `version` 必须变；变 ⇒ CHANGELOG 必须有 `## [<ver>]` 段 | `scripts/check-release-consistency.mjs --diff`（CI + `verify.sh`） |

**面板豁免**（改了也不要求 bump）：`*.test.ts(x)`、`*.smoke.test.tsx`、`apps/web/src/i18n/`（纯文案）、`apps/web/public/`（Agent 包走自己的规则）、`*.md`、CI 配置、`scripts/`。

**整体豁免**：提交信息含 `[skip-release]` 时跳过面板 bump 要求，仅用于纯内部整理（重命名、格式化、注释），**必须在 PR 描述里写明理由**。

## 4. 发版流程

面板发版（Agent 未改则完全不涉及 Agent）：

1. 判定档位 → 改 `package.json` 的 `version` 与 `khcRelease`（同一提交）。
2. 在 `CHANGELOG.md` 的 `[Unreleased]` 下写改动；发布时把该段改成 `## [<version>] - <khcRelease>`。
3. 本地 `./scripts/verify.sh`（含两条发版门禁 + Agent 包留存检查）。
4. PR → CI（`Agent release consistency` / `Panel release consistency` / `Agent package retention` 全绿）→ 合并 main。
5. main 推送自动部署：`Pre-deploy smoke` → `Guard deploy topology` → `Deploy --tag <sha12>` → `Verify production entry` → `Verify deployed agent package` → **`Tag release`（自动打 `release-<khcRelease>`）**。
6. 验收：`curl https://panel.example.com/api/v1/version` 应返回新版本 + `commit`（= 部署提交前 12 位）+ `versionId`；`git tag --list 'release-*'` 应出现本次标签。

Agent 发版额外步骤（改动了 `agent/` 时）：

1. bump `agent/khc/util.py` 的 `VERSION`（按上表档位）。
2. `(cd agent && OUT_DIR=/tmp/khc-dist ./package.sh)` 出包 → 复制到 `apps/web/public/agent/` + 生成 `.sha256`。
3. 重签 `apps/web/public/agent/release-manifest.json`（ADR-0011，私钥不入库）。
4. `node scripts/verify-agent-release.mjs --repo` 与 `node scripts/prune-agent-packages.mjs --check` 必须通过。
5. 详见 `docs/agent-releases.md`。

## 5. 产物留存

`apps/web/public/agent/` 随每次部署作为 assets 全量上传，因此限制留存数量：

```bash
node scripts/prune-agent-packages.mjs --check   # 超限即失败（CI/verify.sh 已接）
node scripts/prune-agent-packages.mjs           # 执行退役
```

保留「当前 `VERSION` + 清单登记版本 + 最近 N-1 个」（默认 3 个）。**清单登记的包永不删除**——删它等于让线上安装/升级 404。已装在节点上的旧版本不受影响（升级只向新版本走）。

## 6. 存量对齐（2026-11-07）

本次按本规范做的第一件事就是修历史欠账：

- 面板 `0.2.0 → 0.3.0`（补齐 10-31 以来所有未发版的改动；新增能力属 minor）。
- `apps/web/public/agent` 由 18 个包 / 3.3MB 收敛为 3 个（0.1.18/0.1.19/0.1.20）/ 652KB。
- Agent `VERSION` 保持 `0.1.20` 不动（本批未改 `agent/` 运行时代码）。
- CHANGELOG 从「只有一个 [Unreleased]」改为按版本切段；0.1.1–0.1.20 的历史细节不追溯补写（避免编造），以 git log 与标签为准确来源。

## 7. 快速自检

```bash
node scripts/check-release-consistency.mjs --repo   # 版本来源 + CHANGELOG 段 + 日期合法
node scripts/prune-agent-packages.mjs --check       # 包留存
node scripts/verify-agent-release.mjs --repo        # Agent 包/版本/签名一致
curl -s https://panel.example.com/api/v1/version         # 线上版本 + commit + versionId
git tag --list 'release-*'                          # 发布史
```
