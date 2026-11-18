# 下线浏览器直连通道与收敛单控制面架构（提案）

> 状态：已实施（批次 1 #84、批次 2 #85） ｜ 最后核验：2026-11-18 ｜ 关联：ADR-0010、ADR-0020、`docs/live-observation.md`

## 1. 背景与现状问题

项目定位是「每月打开约 10 次的服务器运维遥控器 + 配置仓库」，核心诉求是以最低心智负担管好若干 VM 与 NAS/NAT 主机的应用安装分发、内网穿透、基础运维、证书与 DNS。

2026-11-18 底层连接走查发现，当前「浏览器直连 Agent」通道已成为收益最低、维护成本最高的历史包袱：

1. **功能面仅剩 1KB 指标快照**：面板终端（WebSSH）已因安全与断线丢会话归档否决；主机运维 18 个动词也经实测放弃迁直连（`docs/verification/2026-11-17/c2-threshold-decision.md`）。整套浏览器直连基建目前只服务 `GET /_live/snapshot?ticket=` 这一个 10 秒轮询接口。
2. **当初引入直连的两个前提均已不成立**：
   - **配额账**：页面隐藏即停 + 单次 60 次封顶下，即使快照 100% 走 Worker `/nodes/:id/snapshot`（含 2s 内存去重），每月打开 10–20 次仅消耗 **600–1,200 次请求/月**，不到 Cloudflare Workers 免费额度（10 万次/天 ≈ 300 万次/月）的 **0.04%**，还省掉了每次签发 `live-ticket` 的 D1 `audit` 写入。
   - **延迟账**：实测 Cloudflare 边缘与节点同城时 `Worker → Agent` 复用连接仅 **2.8–3.3ms**，对 10 秒刷新一次的指标毫无体感差异。
3. **跨端复杂度与排障坑不成比例**：
   - Agent 侧同时维护三套快照入口：主端口 HMAC `/snapshot`、主端口票据 `/_live/snapshot`、以及 `127.0.0.1:8899` 的 `LiveServer`（`agent/khc/live.py`，含已停用的 SSE `/_live/` 与 `nudge` 代码）；
   - 部署侧需同步维护 `KHC_LIVE_ORIGINS`（CDN 域名与 `*.workers.dev` 漏一即 CORS 403）和 Caddy `liveGateway` 反代；Tunnel 节点开启 Cloudflare Access Service Token 时浏览器无凭据必挂，且旧规则禁止自动回退控制面，直接导致界面报错；
   - 前端与契约侧维护了近 900 行双轨状态机（`snapshot.ts`、`channels.ts` 的 `live-only` 半在线态、`connectionState.ts`）及 `HOST_OPS_CHANNELS` 三分类声明。
4. **文档残留未实现的无 root 穿透分支**：`docs/design-v3.md` §5A 仍保留 `chisel-server` / `chisel-client` 方案，代码从未实现，且目标 NAS/NAT 主机均具备 root 或容器运行 WireGuard / `cloudflared` 的条件。

## 2. 方案对比与推荐

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A 单通道收敛（推荐）** | 彻底下线浏览器直连，所有交互统一走 `浏览器 → Worker → Agent`；归档 `live-observation.md` 与 `chisel` 方案 | 移除跨端约 1,500+ 行冗余代码及票据/CORS/8899 端口故障面；有域名、裸 IP、Tunnel 节点体验 100% 一致 | 快照经 Worker 转发（月均 < 1,200 次请求，占免费额度 < 0.04%） | **推荐（主人已认可方向）** |
| B 保留直连 + 自动回退 | 保留 `8899`、`live-ticket` 与直连代码，仅把直连失败改为静默回退 Worker | 改动小 | 双端口、CORS、票据、双轨状态机等历史包袱全部保留 | 不推荐 |

## 3. 目标架构与四条兼容红线

```
浏览器 ──同源 Cookie──▶ Cloudflare Worker ──HMAC（fetch / TCP / Tunnel）──▶ Agent 主端口
```

为确保生产滚动升级零中断、存量配置与安装命令不失效，执行批次必须遵守以下红线：

1. **严格遵守「先面板、后 Agent」（`docs/engineering/release.md` §2.1）**：
   - 批次 1 只改面板前端与安装命令生成（停止发起 `/live-ticket` 与 `/_live/snapshot`，统一调 Worker `GET /api/v1/nodes/:id/snapshot`），不动 Agent 与 Worker `/live-ticket` 路由；存量 Agent 早已具备 HMAC `GET /snapshot`，切换零中断。
   - 批次 2 再下线 Worker `/live-ticket`、Agent `live.py`（8899 端口）与主端口 `/_live/snapshot`。
2. **严禁删除 Worker 侧 `LIVE_ORIGINS` 环境变量**：
   - `apps/api/src/app.ts` 的 `c.env.LIVE_ORIGINS` 承担面板跨第三方边缘回源（回源 `Host` 为 `*.workers.dev`）时的**写请求 CSRF Origin 白名单校验**，必须原样保留（仅更新注释说明）；只下线 Agent 侧的 `KHC_LIVE_ORIGINS` 与 `--live-origins`。
3. **存量配置与旧命令行向后兼容（防校验 400 / 防脚本退出）**：
   - `caddy-site` 适配器 schema 继续保留可选布尔字段 `liveGateway`（读取时忽略不报错，不再渲染 `handle /_live/*`），前端 `SiteDrawer` 移除该开关，确保 D1 存量配置与备份直接兼容；
   - `agent/install.sh` 与 `khc_agent.py` 对旧参数 `--live-origins`、`--live-host`、`--live-port`、`--no-live` 保留空操作（no-op）解析兼容，防止重跑旧保存命令时报错；
   - D1 `nodes.live_endpoint` 列按「迁移只增不删」保留为空，不做删列迁移。
4. **多标签页节流保留**：保留 `SnapshotLoop` 的 `BroadcastChannel` 同源多标签共享计时器（仅 leader 标签页发 `/nodes/:id/snapshot` 请求），避免多标签页放大 Worker 请求。

## 4. 范围与不做

- **做**：下线浏览器直连快照与已停用 SSE/nudge 代码；前端节点状态收敛为在线/离线/未知（移除 `live-only` 与通道明细表）；下线 `HOST_OPS_CHANNELS` 直连分类；新增 ADR 记录单通道决策（取代 ADR-0009/0010 直连部分与 ADR-0020）；归档 `docs/live-observation.md` 与 `docs/design-v3.md` §5A（`chisel`）。
- **不做**：不改 Worker→Agent 的 `fetch` + `cloudflare:sockets` 双传输与 HMAC 机制；不改 10s 可见轮询 + 隐藏即停 + 60 次封顶策略；不做 D1 删列迁移；不动 Worker CSRF `LIVE_ORIGINS` 校验逻辑。

## 5. 批次拆分

| 批次 | 内容 | 改动范围 | 验收标准与必测项 | 版本 bump |
|---|---|---|---|---|
| **批次 1：面板单通道收敛** | ① `snapshot.ts` 删除 `directSnapshot` 与 `/live-ticket` 调用，全部节点统一走 `/nodes/:id/snapshot` 并开启 `BroadcastChannel` 多标签共享；<br>② 删除未被引用的 `apps/web/src/data/live.ts` 及单测；<br>③ `channels.ts` / `connectionState.ts` / `HubChannelsProvider.tsx` 移除 `live-only` 与通道分叉展示，统一在线/离线指示；<br>④ `SiteDrawer.tsx` 移除「启用观测入口」开关；<br>⑤ `agent-commands.ts` 生成安装/升级命令不再带 `--live-origins` | `apps/web/src/`、`apps/api/src/lib/agent-commands.ts` 及对应单测 | - `./scripts/verify.sh` 全绿；<br>- 浏览器打开域名节点与无域名节点均不再请求 `/live-ticket` 或 `/_live/snapshot`，仅请求 `/api/v1/nodes/:id/snapshot`；<br>- UI 改动附浅色、深色、390px 截图与四态说明 | 面板 minor（Agent 不改） |
| **批次 2：Agent/契约清理与文档归档** | ① Agent 删除 `agent/khc/live.py`、`http.py` 的 `/_live/snapshot` 及 8899 监听启动；`khc_agent.py` 与 `install.sh` 对 `--live-*`/`--no-live` 保留 no-op 兼容；<br>② `caddy_site.py` 停止渲染 `/_live/*`，schema 忽略存量 `liveGateway`；`port_forward.py` 释放 8899 保留端口；<br>③ Worker 删除 `routes/live.ts`；`packages/contracts` 移除 `liveTicket*` 与 `HOST_OPS_CHANNELS`（同步移除 `khc_host.py` 的 `CHANNELS`）；<br>④ 新增 ADR-0021「统一单控制面通道」，更新 ADR-0009/0010/0020 状态；`git mv` 归档 `docs/live-observation.md`，归档 `docs/design-v3.md` §5A（`chisel`）并同步更新 `docs/README.md` 等现行文档 | `agent/`、`apps/api/`、`packages/contracts/`、`docs/` | - `./scripts/verify.sh`（含 `docs-lint --strict`）全绿；<br>- 存量含 `"liveGateway": true` 的 `caddy-site` 配置 plan/apply 正常且不生成 `/_live/*`；<br>- 带 `--live-origins` 的旧安装命令仍正常执行；<br>- 真机升级 1 台节点验证 `8899` 不再监听、`/state` 与 `/snapshot` 正常 | 面板 minor + Agent minor |

## 6. 已拍板（2026-11-18，主人按推荐值批准）

1. **快照轮询间隔**：维持现有 **10 秒**（页面隐藏即停、10 分钟 / 60 次封顶，与控制面长任务进度刷新保持同步）。
2. **批次拆分**：按 §5「批次 1（先面板切换）→ 批次 2（后清理 Agent/契约与文档归档）」顺序执行，严格遵守「先面板、后 Agent」滚动升级规则。
