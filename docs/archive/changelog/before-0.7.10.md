# Changelog（0.7.10，归档）

> 状态：历史 ｜ 最后核验：2026-11-16 ｜ 关联：`CHANGELOG.md`

从根目录 `CHANGELOG.md` 原样迁出，条目未改写。0.7.9 及更早见 `before-0.7.9.md`。

## [0.7.10] - 2026-11-09

- 发布 Agent 0.1.35：修复 TLS 握手在 accept 主线程执行导致的连接冻结（一条只建 TCP
  不发数据的空连接即可让 `/state`、`/health` 全部超时）；握手改到工作线程并带 10s 超时。
- 升级定时器改用 `--timer-property AccuracySec=1us`（默认 1min 精度会让 2s 定时器在
  2–60s 随机触发）；看门狗定时器 = 重启延迟 + 8s，并等待旧进程退出后再做健康探测。
- Agent 启动时清理被 kill -9 遗留的 `.khc-agent-upgrade-*` 目录，并把 `upgrade.json` 的
  `restart_scheduled`/`downloading` 中间态归一为 `unknown`/`failed`。
- 已知问题（未修）：两轮升级重叠时，上一轮看门狗的定时器可能在下一轮执行后回滚版本，
  详见 `docs/agent-lifecycle.md` §13。
