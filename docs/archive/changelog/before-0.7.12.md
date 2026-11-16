## [0.7.12] - 2026-11-10

- 面板节点「Agent」卡新增升级纪律提示：同一节点两次升级间隔需 ≥60 秒，升级失败先看
  节点上的 `/var/lib/khc-agent/upgrade.json` 再决定是否重试（看门狗重叠回滚属已知缺陷，单独立项）。
- 新增外部 uptime 探测脚本 `scripts/uptime-check.mjs`：检查 `/api/v1/health`、
  `/api/v1/version` 的 commit 与 TLS 证书到期；告警 webhook 未配置时显式提示「未配置」，
  不静默通过（告警地址待提供后接线）。
