# U3 真机验证：Peer 隔离与策略链（2026-11-16）

> 状态：证据（一次性验收记录，写完不再修改） ｜ 最后核验：2026-11-16 ｜ 关联：PR #69、`docs/plans/ui-polish-2026-11-16-todo.md` §6
> 节点：`oracle-x86-2`（ubuntu@140.245.108.105），Agent 0.4.0，内核实 7.0.0-1016-oracle，真实 WireGuard

## 0. 两种验证方式

本文有两部分，**第二部分是真机物理 Peer，优先级更高**：

| 部分 | 拓扑 | 能证明什么 |
|---|---|---|
| §1 netns | netns 内真实 WireGuard | 规则链逻辑、幂等、PostDown 对称 |
| **§2 真机两 Peer** | **香港 LXD ↔ Hub ↔ oracle-arm-1** | **真实跨公网隔离；客户端配置不变时服务端能强制切断** |

## 1. netns 验证（8/8）

### 1.1 为什么先做 netns

文档 `临时文件/测试 VM 信息.md` 里的候选 Peer，从 `oracle-x86-2` 的 SSH 端口全部不可达
（香港 `202.73.4.182:56686`、新加坡 `104.234.174.203:53455`、AWS `54.179.74.225`）。
Hub 自身出站正常（`https://www.google.com` 200），是这些主机的 SSH 端口对 Hub 关闭。

后来发现香港主机**从本机走 IPv6 可以 SSH 登录**（Hub 到它的 v6 也通），
于是补做了 §2 的真机验证。netns 部分保留，因为它验证了幂等与清理这类
不方便在生产 Hub 上反复做的动作。

### 1.2 结果

拓扑：`Hub u3hub`（10.99.0.1）、`PeerA u3pa`（10.99.0.2）、`PeerB u3pb`（10.99.0.3），
经路由器 netns 跨网段互联，两个 Peer 各自与 Hub 建立真实 WireGuard 隧道。

| 阶段 | 检查 | 结果 |
|---|---|---|
| 1 基线（无策略链） | A→Hub / A→B | 通 / 通 |
| 2 `reach=hub` | **A→B 应隔离** | **不通** |
| 2 | A→Hub 不受影响 | 通 |
| 3 指定互通 | A→B / B→A | 通 / 通 |
| 4 幂等 | 重复施加后规则条数 | 不变 |
| 5 清理 | 删链后 A→B 恢复 | 通 |

## 2. 真机两 Peer 验证（关键）

### 2.1 拓扑

```
香港 LXD (lxd1145144686160)          oracle-x86-2 (Hub)              oracle-arm-1
2001:470:19:8c2:1::2b                140.245.108.105                 161.118.228.99
出口 v4 202.73.4.182                 wg0 10.98.0.1/24                wg0 10.98.0.2
     │                                    │                               │
     └──── WireGuard 10.98.0.3 ───────────┴───── 存量 peer 10.98.0.2 ─────┘
                    (新建 peer, reach=hub)              (存量, 缺字段 = reach=all)
```

香港到 Hub：`ping` 2/2，**37ms**；WireGuard 握手成功（`latest handshake: 2 seconds ago`）。

### 2.2 结果

| 检查 | 结果 |
|---|---|
| 基线：香港 → arm-1:443（无策略链） | **通** |
| `reach=hub` 策略后：香港 → Hub | **通** |
| `reach=hub` 策略后：香港 → arm-1:443 | **不通** —— 隔离生效 |
| 指定互通（双向 ACCEPT）后：香港 → arm-1:443 | **通** |
| **客户端配置完全不动、只把服务端改回全隔离** | **不通** —— 服务端强制执行生效 |

### 2.3 最后一条最重要

「客户端配置不变，只改服务端规则就能切断」——这才是「服务端强制执行」的定义。
只靠客户端 `AllowedIPs` 的方案做不到这一点：用户随时能改自己的配置。

### 2.4 顺带验证了客户端侧的 AllowedIPs 也生效

第一次测「指定互通」时香港仍然不通，查计数发现 `KHC_WG` 全是 0 ——
包根本没到 Hub 的 FORWARD 链。原因是香港的 `AllowedIPs = 10.98.0.1/32` 只含 Hub，
发往 `10.98.0.2` 的包不进隧道。

**这恰好证明策略在两层都生效**：客户端按 `AllowedIPs` 决定往隧道送什么，
服务端按 `KHC_WG` 决定放不放行。改客户端为 `10.98.0.0/24` 后才测到服务端那一层。

## 3. 一个必须记住的顺序问题

`iptables -A FORWARD -i wg0 -j ACCEPT`（现有 `default_post_up` 的做法）在这台节点上是**死规则**：

```
-P FORWARD ACCEPT
-A FORWARD -j REJECT --reject-with icmp-host-prohibited   ← 这条先命中
-A FORWARD -i wg0 -j ACCEPT                              ← 永远走不到
```

S0 §④ 已发现这个顺序问题。所以 `KHC_WG` 链**必须插到 FORWARD 第 1 位**：

```bash
iptables -C FORWARD -j KHC_WG 2>/dev/null || iptables -I FORWARD 1 -j KHC_WG
```

`build_policy_rules()` 就是这么渲染的，有单测锁住（`test_policy_is_idempotent_by_flush_and_rebuild`）。

## 4. 生产环境未受影响核对

```
Hub FORWARD：仍是最初 6 条（KHC_WG 已 -D/-F/-X）
Hub wg0：测试 peer 已 remove，只剩原有 10.98.0.2
香港：我建的 u3test 接口与 conf 已删；**原有 wg0（11-14 建）未动，仍在运行**
节点服务：khc-agent active（0.4.0）、caddy active
```

## 5. 仍未真机覆盖的部分

- **`egress=all` 的公网 SSH 断开与回滚**：已用 netns 验过机制
  （`ui-polish-u3-rollback.md` §1），但真实发行版的 `systemd-run` 定时器未在物理机上跑过。
  香港这台是 LXD 容器、有独立 v6，适合下次补验（它的 SSH 走 v6，理论上
  `egress=all` 只接管 v4 时不会断——这个假设也还没验）。
- **DNS 行为**：`egress=all` 后的解析路径未测。

