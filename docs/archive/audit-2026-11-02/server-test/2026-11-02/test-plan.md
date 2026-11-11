# 服务端端到端测试计划（2026-11-02）

> 测试人：Agent（受主人委托）；线上环境：https://panel.example.com/（Cloudflare Worker + D1 + Agent）。
> 红线：不新建任何 Cloudflare 资源；不动生产 Worker 配置；node-test-2 只做只读/低风险检查；测试后清理残留。

## 1. 环境勘察结论（实测）

### 1.1 机器现状

| 机器 | 角色 | SSH 实测 | 现状 |
|---|---|---|---|
| test-hub（203.0.113.10） | 测试 Hub | ✅ admin + Lightsail key | Debian 12，khc-agent 0.1.4 已装（:8443，active，面板节点 `sp-vm-aws` 在线）；wg0 51820/UDP 已起；Caddy active（80/443）；socat/wg 有，**nft 无** |
| 香港 NAT（203.0.113.13:<ssh-port>） | 计划 peer | ❌ **TCP 全部超时**（ICMP 通） | NAT 端口映射疑似失效，SSH 不可达 → 相关用例改由 node-test-3 承担或标 BLOCKED |
| node-test-3（203.0.113.11） | 改用 peer | ✅ ubuntu + khc.key | Ubuntu 24.04，khc-agent 已装（:80，面板节点 `e2e-oracle-arm-80` 在线）；Caddy 443；**wg 未装** |
| node-test-2（203.0.113.14） | 未来生产机 | ✅ ubuntu + <local-key-path> | Ubuntu 24.04，干净机器（仅 sshd + rpcbind），无 agent/wg/caddy |

### 1.2 网络与端口约束（影响用例设计）

- Lightsail 防火墙（aws hub）仅放行 80/443/8443/tcp + 51820/udp → 端口转发的**外部**连通性只能在这些端口内验证，其余在本机/经 WG 验证。
- Worker→Agent 裸 IP 必须走 `cloudflare:sockets` TCP 通道（实测 `sp-vm-aws`/`e2e-oracle-arm-80` 均经 `via:"tcp"` 可达，符合设计）。
- 面板已有 7 个节点注册（含历史遗留：vm1-HK、peer2-user-mode-test、e2e-oracle-arm×3、aws_hui_us）。本次只新增临时节点，结束后删除自己新增的。

## 2. 用例矩阵

| # | 能力 | 怎么验 | 在哪台 | 风险与回滚 |
|---|---|---|---|---|
| A1 | 登录/会话 | 正确口令 200 + cookie；错误口令 401；无 cookie 访问 API 401 | 线上面板 | 无 |
| A2 | 概览/节点列表 | API `/nodes` + 浏览器走查截图 | 线上 | 无 |
| A3 | 节点创建与 token | 新建临时节点，确认返回一次性 token | 线上 D1 | 结束时 DELETE |
| A4 | Agent 安装命令生成 | `agent/install-command`（system/user）、`bash -n` 校验、非法 URL 拒绝 | 线上 + 本地 | 无 |
| B1 | 节点概况回传 | `/nodes/:id/state` host 指标（mem/disk/uptime）+ 浏览器走查 | aws hub | 无 |
| B2 | Caddy 站点 | 新增静态站点（`pkg-203-0-113-10.sslip.io:443`）plan→apply→curl 验证；再改配置 apply | aws hub | 改前 rev 可回滚；结束删除测试站点 |
| B3 | Agent 真实安装/重装 | 本地 `package.sh` 打包 → 经 B2 静态站点分发 → 卸载 hub agent → 面板生成 install 命令真实执行 → 节点重新上线 | aws hub（**放在最后**） | 失败可用 SSH 手工 `install.sh` 恢复；保留 SSH 通道不受影响 |
| C1 | WireGuard peer/二维码/连通性 | 面板建 peer → `client_config` → arm-1 装 wireguard-tools 并起隧道 → hub `wg show` 握手 + arm-1 ping 10.99.0.1；二维码走浏览器走查 | aws hub + arm-1 | peer 删除即回滚；arm-1 conf 删除还原 |
| C2 | 端口转发 | hub 上加转发（tcp 监听 → peer WG IP:80），hub 本机 curl 验证 + unit 状态；结束后删规则 | aws hub | 删规则即回滚 |
| D1 | 主机运维（self） | host-ops install → status/processes/keys.list/keys.add/keys.remove | aws hub | 公钥只动 managed 块；结束后删测试键 |
| D2 | 防火墙 60 秒确认 | hub 装 nftables（apt，测试机允许）→ fw.apply 放行规则 + fw.confirm；再 apply 后**不确认** → 60s 自动回滚验证 | aws hub | 锁定保护（SSH/WG/8443 强制保留）+ 自动回滚双保险 |
| D3 | Peer 运维（SSH 经 WG） | onboard arm-1（面板生成命令，SSH 粘贴执行）→ 面板 call status/processes | arm-1 | uninstall 命令可完整卸载 |
| D4 | 诊断 | 面板诊断入口（hub + agent 核心码）；停 Caddy 制造故障看 problems | aws hub | systemctl 重启即恢复 |
| E1 | Agent 离线表现 | 停 arm-1 agent → 面板 reachable:false + 错误信息；重启恢复 | arm-1 | 重启即恢复 |
| E2 | 误配置回滚 | caddy-site 非法配置 apply → 期望失败且旧配置原样（lastApplyError 记录） | aws hub | 内核自动回滚 |
| F1 | HMAC 边界 | hub 本机 curl：无签名/错签名/过期 ts/重放 nonce → 全 401 | aws hub | 无 |
| F2 | token 越权 | 用 A3 新节点的 token 签名请求 hub agent → 401 | aws hub | 无 |
| F3 | 未知 verb/app | host-ops 未知 verb → E_UNKNOWN_VERB；agent 未知 app/action → 4xx | aws hub | 无 |
| F4 | 日志泄露检查 | agent journal / audit / 错误响应 grep token 明文 | aws hub + 线上 | 无 |
| F5 | 登录限流 | 错误口令连打至 429（放在最后，触发后 5 分钟冷却） | 线上 | 等待自动解锁 |
| G1 | node-test-2 只读检查 | SSH 系统信息 + `install.sh --check`（预检不改系统） | x86-2 | 无 |
| H1 | 清理 | 删测试节点/站点/peer/转发/公钥/包目录；arm-1 删 wg conf + khc-host + sudoers；记录清单 | 全部 | 见 setup-notes 清理章节 |

## 3. 执行顺序

A1→A2→A3→A4 → B1→B2 → C1→C2 → D1→D2→D3→D4 → E1→E2 → F1–F4 → G1 → 浏览器走查补截图 → **B3（agent 重装）** → F5（限流，最后）→ H1（清理）→ 出报告。

## 4. 已知环境阻塞（先行声明）

- **香港 NAT 机不可达**：203.0.113.13 的 <ssh-port>/22/80/443 TCP 全部超时（ICMP 通）。原计划"香港做 peer + 破坏性实验"的用例改到 arm-1/aws hub；若必须用香港机需主人修复 NAT 映射。
- Lightsail 防火墙外部端口受限 → 端口转发仅能本机/WG 内验证。
