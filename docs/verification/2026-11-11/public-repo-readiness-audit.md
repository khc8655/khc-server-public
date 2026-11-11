# Public 仓库开放前隐私与凭据审计（2026-11-11）

> 状态：现行（一次性只读审计记录） ｜ 适用范围：`khc-server` 当前工作树 + 全部 git 历史（423 commits / 96 个分支引用 / 45 个 tag），以及 GitHub 仓库侧配置与 Actions 记录 ｜ 最后核验：2026-11-11 ｜ 关联：`AGENTS.md` §3 红线 4/9、`docs/verification/2026-11-10/preprod-test-report.md`（F-09 的后续决策）、`docs/engineering/release.md`、`docs/security-boundaries.md`

**归类**：工程流程 — 验证记录（安全审计）。
**脱敏**：本报告不复述任何完整凭据、真实 IP、真实域名或资源 ID，统一用 `****` 与占位符；需要定位时只给文件路径。

---

## 0. 结论

**当前状态直接开放：不安全。**

| 判定 | 说明 |
|---|---|
| 是否存在必须轮换的已泄露凭据 | **是，1 项**：已提交截图内有一枚可在图中直接读取的 WireGuard Peer 私钥（F-02）。 |
| 是否可以在处理后开放 | **可以**。除此之外未在历史中发现 Cloudflare Token、会话密钥、管理员口令、Tunnel Token、Agent 发布签名私钥。 |
| 最大的非凭据风险 | 真实基础设施清单（公网 IP / 域名 / Worker 与 D1 标识 / SSH 用户名与密钥路径）分散在 20+ 个受版本控制的文档、测试和截图中；一旦公开且被 fork 即不可撤回。 |
| 最短路径 | **不要**把当前 423 提交 / 96 分支 / 45 tag 的历史直接推成 public。新建一个干净的 public 仓库、只推一次脱敏后的初始提交；旧私库保留为历史归档。 |

---

## 1. 审计范围与方法

- **范围**：当前工作树全部 tracked 文件；`git rev-list --all` 覆盖的 423 个提交、96 个本地/远程分支引用、45 个 tag；`git cat-file --batch-all-objects` 覆盖的全部 blob（含不可达对象）。
- **方法**：
  1. 自写只读扫描器遍历全部 blob，正则覆盖 PEM/OpenSSH 私钥、Cloudflare Token、GitHub Token、OpenAI key、AWS key、Slack token、JWT、Tunnel token（`eyJhIjoi…`）、WireGuard 私钥、`Authorization: Bearer`、password/secret 赋值、IPv4/IPv6、域名、UUID。
  2. `git grep` 跨全部提交定位真实地址、密钥路径、节点 ID、安装令牌。
  3. 人工抽查 8 张高风险截图（安装令牌、Peer 导出、节点详情、Cloudflare 设置）。
  4. `gh` 只读检查仓库可见性、secret 名称、工作流定义与最近一次 deploy 日志。
- **未执行**：未调用生产接口；未修改代码、git 历史、仓库设置；未做任何轮换；未 push。

---

## 2. 风险分级总表

| 编号 | 级别 | 主题 | 位置 | 结论 |
|---|---|---|---|---|
| F-01 | **阻断公开** | 运维记忆目录被提交，含完整攻击面 | `.workbuddy/memory/*.md`（main 仍跟踪） | 必须移除并清理历史 |
| F-02 | **阻断公开** | 截图含真实 WireGuard Peer 私钥 | `docs/archive/.../20-peer-export.png` | 凭据已泄露，必须轮换 |
| F-03 | **阻断公开** | 真实基础设施清单散落文档/测试 | 21 个受控文件 | 必须脱敏 + 清历史 |
| F-04 | 必须处理 | 截图含 2 个一次性 Agent 安装令牌 | 2 张截图 | 确认节点已删除或删除节点 |
| F-05 | 必须处理 | 未跟踪高敏文件 + `.gitignore` 缺口 | 根目录报告、`.screenshots/`、`backups/` | 开放前加 ignore / 移出工作区 |
| F-06 | 必须处理 | `wrangler.toml` 暴露 D1 / Worker / 域名 | `wrangler.toml` | 占位化或接受（非凭据） |
| F-07 | 必须处理 | 归档文档含 SSH 用户名、端口、私钥路径 | `docs/archive/.../setup-notes.md` 等 | 脱敏 + 清历史 |
| F-08 | 必须处理 | 验证报告含生产节点名 / IP / 入口域名 | `docs/verification/**`、`docs/plan-v4.md` | 脱敏 |
| F-09 | 建议处理 | 测试夹具内置真实 IP | `apps/api/test/*.test.ts` | 改为文档保留段 |
| F-10 | 建议处理 | 历史 Actions 日志将对公众可见 | GitHub Actions | 开放前删除旧 run |
| F-11 | 建议处理 | public 后仓库设置与供应链 | GitHub 设置、workflow | 按 §6 加固 |
| F-12 | 建议处理 | 代码/脚本默认值指向生产入口 | `app.ts`、`scripts/*.mjs`、`ci.yml` | 改占位符 / 变量 |
| F-13 | 建议处理 | 截图含 SSH 公钥与管理员用户名 | 多张 UI 截图 | 打码或接受 |
| F-14 | 可接受 | 假密钥夹具、示例域名、文档保留段 IP、公钥与哈希 | 测试与发布清单 | 无需处理 |

---

## 3. 详细发现

### F-01【阻断公开】`.workbuddy/memory` 运维记忆被提交

- **位置**：[2026-11-05.md](.workbuddy/memory/2026-11-05.md)、[2026-11-06.md](.workbuddy/memory/2026-11-06.md)、[2026-11-07.md](.workbuddy/memory/2026-11-07.md)；main 仍跟踪，历史中共 9 个提交；远程分支 `chore/untrack-workbuddy` 尚未合并。
- **内容类型**：真实公网 IPv4/IPv6、SSH 用户名与私钥文件名、Agent 发布签名私钥路径、节点 ID、机器 hostname、面板与 Worker 地址、D1 操作细节、测试机登录方式。
- **暴露后的实际风险**：这是一份按时间整理的"生产环境说明书"——攻击者可直接得到入口、节点、账号名、端口、密钥文件名与变更时间线；IPv6 地址还绕开了常见的按 IPv4 封禁策略。即使没有口令，也足以支撑定向探测、撞库与社工。
- **修复动作**：从工作树移除（`git rm -r --cached .workbuddy` 只是开始），并清理全部历史/分支；`.gitignore` 增加 `.workbuddy/`。**仅删除当前文件无效。**

### F-02【阻断公开】截图内含真实 WireGuard Peer 私钥

- **位置**：`docs/archive/audit-2026-11-02/flow-walkthrough/2026-11-02/20-peer-export.png`（历史中 2 个提交；该图已于 2026-11-11 从公开树移除）。
- **内容类型**：`[Interface] PrivateKey = ****`（44 字符 base64，图中可直接抄录）、Peer 公钥、Endpoint、节点名。
- **暴露后的实际风险**：拿到该私钥即可完整还原 Peer 配置并接入对应 WireGuard 网络；若该 Peer 或其所属接口仍在任何环境存活，等于网络准入凭据泄露。即便来自已拆除的测试 Hub，也必须按"已泄露"处理。
- **修复动作**：立即确认 `wt-hub` / `wt-peer-arm1` 是否已彻底删除；若任何环境仍在使用该私钥，**先轮换该 Peer 再谈公开**；然后删除截图并清理历史。删除文件/重写历史都不能让已泄露的私钥恢复安全。

### F-03【阻断公开】真实基础设施清单散落在文档与测试

- **位置**（受版本控制）：
  - 运维记忆：`.workbuddy/memory/2026-11-06.md`、`2026-11-07.md`
  - 根文档：[CHANGELOG.md](CHANGELOG.md)、[TODO-2026-11-06.md](docs/TODO-2026-11-06.md)、[agent-lifecycle.md](docs/agent-lifecycle.md)、[auto-deploy.md](docs/auto-deploy.md)、[live-observation.md](docs/live-observation.md)、[plan-v4.md](docs/plan-v4.md)、[node-onboarding.md](docs/runbook/node-onboarding.md)、[release.md](docs/engineering/release.md)
  - 归档：[setup-notes.md](docs/archive/audit-2026-11-02/server-test/2026-11-02/setup-notes.md)、[report.md](docs/archive/audit-2026-11-02/server-test/2026-11-02/report.md)、[test-plan.md](docs/archive/audit-2026-11-02/server-test/2026-11-02/test-plan.md)、[walkthrough.md](docs/archive/audit-2026-11-02/flow-walkthrough/2026-11-02/walkthrough.md)、`docs/archive/2026-11/c1-acceptance.md`
  - 验证记录：[2026-11-03/report.md](docs/verification/2026-11-03/report.md)、[2026-11-04/snapshot-stability.md](docs/verification/2026-11-04/snapshot-stability.md)、[2026-11-07/incident-workers-dev-as-origin.md](docs/verification/2026-11-07/incident-workers-dev-as-origin.md)、[2026-11-07/p0-closeout.md](docs/verification/2026-11-07/p0-closeout.md)
  - 测试与脚本：`apps/api/test/{cfDns,node-client,nodes,tcp-fetch,tunnels}.test.ts`、[p0-verify-20261107.py](scripts/p0-verify-20261107.py)、[uptime-check.mjs](scripts/uptime-check.mjs)、[live-sse-check.mjs](scripts/live-sse-check.mjs)
  - 索引本身：[docs/README.md](docs/README.md#L72) 第 72 行也写了真实面板入口。
- **内容类型**：8 个公网 IPv4（其中包含生产节点 `node-prod-1` 的地址）、1 个真实 IPv6、面板域名 `a.****.<tld>`、Worker 子域 `khc-*****.*******.workers.dev`、节点域名 `khc*.*****.<tld>`、`oc.******.<tld>`、Cloudflare 边缘 IP、D1 库名/ID、Worker 名、节点名与 hostname、SSH 用户名与端口。
- **暴露后的实际风险**：公开代码本来就会暴露"系统怎么工作"，但这份清单额外暴露了"你的系统在哪、叫什么、怎么登录"。生产节点 IP 一旦公开，攻击者可绕过 CDN 直接打源站；D1/Worker 标识便于精确社工 Cloudflare 账号；节点名与 hostname 可用于在泄露数据中做关联。
- **修复动作**：统一替换为占位符（`<panel-domain>`、`<node-ip>`、`<d1-id>`）；`wrangler.toml` 的 `database_id` 改为占位或 CI 注入；测试改用文档保留段（`198.51.100.0/24`、`203.0.113.0/24`）。随后按 §7 处理历史。**只改当前文件无效。**

### F-04【必须处理】提交的截图包含 2 个一次性 Agent 安装令牌

- **位置**：`docs/archive/audit-2026-11-02/flow-walkthrough/2026-11-02/03-node-token-install-cmd.png`、`docs/archive/ui-redesign/audit-2026-11-03/06-add-node-token.png`（两图已于 2026-11-11 从公开树移除）。
- **内容类型**：完整安装命令 + `?token=****`，令牌在图中可直接抄录；同时含节点地址/域名。
- **暴露后的实际风险**：令牌为一次性、绑定特定节点（`wt-hub`、`audit-test-node`）。若对应节点仍存在于 D1，攻击者可用该命令重新注册/接管 Agent，进而触达该主机。若节点已删除，令牌即失效。
- **修复动作**：主人登录面板确认这两个节点不存在；若存在，删除节点（令牌随之失效）并核查该节点历史操作。截图删除 + 清历史。**不属于"轮换"，但必须确认失效。**

### F-05【必须处理】未跟踪高敏文件与 `.gitignore` 缺口

- **位置**：根目录 `e2e-acceptance-report-2026-11-08.md`、`ux-interaction-audit-2026-11-08.md`、`.screenshots/`、`backups/*.sql`、`.dev.vars`、`.workbuddy/`。
- **现状**：两份根目录报告与 `.screenshots/` **没有被 `.gitignore` 覆盖**（`git check-ignore` 未命中），一次 `git add -A` 就会提交；两份报告含真实 IP、域名、节点 ID、SSRF/探测细节。`backups/` 与 `.dev.vars` 已被忽略；`backups/` 内含 D1 导出（含用户口令哈希）。
- **暴露后的实际风险**：误提交即把上述内容永久公开；D1 导出还会泄露口令哈希与全部配置。
- **修复动作**：开放前把 `.workbuddy/`、`.screenshots/`、根目录 `*-audit-*.md` / `e2e-acceptance-report-*.md` 加入 `.gitignore`；把本地报告与备份移出仓库目录；确认 `git status` 干净后再开放。

### F-06【必须处理】`wrangler.toml` 暴露 D1 / Worker / 域名

- **位置**：[wrangler.toml](wrangler.toml)。
- **内容类型**：Worker `name`、D1 `database_name` / `database_id`（`39dc****-****-****-****-**********`）、`LIVE_ORIGINS`、生产入口域名。
- **暴露后的实际风险**：这些不是凭据，不能单独用于访问资源；但会精确暴露部署拓扑与账号内资源命名。D1 ID 还可能与公开的 Worker 版本信息关联。
- **修复动作**：`database_id` 与 `name` 改为占位符，部署时由 CI 变量注入；或明确接受。**注意：即便接受，仍需处理 F-03 中的其他真实地址。**

### F-07【必须处理】归档文档中的 SSH 用户名、端口与私钥路径

- **位置**：[setup-notes.md](docs/archive/audit-2026-11-02/server-test/2026-11-02/setup-notes.md)、[test-plan.md](docs/archive/audit-2026-11-02/server-test/2026-11-02/test-plan.md)。
- **内容类型**：`ssh -i <私钥路径> <user>@<ip> -p <port>`、密钥文件名（如云厂商默认密钥文件名）、本机密钥路径。
- **暴露后的实际风险**：私钥本体未泄露，但登录方式、用户名、端口、密钥文件名完整暴露；对本机被入侵的场景，等于把"去哪儿找钥匙"也告诉了对方。
- **修复动作**：脱敏为 `<ssh-key>` / `<user>@<host>:<port>`；清历史。

### F-08【必须处理】验证报告含生产节点信息

- **位置**：`docs/verification/2026-11-03/report.md`、`docs/verification/2026-11-04/snapshot-stability.md`、`docs/verification/2026-11-07/p0-closeout.md`、`docs/verification/2026-11-07/incident-workers-dev-as-origin.md`、`docs/plan-v4.md`。
- **内容类型**：生产节点名 `node-prod-1`、节点 ID（`nd_****`）、公网 IP、面板入口、Worker 子域。
- **暴露后的实际风险**：等于公开生产入口与节点清单；`incident-workers-dev-as-origin.md` 还把"回源 Host 就是 workers.dev"这一拓扑讲得很清楚，便于定向探测。
- **修复动作**：全部占位化，保留结论与证据链，删除可定位信息。可参照 `docs/verification/2026-11-10/preprod-test-report.md` 已有的脱敏写法。

### F-09【建议处理】测试夹具内置真实 IP

- **位置**：`apps/api/test/cfDns.test.ts`、`node-client.test.ts`、`nodes.test.ts`、`tcp-fetch.test.ts`、`tunnels.test.ts`。
- **风险**：把真实地址固化进测试；单独看风险低，但可与 F-03 的信息交叉验证，且历史不可改。
- **修复动作**：改为文档保留段 IP；后续测试禁止使用真实地址。

### F-10【建议处理】历史 Actions 日志将对公众可见

- **位置**：GitHub Actions 历史 run（私有期间产生）。
- **现状**：`ci.yml` 的 deploy job 会打印健康检查、版本上传与生产入口校验结果；抽查最近一次 deploy run，`CLOUDFLARE_API_TOKEN` 已被 GitHub 掩码为 `***`，未发现密钥明文。
- **风险**：公开后旧日志对所有人可见，暴露域名、部署时间线与运维细节；目前未发现凭据值，但不能排除更早日志。
- **修复动作**：开放前删除历史 workflow runs，或把日志保留期调到最短并等待过期；后续 workflow 禁止 `set -x`、禁止 `echo` secrets。

### F-11【建议处理】public 后的仓库设置与供应链

- **现状（已核对）**：`ci.yml` 使用 `push: [main]` / `pull_request` / `workflow_dispatch`；`deploy` 只在 `push main` 与手动触发时运行且需要 secrets；`agent` / `verify` job 不使用 secrets；无 `pull_request_target`、无 `workflow_run` 提权链；`cache-cleanup.yml` 权限最小（`actions: write` + `contents: read`）。
- **public 后风险**：fork PR 会在 GitHub 托管 runner 上执行仓库脚本（拿不到 secrets，`GITHUB_TOKEN` 默认为只读），但可滥用 CI 资源与缓存；workflow 里的 `actions/checkout@v4` 等按 tag 引用，存在上游被篡改的供应链风险。
- **建议**：开启 secret scanning + push protection、Dependabot alerts；仓库默认 workflow 权限设为只读；fork PR 要求维护者批准；第三方 action 固定到 commit SHA；main 分支保护；关闭"Allow GitHub Actions to create and approve pull requests"。

### F-12【建议处理】代码与脚本默认值指向生产入口

- **位置**：[app.ts](apps/api/src/app.ts#L68)、[types.ts](apps/api/src/types.ts#L45)、`scripts/uptime-check.mjs`、`scripts/live-sse-check.mjs`、[ci.yml](.github/workflows/ci.yml)。
- **内容类型**：注释/示例中的 `https://a.****.<tld>`、`LIVE_ORIGINS` 示例、运维脚本默认 base URL。
- **风险**：公开即公布面板入口；脚本默认值会引导攻击者直接探测。
- **修复动作**：示例统一改 `<panel-domain>`；CI 改用 repository variable；脚本默认值不指向真实域名。

### F-13【建议处理】截图中的 SSH 公钥与管理员用户名

- **位置**：`docs/archive/audit-2026-11-02/flow-walkthrough/2026-11-02/24-peer-ops-onboarded.png`（含 SSH 公钥与用户名；该图已于 2026-11-11 移除）、多张 UI 截图（`admin`）。
- **风险**：公钥可用于识别主机/检测复用；管理员用户名降低撞库成本。
- **修复动作**：统一打码；若接受公钥公开，至少应删除用户名与主机组合。

### F-14【可接受】无需处理的占位内容

- 测试夹具中的 `-----BEGIN … PRIVATE KEY-----` 均为 `FAKEKEY` 拼接的假体（无真实密钥材料）。
- `example.com`、`203.0.113.x`、`198.51.100.x`、sha256、WireGuard 公钥、`release-manifest.json` 的公钥与签名、D1 导出的空文件哈希，均为公开或不可用材料。
- 结论：无需处理。

---

## 4. 已泄露凭据与轮换对象

| 对象 | 证据 | 是否必须轮换 | 影响面 / 备注 |
|---|---|---|---|
| WireGuard Peer 私钥 | F-02 截图（可读 base64） | **是（若该接口/Peer 仍存在）** | 持钥者可接入对应 WG 网络；轮换后需重新分发该 Peer 配置。**仅删文件/重写历史无效。** |
| 一次性 Agent 安装令牌 ×2 | F-04 截图 | 否（一次性），但必须确认失效 | 若对应节点仍存在，可重装/接管 Agent；删除节点即失效。 |
| Cloudflare API Token | 全历史未检出 | 否 | 仅存在于 GitHub Secrets。 |
| Cloudflare Account ID（secret） | 全历史未检出 | 否 | `wrangler.toml` 只有 D1 ID，不是凭据。 |
| `SESSION_SECRET` / `MASTER_ENC_KEY` / 管理员口令 | 全历史未检出；`.workbuddy` 明确记录"口令不记入日志" | 否 | `.dev.vars` 从未入库。 |
| Agent 发布签名私钥 | 全历史未检出 | 否 | 文档/脚本只出现路径与文件名；建议同时确认该路径不在仓库内。 |
| Tunnel Token | 全历史未检出 | 否 | 无 `eyJhIjoi…` 命中。 |

**明确结论**：本仓库历史上没有提交过 Cloudflare Token、会话密钥、管理员口令或发布签名私钥；唯一必须按"已泄露"处理的是 F-02 的 WireGuard Peer 私钥。若主人无法确认该 Peer 已随测试 Hub 删除，应按已泄露立即轮换。

---

## 5. GitHub 侧核对结果

- 仓库当前 **visibility = PRIVATE**；默认分支 `main`。
- 仓库级 secrets 仅有 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`（名称可见，值不可读）。
- 工作流触发与 secrets 使用符合最小暴露：PR 触发的 job 不引用 secrets；deploy 只在 main/dispatch 运行。
- 未发现 `pull_request_target`、`workflow_run` 提权链或把 secrets 传给 fork PR 的写法。
- **结论**：fork PR 拿不到 secrets；public 后的主要新增风险是"历史日志可见"与"仓库设置未加固"，不是 workflow 本身。

---

## 6. 开放前必须完成的动作清单（按顺序）

| # | 动作 | 执行人 | 说明 |
|---|---|---|---|
| 1 | 确认/轮换 F-02 的 WireGuard Peer 私钥 | **主人** | 若 `wt-hub`/`wt-peer-arm1` 已不存在则记录"随测试环境销毁"；否则先轮换。 |
| 2 | 登录面板确认 F-04 两个一次性令牌对应节点不存在 | **主人** | `wt-hub`、`audit-test-node`；存在则删除节点。 |
| 3 | 选定历史策略：新建干净 public 仓库（推荐）或重写当前历史 | **主人** | 见 §7；历史重写只出方案，未执行。 |
| 4 | 脱敏工作树：删除/占位 F-01、F-03、F-06、F-07、F-08、F-12、F-13 的内容 | 开发 | 参照 `docs/verification/2026-11-10/preprod-test-report.md` 的占位写法。 |
| 5 | 更新 `.gitignore`：`.workbuddy/`、`.screenshots/`、根目录审计报告、`backups/`、`.dev.vars` | 开发 | 防止误提交。 |
| 6 | 本地/临时环境跑 gitleaks 或 trufflehog + 自写 IP/域名扫描，要求 0 命中 | 开发 | 不写入仓库；可 `npx`/临时 venv。 |
| 7 | 删除旧 Actions runs 或把日志保留期调到最短 | **主人** | 公开后旧日志即可见。 |
| 8 | 创建 public 仓库并首次 push（只推干净快照） | **主人** | 首次 push 前不做任何公开。 |
| 9 | 开启 secret scanning + push protection、Dependabot、workflow 只读默认、fork PR 需批准、main 分支保护 | **主人** | 见 F-11。 |
| 10 | 开放后复跑一次 `./scripts/verify.sh` 与一次完整扫描 | 开发 | 确认无回归。 |

---

## 7. 历史处理方案（仅方案，不执行）

### 方案 A（推荐）：新建 public 仓库，只推一次干净提交

1. 从当前 `main` 导出一份脱敏快照（不含 `.workbuddy/`、`.screenshots/`、根目录审计报告、`backups/`、`.dev.vars`；docs 已占位化；`wrangler.toml` 已占位）。
2. 在新目录 `git init`，创建 1 个初始提交（可按需要拆成 3–5 个逻辑提交）。
3. 新建 public 仓库并 push；旧私库保持 private，作为历史/tag/事故记录归档。
4. **优点**：彻底、简单、无旧对象残留；**缺点**：丢弃 423 提交的历史。

### 方案 B：重写当前仓库历史后再公开

1. `git filter-repo --invert-paths --path .workbuddy --path .screenshots --path <敏感截图>`。
2. `--replace-text` 把真实 IP/域名/D1 ID/节点 ID 替换为占位符（需先生成替换规则并人工复核）。
3. 删除或重建全部 45 个 tag、合并/删除 95 个非 main 分支引用。
4. `git reflog expire --expire=now --all && git gc --prune=now --aggressive`。
5. force push `main`，删除远程分支与旧 tag。
6. **残余风险**：GitHub 可能仍可通过已知 SHA 访问旧对象，需要联系 GitHub Support 清理缓存；已存在的 PR/fork ref 也要单独处理；423 个提交中遗漏一处即前功尽弃。

### 方案 C：squash 成少量提交（折中）

保留可读的阶段性历史（如 5–10 个提交），但仍需先完成全部脱敏；适合既想保留一点历史、又不想承担全量重写风险的情况。

**建议**：选 A。本项目的价值在代码与文档现状，不在公开的 423 条提交历史；旧私库继续保留即可。

---

## 8. 审计局限

- 截图仅人工抽查 8 张高风险图，未做全量 OCR；未逐字节解包所有二进制产物（agent 发布包已抽查，内容干净）。
- 未读取生产 D1/接口，无法确认一次性令牌与 WireGuard Peer 的当前有效性；该结论需主人执行 §6 第 1–2 步。
- Actions 日志仅抽查最近一次 deploy run，未逐条下载全部历史日志。
- 正则扫描不能证明"绝对没有"；开放前应以 gitleaks/trufflehog 再做一次独立复核。

---

## 9. 与既有结论的关系

`docs/verification/2026-11-10/preprod-test-report.md` 的 F-09 结论是"全历史无私钥/Token，`.workbuddy` 交主人决策"，其范围为文本 grep，**不覆盖**：截图内的 WireGuard 私钥、截图内的一次性安装令牌、真实基础设施清单，以及 public 后的仓库设置风险。本报告是对该结论在"转 public"场景下的补充与升级。
