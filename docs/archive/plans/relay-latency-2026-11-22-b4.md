# B4 开工说明：Agent 单适配器截止时间

> 状态：已实施 ｜ 最后核验：2026-11-23 ｜ 关联：`docs/archive/plans/relay-latency-2026-11-22.md` §4 B4、`agent/README.md`

> **给开发 agent**：本文是 B4 的完整任务说明。开工前读 `AGENTS.md`、提案、`agent/README.md`、本文全文。偏离本文的地方在 PR 里写明原因；认为本文有误时在 PR 里提出，不要改 `docs/plans/` 下的文件。

## 0. 速览

| 项 | 值 |
|---|---|
| 分支 | `feat/agent-status-deadline`（从最新 `main` 拉） |
| PR 标题 | `feat(agent): 适配器状态采集截止时间与过期兜底` |
| 发版类型 | G（Agent 内核），Agent **patch**；面板不 bump |
| 截止时间默认值 | **2s**（已拍板），`--status-deadline` 可调 |

## 1. 目标

`/state` 不再被最慢的适配器拖住：所有适配器的 `status()` 共用一个截止时间，到点还没返回的，用它上次成功的结果并标明过期；后台继续跑完，下次请求就是新结果。

## 2. 现状（已核实）

- `agent/khc/kernel.py:577` `adapter_state_entries`：只有 1 个适配器时同步调用；多个时 `with ThreadPoolExecutor(max_workers=min(8, n))` 并发后按注册顺序 `future.result()`。`with` 退出会等全部线程，最慢的适配器决定 `/state` 耗时。
- 单个适配器异常时返回 `{"error": str(exc)}`（这个形状前端已经能处理）。
- `agent/khc/state.py:143` `build_state` 调用它；`/snapshot` 不调用。
- 契约 `adapterStateSchema.status` 是 `z.record(z.string(), z.unknown())`，在 `status` 内加字段无需改契约；前端没有枚举 `status` 全部键的代码（已核实），新增字段不会被意外渲染。
- Agent 要求 Python ≥ 3.11（`agent/install.sh`），只用标准库。
- 入口 `agent/khc_agent.py:122` `Kernel(paths, adapters, version=VERSION)`；`run` 子命令的参数在同文件 `run.add_argument(...)`。

## 3. 设计

### 3.1 接口

- `Kernel.__init__` 新增关键字参数 `status_deadline: float = 2.0`。`≤ 0` 表示关闭截止时间，退回现在的行为（并发后全部等完）。
- `khc_agent.py` 的 `run` 增加 `--status-deadline <秒>`（`float`，默认 2.0），传给 `Kernel`。`install.sh` 与 systemd unit **不改**，默认值即生效。

### 3.2 算法

内核维护两张表（受同一把 `threading.Lock` 保护）：

- `_status_cache: dict[name, (status: dict, at: float)]`：每个适配器**上次成功**的结果与时间（`self.clock()`，Unix 秒）。
- `_status_inflight: dict[name, Job]`：正在跑的采集；`Job` 含 `threading.Event` 与结果槽。

`adapter_state_entries()`：

1. 对每个适配器：在途里已有就复用同一个 `Job`；没有就新建 `Job` 并启动一个**守护线程**（`daemon=True`，名为 `khc-status-<name>`）跑 `status()`。
2. 计算**一个共享截止点**：`deadline = time.monotonic() + status_deadline`。按注册顺序逐个 `event.wait(max(0, deadline - time.monotonic()))`。总等待时间 ≤ 截止时间，不是每个适配器各等 2s。
3. 每个适配器的结果：
   - 按时完成且成功：用新结果。
   - 按时完成但抛异常：返回 `{"error": str(exc)}`（与现在一致），**不覆盖**上次成功的缓存。
   - 超时且有缓存：返回缓存的**副本**，附 `"stale": {"since": int(上次成功时间), "reason": "timeout"}`。
   - 超时且无缓存（首次）：返回 `{"error": "status timeout", "pending": True}`。
4. 线程结束时：成功则写缓存；无论成败都从在途表移除并 `set()` 事件。
5. `name`、`version`、`appliedRev` 每次现取，不进缓存。`status()` 返回非 `dict` 时沿用现在的 `{"value": …}` 包装。

### 3.3 为什么用守护线程而不是线程池

`ThreadPoolExecutor` 的工作线程不是守护线程，解释器退出时会等它们结束。一个卡死的 `status()` 会让 Agent 停止、重启、远程升级都卡住，直到 systemd 超时强杀。守护线程 + 在途去重（每个适配器最多 1 个线程）既有界又不阻塞退出。

## 4. 范围与禁止

- 允许：`agent/khc/kernel.py`、`agent/khc_agent.py`、`agent/khc/util.py`（`VERSION`）、`agent/tests/`、`agent/README.md`、`CHANGELOG.md`。
- 禁止：任何适配器文件（`agent/adapters/`）、`MIN_PANEL_VERSION`、契约、Worker、前端、`install.sh`。`agent/khc/` 里不得出现具体应用名。
- 核心冻结说明（PR 必写）：`kernel.py` 属 Agent 内核；必要性是 `/state` 被单个慢适配器阻塞（提案 R7），改动不涉及任何应用知识。

## 5. 测试（`agent/tests/test_kernel.py` 或新增 `test_status_deadline.py`）

用假适配器：`status()` 内 `threading.Event().wait()` 阻塞、可控释放；截止时间取 0.05–0.2s 以保证速度；不依赖 root、不联网。

1. 先成功一次形成缓存，再让它阻塞：调用在 截止时间 + 0.2s 内返回，结果是缓存副本 + `stale.since` 等于上次成功时间、`reason == "timeout"`。
2. 首次就阻塞：返回 `{"error": "status timeout", "pending": True}`。
3. 在途去重：阻塞期间连续调用 3 次，`status()` 实际只被调用 1 次。
4. 释放后：再次调用拿到新结果，没有 `stale`。
5. 共享截止点：3 个适配器都阻塞时，总耗时 ≈ 1 个截止时间，不是 3 个。
6. 正常适配器不受慢适配器影响，返回顺序与注册顺序一致。
7. 抛异常的适配器返回 `{"error": …}`，且之后超时时 `stale` 仍是更早那次成功的结果。
8. 缓存副本被调用方修改不影响缓存（返回的是拷贝）。
9. 采集线程是守护线程（`threading.enumerate()` 里按名字找到并断言 `daemon`）。
10. `status_deadline <= 0` 退回旧行为（全部等完）。
11. CLI：`--status-deadline 0.5` 解析后传入 `Kernel`（参照 `test_cli.py` 写法）；缺省为 2.0。
12. HTTP 层：慢适配器下 `GET /state` 仍 200 且耗时受限（参照 `test_state.py` / `test_http.py` 夹具）。

现有 Agent 测试全部通过（`python3 -m unittest discover -s agent/tests -t agent`）。

## 6. 坑

1. **别用 `with ThreadPoolExecutor`**：退出时会等全部线程，截止时间形同虚设（这正是现在的问题）。
2. **共享截止点**：逐个 `wait(2s)` 会变成 2s × N。
3. **返回副本**：直接把缓存里的 dict 挂上 `stale` 会污染缓存。
4. **异常不写缓存**：否则下次超时会把错误当成「上次成功」。
5. **升级看门狗**：远程升级后看门狗用 `/state` 自检（`agent/khc/http.py` 注释里 0.1.21 的教训）。自检只看可达性与 200，确认截止时间不会让它误判；PR 里写明核对结果。
6. caddy 站点适配器已有自己的 SWR 缓存（`siteHealth`），与内核截止时间叠加没有问题，不要改适配器。

## 7. 文档

- `agent/README.md` 适配器契约一节补充：`status()` 应尽快返回；超过内核截止时间（默认 2s，`--status-deadline`）会被返回上次成功结果并附 `stale`，首次超时返回 `{"error": "status timeout", "pending": true}`；不保证每次调用都等它跑完。
- `CHANGELOG.md`：照 PR #137 的先例，不 bump 面板，在当前最新版本段追加一条，例如「Agent `0.7.x`：单个应用状态采集超过 2 秒时先返回上次结果，节点状态不再被慢应用拖住。」（版本号以实际 bump 为准。）

## 8. 版本

`agent/khc/util.py` 的 `VERSION` patch bump；`MIN_PANEL_VERSION` 不变（新字段旧面板忽略）。打包签名由 CI 完成（`release.md` §3.2）。

## 9. 交付证据（G 类，`docs/engineering/testing.md` §5）

1. `./scripts/verify.sh` 全绿（含 Agent 单测与发版一致性）。
2. 先升级 1 台测试节点，再滚动到其余节点；带异常站点的 `unicom-cn-1` 必须在内。
3. 升级前后用 `scripts/relay-latency-baseline.mjs --node <id>` 测 `/state`（与 B1 同入口、各 10 次中位数），对比写进 PR；验收：`/state` 中位数 ≤ 截止时间 + 网络 RTT。
4. 在测试节点上对一个 `ux-*` 测试站点做 plan → apply → 回滚，确认写路径不受影响。
5. 远程升级一次、回滚一次，看门狗自检通过；`systemctl restart khc-agent` 不被卡住（贴耗时）。

## 10. 审核清单（设计任务逐条核对）

- [ ] 只改允许的文件；`agent/khc/` 无应用名；`MIN_PANEL_VERSION` 未动
- [ ] 守护线程 + 在途去重；没有 `with ThreadPoolExecutor`
- [ ] 共享截止点；返回副本；异常不写缓存
- [ ] 首次超时形状与 `stale` 形状与本文一致
- [ ] 测试 1–12 齐全，现有测试未改断言
- [ ] `agent/README.md`、CHANGELOG、`VERSION` 已更新
- [ ] 真机证据：前后 `/state` 对比、plan→apply→回滚、升级 / 回滚、重启耗时
