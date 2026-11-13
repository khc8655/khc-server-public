# 主机运维（Hub 本机 + Peer 按需 SSH）设计

> 状态：现行 ｜ 最后核验：2026-11-03 ｜ 关联：ADR-0007、docs/host-ops-async.md、docs/host-ops-e2e.md
> 范围：主机运维写操作与 Peer 按需 SSH
> 本文是“主机运维写操作 + Peer 运维”的**唯一权威来源**。只读的 Hub VM 运维卡片（`agent/khc/ops.py`、UI 变更单 #007）已实现，不在此重复。

## 0. 三句话

1. Peer 上**不装守护进程**：需要时在界面点一下，Hub Agent 经 WireGuard 发起一次 SSH，拿回结构化 JSON，用完即断。
2. Peer 上只有两样东西：**一把受限公钥**（`command=` 锁死）+ **一个不运行的静态脚本** `/usr/local/sbin/khc-host`。Hub 被攻破时，攻击者拿不到交互式 shell、只能执行白名单动词——但白名单动词本身可被滥用（见 §0.1 如实说明），这是"显著抬高门槛"而非"Hub 失陷无害"。
3. 全部落在一个适配器 `host-ops` + 一个页面里，**不改冻结核心**（api / contracts / migrations / agent/khc）。

### 0.1 安全边界如实说明（D-5/T4.6，2026-11-03 主人拍板"先只改文档"）

- **如实口径**：Hub 失陷 + host-ops 凭据（Hub 侧 SSH 私钥 + Agent 通道）→ 攻击者可在已接入的 Peer 上执行白名单动词（`fw.apply` / `keys.add` / `cron.set` 等）。**拿不到交互式 shell**（`restrict,command=` 锁死、`from=` 限源、写动作全审计、脚本不可被 Hub 远程覆盖），**但白名单动词本身可被滥用**：
  - `keys.add` 可注入任意公钥 → 攻击者带外直接 SSH 登录该 Peer（等价拿到完整 shell）；
  - `cron.set` 可写任意 crontab 行 → 带外升级为任意命令执行；
  - `fw.apply` 可改动 Peer 防火墙（`E_LOCKOUT` 护栏与 60s 回滚只防误锁死，拦不住故意放行）。
- **本设计的真实价值**：无守护进程、无交互式 shell、动作全审计、脚本与公钥不可被 Hub 远程覆盖——攻击成本与留痕显著高于 B1（免安装 SSH = 完整 shell）；**不是**把"Hub 失陷"降为无害。
- **待办（本批不实现，仅列档）**：`keys.add` / `cron.set` 收窄为仅 `target=self`，或 Peer 侧本地 opt-in 开关文件（Hub 不可远程覆盖）作为接入前置条件；等主人拍板后另行实施。

## 1. 背景与需求

主人的使用方式：一个月打开面板约 10 次，主机出问题时“点一下、看一看”。需求：

| # | 需求 | 对象 |
|---|---|---|
| R1 | 查看系统配置与状态（CPU/内存/磁盘/网络/服务/Top 20 进程） | Hub（已实现，实时）、Peer（本设计，按需） |
| R2 | 查看进程（只读；不提供远程结束） | Hub、Peer |
| R3 | 修改防火墙端口策略 | Hub、Peer |
| R4 | 管理 SSH 公钥 | Hub、Peer |

非目标：Web Shell、任意命令执行、持续监控/告警、Peer 守护进程、批量下发到多台主机。

## 2. 总体链路

```
浏览器（点按钮）
  → Worker  POST /api/v1/nodes/:hubId/apps/host-ops/actions/<verb>   （现有自定义动作透传 + 审计）
  → Hub Agent（8880，现有 HMAC 通道）
      target = "self"      → 本机直接执行 khc-host <verb>
      target = "<peerId>"  → ssh（经 WG）→ Peer 上的 khc-host <verb>
  ← JSON { ok, data | error }
```

- Hub 与 Peer 走**同一个脚本、同一套动词、同一份输出格式**；区别只是是否经过 SSH。
- 读动作同步返回；预算：SSH `ConnectTimeout=4s`、整体 6s，以满足 Worker 侧 8s 超时（`tcp-fetch`）。超时返回明确错误码，不重试。
- 结果**不落 D1**：前端仅在内存里保留最近一次结果，并显示“数据来自 N 分钟前”。写动作照常进 `audit`。

## 3. Peer 端：受限公钥 + 静态脚本

### 3.1 authorized_keys 一行

```
restrict,command="sudo -n /usr/local/sbin/khc-host",from="<Hub 的 WG IP>" ssh-ed25519 AAAA… khc-hub-<hubId>
```

- `restrict`（OpenSSH ≥ 7.2）：禁 pty、端口转发、agent 转发、X11。
- `command=`：无论客户端请求什么命令，都只运行 `khc-host`；客户端想执行的动词从 `SSH_ORIGINAL_COMMAND` 读取。
- `from=`：只接受来自 Hub WG 地址的连接。

### 3.2 运行身份

| 方式 | 说明 | 结论 |
|---|---|---|
| 专用用户 `<ssh-user>` + sudoers 只放行 `/usr/local/sbin/khc-host` | root 权限只给这一个文件 | **默认** |
| 直接 root + `PermitRootLogin forced-commands-only` | 少一个用户，但要改 sshd_config | 可选 |
| 普通用户无 sudo（chisel 接入的非 root Peer） | 只能读，写动作返回 `E_NO_PRIV` | 自动降级 |

sudoers：`<ssh-user> ALL=(root) NOPASSWD: /usr/local/sbin/khc-host`。

### 3.3 脚本 `khc-host`

- 单文件 Python 3（≥3.8，仅标准库）；由 `agent/package.sh` 从 `agent/khc/ops.py`（采集函数）+ `agent/adapters/host_ops/khc_host.py`（动词实现）拼成，**保证 Hub 与 Peer 的采集逻辑同源**。
- 文件属主 root、权限 0755；**不运行、不开机启动、无 systemd 单元**（防火墙持久化单元除外，见 §5.3）。
- 协议：动词来自 `SSH_ORIGINAL_COMMAND`（本机执行时来自 argv），参数是 stdin 上的一个 JSON 对象（≤64 KB）；stdout 输出一个 JSON 对象（≤1 MB）；退出码 0 = 已产生合法 JSON。
- 输出统一包：`{ "ok": true, "v": "<脚本版本>", "data": … }` 或 `{ "ok": false, "v": …, "error": { "code": "E_…", "message": "…" } }`。
- 未知动词、参数校验失败 → `E_BAD_REQUEST`，不做任何事。

### 3.4 更新

脚本**不能被 Hub 远程覆盖**（否则 Hub 失陷即可换成任意脚本，B2 的意义就没了）。
- 每次调用都返回 `v`；低于 Hub 期望版本时界面提示“脚本需更新”，并给出与首次接入相同的一键命令，由主人在 Peer 上执行。
- 旧版本脚本仍可服务它认识的动词；新动词返回 `E_UNKNOWN_VERB`。

## 4. 动词（白名单，一期）

| 动词 | 读/写 | 参数 | 说明 |
|---|---|---|---|
| `version` | 读 | — | 脚本版本、Python 版本、是否有 root、nft 是否可用 |
| `status` | 读 | — | 与 `/state.ops` 同构（`agentOpsSchema`），前端直接复用 #007 卡片 |
| `processes` | 读 | `{ sort: "cpu"\|"mem", limit≤200 }` | pid、ppid、user、startTime、cpu、mem、cmdline（截断 512 字符）；面板默认只取 Top 20 |
| `svc.list` | 读 | — | 只返回 failed 单元 + 面板受管单元（`caddy` / `khc-*` / `wg-quick@*`），不再枚举整机 running 服务 |
| `svc.logs` | 读 | `{ unit, lines≤200 }` | `journalctl` 尾读，默认 100、上限 200 行 |
| `svc.restart` | 写 | `{ unit }` | 受保护单元拒绝；重启后回读 `is-active` |
| `fw.show` | 读 | — | 只返回本系统管理的规则与 `table inet khc_fw` 状态；不再读取其他 nft 表或 iptables |
| `fw.apply` | 写 | `{ rules, baseRev }` | 见 §5 |
| `fw.confirm` | 写 | `{ token }` | 取消 60 秒回滚定时器 |
| `keys.list` | 读 | `{ user? }` | 目标用户 authorized_keys 的指纹、类型、注释、是否本系统管理 |
| `keys.add` | 写 | `{ user?, publicKey, label }` | 只写进标记块 |
| `keys.remove` | 写 | `{ user?, fingerprint }` | 只删标记块内的条目 |
| `cron.list` | 读 | — | 只列 `/etc/cron.d` 下 `khc-*` 受管条目与面板外文件（只读展示） |
| `cron.set` | 写 | `{ name, content?, enabled?, remove? }` | 只写 `/etc/cron.d/khc-<name>`；内容严格校验（见 §4.2） |

`user` 默认 `root`；仅允许 `/etc/passwd` 中存在且有家目录的用户。

### 4.1 进程只读

- 生产路径：先执行一次 `ps -eo pid,ppid,%cpu,rss,uid,etimes --sort=-cpu|mem`，只对入选的
  Top N 行读取 `/proc/<pid>/comm` 与 `cmdline`；不再逐 PID 全量读取 `/proc`（fixture 测试仍走
  `_collect_processes_proc`）。
- 面板默认只请求 Top 20；协议上限仍为 200，避免一次拉回整机进程表。
- `processes` 不提供结束进程的动词；`E_PROTECTED` 仅保留给 `keys.*`。

### 4.2 定时任务（cron）校验

校验的**唯一权威在 `khc-host`**（面板只保留名称字符集/长度的即时提示，内容错误由 Agent 400 返回并带行号）：

- 每行必须是 `/etc/cron.d` 格式：`分 时 日 月 周 用户 命令`；
- 5 段时间字段只接受 `*`、数字、区间 `a-b`、步长 `*/n` 或 `a-b/n`，可逗号列举；越界数字与字母缩写拒绝；
- **拒绝 `@reboot` / `@daily` 等快捷表达式**（开机自启请用 systemd / `svc.*`）；
- 拒绝 shell 分隔符 `;`、`&&`、`||`、`|`、反引号、`$(`，避免一行注入多条命令；
- 最多 100 行、单行 ≤512 字符、不允许控制字符。

## 5. 防火墙（nftables）

### 5.1 管理边界

- **只管理自己的表 `table inet khc_fw`**（`input` 链，`priority filter - 5`，链默认策略 accept），其他表/iptables 规则**不再读取展示**，也绝不修改。
- 语义写清楚：本表里的 `drop` 会生效；本表里的 `accept` **不能**放行被其他表拦截的流量（界面上明确提示）。
- 一期只支持 nftables；检测不到 `nft` 时 `fw.*` 返回 `E_UNSUPPORTED`，其他功能照常。

### 5.2 规则模型

```json
{ "rules": [ { "id": "r1", "action": "allow|deny", "proto": "tcp|udp", "port": "22|8000-8100", "source": "0.0.0.0/0|10.8.0.0/24", "note": "…" } ] }
```

- 强制保留（脚本侧兜底，不信任调用方）：SSH 实际监听端口、WireGuard 监听端口、来自 Hub WG IP 的所有流量、Hub 本机的 8880，以及 `ct state established,related`。任何会拦截它们的规则返回 `E_LOCKOUT`。
- `baseRev` 是 `fw.show` 返回的当前内容哈希，不一致返回 `E_CONFLICT`（防止两处同时改）。

### 5.3 应用与自动回滚

1. 生成新规则文件，`nft -c -f` 语法检查，失败返回 `E_INVALID`；
2. 备份当前 `khc_fw` 表；
3. `systemd-run --on-active=60 --unit=khc-fw-rollback-<token>` 预约回滚到备份；
4. 应用新规则，返回 `{ token }`；
5. Hub **新建一条** SSH 连接调用 `fw.confirm`，成功则停止回滚定时器并持久化；连不上则 60 秒后自动恢复。
6. 持久化：写 `/etc/khc-host/fw.nft`，由 oneshot 单元 `khc-fw.service`（开机加载一次，不常驻）恢复。

Hub 本机（`target=self`）同样走这套流程，确认动作由 Worker 再发一次请求完成——面板能连上 Hub 才算成功。

## 6. SSH 公钥管理

- 只维护 authorized_keys 中 `# >>> khc managed >>>` 与 `# <<< khc managed <<<` 之间的块；块外手工添加的公钥只读展示，不可删除。
- 写入：临时文件 + `fsync` + 原子 rename，保持原属主与 0600。
- `keys.remove` 禁止删除 Hub 自己的运维公钥（`khc-hub-<hubId>`）；删除后该用户可用公钥为 0 时拒绝（`E_LAST_KEY`）。
- 换钥：界面只提供“先添加、确认能登录后再移除”的两步流程。
- 私钥永不进入系统：界面只接受公钥文本。

## 7. Hub 端：适配器 `host-ops`

### 7.1 文件

```
agent/adapters/host_ops.py            适配器：配置渲染、SSH 调用、动作
agent/adapters/host_ops/khc_host.py   脚本动词实现（与 ops.py 一起打包成单文件 khc-host）
agent/tests/test_host_ops.py          假 SSH runner + fixture /proc
apps/web/src/pages/hostops/          VM 卡片动作 + Peer「运维」Tab + 三个抽屉（不新增路由）
```

验收：`git diff --stat` 不出现 `apps/api/`、`migrations/`、`packages/contracts/`、`agent/khc/`。若前端需要类型，在 `apps/web/src/apps/host-ops/` 内本地定义 zod，`status` 复用已有 `agentOpsSchema`。

### 7.2 配置文档（`app_configs`，走 plan/apply）

```json
{
  "peers": {
    "<peerId>": { "enabled": true, "host": "10.8.0.12", "port": 22, "user": "<ssh-user>", "hostKey": "ssh-ed25519 AAAA…" }
  }
}
```

- `render` 产出 Agent 数据目录下的 `host-ops/known_hosts`（0600）。
- `host` 默认取 WireGuard 适配器里该 Peer 的地址，可手改（例如 chisel 隧道的本地端口）。

### 7.3 Hub 的 SSH 密钥

- `install` 时在 Agent 数据目录生成 `host-ops/id_ed25519`（0600），私钥永不离开 Hub、不进 D1、不在任何响应里出现。
- 动作 `hub_pubkey`（读）返回公钥，供界面展示与生成接入命令。

### 7.4 SSH 调用参数（固定，不可由调用方覆盖）

```
ssh -i <data>/host-ops/id_ed25519 -p <port>
    -o BatchMode=yes -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<data>/host-ops/known_hosts
    -o ConnectTimeout=4 -o ServerAliveInterval=2 -o ServerAliveCountMax=1
    -T <user>@<host> <verb>
```

- 参数 JSON 走 stdin；整体超时 6 秒（`fw.apply` 例外，见 §8）。
- 主机密钥不匹配 → `E_HOSTKEY_CHANGED`，不提供“自动接受”。

### 7.5 适配器动作

| 动作 | 模式 | 说明 |
|---|---|---|
| `hub_pubkey` | sync 读 | Hub 运维公钥 |
| `probe` | sync 读 | `ssh-keyscan` 取 Peer 主机密钥指纹，供首次接入时人工核对 |
| `call` | sync，读/写由动词决定 | `{ target: "self" \| "<peerId>", verb, params }`；写动词记审计（target、verb、参数摘要、结果） |

## 8. 错误码

| 码 | 含义 | 界面提示 |
|---|---|---|
| `E_NOT_ONBOARDED` | 该 Peer 未接入 | 显示接入步骤 |
| `E_SSH_TIMEOUT` | 4 秒内连不上 | 检查 WG 握手与 Peer sshd |
| `E_SSH_DENIED` | 公钥被拒 | 重新执行接入命令 |
| `E_HOSTKEY_CHANGED` | 主机密钥变化 | 核对后在设置里重新确认指纹 |
| `E_SCRIPT_MISSING` / `E_SCRIPT_OLD` | 脚本缺失/过旧 | 显示更新命令 |
| `E_NO_PRIV` | 无 root（非 root Peer） | 仅可查看 |
| `E_PROTECTED` / `E_LOCKOUT` / `E_LAST_KEY` | 护栏拦截 | 说明原因 |
| `E_CONFLICT` | 防火墙已被他处修改 | 刷新后重试 |
| `E_UNSUPPORTED` | 无 nft | 防火墙功能不可用 |

`fw.apply` 可能超过 6 秒：走既有 `call_task`（mode=task），UI 轮询任务结果（见 `docs/host-ops-async.md`）。

## 9. 首次接入流程（每台 Peer 一次）

1. 界面“运维”标签显示“未接入”，点“接入”；
2. 界面展示**一条命令**（内含脚本、Hub 公钥、Hub WG IP，`base64` 内联，不依赖任何下载）；主人复制后在 Peer 上以 root 执行一次。命令完成：创建 `<ssh-user>`、写 sudoers（`visudo -c` 校验）、放置脚本、写入受限公钥；
3. 界面调用 `probe` 显示 Peer 主机密钥指纹，主人确认后写入配置（plan/apply）；
4. 自动调用 `version` + `status`，成功即接入完成。

卸载命令同样在界面提供：删受限公钥、脚本、sudoers、`<ssh-user>`、`khc_fw` 表与 `khc-fw.service`。

## 10. 测试与验收

- 单测：脚本各动词（fixture `/proc`、假 `nft`）、护栏（PID 复用、受保护进程、锁死规则、最后一把钥）、SSH 参数不可注入、输出超限截断。
- staging 真机：vm1-HK 作 Hub，独立 Peer（Debian 12 LXD，WG 10.99.0.3）作 Peer：
  - 未接入 → 接入 → `status` 在 6 秒内返回并与 Peer 上 `top`/`df` 一致；
  - 结束一个测试进程；尝试结束 sshd 被拒；
  - 防火墙新增一条 deny 后确认生效；故意加一条拦截 Hub WG IP 的规则被拒；模拟确认失败，60 秒后自动回滚；
  - 添加/移除一把公钥；尝试移除 Hub 运维公钥被拒；
  - 改 Peer 主机密钥后显示 `E_HOSTKEY_CHANGED`。


## 11. 实现落点与验收记录（2026-10-26）

- 适配器：`agent/adapters/host_ops.py`（1.0.0）
- Peer 脚本：`agent/adapters/host_ops/khc_host.py`（与 `agent/khc/ops.py` 打包成单文件 `khc-host`）
- 测试：`agent/tests/test_host_ops.py`（132 项）；全量 Agent **572 项**、前端/Worker **93 项**
- UI：`apps/web/src/pages/hostops/`（不新增路由；VM 卡片 + WireGuard Peer 抽屉「运维」）
- 动作：`hub_pubkey` / `probe` / `onboard` / `call`；`call` 为写动作（同一 Agent 写锁串行）
- 长耗时动作：`call_task`（mode=task）供 `fw.apply` 使用；UI 轮询任务结果（见 `docs/host-ops-async.md`）
- 写动作审计：适配器在动作信封返回 `audit{write,target,verb}`；Worker 通用记录 `host-ops.call`（只记 target/verb/ok/error，不记参数内容）

### 真机验收（vm1-HK 作为 Hub + Peer 自测）

- 接入命令 `bash -n` 通过、内联 base64、无下载；执行后 `<ssh-user>` + sudoers + `/usr/local/sbin/khc-host` + 受限公钥就绪；
- `probe` 返回主机指纹；`onboard` 返回 hubWgIp/脚本版本；写入 peers + plan/apply 生成 known_hosts；
- `call self/peer` 的 version/status/processes 正常；Peer status CPU/内存/磁盘/服务/DNS/路由/Top 进程与真实主机一致；
- 进程列表只读；不再提供 `kill` 动词与面板入口（`khc-host` 1.1.1）。
- `fw.apply` 锁定规则返回 `E_LOCKOUT`；测试网段规则可 apply + 60s 回滚 token + confirm 持久化；空规则清空成功；
- `keys.add/list/remove` 正常；Hub 公钥标记 `hubKey=true/removable=false`，删除被拒；标记块外手工 key 只读；
- 脚本版本低于期望返回 `E_SCRIPT_OLD`（不自动覆盖）；SSH 主机密钥不匹配返回 `E_HOSTKEY_CHANGED`。

### 已知环境前提 / 限制

- Peer 必须开启 `PubkeyAuthentication yes`；接入命令不自动改 sshd（测试机默认关闭，需要运维开启后重启/reload ssh）。
- 专用用户 `<ssh-user>` 的 shell 必须是可执行 shell（当前 `/bin/sh`）；`nologin` 会让 OpenSSH 的 forced command 返回 "This account is currently not available"。
- `fw.apply` 最坏可能超过 6 秒，走 `call_task`；同步读动作仍为 6s 超时，超时返回 `E_SSH_TIMEOUT`，不重试。
- `E_SCRIPT_OLD` 当前严格拒绝旧脚本（即使旧脚本认识该动词），便于 UI 明确提示更新。


### nft 替换修复（issue #12，2026-10-26）

- 根因：nft 对已存在的 table/chain 执行声明式文件是**追加**，旧规则残留、空规则清不清、60s 回滚会把旧规则叠加到新规则。
- 修复：`khc-host` 的 `build_ruleset()` 与回滚文本统一以 `table inet khc_fw {}` + `delete table inet khc_fw` 开头，同一 `nft -f` 事务内原子替换；空备份同样先 delete。
- 真机复测（vm1-HK）：
  1. apply A（deny tcp/65001）→ confirm；apply B（deny tcp/65002）→ confirm；`nft list table inet khc_fw` 只有 65002；
  2. apply C（deny tcp/65003）不 confirm；65s 后自动回滚，`nft list table` 仍只有 65002；
  3. 空规则 apply + confirm 后规则清空。


### 独立 Peer 真机 E2E（2026-10-27，issue #14 关闭）

- 拓扑：Hub `vm1-HK`（WG `10.99.0.1`）── WireGuard ── 独立 Peer（Debian 12 LXD，WG `10.99.0.3`）；Peer 上 `python3`/`wireguard-tools`/`nft`/`<ssh-user>` 就绪。
- 执行：在 Hub 上以 Agent 模式跑 `scripts/host-ops-peer-e2e.sh`（`E2E_WRITES=1 E2E_ALLOW_USER_CREATE=1 E2E_FW_WAIT=65`；`HOST_OPS_CONFIG_FILE` 指向 host-ops 配置；带外 root 私钥）。
- **结果：PASS=99 / FAIL=0 / SKIP=2**（T01–T11）。
  - 独立 Peer `version/status/processes`（只读）、keys add/list/remove + Hub 公钥保护 + 最后一把钥、`E_HOSTKEY_CHANGED`、`from="10.99.0.1"` 正向接入均通过。
  - `fw.apply A/B` confirm 后 nft 只保留 B；`fw.apply C` 不 confirm，65s 自动回滚，nft 仍只剩 B；原始规则恢复。
  - SKIP：反向 `from=` 实测（缺 `HUB_PUBLIC_IP`+`PEER_PUBLIC_HOST`）、`E2E_EXEC_ONBOARD=1` 执行（本次接入已手工完成）。
- 脚本修复（E2E 发现）：Agent 直连补 `idempotencyKey`；`config` 放 body 顶层；`{"params":...}` 单层归一化；断言改用 JSON 解析；防火墙测试源改 `192.0.2.0/24`；短命 sshd 回退 PID 1。
- 未解决：Peer 需预装 `python3`（本次首次 `version` 报 `/usr/bin/env python3` 缺失，安装后恢复）；建议安装脚本前置检查。
