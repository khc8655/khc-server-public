# 节点接入 Runbook（node-onboarding）

> 状态：现行 ｜ 最后核验：2026-11-06 ｜ 关联：`docs/agent-lifecycle.md`、`docs/runbook/troubleshooting.md`、`agent/install.sh`
> 范围：把一台干净 Linux 机器从零接入面板，直至节点 `/state` 上线的端到端步骤

## 1. 前置条件

| 项 | 要求 | 实测参照 |
|---|---|---|
| 系统 | Debian 12 / Ubuntu 24.04（systemd 必需；fw 回滚定时器依赖 `systemd-run`） | lightsail（Debian 12）/ node-test-2（Ubuntu 24.04） |
| Python | ≥ 3.11（安装包自带解释器检测，`install.sh --check` 会报） | 两台测试机均满足 |
| 出站网络 | 能访问发布包地址（面板「Agent」卡给出的 packageUrl） | 测试环境为 `https://panel.example.com/` |
| 入站端口（云防火墙 + 机内 nftables） | 按入口路径放行，见 §4 端口选择 | lightsail 实测放行：80/443/8443 tcp + 51820 udp |

## 2. 预检（只读，不改系统）

```bash
sudo ./install.sh --check
```

- 输出 PASS / WARN / FAIL 三级；WARN 不阻塞安装（如 wg/caddy/socat 未装——按需装应用时才需要）。
- FAIL 项必须先解决（Python 版本、systemd 缺失等）。
- 也可以直接跑面板 install-command 前先在目标机单独执行此步。

## 3. 面板建节点与 token

1. 面板「节点」页 → 添加节点：填 `name` 与 `endpoint`（如 `http://<IP>:8443` 或 `https://<域名>:8443`；格式 `scheme://host[:port]`）。
2. 创建成功响应**一次性返回节点 token**（仅此一次显示，D1 只存 AES-GCM 密文）——立即妥善保存；后续 Agent 升级不需要它，但重装/换机需要。
3. 在节点详情「Agent」卡复制 install-command（含发布包 URL 与 sha256）。

## 4. 端口选择（8880 vs 8443，实测差异）

代码默认 `0.0.0.0:8880`（`agent/install.sh` `KHC_PORT` / `--port`）。**端口本身随便选，约束来自 Worker→Agent 的入口路径**：

| 入口路径 | 端口约束 | 说明 |
|---|---|---|
| 裸 IP + Worker TCP 通道（`cloudflare:sockets`） | **任意端口** | Worker 对裸 IP 的原生 `fetch()` 一律 403 error 1003，走 TCP socket 后无端口限制；实测 hub 用 `http://<IP>:8443`，`/state` 响应 `via:"tcp"` |
| 域名 + Worker 原生 fetch（Cloudflare 代理） | 白名单端口 | HTTP：80/8080/8880/2052/2082/2086/2095；HTTPS：443/8443/2053/2083/2087/2096 |
| cloudflared 隧道（方案 B） | 无（出站连接） | `nodes.tunnel_endpoint` |

选择建议：云防火墙只放行了某几个端口时（如 lightsail 的 8443），用 `--port 8443`；无约束时用默认 8880。**记住所选端口**——防火墙锁定保护会自动识别 Agent 实际监听端口（`/proc` 实测），无需手工登记。

### 4.1 三种并列的接入方案（2026-11-06 口径修订，取代 D-3「直连首选 / Tunnel 备用」）

控制通道有**三种并列方案**，每台节点在创建/配置时**选定其一**；运行时只走所选方案，失败即返回明确错误，**不存在主备关系，也不做跨方案回退**。节点在境内还是境外不改变机制，地域不是选择依据。

**方案 A：https + 域名 + 公网可信证书直连。** 给节点签发**域名**证书（Let's Encrypt / ZeroSSL 等公网 CA；注意这些 CA **不签发裸 IP 证书**），`endpoint` 填 `https://<域名>:<端口>`——域名走 fetch 需选 Cloudflare HTTPS 白名单端口（443/8443/2053/2083/2087/2096）。**TLS 由平台校验证书**（fetch 与 TCP 两条通道都强制校验，无法跳过），Worker 侧零配置。没有证书的明文 `http://` 只有 HMAC 防请求篡改，**没有传输机密性**（凭据、WireGuard 私钥会过公网），仅限可信网络临时使用；裸 IP 若没有域名，请走方案 B（Tunnel），不要用自签或明文硬撑。

**方案 A 证书准备（system 模式已自动化）。** 系统模式下，面板生成的安装命令会带
`--acme <域名>`：证书缺失时 `install.sh` 自动安装 acme.sh 并用 **TLS-ALPN-01（只占用 443）**
签发，失败再回退 **HTTP-01（80）**，最后写入 `--tls-cert/--tls-key` 的固定路径；已有证书则跳过。
因此只需保证：**入站 443、出站 443**；若要用 HTTP-01 回退再加 **入站 80**；Cloudflare 记录必须是
**「仅 DNS」（灰云）**，橙云会拦截 ACME 校验。`--with-caddy` 仍只安装 Caddy 软件包，不参与证书。

**入站 80/443 不可达的节点（境内未备案、只开非标端口）：加 `--acme-dns` 走 DNS-01。**
DNS-01 只靠出站 443 + DNS 记录，不占用任何入站端口，因此也不需要停 Agent/Caddy、不需要 socat：

```bash
# provider 只有 cloudflare / route53；凭据只从环境变量读（不写盘、不进 acme.sh 配置以外的地方）
sudo CF_Token='<Cloudflare API Token>' ./install.sh --system \
  --acme agent.example.com --acme-dns cloudflare \
  --tls-cert /etc/khc-agent/tls/fullchain.pem --tls-key /etc/khc-agent/tls/key.pem \
  --host 0.0.0.0 --port 8443

# route53：AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY（可选 AWS_SESSION_TOKEN）
```

凭据缺失或 provider 不在白名单时，`install.sh` 会在**改动系统之前**直接报错退出。
provider 名称与证书适配器的 `_PROVIDER_DNS` 同源（`cloudflare → dns_cf`、`route53 → dns_aws`），
面板里的 ACME 签发与安装脚本用的是同一套命名。

**续期载体是 systemd timer，不是 crontab。** 无论用 `--acme` 还是 `--acme-dns`，`install.sh` 都会写入
`khc-acme-renew.service` + `khc-acme-renew.timer`（`OnBootSec=15min`、`OnUnitActiveSec=1d`、
`RandomizedDelaySec=30min`、`Persistent=true`），执行 `acme.sh --cron`——它只在到期窗口内真正续签，
多跑是空转。这样即使镜像里装不上 cron 也能自动续期；没有 systemd 时脚本会 WARN 并给出手工命令。
复核：

```bash
systemctl list-timers | grep acme                  # 下一次触发时间
systemctl start khc-acme-renew.service             # 立即跑一次续期
sudo ./install.sh --system --check ...             # 预检里会显示「ACME 走 DNS-01」或入站端口要求
```

Agent 也会把这些事实回报给面板诊断：`certificates.status()` 里的 `tls`（证书路径/到期日/剩余天数）与
`renewal`（timer 是否安装），剩余 ≤30 天报 `tls_cert_expiring`、已过期报 `tls_cert_expired`——
这条链路专补「用 `--acme` 直写本机、因而从不进入证书库」的那张证书。

需要 DNS-01 或自定义 CA 时，仍可手动签发到同一路径：

```bash
# ① 安装 acme.sh（一次）
curl https://get.acme.sh | sh -s email=you@example.com

# ② 签发：DNS-01（不需要开放 80；以 Cloudflare 为例）
export CF_Token='<Cloudflare API Token>'
~/.acme.sh/acme.sh --issue --dns dns_cf -d agent.example.com

# ③ 写到 Agent 固定路径（system 模式）
sudo install -d -m 0750 /etc/khc-agent/tls
sudo ~/.acme.sh/acme.sh --install-cert -d agent.example.com \
  --key-file /etc/khc-agent/tls/key.pem \
  --fullchain-file /etc/khc-agent/tls/fullchain.pem \
  --reloadcmd "systemctl reload khc-agent"

# ④ 复核（应看到「控制通道使用 HTTPS」）
sudo ./install.sh --system --check --tls-cert /etc/khc-agent/tls/fullchain.pem \
  --tls-key /etc/khc-agent/tls/key.pem --host 0.0.0.0 --port 443
```

acme.sh 自带续期任务（依赖 cron，容器镜像里常装不上）；`--reloadcmd` 让证书续期后自动 reload Agent。
走纯手工签发时，重跑一次带 `--acme <域名>` 的安装命令即可补上 systemd 续期 timer（证书已存在会跳过签发，
只补 timer）。user 模式（无 root，无法绑定 443）
不支持 `--acme`，仍需手动签发；路径换成 `~/.config/khc-agent/tls/`，去掉 `sudo`，
`--reloadcmd` 改为 `systemctl --user reload khc-agent`。

**方案 B：Cloudflare Tunnel。** Hub 安装常驻 `cloudflared` 出站连接，Agent 收敛监听 `127.0.0.1`（零公网入站端口），节点 `tunnel_endpoint` 填隧道域名并**选定本方案**。适用于无入站端口、备案/端口受限或主动不暴露端口的节点；**不是方案 A 失败后的兜底**。**前置条件**：域名托管在 Cloudflare（Free 计划即可）。**费用**：Tunnel 本体免费（自托管 connector，无按量费用）；进阶可在隧道入口挂 Access Service Token（免费计划 50 用户额度内）增强准入。

**方案 C：https + 域名 + 自签证书。** Worker 直连自签不可行——`fetch()` 与 `cloudflare:sockets` 的 TLS 一律校验证书，没有 `rejectUnauthorized:false` 或自定义 CA 开关（见 §5.3）。自签要落地，需把它放在 **Tunnel 源站段**（cloudflared `caPool` 指向自签 CA PEM 并配 `originServerName`，保留源站身份验证）或 **Workers VPC 私有服务段**；两种形态下 Worker 侧始终面对 Cloudflare 可信证书。`noTLSVerify: true` 会关闭源站校验，官方标注不推荐用于生产。

三种方案共用既有字段（`endpoint` / `tunnel_endpoint` / `preferred_route`），不新增代码路径。

> **已按 ADR-0012 落地（2026-11-07）**：三种并列方案、节点选定其一、无跨方案回退；同方案内 fetch / TCP 双通道保留。`orderedRoutes()` 只返回选定方案单一目标，跨路由重试与 `onRouteSuccess` 自动回写 `preferred_route` 已删除，运行时不改写配置、失败即报明确错误；决策见 `docs/engineering/adr/ADR-0012-connection-scheme-selection.md`。

> **实测记录（2026-11-06/07，境外测试 hub `203.0.113.10`，IPv6 `2001:db8::10`）**：Agent 0.1.19 在 `/tmp` 实跑，HTTP / 自签 TLS 的 `/health` 200、无签名 `/state` 401、HMAC `/state` 200、SIGHUP 热重载生效；**方案 A** 用 `/tmp` 临时 Caddy 自动签发 Let's Encrypt 证书（`203-0-113-10.sslip.io`），443/8443 双端口 `ssl_verify=0`、HMAC `/state` 200，本机公网复核 0.5s；**方案 B** Quick Tunnel 得 `ssl_verify=0`、HMAC `/state` 200；**方案 C** 自签源站加 `--no-tls-verify` 得 200（`caPool` 未测）。完整数据见 `docs/verification/2026-11-07/p0-closeout.md`。

## 5. 安装

### 5.1 标准路径（真人终端，推荐）

直接粘贴面板 install-command。命令做了这些事（见 `apps/api/src/lib/agent-commands.ts`）：

- `unset HISTFILE`（token 不进 shell 历史）→ 子 shell 内 `curl` 下载 → `sha256sum -c` 校验 → 解包；
- **前置证书检查**（仅 `https://` 入口）：system + 域名的安装命令会带 `--acme <域名>`，证书缺失时由
  `install.sh` 自动签发（TLS-ALPN-01:443，失败回退 HTTP-01:80），不再中止；裸 IP + HTTPS 仍会被明确阻断，
  提示改用域名或 Tunnel；user 模式保留手动签发指引并在提示 token 前退出（见 §4.1）；
- **环境预检**：`install.sh --check`（root / python3.11 / systemd / 端口占用），不写系统、不消耗 token；
- `IFS= read -rs KHC_TOKEN </dev/tty` **提示粘贴 token（不回显）**——必须从终端读，整段多行粘贴时不会把下一行误当 token；
- `install -m 0600` 写 `/etc/khc-agent/token`（user 模式 `~/.config/khc-agent/token`）；
- `sudo ./install.sh --system --host 0.0.0.0 --port <端口>`。

因此 HTTPS 节点只需保证入站 443、出站 443 与「仅 DNS」解析；证书缺失会被自动签发（user 模式仍需先按 §4.1 手动签发）。

### 5.2 非交互安装（自动化 / 重装）

install-command 的 `read </dev/tty` 在管道/无终端 SSH 下会挂起（实测踩坑，60s 无输入失败）。绕过步骤——**先写 token，再直接跑 install.sh**：

```bash
# system 模式（root）
sudo install -d -m 0750 /etc/khc-agent
printf '%s\n' '<节点token>' | sudo install -m 0600 /dev/stdin /etc/khc-agent/token
sudo ./install.sh --system --host 0.0.0.0 --port 8443

# user 模式
install -d -m 0750 ~/.config/khc-agent
printf '%s\n' '<节点token>' | install -m 0600 /dev/stdin ~/.config/khc-agent/token
./install.sh --user --host 0.0.0.0 --port 8443
```

（发布包的下载/校验/解包步骤与 5.1 相同，只是跳过面板命令里的 read 段。）

### 5.3 可选参数：系统包代装与自签 TLS（feat/server-capabilities 新增）

`install.sh` 支持在装 Agent 的同时完成机器初始化，全部幂等、可重复执行：

```bash
# 代装系统包（白名单仅三个，用户拍板；--with 可重复，白名单外包名直接报错）
sudo ./install.sh --system --host 0.0.0.0 --port 8443 \
  --with-caddy --with-wireguard --with-socat        # 或 --with <pkg> 逐个指定

# 自签证书并在同端口启用 HTTPS（已签发则复用；--tls-cn 可指定证书 CN，默认本机 hostname）
sudo ./install.sh --system --host 0.0.0.0 --port 8443 --tls --tls-cn hub.example.com
```

- **代装白名单**：仅 `wireguard-tools` / `caddy` / `socat`（`install.sh` `pkg_allowed`），已装则跳过；适配 apt-get/dnf/yum/apk。
- **`--tls`**：生成本机自签证书并在同一端口启用 HTTPS（Agent 直接以 HTTPS 监听，无需前置反代）。注意 Worker 侧通道差异：**TCP 通道与域名 fetch 通道的 TLS 均由平台强制校验证书，自签不可用**——必须使用公网可信证书（**方案 A**）；若坚持用自签，按 §4.1 **方案 C** 的落地形态（Tunnel 源站段 `caPool` / Workers VPC）配置，Worker 侧不直连自签证书；若不需要自签，改选 **方案 B**（Cloudflare Tunnel）。**域名节点的默认路径不是自签**：面板代建 DNS 后安装命令自动带 `--with-caddy`，但 Caddy **只被安装、不会被面板配置成 Agent 的证书来源**；证书仍须按 §4.1 用 acme.sh 签发并 `--install-cert` 到 `/etc/khc-agent/tls/`。`--tls-cn` 仅在显式勾选「自签 HTTPS」时生效，非自签时 install.sh 会警告并忽略。
- 不带这些参数时行为与旧版一致（只装 Agent 本体），缺包时各适配器 `install()` 仍会提示手动安装或用白名单代装。

## 6. 上线确认

```bash
# 机器上：健康检查（无鉴权）
curl -s http://127.0.0.1:<端口>/health        # {"ok":true,"version":"..."}
systemctl status khc-agent                     # 或 systemctl --user status khc-agent
```

- 面板节点页：节点应变为 reachable，`GET /nodes/:id/state` 返回主机信息 + 已装应用。
- 若面板显示离线但本机 `/health` 正常 → `docs/runbook/troubleshooting.md` §1。
- 启用了 CF DNS 集成（设置页配置过 Token）时，endpoint 为 IP 的节点创建后会自动代建 A/AAAA 记录，见 `docs/cf-dns.md`。

## 7. Peer 接入（可选，一键脚本）

hub 上线并应用 WireGuard 配置后，手机/服务器类 peer 的接入不用再手装工具、手导 conf：

1. 面板「内网穿透」页 → 目标 peer 行内「运维」→ 导出抽屉；
2. 切到「一键安装脚本」Tab（`peer_install_script` 动作，脚本由 Agent 渲染：装 wireguard-tools → 写 conf → `wg-quick` 启用 → ping hub 的 WG 地址做回连验证）；
3. 在 peer 机器上以 root 执行（或下载后执行），末尾回连验证通过即 peer 上线；失败时脚本会提示排查方向（hub 是否已 apply、UDP 端口、Endpoint 可达性）。

自持私钥的 peer（公钥导入型）无脚本可用，仍走 conf 导入路径；conf 与脚本两 Tab 互不影响。

### 7.1 监听端口自动放行（批次 S 方案 B，Agent 0.1.11 起）

- hub 的 WireGuard `udp/listenPort` 与端口转发各 `listenPort` 在 apply 时由 Agent **自动在主机 iptables INPUT 链放行**（带 `khc-auto:<app>` 注释），无需再手工补规则或 fw.apply 放行；关闭/回滚/卸载对应应用时自动收回。
- 触发条件：仅当主机 INPUT 链存在 REJECT/DROP 或 policy DROP 时才插规则（默认 ACCEPT 的主机不插）；**只增 ACCEPT、只删带自身注释的规则**，边界详见 `docs/security-boundaries.md` §6.1。
- 查看来源：面板「主机详情 → 防火墙」卡片「系统自动放行（主机 iptables）」区块（`fw.show` 的 `autoRules`），或机器上 `iptables -S INPUT | grep khc-auto`。
- iptables 不可用/失败时 apply 不中断，面板以警告回显（degraded），此时需人工检查主机防火墙。

### 7.2 onboard 对 peer 用户 shell 的记录与恢复（批次 S 缺陷 2）

- host-ops onboard 需要把 peer 用户 shell 临时改为 `/bin/sh` 时，**先把原值记录到 `/etc/khc-host/original-shell`**（`user:shell`，一行一条；重复 onboard 不覆盖最早记录）。
- 面板 peer 运维抽屉会显示「已临时修改 {user} 的登录 shell」状态（status 的 `onboard` 块）。
- 卸载时按记录分支：既有用户 → 恢复原 shell 且**不删用户**；`__created__`（onboard 时新建的用户）→ `userdel -r`；无记录（旧版本 onboard 的机器）→ 缺省安全，不动 shell 也不删用户。

## 8. 常见失败点速查

| 症状 | 原因 | 去 |
|---|---|---|
| 安装命令 60s 卡在「粘贴节点 token」 | 管道执行，无 /dev/tty | 本页 §5.2 |
| 粘贴 token 前报「缺少可信 TLS 证书」 | user 模式或裸 IP 的 HTTPS 入口（system + 域名会自动签发，不再报此错） | 本页 §4.1「方案 A 证书准备」 |
| 自动签发失败（ACME） | 入站 443/80 不通、域名未解析到本机，或 Cloudflare 仍为橙云（拦截校验） | 开入站 443（回退再开 80）、记录改「仅 DNS」 |
| 面板文案以为 Caddy 会自动签证书 | 旧版误导文案（2026-11-07 已修正）；Caddy 只装包不写 Agent 证书 | 本页 §4.1 / §5.3 |
| `sha256sum -c` 失败 | 发布包与清单不符（签名清单机制，属按设计拒绝） | 核对面板 Agent 卡的版本与 `docs/agent-releases.md` |
| 装完面板仍离线 | 云防火墙未放行所选端口；或 endpoint 的 scheme/port 与实际不符 | 本页 §4 + troubleshooting §1 |
| Agent 起来了但面板 401 | token 与面板记录不一致（如重装后换了 token） | troubleshooting §7 |
| `--check` 报 WARN | 缺 wg/caddy/socat 等可选依赖 | 需要对应应用时装：`POST /nodes/:id/apps/<app>/install`，或安装 Agent 时加 `--with-caddy` 等代装参数（本页 §5.3） |
| WG/端口转发外网连不进且面板 apply 提示「主机 iptables 不可用/自动放行失败」 | Agent 无法操作主机 iptables（非 root/被容器裁剪），自动放行降级 | 本页 §7.1，人工在主机放行 listenPort |
| 0.1.11 之前的老机器起用 WG/端口转发外网不通 | 老版本不写主机 iptables；INPUT 链尾 REJECT 拦包 | 升级 Agent 到 ≥0.1.11 后重新 apply，或临时手工放行 |
