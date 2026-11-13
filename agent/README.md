# khc-agent（Hub 端 Agent 内核）

> 状态：现行 ｜ 最后核验：2026-11-02 ｜ 关联：docs/design-v3.md §2.2、docs/agent-lifecycle.md
> 范围：Agent 内核/适配器契约与已知限制

只用 **Python 3.11 标准库**，供 Cloudflare Worker 按需 HTTPS 调用（HMAC 鉴权）。
内核冻结、适配器可插；加一个应用 = `adapters/<app>.py` 一个文件（+ 前端页面）。

```
agent/
  khc_agent.py                 # 入口：run / version / token
  khc/
    auth.py                    # HMAC-SHA256（±60s，nonce 120s 防重放）
    http.py                    # ThreadingHTTPServer + 路由 + 统一错误信封
    adapters.py                # Adapter 基类 / Ctx / 加载器 / 最小 JSON Schema
    kernel.py                  # plan/apply/rollback/备份/端口/幂等/写锁/Caddy
    tasks.py                   # 线程任务执行器（状态机/日志环形缓冲/取消）
    state.py                   # GET /state 组装
    util.py                    # 原子写 / sha256 / JSON / 文件锁 / Paths / 时间
  adapters/node_exporter.py    # 第一个适配器（C1 演练）
  adapters/wireguard.py        # C2：WireGuard 组网 + 客户端配置 + 无损换钥
  adapters/caddy_site.py       # C3：反代站点（Caddy 片段装配）
  adapters/certificates.py     # C3：证书部署（配合控制面全局证书库）
  adapters/port_forward.py     # C3：端口转发（iptables）
  adapters/host_ops.py + host_ops/  # 主机运维（服务/进程/防火墙/密钥/Peer 按需 SSH）
  tests/                       # unittest（数量以 ./scripts/verify.sh 实测为准；无需 root / 不联网）
  install.sh / uninstall.sh / khc-agent.service
```

## 快速开始

```bash
# 开发/演练：不需要 root，文件根目录指向临时目录
KHC_ROOT=/tmp/khc-root KHC_TOKEN=dev-token \
  python3 agent/khc_agent.py run --port 8880

curl -s http://127.0.0.1:8880/health
# {"ok":true,"version":"0.1.0"}

# 线上安装（root）
sudo ./install.sh            # 程序 /opt/khc-agent，数据 /var/lib/khc-agent
./install.sh --user          # 无 root：~/.local/share/khc-agent + systemd --user

# 查看/生成节点 token（Worker 侧签名用）
python3 khc_agent.py token --token-file /etc/khc-agent/token
```

## HTTP 契约（与 Worker 冻结对齐）

除 `GET /health` 外全部要求：

```
X-Khc-Ts:     unix 秒
X-Khc-Nonce:  一次性随机串（120s 内不可复用）
X-Khc-Sig:    hex(HMAC-SHA256(token, f"{METHOD}|{path}|{ts}|{nonce}|{sha256hex(body)}"))
```

- path **不含 query**；GET/空 body 的 hash 是 `sha256("")`；
- 时间窗 ±60s；失败 401 `{"ok":false,"error":{"code":"unauthorized",...}}`；
- header 名大小写不敏感；token 文件支持多行（双窗口轮换，新旧同时可用）。

动作请求体（Worker 契约）：

```json
{"config": {...}, "expectRev": 12, "epoch": "<rev epoch>", "params": {...}, "idempotencyKey": "..."}
```

| 端点 | 说明 |
|---|---|
| `GET /health` | 无鉴权 `{ok, version}` |
| `GET /state` | 顶层 `host` / `adapters` / `ports` / `tasks`（另有 `ok`；`tasks` 为可选任务摘要） |
| `GET /adapters` | `{ok, adapters:[{name,version,api,schema,actions,requires_root}]}` |
| `POST /apps/<app>/<action>` | plan/apply/rollback 同步；install/uninstall/长动作返回 `{ok,taskId}` |
| `GET /tasks/<id>` | `{ok, task:{id,state,progress,logs,result,error}}` |

- `plan` → `{ok, rev, changes:[{path,diff}], warnings}`，不落盘；
- `apply` → `{ok, rev, appliedRev, epoch, changes, result:{cards}, warnings}`；写动作必须带
  `idempotencyKey`（10 分钟内同 key 回放结果）；失败自动回滚，返回非 2xx +
  `{ok:false,error:{code,message,details}}`；
- 同一节点同一时间只允许一个写动作，冲突 409 `busy`；端口冲突 409 `port_conflict`
  并带 `occupiedBy`；`expectRev` 落后于已应用版本 409 `conflict`；
- rev epoch（D-2/R-2）：`epoch` 为节点纪元（创建时生成，节点重建/恢复时换新值）。
  Agent 持久化收到的 epoch（`state.json` 顶层）并在 `/state`（`agent.epoch`）与 apply
  响应回传。apply 发现纪元不一致即判定旧纪元：清除全部应用的 `appliedRev` 基线
  （保留配置快照），低 rev 重新下发不再 409；本地无纪元（新装/在线升级）则直接
  采纳、不清基线。旧控制面（无 `epoch` 字段）行为与历史版本完全一致。
- `uninstall` 的 `params:{"purge":true}` 清理程序与配置目录。

## 环境变量

| 变量 | 用途 |
|---|---|
| `KHC_ROOT` | 把 `/etc`、`/opt`、`/var/lib` 整体映射到临时根目录（无 root 单测/演练） |
| `KHC_DATA_DIR` | 覆盖数据目录（`ports.json` / `state.json` / `backups/`） |
| `KHC_PROFILE` | `system` / `user`（默认按 euid；设置 `KHC_ROOT` 时默认 system） |
| `KHC_TOKEN` | 逗号/换行分隔的 token（优先于 token 文件） |
| `KHC_PORT` | 监听端口（默认 8880；`KHC_HOST` 默认 0.0.0.0，可用 127.0.0.1 收敛） |
| `KHC_WG_WATCHDOG` | `0/false/no/off` 关闭 WireGuard 换钥看守线程（默认开启，仅在有 PENDING 轮换时启动） |

其余 `KHC_ETC_DIR` / `KHC_OPT_DIR` / `KHC_CONFIG_DIR` / `KHC_UNIT_DIR` /
`KHC_CADDY_DIR` / `KHC_CADDYFILE` / `KHC_TOKEN_FILE` 可单独覆盖（install.sh 会显式传入）。

## 写一个适配器

```python
from khc import Adapter, Ctx, File, Unit, CaddySnippet

class MyApp(Adapter):
    name = "my-app"; version = "1.0.0"; api = 1
    requires_root = False
    ports = [("tcp", "port")]            # 内核做端口登记/冲突检查
    schema = {"type": "object", "properties": {"port": {"type": "integer", "default": 1234}}}
    actions = {"rotate": {"mode": "sync", "write": True}}   # 自定义动作

    def render(self, ctx: Ctx, config):  # 纯函数：配置 -> 文件/unit/Caddy 片段
        return [File(f"{ctx.paths.app_config_dir('my-app')}/config.json", "{}"),
                Unit("khc-my-app.service", content="[Service]\nExecStart=/bin/true\n", restart=True)]

    def install(self, ctx, config):      # 任务内执行；下载用 ctx.download(sha256=...)
        return {"cards": [{"title": "地址", "value": "http://127.0.0.1:1234", "copy": True, "qr": False}]}

    def uninstall(self, ctx, purge=False): ...

    def action_rotate(self, ctx, body): return {"ok": True}
```

`plan/apply/备份/回滚/原子写/unit reload/端口/幂等/写锁/Caddy 装配`全部由内核完成，
适配器**不允许**自己做这些。外部命令一律走 `ctx.run()`（单测注入 mock）。

## WireGuard 适配器（C2）

`wireguard` 适配器负责接口 + peers、客户端配置与无损换钥；外部命令（`wg` / `wg-quick`
/ `systemctl`）全部经 `ctx.run()`（单测注入 mock，无需 root、不联网）。

### 配置 schema

```json
{
  "interface": {
    "name": "wg0",
    "address": "10.99.0.1/24",
    "listenPort": 51820,
    "privateKey": "",
    "publicKey": "",
    "mtu": 1420,
    "extIface": "eth0",
    "publicEndpoint": "203.0.113.10:51820",
    "postUp": "",
    "postDown": ""
  },
  "peers": [
    {
      "name": "phone",
      "publicKey": "",
      "privateKey": "",
      "allowedIps": ["10.99.0.2/32"],
      "keepalive": 25,
      "endpoint": null,
      "enabled": true
    }
  ]
}
```

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `interface.name` | string | `wg0` | 1-15 位 `[A-Za-z0-9_=+.-]` |
| `interface.address` | string | `10.99.0.1/24` | 可逗号分隔多个 IP/CIDR（IPv4/IPv6） |
| `interface.listenPort` | integer | `51820` | 同时声明 `udp/<port>` 参与内核端口登记/冲突检查 |
| `interface.privateKey` | string | `""` | 空 = `wg genkey` 生成并缓存；有值则使用 |
| `interface.publicKey` | string | `""` | 空 = 由私钥 `wg pubkey` 推导；有值绝不复写 |
| `interface.mtu` | integer | `1420` | 576-9000 |
| `interface.extIface` | string | `eth0` | 默认 PostUp MASQUERADE 的出口网卡 |
| `interface.publicEndpoint` | string | `""` | 客户端配置的 `Endpoint`（`host:port`） |
| `interface.postUp` / `postDown` | string | `""` | 空 = 默认 iptables FORWARD + MASQUERADE / `-D` 规则；自定义则整体覆盖 |
| `peers[].name` | string | 必填 | 1-32 位 `[A-Za-z0-9_.@-]`，同一配置内唯一 |
| `peers[].publicKey` | string | `""` | 有值绝不复写（设备自持私钥的 peer 不会被生成私钥） |
| `peers[].privateKey` | string | `""` | 空 = 自动生成并缓存；**只用于客户端配置，绝不写服务端 conf** |
| `peers[].allowedIps` | array[string] | `[]` | 同一网段不能同时分给两个 enabled peer |
| `peers[].keepalive` | integer | `25` | 0 = 不写 `PersistentKeepalive` |
| `peers[].endpoint` | string \| null | `null` | `host:port`（IPv6 用 `[addr]:port`） |
| `peers[].enabled` | boolean | `true` | false 不渲染 `[Peer]`，模板仍保留 |

密钥缓存：`<data_dir>/wireguard-keys.json`（0600）；服务端 `wg0.conf` 只写 peer 公钥。

### 渲染与应用

- `render()` → `/etc/wireguard/<name>.conf`（0600）+ `wg-quick@<name>.service`
  （系统包自带，内核只 enable/start）；服务端配置不写 DNS，默认 PostUp/PostDown
  使用 `iptables FORWARD + MASQUERADE -o <extIface>`。
- `validate()` → `wg-quick strip <apply 临时文件>`；语法错误返回 `invalid_config`，旧文件不动。
- 内核最小可选钩子 `after_apply(ctx, changes[, config, previous])`：
  - 首次 apply：内核已按新配置启动 unit，不再 down/up；
  - **接口段未变且接口已 up** → `wg-quick strip` → `wg syncconf <iface> <临时文件>`（peer-only 不闪断）；
  - **接口级变化**（name/address/listenPort/mtu/extIface/私钥/PostUp/PostDown）→
    `systemctl restart wg-quick@<iface>`；
  - 钩子失败由内核回滚文件并恢复 unit。

### 动作（`actions`）

| 动作 | mode/write | 说明 |
|---|---|---|
| `client_config` | sync / 只读 | params `{"peer": name, "allowedIps"?: [...]}` → `{ok, cards:[{title:"客户端配置", value, copy:true}]}`；Address 只取 peer 自己的 `/32`，Endpoint 用 `publicEndpoint`，AllowedIPs 默认接口网段（默认即 `10.99.0.0/24`） |
| `rotate_peer` | sync / 写 | 生成新密钥对，`wg set <iface> peer <NEW> allowed-ips ""`（旧 peer 不动），返回新客户端配置 + PENDING |
| `confirm_rotation` | sync / 写 | CUTOVER 后删除旧 peer，并把新密钥对写回本地缓存（status/client_config 立即切到新钥） |
| `cancel_rotation` | sync / 写 | PENDING 删除新 peer；CUTOVER 先把 AllowedIPs 挪回旧 peer 再删新 peer |

业务错误统一 `{ok:false, error:"..."}`（HTTP 200）；外部命令失败抛 `command_failed`。

### 无损换钥状态机（docs/design-v3.md §5）

```
ACTIVE --rotate_peer--> PENDING --新钥握手--> CUTOVER --confirm/24h 宽限--> ACTIVE(新钥)
                          |                    |
                          +--cancel/7d 超时--> ACTIVE(旧钥)
```

- 状态持久化在 `<data_dir>/wg-rotation.json`（0600，含一次性新私钥）；
- 看守线程只在有进行中轮换时启动，每 1s 查 `wg show <iface> latest-handshakes`；
  新公钥握手时间不早于轮换开始时间 → `wg set ... allowed-ips <原 IP>`（WireGuard 会把
  地址从旧 peer 原子抢走）→ 24h 宽限期；宽限期结束自动删旧 peer；
- 同一 peer 同时只允许一个进行中的轮换；
- 线程默认开启（`KHC_WG_WATCHDOG=0` 关闭）；Agent 重启时内核 `start()` 钩子从状态文件
  恢复看守；测试用 `WireGuard(watchdog_enabled=False)` + `tick_rotations(now=...)` 手动推进，
  `close()` 停止线程。

### status（`/state`）

返回 `installed` / `running` / `interface` / `unit` / `conf` / `peers` / `rotations`。
`peers[]` 含 `name`、`publicKey`、`allowedIps`、`latestHandshake`、`online`（180s 内）、
`rx`、`tx`、`endpoint`；`rotations[]` 含 `state`、`oldPublicKey`、`newPublicKey`、
`startedAt`、`cutoverAt`、`graceUntil`、`expiresAt`、`latestHandshake`（**不含私钥**）。
`wg show dump` 失败时回退 `latest-handshakes`；`status()` 自身永不抛异常。

## 测试

```bash
# 从仓库根目录
python3 -m unittest discover -s agent/tests -t agent          # 或加 -v
PYTHONPATH=agent python3 -m unittest discover -s agent/tests -t agent -v
```

覆盖：HMAC 正确/错误/过期/nonce 重放；plan/apply diff；apply 失败自动回滚；
幂等回放；端口冲突；并发写锁 409；适配器加载与 Schema 校验；`after_apply`/`start` 钩子；
node_exporter render；install（fixture tar.gz，无网络）；rollback；uninstall；C1 全流程；
`/state`；CLI；WireGuard schema/render/validate、peer-only `syncconf` vs 接口级 `restart`、
udp/51820 端口登记、客户端配置、无损换钥全状态机（PENDING→CUTOVER→confirm/cancel/timeout）
与并发保护。

## 已知限制 / 未实现

- 默认 HTTP 直连 `0.0.0.0:8880`（HMAC 鉴权）；**内核无 TLS 实现**，需要 HTTPS 时用 Caddy 8443 反代或 cloudflared 隧道。
- 单节点单进程模型：写锁、幂等缓存、nonce 缓存都在内存；没有跨进程/多实例协调。
- 任务取消只有内核 API（`TaskManager.cancel`），未暴露 HTTP 端点（契约冻结，未加路由）。
- rollback 是“恢复上一次 apply 前的文件快照”（基于备份清单）；Worker 的版本回滚按设计
  走“旧 config 生成新 rev 再 apply”，两者都可用。
- Caddy reload 优先 `caddy reload`，失败回退 `systemctl reload caddy.service`；假定 unit 名为 caddy。
- `install` 默认从 GitHub Release 下载（URL 可通过 `config.downloadUrl` / `params` /
  `KHC_NODE_EXPORTER_URL[_TEMPLATE]` 覆盖）；sha256 可选。
- 二期：单文件 Go Agent（适配器 api 不变）。

### WireGuard / C2 相关限制

- 内核为 C2 增加了两个最小**可选**钩子（纯加法，现有适配器默认 no-op）：
  `after_apply(ctx, changes[, config, previous])`（apply 成功提交后、健康检查前执行，失败走内核
  回滚）与 `start(ctx)`（Agent 启动时恢复后台看守）。集成点见 `agent/khc/kernel.py`。
- WireGuard `install` 只校验 `wg`/`wg-quick` 是否存在，不代跑 apt/下载；软件包需预先安装。
- `confirm_rotation` / CUTOVER 只改运行时与 Agent 本地缓存；`/etc/wireguard/<name>.conf`
  的持久化仍由 Worker 下一次 apply 完成。若在 Worker 回写新公钥前重启 Agent，
  `wg-quick` 会用旧配置恢复旧 peer（运行时切换丢失，但旧钥仍可用、不会失联）。
  Worker 应在确认后把 `peer.publicKey`（必要时连同 `secrets_enc` 里的 `privateKey`）写回并 apply。
- 轮换看守线程不持有内核写锁：与并发的 apply / rotate 之间靠 `wg` 原子操作 + 适配器内
  RLock 保证；单进程模型，无跨进程协调。
- 显式 `rollback` 会恢复 `wg0.conf` 并 restart unit，但不会回写 Agent 的运行时快照 / 密钥缓存；
  `status` 会短暂显示回滚前的 peers，直到下一次 apply。
- 首次 `plan` 也会生成并缓存密钥（保证 plan/apply 渲染稳定），但不写配置、不跑 unit。
- `wg syncconf` 用「`wg-quick strip` 输出写到 0600 临时文件」实现（不使用 shell 进程替换），
  执行后立即删除临时文件。
- 未实现：接口私钥的“新接口迁移”流程（design §5.4 的 Hub 自身换钥，需在 `wg1` 上逐个迁移 peer）。


## 6.4a 观测层（只读）

- `run` 默认在 `127.0.0.1:8899` 启动只读 WS（`--live-host/--live-port`，`--no-live` 关闭）。
- 浏览器经 Caddy `/_live/` 反代接入，首条消息提交控制面签发的 60 秒一次性 ticket。
- `KHC_LIVE_ORIGINS` 配置允许的控制台 Origin（逗号分隔）；生产必须配置。
- 只读；唯一操作 nudge 仅 ack（v3 暂无 desired 拉取）。详见 `docs/live-observation.md`。
