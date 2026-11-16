# U5 host-ops 固定开销归因与消除（2026-11-16）

> 状态：证据（一次性验收记录，写完不再修改） ｜ 最后核验：2026-11-16
> 节点：`oracle-x86-2`（ubuntu@140.245.108.105），Agent **0.4.1 → 0.5.0**
> 关联：`ui-polish-u4-processes.md` §4（那里只记录、未定位）

## 1. 结论

**每个 `host-ops` 调用都启动一个新 Python 进程跑 124 KB 的 `khc-host` 脚本。**
这就是 U4 记录的那 120–180 ms「固定税」。

改成 self 路径**进程内调用**后：

| 动词 | 改前 | 改后（稳态） | 倍数 |
|---|---|---|---|
| `version` | 129–190 ms | **2.0–2.6 ms** | **约 70×** |
| `svc.list` | 132–191 ms | **7.3–8.8 ms** | 约 20× |
| `snapshot` | 381–411 ms | **17–76 ms** | 约 10× |
| `snapshot{processes}` | 263–289 ms | **135–196 ms** | 约 1.6× |
| `processes` | 241–286 ms | **119–171 ms** | 约 2× |

`snapshot{processes}` 与 `processes` 剩下的大头是 U4 那个 100 ms 采样窗口，属合理成本。

## 2. 归因过程（每一步都排除了一个猜测）

走了不少弯路，记下来避免以后重复：

| 猜测 | 实测 | 结论 |
|---|---|---|
| 反向 DNS（`address_string()`） | 3.1 ms 且带缓存 | 否 |
| 连接建立 / TLS | 8443 是明文 HTTP；`/health` 0.6 ms | 否 |
| 幂等落盘 | `version` 是只读，不进 `IdempotencyStore` | 否 |
| 写锁串行 | 只读动词不取锁 | 否 |
| 并发被 GIL 抢 | Agent 仅 3 线程、累计 CPU 1.6 s | 否 |
| 适配器重复实例化 | `handle_action` 内 0.00 ms | 否 |
| 模块重复加载 | `_khc_host_module()` 二次 0.001 ms、id 不变 | 否 |
| 审计写盘 | 内核里没有审计实现 | 否 |

**决定性对照**（全部在同一台机器、同一时刻）：

```
module.main("version")       0.035 ms     ← 模块已加载
kernel.handle_action(...)    122–180 ms
adapter.action_call(...)     125–174 ms
```

差值全部落在适配器那一层。读 `_dispatch_call` 看到：

```python
result = ctx.run([sys.executable, self.script_path(ctx), verb], ...)
```

再直接量脚本本身：

```
python3 -c pass                     12–23 ms      ← 解释器启动
echo '{}' | python3 khc-host version  83–185 ms   ← 加载脚本 + its imports
```

**结论成立**：83–185 ms 里，12–23 ms 是解释器，其余是加载 124 KB 脚本及其 import。

## 3. 改法

`agent/adapters/host_ops.py` 新增 `_call_host_script_in_process()`：
self 路径直接调模块的 `main()`，把返回的 dict 用 `serialize()` 转成 JSON 包进
`RunResult`。

**为什么包成 `RunResult`**：`_interpret_call()` 是从 `result.stdout` 解析 JSON 的。
这样下游（版本校验、错误映射、审计、`durationMs`）**一行都不用改**，两条路径行为完全一致 ——
这比「在中间加一层分支」安全得多。

### 3.1 状态目录必须显式覆盖

`khc_host.STATE_DIR`（以及 `CRON_DIR` / `PROC_ROOT`）在 **import 时**读环境变量后固化。
模块在 Agent 里长驻，不能假设它的值还是上次的样子。所以每次调用前显式对齐：

```python
module.STATE_DIR = state_dir   # = <data_dir>/fw-state，Agent 沙箱内 /etc 只读
module.PROC_ROOT = "/proc"
```

漏了这一步，写操作会去写 `/etc/khc-host`（沙箱只读）而失败 —— 这是本次最容易踩的坑。

### 3.2 回退策略：只对环境类错误回退

进程内执行可能被 Agent 沙箱限制（某动词要写的路径不在 `ReadWritePaths` 内），
而子进程走 sudo、权限模型不同。所以保留了子进程回退，但**只对这几类回退**：

```
E_NO_PRIV / E_UNSUPPORTED / E_SCRIPT_MISSING / E_IO / E_PERMISSION
```

**业务错误一律不回退**（参数非法、受保护单元、服务不存在）：子进程会给出完全一样的
答案，重跑只是把耗时翻倍，还会在审计里多一条记录。

## 4. 真机验证：8/8

```
[PASS] 只读 version 可用
[PASS] 冷启动 23ms（含模块加载）→ 稳态 2.0ms       稳态: ['2.2', '2.2', '2.0']
[PASS] 只读 svc.list 可用                          8.8 ms, 2 个服务
[PASS] 写动词 cron.set 在进程内成功                 8.6 ms
[PASS] 写入的内容能读回（说明真的落盘了）           dir=/etc/cron.d managed=['u5probe'] writable=True
[PASS] 清理成功                                    managed=[]
[PASS] processes 可用且有 CPU 数据                 119.3 ms, 5 个
[PASS] 受保护单元仍被拒                            E_PROTECTED: ssh.service
```

最后一条专门验证「业务错误不被回退掩盖」：受保护单元仍然如实报 `E_PROTECTED`。

**写操作真的落盘**（`cron.set` → `/etc/cron.d/u5probe` 能读回、能删），
说明状态目录覆盖是对的，沙箱没挡住。

### 4.1 Peer 路径未受影响

Peer 是另一台机器，无法进程内执行，仍走 SSH。相关 61 项测试全通过。

## 5. 测试

| 项 | 内容 |
|---|---|
| 新增 3 | 「self 不起子进程且参数照旧走 stdin」「环境类错误回退子进程」「业务错误不回退」 |
| 改 1 | `test_call_self_runs_local_script`：从「断言 ctx.run 参数」改成「断言不起 python3 子进程」 |
| 基建 | `AdapterRunner.run_in_process()` + `_INPROC_EXECUTOR` 注入点：测试不必真的起解释器 |

`_INPROC_EXECUTOR` 与 `khc_host` 的 `SLEEP`/`MONOTONIC` 同类做法 —— 让测试能控制这一层。

档位：Agent **1170 项**全绿。

## 6. 清理

```
/tmp/u50、khc-agent-0.5.0.tar.gz、各测试脚本  已删
/etc/cron.d/u5probe                          已删（验证后清理，确认 0 残留）
khc-agent active (0.5.0)、caddy active
```
