# AGENTS.md

所有 Agent 开工前必读。本文只写规则和入口，细节放在链接文档里。

## 1. 项目

- 面板是「服务器运维遥控器 + 配置仓库」，不是监控系统：一个月打开约 10 次，平时零流量。
- 架构：Cloudflare Worker（控制面 + D1）+ React 面板 + 节点上的 Python Agent（按需 HTTPS 调用）。
- 不做：心跳/WebSocket、KV/R2/DO/Cron、插件市场、多用户权限、旧数据迁移。
- 唯一开发仓库是 `origin`（`khc8655/khc-server-public`）。旧仓库 `khc8655/khc-server`、`khc8655/wireguard` 只读，不得作为开发依据。

## 2. 必读

1. `docs/README.md`：现行文档索引，每类信息只有一个权威来源
2. `docs/design-v3.md`：冻结核心、适配器、连接与数据模型
3. `docs/engineering/release.md`：版本规则、发版、回滚
4. `docs/engineering/testing.md`：测试分层与发版类型必测项
5. UI 改动：`docs/ui-redesign/ui-guidelines.md` + `docs/ui-redesign/page-specs.md`，取值只来自 `apps/web/src/styles/tokens.css`

## 3. 红线（违反即退回）

1. **方案门禁**：架构、契约、数据模型、UI、流程的改动，必须先有规划者提案并经主人拍板（§4）。小 bug 可直接修，在 PR 里说明。
2. **核心冻结**：Worker 路由、`packages/contracts`、D1 核心表、`agent/khc/` 的改动必须在 PR 里说明必要性。应用相关知识只能放在适配器和应用页面（§6）。
3. **UI 规范**：先归类到六类页面类型，复用既有组件与范式，不新增色板、字号、导航层级、第二种详情入口，抽屉内不弹 Dialog。
4. **安全**：不提交凭据；错误响应和日志不回显凭据；写盘走白名单并防符号链接逃逸；私钥 0600；Agent 只允许拉取式升级。
5. **生产**：合并 main 就是生产部署。不在 Cloudflare 侧挂 Git 集成，`workers_dev` 保持 `true`（`release.md` §1）。
6. **测试**：提交前 `./scripts/verify.sh` 全绿；修 bug 先补会失败的测试；UI 改动附浅色、深色、390 宽截图和四态说明。
7. **版本**：面板与 Agent 的 bump 规则见 `release.md` §2，由脚本强制。
8. **文档**：遵守 §5；改了行为、接口、配置或流程，同一个 PR 更新对应的权威文档。
9. **交接**：工作区干净再交接，不留未提交改动；已合入 main 的分支不再继续开发。

## 4. 协作流程

| 角色 | 职责 |
|---|---|
| 主人 | 拍板提案、派发批次、合并 PR |
| 规划者 | 写提案、拆批次、定验收标准；在执行 PR 中验收；维护 `docs/plans/backlog.md` 与文档规范 |
| 执行者 | 按提案的一个批次开一个 PR：写代码、测试、发版；不修改提案文件 |

1. 规划者开提案 PR：`docs/plans/<主题>-<YYYY-MM-DD>.md`，标题以 `plan:` 开头，≤ 300 行。内容包括背景、方案对比与推荐、范围与不做、批次（每批写明改动范围、验收标准、必测项、是否 bump）、待拍板项。
2. 主人拍板后合并提案，状态改为「已拍板」。
3. 执行者从最新 main 拉分支（`feat/`、`fix/`、`docs/`、`chore/`），一个批次一个 PR，按 PR 模板填写关联提案、偏离提案之处和证据。发现提案有误时在 PR 里提出，由规划者修改提案。
4. 规划者审核 diff 和证据，在 PR 里给出「通过」或「退回 + 原因」，主人合并。
5. 全部批次合入后，规划者把提案移入 `docs/archive/plans/`，未完成项转入 backlog。

不经过提案的小修复也走 PR，规划者照样验收。

## 5. 文档规则

| 位置 | 类别 | 规则 |
|---|---|---|
| `docs/`（除下面三个目录）、`agent/**/README.md` | 现行 | 必须登记在 `docs/README.md`；只写现在是什么、怎么做 |
| `docs/plans/` | 提案与 backlog | 不登记索引；实施完成或被否决后移入 `docs/archive/plans/` |
| `docs/verification/<日期>/` | 证据 | 写完不再修改；不登记索引；不能作为规范依据 |
| `docs/archive/` | 历史 | `git mv` 移入即归档；不能作为开发依据 |

- **不写历史**：现行文档不记录「怎么走到这里」。演变过程留在 git log、PR、ADR；被取代的内容整段移入 `docs/archive/`。
- **一件事只写一处**，其他文档放链接。易变事实（版本号、迁移编号、secret 名、测试数量）以代码和配置为准，文档只写文件路径。
- **状态块**：标题下一行，≤ 200 字符，格式为 `> 状态：现行 ｜ 最后核验：YYYY-MM-DD ｜ 关联：最多 3 项`。「最后核验」后只写日期。提案的状态写「草案 / 已拍板 / 已实施」。
- **体积上限**：本文件 ≤ 100 行；`docs/README.md` ≤ 80 行；`CHANGELOG.md` ≤ 400 行；其他现行文档 ≤ 400 行（例外列在 `scripts/docs-lint.mjs` 里并注明原因）。CHANGELOG 超限时把最旧的版本段整段移到 `docs/archive/changelog/`。
- **CHANGELOG 格式**见 `CONTRIBUTING.md`：每条一行，只写用户能感知的变化，细节写在 PR 里。
- **决策**：新的重大决策写 ADR（`docs/engineering/adr/`）。ADR 不归档，只改状态。
- `node scripts/docs-lint.mjs` 检查以上规则，已接入 `verify.sh`。

## 6. 核心冻结与扩展点

- 新增应用：`agent/adapters/<app>.py` + `agent/tests/test_<app>.py` + `apps/web/src/apps/<app>/page.tsx`。`git diff --stat` 不应出现 `apps/api/`、`migrations/`、`packages/contracts/`、`agent/khc/`。
- 新增 API 或表：先改 `packages/contracts`，再改路由、仓库与测试；迁移只新增 `migrations/000N_*.sql`，不改已应用的迁移；同步更新 `docs/design-v3.md`。
- 新增页面：归类页面类型并登记 `page-specs.md`；路由与动作登记到 `registry/routes.ts`、`registry/actions.ts`。
- 编排层例外：`apps/api/src/lib/mode.ts`、`apps/api/src/lib/node-summary.ts` 可以引用应用名，只做纯派生（不连节点、不写库、不读 secrets）；路由里不得出现 `app === '<应用名>'` 判断。
- `agent/khc/` 不引用具体应用名；`apps/api/src/lib/diagnostics/` 只保留 7 个核心码，应用问题由适配器 `status().problems` 上报。

## 7. 常用命令

```bash
./scripts/verify.sh                 # 本地全量门禁（CI 是其子集）
pnpm dev:api                        # Worker http://127.0.0.1:8787
pnpm dev:web                        # 前端 http://127.0.0.1:5173
python3 -m unittest discover -s agent/tests -t agent
node scripts/docs-lint.mjs          # 文档规则检查
```

## 8. 高频坑

- Cloudflare `fetch()` 访问裸 IP 一律 403 error 1003，IP 直连必须走 `cloudflare:sockets`（`apps/api/src/lib/tcp-fetch.ts`）。
- Cloudflare 代理端口：HTTP 80/8080/8880/2052/2082/2086/2095，HTTPS 443/8443/2053/2083/2087/2096。
- HMAC 签名串 `METHOD|path|ts|nonce|sha256hex(body)`：path 不含 query，GET 的 body hash 用空串。
- 不要用 `pkill -f <含自身命令行的串>`，会杀掉 SSH 会话；按 PID 处理。
- macOS `/tmp` 会被清理，SSH 的 askpass、known_hosts 不要长期放在那里。
- 测试和脚本不依赖 root、不联网（外部 API 用注入的 mock）。
