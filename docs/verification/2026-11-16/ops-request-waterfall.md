# U6 主机运维页请求瀑布复核（2026-11-16）

> 状态：证据（一次性验收记录，写完不再修改） ｜ 最后核验：2026-11-16
> 节点：`oracle-x86-2`（ubuntu@140.245.108.105），Agent 0.5.0 / 面板 0.17.0
> 关联：`ops-inprocess-call.md`（U5 消除进程启动）、`ui-polish-u4-processes.md`（U4 采样窗口）

## 1. 结论

U5 之后服务端已经没有「起进程跑同一份 Python 代码」这类浪费了。这轮复核各动词的真实耗时：

| 动词 | 稳定耗时 | 偶发峰值 |
|---|---|---|
| `version` | **2.5 ms** | — |
| `cron.list` / `keys.list` | **2.2–3.5 ms** | — |
| `svc.list` | **7.3–8.0 ms** | 68 ms |
| `fw.show` | **10.5–11.2 ms** | 69 ms |
| `snapshot`（无进程） | **17–19 ms** | 78 ms |
| `snapshot{processes}` | **176–192 ms** | — |

**剩余可优化点只有两类，且收益都不大**：

1. **串行请求**：`version` + `fw.show`、`version` + `keys.list` 各串一次。并行后省 2–3 ms（Hub）
   —— 但 Peer 目标走 SSH，串行会把两段网络往返相加，那里的收益是实打实的。
2. **外部命令抖动**：见 §3，属系统层面。

## 2. 改了什么

四处「取版本号 + 取数据」的串行组合改成 `Promise.all`：

| 文件 | 组合 | 目标 |
|---|---|---|
| `FirewallSegment.tsx` | `version` + `fw.show` | Hub self |
| `FirewallDrawer.tsx` | `version` + `fw.show` | self 或 **Peer** |
| `OpsSegments.tsx`（KeysSegment） | `version` + `keys.list` | Hub self |
| `SshKeysDrawer.tsx` | `version` + `keys.list` | self 或 **Peer** |

改动前提已验证：`callHostOps` **不抛异常**（把错误转成 `apiErrorResult`），所以
`Promise.all` 不会因为其中一个失败而中断另一个。原有的「`version` 失败可忽略、
`fw.show` 失败才报错」的语义完全保留。

## 3. 外部命令的抖动（不是我们能改的）

`nft` 与 `systemctl` 本身有周期性峰值：

```
nft list ruleset（10 次）:      12 11 11 12 12 11 [69] 12 11 [74]
systemctl list-units（10 次）:  5 4 4 4 4 [57] 4 4 4 4
```

约每 5–7 次出现一次 5–7 倍的峰值。这就是 `svc.list` / `fw.show` 偶发 68–69 ms 的来源。

属操作系统调度或页缓存层面的抖动，不在本项目能控制的范围。**不建议为它加缓存** ——
缓存会让「服务状态」变陈旧，而这张表的意义就是实时。偶发一次 69 ms 在人眼感知上
也不明显。

## 4. 一个自己踩的测试坑（值得记）

第一版并行测试用「两个请求在 `requests` 数组里序号相邻」做判据。**它抓不住串行回归** ——
把代码改回串行后测试照样通过。

原因是 mock 的 fetch 同步返回，串行时中间不会插入别的请求，序号依然相邻。

第二版改成**给 `version` 注入 60 ms 延迟**，判断「`fw.show` 是否在 `version` 返回前发出」。
反向验证：改回串行 → 测试失败；改回并行 → 通过。这次才真的有保护力。

> 教训：**写完回归测试要反向验证一次**。一个抓不住回归的测试等于没有，
> 而且比没有更糟 —— 它会让人以为有保护。

## 5. 测试

新增 1 项：`version 未返回前就已经发出 fw.show`（基于真实延迟，已验证能抓住串行回归）。

档位：前端 **941 项**（5 skip）、Agent 1170 项不变、typecheck、build 全绿。

## 6. 现在的性能基线

主机运维这条链路从最初的 519 ms 到现在：

| 阶段 | 只读动词 | `snapshot{processes}` |
|---|---|---|
| 改造前 | 129–190 ms | 263–289 ms |
| U4（采样窗口 500→100ms） | 129–190 ms | 135–196 ms |
| **U5（进程内执行）** | **2.5 ms** | **176–192 ms** |
| U6（并行加载） | 2.5 ms，组合少 2–3 ms | 不变 |

`snapshot{processes}` 剩下的 ~100 ms 是测准 CPU% 必需的采样窗口，不该再压。
