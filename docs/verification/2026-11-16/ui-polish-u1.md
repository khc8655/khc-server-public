# U1 节点工作区体验修正：真机验证（2026-11-16）

> 状态：证据（一次性验收记录，写完不再修改） ｜ 最后核验：2026-11-16 ｜ 关联：PR #65、`docs/plans/ui-polish-2026-11-16-todo.md` §4

## 1. 环境与准备

- 测试节点：`oracle-x86-2`（ubuntu@140.245.108.105）
- Agent：验证前 0.3.1，验证中升级到 **0.3.2**（本次新增 `GET /state?force=1`，见 §4）
- 面板：本分支本地构建（未部署），验证走 Agent HTTP 层与纯函数层

制造两个失败单元作为对照组（测后删除）：

| 单元 | 类型 | 用途 |
|---|---|---|
| `khc-u1-probe.service` | 受管（`khc-` 前缀） | 应进「需要处理」，可被 `svc.restart` 修好 |
| `u1systemprobe.service` | 非受管（系统单元） | 只应出现在灰色入口，不被误清 |

受管单元用标志文件控制成败（`test -f /run/khc-u1-probe.ok || exit 1`），这样才能模拟「真的修好了」。

## 2. 受管/系统拆分（U1-5）

真机 `/state` 取回：

```
failedUnits: ["khc-u1-probe.service", "u1systemprobe.service"]
```

用 `data/managedUnits.ts` 的同一套规则拆分：

| 分组 | 结果 | 期望 |
|---|---|---|
| 受管（进「需要处理」） | `["khc-u1-probe.service"]` | ✅ |
| 系统（只给灰色一行） | `["u1systemprobe.service"]` | ✅ |

**结论**：拆分规则在真机数据上正确，`khc-` 前缀与系统单元没有串。

## 3. 失败计数刷新（U1-6）—— 发现真实缺陷

### 3.1 先验证快照根本不含失败单元

这是提案 §5 的假设，实测确认：

```
[GET /state]    services: 2, failedUnits: ['khc-u1-probe.service','u1systemprobe.service']
[GET /snapshot] 顶层键: ['collectedAt','cpu','disks','mem','swap','uptime']
[GET /snapshot] 是否含 services: False
```

`/snapshot` 是 10 秒轮询入口，只读 `/proc`，**不含 services / failedUnits**。
所以重启成功后快照不会带来新计数 —— 这正是「重启了但计数没变」的一半原因。

### 3.2 再发现第二个原因：Agent ops 有 5 秒缓存

`khc/ops.py` 的 `CACHE_TTL = 5.0`，`collect_ops` 在缓存窗口内直接返回旧 payload。
**即使前端在写成功后立刻失效查询重拉 `/state`，读到的仍是缓存里的旧失败计数。**

实测（重启成功后 0.8 秒读）：

```
不带 force 的立即读： ['khc-u1-probe.service','u1systemprobe.service']   ← 旧值
带 force 的立即读：   ['u1systemprobe.service']                          ← 新值
```

这不是推测，是同一次运行里两条路径的对照。仅靠 N-3 原文的「失效查询」无法修好这个缺陷。

## 4. 修复

| 位置 | 改动 |
|---|---|
| `agent/khc/state.py` | `build_state(kernel, *, force=False)`，把 force 透传给 `collect_ops` |
| `agent/khc/http.py` | `GET /state?force=1` 解析 query 并传 force（query 不参与签名，与既有 `?cacheBust=1` 一致） |
| `agent/khc/util.py` | VERSION `0.3.1 → 0.3.2`（新增能力，minor） |
| `apps/api/src/routes/nodes.ts` | `/nodes/:id/state` 透传 `?force=1` 给 Agent |
| `apps/web/src/data/hubs.ts` | `fetchHubState(hubId, { force })` 拼 `?force=1` |
| `apps/web/src/apps/host-ops/refreshAfterWrite.ts` | 写成功后**带 force 重新拉取并 `setQueryData`**；失败才退回 invalidate |

## 5. 真机验收结果

| 检查 | 结果 |
|---|---|
| 制造失败后 `/state?force=1` 含受管单元 | PASS `['khc-u1-probe','u1systemprobe']` |
| `svc.restart` 经 HTTP 成功 | PASS `status=200` |
| 不带 force 的立即读拿到缓存旧值（证明缓存真实存在） | PASS 仍含 `khc-u1-probe` |
| 带 force 的立即读已拿到新值（修复生效） | PASS `['u1systemprobe']` |
| 系统单元仍在（未被误清） | PASS |

**5/5 通过**，其中「缓存旧值 vs force 新值」是同一次运行内的对照，因果明确。

## 6. 其他真机确认

- `svc.restart` 直接调用 `svc_restart_verb` 成功（`ok: True`），说明适配器层没有回归。
- 失败单元确实能被 `systemctl restart` 修好并移出 `--state=failed`（`khc-u1-probe` → `u1systemprobe` 单条）。
- 直接调 `khc_host.svc_restart_verb` 与经 HTTP 的结果一致，无签名/权限差异。

## 7. 清理核对

```
khc-u1-probe.service / u1systemprobe.service -> 已删除（stop + disable + rm unit + daemon-reload）
/run/khc-u1-probe.ok                          -> 已删除
/tmp/u32、临时验证脚本                          -> 已删除
生产 khc-agent / caddy                        -> active（Agent 已升到 0.3.2）
```

## 8. 遗留

- **日志错误按单元分组未在 U1 做**：清单 U1 要求分组，但同一条又规定 U1 不改 Agent；
  `unit` 字段在 `_journal_entry()` 里被丢弃，前端无法可靠解析。已顺延到 U2（随 `failedUnits`
  一起改 Agent）。见 PR #65 的「偏离清单一处」。
- **面板 UI 截图未做**：按主人 2026-11-16 指示跳过。
- **U2 的失败单元进快照**仍未做：本次只保证「写后立即重拉能拿到真值」，
  真正的根因（10 秒快照不含失败单元）由 U2 解决。
