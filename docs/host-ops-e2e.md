# host-ops 独立 Peer E2E 验收（issue #14 预备）

> 脚本：[`scripts/host-ops-peer-e2e.sh`](../scripts/host-ops-peer-e2e.sh)
> 契约：[`docs/host-ops.md`](./host-ops.md) §3–§11、[`docs/host-ops-async.md`](./host-ops-async.md)
> 状态：**真机执行通过（2026-10-27）**：独立 Peer，PASS=99 / FAIL=0 / SKIP=2；结果见 `docs/host-ops.md §11`。
> 适用范围：host-ops 真机 E2E 执行记录 ｜ 最后核验：2026-11-02（docs consolidation） ｜ 关联：docs/host-ops.md §11
> 适用：staging / 专用测试机；**禁止对生产 Hub / 生产 Peer 跑 `E2E_WRITES=1`**

---

## 1. 目的与范围

本脚本把 host-ops 的“Hub 本机 + 独立 Peer”整条链路按真机方式跑一遍，作为
issue #14（独立 Peer 真机验收）的**可重复执行件**：

- 通过**产品 API**驱动（Worker `/api/v1/...` 或 Hub Agent `/apps/host-ops/...`），
  而不是绕过产品直接调脚本；
- 覆盖：受限公钥接入命令、`from=` 来源限制、`probe` 指纹、`status`/`processes`、
  `keys.*`（含 Hub 公钥保护与最后一把钥）、
  主机密钥变化的 `E_HOSTKEY_CHANGED`、`fw.apply` 不确认时 60s 自动回滚
  （含 #12 的“nft 只保留上一条”回归）；
- 缺第二台 Peer / 缺写权限 / 缺带外 SSH 时**明确 SKIP 并说明原因**，不误报失败；
- 缺第二台 Peer 时直接退出 **0**（#14 未就绪时脚本可以安全地纳入验收清单）。

不做什么：

- 不替代 `./scripts/verify.sh`（单测/类型/构建）；
- 不测 UI 渲染（由 UI 变更单 #008 的截图与人工走查负责）；
- 不修改产品代码、不写 D1、不改 `app_configs`（T10 会临时改 Hub 本地
  `known_hosts`，有备份、结束时恢复）；
- 不负责安装 Agent（由 `agent/install.sh` 与 issue #14 的前置步骤完成）。

---

## 2. 环境变量

### 2.1 必填（决定连哪台 Hub / 哪台 Peer）

| 变量 | 说明 |
|---|---|
| `HUB` | Worker 地址（如 `https://<worker-name>.xxx.workers.dev`）或 Hub Agent 地址（如 `http://127.0.0.1:8880`）。二选一由 `HUB_MODE`/自动判断。 |
| `PEER_HOST` | 第二台 Peer 的地址（WG IP 或域名）。**未设置 = 直接 SKIP 并退出 0**。 |

`PEER_HOST` 设置后，其余连接信息二选一：

- **Worker 模式**：`HUB_NODE_ID=<节点 id>` + `KHC_COOKIE` 或 `KHC_PASSWORD`；
- **Agent 模式**：`HUB_AGENT_TOKEN=<节点 token>`（建议在 Hub 上以 root 运行）。

### 2.2 传输与认证

| 变量 | 默认 | 说明 |
|---|---|---|
| `HUB_MODE` | `auto` | `auto`/`worker`/`agent`。auto：有 `HUB_AGENT_TOKEN` → agent；有 cookie/口令 → worker；`:8880` → agent；否则有 `HUB_NODE_ID` → worker。 |
| `HUB_NODE_ID` | 空 | Worker 模式必填；也接受别名 `HUB_NODE`。 |
| `HUB_AGENT_TOKEN` | 空 | Agent 模式必填；也接受别名 `HUB_TOKEN`。**不会打印明文**。 |
| `KHC_COOKIE` | 空 | Worker 模式：浏览器里已有的会话 Cookie（推荐，避免登录限流）。 |
| `KHC_PASSWORD` | 空 | Worker 模式：管理员口令，脚本自动 `POST /api/v1/auth/login`。注意登录限流 **10 次/5 分钟**。 |

### 2.3 Peer 与带外 SSH

| 变量 | 默认 | 说明 |
|---|---|---|
| `PEER_ID` | 自动 | host-ops 配置里的 Peer key。配置里只有一个启用 Peer 时自动取；多个时必须显式指定，否则 SKIP。支持中文/空格（按配置原文）。 |
| `PEER_PORT` | `22` | Peer sshd 端口。 |
| `PEER_USER` | `<ssh-user>` | Peer 上的受限用户（接入命令创建的用户）。 |
| `SSH_KEY` | 空 | 可选的**带外**管理私钥（登录 `PEER_ADMIN_USER`）。用于起测试进程、读 `nft`/`authorized_keys`、创建临时用户、核对 `hostname`。**不设置时所有带外校验 SKIP，产品 API 用例照常跑**。 |
| `PEER_ADMIN_USER` | `root` | 带外 SSH 用户；需 root 才能做 `E2E_EXEC_ONBOARD`/`E2E_ALLOW_USER_CREATE`/`nft` 校验。 |
| `PEER_ADMIN_PORT` | `$PEER_PORT` | 带外 SSH 端口。 |
| `HUB_WG_IP` | 空 | Hub 的 WireGuard 地址（如 `10.8.0.1`）。用于断言 `from="..."`。未设置时若 `onboard` 返回 `hubWgIp` 会自动采用。 |
| `HUB_PUBLIC_IP` | 空 | Hub 公网出口地址。配合 `PEER_PUBLIC_HOST` 做 `from=` **反向实测**（从非 Hub 来源连接必须被拒）。 |
| `PEER_PUBLIC_HOST` | 空 | Peer 的非 WG 入口（公网/其它地址），仅用于反向实测。 |
| `PEER_PUBLIC_PORT` | `$PEER_PORT` | 上述入口端口。 |
| `HUB_RESTRICTED_KEY` | `/var/lib/khc-agent/host-ops/id_ed25519` | Hub 的受限私钥。仅在 **Hub 上以 root** 运行时可读，用于“正向/反向受限公钥实测”。 |
| `HOST_OPS_DATA_DIR` | `/var/lib/khc-agent` | Hub Agent 数据目录。T10 用来定位 `host-ops/known_hosts`。 |
| `HOST_OPS_CONFIG_JSON` | 空 | 直接提供 host-ops 配置 JSON（通常不需要；脚本会从 Worker / Hub `state.json` 自动读取）。 |
| `HOST_OPS_CONFIG_FILE` | 空 | 从文件读取 host-ops 配置 JSON。 |

### 2.4 测试开关

| 变量 | 默认 | 说明 |
|---|---|---|
| `E2E_WRITES` | `0` | `1` 才执行 **fw.apply|confirm / keys.add|remove / 主机密钥负例**。默认只读。 |
| `E2E_ALLOW_USER_CREATE` | `0` | `1` 允许在 Peer 上创建临时用户 `khce2e` 验证 `E_LAST_KEY`，用例结束 `userdel -r`。 |
| `E2E_EXEC_ONBOARD` | `0` | `1` 在 Peer 上真正执行接入命令（写 `/usr/local/sbin`、sudoers、受限公钥）。仅用于**全新测试机**。 |
| `E2E_USE_TASK` | `1` | `fw.apply` 优先走 `call_task` + 轮询；Agent 不支持时自动回退同步 `call`。 |
| `E2E_FW_WAIT` | `65` | 等自动回滚的秒数；小于 61 会被强制改 61（回滚定时器固定 60s）。 |
| `E2E_TASK_TIMEOUT` | `120` | 任务轮询上限秒数。 |
| `E2E_CURL_TIMEOUT` | `20` | 单次 HTTP 超时。 |
| `E2E_KEEP` | `0` | `1` 保留临时目录（排查用）。 |

> **安全**：脚本不会打印 token / cookie / 口令 / 私钥；配置摘要只显示是否设置。

---

## 3. 运行方式

### 3.1 只读快速检查（推荐先跑）

在任意能访问 Worker 的机器上：

```bash
HUB=https://<worker-name>.<account>.workers.dev \
HUB_NODE_ID=hub-vm1 \
KHC_PASSWORD='<管理员口令>' \
PEER_HOST=10.8.0.12 \
PEER_ID=oracle-arm \
HUB_WG_IP=10.8.0.1 \
./scripts/host-ops-peer-e2e.sh
```

预期：T01–T05 通过；T08（写）/T09/T10/T11 中缺能力的项显示 `[SKIP]` 原因。
退出码 0（无 FAIL）。

### 3.2 完整验收（推荐：在 Hub 上以 root 跑）

在 Hub 上以 root 执行，直连本机 Agent，同时用带外 SSH 做旁证：

```bash
HUB=http://127.0.0.1:8880 \
HUB_AGENT_TOKEN='<节点 token>' \
PEER_HOST=10.8.0.12 \
PEER_ID=oracle-arm \
PEER_USER=<ssh-user> \
HUB_WG_IP=10.8.0.1 \
SSH_KEY=/root/.ssh/khc_admin_ed25519 \
E2E_WRITES=1 \
./scripts/host-ops-peer-e2e.sh
```

这会额外覆盖：带外 `nft` 对照（T11）、
`authorized_keys` 静态断言（T09）、known_hosts 负例（T10）。
若还要验 `E_LAST_KEY`，加 `E2E_ALLOW_USER_CREATE=1`。

### 3.3 全新 Peer 首次接入

先把 Peer 加进 WireGuard 与 host-ops 配置（`enabled=true`，可先不填 `hostKey`），
保存并 apply，然后在 **Hub** 上：

```bash
HUB=http://127.0.0.1:8880 HUB_AGENT_TOKEN='<token>' \
PEER_HOST=10.8.0.12 PEER_ID=oracle-arm HUB_WG_IP=10.8.0.1 \
SSH_KEY=/root/.ssh/khc_admin_ed25519 \
E2E_WRITES=1 E2E_EXEC_ONBOARD=1 \
./scripts/host-ops-peer-e2e.sh
```

`E2E_EXEC_ONBOARD=1` 会：执行 `onboard` → 把返回的接入命令通过带外 SSH 在 Peer 上
执行 → 断言 `khc-host`/`/etc/khc-host`/`<ssh-user>` 就绪 → 立刻 `call version` 验证。
之后按 T03 的 `probe` 指纹人工确认，再写入配置并 apply（脚本不会替你写配置）。

### 3.4 参数

| 参数 | 说明 |
|---|---|
| `--writes` | 等价 `E2E_WRITES=1` |
| `--read-only` | 等价 `E2E_WRITES=0`（默认） |
| `-h, --help` | 用法 |

---

## 4. 输出与退出码

```
[PASS] ...   断言通过
[SKIP] ...   环境能力缺失 / 只读模式跳过（附原因，不计失败）
[FAIL] ...   断言失败（汇总里列出）
[INFO] ...   上下文（版本、主机名、token 长度等，不含凭据）
[WARN] ...   设计未承诺的字段/行为（不计失败）
```

| 退出码 | 含义 |
|---|---|
| `0` | 全部通过，或仅有 SKIP（含“未设置 PEER_HOST”的整段跳过） |
| `1` | 至少 1 个 FAIL |
| `2` | 用法/依赖错误（缺 HUB、缺 curl/python3、登录失败、未知参数） |

**缺第二台 Peer 的行为（重要）**：`PEER_HOST` 未设置时，脚本在检查依赖之前就打印
SKIP 说明并 `exit 0`，不发起任何网络请求：

```
[SKIP] 缺少第二台 Peer（PEER_HOST 未设置）—— #14 真机验收需要一台独立 Peer。
       本次不执行任何用例，退出 0。
```

---

## 5. 用例清单

| 用例 | 名称 | 依赖能力 | 关键断言 |
|---|---|---|---|
| **T01** | `hub_pubkey` | API | 返回合法 `ssh-ed25519/rsa` 公钥、`SHA256:` 指纹；本机 `ssh-keygen` 复算一致 |
| **T02** | `onboard` 受限公钥接入命令 | API + 已保存配置 | 命令以 `sudo bash -c` 开头；含 `restrict,command="sudo -n /usr/local/sbin/khc-host"`、`from="<HUB_WG_IP>"`、`visudo -cf`、内联 `base64 -d`；**无** `curl/wget`、**无**私钥；同时返回卸载命令。`E2E_EXEC_ONBOARD=1` 时在 Peer 上执行并验证落地 |
| **T03** | `probe` 指纹 | API（+ 带外可选） | 指纹格式 `SHA256:`；`hostKey` 合法；有带外时与 Peer 的 `/etc/ssh/ssh_host_*_key.pub` 对照 |
| **T04** | Hub 本机读动作 | API | `version` 版本/动词清单；`status` 主机名/uptime/cpu/mem；`processes` 行数与 `pid/startTime` 字段 |
| **T05** | Peer 读动作 | API + 配置 | 同上；有带外时 `hostname` 与真实主机一致 |
| **T08** | `keys.*` | API（写需 `E2E_WRITES=1`） | `keys.list` 标记 `hubKey=true`、`removable=false`；写模式删 Hub 公钥 → `E_PROTECTED`；临时公钥 add→list→remove 闭环；`E2E_ALLOW_USER_CREATE=1` 时临时用户删最后一把钥 → `E_LAST_KEY` |
| **T09** | `from=` 限制 | 带外 SSH / Hub 受限私钥 | 静态：托管行含 `restrict,`、`command=...khc-host`、`from="<HUB_WG_IP>"`、未放宽来源；正向：Hub 受限私钥直连可执行；反向：从非 Hub 来源连接必须 `Permission denied` |
| **T10** | 主机密钥变化 | `E2E_WRITES=1` + Hub 本地 `known_hosts` 可写 | 临时替换 `known_hosts` 为错误主机密钥 → Peer 调用返回 `E_HOSTKEY_CHANGED`；恢复后 sha256 一致且调用恢复可用 |
| **T11** | 防火墙 60s 自动回滚（#12 回归） | `E2E_WRITES=1` + Peer root + nft + systemd-run | A apply+confirm → 只有 65001；B apply+confirm → 只有 65002（65001 不残留）；C apply 不 confirm → `pending.token` + `expiresInSeconds=60`，等待后回滚到 B、65003 消失；有带外时用 `nft list table inet khc_fw` 二次确认；结束恢复原始规则 |

> 所有断言只使用 **API 返回的 JSON** 与**带外命令输出**；不读取 D1、不读配置文件内容
> （T02 的配置读取只用于解析 Peer 列表，不打印）。

---

## 6. 环境能力 → SKIP 矩阵

| 缺少的能力 | 被 SKIP 的用例 | 保留的覆盖 |
|---|---|---|
| 第二台 Peer（`PEER_HOST` 未设） | 全部 | 脚本打印 SKIP，退出 0 |
| 已保存的 host-ops 配置 | T02、T03、T05–T11 | T01、T04（本机读） |
| `PEER_ID` 无法确定（多个 Peer 且未显式给） | 全部 Peer 用例 | 脚本打印候选并退出 0 |
| 带外 SSH（`SSH_KEY` 未设/不可登录） | T09 静态、T11 的 nft 对照、T08 的临时用户 | T01–T05、T08 主体、T10、T11 API 断言 |
| `E2E_WRITES=0` | T08 的删除/添加、T10、T11 | 所有读动作与 `removable=false` 断言 |
| Peer 非 root（`version.root=false`） | 写动作会返回 `E_NO_PRIV`（脚本按真实结果判定） | 读动作 |
| Peer 无 nft（`version.nft=false` 或 `fw.show.available=false`） | T11 | 其余 |
| 读不到 Hub 受限私钥 | T09 正向/反向实测 | T09 静态断言（若有带外） |
| 未暴露 Peer 非 WG 入口（`PEER_PUBLIC_HOST`/`HUB_PUBLIC_IP` 缺） | T09 反向实测 | T09 静态断言 |
| 非 Hub 本机运行（无 `known_hosts` 写权限） | T10 | 其余 |
| Agent 不支持 `call_task` | 不跳过；自动回退同步 `call`（可能受 6s 窗口限制） | 全部 |

---

## 7. 已知限制与风险

1. **T11 必须真等 60 秒**：回滚定时器是 `systemd-run --on-active=60`，脚本用
   `E2E_FW_WAIT`（默认 65）等待。这是真实行为的验证，不能加速；整轮约 +70s。
2. **写测试会改变测试机状态**：
   - `fw.apply` 只操作 `table inet khc_fw`，使用高位端口 65001–65003，结束恢复原始规则；
   - `keys.add/remove` 使用一次性 ed25519 公钥，结束移除；
   - `E2E_ALLOW_USER_CREATE=1` 会创建/删除临时用户 `khce2e`；
   - **不要在承载业务的 Peer 上跑写测试**；更不要对生产跑。
3. **T10 会短暂改动 `known_hosts`**：只在 root + Hub 本机可行；窗口是“写坏文件 →
   一次 API 调用 → 恢复”，脚本用 `trap` 兜底恢复。若脚本被 `kill -9`，需手工从
   `$TMPDIR_E2E/known_hosts.bak`（`E2E_KEEP=1` 时保留）恢复。
4. **`from=` 反向实测需要额外网络条件**：Hub 要能从非 WG 地址出网、Peer 要暴露
   非 WG 入口。否则只做 `authorized_keys` 静态断言，并在输出中明确 SKIP。
5. **受限公钥正向实测需要 Hub 的私钥**（`HUB_RESTRICTED_KEY`）：只有在 Hub 上以
   root 运行才可读。在笔记本上跑时该断言 SKIP（不是失败）。
6. **Worker 模式无法做 T10**：`known_hosts` 在 Hub 本地；脚本会 SKIP 并提示在 Hub 上跑。
7. **`E2E_EXEC_ONBOARD=1` 会改 Peer 系统**：创建 `<ssh-user>`、写 sudoers/脚本/受限公钥。
   仅用于全新测试机；执行前确认 `PEER_HOST` 不是生产机。
8. **登录限流**：Worker 登录 10 次/5 分钟；反复调试请用 `KHC_COOKIE`。
9. **Peer 脚本版本过旧**：所有 `call` 会返回 `E_SCRIPT_OLD`（设计如此），脚本会 FAIL；
   按界面提示在 Peer 上重跑接入命令更新脚本后再验收。
10. **清理是 best-effort**：退出时若网络已断，防火墙恢复可能失败，需人工按
    `fw.show` 与 `docs/host-ops.md §5` 处理；脚本会打印提示。
11. **不纳入 CI**：需要真机/真实 Peer，`./scripts/verify.sh` 只做 `bash -n` 级别的
    静态检查（本脚本已通过 bash 3.2 与 bash 5 语法检查）。

---

## 8. 故障排查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `[SKIP] 缺少第二台 Peer` | `PEER_HOST` 未设置 | 按 §2/§3 设置后重跑 |
| `[SKIP] 配置里没有已启用的 Peer` | host-ops 未接入/未 apply | 面板完成接入向导、保存配置并 apply |
| `[SKIP] 配置里有 N 个启用 Peer` | 多 Peer 未指定 | 设置 `PEER_ID` |
| `E_NOT_ONBOARDED` | Peer 未接入或 `enabled=false`/`known_hosts` 缺失 | 执行接入命令；保存 `hostKey` 并 apply |
| `E_SSH_TIMEOUT` | WG 未握手 / sshd 不可达 / 端口错 | 在 Hub 上 `wg show`、`nc -vz <peer> 22` |
| `E_SSH_DENIED` | 受限公钥未写入 / `from=` 不匹配 / sshd 未开 `PubkeyAuthentication` | 重跑接入命令；核对 `HUB_WG_IP`；检查 Peer sshd 配置 |
| `E_HOSTKEY_CHANGED` | Peer 重装或换主机密钥 | 在面板重新 `probe` 并确认指纹 → 保存 apply |
| `E_SCRIPT_OLD` / `E_SCRIPT_MISSING` | Peer 上 `khc-host` 版本旧/缺失 | 重新执行接入命令（脚本不会被远程覆盖） |
| `E_NO_PRIV` | Peer 非 root / sudoers 未生效 | 检查 `<ssh-user>` 的 sudoers 与 `visudo -cf` |
| `E_LOCKOUT` | 规则会拦截 SSH/WG/8880/Hub WG 来源 | 这是护栏，属预期；调整规则 |
| `E_CONFLICT` | `baseRev` 过期 / 已有 pending | 先 `fw.show` 刷新；等 pending 回滚或确认后再改 |
| `E_UNSUPPORTED` | Peer 无 nft / systemd-run 不可用 | 安装 nftables/systemd；或跳过 T11 |
| T11 回滚未发生 | `systemd-run` 失败 → 产品会返回 `E_UNSUPPORTED` 且**不修改**防火墙 | 检查 `systemd-run --version` 与权限 |
| 登录 `HTTP 429` | 撞登录限流 | 改用 `KHC_COOKIE`，等 5 分钟 |

---

## 9. 与 issue #14 的关系（真机执行步骤）

Wave 2 的执行顺序：

1. **准备第二台 Peer**（独立于现有 4 台生产 Hub/Peer）：安装 sshd（开启
   `PubkeyAuthentication`）、可用 nft/systemd、WireGuard 与 Hub 握手正常。
2. **只读跑一遍**（§3.1）：确认 T01–T05 全绿，记录 SKIP 原因。
3. **完整跑一遍**（§3.2，`E2E_WRITES=1`）：记录 T08–T11 输出。
4. **结果回填**：把命令、关键输出（版本、指纹、nft 断言、回滚时间）
   按 `docs/host-ops.md §11` 的“真机验收”格式追加，并在 PR 描述里附执行环境
   （发行版、内核、systemd、nft 版本、OpenSSH 版本、Agent/脚本版本）。
5. **关闭 #14**：若存在 SKIP，逐项说明原因（是“环境不满足”还是“待补能力”）。

**结果记录模板**：

```text
日期 / 执行人 / 提交（git rev）/ 环境（Hub + Peer 发行版/架构）
HUB=... HUB_MODE=... PEER=... PEER_ID=... PEER_USER=... HUB_WG_IP=...
命令：E2E_WRITES=1 ... ./scripts/host-ops-peer-e2e.sh
结果：PASS=n FAIL=0 SKIP=m（附 SKIP 原因清单）
关键证据：
  - hub_pubkey 指纹：SHA256:...
  - probe 指纹：SHA256:...（与 Peer ssh-keygen 一致）
  - fw.apply：A/B confirm 后 nft 只有上一条；C 未确认 65s 后自动回滚
  - keys：add/remove 闭环；Hub 公钥 E_PROTECTED；E_LAST_KEY（如启用）
  - E_HOSTKEY_CHANGED：命中并恢复
遗留/限制：...
```

---

## 10. 维护约定

- **契约变更必须同步脚本**：`docs/host-ops.md` §4 的动词、§8 的错误码、§3.1 的
  authorized_keys 格式发生变化时，更新对应 T 用例的断言与本文档。
- 新增动词（例如未来的 `disk.*`）时：在 `docs/host-ops.md` 登记 → 脚本加
  `Txx` → 本文用例表加一行。
- 脚本的“带外能力”一律保持**可选**：任何新增断言都不能让“没有第二台机器”的
  环境从 SKIP 变成 FAIL。
- 修改后最低验证：`bash -n scripts/host-ops-peer-e2e.sh`；
  有第二台 Peer 时跑 §3.1/§3.2。
