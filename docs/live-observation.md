# 6.4a 观测层：服务端实现（v3 架构）

> 状态：现行 ｜ 最后核验：2026-11-05 ｜ 关联：docs/data-layering.md、docs/engineering/adr/ADR-0010-snapshot-polling.md、agent/khc/live.py
> 范围：观测层 10s 快照轮询、snap/live ticket；SSE 已停用，代码保留
> **2026-11-01：观测通道曾由 WebSocket 改为 SSE。**
> **2026-11-04：ADR-0010 拍板方案 A——页面可见时 10s 轮询轻量 `/snapshot`，
> 隐藏即停、10 分钟/60 次上限；无域名经 Worker 转发；SSE 不再被前端引用。**
> **当前实现依据：本文件 §8 + `docs/design-v3.md`（v3 适配）。**
> 旧仓库 `khc8655/wireguard` PR #3 §6.4a 仅作历史来源，已冻结；不再作为开发依据。

## 1. 分层与边界

```
有可信域名：浏览器 ──10s──▶ https://<domain>/_live/snapshot?ticket= ──▶ Agent 127.0.0.1:8899
无域名：    浏览器 ──10s──▶ Worker /nodes/:id/snapshot（2s 去重）──HMAC──▶ Agent /snapshot
控制面：    浏览器 ──打开工作区一次──▶ Worker /state（可写探测 + 适配器/端口等重数据）
```

- **指标（CPU/内存/磁盘/负载/uptime）** 由浏览器每 10 秒拉一次轻量快照；页面隐藏立即停止，
  10 分钟或 60 次到顶后停表（ADR-0010）。
- **适配器运行态、服务/进程、端口等重数据** 仍只由打开工作区时的一次性 `/state` 提供，
  **不做周期 `/state` 轮询**（ADR-0009 的配额结论保留）。
- **失败行为**：快照请求失败保留上一帧并自动按 10s 重试；断网/Agent 重启后自动恢复；
  到顶后显示「已停止自动刷新 · 数据截至 xx:xx」，提供手动刷新（只补一次）。
- **SSE**：`/_live/` 与一次性 live ticket 仍在 Agent/Worker 中保留，但前端不再引用（不可达）。


## 2. Worker API

`POST /api/v1/nodes/:id/live-ticket`（管理员会话）

```json
// request
{ "scope": "live", "origin": "https://console.example.com" }
// response
{ "ticket": "<payloadB64>.<hmacHex>", "expiresAt": 179..., "livePath": "/_live/" }
```

- ticket TTL 60 秒、一次性（Agent 侧 jti 去重）；
- claims：`v, n(nodeId), s(live|nudge), e(exp), j(jti), o(origin)`；
- 当前架构用 **节点 token HMAC** 签名（Hub 已持有 token，无需分发新公钥）；
  v0.5r 拆分 Service Token 后切换 Ed25519（Hub 只存公钥），票据/scope 不变；
- **ticket 经 URL 查询串 `?ticket=` 提交**（EventSource 无法发自定义首消息/请求头）：
  一次性 + 60s 短时缓解查询串暴露；Agent 观测服务**不打访问日志**，票据不落日志。

## 3. Agent 观测服务

模块 `agent/khc/live.py`（SSE 实现，无第三方依赖）：

- 默认 `127.0.0.1:8899`（生产由 Caddy 443 反代，不直接公网）；
- `GET /_live/?ticket=...`（scope=live）：响应 `text/event-stream`，
  先发 `event: hello`，随即推首帧 `event: state`（前端无需等推送周期），
  之后仅在 `/state` 内容变化时推送（间隔默认 1 秒）；每 15 秒发 `: ping` 心跳注释行；
- `POST /_live/nudge`（scope=nudge）：请求体 `{"type":"nudge","rev":N,"ticket":"..."}`，
  验票后调用 `on_nudge` 并返回 JSON ack（nudge 票据不进 URL）；
- 无票据/票据非法/Origin 不允许 → 401/403（EventSource 收非 200 即关闭，前端重新取票）；
- 连接上限 8（`KHC_MAX_LIVE_CONN`），超出 503；
- 断开检测：select 监听客户端可读（EOF/半关闭/违规写数据）即结束；心跳写失败同样结束。

启动参数/环境变量：

```bash
khc_agent.py run ... \
  --live-host 127.0.0.1 --live-port 8899 \
  --live-origins https://console.example.com
# 或 KHC_LIVE_HOST/KHC_LIVE_PORT/KHC_LIVE_ORIGINS；--no-live 关闭
```

Caddy（Hub 域名入口，需替换域名）：

```caddyfile
https://hub.example.com {
    handle /_live/* {
        reverse_proxy 127.0.0.1:8899
    }
    # 其余站点块...
}
```

## 4. 安全要点

- 观测层不暴露 Agent 的 8880 控制 API；live 只绑 127.0.0.1，由 Caddy TLS 终止；
- ticket 60s/一次性/jti 去重/Origin claim；`KHC_NODE_ID` 配置后校验 nodeId；
- ticket 走 URL 查询串：一次性 + 短时缓解暴露；观测服务不打访问日志（票据不落盘）；
- 只读（SSE 单向）+ nudge 不带配置，绕过观测层不能改配置；
- 生产必须配置 `KHC_LIVE_ORIGINS`（留空 = 不校验 Origin，仅限内网调试）；A-4 整改后
  面板生成的安装/升级命令自动带 `--live-origins`（面板域名）与 `--node-id` 渲染进
  systemd unit，未知 Origin 的 SSE 一律 403；手动重装不带参数时从现有 unit 继承；
- 连接上限；无票据直接 401/403，只看到 TLS 握手/拒绝。

## 5. 验证

- Agent：`python3 -m unittest discover -s agent/tests -t agent` 中 `test_live`（8 项：live 流/只读断开、nudge POST、scope 混用拒绝、replay、expired、Origin、连接上限、health）；
- Worker：`apps/api/test/live.test.ts`（签票/验签/scope、匿名、节点不存在）；
- 离线保存冒烟：`apps/api/test/smoke-offline-save.test.ts`（Hub 断连时保存成功/apply 失败记录错误/恢复后 expectRev 生效）。

## 6. staging / 域名验证（2026-10-26）

- Worker 已部署 staging（API Token 鉴权），`POST /nodes/:id/live-ticket` 200；
- Agent 测试机 live 服务绑定 `127.0.0.1:8899`，通过 SSH 隧道用**真实 Worker ticket** 验证：
  - handshake 101 → hello（nodeId 一致）→ state；
  - 写消息 → `read_only`；
  - nudge ticket → `nudge.ack rev=123`；
  - 同一 ticket 第二次 → `replay`。
- 域名/证书（测试环境）：
  - `example.com` A → `203.0.113.12`（Cloudflare，DNS only）；
  - Caddy 自动 ACME（TLS-ALPN-01）签发 Let's Encrypt 证书；
  - Caddy `handle /_live/*` 反代 `127.0.0.1:8899`（保留 `/_live/` 路径）；
  - **浏览器从 staging HTTPS origin 直连 `https://example.com/_live/?ticket=...`**：hello → state（caddy-site/certificates/node-exporter/wireguard），证书被浏览器信任。
- **CORS**：SSE 是跨域 HTTP 请求，Agent 必须回显已通过 allowlist 的 `Access-Control-Allow-Origin` 并带 `Vary: Origin`；WebSocket 没有这个要求。
- 当前 Worker 票据用节点 token HMAC；与 6.4a 的 Ed25519 差异见 §2，待 Service Token 拆分后切换。

## 6.1 UI 接入（2026-10-26）

- 节点观测入口由绑定域名自动推导为 `https://<domain>`（`liveEndpoint` 仅作存量/高级覆盖），创建与设置页不再要求手填；
- 节点概况新增「实时观测」卡片：状态（实时/连接中/未连接/未配置）、最近推送、观测入口；
- 节点概况新增「VM 运维」卡片：CPU/负载/内存/磁盘/服务/网络/监听端口/Top 进程/运行时长/重启标记；数据来自 `state.ops`，live 1s 推送、采集端 5s 缓存；
- 页面可见时取 ticket 连接 `https://<liveEndpoint>/_live/?ticket=...`（EventSource），隐藏断开、恢复重连；票据一次性，EventSource 不自动重连——连接失败后进入「未连接」并停止，由用户点「重新连接」重新取票（不做 10s 周期重试，避免浏览器无法直连时持续消耗 Worker 票据请求）。
- Agent 必须对 SSE 成功响应和 401/403 响应回显 CORS；否则浏览器 `EventSource` 会直接进入降级，而 curl 仍看似正常。
- staging 浏览器实测：节点概况显示「实时」，约 1 秒推送；截图 `docs/archive/ui-v2.2/shots/live-observation.png`。

## 6.2 VM 运维状态

- Agent `khc/ops.py`：CPU（核数/型号/使用率/load）、内存/Swap、磁盘（/ 与数据目录、inode）、网络（默认路由/DNS/监听端口）、systemd 服务/failed units、Top 5 进程、reboot required、采集时间。
- 5 秒缓存，`systemctl`/`ps` 超时 2s，任何异常降级为 `ops.error`，不影响 `/state`。
- live 通道原样推送；前端只消费 live 快照，未连接时显示未连接提示并停止取数（不回退 /state）。
- 验收：staging 节点概况显示 CPU 0.7–8.6%、内存 17.3%、磁盘 5.8%、服务/监听端口/DNS/路由/Top 进程，live 1s 更新。

## 7. 已接入

1. Caddy 站点 `liveGateway=true` 自动生成 `/_live/` 路由（已完成）；
2. 前端 10s 快照轮询、页面隐藏即停、60 次/10 分钟上限（2026-11-04，ADR-0010）；
3. nudge → 控制层 desired 拉取（尚未接入；不影响只读观测）；
4. CSP 动态化（尚未接入；正式多域名上线前需要处理）。

## 8. 10s 快照轮询（2026-11-04，验证分支）

### 8.1 Agent

`GET /snapshot`（HMAC 头鉴权，Worker 转发用）：

```json
{
  "ok": true,
  "ts": 1793792008,
  "host": { "hostname": "...", "uptime": 3384000, "load": [0.22, 0.05, 0.02], "...": "..." },
  "ops": {
    "cpu": { "cores": 2, "model": "...", "usagePercent": 52.0, "load": [...] },
    "mem": { "total": ..., "available": ..., "used": ..., "percent": 45.1 },
    "swap": {...}, "disks": [...], "uptime": ..., "collectedAt": 1793792008
  },
  "agent": { "version": "0.1.14", "serverTime": ... }
}
```

- 只读 `/proc` + `statvfs`，**不跑 systemctl/ps 等子进程**，不含适配器/端口/服务/进程；
- CPU 用 `/proc/stat` 计数器差分；首次或距上次 >30s（或 <0.2s）时在请求内双采样 1 秒；
- 无常驻线程/定时器；失败降级为 `ops.error`，不影响控制 API。

浏览器直连：`GET /_live/snapshot?ticket=...`（Agent `live.py`，仍绑 127.0.0.1:8899，
由 Caddy `/_live/*` 反代）。ticket：

- scope=`snap`，TTL 15 分钟，**有效期内可复用**（不触达 jti 一次性去重）；
- 响应回显允许的 `Access-Control-Allow-Origin` + `Vary: Origin` + `Access-Control-Max-Age: 600`；
- 401/403 同样带 CORS，避免浏览器把鉴权失败误判为网络错误。

### 8.2 Worker

- `POST /nodes/:id/live-ticket`（`scope:"snap"`）→ `snapshotPath:"/_live/snapshot"`，TTL 900s；
- `GET /nodes/:id/snapshot`：管理员会话；转发 Agent HMAC `/snapshot`（5s 超时）；
  同节点 2 秒内请求共享一次 Agent 采集并标记 `cached:true`（内存 Map 为单 isolate，
  并发/冷启动可能不命中，属尽力而为，不保证多标签页不放大 Agent 负载）；
  Hub 不可达返回 200 + `reachable:false`，页面进入失败态而非报错。

### 8.3 前端

- `apps/web/src/data/snapshot.ts`：`SnapshotLoop` 状态机 + `useHubSnapshot`；
- 打开拉 1 次；可见时每 10s；隐藏 `clearTimeout`；恢复按剩余间隔；硬上限 10 分钟/60 次；
- 直连模式同源多标签经 `BroadcastChannel` 共享一个计时器与最近快照：只有 leader 发请求，
  其余读广播；leader 关闭后存活标签接管；任一标签可见才继续（转发模式不启用）；
- 失败保留上一帧，继续按 10s 重试（不立即重试、不并发）；
- `history` 环形缓冲 120 点（图表数据源，不落库）；
- 状态文案：`实时（10s）`、`无域名 · 仅快照`、`已停止自动刷新 · 数据截至 xx:xx`；
  直连失败时显示「实时观测不可用：<原因>；不会自动回退控制面快照」，并只提供
  **手动**「读取控制面快照」按钮（一次点击只读一次，不改变 mode/status，也不重启自动循环）。
  直连仍按 10s 重试；手动读取不是自动回退，ADR-0010 的「不回退」口径不变；
- 手动刷新只补一次。

### 8.4 停用 SSE

- 前端不再 import `apps/web/src/data/live.ts`（代码保留但不可达，便于回滚）；
- Worker live-ticket 与 Agent `/_live/` 保留；Caddy 路由不变；
- 后续如确认长期不用，再按文档门禁删除 SSE 相关代码与契约。

### 8.5 网关（Caddy `/_live/*`）与 Origin 白名单

有可信 HTTPS 域名的节点，站点配置开启 `liveGateway=true` 即生成：

```caddyfile
handle /_live/* {
    reverse_proxy 127.0.0.1:8899
}
# 其余站点块...
```

站点其余路由放在后面的 `handle {}` 主路由，不额外占用端口。该开关在面板「站点」编辑
抽屉保存并生效即可（适配器 schema 字段 `liveGateway`）。

上线必查：

1. Agent 在 `127.0.0.1:8899` 监听（`systemctl cat khc-agent` 可见 `--live-port 8899`）；
2. systemd unit 的 `KHC_LIVE_ORIGINS` 必须包含**当前面板域名**；否则浏览器的跨域请求
   会在 Origin 校验处收到 403（无 CORS 头，表现为 `Failed to fetch`）。可用
   `curl -H 'Origin: https://<面板域名>' 'https://<节点域名>/_live/snapshot?ticket=<snap票>'`
   区分「Origin 拒绝（403，空 body）」与「票据问题（401，JSON）」；
3. 面板有两个地位对等的入口：`https://panel.example.com`（CDN）与
   `https://<worker-name>.<account>.workers.dev`（Workers 原生）。**两个都要写进
   `[vars] LIVE_ORIGINS`**，只写一个时从另一个入口访问会被 Origin 校验 403。
   **0.5.5 起**安装/升级命令的 `--live-origins` 取自该变量（逗号分隔），不再取 Worker
   看到的回源 Host；未配置 `LIVE_ORIGINS` 时才退回请求 origin。存量节点 unit 里可能是
   单值或旧的 workers.dev，重新生成安装/升级命令跑一次即可纠正
   （或 SSH 更新 unit 后 `systemctl daemon-reload && systemctl restart khc-agent`）。
   `KHC_LIVE_ORIGINS` 留空的旧节点不校验 Origin，所以不会因此中断观测。
