## [0.7.13] - 2026-11-10

- 发布 Agent 0.1.36（预发复测 13 项缺陷按 R1–R7 成批修复）：
  - 动作参数统一走 `action_params(body)` 唯一访问器，修复 CaddyFile 接管/恢复（C-05）与
    备份恢复时「参数读错层级」导致的失败；适配器内置 AST 守卫阻止再次直读顶层键。
  - cron 校验收敛为 Agent 单一权威：拒绝 `@reboot` 等快捷表达式、shell 分隔符注入
    （`;` / `&&` / `||` / `|` / `$()` / 反引号）、段数不足与越界时间字段；面板侧只保留格式提示。
  - `status` 新增 `orphan_unit`（残留 `wg-quick@*`）与 `wireguard_dir_missing`（`/etc/wireguard`
    缺失降级，不再拖垮 Agent 启动）；站点 plan/apply 读 `/proc/net/tcp{,6}` 做真实端口预检。
  - 过载拒绝语义明确：明文池满返回 503 + `Retry-After`，TLS 握手前只能断连（见
    `docs/security-boundaries.md` §4.1）。
- 备份默认剥离 basicauth 密码哈希并在 manifest 记录 `stripped`/`encKeyId`，导入时保留目标
  节点旧值；新增 `scripts/verify-backup.mjs` 与灾难恢复「回放前自检」。
- 面板文案：直连观测不可用时明确「不回退控制面快照」；未知状态改为「未读取」。
- Agent unit 的 `/etc/wireguard` 白名单改为可选前缀，目录被误删时 Agent 仍可启动。
