# design-v3 §5A：无 root peer（chisel 方案，未实施归档）

> 状态：历史 ｜ 最后核验：2026-11-18 ｜ 关联：`docs/design-v3.md`、`docs/engineering/adr/ADR-0021-single-control-plane-channel.md`

从 `docs/design-v3.md` 移出的原 §5A（`chisel-server` / `chisel-client` 端口隧道设想）。仓库从未实现 `chisel` 适配器，目标 NAS/NAT 主机均通过 WireGuard 或用户态 `cloudflared`（Tunnel 模式）接入，Agent 本身的 `--user` 无 root 运行模式（§5A.4）仍保留并记录于 `docs/install.md`。

## 5A. 没有 root 的 peer

### 5A.1 结论

**chisel 不能替代 WireGuard**：它是端口隧道（HTTP/WebSocket 上跑 SSH），不是三层组网。但对**没有 root 权限的 peer** 来说，它是最稳的接入方式。分层如下：

| 节点类型 | 传输方式 | 说明 |
|---|---|---|
| Hub、有 root 的 peer | WireGuard 内核版 | 维持 §5 的握手后切换流程 |
| 无 root peer（默认） | **chisel 客户端 → Hub 上的 chisel server（WSS，挂在 Caddy 后面）** | 只转发声明过的端口；走 HTTPS，UDP 被限速或封锁的网络也能用 |
| 无 root peer（可选） | **wireproxy**（用户态 WireGuard） | 只需映射少量 TCP 端口、又想留在同一个 WG 网络里时使用；Hub 不用改，直接套用 §5 的换钥流程 |

不引入 Tailscale 用户态（需要 headscale 协调服务器，太重），也不引入 frp/rathole（和 chisel 定位相同，没有必要再加一种）。

### 5A.2 方案对比

| | chisel | wireproxy | WireGuard 内核版 |
|---|---|---|---|
| 本质 | TCP/UDP 端口隧道，WebSocket + SSH | 用户态 WG 客户端（wireguard-go + 用户态网络栈） | 三层虚拟网卡 |
| root | 不需要 | 不需要 | 需要（或 CAP_NET_ADMIN） |
| 穿透 | HTTPS/WSS，可以放在 Caddy 或 CF CDN 后面；自带指数退避重连和 keepalive 超时检测 | 仍然是 WG UDP | WG UDP |
| 反向暴露 peer 上的服务 | `R:` 反向转发 | `TCPServerTunnel` | 原生 |
| 鉴权和换钥 | authfile（`user:pass` → 地址正则白名单），**热加载**：删掉的用户立即不能再建新隧道，已经建立的隧道不受影响 | 与 WG 相同 | §5 |
| 不足 | 不是网卡，只能转发声明过的端口 | SOCKS5 的 UDP、UDP 静态路由尚未支持；仓库换过几次维护者 | 没有 root 用不了 |

### 5A.3 chisel 落地（两个适配器，核心不动）

- `chisel-server`（Hub）：监听 `127.0.0.1:<port>`，由 Caddy 在高位端口上做 WSS 反代（`/_tunnel/*`）。启动参数 `--reverse --authfile /etc/khc/chisel-users.json`，并用 `--keyfile` 固定服务端密钥，客户端用 `--fingerprint` 校验。
- `chisel-client`（peer）：普通用户运行，配置项为 server URL、fingerprint、`--auth`、remotes 列表（如 `R:127.0.0.1:2201:localhost:22`）。
- **authfile 正则必须写锚点**（`^R:127\.0\.0\.1:2201$`），否则会被前缀匹配越权。由适配器生成，不允许手写。
- 反向端口由内核的端口登记统一分配，只绑定 Hub 的 `127.0.0.1`，再由 Caddy 或转发单元决定是否对外暴露。
- **换钥（同样是先加后删）**：① authfile 新增 `user:新密码`，热加载；② peer 端 Agent 换成新凭据并重启客户端，确认重连成功；③ 删除旧用户。失败就停在 ① 之后，旧凭据仍然可用。

### 5A.4 对核心的影响：Agent 支持普通用户运行（控制面不加代理）

- 安装脚本检测到没有 root 时，进入 user 模式：程序在 `~/.local/share/khc-agent`，配置在 `~/.config/khc-agent`，用 `systemd --user` 管理（并提示执行 `loginctl enable-linger`）；没有 systemd 时退化为 nohup 加 crontab `@reboot`。
- `/adapters` 返回每个适配器的 `requires_root`。user 模式下，面板把需要 root 的应用置灰，并说明原因。
- 无 root peer 的控制通道：优先让 peer 自己跑**用户态 cloudflared**（出站隧道），Worker 直接访问 `<peer>-t.<domain>`，与 Hub 走同一套 HMAC，**核心不需要新增代理端点**。chisel 只负责数据面端口转发（§5A.3），控制面不经过它。
- 如果将来必须复用 Hub 的 chisel 反向端口做控制通道，需要在核心加一个**通用代理端点**（含鉴权、超时、审计），这属于核心变更，不在本期范围。
- 这类 peer 改 chisel 数据面配置时仍要带 30s commit-confirmed：重连失败自动回退旧配置（与 §5.4 对远端 WG 机器的规则相同）。
