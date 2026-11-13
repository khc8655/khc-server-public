# GitHub → Cloudflare Worker 自动部署

> 状态：现行 ｜ 适用范围：CI 自动部署的配置与行为 ｜ 最后核验：2026-11-07（部署前强制冒烟进 CI、拓扑闸门、部署后生产入口校验、workers_dev 回滚为 true） ｜ 关联：`.github/workflows/ci.yml`、`docs/engineering/release.md`

> ⚠️ **`workers_dev` 必须保持 `true`**：生产入口 `https://panel.example.com` 的源站就是 `<worker>.<subdomain>.workers.dev`，置 `false` 会让整站 404。详见文末「事故记录 2026-11-07」。

**main 推送（或手动 workflow_dispatch）→ GitHub Actions 自动构建前端，先跑部署前强制冒烟，通过后才 `wrangler deploy`。** 由于生产复用同一 Worker/D1（ADR-0008），**这就是生产部署**，没有独立的 staging 部署环节。

## 触发

- `push` 到 `main`（忽略 `docs/**` 与 `**/*.md` 的纯文档变更，不触发部署）；
- `pull_request`：只跑测试（agent + typecheck/vitest/build），不部署；
- `workflow_dispatch`：Actions 页面手动点 `Deploy production Worker`；**仅当所选 ref 为 `main` 时才部署**（deploy job 的 if 统一校验 `github.ref`），避免从任意 feature 分支带生产 secrets 部署。

## CI 部署顺序（deploy job，2026-11-07 起）

`needs: [agent, verify]`，且仅 `main` 推送 / `workflow_dispatch`（`github.ref == refs/heads/main`）才执行。步骤如下，**任一步 `exit 1` 都会阻断后续步骤**：

1. **Install / Build web**：`pnpm install --frozen-lockfile` → `pnpm build`。
2. **Pre-deploy smoke（部署前强制冒烟，§3.6）**：`npx wrangler versions upload`（只上传版本、**不切生产流量**）→ 从输出解析 `*.workers.dev` 预览 URL → 依次 curl `<预览URL>/api/v1/health` 与 `/api/v1/version`，要求均 **200** 且 health 返回 **`ok:true`**；命令本身失败或预览可达但冒烟不通过，直接 `exit 1` 阻断 Deploy。
   - `wrangler.toml` 显式设置 **`preview_urls = true`**（与 `workers_dev` 相互独立，Cloudflare 官方文档）：版本预览 URL 因此始终可用，冒烟检查的是**本次新构建**。仅当预览 URL 极端不可用时，才退化为对已部署自定义域名 `https://panel.example.com` 做同样检查；连生产都不健康仍 `exit 1` 阻断部署。
   - 复用既有 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`，**不引入新 Secret**。
3. **Guard deploy topology（拓扑闸门，2026-11-07 事故后新增）**：curl `https://panel.example.com/cdn-cgi/trace` 取 `h=` 字段，实测生产入口真正的 Host/源站。若 `h` 命中 `*.workers.dev`，则 `wrangler.toml` 的 `workers_dev` 必须为 `true`，否则 `exit 1`。这一步把「配置与真实拓扑冲突」在**部署前**挡住——部署前冒烟查的是新版本预览，无法发现这类拓扑事故。
4. **Deploy**：`npx wrangler deploy`（此时才切换生产流量）。
5. **Verify production entry（部署后第一道校验）**：curl `https://panel.example.com/api/v1/health` 与 `/api/v1/version`，要求均 **200** 且 `ok:true`；失败时额外打印 health 响应体、`/cdn-cgi/trace`、以及直连 `*.workers.dev` 的响应头，便于一眼区分「Worker 挂了」与「入口/源站断了」。
6. **Verify deployed agent package（部署后一致性校验，§3.7）**：curl **固定自定义域名** `https://panel.example.com/agent/khc-agent-<VERSION>.tar.gz?v=<sha 前 12 位>` 算 sha256，与仓库 `.sha256` 比对，**同时校验 HTTP 200**；任一不符即失败。URL 不从 `deploy.log` 解析 `*.workers.dev`（缓存与入口变化会解析失败或解析到错误目标）。

> **兜底的能力边界**：`preview_urls = true` 已保留对新构建的真机预览，正常路径不会走兜底。只有预览 URL 完全不可用时，自定义域名检查才生效，而它针对的是「当前线上版本」，只能阻断「生产已挂」这类明显故障；此时 CI 日志会明确标注走了兜底，需人工留意。预览 URL 是公开的版本化地址，生产入口仍只有自定义域名。

## 一次性配置（已完成，备查）

1. **GitHub Secrets**（仓库 Settings → Secrets and variables → Actions）
   - `CLOUDFLARE_API_TOKEN`：至少含 `Workers Scripts:Edit`；用到 D1 绑定时建议 `D1:Edit`。
   - `CLOUDFLARE_ACCOUNT_ID`。
2. **Worker Secrets**（Cloudflare Worker 的 Settings → Variables and Secrets，或 `wrangler secret put`）：
   - `ADMIN_PW_HASH` / `SESSION_SECRET` / `MASTER_ENC_KEY`
   - `AGENT_RELEASE_PUBKEY`（首次部署前按 `docs/agent-releases.md` 生成签名包，否则生产安装/升级接口按 #41 返回 503）。
   - `AGENT_RELEASE_MANIFEST` 不再是必填：签名清单随 assets 部署（`apps/web/public/agent/release-manifest.json`，ADR-0011），仅清单缺失时才需该 secret 兜底。
3. D1 迁移按 `docs/engineering/d1-migrations.md` 执行。

## 说明

- Worker Secrets 不会因为 GitHub 部署丢失；只需配置一次。
- 配置唯一来源是 `wrangler.toml`（`ENVIRONMENT=production`）；`wrangler.staging.toml` 已于 2026-11-03 删除，不存在"staging 部署命令"。
- **`workers_dev = true` + `preview_urls = true`（2026-11-07 回滚后的现状）**：`workers.dev` 子域**既是版本预览的载体，也是生产入口的源站**（见事故记录），因此不能关闭。§3.7「关闭 workers.dev 直接访问」在当前拓扑下**不可执行**；要落地必须先给 Worker 挂上真正的 Cloudflare 自定义域名（如 `panel-alt.example.com`），再把第三方边缘的源站改到该域名。`preview_urls` 与 `workers_dev` 相互独立，显式开启保证 CI 部署前冒烟验证的是本次新构建。
- **上线前冒烟已进 CI（§3.6）**：不再依赖人工先 `versions upload` 再合并；deploy job 在 `Deploy` 前强制执行「版本上传 → 预览/兜底 health+version 冒烟 → 失败即阻断」，见上节。`docs/engineering/release.md` §4 保留为本地手动预览的操作手册（现已不能作为上线门禁）。
- CI 内原有的"占位 D1 id 检查"已移除：生产复用现有 D1（ADR-0008）后该检查成为永远通过的死代码。
- 部署前门禁：agent 单测 + typecheck + vitest + build 在 CI 各 job 先行通过；发布一致性 `--diff` 基线取 `github.event.before`（PR 用 `base.sha`），`--repo` 还会逐文件比对包内 Agent 源码与仓库 `agent/`。**CI 与 `./scripts/verify.sh` 不完全等价**：catalog drift 检查、`bash -n` 与安装预检脚本目前只在本地全量校验中执行。
- **部署后包校验走固定自定义域名（§3.7）**：curl `https://panel.example.com/agent/khc-agent-<VERSION>.tar.gz?v=<sha 前 12 位>`（与签名清单同款 cache-buster，避免 CDN 命中旧字节导致 sha256 误判）算 sha256 与仓库包比对，并同时要求 HTTP 200。该校验发生在 `wrangler deploy` 之后，只能事后报警，不能替代部署前冒烟；整站故障的更清晰报错由前一步 `Verify production entry` 负责。

## 事故记录 2026-11-07：`workers_dev = false` 导致整站 404

**现象**：PR #86 合并后部署 run `42267241348`，`Deploy` ✓ 但 `Verify deployed agent package` ✗，报「线上包 sha256 `e3b0c44…` ≠ 本次构建 `baa400e8…`」。`e3b0c44…` 是**空文件**的 sha256——即 curl 拿到的是 404 空体，不是包内容不一致。

**实测**：`https://panel.example.com` 上**所有**路径（`/`、`/api/v1/health`、`/agent/*`）都返回 `404` + `error code: 1042`，整站不可用，而不只是包。

**根因**（完整证据链见 `docs/verification/2026-11-07/incident-workers-dev-as-origin.md`）：

1. `panel.example.com` 的 DNS 不是 Cloudflare Workers 自定义域名，而是 `CNAME → <edge-host> → 203.0.113.16`（第三方边缘，响应头 `server: Edge/1.1.35`）。
2. `curl https://panel.example.com/cdn-cgi/trace` 返回 `h=<worker-name>.<account>.workers.dev`——该边缘**回源的 Host 就是 workers.dev 域名**。
3. 直接请求 `<worker-name>.<account>.workers.dev` 返回**与站点完全一致**的 `404 / error code: 1042`。
4. 因此 `workers_dev = false` 等于把生产入口的源站关掉：边缘回源取不到任何内容。

**处置**：`wrangler.toml` 回滚为 `workers_dev = true`（保留 `preview_urls = true`），重新部署，生产 5 个入口全部恢复 200，线上包 sha256 与仓库一致（`baa400e8…`）。

**为什么原门禁没挡住**：部署前冒烟查的是 `wrangler versions upload` 的预览 URL（版本级入口，不受 `workers_dev` 影响），部署前必然通过；问题只在 `wrangler deploy` 应用 `workers_dev=false` 的瞬间产生。**新增两道门**：部署前「拓扑闸门」用 `/cdn-cgi/trace` 实测源站、与配置交叉校验；部署后「Verify production entry」先判整站健康，再判包一致性。

## 历史备查：2026-10-31 Actions 额度耗尽事件

当时 runner 无法启动，曾临时注释掉 push/PR 触发、用 `./scripts/deploy-local.sh` 本地部署过渡；**2026-11-01 已恢复自动触发**（commit `5b4fba6`）。`deploy-local.sh` 保留作为 CI 不可用时的兜底。

## GitHub Actions cache 清理

仓库使用 `.github/workflows/cache-cleanup.yml` 每天删除创建超过 7 天或 7 天未访问的 Actions cache。手动触发：`gh workflow run cache-cleanup.yml`。
