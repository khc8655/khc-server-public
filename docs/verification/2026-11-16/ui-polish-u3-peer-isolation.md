# U3 真机验证：Peer 隔离与策略链（2026-11-16）

> 状态：证据（一次性验收记录，写完不再修改） ｜ 最后核验：2026-11-16 ｜ 关联：PR、`docs/plans/ui-polish-2026-11-16-todo.md` §6
> 节点：`oracle-x86-2`（ubuntu@140.245.108.105），Agent 0.3.3，内核实 7.0.0-1016-oracle，真实 WireGuard

## 1. 为什么用 netns 而不是远端 VM

清单要求「真机，至少两个 Peer」。实测发现文档里的候选 Peer 全部不可用：

| 主机 | 地址 | 实测 |
|---|---|---|
| 香港 NAT | `202.73.4.182:56686` / `2001:470:19:8c2:1::2b` | **从 Hub 全部不可达**（22/2222/56686/10022/2022 全关，v4 与 v6 都不通） |
| 新加坡 NAT | `104.234.174.203:53455` / `2001:470:36:de8:1::51` | 不可达 |
| AWS Lightsail | `54.179.74.225` | 不可达（本机与 Hub 都不通） |
| oracle-arm-1 | `161.118.228.99` | 22 关；但它是现有 peer（`10.98.0.2`），**经 wg 可 ping 通 1ms** |

Hub 自身出站正常（`https://www.google.com` 200），所以不是 Hub 侧断网，是这些主机已关机或换了 IP。

`oracle-arm-1` 虽然经 wg 可达，但从公网无法登录（22 关），改不了它的配置。
**结论：没有可登录的第二个真实 Peer。**

改用 netns 内**真实 WireGuard**（真实握手、真实内核转发、真实 iptables）验证策略链效果。
这能验证服务端强制执行的隔离行为，且完全不碰 Hub 的生产 `wg0` 与 `FORWARD`。

## 2. 拓扑

```
Hub  u3hub  wg0 10.99.0.1/24   公网 172.60.0.10   ← 挂 KHC_WG 策略链
PeerA u3pa  wg0 10.99.0.2/24   公网 172.50.0.20
PeerB u3pb  wg0 10.99.0.3/24   公网 172.51.0.30
路由器 u3rtr 172.50.0.1 / 172.51.0.1 / 172.60.0.1
```

三个 netns 通过 veth + 路由器连接，模拟跨网段公网。两个 Peer 各自与 Hub 建立真实 WireGuard 隧道
（`persistent-keepalive 5`）。

## 3. 结果：8/8 通过

### 阶段 1 基线（无策略链）

```
[PASS] A -> Hub             通
[PASS] A -> B（无策略时互通）  通
```

确认「不施加策略时全体互通」——这正是升级前的行为，也是存量的默认状态。

### 阶段 2 reach=hub（新建 Peer 的默认值）

规则：

```
-N KHC_WG
-A KHC_WG -i wg0 -o wg0 -j DROP
-A KHC_WG -j RETURN
```

```
[PASS] A -> B（reach=hub，应隔离）   不通
[PASS] A -> Hub（隔离不影响连 Hub）  通
```

**这是 U3 最核心的验收项：新 Peer 默认 ping 不通其他 Peer，但连 Hub 不受影响。**

### 阶段 3 指定互通（双向）

规则：

```
-A KHC_WG -s 10.99.0.2/32 -d 10.99.0.3/32 -i wg0 -o wg0 -j ACCEPT
-A KHC_WG -s 10.99.0.3/32 -d 10.99.0.2/32 -i wg0 -o wg0 -j ACCEPT
-A KHC_WG -i wg0 -o wg0 -j DROP
-A KHC_WG -j RETURN
```

```
[PASS] A -> B（互相点名，应通）  通
[PASS] B -> A（双向都要通）     通
```

### 阶段 4 幂等性

```
[PASS] 重复施加后规则条数不变
```

靠「先 `-F` 整链再重建」与「`-C` 判存在再 `-I`」实现，不依赖调用方去重。

### 阶段 5 清理

```
[PASS] 删除链后 A -> B 恢复  通
```

`-D FORWARD -j KHC_WG` + `-F` + `-X` 后回到互通状态，确认 PostDown 的对称清理有效。

## 4. 一个必须记住的顺序问题

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

## 5. 生产环境未受影响核对

```
Hub 生产 FORWARD：仍是最初 6 条（未增未减）
Hub wg0：仍只有原有 peer 10.98.0.2，allowed-ips 未变
现有 peer 连通：1 received
netns 残留：空
```

## 6. 仍未真机覆盖的部分

- **客户端 `AllowedIPs` 的实际生效效果**：本次只验证了服务端 FORWARD 策略。
  客户端配置生成有单测（`clientAllowedIps`），但「装上之后 Peer 真的只把该走的流量送进隧道」
  需要一台可登录的真实 Peer 才能验。
- **`egress=all` 的公网 SSH 断开与回滚**：已在 `ui-polish-u3-rollback.md` 用 netns 验过断开原因与
  回滚机制，但真实发行版的 `systemd-run` 定时器仍需真机补验。
- **跨真实的两个物理 Peer**：等有可登录的第二台机器时补。

## 7. 清理

```
netns u3hub/u3pa/u3pb/u3rtr  -> 已删除（trap 自动 + 复核为空）
veth u3v1/u3v2/u3v3          -> 已删除
临时密钥 /tmp/u3*.key         -> 已删除
临时脚本 /tmp/u3-*.sh         -> 已删除（root 写入需 sudo rm）
```
