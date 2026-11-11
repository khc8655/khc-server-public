# khc-server v2（简化版）：按需连接 + 配置仓库

> **修订原因**：v1 设计（heartbeat 60s / desired 拉取 / WS 常连）是为"7×24 实时管控"准备的，和实际用法不匹配。
> 实际用法：面板**一个月打开约 10 次**，平时只当配置仓库；用的时候要**秒级响应、稳定**，不想等 60 秒。
> 本文件**取代 design-v1 的连接层**（§6/§7 的 Agent 协议部分）；数据模型、前端、安全模型继续沿用。

---

## 0. 一句话

**没有心跳、没有常驻连接、没有后台同步。** 控制面就是「配置仓库 + 按需 RPC 代理」：
打开面板时并发拉一次状态（2–3 秒），点"应用"时直接调 Hub 上的 Agent（1–2 秒），长任务异步 + 面板轮询。

---

## 1. 三条原则

1. **按需连接**：只在用户操作时发请求；面板关掉后，控制面和 Hub 之间**零流量**。
2. **配置为中心**：D1 是配置仓库（节点/Peer/暴露/应用/版本历史）；面板不打开也不影响 Hub 上服务运行。
3. **失败要快、要明确**：Hub 不可达时 3–8 秒内报错，绝不"等下一次同步"。

---

## 2. 架构

```
       ┌──────────────── Cloudflare Worker（控制面）────────────────┐
       │  Static Assets：React 面板                                  │
       │  /api/v1/*：配置 CRUD + 按需 RPC 代理 + 任务代理             │
       │  D1：nodes / peers / exposures / apps / revisions / audit    │
       │  （无 KV、无 R2、无 Durable Object、无 Cron、无 Queue）        │
       └───────────────┬─────────────────────────────────────────────┘
                       │ ① 面板打开：并发 GET /state（3s 超时）
                       │ ② 点应用：POST /apply /plan（8s 超时，重试 1 次）
                       │ ③ 长任务：POST /tasks → 轮询 GET /tasks/:id
                       ▼
       ┌────────────── Hub（3 台云 VM）──────────────────────────────┐
       │  khc-agent：单文件 Python HTTP 服务，监听 127.0.0.1:8787      │
       │  ← cloudflared 隧道（出站）→ https://<hub>.example.com       │
       │  职责：编译结果落地 / Caddy validate+reload / WG syncconf    │
       │        / 转发单元 / 应用安装任务 / 本地看门狗（纯本地）        │
       └──────────────────────────────────────────────────────────────┘
```

**唯一常驻进程**：Hub 上的 `khc-agent` + `cloudflared`（都是被动等待，不主动发请求，不占 Worker 额度）。
**面板不打开时**：Worker 请求量 = 0；Hub 上只有隧道保持一条出站连接（Cloudflare 免费，不产生请求）。

---

## 3. 交互时序

### 3.1 打开面板

```
浏览器 → GET /api/v1/nodes                        （D1，毫秒级）
浏览器 → GET /api/v1/status                       （Worker 并发扇出到 3 台 Hub /state，3s 超时）
   └─ 每台成功：更新 D1 last_seen；失败：该台标记 unreachable（不阻塞其他台）
浏览器渲染：节点在线状态、Peer 握手、Caddy 状态、证书到期
```

**目标：3 秒内看到全部节点状态**；某台挂了只影响它自己那行。

### 3.2 保存配置（不碰 Hub）

```
面板 → PUT /api/v1/nodes/:id/config → D1（+ revisions 版本快照）+ audit
```

### 3.3 预览与应用（关键路径，要快）

```
面板 → POST /api/v1/nodes/:id/plan      → Worker → Hub POST /plan
         Hub 编译结果与当前文件 diff，返回 { changes:[...], warnings:[...] }
用户确认 → POST /api/v1/nodes/:id/apply → Worker → Hub POST /apply
         Hub：validate → 原子写 → reload（失败回滚）→ 返回 { ok, rev, files, units }
```

- 超时 8s，网络错误自动重试 1 次（带幂等键 `rev`，重复 apply 无副作用）。
- 失败返回明确原因（例如 `caddy validate failed: line 12`），不吞错。

### 3.4 长任务（装应用 / 签证书 / 批量 Peer 推送）

```
面板 → POST /api/v1/nodes/:id/tasks {kind, params}
         Worker 转发 Hub → Hub 立即返回 taskId（后台线程执行）
面板 → GET /api/v1/tasks/:id（每 1s，最长 10 分钟）
         Worker 代理 Hub GET /tasks/:id → { state, progress, logs[], result }
完成 → 面板展示结果（登录地址/token 等）
```

只有任务运行期间才轮询，任务结束即停。

### 3.5 Peer 密钥轮换

```
面板 → POST /api/v1/nodes/:id/keys/rotate → Hub 生成新 key（本地），返回新公钥
     → D1 记录 key 版本；面板展示新的客户端配置/二维码
```

### 3.6 Hub 离线

```
任何按需请求在 3–8s 内失败 → 面板显示「Hub 不可达（最后在线 2 小时前）」+ 重试按钮
配置照常保存到 D1；Hub 恢复后再点「应用」即可。
```

不做"离线命令队列"——它会让系统变复杂，而且你 10 次/月的使用频率下，重试一次成本更低。

---

## 4. 为什么这样更快、更稳、更简单

| 维度 | 旧（heartbeat 轮询 / WS） | 本方案（按需直连） |
|---|---|---|
| 操作生效延迟 | 最多 60s（等心跳） | **1–2s**（直接调用） |
| 打开面板看到状态 | 依赖最近心跳（可能过期） | **3s 内实时扇出** |
| 闲置资源 | 每节点 1,440 请求/天 + 常驻连接 | **0 请求/天**（只有隧道静默连接） |
| 组件数 | Worker + D1 + DO + KV + Cron + WS | **Worker + D1 + 隧道** |
| 失败模式 | 连接状态机、重连风暴、部署断连 | 一次 HTTP 调用，超时即报错 |
| 代码量 | 协议 v2 + 任务租约 + 事件流 | 一个 RPC 客户端 + 一个单文件 Agent |
| 调试 | 心跳/desired/ack 三层 | `curl` 就能调，日志一眼看懂 |
| 免费额度 | 心跳占 10%+ | 用量只跟"打开次数"相关，可忽略 |

---

## 5. 组件与接口

### 5.1 Worker（控制面）

| 路由 | 说明 |
|---|---|
| `POST /api/v1/auth/login` / `logout` / `GET /me` | 维持 M1 已实现 |
| `GET/POST /api/v1/nodes`、`GET/PATCH/DELETE /api/v1/nodes/:id` | 维持 M1 |
| `GET/POST /api/v1/nodes/:id/peers`、`PATCH/DELETE /api/v1/peers/:id` | 维持 M1 |
| `GET/POST /api/v1/nodes/:id/exposures`、`PATCH/DELETE /api/v1/exposures/:id` | 维持 M1 |
| `GET /api/v1/status` | **新增**：并发扇出所有 Hub `/state`（3s 超时，单台失败不阻塞） |
| `POST /api/v1/nodes/:id/plan` | **新增**：代理 Hub `/plan` |
| `POST /api/v1/nodes/:id/apply` | **新增**：代理 Hub `/apply`（幂等 rev） |
| `POST /api/v1/nodes/:id/tasks` | **新增**：创建异步任务 |
| `GET /api/v1/tasks/:id` | **新增**：代理 Hub 任务状态/日志 |
| `POST /api/v1/nodes/:id/keys/rotate` | **新增**：代理 Hub 轮换 key |
| `GET /api/v1/nodes/:id/export` | **新增**：导出当前 Hub 配置（接管/备份用） |
| `GET/PUT /api/v1/nodes/:id/revisions` | 配置版本历史（D1） |

### 5.2 Agent（Hub 上，单文件 Python）

| 端点 | 说明 |
|---|---|
| `GET /health` | 无鉴权，仅 `{ok,version}`（隧道探活） |
| `GET /state` | WG peers/握手、Caddy 状态、转发单元、证书到期、磁盘/内存 |
| `POST /plan` | `{manifest}` → 与现网 diff（不落盘） |
| `POST /apply` | `{manifest, expectRev}` → validate/原子写/reload/回滚，返回结果 |
| `POST /tasks` | `{kind, params}` → `{taskId}`（后台线程） |
| `GET /tasks/:id` | `{state, progress, logs[], result, error}` |
| `POST /keys/rotate` | 轮换指定 key，返回新公钥 |
| `GET /export` | 当前配置快照（用于接管/备份） |
| `POST /uninstall` | 清理自身（保留用户数据） |

鉴权：`Authorization: Bearer <node-token>`（每节点独立，D1 存哈希）。
监听：`127.0.0.1:8787`；对外只通过 **cloudflared 隧道** 暴露 HTTPS（无公网管理端口）。
本地看门狗：每 5 分钟检查 WG/Caddy/转发存活，**纯本地操作，不发网络请求**。

### 5.3 D1（在 M1 schema 上增量）

```sql
-- 配置版本历史（"仓库"感）
CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  manifest_json TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_revisions_node ON revisions(node_id, rev DESC);

-- 节点最近一次成功接触（替代 heartbeat 做"最后在线"展示）
ALTER TABLE nodes ADD COLUMN last_seen_at INTEGER;
ALTER TABLE nodes ADD COLUMN last_status_json TEXT;
```

任务表复用 M1 的 `tasks` / `task_events`，但语义改为"按需任务"（无租约、无队列）。

---

## 6. Agent 形态（继续 Python 单文件，满足"好删"）

```
/opt/khc-agent/khc-agent            # 单个可执行 Python 文件（stdlib only）
/etc/khc-agent/agent.env            # NODE_ID / AGENT_TOKEN / CONFIG_DIR
/var/lib/khc-agent/                 # 状态、任务日志、缓存
/etc/systemd/system/khc-agent.service
/etc/systemd/system/khc-agent-tunnel.service   # cloudflared（出站隧道）
```

- 安装：`curl -fsSL https://<console>/install.sh | sudo sh`
- 卸载：`khc-agent uninstall --purge`（一条命令清 unit + 二进制 + 数据）
- 依赖：系统自带 Python 3 + cloudflared 单二进制；**无 pip 依赖、无数据库、无守护端口暴露**。

---

## 7. 代码取舍（M1 不推翻）

| M1 已有 | 处理 |
|---|---|
| Worker + Hono + D1 + 迁移 | **保留** |
| 登录 / Cookie 会话 / 限流 | **保留** |
| Nodes / Peers / Exposures CRUD + 契约 | **保留** |
| React 前端骨架 / 登录页 / 节点页 | **保留并扩展**（状态页、配置页、任务页） |
| `tests`（23 项） | **保留**，新增 RPC 代理/状态扇出/任务测试 |
| 原设计的 heartbeat/desired/DO/WS/actor | **不做**（从路线图删除） |

新增代码量估计：
- Worker：RPC 代理 + 状态扇出 + 任务代理 + revisions ≈ 1 天
- Agent：单文件（复用旧 agent 的 WG/Caddy/转发逻辑，删掉 acme 长流程或改成任务）≈ 2–3 天
- 前端：状态页 / 配置页 / 应用安装向导 / 任务日志 ≈ 2–3 天
- 测试 + 真机验证（用已开好的测试 VM）≈ 1–2 天

---

## 8. 里程碑（简化成两个）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **S1 控制面 + 直连** | Worker RPC 代理、状态扇出、revisions；单文件 Agent（health/state/plan/apply）；隧道 | 打开面板 3s 内看到 3 台 Hub 状态；点应用 2s 内返回并生效 |
| **S2 应用与密钥** | 任务系统（装应用/证书）、Peer 密钥轮换、导出/接管、配置版本回滚 | 在测试 VM 上一键装应用并展示登录地址/token；坏配置可回滚 |

---

## 9. 待确认

1. **Hub 暴露方式**：Cloudflare Tunnel（推荐，免公网管理端口）还是公网端口 + token（少一个进程，但暴露端口）？
2. **Agent 语言**：单文件 Python（推荐，复用现有逻辑）还是 Go 单文件？
3. **长任务交互**：异步任务 + 面板轮询（推荐）还是同步等待（实现更简单，但慢任务会超时）？
4. **配置历史**：是否要保留每次 apply 的版本与一键回滚（"仓库"感更强）？
5. **应用安装结果**：只展示（登录地址/账号/token）即可，还是也要"一键打开/复制/二维码"？
