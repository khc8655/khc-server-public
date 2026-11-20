# D1 迁移 runbook

> 状态：现行 ｜ 最后核验：2026-11-20 ｜ 关联：`docs/engineering/release.md`、ADR-0008
> 范围：`migrations/` 到任意环境的执行顺序、命令与核对

## 原则

- 迁移**只增不改**：新变更一律新增 `migrations/000N_*.sql`（当前目录见 `migrations/`），不得修改已应用的文件。
- 生产与"staging"是同一个 D1（`<d1-name>`，见 ADR-0008）——**对 remote 执行迁移就是直接改生产库**，由 CI `deploy` job 自动记录 Time Travel 书签后再执行迁移。
- 全量迁移使用 `wrangler d1 migrations apply DB`（读取 `wrangler.toml` 的 `migrations_dir = "migrations"`）；存量环境先由 `scripts/d1-baseline.mjs` 校验 0001–0013 并登记 `d1_migrations`（已有则跳过）。

## 迁移清单（0001–0013 基线）

| # | 文件 | 内容 | 备注 |
|---|---|---|---|
| 0001 | `0001_init.sql` | 核心四表：`nodes` / `app_configs` / `revisions` / `audit` | 全新建库时执行 |
| 0002 | `0002_c3.sql` | C3 扩展：`certificates`、`settings` 两表 | 全局证书库 + 全局设置（DNS 凭据等） |
| 0003 | `0003_live_endpoint.sql` | `nodes` 加 `live_endpoint` 列 | 6.4a 观测层入口 |
| 0004 | `0004_last_apply_error.sql` | `app_configs` 加 `last_apply_error` 列 | apply 失败摘要（JSON） |
| 0005 | `0005_clear_runtime_state.sql` | 清空 `nodes.last_state_json` 历史数据 | 数据分层：运行快照不再落库；列保留为空 |
| 0006 | `0006_rate_limit.sql` | 新增 `rate_limit` 表 | 登录限流 D1 计数 |
| 0007 | `0007_rev_epoch.sql` | `nodes` 加 `rev_epoch` 列 | 配置版本 epoch（D-2/T2.2） |
| 0008 | `0008_node_domain.sql` | `nodes` 加 `domain` 列 | CF DNS 代建记录后写入节点域名 |
| 0009 | `0009_ssh_keys.sql` | 新增 `ssh_keys` 表 | 全局 SSH 公钥库（只存公钥） |
| 0010 | `0010_node_access.sql` | `nodes` 加 `access_mode` / `tunnel_id` / `allow_insecure` 列；新增 `tunnels` 表 | 全局接入配置（域名/Tunnel/IP 直连）与隧道配置（Token 密文） |
| 0011 | `0011_cert_acme_meta.sql` | `certificates` 加 `acme_provider` / `acme_credential_key` / `acme_ca` / `acme_key_type` 列 | 证书一键续期的 ACME 元数据 |
| 0012 | `0012_app_configs_summary.sql` | `app_configs` 加可空 `summary_json` 列 | 明文摘要（只含模式与计数）供 `GET /nodes` 零解密派生 |
| 0013 | `0013_app_manifests.sql` | 新增 `app_manifests` 表 | 全局应用清单（脚本正文 + 元数据，只存配置） |

## 执行命令

### 本地开发（wrangler 本地 D1）

```bash
node scripts/d1-baseline.mjs --local
npx wrangler d1 migrations list DB --local
npx wrangler d1 migrations apply DB --local
```

全新本地库时 `d1-baseline.mjs` 为 no-op，`migrations apply` 自动从 `0001` 按序执行全部文件；已有存量库先校验 0001–0013 结构并初始化 `d1_migrations`。

### CI 与远程（= 生产，见 ADR-0008）

合入 `main` 后由 `.github/workflows/ci.yml` 的 `deploy` job 在构建部署前自动按序执行：

```bash
npx wrangler d1 time-travel info DB --config wrangler.ci.toml
node scripts/d1-baseline.mjs --config wrangler.ci.toml --remote
npx wrangler d1 migrations list DB --config wrangler.ci.toml --remote
npx wrangler d1 migrations apply DB --config wrangler.ci.toml --remote
```

如本机应急执行，把 `--config` 换为 `wrangler.local.toml` 即可。

## 核对

CI 与手工执行后统一核对表、关键列与待执行列表：

```bash
npx wrangler d1 migrations list DB --config wrangler.ci.toml --remote
npx wrangler d1 execute DB --config wrangler.ci.toml --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
npx wrangler d1 execute DB --config wrangler.ci.toml --remote --command "PRAGMA table_info(nodes)"
npx wrangler d1 execute DB --config wrangler.ci.toml --remote --command "PRAGMA table_info(app_configs)"
```

`0012` 回填后可检查未回填行数（全为 0 即完成）：

```bash
npx wrangler d1 execute DB --remote --command "SELECT COUNT(*) AS missing FROM app_configs WHERE summary_json IS NULL"
```

本地回归门禁：`./scripts/d1-migration-local-test.sh`（覆盖全新应用、幂等、存量数据兼容、基线脚本 fail-closed 与增量迁移模拟）。

## 回滚

- 加列类迁移（如 0003/0004/0012）：向后兼容，旧版本 Worker 自动忽略多余列；原则上通过回退代码而非 `DROP COLUMN` 恢复。
- 破坏性迁移前可用 CI 日志打印的 Time Travel bookmark 恢复：`npx wrangler d1 time-travel restore DB --bookmark=<bookmark>`。
- 任何破坏性回滚必须单独评估并记 ADR（`docs/engineering/release.md` §5 规则）。
