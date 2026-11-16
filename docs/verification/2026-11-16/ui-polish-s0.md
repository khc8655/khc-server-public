# S0 主机运维提速与 Peer 网络实测（2026-11-16）

> 状态：证据（一次性验收记录，写完不再修改） ｜ 最后核验：2026-11-16 ｜ 关联：PR #65、`docs/plans/ui-polish-2026-11-16-todo.md` §3
> 节点：`oracle-x86-2`（ubuntu@140.245.108.105），Agent 0.3.2，Caddy 站点 1 个（上游 `127.0.0.1:8899` 与 `127.0.0.1:8443`），WireGuard `wg0`（10.98.0.1/24，1 个 peer 10.98.0.2）

**本批不改代码、不 bump 版本。**四项都有实测数据，测完节点恢复原状。

原始测量数据见同目录 `s0-data/`（`s0-timing-agent.json`、`s0-split.json`）。

## ① 主机运维各调用耗时（分三段）

### 1.1 端到端（Agent 本机发 HTTP，7 次取样）

| 动词 | 中位数 | 最大 | 状态 |
|---|---|---|---|
| `svc.list` | 130.6 ms | 205.7 ms | 200 |
| `processes` | **641.9 ms** | 647.4 ms | 200 |
| `fw.show` | 127.4 ms | 133.4 ms | 200 |
| `keys.list` | 120.8 ms | 125.2 ms | 200 |
| `cron.list` | 74.5 ms | 128.7 ms | 200 |
| `logs.errors` | 154.9 ms | 195.5 ms | 200 |
| `status` | 347.2 ms | 354.6 ms | 200 |
| `snapshot` | 361.0 ms | 367.0 ms | 200 |

### 1.2 拆成「Agent 执行」与「传输」（各 5 次取样，中位数）

| 动词 | Agent 执行 | HTTP 往返 | 传输开销 |
|---|---|---|---|
| `svc.list` | 5.3 ms | 104.8 ms | 99.5 ms |
| `processes` | **518.7 ms** | 603.3 ms | 84.7 ms |
| `fw.show` | 8.1 ms | 92.2 ms | 84.1 ms |
| `keys.list` | 0.3 ms | 99.6 ms | 99.3 ms |
| `cron.list` | 0.1 ms | 97.9 ms | 97.8 ms |
| `logs.errors` | 24.4 ms | 108.0 ms | 83.6 ms |

### 1.3 结论

1. **传输是固定成本，约 84–100 ms**。这是本机回环 + HMAC 签名 + HTTP 框架的开销，与动词无关。真实环境还要加 Worker 往返与公网 RTT，只会更大。
2. **瓶颈不在 Worker 往返，在 `processes` 这一个动词**：它执行 518.7 ms，因为要跑 `ps` 子进程并解析。其余动词执行都 < 25 ms。
3. 所以提案 §4 的选项 A（先测后改，不改通道）是对的，但**优化重点不是通道，是 `processes` 动词的实现**。B 方案（只读改直连）能省那 85–100 ms 传输，但解决不了 519 ms 的大头。

> 对 U4 的建议：`processes` 改为读 `/proc` 自采（`host_ops` 已有只读 `/proc` 采集的先例），或加短缓存。通道不必动。

## ② 10 秒快照加入失败单元的耗时（决定 U2 能否开工）

`systemctl list-units --state=failed --no-legend --plain`，10 次取样：

```
样本(ms): 8 6 5 6 5 8 5 5 5 5     → 中位数 5.5 ms，最大 8 ms
```

与 `/state` 现状同口径（两次 systemctl：`is-active` + `list-units`），10 次取样：

```
样本(ms): 11 10 10 74 9 10 69 9 9 10  → 中位数 10 ms，最大 74 ms
```

**结论：可以每 10 秒执行一次。** 单次 5–8 ms，即便加上偶发抖动（74 ms 的离群值）也只占 10 秒周期的 0.7%。
U2 的前提条件满足，可以开工。

> 注意：这意味着 U2 只需在 `collect_snapshot` 里多跑一次 `list-units`，不需要改频率或加缓存层。

## ③ 「全部流量走 Hub」后公网 SSH 是否断开

### 3.1 为什么用 netns 而不是真机

现有节点上唯一的 Peer（`10.98.0.2`）从公网完全不可达：`23.94.180.2` 的 22/51666/2022 全部关闭，IPv6 也不可达；
Hub 上没有它的私钥（`~/.ssh` 只有 `authorized_keys` 与 `known_hosts`），无法登录。
直接在真机上改默认路由会把自己锁死，因此用 network namespace 精确复刻 `wg-quick` 加载
`AllowedIPs = 0.0.0.0/0` 时的路由动作（`wg-quick` 做三件事：独立表 51820 的默认路由、
`ip rule not fwmark` 策略路由、`ip rule table main suppress_prefixlength 0`）。

### 3.2 实测（netns，kernel 7.0.0-1016-oracle）

加载后 `ip rule`：

```
0:      from all lookup local
32764:  from all lookup main suppress_prefixlength 0
32765:  not from all fwmark 0xca6c lookup 51820
32766:  from all lookup main
32767:  from all lookup default
```

`table 51820`：`default dev wg0 scope link`
main 表默认路由：**仍在**（`default via 172.30.0.1 dev veth-s0n`）

三种回程场景：

| 场景 | 回程路由 | 判定 |
|---|---|---|
| A 客户端与 VM **同网段** | `172.31.0.99 dev veth-s0n2` | **SSH 不断**（直连路由前缀更长，不受 `suppress_prefixlength 0` 影响） |
| B 客户端在**公网其他网段** | `203.0.113.50 dev wg0 table 51820` | **已建立的 SSH 会断**：入包走物理网卡、回包从隧道出去，对端看到源 IP 不对 |
| C 加 Hub endpoint 的 /32 直连路由 | endpoint 走物理网卡，公网客户端仍走 wg0 | endpoint 本身不打环，但**不影响 SSH 客户端回程** |

### 3.3 结论

**提案 §6 的风险文案第一条「VM 原有公网入站可能因为回程路由改走隧道而断开」是对的，且比预想更确实：**

- 只有在「SSH 客户端与 VM 同网段」时才不断；
- 公网 SSH（客户端在任意其他网段）**会断**，因为回程按默认路由走隧道；
- 保留 endpoint 的 /32 直连只能防止 WireGuard 自身打环，救不了 SSH 回程。

**对 U3 的要求**：「全部流量走 Hub」的确认框必须明确写「**公网 SSH 会断开**」，不能只说「可能」。
另外建议确认框附一条应急说明：如何从 Hub 侧或其他 Peer 跳板恢复。

**DNS**：本次未单独测。`AllowedIPs = 0.0.0.0/0` 装上后所有解析走隧道，
若客户端仍用本地 `resolv.conf` 里的公网 DNS，查询会被送进隧道再由 Hub 转发 —— 能工作但绕路；
提案 §6 说「DNS 需要另外配置」是对的。

## ④ FORWARD 隔离对现有转发与站点的影响

### 4.1 现状

```
-P FORWARD ACCEPT
-A FORWARD -j REJECT --reject-with icmp-host-prohibited
-A FORWARD -i wg0 -j ACCEPT
-A FORWARD -o wg0 -j ACCEPT
-A FORWARD -i wg0 -j ACCEPT
-A FORWARD -o wg0 -j ACCEPT
```

注意 `-A FORWARD -j REJECT` 排在 wg0 的 ACCEPT 之前 —— 这意味着包到 REJECT 就断了，
后面两条 wg0 ACCEPT 实际是**死规则**（顺序问题，既有缺陷，不在本批修）。

站点上游全部是 `127.0.0.1`（回环，不经 FORWARD）；无 socat 端口转发单元。

### 4.2 施加规则（独立链 S0TEST，插在 FORWARD 第 1 位）

```
-N S0TEST
-A S0TEST -s 10.98.0.2/32 -d 10.98.0.1/32 -i wg0 -o wg0 -j ACCEPT
-A S0TEST -s 10.98.0.1/32 -d 10.98.0.2/32 -i wg0 -o wg0 -j ACCEPT
-A S0TEST -i wg0 -o wg0 -j DROP
-A S0TEST -j RETURN
```

### 4.3 前后对照

| 检查 | 施加前 | 施加后 | 结论 |
|---|---|---|---|
| Peer → Hub ping | 2/2 通，0.895 ms | 2/2 通，0.863 ms | 正常 |
| Caddy 站点上游（`127.0.0.1:8899`） | 403 | 403 | 正常 |
| Peer SSH 端口 22 | 开放 | 开放 | 正常 |
| Agent `/health` | ok 0.3.2 | ok 0.3.2 | 正常 |
| Hub 自身出网 | 200 | 200 | 正常 |

### 4.4 结论

1. **现有转发与站点不受影响**：站点上游全在本机回环，不经 FORWARD；无 socat 转发单元。
2. **规则幂等**：重复 apply 后链内仍是 4 条（先用 `-D/-F/-X` 清自己再加）。
3. **计数全 0 说明 Peer→Hub 是本地投递**，不经 FORWARD 链 —— 所以 `wg0→wg0` 的 DROP
   不会误伤 Peer 到 Hub 的流量。这正是 U3 想要的隔离效果。
4. **测完已清理**（`-D FORWARD -j S0TEST` + `-F` + `-X`），`iptables -S FORWARD` 回到原始 6 条。

> 附带发现（不在本批范围）：现有 FORWARD 里 `-j REJECT` 在 `-i/-o wg0 -j ACCEPT` 之前，
> 使后者成为死规则。Peer 间互通目前靠 `-P ACCEPT` 生效。U3 渲染规则时必须
> **插到 FORWARD 第 1 位**（本次测试就是这么做的），否则会被那条 REJECT 抢先。

## 5. 四项总表

| 项 | 结论 | 对后续的意义 |
|---|---|---|
| ① 分段计时 | 传输固定 84–100 ms；`processes` 执行 519 ms 是唯一大头 | U4 优化 `processes`，不必改通道 |
| ② `list-units` 耗时 | 5–8 ms（双调用 10 ms） | **U2 可以开工** |
| ③ 全部流量走 Hub | 跨网段公网 SSH **会断**；仅同网段不断 | U3 风险文案改「会断开」，并给恢复指引 |
| ④ FORWARD 隔离 | 现有转发/站点不受影响；规则幂等；Peer→Hub 不经 FORWARD | **U3 可以开工**；必须插在 FORWARD 第 1 位 |

## 6. 清理核对

```
S0TEST 链              -> 已删除（-D + -F + -X）
wgprobe / wgprobe2 netns -> 已删除（trap 自动清理）
veth-s0h / veth-s0n    -> 已删除
FORWARD 规则            -> 回到原始 6 条
Peer 连通性             -> 正常（2/2）
Agent / Caddy          -> active（0.3.2 / 正常）
临时脚本 /tmp/s0-*      -> 已删除（脚本在真机上以 root 写入，需 sudo rm）
原始数据                -> 存 docs/verification/2026-11-16/s0-data/
```
