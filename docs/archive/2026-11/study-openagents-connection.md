# 研究：OpenAgents 的「服务端 ↔ 节点」连接与消息同步机制

> 研究对象：<https://github.com/openagents-org/openagents>（浅克隆，2026-10-25，`/tmp/openagents`）
> 研究范围：**只看连接与消息同步**，不涉及 Agent 框架、Mods 业务逻辑。
> 目的：对照我们 khc-server 的"heartbeat 轮询"设计，决定是否改架构。

---

## 0. 结论先行

OpenAgents 不是"一条 WebSocket 打天下"，而是**三条通道分工**：

| 通道 | 方向 | 机制 | 用途 |
|---|---|---|---|
| **A. 实时事件通道** | Agent/节点 → 服务端**出站**长连接 WebSocket | 注册握手 + 服务端推送 + ping/pong + 每 agent 内存队列 | 实时消息投递（网络内 agent 之间） |
| **B. 机器控制通道** | 机器 daemon → 服务端 HTTP **心跳（10s）** | 心跳响应里**捎带待执行命令**；daemon 执行后 POST 结果 | 远程在机器上装/启/停 agent（"伪推送"） |
| **C. 消息同步通道** | 客户端 → 服务端 `GET /v1/events?after=<cursor>` | **事件表 + 游标增量拉取**，at-head 缓存优化 | 历史/断线补齐、UI 消息流 |

关键设计思想：

1. **服务端从不主动连节点**（NAT / 防火墙友好），所有连接都是节点主动出站。
2. **实时与持久分离**：WebSocket 只负责"现在推"；历史与补齐靠数据库事件表 + cursor 拉取。
3. **心跳不是只报活**：心跳响应顺带下发命令，结果再回传（省一次轮询）。
4. **游标 + 幂等重放**：断线重连用 `after=<最后一条事件 ID>` 补齐，服务端有 `resume_cursor` 防止游标倒退。
5. **在线状态是推断出来的**：`last_heartbeat` 超时 / WS 无活动超时 → 标记离线，不依赖长连接本身。

---

## 1. 代码证据

### 1.1 实时事件通道（WebSocket）

- 客户端连接 + 注册握手：[`sdk/src/openagents/sdk/connectors/websocket_connector.py:61`](file:///tmp/openagents/sdk/src/openagents/sdk/connectors/websocket_connector.py)（`connect_to_server`：先 `ws://` 连接，再发 `system_request REGISTER_AGENT`，收到 `system_response` 后才算连上）
- 消息监听 + 服务端心跳：[`websocket_connector.py:194`](file:///tmp/openagents/sdk/src/openagents/sdk/connectors/websocket_connector.py)（`_listen_for_messages`：`type=message` 走业务；`type=system_request` 且 `command=ping_agent` 时回 pong）
- 服务端监听与连接表：[`sdk/src/openagents/sdk/transports/websocket.py:173`](file:///tmp/openagents/sdk/src/openagents/sdk/transports/websocket.py)（`websockets.serve`；每个连接分配 `peer_id`；`register_agent_connection` 把 agent_id 映射到 socket）
- 服务端推送：`WebSocketTransport.send()` 按目标 agent 找到 socket 直接 `send`，无目标则广播
- 每 agent 队列 + 投递：[`sdk/src/openagents/sdk/event_gateway.py:258`](file:///tmp/openagents/sdk/src/openagents/sdk/event_gateway.py)（`agent_event_queues: Dict[str, asyncio.Queue]`；`deliver_to_agent` 入队；`poll_events` 排空队列）
- 心跳超时清理：[`sdk/src/openagents/sdk/topology.py:566`](file:///tmp/openagents/sdk/src/openagents/sdk/topology.py)（`_heartbeat_monitor`：按 `last_seen` 判断，超时 `unregister_agent`）

> 注意：这里的队列是**进程内内存队列**，不是持久化 outbox。服务端重启 / agent 断线期间的消息**不会补发**（只能靠 B/C 通道的数据库记录与游标补齐）。所以 OpenAgents 的 WS 是"快"通道，不是"可靠"通道。

### 1.2 机器控制通道（HTTP 心跳 + 命令捎带）

- 配对（一次性 code 换每节点 token）：[`workspace/backend/app/routers/nodes.py`](file:///tmp/openagents/workspace/backend/app/routers/nodes.py) `POST /v1/nodes/redeem` —— code 单次使用、短有效期；成功后返回 `nodeId + token`；重复配对复用同一 token，避免正在跑的 agent 掉线
- 心跳：[`nodes.py`](file:///tmp/openagents/workspace/backend/app/routers/nodes.py) `POST /v1/nodes/heartbeat` —— 更新 `last_heartbeat/status=online`，**把 `pending` 命令改为 `running` 并随响应返回**（注释原文："the node isn't directly reachable, so the heartbeat is our push channel"）
- 命令状态机：`pending → running → done/error`；daemon 执行后 `POST /commands/:id/result` 回传；**结果落库后清洗命令参数**（可能含 API key）
- 机器侧节奏：launcher 注释写明 daemon **每 10 秒**读一次 `node.json` 并心跳（[`packages/launcher/src/main/node-pairing.ts:17`](file:///tmp/openagents/packages/launcher/src/main/node-pairing.ts)）；UI 点了"启动 agent"后会主动触发一次心跳，不等下一个 10s

### 1.3 消息同步通道（事件表 + cursor）

- 拉取接口：[`workspace/backend/app/routers/events.py:742`](file:///tmp/openagents/workspace/backend/app/routers/events.py) `GET /v1/events?after=<event_id>&limit=...`
- 游标恢复：[`workspace/backend/app/services/poll_queries.py:80`](file:///tmp/openagents/workspace/backend/app/services/poll_queries.py) `resume_cursor()` —— 不信任客户端游标倒退，取"客户端游标 / 缓存 head / 最新事件"里最新的位置
- at-head 优化：客户端停在 head 时空轮询走缓存/单飞，避免每次打 DB；写事件时用 generation 让旧缓存失效
- 结论：**历史消息永远从数据库按游标读**；WS 只负责把"新事件"即时推给在线 agent，两条路最终一致

---

## 2. 机制拆解（时序）

### 2.1 配对与身份

```
用户在 UI 点“连接这台机器”
  → 服务端生成短命 pairing code（单次、限时、绑定 workspace + owner）
  → 机器 daemon 用 code 调 /v1/nodes/redeem
  → 服务端 upsert Node 记录，返回每节点独立 token
  → daemon 把 token 写入本地 node.json（0600）
```

要点：**每台机器一个独立 token**（不是共享全局 token）；重复配对复用 token，避免重装导致正在跑的 agent 掉线；删除 Node 记录 = 真正吊销。

### 2.2 心跳捎带命令（伪推送）

```
daemon ──每 10s──▶ POST /nodes/heartbeat
                     ├─ 更新 last_heartbeat / status / 机器信息
                     ├─ 查 pending 命令 → 标记 running → 随响应返回
                     └─ 响应：{status:"online", commands:[...]}

daemon 执行命令（装/启/停 agent）
  → POST /nodes/:id/commands/:cmdId/result {ok,message,data}
  → 命令置 done/error，参数清洗
```

优点：节点无需公网可达；零额外轮询；天然重试（心跳没拿到就下次再拿，但注意"标记 running"后如果 daemon 崩了会卡住，需要超时回收）。
缺点：10s 延迟；心跳频率 = 请求量。

### 2.3 WebSocket 实时通道

```
agent ──出站 ws://──▶ 服务端
  1) 发 system_request: REGISTER_AGENT {agent_id, metadata, force_reconnect}
  2) 服务端回 system_response: success → agent 开始 listen
  3) 服务端把事件放入该 agent 的 asyncio.Queue
  4) 投递循环把队列里的 event 包成 {"type":"message","data":{...}} 推给 socket
  5) 服务端发 system_request ping_agent → agent 回 pong（保活/活性）
  6) 服务端 _heartbeat_monitor 每 60s 扫一次，超过 180s 无活动则 unregister
```

信封格式（简化）：
```json
{"type":"message","data":{"event_name":"...","source_id":"...","target_agent_id":"...","payload":{},"event_id":"...","timestamp":...,"metadata":{}}}
{"type":"system_request","command":"ping_agent","timestamp":...}
{"type":"system_response","command":"ping_agent","success":true,"agent_id":"..."}
```

### 2.4 断线与补齐

- WS 断开：agent 侧 `ConnectionClosed` → `is_connected=false`；服务端 `_handle_client` finally 清理连接表；`_heartbeat_monitor` 超时 unregister。
- 服务端**不做 WS 消息补发**；agent 重连后要靠 C 通道（`/events?after=`）补齐历史。
- 事件游标不会倒退：`resume_cursor` 以最新位置为准。

---

## 3. 设计取舍分析

| 取舍 | OpenAgents 的选择 | 原因 | 代价 |
|---|---|---|---|
| 谁连接谁 | 节点/agent 出站 | NAT、云安全组、免公网管理端口 | 服务端必须维护连接状态 |
| 机器控制 | HTTP 心跳 + 命令捎带（10s） | 实现最简单、零依赖、天然重试 | 10s 延迟；心跳本身是请求量 |
| 实时消息 | WebSocket + 内存队列 | 低延迟、双向、可 ping/pong | 进程内队列不持久；重启丢队列 |
| 历史/补齐 | DB 事件表 + cursor | 可靠、可审计、可重放 | 需要处理游标与缓存一致性 |
| 在线状态 | last_heartbeat / WS 活动超时 | 简单、两者兼容 | 需调好超时阈值 |
| 节点鉴权 | 每节点独立 token | 泄露影响面小、可单独吊销 | 需要配对流程 |

---

## 4. 与 khc-server 当前设计的对比

| 维度 | khc-server 现设计（M1 已实现控制面 HTTP） | OpenAgents 做法 | 评价 |
|---|---|---|---|
| Hub → 控制面 | HTTPS heartbeat 60s + desired 拉取 | WS 长连接（agent 层）/ 10s HTTP 心跳（机器层） | 我们**只有轮询**，没有实时通道；命令延迟最高 60s |
| 控制面 → Hub 下发 | 等下一次心跳 | 心跳响应捎带命令（即时到 10s） | 我们命令延迟不可控 |
| 断线补齐 | desired rev + 全量 desired | 事件表 + `after` 游标增量 | 我们缺**增量事件流** |
| 在线状态 | heartbeat 超时 | heartbeat 超时 + WS 活动 | 相当 |
| 消息持久化 | 无（只有 desired 全量） | DB 事件表（可审计、可重放） | 我们需要补 events 表 |
| 请求量（6 节点） | ~8,600/天（60s） | WS 约 432 计费请求/天 + 心跳 10s ≈ 52,000/天（机器层） | 我们的 60s 已经比它省，但**不实时**；WS 最省且实时 |

**核心差距**：我们是"定时拉"，它是"实时推 + 游标补"。用户操作后，我们的 Hub 最多等 60s 才动；它 10s 内（机器层）或实时（agent 层）。

---

## 5. 建议：khc-server v2 连接层改为 **WS-first Hybrid**

不是照抄，而是把三通道思想映射到 Cloudflare：

```
   ┌──────────────────── Cloudflare Worker ────────────────────┐
   │  /api/v1/agent/ws  ──升级──▶  Durable Object "HubSession" │
   │                                  │ 持有可休眠 WebSocket    │
   │  面板 /api/v1/*  ───────────────▶│ 推送 desired/task/事件  │
   │  D1：nodes / desired_rev / events / tasks / task_events    │
   │  Cron：心跳超时标记、任务超时回收、事件清理                │
   └──────────────────────────▲────────────────────────────────┘
                              │ 一条出站 WSS（Hub 主动连）
   ┌──────────────────────────┴────────────────────────────────┐
   │  khc-agent（Hub 上）：单文件 Python（或 Go）                │
   │  - 连接/重连（指数退避 + 抖动）                             │
   │  - resume: 上报 appliedRev + lastEventSeq                  │
   │  - 收 desired.changed / task.dispatch / agent.update       │
   │  - 回报 heartbeat / apply.result / task.event / task.result│
   │  - WS 不可用时回退 HTTP 心跳 + desired 拉取                 │
   └───────────────────────────────────────────────────────────┘
```

### 5.1 消息信封（统一）

```json
{ "v": 1, "id": "msg_xxx", "seq": 123, "type": "desired.changed", "ts": 1792912345, "payload": {...} }
```

- `seq`：每个节点单调递增的服务端序号（来自 D1 `events.seq`），用于断线补齐。
- 客户端上行也有 `id`，服务端 ack：`{"type":"ack","id":"msg_xxx"}`；未 ack 的消息在重连时重发（at-least-once），Agent 侧按 `id` 幂等去重。

### 5.2 连接生命周期

```
Agent: connect wss://<worker>/api/v1/agent/ws?node=<id>
  → Worker 校验 Bearer token（只验证，不写 D1 热路径）
  → 转发 Upgrade 到 DO idFromName(nodeId)
DO:  ctx.acceptWebSocket(server)（Hibernation API）
  ← Agent: {"type":"hello","agentVersion","appliedRev","lastEventSeq"}
  → DO: 立即回 {"type":"hello.ack","serverTime","desiredRev","replayFrom":seq}
  → DO: 从 D1 events 补齐 seq > lastEventSeq 的未确认事件（有上限，超出走全量 desired）
  ... 之后双向推送 ...
  Agent 每 30–60s 发 {"type":"heartbeat",...}（WS 消息，不是 HTTP）
  DO 回 ack；D1 只在状态变化时写（60s 节流）
断线：DO webSocketClose → 标记 offline（或 Cron 兜底）；任务留在 D1，重连后补发
```

### 5.3 Cloudflare 映射与成本

| 组件 | 说明 |
|---|---|
| `HubSession` DO（SQLite backend） | 每节点一个实例，持有 Hibernation WebSocket；`serializeAttachment` 存 nodeId/seq |
| Worker 路由 | `/api/v1/agent/ws` 升级 → DO；普通 API 不变 |
| D1 | `events(seq AUTOINCREMENT, node_id, type, payload, created_at)`；`nodes.desired_rev`；`tasks` 复用 |
| Cron | 每 5 分钟：心跳超时、任务租约回收、事件清理（保留 30 天） |
| 回退 | WS 握手失败/被墙时，Agent 走 `POST /agent/heartbeat` + `GET /agent/desired`（保留现有接口） |

**免费额度核算（6 节点，60s 心跳）**：

| 项 | 量 | 免费额度 | 占比 |
|---|---|---|---|
| WS 升级请求 | 6/天（+ 重连） | Worker 100k/天 | 忽略 |
| Agent→服务端消息 | 8,640/天 | DO 100k/天（WS 消息 20:1 计费）→ 约 432 | 0.4% |
| 服务端→Agent 消息 | 事件推送，出站**不收费** | — | — |
| DO duration | 每次唤醒几 ms；休眠时不计 | 13,000 GB-s/天 | <1% |
| D1 行写 | 仅状态变化（60s 节流）≈ 8,600/天 | 100k/天 | 8.6% |

对比 HTTP 轮询：请求量从 8,640/天降到约 432 计费请求/天，**并且实时**。

### 5.4 风险与对策

| 风险 | 说明 | 对策 |
|---|---|---|
| **部署会断开所有 WS** | Cloudflare 官方明确：代码更新会重启 DO、断开全部连接 | Agent 必须自动重连（指数退避 + 抖动）；面板显示"重连中"；部署窗口避开操作 |
| DO 单点 | 每节点一个 DO 实例；实例故障时连接断 | 重连即可；状态全在 D1，DO 无持久状态 |
| 消息大小 | Workers WS 消息有上限（远大于我们需求，但别塞大配置） | desired 走 D1/按需拉取，WS 只发"变更通知 + 小 payload"；大对象走 R2 |
| 20:1 计费 | 上行 WS 消息按 1/20 计 | 心跳 60s、批量上报状态，别每行日志发一条 |
| Hibernation 不适用于出站 WS | 我们是"服务端接收 WS"（可休眠），Agent 端是出站（客户端不受影响） | 用 Hibernation API + `serializeAttachment` |
| Python 标准库没有 WS 客户端 | 单文件 Agent 的约束 | 二选一：① vendored 一个 ~300 行 RFC6455 客户端（保持零依赖）；② 接受一个 `websockets` 依赖；③ 走 Go 单二进制（stdlib 也没有 WS，但可 vendor/依赖） |

---

## 6. 对 M2 的影响（不需要推翻 M1）

M1 已完成的是**控制面 + 前端 CRUD + D1**，这些全部保留。M2 只需要改变"Agent 通道"，并新增少量表/路由：

**新增/修改**：
1. `wrangler.toml`：新增 `HubSession` DO 绑定 + migration（`new_sqlite_classes`）。
2. `apps/api/src/do/hub-session.ts`：WebSocket 生命周期、hello/resume、ack、事件补齐、ping 保活。
3. `apps/api/src/routes/agent-ws.ts`：`/api/v1/agent/ws`（token 校验 + 升级转发 DO）。
4. D1 `migrations/0002_events.sql`：`events`（seq 自增）+ `nodes.desired_rev`/`agent_status` 字段。
5. Agent 侧：连接/重连、hello/resume、心跳、desired/task 处理、HTTP 回退。
6. 面板：节点详情显示"连接方式（WS/HTTP）、最后心跳、重连次数"；任务实时刷新。
7. 现有 HTTP `heartbeat/desired` 接口**保留**作为回退与兼容。

**不变**：D1 schema 主体、前端页面、认证、adopt 流程、任务表结构。

预计额外工作量：DO + WS 路由 ≈ 1–1.5 天；Agent WS 客户端（vendored）≈ 1–1.5 天；事件表 + 补齐逻辑 ≈ 1 天；测试（断线重连/部署断连/补发幂等）≈ 1 天。

---

## 7. 待决策

1. **是否采用 WS-first Hybrid？**（推荐；保留 HTTP 回退，不推翻现有设计）
2. **Agent 的 WS 客户端怎么来？**
   - A（推荐、保持零依赖）：vendored 一个最小 RFC6455 客户端，单文件 Python；
   - B：允许 `websockets` pip 依赖（安装脚本联网 pip）；
   - C：改用 Go 单二进制（顺带解决"单文件/易删除"的诉求，但重写成本高）。
3. **面板是否也要实时？** 建议先保持 15–30s 轮询（静态资源免费，API 量小），后续需要再给面板加 SSE/WS。
4. **心跳间隔**：WS 模式下 60s；HTTP 回退模式 30s。

---

## 8. 参考

- OpenAgents 仓库：<https://github.com/openagents-org/openagents>
- Cloudflare Durable Objects 定价：<https://developers.cloudflare.com/durable-objects/platform/pricing/>
- Cloudflare WebSocket/Hibernation：<https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
- Workers 免费额度：<https://developers.cloudflare.com/workers/platform/pricing/>
