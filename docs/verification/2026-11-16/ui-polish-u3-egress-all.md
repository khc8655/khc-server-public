# U3 补充：`egress=all` 的断开行为与定时回滚（真机，2026-11-16）

> 状态：证据（一次性验收记录，写完不再修改） ｜ 最后核验：2026-11-16
> 节点：香港 LXD `lxd1145144686160`（`2001:470:19:8c2:1::2b`，root 登录），Hub `oracle-x86-2`
> 关联：`ui-polish-u3-rollback.md`（netns 版机制验证）、`ui-polish-u3-peer-isolation.md`（隔离验证）

## 1. 这台机器的网络本质（决定了结论怎么读）

| 项 | 实测 |
|---|---|
| 容器地址 | v4 `10.232.210.192/24`（LXD 内网，NAT） |
| v6 地址 | 只有 ULA `fd42:3180:c365:5557:...`（**不是公网 v6**） |
| 出口公网 IP | `202.73.4.182`（NAT 出口） |
| 我的 SSH 入口 | `2001:470:19:8c2:1::2b:22` → LXD 宿主机映射到容器 |
| systemd | 可用（`systemd-run` 存在，`is-system-running` = running） |

**关键**：SSH 到这台机器走的是**宿主机 v6 映射**，不是容器的 v4。
所以「`egress=all` 只接管 v4 时 SSH 是否断」在这里的答案是**不会断** —— 但这不是
因为策略安全，而是因为**入口本来就不在 v4 上**。

## 2. 实验一：定时回滚能否在真实 systemd 上自救

这是 netns 版无法覆盖的部分（netns 里跑不了 systemd，之前用 `sleep` 代替）。

**顺序严格照文档要求**：先布防定时器，再加载路由。

```
1. systemd-run --on-active=90 --unit=u3rollback /root/u3-rollback.sh
   -> "Running timer as unit: u3rollback.timer"，NEXT 89s
2. 之后才 wg-quick up u3all（AllowedIPs = 0.0.0.0/0）
```

**结果：成功自救。**

```
[2026-11-16T10:22:48+00:00] 开始回滚
[2026-11-16T10:22:49+00:00] 回滚完成，默认路由：
default via 10.232.210.1 dev eth0 metric 1024
```

回滚后核对：v4 出口恢复 `202.73.4.182`、到 Hub `1 received`、`ip rule` 残留 **0 条**、
`u3all` 已删除。

> 这是真实发行版（Ubuntu + systemd）上第一次验证通过。
> 之前 netns 用 `sleep` 代替，只能证明「定时器逻辑本身与网络无关」，
> 这次证明了 `systemd-run --on-active` 这条真实路径也可靠。

## 3. 实验二：全量接管后，SSH 与新连接的表现

### 3.1 接管生效确认

```
默认路由（接管前）: default via 10.232.210.1 dev eth0
默认路由（接管后）: 1.1.1.1 dev u3all table 51820 src 10.98.0.3
endpoint 路由:      140.245.108.105 via 10.232.210.1 dev eth0   ← 走物理网卡，未自环
```

endpoint `/32` 的直连路由生效，没有出现 `ui-polish-u3-rollback.md` §1.4 描述的自环。

### 3.2 关键观察：现有会话活着，新连接连不上

| 检查 | 结果 |
|---|---|
| 我这条已建立的 SSH 会话 | **正常**（能继续执行命令） |
| `202.73.4.182:22`（容器自己的 NAT 出口） | **连不上** |
| `10.232.210.1:22`（内网网关） | **连不上** |
| 容器内 v4 出网（`curl ifconfig.me`） | **断** |

**这修正了文档里「SSH 会立即断开」的表述精度**：准确说是
**新连接无法建立**，已建立的连接在会话空闲超时或网络栈重连前不会立刻被踢。
实际观感取决于有没有活动流量 —— 正在传输的会话可能卡死，空闲会话可能撑一会儿。

对用户的影响没有区别（断线是迟早的、且无法重连），但文案上说「无法新建连接」比说
「立即断开」更贴合真实行为。**建议 UI 文案改为「断开后无法重连」**，
这比「立即断开」更准确，也更能说明严重性（不是抖一下就恢复，是回不来）。

### 3.3 隧道正常但出网仍断

第二次实验中 Hub 侧已加入该 Peer，隧道握手成功：

```
latest handshake: 4 seconds ago
transfer: 92 B received, 180 B sent
```

但 `curl -4 ifconfig.me` 仍断。原因是 Hub 侧还没为该 Peer 渲染 `egress=all` 的
放行与 NAT —— 这正是策略链该做的事，符合预期。

## 4. 这次没测到什么（诚实记录）

- **「SSH 走 v4 时被断开」**：这台机器的入口不在 v4 上，无法构造这个场景。
  要验它需要一台「SSH 走 v4 且能带外恢复」的机器。
- **DNS 行为**：`egress=all` 后 `systemd-resolved` 的解析路径没测。
- **`egress=all` 的完整成功路径**（隧道通 + NAT 正常 + 出网可用）：
  需要 Hub 侧带上 `egress=all` 的完整策略渲染才能验，本次只验了失败态。

## 5. 清理

```
Hub:      测试 peer 已 remove（剩 1 个原有 peer）；FORWARD 6 条；无 KHC_WG
香港:     u3all.conf、u3-rollback.sh、u3-rollback.log 已删
          所有 u3* 定时器已 reset-failed（0 个残留）
          **原有 wg0.conf（11-14 建）与运行中的 wg0 未动**
```

## 6. 对 U3 文档的修订建议

1. **UI 风险文案**：把「公网 SSH 会立即断开」改为「断开后无法重连」。
   实测表明已建立会话不会立刻断，但断了就回不来 —— 后者才是用户该被警告的。
   相关位置：`zh.wireguard.network.egressWarnBody1`、`docs/security-boundaries.md` §12。
2. **回滚要求可以更肯定**：`systemd-run --on-active` 在真实发行版上验证通过，
   文档里「必须在加载路由之前布防」这条要求有实测支撑，可以写成硬要求而非建议。
