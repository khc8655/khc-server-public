# 待办清单（backlog）

> 状态：现行 ｜ 最后核验：2026-11-23 ｜ 关联：`AGENTS.md` §4

全仓唯一的待办清单，由设计任务维护。每项一行；开工前先写提案，主人拍板后才派发。完成后直接删除该行，记录留在 PR 与 CHANGELOG。

## 安全与运维

| 项 | 说明 | 来源 |
|---|---|---|
| 启用面板 TOTP | 代码已实现，生产是否启用待主人确认 | 2026-11-10 测试工作单 N10 |
| 确认 `MASTER_ENC_KEY` 有离线备份 | Worker secret 无法读回，只能主人核实 | 2026-11-10 测试工作单 F4 |
| CI 部署后校验失败自动 `wrangler rollback`，冒烟扩展到登录与 D1 查询 | 现在失败只报错，线上保持新版本 | N6 |
| uptime 探测接入定时任务与告警 webhook | `scripts/uptime-check.mjs` 已有，未运行 | N7 |
| D1 定时导出与异地保存；Time Travel 写进恢复 SOP | 现在只有手动导出 | N8 |
| 验证 N-1 回滚按钮 | CI 日志与清单两条（0.6.0 → 0.5.5）已于 2026-11-18 部署核对；剩面板回滚按钮真机演练（ADR-0019） | 2026-11-12 |
| D1 迁移是否常态化走 CI | 0013 已由 CI 部署 job 执行（#87）；0014+ 是否沿用、如何保证幂等需主人拍板 | 2026-11-18 #87 |
| 同版本发版复用已签名包 | 打包已可复现（#88），但 runner 的 zlib 升级或本机应急重建仍可能改变字节；可改为同版本直接复用线上已签名包 | 2026-11-18 #88 |
| 信任根类操作的独立演练机 | 换钥演练与生产切换共用了同一台机器 | 2026-11-11 换钥 |
| host-ops 能力收窄 | `cron.set`、`keys.add` 按节点授权或时间窗，需先选方案 | 架构审查 D-5 |
| 补齐 B4 真机回滚与重启耗时证据 | 下次 Agent 升级时补做一次 `apply → 回滚`、一次远程回滚演练并记录 `systemctl restart` 耗时 | 2026-11-23 B4 复盘 |

## 功能与缺陷

| 项 | 说明 | 来源 |
|---|---|---|
| D-12 两轮升级重叠时看门狗误回滚 | 修法见 `docs/agent-lifecycle.md` §13；现靠「间隔 ≥60s」兜底 | 2026-11-08 E2E |
| 上游 443 明文 HTTP 的 scheme 无法表达 | Caddy 把 443 默认当 HTTPS，需产品决策 | 2026-11-08 UX 审计 P1-12 |
| Hub 自身 `wg1` 接口密钥轮换 | design-v3 §5.4 未实现 | 生产就绪余项 |
| 证书二维码、面板内自动续期编排 | 续期 timer 已随 Agent 0.1.51 安装，面板只展示 timer 是否就绪，尚无编排入口 | 生产就绪余项 |
| 多 DNS 服务商驱动（腾讯云 DNSPod / 阿里云 DNS 等） | S1 已拆分「账号」并预留 `provider` 扩展结构，后续按同一驱动接口补齐非 Cloudflare 厂商 | 2026-11-21 settings-ia-and-workflows |
| Agent 重启期间面板约 30s 显示不可达 | `node-client` 对连接拒绝的冷却是 30s（超时为 5s），`/state` 不绕过冷却；远程升级 / 回滚后用户会看到 30s「离线」。可考虑连接拒绝也用短冷却，或升级流程内的探测绕过冷却 | 2026-11-23 manifest-v2 真机验证 |
| 应用发布后 Worker 侧公网可达探活（P4） | 新增只读外网 HTTP/HTTPS 连通性与 TLS 探活端点（涉及 `apps/api/` 与契约评审），P1–P3 已先靠防火墙放行检查、本机监听检测与 DoH 解析覆盖主要排障场景 | 2026-11-22 ui-flow-consolidation |

## 暂缓（主人决定，重启需重新拍板）

| 项 | 说明 |
|---|---|
| 请求/响应 AEAD 加密与响应 HMAC | 2026-11-07 暂缓；控制通道全部 TLS 时不需要 |
| 接入方案 C 的 `caPool` 与 Access 403 实测 | 需具名隧道与 Service Token 凭据 |

## 低优先级整理

| 项 | 说明 |
|---|---|
| 前端单 chunk 约 978 KB，按路由拆分 | ui-guidelines §9 目标为数百 KB |
| 代码注释仍引用已归档的 `docs/release-versioning.md`（`apps/web/src/version.ts`、`apps/api/src/version.ts`、`apps/api/src/lib/build-info.ts`、`scripts/lib/release.mjs`） | 下次改到这些文件时顺手改为 `docs/engineering/release.md` |
| `ci.yml` 注释收敛（每步 ≤3 行，引用 ADR，删事故叙述） | 改 `ci.yml` 会触发一次部署，并入下次功能发版 |
| `design-v3.md` §1.1 按日期叠加的修订说明合并成现状描述 | 文档整理 |
