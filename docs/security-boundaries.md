# 安全与边界说明（security-boundaries）

> 状态：现行 ｜ 最后核验：2026-11-06 ｜ 关联：`agent/khc-agent.service`、`apps/api/src/lib/rate-limit.ts`、`apps/api/src/lib/agent-commands.ts`
> 范围：回答"装了这个 Agent / 这个 Worker 之后，它们到底被授权做什么、不能做什么"；面向安全审计与边界自查

## 1. 控制面（Worker + 面板）

- **会话**：登录成功发 JWT cookie `khc_sess`，有效期 8h（`SESSION_TTL_SEC`）；所有 `/api/v1` 路由（除登录本身）要求会话。启用 TOTP 后登录需追加 6 位验证码，令牌携带会话版本 `ver`（取自 settings 的 `auth.session_epoch`）；启用/禁用 TOTP 或「全部登出」递增该版本即撤销全部既有会话（8h TTL 与 cookie 名称/属性不变）。
- **登录限流**：10 次失败 / 300s / 每源 IP，第 11 次 429。存储三级降级（P1-C，迁移 0006）：**D1 单语句原子 upsert**（`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`，跨 isolate 计数，主路径）→ KV（未绑定则跳过）→ 进程内 Map（本地 dev 兜底）。存储异常不阻塞登录主路径。
- **Worker→Agent 传输**：域名走原生 fetch，裸 IP 走 `cloudflare:sockets` TCP 通道（同一接入方案内的两条传输通道）；均要求 HMAC 签名（见 §4）。**接入方案口径（2026-11-06 修订，取代 D-3「直连首选 / Tunnel 备用」）**：三种**并列**方案，节点创建/配置时**选定其一**，运行时只走该方案，失败即报错，无主备、无跨方案回退——
  - **方案 A：https + 域名 + 公网可信证书直连**（域名/IP 证书，平台强制校验证书）。Agent 支持直接 TLS 监听（`--tls-cert` / `--tls-key`，主端口复用，SIGHUP 热重载）；Worker 侧拒绝明文通道下发证书私钥/DNS 凭据（`secure-channel.ts`，400 `insecure_channel_secret`，development 豁免）。
  - **方案 B：Cloudflare Tunnel**（cloudflared 常驻出站、Agent 绑 `127.0.0.1`，TLS 由 Cloudflare 托管），适用于无入站端口或备案/端口受限节点，**不是 A 失败后的兜底**。
  - **方案 C：https + 域名 + 自签证书**：Worker 直连自签在平台侧不可行（无跳过校验/自定义 CA 开关），只能把自签放在 Tunnel 源站段（`caPool` / `originServerName`）或 Workers VPC 私有服务段。
  引导见 `docs/runbook/node-onboarding.md` §4.1。**已按 ADR-0012 落地：三种并列方案、节点选定其一、无跨方案回退；同方案内 fetch / TCP 双通道保留**（`orderedRoutes()` 只返回选定方案单一目标，删跨路由重试与 `onRouteSuccess` 自动回写）；权威口径见 `docs/design-v3.md` §1.1 与 `docs/engineering/adr/ADR-0012-connection-scheme-selection.md`。未配证书的明文 HTTP 仅有 HMAC 防请求篡改，**无传输机密性**（凭据、WireGuard 私钥会过公网），仅限可信网络临时使用。
- **审计**：节点/配置/动作全部落 `audit` 表（actor/node/app/action/detail）。

## 2. Agent 沙箱（systemd unit 逐项）

**定位（A-7）**：沙箱是**防误写**层——保证 Agent/适配器自身的写入只落在 §3 白名单目录，误操作（bug、路径拼接错误、适配器越界写）被只读挂载拦截。**它不构成对越权代码的边界**：Agent 以 root 运行，沙箱内进程仍可经 D-Bus 调 systemd（创建/启停 unit）、`systemd-run`（沙箱外以 root 执行，F-L2 即依赖此路径）、remount 等方式写出白名单——`ReadWritePaths` 是目录级权限，无法按文件名前缀过滤，`NoNewPrivileges` 也只挡提权不挡既有 root 权能。真正的边界是：**代码级白名单**（host-ops 只管理 `khc-` 前缀的 cron 文件与 `*.service` 受保护名单外的服务，见 §9；port-forward 只写 `khc-forward-*.service`）+ 发布包信任链（§5）+ 写操作鉴权（§4）；审计与回滚（design-v3 §2.2）提供事后可追溯。评估过把 unit 目录收窄到 `khc-*` 前缀：不可行（`ReadWritePaths` 无前缀过滤，unit 必须位于标准 unit 目录才能被 `systemctl enable` 加载；改专属子目录需 `systemctl link` 非小改），按"小且可测"门槛不做。

`agent/khc-agent.service` 由 install.sh 渲染，当前边界（P0-1 修复后实机复验）：

| 指令 | 值 | 含义 |
|---|---|---|
| `NoNewPrivileges` | true | 进程及其子进程不能提权 |
| `ProtectSystem` | full | `/usr`、`/boot`、`/etc` 只读（`/etc` 下白名单例外见 §3） |
| `ProtectHome` | **read-only** | 家目录可读不可写——host-ops `keys.*` 需要读 authorized_keys；Agent 以 root 运行本可读全盘，read-only 不构成额外暴露。**写权限只对被授权用户的 `.ssh` 开放**（`ReadWritePaths=-/root/.ssh`，hub self 默认用户 root；其他用户需安装时授权） |
| `PrivateTmp` | true | 私有 /tmp、/var/tmp，不与主机互通 |
| `ReadWritePaths` | 见 §3 | 写权限白名单，前缀 `-` 表示路径不存在时忽略 |

修复方式说明：此前 `ProtectHome=true`（家目录完全不可见）导致 `keys.*` 恒失败；改为 `read-only` + 最小 `ReadWritePaths` 放通，`systemd-analyze security` 暴露面评分未上升（report §7 P0-1）。

## 3. 写盘白名单

Agent 可写路径 = unit 的 `ReadWritePaths` 全集（system 模式默认值；user 模式在 `$HOME/.config` / `$HOME/.local/share` 下，见 `agent/install.sh`）：

| 路径 | 用途 |
|---|---|
| `/etc/wireguard` | WG 接口与 peer 配置（unit 中带 `-` 可选前缀：目录被误删时 Agent 仍能启动，WireGuard 适配器以 `wireguard_dir_missing` 降级上报；目录仍由 install.sh 创建） |
| `/etc/khc`（apps etc） | 各适配器管理的应用配置 |
| `/etc/khc-agent`（config dir） | token、runtime state |
| systemd unit dir | port-forward `khc-forward-*.service`、host-ops `khc-fw.service`（防火墙持久化 oneshot）——**目录内其余 unit 代码级白名单不写**（`ReadWritePaths` 无法按前缀收窄，见 §2 定位） |
| `/etc/caddy`（Caddy 父目录）/ `/etc/caddy/khc.d` / `/etc/caddy/Caddyfile` | 反代站点片段装配 |
| `/opt/khc`（apps opt） | 应用安装产物 |
| `/var/lib/khc-agent`（data dir） | Agent 数据、host-ops 脚本 |
| `/root/.ssh`（授权用户家目录） | hub self `keys.*` 管理 authorized_keys |
| `/etc/cron.d` | host-ops `cron.*` 管理的 `khc-*` 条目（只写 `khc-` 前缀白名单文件，条目名/内容强校验） |

白名单之外的家目录只读、`/usr`/`/boot` 只读；其余路径写操作被沙箱拦截。

### 3.1 旧机器升级时的白名单补齐（F-L2/F-L3）

远程升级不重装 unit：升级流程会在重启前 ① 补建新版所需的全部白名单目录（与 install.sh §2 / `Paths.ensure_dirs` 同一集合，`/etc/wireguard` 保持 0700；沙箱内 EROFS 时经 `systemd-run` 临时 unit 在沙箱外以 root 补建）；② 对比包内新模板，把旧 unit 缺失的 `ReadWritePaths` 条目**只增不减**地追加（如 0.1.4 时代 unit 缺的 `/etc/cron.d`、`/root/.ssh`）并 `daemon-reload`。占位符无法解析的条目宁可不加；补齐失败不阻断升级（回滚兜底机制不变）。

## 4. 命令与传输防泄露

- **HMAC 签名**：每个节点一个随机 token（Agent 本地 `0600` 明文保存；D1 只存 AES-GCM 密文，`MASTER_ENC_KEY` 加密）。请求头 `X-Khc-Ts` / `X-Khc-Nonce` / `X-Khc-Sig = HMAC-SHA256(token, method|path|ts|nonce|sha256(body))`；Agent 校验 ±60s 时间窗 + nonce 120s 防重放。实测伪造/缺失签名对全部鉴权端点 401（F1/F2）。
- **token 不进命令文本**（#31）：面板生成的 install-command 用 `read -rs </dev/tty` 从终端读 token（不回显、不进 history、`unset HISTFILE`），落盘用 `install -m 0600`；升级命令不含 token。
- **本地生成的 token 仅显示一次**（install.sh 尾部提示，umask 077 生成）。
- **日志零泄露**：错误响应与日志不回显凭据；实测 F4 对 agent 日志、audit、state.json 的 grep 未发现 token/私钥。

### 4.1 Agent 并发上限与过载行为（PP-E-03，设计性保护）

- Agent 的 `ThreadingHTTPServer` 固定 `max_workers=64`：**accept 后、TLS 握手前**抢全局槽位，抢不到直接关闭 TCP，不写 HTTP 响应。
- 该上限同样约束 `/health` 与 `/_live/*`（没有独立小池），因此在 50 空 TCP + 50 慢 TLS 洪水期间，探活可能被拒（实测 20 次中 8 次 RST/SSL EOF）；洪水断开后自动恢复（10/10 成功）。
- 这是有意的资源保护：宁可拒绝新连接，也不让慢握手/端口扫描拖垮已有请求与 accept 循环。面板侧由 30s 冷却与快照兜底，不视为节点故障。

## 5. 发布包信任链（#32）

- Agent 安装/升级包必须命中 **Ed25519 签名清单**（`docs/agent-releases.md` 的发布清单机制）：命令里 `sha256sum -c` 先校验，升级链路再查清单——自建/未登记包被 `release_not_in_manifest` 拒绝（实测 A4，按设计工作）。
- Agent 升级只允许**拉取式**（Agent 侧从发布地址下载），控制面不推送任意代码。

## 6. 防火墙安全网

- **只管理 `table inet khc_fw`**，不碰系统其余 nftables 规则。
- **锁定保护**（P1-B 修复后）：`deny` 规则按「协议 + 端口」两维判定——tcp 保护 SSH 端口 + Agent 实际监听端口（`/proc` 实测 Agent 进程 LISTEN socket，不依赖配置登记）；udp 保护 WG 端口。命中即 `E_LOCKOUT` 拒绝，规则不生效；协议不匹配（如 `deny udp/22`）不误拦。
- **60 秒确认 + 自动回滚**：`fw.apply` 用 `systemd-run --on-active=60` 预约回滚；`fw.confirm` 才持久化。实测不确认约 70s 自动回滚、SSH 会话不受影响。`systemd-run` 不可用时 `E_UNSUPPORTED` 保护性失败（规则未被修改）。

### 6.1 主机 iptables 自动放行边界（批次 S 方案 B，Agent 0.1.11）

背景：OCI 类主机 iptables INPUT 链尾有 `REJECT`，`khc_fw`（nft 早链）的 accept 非最终裁决（实测见 `docs/verification/2026-11-03/report.md` §16/§17），WG/端口转发的监听端口必须直接在主机 iptables 放行。边界：

- **opt-in**：仅适配器 `port_claims` 声明 `release: true` 的端口参与（当前：wireguard 的 `udp/listenPort`、port-forward 各转发的 `listenPort`）；caddy 不参与。
- **条件触发**：仅当 INPUT 链存在 REJECT/DROP 规则或 policy DROP 时才插入；默认 ACCEPT 的主机不插。
- **只增 accept**：结构上不可能产生 DROP/REJECT，SSH/Agent 端口不可能被自动规则误伤（锁定保护不被绕过）。
- **只删自身**：规则带 `-m comment --comment "khc-auto:<app>"` 标记；关闭/回滚/卸载时只删带本系统注释的精确规则，绝不触碰用户手工规则。
- **失败降级**：iptables 不可用/非 root 时 apply 不失败，以 `hostFw.degraded` + warnings 上报。
- **查看来源**：面板「防火墙」卡片「系统自动放行（主机 iptables）」区块，或 `khc-host fw.show` 的 `autoRules` 字段。

## 7. 密钥与凭据归属

| 密钥 | 存放 | 边界 |
|---|---|---|
| 节点 token | Agent 本地 `0600`；D1 侧 AES-GCM 密文 | 明文只在机器与面板一次性展示 |
| WG 接口私钥 | Agent keystore / conf（`/etc/wireguard`，0600） | **不出 Agent**（P1-A 取舍：apply 响应不回传私钥，因此 D1 不回存 peer 公钥） |
| WG 客户端私钥 | 只在客户端配置文本里，由使用方自持 | 服务端 conf 不含 peer 私钥 |
| 证书私钥 | D1 AES-GCM 密文（ADR-0006），部署到节点后由 Agent 管理 | 签发走 acme.sh DNS-01 |
| DNS 凭据 | `settings` 表（0002） | 面板「设置」管理 |
| `MASTER_ENC_KEY` | Worker secret | 所有 AES-GCM 的主密钥；丢失则加密数据不可恢复 |

### 7.1 密钥引用与命名空间隔离（安全批次 B，2026-11-06）

配置/参数中的密钥引用（`$cert` / `$dnsCred`）由 Worker 在 apply 前展开：

- **`$cert:<id>`**：引用全局证书库（`certificates` 表），展开为 `{ domains, certPem, keyPem }`；证书私钥经 `MASTER_ENC_KEY` 加密存储。
- **`$dnsCred:<key>`**：引用 `settings` 表的加密凭据，展开为解密后的凭据对象（如 `{ apiToken: "..." }`）。
  - **命名空间隔离（批次 B）**：`$dnsCred` 引用必须以 `dns.` 前缀开头（如 `dns.cloudflare`、`dns.alidns`），拒绝引用其他 settings 键（如内部配置、其他凭据），防止凭据泄露到非预期适配器。违反时返回 400 `badRequest`。
- **安全通道检查（P1）**：Worker 检测配置含 `$cert` / `$dnsCred` 引用且节点的任一候选通道（`endpoint` / `tunnel_endpoint`）为明文 `http://` 时，拒绝 apply 并返回 400 `insecure_channel_secret`（提示升级为 TLS 直连或隧道）。`ENVIRONMENT=development` 豁免，方便本地调试。

实现：`apps/api/src/lib/secret-refs.ts`（引用解析与命名空间校验）、`apps/api/src/lib/secure-channel.ts`（安全通道检查）。测试覆盖：命名空间隔离 7 项、安全通道 16 项。

## 8. Recipe 参数注入防护（安全批次 B，2026-11-06）

Recipe 参数（`agent/recipes/catalog.json`）在传递到 shell 脚本前必须经过严格校验，防止注入攻击：

### 8.1 字符白名单（pattern 约束）

所有可能进入 systemd unit / shell 变量的字符串参数**必须带 `pattern` 正则约束**：

| Recipe | 参数 | pattern | 用途 |
|---|---|---|---|
| demo-echo | greeting | `^[\x20-\x7E]*$` | 禁止控制字符与换行（防止 unit 注入） |
| sing-box | protocol | `^(vless\|trojan\|vmess)$` | 枚举限制 |
| sing-box | password | `^[A-Za-z0-9-]*$` | UUID/密码字符集 |
| generic-service | mode | `^(docker\|binary)$` | 枚举限制 |
| generic-service | image | `^[a-z0-9._/-]*$` | Docker 镜像名 |
| generic-service | downloadUrl | `^https://[A-Za-z0-9._/-]*$` | 强制 HTTPS，禁止特殊字符 |
| generic-service | sha256 | `^[a-f0-9]{0,64}$` | 哈希值格式 |

### 8.2 校验机制

- `khc/recipes.py:validate_params()` 对每个参数按 `pattern` 校验，不匹配时抛 `RecipeError`。
- 校验在 Agent 侧执行（权威），Worker/前端同步执行相同校验（提前反馈）。
- 测试覆盖：换行注入拒绝、控制字符拒绝、http URL 拒绝、特殊字符拒绝（`test_recipes.py` 新增 2 项）。

### 8.3 已知限制

- `pattern` 只能按**整个值**匹配，无法按字段内部结构（如 JSON/YAML）校验——需要这类参数的 recipe 必须在脚本内再次校验或使用更安全的传递机制（如临时文件）。
- 现有 recipe 参数若含特殊字符将被拒绝（向后不兼容），但旧系统无生产实例，影响可控。

## 9. 自查命令集（对应实测 F1–F4）

```bash
# 1) 沙箱边界（机器上）
systemctl cat khc-agent | grep -E 'ProtectHome|ProtectSystem|ReadWritePaths|NoNewPrivileges'
sudo systemd-analyze security khc-agent

# 2) 防火墙保护行与回滚定时器（__fixed_* 等锁定规则 ID 只在 fw.show JSON 里）
sudo /var/lib/khc-agent/host-ops/khc-host fw.show | python3 -m json.tool | grep -E '__fixed_|__ssh_|__wg_'
sudo nft list table inet khc_fw
sudo systemctl list-timers 'khc-fw-*'

# 3) token/私钥零泄露（机器上 + D1 导出）
sudo grep -rE '<token前缀>' /var/lib/khc-agent/ /etc/khc-agent/ || echo clean
#   面板侧：audit 表与错误响应不应含凭据（抽查最近的 error 响应）

# 4) 签名边界（从外部对 Agent 端点）
curl -s http://<ip>:<port>/state           # 无签名 → 401（/health 除外）
curl -s http://<ip>:<port>/health          # 唯一无鉴权端点，只回 ok+version
```

## 9. 系统包代装白名单（feat/server-capabilities）

- Agent 安装脚本只代装**白名单内**的系统包：`wireguard-tools` / `caddy` / `socat`（`agent/install.sh` `pkg_allowed`，用户拍板"仅这三个，不接受任意包名"）；`--with` 收到白名单外包名直接失败。
- 代装仅发生在 **install.sh 安装/重跑时**（`--with-caddy` / `--with-wireguard` / `--with-socat` / `--with PKG`），已装则跳过，幂等；适配 apt-get/dnf/yum/apk。
- 运行期适配器不执行任意包安装：缺包时 `install()` 报错提示（或经 install.sh 白名单代装路径），`port_forward` 等对 socat 的提示只引导用户，不越权执行。

## 10. Cloudflare DNS Token（feat/server-capabilities）

- **最小权限**：仅 **单 Zone 的 `Zone → DNS → Edit` + `Zone → Zone → Read`**（`apps/api/src/lib/cf-dns.ts` 校验并提示）；**不需要 record tags 权限**——面板用 comment（`khc-server managed`）标记托管记录，不用 tags（F-L1：带 tags 的创建请求会被最小权限 Token 的 CF 账号拒绝）。绝不允许 Account 级 Token。
- **存储**：Token 经 `MASTER_ENC_KEY` AES-GCM 加密存 `settings` 表（key `cf_dns`），**只写不回读**，面板不回显明文（同节点 token 处理惯例）；audit 只记动作与 zone 名，不记凭据。
- **作用面**：面板只创建/删除**自己代建的** A/AAAA 记录（D1 登记 `cf_dns_node_<nodeId>`，联动删除按登记的 recordId 执行，不依赖 comment/tags），不碰用户手建记录；未配置/未启用时所有代建端点返回 `cf_dns_disabled`，节点创建不受影响。用法与失败处理见 `docs/cf-dns.md`。

## 11. 删除节点/Peer 时的服务清理（feat/server-capabilities）

- 删除确认框默认勾选「同时清理本机服务」，经主机运维通道下发 khc-host `cleanup`：停用 `wg-quick@wg0` 删 `wg0.conf`、清空 `/etc/caddy/khc.d` 并 reload、停删全部 `khc-forward-*.service`、停删已确认的防火墙产物（`khc-fw.service`、nft `table inet khc_fw`、fw 规则/状态文件——默认 `/etc/khc-host/` 与 Agent 数据目录 `fw-state/` 两处布局都清）、清 `/opt/khc` 与 `/etc/khc`。**khc-agent 自身不在清理范围**（Agent 卸载仍必须由人在机器上跑 `uninstall.sh`，控制面不能远程卸载 Agent）。
- cleanup 幂等、逐项回读校验；**有残留即阻止删除**并列出清单，可取消勾选改为仅删除面板记录（此时本机服务原样保留）。`/opt/khc`、`/etc/khc` 若是 Agent 沙箱 `ReadWritePaths` bind mount（挂载点不可 rmdir），只清空内容、目录保留并记入 `skipped` 清单（明确上报原因，不算残留、不阻断删除）。
