# WebSSH S0 前置实测（零安装部分，2026-11-15）

> 状态：现行（一次性验收证据，写完不再修改） ｜ 最后核验：2026-11-15 ｜ 关联：`docs/plans/webssh-2026-11-15.md` §3.1/§6、PR #54

## 1. 目的与范围

提案 §6 的 S0 验收清单共 7 项。本轮在**不安装任何组件、不写 `/etc/caddy`、不 reload 生产实例**的前提下完成 ①③⑤⑥⑦；②④（ttyd 实装、tmux 接回）与浏览器端 `top`/`apt install`/一键脚本、Tunnel 节点验证，需在目标机装包并临时改 Caddy 配置，另待主人确认后补。

前置结论沿用 `webssh-caddy-smoke.md`：Caddy 动态 unix socket 上游可行；socket 属主必须改。

## 2. 环境

| 项 | 值 |
|---|---|
| 节点 | `oracle-x86-2` / `140.245.108.105`（提案指定 S0 机，**标注为「未来生产机」**） |
| OS | Ubuntu 24.04.4 LTS |
| Caddy | 2.6.2，`User=caddy / Group=caddy` |
| 已装 | ttyd **无**、tmux **无**、wg0 有 |
| WG Peer | `10.98.0.2/32`（endpoint `161.118.228.99:50865`） |
| 隔离方式 | 独立临时 Caddy：`{ admin off }` + 端口 19011 + `/tmp/khc-s0-*` 配置；测后全部清理 |

## 3. ① 目标 Caddy 版本的 fmt / validate / WebSocket Upgrade

Caddyfile（`path_regexp` 严格限定 id 为 32 位小写 hex）：

```
{
  admin off
}
:19011 {
  log { output file /tmp/khc-s0-*/access.log }
  @term path_regexp term ^/_term/([0-9a-f]{32})/
  handle @term {
    reverse_proxy unix//tmp/khc-s0-*/term-{re.term.1}.sock
  }
  handle { respond "NO_MATCH" 404 }
}
```

| 检查 | 结果 |
|---|---|
| `caddy fmt --overwrite` | **OK**（提案里手写的缩进需格式化，S1 生成配置后必须过 `fmt`） |
| `caddy validate` | **Valid configuration** |
| 普通 GET 经动态上游 | `PLAIN_OK [http 200]` |
| **WebSocket Upgrade 经动态 unix socket 上游** | **`HTTP/1.1 101 Switching Protocols`**，`Sec-Websocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`（标准 sample nonce 的正确响应）；后端日志确认收到 `Connection: Upgrade` / `Upgrade: websocket` / `Sec-Websocket-Key` |

**结论：上一轮遗留的「WebSocket Upgrade 经动态上游未验证」已闭环，101 透传正常。** Caddy 2.6.2 满足 S1 需要。

## 4. ③ 非法 id 被拒且不产生 socket 路径

同一个 Caddy 实例，四种非法 id：

```
ABCDEF0123456789ABCDEF0123456789  -> 404
short                            -> 404
../etc/passwd                    -> 404
aaaa…(40 个 a)                   -> 404
```

socket 目录内**只有**合法 id 那一个 `term-abcdef0123456789abcdef0123456789.sock`，无额外文件生成。

**结论：严格 `^/_term/([0-9a-f]{32})/` 正则可挡住大写、短 id、超长 id 与路径穿越；且非法请求不会触发上游 dial，不会产生 socket 路径。** S1 的必测项设计成立。

## 5. ⑦ K1 暴露面实测：access log 确实完整记录 bearer URL

同一实例的 Caddy access log（JSON 格式）实际输出：

```
"uri":"/_term/abcdef0123456789abcdef0123456789/"
"uri":"/_term/abcdef0123456789abcdef0123456789/ws"
"uri":"/_term/ABCDEF0123456789ABCDEF0123456789/"
```

**结论：提案 §4.1 新增的「`/_term/*` 关闭 access log 或只记路径前缀」不是多余要求，而是必须的**——只要站点配了 `log`，完整的 128 位 bearer URL 就会落盘，即使会话早已结束。同时证实 `-O` 只涉及 WebSocket，页面 GET 的 URL 一样进日志。

## 6. ⑥ 发行版源 ttyd 版本与已知漏洞

| 项 | 结果 |
|---|---|
| `apt-cache policy ttyd` | Candidate **1.7.4-1build2**（`noble/universe`），Installed: none |
| 上游最新 release | **1.7.7**（2024-03-30，GitHub Releases API 核实） |
| 1.7.4 是否含 `-U` | **含**。GitHub tag 1.7.4 的 OPTIONS 已列 `-U, --socket-owner`、`-W, --writable`、`-O`、`-b`；**缺 1.7.7 才有的 `-q, --exit-no-conn`**（S1 的「无人连接超时清理」需 Agent 侧定时器实现，不能依赖 `-q`） |
| Ubuntu 官方 CVE | `CVE-2021-34182`（ttyd 1.6.3 默认配置权限导致任意代码执行）在 **24.04 LTS 状态 `Needs evaluation`、优先级 Medium**，即 Ubuntu 尚未判定该版本是否受影响/已修复 |
| 聚合漏洞站说法 | 有站称 1.7.4/1.7.7 均受影响且「无修复版本」，与 Ubuntu 官方状态及上游修复说明矛盾，**不采信**，仅记录为待评估 |

**给 S1 的建议**：优先用上游 1.7.7 静态二进制（官方 release 提供 `ttyd.x86_64` + `SHA256SUMS`）而非 apt 源 1.7.4，理由是版本落后 3 个 patch、缺 `-q`、且 CVE 在 24.04 未评估。若坚持用 apt 源，需在 ADR-0020 记录该取舍。**本用法不是 CVE 描述的「默认配置」**（unix socket + `-o -O -U` + 随机路径 + 反代 + 默认关闭开关），风险已显著降低，但不等于无需评估。

## 7. ⑤ WG Peer 链路（只读）

```
ping 10.98.0.2        -> 2/2 received, 0% loss, rtt 0.830/0.874/0.918 ms
TCP 10.98.0.2:22      -> 可达
wg show wg0 latest-handshakes -> 1794721908（新鲜）
```

**结论：Hub → Peer 的 WG 链路与 sshd 端口可用**，S0 的「经 WG 用 ssh 进入一台 Peer」具备前置条件；实际登录需装好专用公钥后验证。

## 8. 本轮未做（需主人确认后补）

| 项 | 需要的动作 |
|---|---|
| ② ttyd 实装 + `-U` 属主 + `systemd-run` 跳出沙箱 | 在目标机装 ttyd（apt 或上游二进制）并以临时单元启动 |
| ④ 刷新后 tmux 接回 | 装 tmux（源里 `3.4-1ubuntu0.2`），起 `tmux new -A -s khc` 后断开重连 |
| 浏览器端 `top` / `apt install` / 带菜单一键脚本 | 依赖 ②，且需临时把 `/_term/*` 写进站点配置 |
| Tunnel 节点同样能用 | 需另一台 Tunnel 节点 + 同样的临时配置 |
| `-b /_term/<id>` 与动态上游配合 | 需 ttyd 实装后才能验（Caddy 不 strip 路径，预期可行） |

以上均涉及**在「未来生产机」上装包或临时改 Caddy 站点配置**，按主人规矩需明确许可后执行。

## 9. 清理核对

```
=== 残留进程 ===  无
=== 残留文件 ===  无
=== 19011 端口 ===  已释放
=== 生产 Caddy ===  active
```
