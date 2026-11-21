# D1 迁移改由 CI 部署 job 执行（提案）

> 状态：草案 ｜ 最后核验：2026-11-18（main `8d5065b`，面板 0.19.0 / Agent 0.6.0） ｜ 关联：`docs/engineering/d1-migrations.md`、ADR-0008、ADR-0016

> **开发须知**：本文是草案，等待主人合并后才能实施。只有一个批次 M1。

## 1. 背景

主人 2026-11-18 决定：数据库迁移以后由 CI 部署 job 执行。0013 已由 #87 临时补跑过一次，那一步写死了文件名，只能处理 0013。

直接把「对每个迁移文件跑 `wrangler d1 execute`」泛化会出问题。`migrations/` 里 0003、0004、0007 至 0012 用的是 `ALTER TABLE ... ADD COLUMN`，重复执行会报错。0013 能重跑，只是因为它用了 `CREATE TABLE IF NOT EXISTS`。所以 CI 必须自己记录哪些迁移已经执行过。

## 2. 方案对比

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A（推荐） | 使用 wrangler 自带的 `d1 migrations apply`，由它在库里维护 `d1_migrations` 表，只执行未记录的文件 | 官方机制，不自己写跟踪逻辑；每个文件只执行一次，不要求幂等 | 生产库没有这张表，首次要补记 0001 至 0013（见 §3） |
| B | 自己写脚本：每个迁移文件头部写「前置检查 SQL」，CI 先检查再执行 | 不依赖 wrangler 的表 | 要自己维护检查逻辑，容易写错 |
| C | 要求以后所有迁移都写成幂等 SQL，CI 每次全量重跑 | 实现最简单 | SQLite 的 `ADD COLUMN` 没有 `IF NOT EXISTS`，做不到 |

## 3. 推荐做法（方案 A）

1. `wrangler.toml` 的 D1 绑定补 `migrations_dir = "migrations"`。CI 渲染 `wrangler.ci.toml` 时随之带上。
2. **首次补记（baseline）**：CI 发现生产库没有 `d1_migrations` 表时，先逐项核对 0001 至 0013 的结果是否已经在库里（核对项见 §4），全部通过后才建表并写入这 13 条记录；有任何一项不满足就停止部署，由主人处理。这一步之后不再执行。
3. 每次部署，在构建之前依次执行：
   1. `wrangler d1 time-travel info` 打印当前恢复书签，写进 CI 日志。D1 自带 30 天按时间点恢复，回滚用它。
   2. `wrangler d1 migrations list` 打印待执行的迁移。
   3. `wrangler d1 migrations apply`，没有待执行的迁移时什么都不做。
   4. 复核：重新查表清单，输出到日志。
4. 迁移步骤失败即阻断部署。
5. 不把数据库导出文件放进 CI artifact。公开仓库的 artifact 可被他人下载，数据库内容里有加密后的凭据，不应外传。

## 4. 迁移编写规则（写进 `d1-migrations.md`）

先迁移、后部署，所以迁移执行完的那一刻，线上跑的仍是旧版 Worker。规则：

- 迁移必须向后兼容旧代码。只做新增表、新增可空列或带默认值的列，不删列、不改列名、不改类型。
- 要删除或改名时分两次发版：先发新代码，停止使用旧列；再发迁移删除旧列。
- 迁移文件不得修改，只能新增，编号递增（现有规则）。
- 每个新迁移要补本地测试：`scripts/d1-migration-local-test.sh` 在「上一版本的库」上执行并校验结果。

baseline 核对项（0001 至 0013 各一条，用 `sqlite_master` 和 `PRAGMA table_info` 查）：

| 迁移 | 核对 |
|---|---|
| 0001 | 表 `nodes`、`app_configs`、`revisions`、`audit` 存在 |
| 0002 | 表 `certificates`、`settings` 存在 |
| 0003 | `nodes.live_endpoint` 列存在 |
| 0004 | `app_configs.last_apply_error` 列存在 |
| 0005 | 无结构变化，只清数据，视为通过 |
| 0006 | 表 `rate_limit` 存在 |
| 0007 | `nodes.rev_epoch` 列存在 |
| 0008 | `nodes.domain` 列存在 |
| 0009 | 表 `ssh_keys` 存在 |
| 0010 | `nodes.access_mode`、`nodes.tunnel_id`、`nodes.allow_insecure` 列和表 `tunnels` 存在 |
| 0011 | `certificates.acme_provider`、`acme_credential_key`、`acme_ca`、`acme_key_type` 列存在 |
| 0012 | `app_configs.summary_json` 列存在 |
| 0013 | 表 `app_manifests` 存在 |

## 5. 范围与不做

做：`wrangler.toml` 和 CI 的迁移步骤；baseline 脚本及测试；`d1-migrations.md`、`release.md` 更新；删掉 #87 写死 0013 的步骤。

不做：不改任何现有迁移文件；不做自动回滚（回滚用 Time Travel，由主人手动执行）；不加删列迁移。

## 6. 批次

| 批次 | 内容 | 改动范围 | 验收 | bump |
|---|---|---|---|---|
| M1 | §3 的全部内容 | `wrangler.toml`、`.github/workflows/ci.yml`、新增 `scripts/d1-baseline.mjs` 及测试、`scripts/d1-migration-local-test.sh`、`docs/engineering/d1-migrations.md`、`docs/engineering/release.md` | 见下 | 否（不改 `apps/` 与 `agent/`） |

M1 验收：

- 本地用临时 D1 验证三种情形：全新库按序执行全部迁移；已有 0001 至 0013 结果但没有 `d1_migrations` 表的库，baseline 后 `migrations apply` 不执行任何文件；缺少某一项核对结果的库，baseline 停止并报出缺哪一项。
- 新增迁移 0014 的演练文件放在测试目录，不放进 `migrations/`，验证 apply 只执行它一次，重跑不再执行。
- `./scripts/verify.sh` 全绿；CI 配置经 YAML 解析校验。
- PR 合并触发第一次生产部署时，日志里必须出现：书签、baseline 通过、待执行迁移数为 0、复核表清单。把日志位置写进 PR 评论。
- 合并前，主人确认最近一次 D1 导出已存在（这是生产库首次被 CI 写入 `d1_migrations` 表）。

## 7. 待拍板

| # | 事项 | 推荐 |
|---|---|---|
| P-1 | 迁移机制：A 使用 wrangler 的 `d1_migrations` 表 | A |
| P-2 | 迁移规则：先迁移后部署，迁移必须向后兼容；破坏性变更分两次发版 | 同意 |
| P-3 | 不把导出文件放 CI artifact，回滚使用 D1 Time Travel | 同意 |
