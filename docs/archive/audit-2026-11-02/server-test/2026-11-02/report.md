# 服务端端到端测试报告（2026-11-02）

> 状态：已归档（一次性测试证据，历史记录；不得作为开发依据，AGENTS.md 红线 9c） ｜ 最后核验：2026-11-03（归档登记）
> 测试环境：线上 https://panel.example.com/（Cloudflare Worker + D1 + Agent）
> 测试机：test-hub（hub）、node-test-3（peer）、node-test-2（只读）；香港 NAT 机不可达（见 §2）
> 测试计划：[test-plan.md](./test-plan.md)；操作实录：[setup-notes.md](./setup-notes.md)
> 红线遵守：未新建任何 Cloudflare 资源；未部署；未改动 `docs/` 既有文档；未开 PR。
> 后续：报告所列 P0/P1 修复已合入 main 并随 feat/server-capabilities 补齐发布链路（`5165cad`；0.1.5 打包后未发布，轮换回归修复后以 Agent 0.1.6 出包取代）；测试节点已按 §6.3 清理。

## 1. 结果概览

| 统计 | 数量 |
|---|---|
| PASS | 20 |
| FAIL | 1（F5 登录限流） |
| PARTIAL | 1（D1 主机运维 self：keys.* 失败） |
| BLOCKED | 2（香港机相关用例、二维码 UI 走查） |

- 已验证能力：认证与会话、概览、节点创建/token/生命周期命令、Agent 安装注册与指标回传、Caddy 站点管理（含 LE 证书自动签发）、WireGuard peer 创建与连通性（ping 2.5ms）、端口转发、host-ops（self 状态/进程/防火墙 + peer 经 WG SSH 接入与调用）、防火墙 60 秒确认与自动回滚（实测 70s 回滚成功）、诊断、Agent 离线表现、误配置拒绝与回滚、HMAC 全边界、token 越权、未知 verb/action 拒绝、日志零泄露、Agent 真实卸载/重装与恢复路径。
- 被环境阻塞：香港 NAT 机 SSH 不可达（原计划 peer + 破坏性实验全部改由 arm-1/aws hub 承担）；浏览器子代理无法稳定截图/打开抽屉（二维码 UI 未走查，以 API 证据替代）。

## 2. 环境阻塞

1. **香港 NAT（203.0.113.13:<ssh-port>）TCP 全端口超时**（ICMP 通）。NAT 端口映射疑似失效，需主人修复后才能补测"外网 peer 接入"场景。
2. Lightsail 防火墙仅放行 80/443/8443/tcp + 51820/udp → 端口转发的外网连通性只能在放行端口内验证（本测试用 hub 本机 + WG 内网验证）。
3. 浏览器走查：登录页/概览页截图成功（`shots/ui-01-login.png`、`ui-02-overview.png`），后续页面因浏览器子代理视口/渲染问题截图失败，改用 API 响应作为证据。

## 3. 测试矩阵

| # | 能力 | 结果 | 证据（摘要） | 备注 |
|---|---|---|---|---|
| A1 | 登录/会话 | PASS | 错误口令 401 `invalid_credentials`；无 cookie 访问 `/nodes` 401；正确口令 200 + `khc_sess` cookie | |
| A2 | 概览/节点列表 | PASS | `GET /api/v1/nodes` 返回 7 个注册节点；浏览器截图 ui-02 | 列表含 6 个历史遗留测试节点（非本次创建，见 §6） |
| A3 | 节点创建与 token | PASS | 创建 `e2e-test-2026-11-02`，返回一次性 token（43 字节）；结束已 DELETE（HTTP 200） | |
| A4 | 生命周期命令生成 | PASS | install/uninstall 命令 `bash -n` 全过；命令文本零 token（`read -rs KHC_TOKEN </dev/tty`）；非法 URL/sha256 → 400 `release_not_in_manifest` | 自建包被清单拒绝是 #32 签名机制**按设计工作**，非 bug |
| B1 | 节点概况回传 | PASS | `/nodes/:id/state` 返回 host（cpu 2 核/mem/disk/load）+ ops + adapters 全量指标，`via:"tcp"` | |
| B2 | Caddy 站点管理 | PASS | 静态站点 `pkg-e2e-test`：PUT rev6 → plan diff → apply → HTTPS `curl https://pkg-203-0-113-10.sslip.io/` 下载 sha256 与源一致；LE 证书自动签发；结束后已删除站点并 apply（rev7） | 见问题 P2-7（无 index.html 时健康探测误报） |
| B3 | Agent 真实卸载/重装 | PASS | 面板 uninstall 命令真实执行：`/opt/khc-agent`、`/var/lib/khc-agent` 清除，面板正确 `reachable:false`；重装：官方 0.1.4 包 sha256 校验 OK → `install.sh --system` → `/health {"ok":true,"version":"0.1.4"}` → `/state reachable:true` | 重装走手动 install.sh：生成命令的 `read </dev/tty` 在非交互 SSH 下挂起（#31 防泄露的代价，见 setup-notes §3.1）；重装后应用层恢复路径已验证（install + apply），并暴露问题 P1-6/P2-11 |
| C1 | WireGuard peer/连通性 | PASS | 面板建 peer `arm1-e2e` → `client_config` → arm-1 `wg-quick up khc0` → ping 10.99.0.1 2.5ms → 面板 online + rx/tx 增长 | 二维码子项未走查成功：`client_config` cards 的 `qr` 字段为 `null`（问题 P2-8） |
| C2 | 端口转发 | PASS | tcp/9443 → 10.99.0.2:80：hub 本机 `curl` 经转发拿到 arm-1 agent health；systemd unit 正常；结束已清空（count=0，9443 释放） | |
| D1 | 主机运维（self） | PARTIAL | `version/status/processes/fw.show` PASS；**`keys.list/keys.add` FAIL**："没有可用的家目录"（问题 P0-1） | 直接 SSH 跑同一 khc-host 脚本正常 → 归因 Agent systemd 沙箱；**P0-1 已修复并实机复验通过（见 §7）** |
| D2 | 防火墙 60 秒确认 | PASS | peer `fw.apply`（token 76f3c11e）→ nft `table inet khc_fw` 实时生效 → `fw.confirm` 取消定时器并持久化；**不确认场景**：70s 后规则自动回滚（实测） | 两个锁定保护逻辑缺陷见问题 P1-3/P1-4（用 192.0.2.0/24 绕过后主流程通过） |
| D3 | Peer 接入与运维 | PASS | onboard 返回 90KB 一键命令；arm-1 执行后经 WG SSH `call status/processes` 成功；uninstall 命令执行成功（khc-host/配置/防火墙全清） | authorized_keys 残留一行见问题 P2-10 |
| D4 | 诊断 | PASS | 健康态 2 项检查通过；`systemctl stop caddy` 后正确报 `inactive` + `upstream_down`，重启恢复 | |
| E1 | Agent 离线表现 | PASS | 停 arm-1 agent → 面板 `reachable:false` + 明确错误信息；节点列表 offline；重启恢复 | |
| E2 | 误配置回滚 | PASS | WG peer AllowedIPs 冲突 → 400 `invalid_config`，运行配置完好；caddy 非法配置同理 | |
| F1 | HMAC 边界 | PASS | 无签名/错签名/过期 ts（±60s 窗外）/重放 nonce（120s 内）→ 全部 401 | |
| F2 | token 越权 | PASS | 用临时节点 token 签名请求 hub agent → 401 | |
| F3 | 未知 verb/app | PASS | host-ops `rm -rf /` → E_BAD_REQUEST；未知 action → 拒绝 | |
| F4 | 日志泄露 | PASS | agent journal / audit / state.json / 错误响应 grep token 明文 → 零命中 | |
| F5 | 登录限流 | **FAIL** | 连续 **12 次**错误口令登录全部 401，未触发 429 | 根因见问题 P1-5（**已修复并上线验证**，P1-C：D1 计数，生产第 11 次 429，见 §7）；复现步骤 §4.5 |
| G1 | x86-2 只读检查 | PASS | SSH 只读勘察（Ubuntu 24.04 x86_64、Python 3.12.3、80/443/8443 空闲、盘 43G 空闲）；`install.sh --check`：PASS=11 WARN=3（wg/caddy/socat 未装，干净机器正常）FAIL=0 | Oracle 网络可达 `panel.example.com` 下载源 |
| H1 | 清理 | PASS | 见 §5 清理记录；最终态：wg peers=0、转发 count=0、站点仅剩 live-gateway、host-ops 已卸载、临时节点已删 | |

## 4. 问题清单（按严重度）

### P0-1：Agent systemd 沙箱隐藏 /home 与 /root，host-ops `keys.*`（self）全部失败

> **状态：已修复**（分支 `fix/server-issues`，commit `bb4dc81`；hub 实机复验通过，见 §7）

- **归属**：Agent（`agent/install.sh` unit 渲染 `ProtectHome=true` + `agent/adapters/host_ops/khc_host.py` keys 动词）
- **现象**：面板 host-ops self `keys.list`/`keys.add` 报"没有可用的家目录"；直接 SSH 以相同参数跑 `/var/lib/khc-agent/host-ops/khc-host` 正常。
- **复现**：hub 上 `POST /apps/host-ops/call {"target":"self","verb":"keys.list"}` → `ok:false`。
- **定位**：`ProtectHome=true` 使 Agent 进程看不到 `/root`（hub 为 root 运行时家目录）。修复方向：unit 改 `ProtectHome=read-only` 并把 keys 白名单路径加入 `ReadOnlyPaths`/按需 `ReadWritePaths`，或 keys 动作改走 sudo 白名单脚本路径（不依赖家目录枚举）。

### P0-2：khc-host `SCRIPT_PATH` 硬编码 `/usr/local/sbin/khc-host`，hub self 的 `fw.apply` 永远失败

> **状态：已修复**（分支 `fix/server-issues`，commit `b5dd69d`；hub 实机复验通过，见 §7）

- **归属**：Agent 适配器（`agent/adapters/host_ops/khc_host.py` L406；peer 侧脚本路径由 onboard 安装到 `/usr/local/sbin/khc-host`，但 **hub self** 的脚本实际在 `/var/lib/khc-agent/host-ops/khc-host`）
- **现象**：hub self `fw.apply` → `E_UNSUPPORTED`（systemd-run 回滚定时器找不到可执行文件）；面板侧另有 OSError。
- **复现**：`POST /apps/host-ops/call {"target":"self","verb":"fw.apply",...}`。
- **定位**：`_schedule_rollback` 用 `SCRIPT_PATH` 拼 systemd-run 命令。修复方向：按实际安装位置解析（self 用适配器 DATA_DIR 路径，peer 用 `/usr/local/sbin/khc-host`），或 hub self 也安装到 `/usr/local/sbin`。

### P1-3：`FW_PROTECTED_FIXED_PORTS=(8880,)` 硬编码，锁定保护端口错位

> **状态：已修复**（P1-B，commit `202c2d8`：端口按运行中的 khc-agent 进程实测，`__fixed_8443`；hub 实机复验通过，见 §7）

- **归属**：Agent 适配器（`khc_host.py` L339）
- **现象**：本 hub Agent 实际监听 8443；`deny tcp/8443` 不会被 E_LOCKOUT 拦截（8880 才是文档默认值）。
- **风险**：误封 Agent 端口导致面板失联。修复方向：保护端口从 Agent 实际监听端口/配置读取。

### P1-4：`rule_lockout_reason` 只看源网段不看端口，产生锁定误报

> **状态：已修复**（P1-B，commit `202c2d8`：改为协议+端口两维匹配，源网段维度移除；hub 实机复验通过，见 §7）

- **归属**：Agent 适配器（`khc_host.py` L1062-1077）
- **现象**：`deny tcp/9999 from 0.0.0.0/0`（与 SSH/WG/Agent 端口无关）被误报"会拦截来自 Hub WG IP 的连接"并拒绝。
- **复现**：peer `fw.apply` 一条 `0.0.0.0/0` 源的 deny（非保护端口）→ 被拒。测试用 `192.0.2.0/24` 源绕过。

### P1-5：生产登录限流未生效（F5 FAIL）

> **状态：已修复并上线验证（2026-11-02）**（P1-C，commit `f1a6100`：D1 单语句原子 upsert 计数 + 迁移 `0006_rate_limit.sql`，零新增绑定。0006 迁移已对生产 D1 执行（`rate_limit` 表已建），Worker 已随 main `02f13b2` 部署；生产复验：本机连续 12 次错误口令，第 1–10 次 401、**第 11–12 次 429**（`too_many_attempts`），D1 计数行 `count=12` 确认落库，异 IP（hub VM）登录不受影响）

- **归属**：API/部署配置（`apps/api/src/lib/rate-limit.ts` 逻辑正确，但 `wrangler.toml` **未绑定 KV**）
- **复现**：`for i in $(seq 12); do curl -X POST .../auth/login -d '{"username":"admin","password":"wrong"}'; done` → 12 次全部 401，无 429。
- **定位**：`c.env.KV` undefined → 退化为单 isolate 内存计数；Cloudflare 边缘多 isolate 下计数被稀释，形同虚设。修复方向：绑定一个 KV namespace（免费额度内）或改用 D1 计数。**需主人决策**（涉及 Worker 配置变更，本次未动）。

### P1-6：Agent 卸载/重装丢失 peer 公钥映射（D1 `publicKey` 为空）

> **状态：已修复**（P1-A，commit `7a8c91d`：从现存 conf 恢复接口私钥与 peer 公钥映射；hub 实机复验通过（重装后 conf sha256 不变、peer 公钥原样恢复、arm-1 ping 不中断），见 §7。未做 D1 回写——apply 响应携带私钥违反"私钥不出 Agent"，conf 恢复已覆盖真实场景）

- **归属**：Agent wireguard 适配器 + 契约（peer 公钥只存 Agent 本地 `wireguard-keys.json`）
- **现象**：重装后（`/var/lib/khc-agent` 被清）wg0 仍在运行、握手正常，但 `/state` 上报 `peers:[]`，浏览器 peer 显示"未知"。
- **后果**：重装后面板丢失 peer 可观测性，且无法可靠清理内核 peer（见 P1-9）。修复方向：peer 公钥回写 D1 config（`publicKey` 字段已预留）。

### P1-9：WG apply 删除 peer 只改 wg0.conf，不同步运行中的内核接口

> **状态：已修复**（P1-A，commit `7a8c91d`：apply 后自动 `wg set <iface> peer <pubkey> remove` 清理内核残留 peer；hub 实机复验 `peers=[]` apply 后内核 peers=0，见 §7）

- **归属**：Agent wireguard 适配器
- **现象**：`peers=[]` PUT+apply 成功（changes=1，`/etc/wireguard/wg0.conf` 0 个 `[Peer]`），但 `wg show wg0` 内核里 peer 仍在（allowed ips 10.99.0.2/32 仍生效）。手动 `wg set wg0 peer <pubkey> remove` 才清除。
- **风险**：已"删除"的 peer 仍可通信；配置与运行态漂移。可能与 P1-6 相关（agent 不认识内核 peer）。

### P1-7：`/state` 经 TCP 通道延迟 2.1–2.4s，逼近 3s 超时

- **归属**：API 传输层（`cloudflare:sockets` 往返延迟 + 3s 超时）
- **现象**：ops 页偶发"节点不可达，以下为缓存状态"，与实际可达矛盾（重试即恢复）。
- **建议**：超时上调或前端静默重试一次。

### P2-8：`client_config` cards 的 `qr` 字段为 `null`

- **归属**：Agent wireguard 适配器（或前端渲染未触达）——二维码 UI 本次未能走查（浏览器子代理限制），标 BLOCKED，需人工补验。

### P2-10：peer 卸载命令清不掉 authorized_keys（sed 模式与写入的 comment 不一致）

- **归属**：Agent 适配器（onboard/uninstall 命令生成）
- **现象**：onboard 写入的受限公钥行 comment 为 `khc-hub`，uninstall 的 `sed /khc-hub-nd_<hubId>/d` 匹配不到 → 卸载后残留一行 `restrict,command="sudo -n /usr/local/sbin/khc-host",from="10.99.0.1" ... khc-hub`。
- **影响**：低（受限命令 + from 限制），但属清理不彻底。

### P2-11（韧性观察，非确定性 bug）：Agent 重装后的应用层恢复路径

- 重装后各 app `appliedRev=null`、host-ops `installed:false`；**PUT+apply 只恢复 known_hosts，不重建 hub 密钥/脚本**，需再显式 `POST /install`（本次已验证该路径可行）。
- hub 密钥重建后指纹改变 → **所有已 onboard 的 peer 全部失效**（`E_SSH_DENIED`，需逐个重新 onboard）。
- 建议：文档化"Agent 重装 SOP"（install → 各 app install → apply → peer 重新 onboard），或考虑密钥备份。

### P2-7：静态站点无 index.html 时健康探测误报

- HEAD 404 → siteHealth 报 warn"探测异常"，实际站点可访问。低优先级噪声。

### 其他观察（不计缺陷）

- 节点列表的 `status` 字段为上次轮询缓存：hub 实际在线但列表显示 offline（`/state` 实时可达）。属设计取舍，建议 UI 文案区分"最后已知状态"。
- `install.sh` 每次安装都会在终端回显 token（"仅显示这一次"文案与重装场景不符；终端-only，可接受）。
- 节点概况 `agentVersion/uptime` 在 `/state` 顶层不存在（在 `state.agent` 内）——前端如取错层会显示空，本次 API 证据取自正确层级。

## 5. 清理记录（H1）

| 对象 | 动作 | 结果 |
|---|---|---|
| 临时节点 `e2e-test-2026-11-02` | `DELETE /api/v1/nodes/nd_xxxxxxxxxxxxxxxx` | HTTP 200，列表已无 |
| WG peer `arm1-e2e` | D1 config 移除 + apply（rev5）+ 手动 `wg set ... remove`（内核残留，见 P1-9） | `wg show wg0 peers` = 0 |
| Caddy 站点 `pkg-e2e-test` | config 移除 + apply（rev7） | sites=1（仅剩原有 live-gateway） |
| hub `/var/www/khc-pkg` | `rm -rf` | 已删 |
| 端口转发 `e2e-peer-http` | forwards 清空 + apply（rev2）+ `systemctl reset-failed` | count=0，9443 释放 |
| host-ops | peers 清空 + apply（rev3）+ uninstall task | `installed:false`，`/var/lib/khc-agent/host-ops` 清空 |
| arm-1 peer 侧 | 执行面板 uninstall 命令 + 手动 `sed /khc-hub/d`（P2-10 残留）+ `wg-quick down khc0` + 删 `/etc/wireguard/khc0.conf` + 删 `/tmp/peer-onboard.sh` | khc-host/config/nft 表/khc0/authorized_keys 全净 |
| hub `/tmp` | 删 `install-cmd.sh`、`uninstall-cmd.sh`、`khc-token-reinstall` | 已删 |
| 本地 `/tmp` | 保留 cookie/token 快照文件供追溯，不在仓库内 | 无仓库污染 |

最终验证：hub agent active（0.1.4，:8443）、`/state reachable:true`、各 app 配置干净；arm-1 仅有本次测试前已存在的 khc-agent（节点 `e2e-oracle-arm-80`，Oct 31 安装，非本次产物，当时未动）。**（后续收尾：测试 hub 与 arm-1 的 Agent 已于 2026-11-02 全部卸载、D1 节点已清空，见 §6.3。）**

## 6. 需要用户提供或决策的事项

1. **香港 NAT 机修复**：203.0.113.13:<ssh-port> TCP 不通，修复后可补测外网 peer 接入与破坏性场景。
2. ~~**登录限流修复方案**（P1-5）~~：**已拍板并实施并上线**——用户选择 D1 计数（零新增绑定/零成本），P1-C 已合入 main（`02f13b2`）；0006 迁移已先于部署对生产 D1 执行完毕，生产 429 复验通过（见 §4 P1-5 状态行）。
3. ~~**D1 历史遗留节点清理**~~：**已清理（2026-11-02，经主人授权）**——删除清单与卸载结果：
   - **D1 节点删除（面板 API `DELETE /api/v1/nodes/:id`，全部 HTTP 200，删除后 `GET /nodes` 返回 `{"nodes":[]}`）**：`vm1-HK（测试）`（nd_yyyyyyyyyyyyyyyy）、`peer2-user-mode-test`（nd_xxxxxxxxxxxxxxxx）、`aws_hui_us`（nd_xxxxxxxxxxxxxxxx）、`e2e-oracle-arm`（nd_xxxxxxxxxxxxxxxx）、`e2e-oracle-arm-3000`（nd_xxxxxxxxxxxxxxxx）、`e2e-oracle-arm-80`（nd_xxxxxxxxxxxxxxxx）、`sp-vm-aws`（nd_xxxxxxxxxxxxxxxx，本次测试 hub，一并清理以满足"面板节点列表为空"）。
   - **aws hub（203.0.113.10，sp-vm-aws）Agent 卸载**：`systemctl stop/disable khc-agent` + 删 unit + `rm -rf /opt/khc-agent /var/lib/khc-agent /etc/khc-agent`；`wg-quick down wg0` + 删 `/etc/wireguard/wg0.conf`；清 Caddy 的 khc 痕迹（`/etc/caddy/khc.d/` + Caddyfile 的 `import khc.d/*` 两行，validate + reload 通过，caddy 包与默认配置保留）；清残留安装 shell（PID 146603）与 `/tmp/install-cmd.sh`。验证：无 khc unit/进程、三目录不存在、`/etc/wireguard/` 为空、`wg show` 空、`grep -rl khc /etc` 无命中、nft 无 khc_fw 表。
   - **arm-1（203.0.113.11，e2e-oracle-arm 系 3 节点所在机）Agent 卸载**：同上三目录 + unit 清除；仅有一个 agent 实例在跑（:80，即 e2e-oracle-arm-80；8443/3000 实例此前已停）；`authorized_keys`（ubuntu/root）无 khc-hub 残留；`/etc/wireguard/` 为空、无 wg 接口；Caddyfile 无 khc 行。验证：无 khc unit 文件/进程、无 8443/3000/80/8880 监听。已知无害残留：systemd 内存中 `khc-fw.service`（not-found/dead）幽灵条目——盘上无任何引用文件，重启后自然消失。
   - **不可达的 4 个节点**（vm1-HK、peer2-user-mode-test、aws_hui_us 及其余 offline 记录）：仅删 D1 记录，无机器侧操作。
   - **VM 机器本身未动**（不关机、不重装；arm-1 的机器名 "khc" 属机器身份保留）。
4. ~~**bug 修复优先级**~~：**已拍板并实施**——P0-1/P0-2/P1-6/P1-9/P1-3/P1-4/P1-5 已全部在 `fix/server-issues` 分支修复并复验（见 §7）；P1-7/P2-7/P2-8/P2-10/P2-11 未处理，待主人排期。

## 7. 修复进展（2026-11-02，分支 `fix/server-issues`，基于 main 62a0cdd）

> 按主人授权的优先级顺序逐项修复；每项独立提交、独立验证。全部完成后 `./scripts/verify.sh` 退出码 0（vitest 301 项、agent 单测 757 项、typecheck、build、compileall、shell 语法全绿）。

### P0-1（commit `bb4dc81`）：ProtectHome 最小放通

- **改动**：`agent/install.sh` unit 渲染——`ProtectHome=true` → `read-only`，并对 keys.* 需要写入的家目录追加 `ReadWritePaths=`（按用户家目录白名单，仅授权用户）；其余沙箱限制（ProtectSystem/PrivateTmp 等）不变。
- **hub 实机复验**：重载 unit + 重启 Agent 后 `keys.list` 返回家目录与标记块、`keys.add`/`keys.remove` 读写正常；`systemd-analyze security` 暴露面评分未上升；fw.*/processes 等其它动词不受影响。

### P0-2（commit `b5dd69d`）：SCRIPT_PATH 按实际部署形态解析

- **改动**：`agent/adapters/host_ops/khc_host.py` 新增 `_resolve_script_path()`——优先 `KHC_HOST_SCRIPT_PATH` 环境变量，其次 `__file__` 实际位置（realpath），兜底 `/usr/local/sbin/khc-host`；hub self（`<data_dir>/host-ops/khc-host`）与 peer（`/usr/local/sbin/khc-host`）两种形态均覆盖。STATE_DIR 同步按部署形态解析。
- **hub 实机复验**：hub self `fw.apply`（deny tcp/65530 等 3 条高位端口规则）→ ok，`systemd-run` 回滚定时器创建成功；60 秒内 `fw.confirm` 持久化路径可用；不确认时 70s 自动回滚实测成功（本次 P1-B 复验再次确认）。

### P1-A（commit `7a8c91d`）：WG 密钥恢复 + 内核 peer 同步

- **改动**：`agent/adapters/wireguard.py`——(1) `_conf_recovery()` 解析现存 `/etc/wireguard/<name>.conf`，接口私钥丢失时从 conf PrivateKey 恢复（`_derive_public` 推导公钥），peer 公钥按 AllowedIPs 严格匹配恢复（任一 CIDR 缺失/不一致即不恢复，避免错配）；(2) `_prune_kernel_peers()` 在 peer-only apply 后对比 conf 与 `wg show dump`，对内核残留 peer 逐个 `wg set <iface> peer <pubkey> remove`（失败容忍，不阻断 apply）。
- **取舍**：不做 D1 侧 publicKey 回写——apply 响应回传 effective config 会携带私钥（违反"私钥不出 Agent"红线）；Worker 解析 wireguard 结构回写会把应用知识扩散进核心路由。conf 恢复已覆盖真实场景（Agent 重装后 conf/内核接口均在）。
- **单测**：`agent/tests/test_wireguard.py` 新增 10 项（conf 恢复 ×3、严格匹配纯函数 ×4、内核 prune ×3），全文件 111 项全绿。
- **hub 真机复验**：建 peer `p1a-verify`（rev6）→ arm-1 装客户端 ping 2.5ms → 停 Agent 清空 WG 状态文件（keystore/runtime/state.json 等）重启 → 重新 apply rev6 → **conf sha256 不变、peer 公钥原样恢复（privateKey 空=设备自持）、面板 /state 上报 peer 公钥正确、arm-1 ping 不中断**。P1-9 复验：PUT `peers=[]`（rev7）+ apply → 内核 peers=0（无需手动 remove）。

### P1-B（commit `202c2d8`）：保护端口按进程实测 + 协议/端口两维锁定判定

- **改动**：`agent/adapters/host_ops/khc_host.py`——(1) 删除 `FW_PROTECTED_FIXED_PORTS=(8880,)` 硬编码，新增 `_agent_ports()` 从 `/proc` 实测 cmdline 含 khc_agent 的进程持有的 LISTEN socket 端口；(2) 新增 `_protected_by_proto()`（tcp=SSH+Agent 入口，udp=WG），`rule_lockout_reason` 改为协议+端口两维匹配并移除源网段维度（Hub→Peer 控制通道是 SSH，已由 saddr accept + SSH 端口保护覆盖）。
- **单测**：`agent/tests/test_host_ops.py` 存量 5 处适配 + 新增 3 项（`_agent_ports` 进程实测与非 Agent 进程排除、fw.show/fw.apply 保护 8443、协议不匹配与 `0.0.0.0/0` 源不再误拦），全文件 160 项全绿。
- **hub 实机复验**（面板 API `POST /apps/host-ops/call`）：`fw.show` 锁定规则含 `__fixed_8443`/`__fixed_8899`（Agent 进程实测端口，无 8880）；`deny tcp/8443` → `E_LOCKOUT`；`deny udp/22` + `deny tcp/51820`（协议不匹配）与 `deny tcp/65530 source=0.0.0.0/0`（非保护端口）三条规则一次 apply 全部通过；nft 实表确认保护行 `tcp dport { 8443, 8899 } accept`；60 秒自动回滚后表删除、state 复位 `none`，全程 SSH 会话无影响。

### P1-C（commit `f1a6100`）：登录限流改 D1 固定窗口计数

- **改动**：`migrations/0006_rate_limit.sql`（新增 `rate_limit` 表）+ `apps/api/src/lib/rate-limit.ts`（D1 单语句原子 upsert `INSERT ... ON CONFLICT DO UPDATE ... RETURNING count`，窗口过期自动重置；D1 异常 → KV（未绑定跳过）→ 进程内内存三级降级）+ `apps/api/src/routes/auth.ts`（传 `{db, kv}`，阈值 10 次/300 秒不变）。
- **测试**：`apps/api/test/rate-limit.test.ts` 新增 6 项（D1 计数与超限、D1/KV 异常降级、内存兜底、登录集成第 11 次 429 + 异 IP 不受影响）；迁移与 upsert 语义在本地 sqlite3 实测（计数递增、窗口过期重置）。vitest 全量 301 项、api typecheck 通过。
- **生产复验：通过（2026-11-02）**——0006 迁移先于部署对生产 D1 执行（`rate_limit` 表已建，`sqlite_master` 7 表核对）；Worker 随 main `02f13b2`（squash）经 CI 部署成功（run 41468712598 三 job 全绿）；生产复验 12 次错误口令第 11 次 429、D1 计数落库、异 IP 不受影响（详见 §4 P1-5 状态行）。
