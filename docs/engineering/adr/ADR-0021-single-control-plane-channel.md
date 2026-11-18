# ADR-0021: 统一单控制面通道，下线浏览器直连 Agent

- 状态：已接受
- 日期：2026-11-18
- 决策者：主人
- 关联：`docs/design-v3.md`、`docs/data-layering.md`、ADR-0001、ADR-0012
- 取代：ADR-0009、ADR-0010（浏览器直连分支）、ADR-0020

## 背景

随着 WebSSH 终止、host-ops 18 个动词经实测放弃迁直连，浏览器直连 Agent（`live-ticket` + `/_live/snapshot` + `127.0.0.1:8899`）仅剩 10 秒快照一个接口；而页面隐藏即停 + 60 次封顶下，快照全走 Worker 每月仅约 600–1,200 次请求（不足免费额度 0.04%），且复用连接实测 RTT 仅 ~3ms。维护跨端直连票据、Origin 白名单、`8899` 端口与前端 `live-only` 双轨状态机反而增加了 Tunnel / Access Service Token 场景下的故障面。

## 选项

| 选项 | 做法 | 利 | 弊 |
|---|---|---|---|
| **A 统一单控制面（选定）** | 所有请求（含 10s 快照 `/nodes/:id/snapshot`）统一经 `浏览器 → Worker → Agent`（HMAC + 2s 去重） | 零票据/CORS/8899 复杂度；Tunnel 与直连体验一致；删除约 1,500 行双轨代码 | 快照请求走 Worker 转发（月均 < 1,200 次） |
| B 保留直连 + 自动回退 | 保留 `8899`、`live-ticket` 与直连代码，直连失败改为回退 Worker | 改动小 | 双端口、CORS、票据、双轨状态机全部残留 |

## 决策

1. **统一单通道**：所有交互与 10s 可见轮询快照统一经 `浏览器 → Cloudflare Worker → Agent 主端口`（HMAC 鉴权，复用 ADR-0001 的 `fetch` + `cloudflare:sockets` 双传输）。保留 10s 可见轮询、页面隐藏即停、`BroadcastChannel` 多标签共享与 10 分钟/60 次封顶。
2. **下线浏览器直连基础设施**：移除前端 `directSnapshot` / `live-only`、Worker `/nodes/:id/live-ticket`、Agent `khc/live.py`（8899 端口）与主端口 `/_live/snapshot`，以及 `HOST_OPS_CHANNELS` 直连分类表；释放端口 `8899`。
3. **保留与向后兼容边界**：
   - Worker 的 `c.env.LIVE_ORIGINS`（`apps/api/src/app.ts`）保留作为跨边缘回源写请求 CSRF Origin 白名单，严禁删除；
   - `agent/khc_agent.py` 与 `install.sh` 保留 `--live-origins` / `--live-host` / `--live-port` / `--no-live` 的空操作参数解析，防旧命令报错；
   - `caddy-site` schema 保留并忽略存量 `liveGateway` 字段，不再生成 `/_live/*`；D1 `nodes.live_endpoint` 列保留为 NULL。

## 影响 / 迁移 / 回滚

- 严格按「先面板（0.18.0，PR #84）→ 后 Agent/契约清理（面板 0.19.0 / Agent 0.6.0）」两批滚动落地，零中断。
- 若需回滚，可在面板 0.18.0 前恢复前序版本；Agent 降级走发布清单 N-1（ADR-0019）。

## 验证

- `./scripts/verify.sh`（TypeScript / Vitest / Python 单测 / D1 迁移 / 安装生命周期 / docs-lint）全绿；
- 含 `"liveGateway": true` 的存量 `caddy-site` plan/apply 不生成 `/_live/*`；带 `--live-origins` 的旧命令正常执行；8899 不再监听且 `/_live/snapshot` 未带 HMAC 返回 401。
