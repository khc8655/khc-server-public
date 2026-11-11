# 实测环境与接入步骤记录（2026-11-02）

> 供后续接手者复现/运维参考。配套报告：[report.md](./report.md)、测试计划：[test-plan.md](./test-plan.md)。

## 1. 环境实测

### 1.1 线上控制面

- 入口：`https://panel.example.com/`（Worker 名 `<worker-name>`，`ENVIRONMENT=production`，D1 `<d1-name>`，**无 KV 绑定** → 登录限流失效，见报告 P1-5）。
- API 前缀 `/api/v1`；会话 cookie `khc_sess`（JWT，24h）。
- Agent 官方发布包（签名清单内）：`https://panel.example.com/agent/khc-agent-0.1.4.tar.gz?v=20261101`，sha256 `1592311d89230effaa6d485e5ff94bc49b6f574a2a608a691c92648f2f79763b`。

### 1.2 机器

| 机器 | SSH | 要点 |
|---|---|---|
| test-hub（hub，203.0.113.10） | `ssh -i "<local-volume>/工具/vm/aws/<cloud-key>.pem" <ssh-user>@203.0.113.10` | Debian 12；agent :8443（token `/etc/khc-agent/token`）；wg0 51820/udp（WG 网 10.99.0.1/24）；Caddy 80/443；Lightsail 防火墙仅放行 80/443/8443/tcp+51820/udp |
| node-test-3（203.0.113.11） | `ssh -i "<local-volume>/工具/vm/Oraclecloud/khc.key" <ssh-user>@203.0.113.11` | Ubuntu 24.04 arm64；有旧 agent（:80，节点 e2e-oracle-arm-80，Oct 31 装）；wg 测试时装的 `wireguard-tools` 保留（无害） |
| node-test-2（203.0.113.14） | `ssh -i "<local-key-path>" <ssh-user>@203.0.113.14` | 未来生产机：干净 Ubuntu 24.04，Python 3.12.3，80/443/8443 空闲，可达发布包下载源；预检需装 wg/caddy/socat |
| 香港 NAT（203.0.113.13:<ssh-port>） | ❌ 不可达 | TCP 全超时（ICMP 通），NAT 映射失效待修 |

## 2. 关键操作流（实测命令）

### 2.1 面板 API 登录

```bash
curl -s -c /tmp/khc-cookie.txt -X POST -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<口令>"}' \
  https://panel.example.com/api/v1/auth/login
# 后续请求统一：curl -b /tmp/khc-cookie.txt ...
```

### 2.2 节点创建 → Agent 安装（面板标准路径）

1. `POST /api/v1/nodes`（name 等）→ 拿一次性 token；
2. `POST /api/v1/nodes/:id/install-command` → 生成安装命令（**不含 token**，执行时 `read -rs KHC_TOKEN </dev/tty` 交互输入）；
3. 在目标机执行命令：下载 0.1.4 包 → sha256 校验 → `install.sh --system --host 0.0.0.0 --port 8443`；
4. 面板 `/state` 出现 `reachable:true`（`via:"tcp"`，Worker→裸 IP 走 `cloudflare:sockets`）。

**非交互安装（自动化/重装）**：安装命令里的 `read </dev/tty` 在管道 stdin 下会挂起。绕过方式——先放 token 再直接跑 install.sh（token 已存在时 install.sh 不会覆盖）：

```bash
sudo mkdir -p /etc/khc-agent
sudo install -m 600 <token文件> /etc/khc-agent/token
# 下载解包包后：
sudo ./install.sh --system --host 0.0.0.0 --port 8443
```

### 2.3 卸载

`POST /api/v1/nodes/:id/uninstall-command` → 在节点上执行（清 `/opt/khc-agent`、`/var/lib/khc-agent`；`/etc/khc-agent/token` 实测**会**被清掉，重装前需重新写入）。卸载后应用本地态（host-ops 密钥、WG peer 公钥映射）全部丢失，恢复见报告 P2-11。

### 2.4 应用配置（PUT → apply）

```bash
# 读当前配置
curl -b cookie https://panel.example.com/api/v1/nodes/<id>/apps/<app>
# PUT 新配置（rev 由服务端自增；写 D1 不碰 Agent）
curl -b cookie -X PUT -H 'Content-Type: application/json' -d @new.json .../apps/<app>
# 生效（转发 Agent，携带 expectRev；幂等键建议显式传）
curl -b cookie -X POST -H 'Content-Type: application/json' \
  -d '{"idempotencyKey":"<unique>"}' .../apps/<app>/apply
```

### 2.5 Peer 接入（host-ops onboard）

1. hub 侧先建 WG peer（`client_config` 拿配置，peer 机 `wg-quick up`）；
2. `POST .../apps/host-ops/onboard {"peerId":"..."}` → 返回 ~90KB 一键命令；
3. 在 peer 机以 root 执行 → 装好 `/usr/local/sbin/khc-host` + 受限 authorized_keys；
4. `POST .../apps/host-ops/call {"target":"<peerId>","verb":"status"}`（经 WG SSH，6s 超时）；
5. 卸载：执行 onboard 响应里的 `uninstallCommand`（注意报告 P2-10：authorized_keys 可能残留一行，手动 `sed /khc-hub/d`）。

### 2.6 防火墙 60 秒确认（peer）

`fw.apply`（写 nft `table inet khc_fw` + 60s systemd-run 回滚定时器）→ 60s 内 `fw.confirm` 持久化，否则自动回滚（实测 70s 内生效）。锁定保护误报的绕过：deny 规则源网段避免用包含 hub WG IP 的宽网段（如 `0.0.0.0/0` 会被误报，见报告 P1-4）。

## 3. 踩坑实录

1. **`read </dev/tty` 挂起**：非交互 SSH 执行面板安装命令两次超时。结论：命令面向真人终端设计（#31 防 token 入历史）；自动化场景按 §2.2 绕过。
2. **自建包被拒**：本地 `package.sh` 打的包走 `install-command` 会被 `release_not_in_manifest` 400 拒绝——#32 签名清单按设计工作。测试一律用官方 0.1.4 包。
3. **卸载后 token 丢失**：文档语义"token 保留"与实测不符（实测 `/etc/khc-agent` 整体清除）。重装前务必另存 token（本次提前存到本地 `/tmp/hub-token.txt` 才得以恢复）。
4. **重装后 `/state` 的 peers/应用态为空**：wg0 仍在跑但面板 peers=[]（P1-6）；host-ops 需显式 `POST /install` 才恢复密钥；hub 密钥重建后旧 peer 全部失联需重新 onboard（P2-11）。
5. **WG 删除 peer 内核残留**：apply 空 peers 后必须 `sudo wg show wg0` 复核，必要时 `sudo wg set wg0 peer <pubkey> remove`（P1-9）。
6. **Cloudflare 裸 IP 403**：所有 Worker→Agent 调用走 TCP 通道（`via:"tcp"`）；`/state` 实测 2.1–2.4s，3s 超时偶发踩线（P1-7）。
7. **macOS `/tmp` 会被清理**：cookie/token 等临时凭据不要隔天复用。
8. **systemd failed unit 残留**：删除转发 unit 后 `systemctl reset-failed khc-forward-<name>.service` 清理显示。

## 4. 本次清理对照表

见报告 §5（所有测试对象已还原/删除；arm-1 上 `wireguard-tools` 包保留属正常依赖）。

## 5. 补测清单（环境修复后）

- 香港 VM：外网 peer 接入、破坏性场景（服务失败/防火墙变更确认/误配置回滚在公网 peer 上的表现）。
- 二维码 UI 走查（`client_config` 的 `qr` 字段当前为 null，P2-8）。
- 登录限流 429（修复 KV 绑定后复测 F5）。
