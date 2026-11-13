# D1 迁移 runbook

> 状态：现行 ｜ 最后核验：2026-11-11 ｜ 关联：`docs/engineering/release.md`、ADR-0008
> 范围：`migrations/` 到任意环境的执行顺序、命令与核对

## 原则

- 迁移**只增不改**：新变更一律新增 `migrations/000N_*.sql`，不得修改已应用的文件。
- 当前已应用的为 **0001–0012**（含生产）；新迁移从 0013 起。
- 生产与"staging"是同一个 D1（`<d1-name>`，见 ADR-0008）——**对 remote 执行迁移就是直接改生产库**，执行前先备份/导出。
- 根 `package.json` 的 `db:migrate:local/remote` 脚本只跑 `0001_init.sql`，**不能当作全量迁移命令**；0002 起按本手册逐个执行（修复脚本属代码改动，待主人拍板）。

## 迁移清单（0001–0012）

| # | 文件 | 内容 | 备注 |
|---|---|---|---|
| 0001 | `0001_init.sql` | 核心四表：`nodes` / `app_configs` / `revisions` / `audit` | 全新建库时执行 |
| 0002 | `0002_c3.sql` | C3 扩展：`certificates`、`settings` 两表 | 全局证书库 + 全局设置（DNS 凭据等） |
| 0003 | `0003_live_endpoint.sql` | `nodes` 加 `live_endpoint` 列 | 6.4a 观测层入口 |
| 0004 | `0004_last_apply_error.sql` | `app_configs` 加 `last_apply_error` 列 | apply 失败摘要（JSON） |
| 0005 | `0005_clear_runtime_state.sql` | 清空 `nodes.last_state_json` 历史数据 | 数据分层：运行快照不再落库；列保留为空 |
| 0006 | `0006_rate_limit.sql` | 新增 `rate_limit` 表 | 登录限流 D1 计数（P1-C）；2026-11-02 已对生产执行并复验 |
| 0007 | `0007_rev_epoch.sql` | `app_configs` 加 `rev_epoch` 列 | 配置版本 epoch（D-2/T2.2） |
| 0008 | `0008_node_domain.sql` | `nodes` 加 `domain` 列 | CF DNS 代建记录后写入节点域名（2026-11-03 新增） |
| 0009 | `0009_ssh_keys.sql` | 新增 `ssh_keys` 表 | 全局 SSH 公钥库（P4，只存公钥；2026-11-07 已对生产执行） |
| 0010 | `0010_node_access.sql` | `nodes` 加 `access_mode` / `tunnel_id` / `allow_insecure` 列；新增 `tunnels` 表 | 全局接入配置（域名/Tunnel/IP 直连）与隧道配置（Token 密文；2026-11-07 已对生产执行） |
| 0011 | `0011_cert_acme_meta.sql` | `certificates` 加 `acme_provider` / `acme_credential_key` / `acme_ca` / `acme_key_type` 列 | 证书一键续期的 ACME 元数据（2026-11-07 新增；**生产已应用**，2026-11-10 用 `PRAGMA table_info(certificates)` 复核四列存在） |
| 0012 | `0012_app_configs_summary.sql` | `app_configs` 加可空 `summary_json` 列 | 明文摘要（只含模式与计数）供 `GET /nodes` 零解密派生；旧行 NULL 时回退解密，一次性回填后不再发生（2026-11-11 新增；**生产已应用**） |

## 执行命令

### 本地开发（wrangler 本地 D1）

```bash
npx wrangler d1 execute DB --local --file=migrations/0001_init.sql
npx wrangler d1 execute DB --local --file=migrations/0002_c3.sql
npx wrangler d1 execute DB --local --file=migrations/0003_live_endpoint.sql
npx wrangler d1 execute DB --local --file=migrations/0004_last_apply_error.sql
npx wrangler d1 execute DB --local --file=migrations/0005_clear_runtime_state.sql
npx wrangler d1 execute DB --local --file=migrations/0006_rate_limit.sql
npx wrangler d1 execute DB --local --file=migrations/0007_rev_epoch.sql
npx wrangler d1 execute DB --local --file=migrations/0008_node_domain.sql
npx wrangler d1 execute DB --local --file=migrations/0009_ssh_keys.sql
npx wrangler d1 execute DB --local --file=migrations/0010_node_access.sql
npx wrangler d1 execute DB --local --file=migrations/0011_cert_acme_meta.sql
npx wrangler d1 execute DB --local --file=migrations/0012_app_configs_summary.sql
```

（全新本地库必须按序执行全部 12 个；已有库只补未应用的编号。）

### 远程（= 生产，见 ADR-0008）

```bash
# 1) 先导出备份
npx wrangler d1 export DB --remote --output=backup-$(date +%Y%m%d).sql

# 2) 按序执行未应用的迁移（示例：只缺 0005）
npx wrangler d1 execute DB --remote --file=migrations/0005_clear_runtime_state.sql
```

## 核对

每个迁移执行后核对表/列存在：

```bash
npx wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
# 期望：app_configs / audit / certificates / nodes / rate_limit / revisions / settings / ssh_keys / tunnels（+ sqlite 内部表 / _cf_KV）

npx wrangler d1 execute DB --remote --command "PRAGMA table_info(nodes)"
# 期望含 live_endpoint 列

npx wrangler d1 execute DB --remote --command "PRAGMA table_info(app_configs)"
# 期望含 last_apply_error / summary_json 列
```

0012 回填后追加核对（全为 0 才算完成）：

```bash
npx wrangler d1 execute DB --remote --command "SELECT COUNT(*) AS missing FROM app_configs WHERE summary_json IS NULL"
```

执行后在面板冒烟：节点列表正常加载（`nodes` 表）、证书库可打开（`certificates`）、节点设置可保存（`settings`/`app_configs`）。

## 回滚

- 0003/0004/0012（加列）：SQLite 的 `DROP COLUMN` 支持有限且属破坏性变更，原则上**不回滚**，代码层忽略多余列即可；0012 的回退路径是读取代码改回 `listForSummary()`（列保留，不影响旧版本 Worker）。
- 0002（新表）：确认无数据依赖后 `DROP TABLE certificates; DROP TABLE settings;`（会丢证书数据，须先导出）。
- 0005（清数据）：不可逆，依赖执行前的导出备份。
- 任何破坏性回滚必须单独评估并记 ADR（release.md §5 规则）。
