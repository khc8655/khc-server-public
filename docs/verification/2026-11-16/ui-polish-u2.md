# U2 真机验证：失败单元进快照 + 清除失败状态（2026-11-16）

> 状态：证据（一次性验收记录，写完不再修改） ｜ 最后核验：2026-11-16 ｜ 关联：PR、`docs/plans/ui-polish-2026-11-16-todo.md` §5
> 节点：`oracle-x86-2`（ubuntu@140.245.108.105），Agent **0.3.2 → 0.3.3**

## 1. 做了什么

| 项 | 改动 |
|---|---|
| 快照带失败单元 | `agent/khc/ops.py` 的 `collect_snapshot` 增加 `failedUnits`，与 `/state` 共用新的 `_failed_units()` |
| 三态语义 | 数组（可为空）= 采集成功；**字段缺省** = 旧 Agent 或没读到（前端退回 `/state`）；不用 `null` |
| 契约 | `agentOpsSchema` 显式声明 `failedUnits?: string[]`（`passthrough` 下不声明就没有类型） |
| 前端取值 | 新增 `apps/web/src/data/failedUnits.ts` 的 `pickFailedUnits`：快照 → 快照 `ops.services` → `/state` → `null` |
| 页面 | 概况页「需要处理」与主机卡片、主机运维状态带都改为快照优先；读不到时显示「未读取」而不是「0 个失败」 |
| 新写动词 | `svc.reset-failed <unit>`：复用 `_service_unit_param` 的单元名校验与受保护单元名单 |
| 权限 | 进 `WRITE_VERBS`（自动从 Peer 可用集合里被减掉，**N-2 满足**），**不进** `PEER_SAFE_WRITE_VERBS` |
| UI | 服务列表行内「清除失败状态」，L2 确认框；非失败单元禁用并说明原因 |

## 2. 真机验收（8/8）

```
[PASS] 快照返回 failedUnits 字段              snapshot.failedUnits=[]
[PASS] 制造失败后快照能看到该单元              snapshot=['khc-u2-probe.service']
[PASS] 快照与 /state 同源同值                  snapshot == state
[PASS] svc.reset-failed 调用成功               status=200 data={'reset': True, 'stillFailed': False}
[PASS] 返回 stillFailed=false
[PASS] 10 秒内快照不再含该单元（计数归零）      等待约 0s
[PASS] 非法单元名被拒                          E_BAD_REQUEST: 服务名不合法: ../etc/passwd（仅允许 *.service）
[PASS] 受保护单元被拒                          E_PROTECTED: 服务受保护，不允许从面板操作: ssh.service
```

**核心验收达成**：`svc.reset-failed` 之后**快照立即归零**（等待 0s），
不需要重新拉 `/state` —— 这正是 U1 遗留的「重启成功后计数还是旧的」的最终解。

快照结构实测：

```
snapshot ops keys: ['collectedAt', 'cpu', 'disks', 'failedUnits', 'mem', 'swap', 'uptime']
```

## 3. 偏离 ADR-0010（必须在 PR 里说明）

`docs/live-observation.md` 原文写着 `/snapshot`「**不跑 systemctl/ps 等子进程**」。
本次为了把失败单元带进 10 秒轮询，**打破这条约束**。

理由与代价：

- 失败单元过去只在 `/state` 采集，而 `/state` 不是轮询入口 —— 页面打开后计数就冻住。
  这是 U1 真机验证发现的真实缺陷（`ui-polish-u1.md` §3.2），不修就会一直存在。
- S0 实测 `systemctl list-units --state=failed` 单次 **5–8 ms**（`ui-polish-s0.md` §②），
  占 10 秒周期的 0.7%，代价可接受。
- 采集失败时**只让该字段缺省**，指标（CPU/内存/磁盘）照常返回 —— 失败单元不该拖垮快照。
- 复用 `_failed_units()` 与 `/state` 同源，避免两处逻辑漂移（有测试锁住这一点）。

## 4. 旧 Agent 兼容

`pickFailedUnits` 取值顺序（8 项单测覆盖）：

1. 快照顶层 `failedUnits`（0.3.3+）
2. 快照 `ops.services.failedUnits`（部分版本的老位置）
3. `/state` 的 `ops.services.failedUnits`
4. 都没有 → `null`（页面显示「未读取」，**不显示「0 个失败」**）

空数组与 `null` 严格区分：前者是「确实没有失败」，后者是「不知道」。
页面上这两种情况文案完全不同，不能合并。

## 5. 测试

新增/修改用例（先在旧实现上确认会红）：

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `agent/tests/test_snapshot.py` | +5 | 快照带失败单元、空列表、systemctl 不可用时字段缺省、上限 10、与 `/state` 同源 |
| `agent/tests/test_host_ops.py` | +7 | 写动词登记、非法单元名、受保护单元、成功路径、stillFailed、systemctl 报错、Peer 拒绝 |
| `apps/web/src/data/failedUnits.test.ts` | 8 | 三态取值顺序、空数组 vs null、脏值兜底 |
| `apps/web/src/apps/host-ops/hostops.smoke.test.tsx` | +2 | 失败单元可清除并提示、非失败单元禁用并说明原因 |

档位：Agent 全量、前端 422 项、typecheck、build 全部通过。

## 6. 清理

```
/etc/systemd/system/khc-u2-probe.service  -> 已删除（stop + disable + rm + daemon-reload）
/run/khc-u2-probe.ok                      -> 已删除
/tmp/u33、临时脚本                          -> 已删除
systemctl list-units --state=failed       -> 空
khc-agent / caddy                         -> active（Agent 0.3.3）
```
