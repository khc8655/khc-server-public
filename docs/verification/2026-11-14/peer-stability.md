# WireGuard Peer 链路稳定性实测（2026-11-14）

> 状态：现行（一次性验收证据，写完不再修改） ｜ 最后核验：2026-11-14 ｜ 关联：#34、WireGuard Peer 上线前压测

## 1. 目的与判据

产品定位要求：Peer 侧端口普遍受限（NAT / 端口封禁 / 丢包），**一次稳定连上后不允许"悄悄断掉并失联"**。
本记录用真实机器验证三件事：

1. 各种断链场景下，链路能否**自动恢复**、恢复耗时多少；
2. 恢复是否需要人工介入；
3. 面板对"已断链"状态是否能有明确呈现（而不是始终显示在线）。

## 2. 环境

| 角色 | 机器 | 关键参数 |
|---|---|---|
| Hub | `oracle-x86-2`（`140.245.108.105`，未来生产机） | `wg0` = `10.98.0.1/24`，`listenPort 51820`，`mtu 1420`，`extIface ens3`，`wg-quick@wg0` enabled，`khc-agent` enabled |
| Peer | `oracle-arm-1`（`161.118.228.99`） | `khc1` = `10.98.0.2/32`，`PersistentKeepalive 25`，AllowedIPs `10.98.0.0/24` |
| 面板 | `0.12.8`，`https://khc-server-staging.kanghongcan.workers.dev` | hub 节点 `nd_0500a03d6af5639b`，wireguard `rev 20` |

> 说明：`oracle-arm-1` 上已存在一条 `khc0` 隧道（对 `54.179.74.225`），本次全部测试使用独立接口 `khc1` 与独立网段 `10.98.0.0/24`，全程未影响既有 `khc0`。

采样方式：peer 端 `ping -D`（带时间戳）打到 `10.98.0.1`，按 `icmp_seq` 与时间戳还原中断区间；hub 端 `wg show` 取 `latest handshake`；必要时用 `iptables` 计数器确认对端仍在持续重试。

## 3. 结果总表

| # | 场景 | 模拟方式 | 中断时长 | 是否自愈 | 人工介入 |
|---|---|---|---|---|---|
| 1 | Peer 端服务重启 | peer `systemctl restart wg-quick@khc1` | **1 s** | 是 | 无 |
| 2 | Peer 仅 peer 级配置变更 | 面板加一个 `probe-dummy` peer → `apply` | **0 丢包** | — | 无 |
| 3 | Peer 接口级配置变更 | 面板改 `mtu` 1420 → 1380 → `apply` | **≈15 s**（窗口内 81% 丢包） | 是 | 无 |
| 4 | Hub 端 WG 服务重启 | hub `systemctl restart wg-quick@wg0` | **15.6 s** | 是 | 无 |
| 5 | Hub 主机整机重启 | hub `systemctl reboot`（内核启动 27 s） | **38.7 s** | 是 | 无 |
| 6 | 短时单向黑洞 | hub `iptables -I INPUT -p udp --dport 51820 -j DROP`，40 s | **2 s** | 是 | 无 |
| 7 | 长时单向黑洞 | 同上，180 s | **3 s** | 是 | 无 |
| 8 | 超长黑洞（跨面板在线窗口） | 同上，累计 **330.8 s** | **2.9 s** | 是 | 无 |
| 9 | 链路劣化（丢包型 NAT / 拥塞） | hub 侧 `statistic --probability 0.3 -j DROP`，60 s | 会话未断，实测丢包 **29.2 %** | — | 无 |
| 10 | 长时间空闲 | peer 空闲 150 s 后回连 | 未断（`PersistentKeepalive 25` 维持映射） | — | 无 |

结论：**10 个场景全部自动恢复，无一需要人工干预**；最坏情况是 Hub 整机重启，38.7 s。

## 4. 关键场景原始证据

### 4.1 Hub 端 `wg-quick@wg0` 重启（15.6 s）

hub 重启时刻 `1794630200.2`；peer 最后一包 `1794630199.97`（`seq=30`），恢复首包 `1794630215.56`（`seq=105`）。

```
300 packets transmitted, 226 received, 24.6667% packet loss, time 61977ms
hub latest-handshake: 1794630215   # 重启后 15 s 完成重新握手，期间无人工动作
```

### 4.2 Hub 整机重启（38.7 s）

重启指令 `1794631040`；内核重启后 `wg-quick@wg0` 自动 active；peer 握手恢复 `1794631088`。

```
OUTAGE: seq23@1794631050.0 -> seq61@1794631088.7 = 38.7s, lost=37
300 packets transmitted, 263 received, 12.3333% packet loss
重启后：khc-agent active（04:38:04 UTC），ping 5/5，rtt 0.89 ms
```

即：**整机重启后 38.7 s 自动回到可用状态，配置与开机自启均未人工干预。**

### 4.3 超长黑洞 330.8 s（跨 180 s 在线窗口）

黑洞起点 `1794630328`（与 `iptables -I` 时刻一致），解除 `1794630656`，恢复首包 `1794630658.88`。

```
GAP seq10@1794630328.12 -> seq205@1794630658.88 = 330.8s, lost=194
解除封堵后 2.9 s 恢复；hub latest-handshake 1794630658（解除后 2 s）
```

黑洞期间 peer 侧 `latest handshake` 龄从 2 分 31 秒一路涨到 6 分 24 秒，但 `transfer` 仍在增长（`76.17 KiB → 85.65 KiB sent`），证明 **peer 在持续重试而非放弃**；hub 侧 `DROP` 计数器同步增长。

恢复瞬间有 **93 个被暂存的报文一并涌出**（`time=` 高达 34822 ms），属 WireGuard staging queue 的正常释放行为，随后 RTT 立刻回到 0.9 ms。

### 4.4 30 % 丢包（会话不断）

```
120 packets transmitted, 85 received, 29.1667% packet loss
latest handshake: 58 seconds ago    # 丢包窗口内仍完成过重新握手
```

移除规则后立刻 `20/20, 0% packet loss`，无需重连。

## 5. 面板状态呈现

`agent/adapters/wireguard.py` 的在线判定为：

```
ONLINE_WINDOW = 180
online = bool(latest_handshake and 0 <= now - latest_handshake <= ONLINE_WINDOW)
```

这是**必要设计而非缺陷**：空闲链路只在 `REKEY_AFTER_TIME`（120 s）才重新握手，若窗口小于 ~150 s，健康 Peer 会间歇性被判为离线（假离线比晚报更糟）。代价是真断链后最多滞后 180 s 才显示离线。

UI 侧（`apps/web/src/apps/wireguard/page.tsx`）同时给 `状态`（在线/离线）与 `握手`（相对时间）两列，操作者即便在 180 s 窗口内也能从握手龄判断链路是否停滞。因此本场景**不需要改代码**，只在文档标注该时间语义。

## 6. 结论与遗留

- Peer 链路的自愈能力满足"断线不失联"要求；恢复耗时排序：Peer 重启 1 s < 短黑洞 2 s < 长黑洞 3 s < 接口级变更 15 s ≈ Hub WG 重启 15.6 s < Hub 整机重启 38.7 s。
- **接口级（MTU 等）变更必然带来约 15 s 抖动**，因为需要重建接口；仅 peer 级变更走 `wg syncconf`，实测 0 丢包。变更窗口应避开业务高峰。
- 遗留：`oracle-arm-1` 的 `khc1` 接口、hub 面板中的测试 Peer 条目、以及 `docs/verification/2026-11-13` 记录中提到的临时文件仍在测试机上，属测试资产，清理需单独确认。
