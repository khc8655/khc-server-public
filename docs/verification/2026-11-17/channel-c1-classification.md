# C1 通道分类落地：真机验证（2026-11-17）

> 状态：证据（一次性验收记录，写完不再修改）｜最后核验：2026-11-17
> 节点 oracle-x86-2 ｜ Agent **0.5.1 → 0.5.2** ｜ 面板 0.17.3
> 关联：`docs/engineering/adr/ADR-0020-channel-classification.md`、PR #76 通道梳理

## 1. 做了什么

按 ADR-0020 把「哪些数据能直连」写成规则，并落到代码：

| 项 | 内容 |
|---|---|
| ADR-0020 | 三个类别、四条准入条件、两道明确排除、三道兜底 |
| `khc_host.py` | 新增 `CHANNELS`（18 个动词）、`channel_map()`、`is_direct_channel()` |
| `contracts` | 新增 `NODE_CHANNELS`、`HOST_OPS_CHANNELS`、`hostOpsChannel()`、`isDirectChannel()` |
| `live.py` | 票据作用域提为常量 `TICKET_SCOPES`，并写明它是通道分类的兜底 |
| 测试 | Agent +11、前端 +6（含一个读 Python 源的一致性测试） |

## 2. 分类结果

| 类别 | 数量 | 动词 |
|---|---|---|
| `observe` | 2 | `status`、`snapshot` |
| `ops-read` | 5 | `version`、`processes`、`fw.show`、`svc.list`、`cron.list` |
| `control` | 11 | 8 个写动词 + `keys.list`、`svc.logs`、`logs.errors` |

**可直连 7 个，必须经控制面 11 个。**

### 2.1 与提案的两处刻意分歧

1. **`keys.list` 归 `control`**（提案归 `ops-read`）。它是「谁能登进这台机器」的完整清单，
   且与 `keys.add`/`keys.remove` 是同一份数据，读写分走两条通道会让竞态更难排查。
2. **`svc.logs` / `logs.errors` 归 `control`**（提案把 `svc.logs` 归 `ops-read`）。
   日志内容不可控，令牌泄漏最常见的途径就是日志。

理由写在 ADR §3：通道规则要能放心用很久，为 5 个动词快 0.5ms 而把「登录权限清单」
和「日志内容」放进直连不划算 —— 何况它们本来也不是高频操作。

## 3. 三道兜底（都有测试）

1. **字段必填**：18 个动词缺任一类别，`channel_map()` 抛 `ValueError`，Agent 启动即失败。
2. **写动词只能是 `control`**：8 个写动词被标成 `observe`/`ops-read` 时 `channel_map()`
   抛错；contracts 侧也有一条同样的测试。
3. **票据作用域白名单**：`control` 永远不在 `TICKET_SCOPES` 里，签不出可直连的票。
   新增作用域等于新增一条直连通路，必须同时改 ADR。

## 4. 真机验证：7/7

```
[PASS] channel_map() 在真机可用                     18 个动词
[PASS] 三类分布符合 ADR                             {'ops-read': 5, 'observe': 2, 'control': 11}
[PASS] 可直连动词是预期集合                          ['cron.list','fw.show','processes','snapshot','status','svc.list','version']
[PASS] 写动词全是 control                           8 个写动词全对
[PASS] 公钥/日志不进直连                            全部 control
[PASS] control 不在票据作用域                       ('live', 'nudge', 'snap')
[PASS] 伪造 control 票被拒                          err=bad_signature
```

最后一条值得记一笔：我原本预期 `bad_scope`，实测是 **`bad_signature`** ——
验票先校验签名再校验作用域，所以伪造的票根本走不到作用域检查。
**这比预期更安全**，测试断言已改为两者都接受并注明原因。

## 5. 一致性测试能抓住漂移（反向验证过）

contracts 里的 `HOST_OPS_CHANNELS` 与 Python 的 `CHANNELS` 是两份独立声明，
靠 `packages/contracts/test/channel.test.ts` 读 Python 源做校验。

**反向验证**：故意把 `keys.list` 改成 `ops-read`，两个测试同时失败，
报错直接指出是 `keys.list`：

```
× contracts 与 Agent 的 CHANNELS 完全一致
× 公钥清单与日志不进直连（ADR-0020 §3）
-   "keys.list": "control",
+   "keys.list": "ops-read",
```

> 这一步是必须的。前面 U6 踩过一次「测试抓不住回归」，所以这次先反向验证再收工。

## 6. 刻意没做的

**其他适配器（wireguard / caddy-site）没加 `channel` 字段。**

它们的 19 个动作目前没有任何直连通路（直连只存在于观测快照与将来的 C2），
补一个当前无人读取的字段是空转。等某个适配器真的要开直连时再补。

这一条在 ADR §4 里写明了是**刻意的范围限制，不是遗漏**。

## 7. 门禁

Agent **1186 项**（+11）、前端 **946 项**（+6）、typecheck、build、docs lint（50 份）、
release 一致性全绿。Agent 0.5.2 已部署，`minPanelVersion` 仍 0.5.0（不破坏兼容）。

## 8. 下一步

C1 完成。按 PR #76 §7 的推荐顺序，接下来是：

1. **量化「Worker→Hub」那一跳** —— C2 唯一的收益来源，测一次就有答案
2. C2 只在那一跳超 150ms 时做
3. 否则转去查 Caddy 的 24–74ms（每个请求都付）
