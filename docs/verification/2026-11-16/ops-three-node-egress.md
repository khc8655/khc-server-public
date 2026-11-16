# U7 三节点真机验证：Peer 隔离、S0 §④ 的顺序坑、`egress=all` 的真实表现（2026-11-16）

> 状态：证据（一次性验收记录，写完不再修改） ｜ 最后核验：2026-11-16
> 节点：Hub `oracle-x86-2`（140.245.108.105）、香港 LXD（2001:470:19:8c2:1::2b, 37ms）、
> 新加坡 LXD（2001:470:36:de8:1::51, **2.2ms**，与 Hub 同机房）
> 关联：`ui-polish-u3-peer-isolation.md`、`ui-polish-u3-egress-all.md`

## 1. 为什么这次能做得更彻底

之前只有 2 台机器，这回找到第 3 台（新加坡），而且它**与 Hub 同机房（2.2ms）**，
正好能和香港（37ms）形成对比。三节点才能验证「A↔B 都要通」这类多 Peer 场景。

### 1.1 两台 LXD 的网络结构（关键前提）

| 项 | 香港 | 新加坡 |
|---|---|---|
| 容器地址 | `10.232.210.192/24`（NAT） | `10.22.130.41/24`（NAT） |
| 公网 v4 | 无（出口 `202.73.4.182`） | 无（出口 `104.234.174.203`） |
| 公网 v6 | **无**（只有 LXD ULA） | **无**（只有 LXD ULA） |
| SSH 入口 | 宿主机 v6 映射 | 宿主机 v6 映射 |

**两台之间 v4 互通不了**（`22/80/443/53455` 全不通、ping 100% 丢包），但**走 v6 通**。
因为它们都是 NAT 后面的容器，v4 没有入站映射。

## 2. 最重要的发现：S0 §④ 那个坑是真的，而且是致命的

### 2.1 现象

三节点建好后，**不加任何策略**，香港 ping 新加坡：**不通**。

Hub 的 FORWARD 原本是：

```
-P FORWARD ACCEPT
-A FORWARD -j REJECT --reject-with icmp-host-prohibited   ← 第 2 条就是 REJECT
-A FORWARD -i wg0 -j ACCEPT                               ← 死规则
-A FORWARD -o wg0 -j ACCEPT                               ← 死规则
```

### 2.2 验证

把 `-i wg0 -o wg0 -j ACCEPT` **插到第 1 位**：

```
-P FORWARD ACCEPT
-A FORWARD -i wg0 -o wg0 -j ACCEPT    ← 现在这条先命中
-A FORWARD -j REJECT ...
```

香港 → 新加坡 **立刻通了**，40ms（香港→Hub 37ms + Hub→新加坡 2ms，吻合）。

### 2.3 这意味着什么

**升级前，任何 Peer 之间都通不了** —— 除非用户自己手动调过 iptables 顺序。
那些 `-i wg0 -j ACCEPT` 规则从来没有生效过。

而 U3 的 `KHC_WG` 链用 `-I FORWARD 1` 插入，正好绕过了这个坑。所以 U3 上线后
Peer 间互通才第一次真正可用。**这个发现应该写进 CHANGELOG 或升级说明**，
否则用户会以为「升级后 Peer 之间突然能通了」是个 bug。

## 3. Peer 隔离与指定互通（真机）

| 检查 | 结果 |
|---|---|
| 无策略（仅修好顺序） | 香港→新加坡 **通** 40ms |
| `reach=hub`（`-i wg0 -o wg0 -j DROP`） | 香港→新加坡 **不通** ✓ |
| `reach=hub` 时香港→Hub | **通** ✓（隔离不影响连 Hub） |
| 指定互通（双向 ACCEPT） | 香港→新加坡 **通** 41ms ✓ |

三节点比两节点更有说服力：M 台 Peer 时规则是 O(M) 条 `DROP` + 按需 `ACCEPT`，
不会随规模退化。

## 4. `egress=all` 在真机上的表现（修正了之前的结论）

### 4.1 SSH 不会断——前提是走 v6

全量接管 v4（`AllowedIPs = 0.0.0.0/0`）后：

```
endpoint 路由:  140.245.108.105 via 10.22.130.1 dev eth0   ← 正确，未自环
默认路由:       1.1.1.1 dev u7all table 51820              ← 接管成功
本会话:         存活
新 SSH 连接:    成功（走宿主机 v6 映射）
v4 出网:        断
```

**结论：只接管 v4 时，走 v6 的 SSH 完全不受影响。** 这修正了 `ui-polish-u3-egress-all.md`
里「入口不在 v4 上所以没断」的措辞 —— 那次是「恰好躲过」，这次是**明确验证了 v6 通路不受影响**。

### 4.2 但 v4 出网是断的（Hub 侧没配好）

Hub 上 `wg0→ens3` 有 9 个包通过（588 字节），NAT 规则 `-s 10.98.0.0/24 -o ens3 -j MASQUERADE`
也在，但**回包不返回**：

```
Hub 自己:  ping 8.8.8.8 通 / curl 1.1.1.1 返回 301
经隧道:    ping Hub 内网 通 / ping Hub 公网 通 / DNS 解析正常
经隧道出公网: connect=0（TCP 握手包不回来）
NAT 计数:   4 个包（而 FORWARD 放行了 9 个）
```

**没定位到根因。** 候选方向：Oracle Cloud 的出站/回程安全策略、MTU 分片、
conntrack 在 wg0 上的处理。下次可做：在 Hub 抓 `ens3` 双向包，同时在新加坡发起请求。

> 这条**不影响「断开风险」的验证**（§4.1 已确认 v4 会断），影响的是
> 「`egress=all` 能不能正常用」——目前看**不能**，出网是坏的。必须修好 Hub 侧才能上线这个功能。

### 4.3 一个健壮性缺陷（必须修）

第二轮施加时，`wg-quick up` 直接失败回滚：

```
[#] ip route add 140.245.108.105/32 via 10.22.130.1 dev eth0
RTNETLINK answers: File exists          ← 上一轮的 PostUp 路由还在
[#] ip rule delete table 51820
[#] ip link delete dev u7all            ← 整条链回滚，接口被删
```

**`PostUp` 用 `ip route add` 不幂等**：残留一次，之后每次 up 都失败，且失败方式是
「静默回滚」—— 用户只会看到接口没建起来。

必须改成 `ip route replace`（或者 `add ... 2>/dev/null || replace`）。
**这是产品代码要改的地方**，不只是测试脚本。

## 5. 定时回滚：第二次真机验证通过

两轮都用 `systemd-run --on-active` 布防，均成功自救：

```
[13:08:39] 回滚开始 → [13:08:39] 回滚完成
[13:11:15] 回滚开始 → [13:11:16] 回滚完成
```

回滚后 `v4 出网: 104.234.174.203`（正确）。

**但回滚脚本漏了一件事**：`wg-quick down u7all` 在路由已被 `ip rule` 改动后会失败，
导致接口残留（要手动 `ip link del`）。产品代码的回滚要补 `ip link del` 兜底。

## 6. 清理

```
Hub:    实验 peer 已 remove（剩 1 个原有）；FORWARD 回到原始 6 条；KHC_WG 已 -D/-F/-X
香港:   u7.conf 等已删；**原有 wg0.conf 与运行中的 wg0 未动**
新加坡: u7*.conf、回滚脚本、日志已删；**原有 khc0.conf 未动**
```

## 7. 结论与后续

**已确认（可写进文档）**：
1. Peer 隔离在真机成立，`reach=hub` 默认隔离不影响连 Hub。
2. 指定互通双向放行有效。
3. `egress=all` 只接管 v4 时，走 v6 的 SSH 不受影响。
4. Peer 间互通依赖 FORWARD 顺序，原有 `default_post_up` 的 ACCEPT 是死规则。

**待修（代码层面）**：
1. `egress=all` 时 `PostUp` 的 endpoint 路由要用 `ip route replace`，否则重复 apply 必失败。
2. 回滚要补 `ip link del` 兜底（`wg-quick down` 可能已失效）。

**待查**：
1. `egress=all` 的出网为什么不通（Hub 侧转发/NAT 有 4/9 的缺口）。
   **在修好之前，`egress=all` 不应该对用户开放。**
