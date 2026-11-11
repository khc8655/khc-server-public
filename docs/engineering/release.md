# 发版流程

> 状态：现行 ｜ 适用范围：版本号、发版分层、部署、部署前强制冒烟、D1 迁移、回滚、secrets、发布签名密钥轮换 ｜ 最后核验：2026-11-11（§7.4 补发布签名密钥轮换记录：方案 B 直接换钥、SIGN_KEY_FILE 加固、0.1.39 双节点切换与旧钥封存） ｜ 关联：`docs/release-versioning.md`、`docs/auto-deploy.md`、`docs/engineering/d1-migrations.md`、`docs/engineering/adr/ADR-0011-manifest-with-deploy.md`、`docs/engineering/adr/ADR-0013-release-layering.md`

## 0. 资源拓扑（ADR-0008，必读）

**生产与"staging"是同一个 Worker（`<worker-name>`）与同一个 D1（`<d1-name>`）**，生产身份仅由 `wrangler.toml` 的 `ENVIRONMENT=production` 表达；自定义域名在 Cloudflare 面板绑定。决策与影响见 `docs/engineering/adr/ADR-0008-production-reuses-staging.md`。

> 配置唯一来源是 `wrangler.toml`。原 `wrangler.staging.toml`（会把生产 `ENVIRONMENT` 翻成 `staging`）已于 2026-11-03 随 D-6 删除；上线前验证现由 **CI 部署前强制冒烟**（§3.6）承接，见 §4。
>
> **`workers_dev = true` + `preview_urls = true`（2026-11-07 回滚后的现状）**：`workers.dev` 子域**既是版本预览的载体，也是生产入口的源站**——`https://panel.example.com` 是第三方边缘，回源 Host 就是 `<worker>.<subdomain>.workers.dev`（`/cdn-cgi/trace` 的 `h=` 可实测）。因此 `workers_dev` 不能关闭，§3.7 在当前拓扑下不可执行，详见 `docs/auto-deploy.md`「事故记录 2026-11-07」。`preview_urls` 与 `workers_dev` 相互独立，显式保留后 §4 的预览 URL 冒烟在 CI 中仍然有效，检查的是本次新构建。
>
> 写请求 CSRF 白名单：`[vars] LIVE_ORIGINS`（逗号分隔的 origin，如 `https://panel.example.com`）。未配置时只允许与请求同 host 的 Origin（既有行为）；配置后按白名单放行，跨站伪造 Origin 仍 403。

## 1. 版本

- 语义化版本 `MAJOR.MINOR.PATCH`，当前 `0.3.x`（面板）。**分层与规则见 ADR-0013 与 `docs/release-versioning.md`**，本节只列要点。
- **面板版本唯一来源**：仓库根 `package.json` 的 `version` + `khcRelease`；`apps/web/src/version.ts` 与 `apps/api/src/version.ts` 都从它 import（不再双写硬编码）。
- **Agent 版本**：`agent/khc/util.py` 的 `VERSION`，独立于面板；改了 Agent 运行时代码就必须 bump 并出包（`scripts/verify-agent-release.mjs` 强卡）。
- **构建标识**：`wrangler deploy --tag <commit sha12>` 写入 Cloudflare `[version_metadata]`，`GET /api/v1/version` 与 `/api/v1/health` 返回 `commit` / `builtAt` / `versionId`。线上任何时刻都能反查到提交。
- **发布单元**：每次成功的生产部署由 CI 自动打 `release-<khcRelease>` 标签（同日多次加 `-2`/`-3`），注解含「面板版本 / Agent 版本 / Worker Version ID / 提交」。
- 每次发版更新 `CHANGELOG.md`（Keep a Changelog 格式），发布时 `[Unreleased]` 整段改为 `## [x.y.z] - 日期`。
- **门禁**：`scripts/check-release-consistency.mjs`（面板 bump + CHANGELOG 段）、`scripts/prune-agent-packages.mjs --check`（包留存），均已接入 CI 与 `./scripts/verify.sh`。

### 1.1 面板 ↔ Agent 兼容矩阵

**由代码强制**：Agent 侧 `MIN_PANEL_VERSION`（`agent/khc/util.py`）+ 面板侧 `X-Khc-Panel-Version` 请求头。

| 面板版本 | 可搭配的 Agent | 说明 |
|---|---|---|
| 0.4.x | 0.1.10 – 0.1.21+ | 面板 0.4.0 起在每次请求附 `X-Khc-Panel-Version`；**判定在 Agent 侧**：Agent 0.1.21 要求面板 ≥ 0.4.0。老 Agent 忽略该头，工作正常 |
| 0.3.x | 0.1.10 – 0.1.20 | 面板不带版本头；Agent 0.1.21 会以 426 `panel_too_old`（`panel_version_missing`）拒绝，故 0.3.x 面板**不可**搭配 0.1.21+ |
| 0.2.x | 0.1.10 – 0.1.20 | 含 TOTP 登录（面板侧），Agent 无感知 |

**升级顺序：先面板、后 Agent。** 反向（新 Agent + 旧面板）会被 426 拒绝，属预期行为——把静默的协议错配
变成明确报错。被拒时的表现：节点状态卡片与 `/state` 返回
「Agent 拒绝服务：版本协商失败（节点 Agent X 要求面板 ≥ Y，当前面板 Z…）」；直接 `GET /health`
可看到 Agent 的 `version` 与 `minPanelVersion`。

> 新增协议字段/破坏性变更时，必须同步：① 本表；② `MIN_PANEL_VERSION`；③ CHANGELOG 的版本段；
> ④ 面板侧 `signAgentRequest` 的头。门禁 `check-release-consistency` 不校验矩阵内容——它是人工契约。

## 2. 分支与合并

- `main` 始终可部署；功能在 `feat/*`，修复在 `fix/*`，文档在 `docs/*`。
- PR 必须：`./scripts/verify.sh` 通过、文档更新、UI 附截图、风险与回滚说明。
- 合并由主人执行（或明确授权）。

## 3. 部署（即生产部署）

合并到 `main` 后 GitHub Actions 先跑**部署前强制冒烟**，通过后才 `wrangler deploy`（见 `docs/auto-deploy.md` 与 §4）。也可手动触发 Actions 里的 `Deploy production Worker`（workflow_dispatch）。deploy job 顺序：Install / Build web → **Pre-deploy smoke** → Deploy → Verify deployed agent package；任一步失败即 `exit 1` 阻断后续步骤。

本地部署（CI 不可用时的兜底）：

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
./scripts/deploy-local.sh        # 内部先跑 verify.sh 再构建部署
```

首次/重建资源（一般不需要，现有资源已就绪）：

```bash
npx wrangler d1 create my-khc-db        # 若库不存在
# 然后按 docs/engineering/d1-migrations.md 顺序执行迁移
npx wrangler secret put ADMIN_PW_HASH        # 以下 secrets 也可在 Cloudflare 面板配置
npx wrangler secret put SESSION_SECRET
npx wrangler secret put MASTER_ENC_KEY
npx wrangler secret put AGENT_RELEASE_PUBKEY
# AGENT_RELEASE_MANIFEST 已不是必填：签名清单随部署发布
# （apps/web/public/agent/release-manifest.json，ADR-0011）；
# 仅在清单文件缺失的兼容场景下才需要这个 secret 兜底。
```

- secrets 只通过 `wrangler secret put` 或 Cloudflare 面板写入，不落仓库。
- `ADMIN_PW_HASH` 用 `node scripts/hash-password.mjs '<password>'` 生成。
- `MASTER_ENC_KEY` 丢失 = 所有加密 token/密钥不可恢复：必须离线备份。

## 4. 部署前强制冒烟（CI，D-6 / §3.6）

**现状（2026-11-07）**：上线前冒烟已由 CI deploy job 强制执行，不再依赖人工先 `versions upload` 再合并。`wrangler.toml` 为 `workers_dev = false` + `preview_urls = true`（§3.7 / §3.6）：生产 workers.dev 入口关闭，但版本预览 URL 仍可用，下面「用预览 URL 冒烟」同时是 CI 的实际门禁逻辑；本地手动执行仅作排障参考。

CI deploy job 在 `Deploy` 步骤之前的实际顺序（详见 `docs/auto-deploy.md`）：

1. `npx wrangler versions upload`：只上传版本、**不切生产流量**；上传命令失败即 `exit 1` 阻断 Deploy。
2. 从输出解析 `*.workers.dev` 预览 URL（或 `--preview-alias` 的别名 URL）→ curl `<预览URL>/api/v1/health` 与 `/api/v1/version`，要求均 **200** 且 health 返回 **`ok:true`**；预览 URL 可达但冒烟不通过即 `exit 1` 阻断（不兜底）。
3. **预览 URL 不可用时的兜底**：`preview_urls = true` 下正常不会触发；仅在预览域名完全不可用时，改为对**已部署自定义域名 `https://panel.example.com`** 做同样的 health/version 检查；连生产都不健康仍 `exit 1` 阻断部署，且 CI 日志需标注走了兜底。
4. 全部通过后才执行 `npx wrangler deploy`（此时才切生产流量并应用 `workers_dev = false`）。

复用既有 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`，不引入新 GitHub Secret。

> **兜底的能力边界**：正常路径用预览 URL 验证本次新构建。只有预览 URL 完全不可用时才走兜底，而兜底检查的是「当前线上版本」，只能阻断「生产已挂」这类明显故障；此时应查 CI 日志与 `preview_urls` 是否被后续部署覆盖。预览 URL 为公开的版本化地址，生产入口仍只有自定义域名。

### 4.1 历史：本地手动版本预览 recipe（workers_dev=true 时代，非门禁）

在**不改动生产流量**的前提下验证要上线的构建：

```bash
npm run build                 # 或 ./scripts/verify.sh（含 build）
npx wrangler versions upload  # 不带 --env，读 wrangler.toml；只上传版本，不切流量
# → 输出 Worker Version ID 与 Version Preview URL：
#   https://<versionId 前 8 位>-<worker-name>.<账号子域>.workers.dev
```

冒烟（把 `<预览URL>` 换成本次输出的地址）：

1. `GET <预览URL>/api/v1/health` → 200 JSON，`version` 与本次构建一致（**注意 `/health` 是 SPA 兜底、会返回 HTML 200，不能当探活用**）；
2. `GET <预览URL>/` → 200 HTML，`/assets/*.js` 可加载；
3. `POST <预览URL>/api/v1/auth/login`（正确口令）→ 200；带 cookie 后 `GET /api/v1/nodes` → 200；
4. `GET <预览URL>/api/v1/nodes`（不带 cookie）→ 401；
5. 需要时补一次 `plan`（不 apply）。

确认无误后由主人执行生产部署：`npx wrangler deploy`（或合并 main 后等 CI）。

**计费与流量口径**：版本预览**不切换生产流量**（生产继续跑当前活动版本），也**不新建独立 Worker 或独立计费单元**；预览 URL 的请求按该 Worker 的请求数计数，只在有人访问时产生（低频项目可忽略）。版本记录本身不额外计费。

> 实测（2026-11-03，本机 wrangler 4.152.0）：`versions upload` 成功，预览 URL 形如 `https://fd8f2f58-<worker-name>.<account>.workers.dev`；该 URL 的 `/api/v1/health`、`/`、登录、`/api/v1/nodes`（401/200）全部符合预期；**不需要在面板额外开任何开关**——预览 URL 依赖 Worker 的 `workers_dev` 路由（`wrangler.toml` 当时 `workers_dev = true`）。**2026-11-07 起 `workers_dev = false`，该预览 URL 已失效**，CI 改为上面的自定义域名兜底。详见 `docs/verification/2026-11-03/report.md` §20。

## 5. 部署后冒烟

1. `GET /api/v1/health` 返回当前版本（`/health` 是 SPA 兜底、不做探活）；
2. 登录面板 → 节点列表加载 → 任一节点 state 拉取成功；
3. 一次 plan（不 apply）；
4. 首页面板版本号与 `version.ts` 一致。

`wrangler deploy` 之后，CI 还会用**固定自定义域名** `https://panel.example.com/agent/khc-agent-<VERSION>.tar.gz?v=<sha 前 12 位>` 核对线上 Agent 包 sha256 与仓库一致（§3.7；不再从 deploy 输出解析 `*.workers.dev` URL）。该校验只能事后报警，不能替代 §4 的部署前冒烟。

出问题立即回滚：`npx wrangler rollback`（回到上一部署版本）或重新部署上一个 commit；Agent 侧保留旧版本目录（`.prev`）。

## 6. D1 迁移

见 `docs/engineering/d1-migrations.md`（迁移清单、执行顺序、命令、核对与回滚）。要点：只增不改；对 remote 执行即改生产库，先导出备份。

## 7. Agent 发版

### 7.1 链条（走查卡点 1 的诊断结论）

> **公开仓库说明（2026-11-11）**：`apps/web/public/agent/` 下的 `*.tar.gz`、`.sha256`、`release-manifest.json` **不进入公开仓库**（已写入 `.gitignore`），由私有发版流程在发布机上用发布私钥生成后注入。公开仓库运行 `./scripts/verify.sh` 时，该目录无产物会显式打印 `SKIP` 并放行（不伪造验签）。以下流程描述以私有发版仓库为准。

- **产生**：`agent/package.sh` 按 `agent/khc/util.py` 的 `VERSION` 打 `khc-agent-<VERSION>.tar.gz` + 伴生 `.sha256`；
- **入库与托管**：包放在 `apps/web/public/agent/`，随 Worker assets 自动部署（线上 URL 形如 `https://<worker>/agent/khc-agent-<VERSION>.tar.gz`）；
- **清单**：`scripts/sign-agent-release.mjs` 用 Ed25519 私钥签发布清单 `{version,url,sha256}`，写入 `apps/web/public/agent/release-manifest.json` 并入库，随 assets 同一次部署生效（ADR-0011）；Worker 读取优先级为**该文件优先**，`AGENT_RELEASE_MANIFEST` secret 仅在文件缺失时兜底；面板 install/upgrade 命令只接受清单内的 `url+sha256`；
- **下发**：Agent 拉取式升级，下载后自校验 sha256；同版本升级拒绝（`same_version`），必须 `reinstall=true`。

> 历史漂移案例（2026-11 走查）：批次修复改了 agent 源码但 `VERSION` 未 bump、包未重打，
> 线上清单仍指向旧 `khc-agent-0.1.4.tar.gz`（sha256 `1592311d…`），与 main 重建产物
> （sha256 `6e9dae56…`）同名不同内容——"代码修了但线上跑旧包"。
> 清单现在是仓库内的 `apps/web/public/agent/release-manifest.json`，CI 可离线验签；
> 线上实际生效值仍以部署后 `GET /api/v1/agent/releases` 为准。

### 7.2 发版步骤（每次改动 agent 代码）

1. bump `agent/khc/util.py` 的 `VERSION`（补丁缺陷 = patch 位）；
2. `./scripts/build-agent-release.sh` —— 出包、拷入 `apps/web/public/agent/`、一致性自检，产物与 `.sha256` 入库随分支合并；
3. 有私钥时：`SIGN_KEY_FILE=<Ed25519 私钥 PEM 文件路径> PUBLIC_BASE=https://<worker>/agent ./scripts/build-agent-release.sh`——
   脚本只接受**文件路径**，拒绝把私钥内容放进环境变量或命令行参数；脚本会把签名清单写入
   `apps/web/public/agent/release-manifest.json` 并 `git add`（私钥不入 CI/仓库）；
   **不再需要 `wrangler secret put AGENT_RELEASE_MANIFEST`**，清单随同一次部署生效（ADR-0011）；
   脚本生成的包 URL 带 `?v=<sha 前 12 位>`：同名包重建后 CDN 仍可能命中旧内容，查询串确保节点拉取到与清单 sha 一致的字节；
4. 部署后在面板 `GET /api/v1/agent/releases` 核对版本与 sha 前缀，节点上执行升级命令。

**0.1.7 实例（已完成，2026-11-03 批次 K）**：步骤 1–2 在批次 J 完成（`agent/khc/util.py` `VERSION = "0.1.7"`，包入库 `apps/web/public/agent/khc-agent-0.1.7.tar.gz`，CI 一致性检查通过；0.1.5/0.1.6 曾在批次 G/I 打包但均为未发布的中间版本，已先后被取代并从仓库移除）；**步骤 3 已在批次 K 执行**——用既有 Ed25519 私钥（本地 `.khc-local/release-keys/agent-release-private.pem`，公钥指纹与线上 `AGENT_RELEASE_PUBKEY` 一致）签发含 0.1.7 条目的新清单并 `wrangler secret put AGENT_RELEASE_MANIFEST`；步骤 4 已核对：线上 `GET /api/v1/agent/releases` 返回 0.1.7（sha256 `80405614…`）与仓库包一致，线上下载包 sha256 == 仓库包。

**清单未更新时的线上表现（fail-closed，按设计拒绝）**：面板所有下发命令走 `agent_lifecycle.ts` 路由（install/upgrade/uninstall 命令生成与远程升级），每个都先过 `assertAgentReleaseAllowed`（`apps/api/src/lib/agent-releases.ts`）；0.1.7 的 `packageUrl + sha256` 不在清单内 → 直接 400 `release_not_in_manifest` → **面板 Agent 卡的安装/升级命令生成失败、远程升级报错**，Agent 看门狗升级用的 URL 同样来自该链路。这不会破坏已运行的 0.1.4 节点，但"代码修了却发不出去"，直到主人完成步骤 3。

### 7.3 自动校验（防回归）

- **CI（verify job）**：`node scripts/verify-agent-release.mjs --diff "$DIFF_BASE" --repo`，`DIFF_BASE` 取 push 的 `github.event.before`（PR 用 `base.sha`，手动触发用 `HEAD~1`）——规则 1：agent 运行代码（`khc/`、`adapters/`、入口脚本）变更必须 bump `VERSION`；规则 2：`VERSION` 变更必须已出包入库。此前用 `origin/main` 作基线，push main 时它已等于 HEAD，diff 恒为空、两条规则从不触发；
- **CI（deploy job）**：`workflow_dispatch` 同样要求 `github.ref == refs/heads/main`；`Deploy` 前先跑部署前强制冒烟（§4），部署后 curl **固定自定义域名** `https://panel.example.com/agent/khc-agent-<VERSION>.tar.gz?v=<sha 前 12 位>`（与签名清单同款 cache-buster）算 sha256，与仓库包不一致即失败（§3.7 起不再从 deploy 输出解析 `*.workers.dev` URL，关闭 workers_dev 后也解析不到）；
- **本地**：`./scripts/verify.sh` 包含 `--repo` 一致性检查（`VERSION` == 包内版本 == 文件名、`.sha256` == 实际哈希），用 Agent 内置公钥验证 `apps/web/public/agent/release-manifest.json` 的签名并核对其 sha256 覆盖当前包，且**逐文件比对包内 Agent 源码与仓库 `agent/`**——改了 `agent/khc/*.py` 却没重打包会直接失败。

- Agent 包 = `agent/package.sh` 产出的 tar.gz + sha256；
- 升级只允许拉取式（Agent 从控制面下载并自校验），禁止远程推送脚本；
- 升级失败自动回退旧版本目录（`.prev`）；
- 发版后真机跑 `install --no-start` + 冒烟；流程见 `docs/agent-releases.md`、`docs/agent-lifecycle.md`。

### 7.4 发布签名密钥轮换记录（2026-11-11，方案 B 直接换钥）

- **批准**：主人于 2026-11-11 选择「方案 B：直接换钥」（不走"旧钥签过渡版本"的渐进路径）。
- **起因**：旧 Ed25519 私钥在一次本地构建命令的失败回显中被当作路径打印，按**已泄露**处置，不再使用。
- **顺序**（实际执行）：
  1. 根因修复：`scripts/build-agent-release.sh` 的 `SIGN_KEY` 改名 `SIGN_KEY_FILE`，只接受私钥**文件路径**并做存在性预检；旧变量显式拒绝；任何失败路径不回显变量内容。
  2. 离线生成新钥对（仓库外、私钥 `0600`）：私钥 `.khc-local/release-keys/agent-release-2026-11-11-private.pem`，公钥 `jicI9g35IzwQSsfeDVmwcI1RDZ5jQmeWOHuZ5Vx0OmA=`。
  3. Agent 0.1.39 的 `agent/khc/release_verify.py` **只内置新公钥**；旧公钥 `/FZ9DSjSypUVJiW2++8AWhdrCke/v02SdzTpFd/SQK4=` 在工作树无残留。
  4. 用新钥签 0.1.39 清单（sha256 `78f268472b5f…`），`scripts/verify-agent-release.mjs --repo` 通过；改动见 PR #137。
  5. 测试机 203.0.113.17 演练：手工装 0.1.39，`/health` = `0.1.39`、`systemctl is-active` = `active`；新钥清单验签通过，旧钥清单被拒（`release_signature_invalid`）。
  6. 生产切换：合并 PR #137 触发 assets 部署（新清单随包上线），随后立即 `npx wrangler secret put AGENT_RELEASE_PUBKEY` 换为新公钥。中间态（约 10 秒）：Worker 用旧公钥验新清单 → `GET /api/v1/agent/releases` 返回 403 `release_signature_invalid`，**只影响安装/升级命令生成，运行中的节点不受影响、无自动升级定时器**。
  7. 两台节点用安装命令手工铺 0.1.39：`node-test-2`、`node-prod-1`；逐台核对 `/health`、`is-active`、面板 `/state` 的 `agent.version = 0.1.39`。
  8. 复核：`GET /api/v1/agent/releases` 的 sha256 与线上下载包一致；0.1.39 内置公钥能验过生产新清单。
  9. 旧私钥销毁并封存（见下）。
- **回退方式**（仅当 0.1.39 节点出现不可恢复故障）：
  1. 从封存件解密恢复旧私钥（见下）；
  2. `npx wrangler secret put AGENT_RELEASE_PUBKEY` 恢复旧公钥 `/FZ9…`；
  3. 用旧私钥重签含 0.1.38 的清单并部署（或 `wrangler rollback` 回滚到 PR #137 之前的 Worker 版本，旧 assets 清单随版本回滚）；
  4. 用安装命令把节点回装 0.1.38。**0.1.39 只认新钥、旧版只认旧钥**：secret 与节点包必须一起回退，不能只改其一。
- **旧私钥封存位置与取用**：
  - 封存件：`.khc-local/release-keys/sealed/agent-release-old-2026-10-31.pem.enc`（`0400`，AES-256-CBC + PBKDF2 30 万轮）；
  - 口令：macOS 登录钥匙串条目 `khc-old-agent-release-key-2026-10-31`（account `khc-release`）。**只有主人本机登录并解锁钥匙串才能取出**；
  - 本机明文旧私钥已用随机字节覆盖后删除；封存件不含口令，可另存到离线介质（U 盘/加密盘），建议复制后删除本机副本；
  - 取用者：仅主人（项目所有者）；
  - **封存目的仅为回退，到期销毁日 2026-11-25（封存后两周）**，不作长期保管。到期销毁步骤：① `rm -f .khc-local/release-keys/sealed/agent-release-old-2026-10-31.pem.enc`；② `security delete-generic-password -a khc-release -s khc-old-agent-release-key-2026-10-31`；③ 复核仓库与封存目录无残留（`ls .khc-local/release-keys/sealed/`，并按旧公钥前缀 grep `.py/.ts/.mjs/.json`）；
  - **销毁后上述「回退方式」的第 1–3 步不再可用**（没有旧私钥就无法重签旧清单），只能靠安装命令把节点回装旧版本；届时如仍需保留封存件，必须显式改期并把理由写回本节，不得口头延期。
- **注意**：APFS / Time Machine 快照与远端会话日志无法逐块擦除；旧钥已按泄露处置，不得再用于任何新清单签名。
- **遗留（2026-11-11 记录，未改代码）**：`node-prod-1` 与测试机 203.0.113.17 是同一台，本次换钥的演练与生产切换共用该机，信任根类操作缺少独立演练环境；建议后续单列一台专用测试机（待主人提供机器）。

## 8. 回滚检查表

- [ ] 先用 `git tag --list 'release-*'` 找到目标发布标签，标签注解里直接写着「面板版本 / Agent 版本 / Worker Version ID / 提交」——回滚目标是提交而不是猜测
- [ ] 核对线上身份：`curl https://panel.example.com/api/v1/version` 的 `commit` / `versionId` 与目标标签是否一致
- [ ] Worker 版本回滚路径可用（`wrangler rollback`，或按标签提交重新部署）
- [ ] D1 迁移可回退（或无需回退，见 d1-migrations.md）
- [ ] Agent 旧版本目录存在（`.prev`）；注意 `apps/web/public/agent/` 只保留最近 3 个包，更早版本需从标签或 CI artifact 取
- [ ] 当前节点配置已导出（备份导出）或 revisions 可回滚
- [ ] 通知/记录到 CHANGELOG；回滚后补一段 `### Fixed（回滚说明）`
