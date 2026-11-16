# host-ops 只读动词被写锁拒绝：修复与真机验证（2026-11-16）

> 状态：证据（一次性验收记录，写完不再修改） ｜ 最后核验：2026-11-16 ｜ 关联：`docs/host-ops.md`、PR #63

## 1. 症状

主机运维页随机出现「操作失败，请稍后重试」，展开详情为：

```
code: busy
message: 节点正在执行写动作（应用 host-ops 的请求被节点级写锁拒绝），请稍后重试
```

每次刷新位置不同，点「重试」有时成功。服务列表整片骨架屏，非确定性。

## 2. 根因

`HostOps.actions` 把 `call` / `call_task` 整条标成 `write: True`，而适配器**没有实现**
基类预设的 `is_write(action, body, meta)` 钩子（`agent/khc/adapters.py` 里该钩子的
文档字符串恰好就以「host-ops 的 call 读动词」举例，但一直没落地）。

后果链：

1. 内核 `_is_write` 落到默认分支，`call` 一律当写动作；
2. 写动作要求 `idempotencyKey`，且要抢节点级写锁（`_acquire_write`，`acquire(blocking=False)`）；
3. 页面进入时并发发起多个只读 verb（`svc.list` / `snapshot` / `version` / `fw.show` …），
   后到者拿不到锁 → `409 busy`；
4. Worker 原样透传 Agent 状态码与 code，前端字典里没有 `busy`，
   `hostOpsErrorTitle` 兜到 `E_UNKNOWN` → 「操作失败，请稍后重试」。

旁证：前端 4 处代码写着「call 是 Agent 写锁动作；读动词也串行，避免并发拿不到锁」
（`OpsSegments.tsx` / `FirewallDrawer.tsx` / `FirewallSegment.tsx` / `SshKeysDrawer.tsx`），
即绕行注释。旧单测 `test_task_holds_write_lock_until_done` 的注释写「读动作不受影响」，
断言却是只读 verb 必须 `Busy` —— 缺陷被测试固定了下来。

## 3. 修复

| 位置 | 改动 |
|---|---|
| `agent/adapters/host_ops.py` | 新增 `is_write` 钩子：`call`/`call_task` 按 verb 判定，**只读白名单** `PUBLIC_VERBS - WRITE_VERBS` 才算读；未知 verb / 缺 verb / 参数畸形一律按写（保守） |
| 同上 | 适配器 `VERSION` 1.0.0 → 1.0.1；`call`/`call_task` 的 description 改为「读写按 verb 判定」 |
| `apps/web/src/data/hostOps.ts` | Agent `busy` → 面板 `E_BUSY` 归一化（`ApiError` 与 `ok:false` 信封两条路径） |
| `apps/web/src/i18n/zh.ts` | 新增 `E_BUSY`：「节点正在执行另一个写操作，请稍后重试。」 |
| 前端 4 处 | 移除失效的「读动词也串行」注释（串行保留，但不再声称是必需） |
| `docs/host-ops.md` | `call` 的读写口径改为按 verb；最后核验 2026-11-16 |

Agent `0.3.0 → 0.3.1`（patch），面板 `0.14.0 → 0.14.1`（patch）。

## 4. 本地验证

新增测试（先确认在旧实现上会红，再确认新实现绿）：

| 用例 | 旧实现 | 新实现 |
|---|---|---|
| `AdapterIsWriteTests.test_read_verbs_are_not_writes`（10 个只读 verb） | FAIL | PASS |
| `AdapterIsWriteTests.test_writes_decided_per_verb_for_call_task_too` | FAIL | PASS |
| `AdapterIsWriteTests.test_unknown_or_missing_verb_is_conservative_write` | PASS | PASS |
| `AdapterCallTaskLockTests.test_task_holds_write_lock_until_done`（写锁占用时只读仍可用） | ERROR | PASS |
| `HttpContractTests.test_call_read_does_not_require_key` | FAIL | PASS |
| `HttpContractTests.test_concurrent_read_verbs_over_http_all_succeed`（6 并发只读） | FAIL | PASS |
| `hostOps.test.ts`「409 busy 归一化为 E_BUSY」 | FAIL | PASS |

档位：Agent **1118 项**、前端/Worker **864 项**（5 skip）、typecheck、build、d1 migrations 41 项、
install lifecycle 22 项、app manifests、docs lint strict、release 一致性全绿。

## 5. 真机验证（oracle-x86-2，140.245.108.105）

把本分支 `agent/{khc,adapters}` 上传后，用一次性 systemd 单元复刻生产沙箱属性
（`NoNewPrivileges` + `ProtectSystem=full` + `ProtectHome=read-only` + `PrivateTmp`），
以真实 `Kernel` + `load_adapters` 加载适配器（与生产同一路径），HTTP/内核层并发打 verb。

**修复后 5/5 通过：**

| 检查 | 结果 |
|---|---|
| `is_write` 判定 10 个只读 + 7 个写 | 全部正确（只读：version/status/snapshot/processes/fw.show/keys.list/svc.list/svc.logs/logs.errors/cron.list） |
| 未知 verb / 缺 verb / 参数畸形 | 一律按写处理 |
| 并发 10 个只读 verb | 无一次 409 busy |
| 写锁被占用时写 verb | 仍 409 busy（写锁未被错误放开） |
| 写锁被占用时只读 verb | 正常可用 |

**同一驱动跑旧实现 3/5（反证）：**

| 检查 | 旧实现 |
|---|---|
| `is_write` 判定 | FAIL —— 10 个只读 verb 全部被误判为写 |
| 并发 10 个只读 verb | PASS（此轮恰好未撞车，说明症状是非确定性的） |
| 写锁被占用时只读 verb | FAIL —— `BadRequest: 写动作必须带 idempotencyKey` |

## 6. 真机升级与 A/B 对照（同一节点，最强证据）

上述隔离单元验证的是"代码逻辑"。本节在 `oracle-x86-2` 上**把生产 Agent 从 0.1.48 原地升级到
0.3.1**，对真实运行进程打并发请求，然后在同一进程内做 A/B 对照（唯一变量是 `is_write`
钩子有无），闭合因果链。

### 6.1 原地升级

用仓库出的包（`agent/package.sh`）在节点上跑官方 `install.sh`，按节点既有配置
（`KHC_HOST=127.0.0.1` / `KHC_PORT=8443` / 原 `KHC_LIVE_ORIGINS` / 原 `KHC_NODE_ID`）重装：

```
[khc-agent] health OK (http): {'ok': True, 'version': '0.3.1', 'minPanelVersion': '0.4.0'}
```

升级前后：`ExecStart` 与 `KHC_*` 环境变量保持一致，token 文件路径不变（`install.sh` 本次
重新生成了 token，属其既有行为），监听仍是 `127.0.0.1:8443`。

### 6.2 真实进程并发（HTTP + HMAC 签名）

对 `127.0.0.1:8443` 用 `X-Khc-Token/Ts/Nonce/Sig`（`METHOD|path|ts|nonce|sha256hex(body)`）打请求：

| 检查 | 结果 |
|---|---|
| 并发 10 个只读 verb | 全部 200，无 busy |
| 只读 verb 不带 `idempotencyKey` | 200（旧版此处会 400） |
| 写 verb 不带 `idempotencyKey` | 400 `idempotency_key_required`（权限未放宽） |
| 并发两个写 verb | 一个 200、一个 409 `busy`（写锁仍生效） |
| 写动作之后只读 | 立即 200 |

### 6.3 同进程 A/B：缺陷 → 修复

关键点：真实前端每个请求**都带** `idempotencyKey`（`hostOpsAction` 恒带）。不带 key 的只读
请求在旧实现上会先被 400 拦住，反而不进入写锁竞争 —— 这也是最初复现不出 busy 的原因。
补上 key 后，10 个并发只读请求（每个注入 50ms 延迟以强制重叠）：

| 场景 | 结果 |
|---|---|
| **旧实现**（`is_write` 退回基类默认） | **9/10 被拒，`busy`** —— 精确复现截图症状 |
| **修复后**（当前 `is_write`） | **0/10 失败**，全部 200 |
| 写锁被占用时只读 verb：旧实现 | FAIL —— `写动作必须带 idempotencyKey` |
| 写锁被占用时只读 verb：修复后 | PASS —— 可用 |

旧实现 9/10 失败、修复后 0/10 —— 因果链闭合，不是"改了别的东西顺带好了"。

## 7. 清理核对

```
/var/lib/khc-r3        -> 已删除
/var/lib/khc-apps      -> 已删除
khc-r3-driver.service  -> 已删除（stop + reset-failed）
/tmp/khc-up-031、临时测试脚本 -> 已删除
残留 khc-app 用户      -> 0
生产 khc-agent / caddy -> active（Agent 已升到 0.3.1）
```

## 8. 遗留

- 写动作之间仍是节点级串行（设计如此，A-8），不做并发写。
- 面板侧真正的修复在 Agent：旧 Agent（≤ 0.3.0）上只读 verb 仍会抢锁。面板的 `E_BUSY` 只是
  把冲突显示成可读文案，不改变行为。
- 本次已在 `oracle-x86-2` 把节点升级到 0.3.1 并验证；其余节点按批次自行安排，不在本证据范围。