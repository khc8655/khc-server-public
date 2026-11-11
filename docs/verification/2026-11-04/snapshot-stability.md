# 10s 快照轮询稳定性验证（2026-11-04）

- 状态：验证记录（**验证分支，未合并、未部署生产**）
- 适用范围：ADR-0010 方案 A——Agent `/snapshot`、Worker 转发、前端 `SnapshotLoop` 与可见性/上限行为
- 最后核验：2026-11-04
- 关联：`docs/engineering/adr/ADR-0010-snapshot-polling.md`、`docs/live-observation.md` §8、`docs/data-layering.md`

## 1. 结论

**达到「可稳定使用」标准（验证分支范围内）**，但有 5 项遗留风险需要在合入前/后确认（见 §6）。

- 轮询节奏稳定：可见时请求间隔集中在 10s，无突发；隐藏后增量 0；切回只恢复一个循环。
- 硬上限正确：60 次到顶后停表并保留手动刷新，手动刷新只补 1 次、不重启循环。
- 资源无异常：Agent 进程 CPU 约 0.044% 单核、RSS 34.1 MiB 全程不变；浏览器堆在 300 次轮询内无增长。
- 异常可恢复：Agent 重启后 20s（≤2 个轮询周期）自动恢复，无需刷新页面。
- 准确性可接受：CPU 与 `top`/`/proc/stat` 同口径一致（含 steal），内存与 `free` 一致，磁盘与 `df` 一致；首采在单核负载下 **50.5%**，空闲时 0.0–0.1% 与 `/proc/stat` 同量级（属真实空闲，不是缺历史造成的假 0）。
- `./scripts/verify.sh` 全绿：前端/Worker 470 项、Agent 897 项。

## 2. 实现范围（本分支）

| 层 | 变更 | 关键文件 |
|---|---|---|
| Agent | 新增 HMAC `GET /snapshot`；只读 `/proc`/`statvfs`，CPU 计数器差分，首次/过久/过快时请求内双采样 1 秒；无常驻线程/定时器 | `agent/khc/ops.py`、`agent/khc/state.py`、`agent/khc/http.py` |
| Agent 观测层 | `GET /_live/snapshot?ticket=`（scope=`snap`，15 分钟可复用）；CORS + `Access-Control-Max-Age: 600` + `no-store` | `agent/khc/live.py`、`agent/khc_agent.py` |
| Worker | `POST /nodes/:id/live-ticket` 支持 `snap`；`GET /nodes/:id/snapshot` 转发（5s 超时、同节点 2s 去重、`lastSeenAt` 最多 1 次/分钟） | `apps/api/src/routes/live.ts`、`apps/api/src/routes/snapshot.ts` |
| 前端 | `SnapshotLoop`：打开拉 1 次、可见 10s、隐藏停、60 次/10 分钟上限、手动刷新、120 点环形缓冲；单次请求 8s 硬超时；只有 HTTPS 入口直连，http/IP 覆盖值走转发；SSE 前端引用停用（代码保留不可达） | `apps/web/src/data/snapshot.ts`、`apps/web/src/data/channels.ts` |
| UI | 状态带文案 `实时（10s）` / `无域名 · 仅快照` / `已停止自动刷新 · 数据截至 xx:xx`；沿用既有组件，无新页面范式/导航层级 | `HubChannelsProvider.tsx`、`HubOpsPage.tsx`、`HubOverviewPage.tsx` |

## 3. 测试环境与方法

- 测试机：Oracle Cloud `node-test-2`（2 vCPU / 954 MiB，Ubuntu），**使用的临时 Agent 位于 `/tmp/khc-snap`、控制端口 8897、观测端口 8898，经 SSH 隧道访问；未改动同机生产 Agent（端口 8443）**。
- 分支未部署：所有直连测试使用本地签发的 `snap` ticket 访问临时 Agent；Worker 转发路径由单元测试覆盖，Worker 请求数按路由逐次计数推导。
- 时钟：2026-11-04 19:32–20:30（Asia/Shanghai），连续运行约 60 分钟。
- 采样：Agent 进程每 60s 记录 `/proc/<pid>/stat` 的 `utime+stime`、RSS、线程数；浏览器侧用真实 Chromium 跑 `SnapshotLoop`（mock fetch）并每 1s 记录 `performance.memory`。

## 4. 实测结果

### 4.1 可见节奏（关闭上限的压力测试，连续 30 分钟）

> 生产默认 10 分钟/60 次上限；本节为验证定时器长期不漂移，harness 显式放宽上限，故能跑满 30 分钟。

| 指标 | 结果 |
|---|---|
| 计划间隔 | 10 000 ms |
| 实测请求数（含首拉） | 181 |
| 平均间隔 / 最小 / 最大 | 10 002 / 9 991 / 10 004 ms |
| >12s 的间隔 | 0 |
| 失败请求 | 0 |
| 快照 CPU 区间 | 0–5.9%（主机侧活动尖峰；轮询本身未造成持续占用） |

### 4.2 隐藏 30 分钟与切回

| 阶段 | 请求增量 | 结论 |
|---|---|---|
| 可见 35s（预热） | 4（首拉 + 3 次 10s） | 节奏正常 |
| 隐藏 30 分钟 | **0** | 定时器立即停止；期间最长无请求间隔 1 805 004 ms |
| 切回可见 65s | 7（首拉 + 6 次 10s） | 恢复单个循环，无叠加 |
| 4 次显示/隐藏快速切换后再等 40s | 4 | 只有一个计时器在跑 |
| 全程失败请求 | 0 | — |

### 4.3 60 次硬上限（主 harness，可见 30 分钟窗口）

| 指标 | 结果 |
|---|---|
| 可见 30 分钟窗口实际请求数 | **60**（首拉 + 59 次 10s） |
| 到达上限的时刻 | 约第 9 分 50 秒（60 次），之后停表 |
| 到顶后至窗口结束（约 20 分钟）增量 | **0** |
| 手动刷新 | **+1**（`manualPolls=61`），不重启自动循环 |
| 停表后切回可见（65s） | **0**（`resumeAutoDelta=0`） |
| 隐藏 30 分钟增量（停表后） | **0** |

### 4.4 多标签页

| 场景 | 请求数 | 说明 |
|---|---|---|
| 两个直连标签页并行 60s（旧实现，未共享） | **12**（每个 6 次） | 旧实现每标签各自 10s；本分支已改为 BroadcastChannel 共享（见 §8.4） |
| Worker 转发同节点 2s 内并发 | 1 次 Agent 调用 / 2 次 Worker 请求 | 单元测试断言（`apps/api/test/snapshot.test.ts`）；仅代表单 isolate |
| Worker 转发错峰（>2s） | 2 次 Agent 调用 | 去重窗口只覆盖并发；错峰标签页仍各自请求 |

### 4.5 Worker 请求数（推导，分支未部署）

| 路径 | 每次会话（10 分钟上限） | 说明 |
|---|---|---|
| 有域名直连 | 1 次签票 + 0 次轮询 | snap 票 15 分钟复用；ticket 到期前 30s 才续签 |
| 无域名转发 | ≤60 次 `GET /snapshot` | 打开 1 次 + 每 10s 1 次，到 60 次停 |
| 打开工作区重数据 | 1 次 `GET /state` | 不随 10s 轮询；服务/进程/适配器不在快照内 |
| D1 写 | ≤1 次/分钟（`lastSeenAt`） | 10 分钟会话 ≤10 次，停表后 0 |

### 4.6 Agent 资源

| 指标 | 结果 |
|---|---|
| CPU（`utime+stime`，60 分钟） | 157 ticks / 3 541 s ≈ **0.044% 单核**（含 2–3 路并行轮询） |
| RSS | 34 952 KB（≈34.1 MiB）全程不变；启动峰值 34 956 KB |
| 线程数 | 2（启动后稳定，无常驻采集线程） |

### 4.7 浏览器内存

| 指标 | 结果 |
|---|---|
| 轮询次数 | 300（maxPolls 上限） |
| `performance.memory.usedJSHeapSize` | 5641 KB，全程 spread 0 KB |
| 环形缓冲 | 120 点，未增长 |

> 说明：无头 Chromium 的 `performance.memory` 是量化值；本项用于排除明显泄漏，不能替代 DevTools 逐对象快照。

### 4.8 异常恢复

| 场景 | 结果 |
|---|---|
| 精确 PID 停止临时 Agent 18s | 失败 2 次（间隔 10s），无并发/立即重试 |
| 重启 Agent 后自动恢复 | 7 次成功 / 70s；首个成功在重启命令后 **20.0s**（≤2 个轮询周期） |
| 恢复后首帧 | 保留上一帧至首成功；状态回到 `live`，未重复叠加循环 |
| 新进程首个快照（另一轮，单核 burn 下） | CPU **50.5%**，未出现 0% 或离谱值 |
| 停表后 Agent 恢复 | 不自动重启轮询，等待手动刷新（符合上限设计） |

### 4.9 准确性对照

| 指标 | 快照值 | 实测对照 | 偏差 |
|---|---|---|---|
| CPU（单核 burn，2 vCPU） | 50.2 / 50.3 / 50.8 / 50.9% | `/proc/stat` 5s 差分 49.9%；`top` 非 idle 52.4%（us+sy+st） | ≤2.2pp |
| CPU（空闲） | 0.7%（另一次 0.0%） | `/proc/stat` 5s 差分 0.1% | 采样窗口不同，量级一致 |
| 首次采样（新进程 + 单核 burn） | **50.5%** | `/proc/stat` 49.9% | 0.6pp；内部 1s 双采样生效 |
| 首次采样（新进程 + 空闲） | 0.0% | `/proc/stat` 0.1% | 真实空闲值，非缺历史导致的 0 |
| 内存 | 45.7%（used 456 970 240 B） | `free` 434/954 MiB ≈45.5% | 0.2pp |
| 磁盘 `/` | 10.1% | `df` 11% | 0.9pp（块口径） |
| 负载 | 0.00 / 0.04 / 0.05 | `uptime` 一致 | — |

## 5. 判定标准

| 标准 | 阈值 | 结果 |
|---|---|---|
| 可见节奏 | 间隔 9.5–10.5s，无连发 | 通过 |
| 隐藏 | 30 分钟增量 0 | 通过 |
| 切回 | 不叠加循环，增量≈1/10s | 通过 |
| 上限 | 60 次后停表，手动 +1 | 通过 |
| Agent 资源 | RSS 增长 <5%，CPU <2% 单核 | 通过 |
| 浏览器内存 | 300 次轮询堆增长 <500 KB | 通过 |
| 异常恢复 | 重启后 ≤2 个轮询周期恢复 | 通过 |
| 准确性 | CPU ±3pp、内存/磁盘 ±2pp | 通过 |
| 首采准确性 | 单核负载下首采 ≥40% 且与 `/proc/stat` 差 ≤3pp；空闲时不得出现假 0 | 通过（50.5% vs 49.9%；空闲 0.0% 为真实值） |
| 测试 | `./scripts/verify.sh` 全绿 | 通过 |

## 6. 遗留风险

1. **直连多标签已共享（本分支）**：同源标签页经 BroadcastChannel 由 leader 独占请求，
   非 leader 只读广播值；leader 关闭后存活标签接管，全部隐藏时停表。单测覆盖，
   尚未在预览/真机做多标签联调（§8.4）。
2. **Worker 转发去重只覆盖单 isolate 内的 2s 并发**：跨 isolate / 冷启动 / 错峰标签页
   仍各自触发 Worker 请求与 Agent 采集；Worker 请求数会随标签页成倍，但每次会话仍有
   60 次硬上限。不承诺多标签不放大。
3. **失败也计入 60 次上限**：Agent 长时间不可用（>10 分钟）后轮询会停表，恢复后需手动刷新。这是为了避免无限重试消耗配额的有意取舍。
4. **预览 E2E 只覆盖部分项**：已在 `wrangler versions upload` 预览版本上复核直连/转发/CORS/可见 10s/隐藏 0 增量；10 分钟停表文案、2s 去重命中、断线恢复未能预览实测（原因见 §8.2）。
5. **`performance.memory` 量化**：浏览器内存结论只排除明显泄漏，未做 DevTools 堆快照；如需强结论，合入前补一次 10 分钟 DevTools Memory 面板录制。

## 7. 复现要点

- 全量测试：`./scripts/verify.sh`。
- 测试机临时 Agent（非生产）：`khc_agent.py run --host 127.0.0.1 --port 8897 --live-host 127.0.0.1 --live-port 8898 --token-file <tmp>/token --live-origins http://localhost:5173`，本地 SSH 隧道 `-L 18897:127.0.0.1:8897 -L 18898:127.0.0.1:8898`。
- 直连 harness 直接复用 `apps/web/src/data/snapshot.ts` 的 `SnapshotLoop`（fetch 走隧道，snap ticket 每 15 分钟前滚动续签），不经过 Worker。
- 浏览器内存页用 esbuild 把 `SnapshotLoop` 打成一个本地页面，300 次轮询、每 1s 读 `performance.memory`。
- 本次验证的临时脚本只在测试机/本机 `/tmp`，未入库；测试后已删除临时 Agent、隧道与临时文件。

## 8. 预览环境 E2E（真实 Worker + 真实 Agent）

- 预览地址：`https://snap-preview-<worker-name>.<account>.workers.dev`
  （`npx wrangler versions upload --preview-alias snap-preview`，版本 `147b1a2b`；**未切换生产流量**）。
- 临时节点 `nd_xxxxxxxxxxxxxxxx`（`preview-snap-e2e`，仅用于本轮，验证后删除）；
  Agent 在本机运行（控制 8897 / 观测 8898，`/proc` 指标为合成值），两条 cloudflared 隧道后各接一个
  计数代理，用于区分「Worker 转发」与「浏览器直连」的请求时刻。
- 截图（浅/深）：`docs/verification/2026-11-04/browser/snapshot-ui/node-overview-light.png`、
  `node-overview-dark.png`；390×844：`node-overview-390-light.png`、`node-overview-390-dark.png`。

### 8.1 结果

| 项 | 结果 | 证据 |
|---|---|---|
| 直连：简单 GET 不触发预检 | 通过 | 浏览器网络记录 0 次 OPTIONS；Agent `OPTIONS` 返回 204 + `Access-Control-Max-Age: 600`（curl，预览 origin 在白名单） |
| 直连：短票放 query | 通过 | 1 次 `POST /api/v1/nodes/:id/live-ticket`；随后 `GET https://<隧道>/_live/snapshot?ticket=…` |
| 直连：Worker 轮询请求为 0 | 通过（修复后） | 修复前每次打开多 1 次 `GET /nodes/:id/snapshot`（首帧 `liveEndpoint=undefined` 先走转发）；修复后同一操作只剩 2 次 `/state` + 1 次 `live-ticket`（提交 `c43ecf2`） |
| 转发模式文案与数据 | 通过 | 「无域名 · 仅快照 · 最近 11-04 23:32」；CPU 50.0%、内存 41%、磁盘 63/64% |
| 可见时 10s 节奏 | 通过 | 单标签页 23:41:00.289 → 23:41:09.760 → 23:41:19.444 → 23:41:29.114 → 23:41:40.018（9.47/9.68/9.67/10.90s） |
| 隐藏标签页 0 增量 | 通过 | 23:33:49 首拉后 60s 增量 0；23:40:11 首拉后 49s 增量 0 |
| 切回前台不叠加 | 通过（间接） | 可见后同一标签页维持单条 10s 序列；未出现同一页面 2 倍频率 |
| 转发 2s 去重 | **未通过（未命中）** | 3 次「两请求并发」尝试均产生 2 次 Agent `/snapshot`（相隔 0.84–1.48s），响应无 `cached`；单测（单 isolate）通过。低流量并发可能落在不同 Worker isolate，内存 Map 不共享 |
| 10 分钟停表文案 | **预览未能实测** | 自动化标签页会话 ≤60s 且常为 `hidden`，无法把同一可见页面保持到 10 分钟再读回；§4.3 已用真实 Chromium 跑满 60 次并停表，文案由 `zh.snapshot.stoppedAt` 覆盖 |
| 断线恢复 | 预览未复测 | 受同一页面生命周期限制；§4.8 已在真机验证（重启后 20.0s 恢复） |
| 390×844 视口（浅/深） | 通过（布局） | CDP `Emulation.setDeviceMetricsOverride`，实测 `innerWidth=390`；截图 `snapshot-ui/node-overview-390-{light,dark}.png`。预览版本仍下发 Agent 0.1.14，页面显示「快照刷新失败」属预期，仅用于响应式布局核对 |

### 8.2 卡点说明

- **10 分钟停表**：`document.hidden` 在自动化标签页中常为 `true`；页面一旦关闭/被回收就无法再读，
  因而无法在预览里等到同一页面到达上限。没有伪造该结果。
- **2s 去重**：并发请求由页面脚本同时发出，但 Worker 侧未返回 `cached` 且 Agent 收到两次调用。
  可能原因：两次请求落在不同 isolate（内存 Map 不共享）或实际到达时间超出窗口。已在 ADR-0010 /
  `docs/live-observation.md` 把该去重标注为「单 isolate、尽力而为」，不宣称多标签不放大采集。
- **390 截图**：内置浏览器的视口模拟不可用；本轮改用 ego-browser 的 CDP
  `Emulation.setDeviceMetricsOverride` 取得真实 390×844（非缩放），实测
  `window.innerWidth=390` 后截图，浅/深两张已附。
- **多标签干扰**：预览期间自动化会话留下了重复标签页，直连日志出现 10s 节奏的成对请求；
  属「每个标签页各自 10s」，不是单页面叠加循环（§6.1 已记录该风险）。

### 8.3 本轮请求量（预览版本，不含本地 Agent 单测）

| 类别 | 次数 | 说明 |
|---|---|---|
| Worker 转发 `/snapshot` | 24 | 含首轮脚本重试 15 次；修复后直连页面为 0 |
| Worker `/state`（打开工作区） | ≈26 | 每次打开 2 次，含重复加载 |
| Worker `live-ticket` | 5 | 每次直连页面打开 1 次 |
| **Worker 合计** | **≈55** | 处于「几十」量级 |
| 浏览器直连 Agent `/_live/snapshot` | 74 | 不占 Worker、不写 D1；含可见标签页约 5 分钟的 10s 轮询与重复标签页 |

计数来自本地计数代理（query 已剥离）；部分阶段日志清理后按阶段累加，±3 次误差。

### 8.4 多标签共享单测（本分支新增）

`apps/web/src/data/snapshot-shared.test.ts`（FakeBus + FakeChannel + fake timers）：

| 用例 | 断言 | 结果 |
|---|---|---|
| 两个标签只发一路请求 | 30s 内两标签请求合计 4 次、至少一方恒为 0；follower 仍拿到广播快照 | 通过 |
| leader 退出后接管 | A 首拉 1 次后 `stop()`，B 在剩余间隔续上（10s +1、再 10s +1），A 保持 1 | 通过 |
| 全部隐藏时停止 | 两标签均隐藏后 60s 增量 0；任一标签恢复可见立即补 1 次并回 10s 节奏 | 通过 |

转发模式不启用 BroadcastChannel；其 2s 去重仍只代表单 isolate 内尽力而为，
跨 isolate 不保证（预览实测未命中，见 §8.1/§8.2）。
