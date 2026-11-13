# 生产就绪状态跟踪

> 状态：现行（跟踪余项） ｜ 适用范围：生产上线后的遗留门禁与运维缺口 ｜ 最后核验：2026-11-11（补记 2026-11-10 测试工作单遗留项 N6/N8/N9） ｜ 关联：ADR-0008、`docs/engineering/release.md`、`docs/auto-deploy.md`、`docs/verification/2026-11-11/pr-decision-salvage.md`

**生产已上线**（单 Worker/D1 拓扑，ADR-0008）：main 推送经 CI 自动部署，面板经自定义域名访问，UI 重构（PR #58/#59）已在线上验证。本文原为 2026-10-27 的上线前门禁清单，现改为**余项跟踪**；已完成项保留作背景。

## 1. 原硬门禁的落地情况（2026-10-27 清单 → 现状）

| # | 门禁 | 现状 |
|---|---|---|
| B1 | 生产 Cloudflare 资源 | ✅ 已按 ADR-0008 落地：生产复用 `<worker-name>` Worker 与 `<d1-name>`，不再建独立生产资源；自定义域名在面板绑定 |
| B2 | 生产 Secret | ✅ 已配置（面板可登录、加密功能可用即为证据）；`MASTER_ENC_KEY` 离线备份仍需主人自查 |
| B3 | 生产迁移 | ✅ **0001–0011** 已全部应用（2026-11-10 复核：0009/0010/0011 的列与表在生产库均存在）；后续迁移走 `docs/engineering/d1-migrations.md` |
| B4 | 生产 Agent 包与真实升级 | ✅ 真实 HTTPS 包升级链已打通；发布清单与线上节点回显均为 **0.1.35**（2026-11-10 复核，含 node-test-2 由 0.1.23 实升验证） |
| B5 | 生产接管/UAT | ✅ 真实 Hub 已接管并承载生产流量（面板即为生产控制面） |
| B6 | 运维安全 | ⚠️ **部分未完成**，见 §2 |

## 2. 仍开放的余项（非阻塞，按需推进）

- ~~登录限流为 isolate 内存实现~~ **已解决（2026-11-02，P1-C）**：D1 固定窗口计数（迁移 0006，单语句原子 upsert，跨 isolate；D1 → KV → 内存三级降级），生产复验第 11 次错误口令 429、异 IP 不受影响。
- **外部 uptime 探测已实现、告警落点待接线（2026-11-10）**：`node scripts/uptime-check.mjs --base https://panel.example.com` 检查 `/api/v1/health`、`/api/v1/version` 的 commit（可用 `--expect-commit` 校验本次构建）与 TLS 证书到期（默认剩余 <21 天告警）；有 fail/warn 时按 webhook 外发。**告警地址尚未提供**——`KHC_ALERT_WEBHOOK` / `--webhook` 为空时脚本显式打印「未配置…本次结果不会外发」，不会静默通过。待主人给地址后写入 cron 即可，无需再改代码。
- D1 无自动备份/监控/告警：目前靠发版前手动 `wrangler d1 export`（见 d1-migrations.md）；可考虑 Cloudflare 面板定时任务 + 异地保存。
- 无 2FA：单用户密码登录（pbkdf2 哈希）；是否上 TOTP 待主人拍板。
- 证书二维码、面板内自动续期编排（acme.sh cron 已装）。
- Hub 自身 `wg1` 接口密钥轮换（design §5.4 未实现）。
- Agent 包无代码签名（当前 HTTPS + sha256 + manifest 公钥校验，见 `docs/agent-releases.md`）。
- **CI 部署后校验失败只 `exit 1`，未自动回滚（N6，2026-11-10 建议，未实施）**：部署前冒烟尚未覆盖登录与 D1 查询；上线后建议扩展冒烟并在失败时自动 `wrangler rollback`。
- **D1 仅有发版前手动导出（N8）**：定时导出/异地保存与 Time Travel 恢复 SOP 未落地；当前命令与恢复步骤见 `docs/engineering/d1-migrations.md`、`docs/backup.md`。
- **前端单 chunk 约 978 KB（N9，2026-11-10 观测，未复核）**：未按路由拆分；`docs/ui-redesign/ui-guidelines.md` §9 目标为数百 KB 量级，低优先级。

## 3. 验证基线

- CI：Agent 与前端/Worker 全量测试全绿（数量以 `./scripts/verify.sh` 实测为准）。
- 部署后冒烟清单见 `docs/engineering/release.md` §5；上线前冒烟见 §4（`wrangler versions upload` + 预览 URL）。
- ~~`wrangler.staging.toml` 脚枪~~ **已解决（2026-11-03，D-6）**：文件已删除，配置唯一来源 `wrangler.toml`；实测版本预览可用（`docs/verification/2026-11-03/report.md` §20）。
