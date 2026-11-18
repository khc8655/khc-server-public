## [0.9.0] - 2026-11-11

- 手工安装的应用「可见 + 可接管」：`POST /nodes/probe` 改用 Agent `GET /state`（10s 预算），
  响应新增可选 `apps: [{name,installed,running}]`（只含名称与布尔值，不含任何 secrets）；
  首页仍只发 1 次 probe，`/state` 超时/结构不合法时 apps 缺失或为空、不影响 `reachable`。
  首页卡片与节点概况页把 D1 期望配置与在线实装做差集：D1 有行但节点未安装 → 「未安装 / 未生效」
  （不再显示肯定的「组网节点」）；实装但 D1 无行、或 Caddy 实装但站点计数为 0 → 「外部安装 · 未纳管」，
  入口复用站点页既有 `caddy_import_scan` → `takeover`，不新造操作范式；WireGuard 无接管流程，
  只显示状态并进入现有应用页。`lib/node-summary.ts` 仍为纯 D1 派生，不塞在线探测。
- 摘要语义修正：有配置行但条数为 0 时 `summary.sites` / `summary.forwards` 返回 0（不再折成 null），
  首页与详情页明确显示「站点 0 / 转发 0」，不再与「未配置」混成空白。
- `app_configs` 新增可空 `summary_json`（迁移 `0012_app_configs_summary.sql`，只增列）：
  `put` 时用明文 config 派生模式与计数落库，`GET /nodes` 与 `GET /nodes/:id` 改读明文摘要、零解密；
  `summary_json IS NULL` 的旧行整批回退 `listForSummary()` 解密派生，一次性回填后观察一版再删。
  硬约束：摘要只含模式与计数，不得写入私钥、证书、密码或哈希（已有测试断言防回归）。
  旧版本 Worker 的显式列名查询不受影响（该列为可空、无默认值）。
