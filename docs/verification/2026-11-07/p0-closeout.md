# P0 收口核验与 P5 三项评估（2026-11-07）

> 归类：工程流程（验证记录）
> 状态：验证记录（分支 `feat/todo-closeout-2026-11-07` / 基线 `2668075`；未合并、未部署；测试 VM 临时进程已全部回收、443/8443 已释放）
> 适用范围：P0「仍未测」中可自动化项的真机实跑结论 + §2 P5 三项（D1 状态对齐 / 直连观测改协议 / P2 隧道实现）评估结论
> 最后核验：2026-11-07（VM UTC `2026-11-06 17:22:52 → 17:23:04`；本机 UTC+8 为 11-07）
> 关联：`AGENTS.md` §3 红线 9a、`docs/TODO-2026-11-06.md` §2 P0 实测记录 / §2 P5 / §3.8、`docs/design-v3.md` §1.1、`docs/security-boundaries.md` §1、`docs/live-observation.md` §8、`docs/engineering/adr/ADR-0001` / `ADR-0010` / `ADR-0012`、`apps/api/src/lib/diagnostics/evaluate.ts`、`scripts/p0-verify-20261107.py`
> 索引登记：按红线 9a，本文件须登记 `docs/README.md`「工程流程」表；按主人「统一收口」分工，本轮**未触碰索引**，由收口方补登记（见 §8）。

---

## 0. 边界与合规声明

- **未修改任何现有产品代码文件**（`apps/**`、`agent/**`、`packages/**`、`.github/**`、`wrangler.toml`、现有 `docs/**` 一律未动）；本轮仅新增 `scripts/p0-verify-20261107.py` 与本文件。
- 未执行 `git add/commit/push/stash/checkout`；未跑 `./scripts/verify.sh` / 全量测试；未安装第三方工具；未删除任何既有文件（仅清理 `py_compile` 自身生成的 `scripts/__pycache__/*.pyc` 字节码缓存，见 §7）。
- 测试 VM 与面板**口令 / token 全程未回显**：`<local-volume>/临时文件/测试 VM 信息.md` 只读取了字段结构（地址 / 认证 / 开放端口 / 面板登录 / staging URL），值一律脱敏；本轮 HMAC token 为每次运行随机生成、不打印、不写入仓库；私钥只作 `ssh -i` 路径参数。
- 本机设了 `HTTP_PROXY` / `HTTPS_PROXY`，所有直连 `curl` 均带 `--noproxy '*'`。
- **共享工作区声明**：多个并行代理正在改 `apps/**`、`agent/**`、`packages/**`、`docs/**`、`.github/**` 等（本轮只读这些文件）。§4 的 P5 结论以「最后核验」时点的工作区状态为准；期间并行代理落地了 `ADR-0012-connection-scheme-selection.md` 与 `node-client.ts` 的 §3.8 改造。
- 测试 VM：test-hub `203.0.113.10` / IPv6 `2001:db8::10`，Debian 12、Python 3.11.2，SSH 用户 `admin`；Agent 包 `apps/web/public/agent/khc-agent-0.1.19.tar.gz`。

---

## 1. 实测环境与复现命令

### 1.1 一键复现

```bash
cd <home>/Documents/alivm/khc-server
PYTHONDONTWRITEBYTECODE=1 python3 scripts/p0-verify-20261107.py
# 可覆盖：--vm / --user <ssh-user> / --key <私钥路径> / --domain 203-0-113-10.sslip.io
#        --le-crt / --le-key / --cloudflared / --skip-tunnel
```

脚本自包含：`scp` 上传 0.1.19 包与自身到 VM 新建的 `/tmp/khc-p0v-XXXXXX`，在**单一前台进程**内启动 Agent / Caddy 第二实例 / cloudflared / TLS demo server，全部子进程在 `try/finally` 中按 PID + 进程组回收；报告同时写 VM 上的 `report.txt`，本机用一次短 `ssh cat` 取回，避免长 SSH 流被截断丢证据。所有写盘仅发生在 `/tmp`，不写系统目录。

### 1.2 实测拓扑（方案 A：LE 可信证书 443/8443 + Caddy 反代）

```
curl --noproxy '*' --resolve 203-0-113-10.sslip.io:443:127.0.0.1
  └─ HTTPS :443 / :8443  Caddy 第二实例（admin off / http_port 8080 / auto_https disable_redirects）
       └─ reverse_proxy 127.0.0.1:18881
            └─ khc-agent 0.1.19（/tmp 隔离，profile=system）
                 ├─ KHC_ROOT=<base>/root     KHC_DATA_DIR=<base>/data
                 ├─ --adapters-dir <base>/adapters（合成适配器）
                 └─ --no-live
```

已签 LE 证书（复用前序 P0 实测所签，未重新签发）：

```
subject=CN = 203-0-113-10.sslip.io | issuer=C = US, O = Let's Encrypt, CN = YE2
notBefore=Nov  6 15:24:21 2026 GMT | notAfter=Feb  4 15:24:20 2027 GMT
→ 实测时证书有效、主机名与 sslip.io 域名匹配（故「证书过期 / 不匹配」用独立生成的证书复现，见 §3.4）
```

Caddyfile（第二实例，不改系统 Caddyfile；`sudo -n` 仅为绑定 443/8443 特权端口）：

```caddyfile
{
    admin off
    http_port 8080
    auto_https disable_redirects
}
203-0-113-10.sslip.io:443, 203-0-113-10.sslip.io:8443 {
    tls <既有 LE .crt> <既有 LE .key>
    reverse_proxy 127.0.0.1:18881
}
```

Agent 启动参数（真实 0.1.19 包，`/tmp` 隔离、不注册服务）：

```bash
python3 khc_agent.py run --host 127.0.0.1 --port 18881 \
  --root <base>/root --data-dir <base>/data \
  --token-file <base>/token --adapters-dir <base>/adapters --no-live
# agent.log: "khc-agent 0.1.19 starting (profile=system, data=<base>/data)"
```

**合成适配器**（任务书允许的「不会真正改系统的适配器动作」，仅写 `<base>` 内文件）：
- `p0-noop`：`render()` 返回 `[]` → 真实写动作但零变更、零系统写入；`after_apply` 向 `<base>/exec-counter.log` 计一次内核执行。
- `p0-fail`：`render()` 返回 1 个相对路径 `File`（落在 `KHC_ROOT` 沙箱内），`after_apply` 抛异常 → 触发内核自动回滚；同样计数。

HMAC 签名（与 `AGENTS.md` §8 / `agent/khc/auth.py` 冻结契约一致）：

```
X-Khc-Sig = HMAC-SHA256(token, "METHOD|path|ts|nonce|sha256hex(body)")
X-Khc-Ts / X-Khc-Nonce / X-Khc-Sig；每次请求换新 nonce；path 不含 query；GET body hash 用空串
```

### 1.3 关键原始请求模板

```bash
# 写动作（两次仅改 ts/nonce，body 与 idempotencyKey 完全相同）
curl --noproxy '*' -sS --max-time 20 \
  --resolve 203-0-113-10.sslip.io:443:127.0.0.1 \
  -X POST \
  -H "X-Khc-Ts: <ts>" -H "X-Khc-Nonce: <nonce>" -H "X-Khc-Sig: <sig>" \
  -H 'Content-Type: application/json' \
  --data '{"config":{"note":"p0-verify"},"idempotencyKey":"<同一 key>"}' \
  https://203-0-113-10.sslip.io/apps/p0-noop/apply

# 证书过期 / 主机名不匹配（自签 demo，见 §3.4）
openssl req -x509 -newkey rsa:2048 -nodes -keyout valid.key -out valid.crt \
  -days 1 -subj '/CN=p0-verify.example.test' \
  -addext 'subjectAltName=DNS:p0-verify.example.test'
openssl ca -selfsign -batch -config ca.cnf -keyfile expired.key -in expired.csr \
  -out expired.crt -startdate 20200101000000Z -enddate 20200102000000Z \
  -extensions v3 -notext     # cwd 必须为证书目录（ca.cnf 用 dir = .）
curl --noproxy '*' --cacert valid.crt   https://127.0.0.1:19443/health
curl --noproxy '*' --cacert expired.crt --resolve p0-verify.example.test:19444:127.0.0.1 \
  https://p0-verify.example.test:19444/health
```

---

## 2. 真实输出（最终一轮，`remote_exit=0` / `__RUN_EXIT__:0`）

VM 时间 `Fri Nov 6 17:22:52 UTC 2026`；`[remote_base] /tmp/khc-p0v-xURrR2`。以下为 `report.txt` 原文摘录（数值为 `%{http_code}|%{ssl_verify_result}|%{time_total}`）。

### 2.1 HTTPS 通道与 HMAC 基线

| 检查 | 真实输出 |
|---|---|
| `:443 /health` | `200\|0\|0.046741`　`{"ok":true,"version":"0.1.19"}` |
| `:8443 /health` | `200\|0\|0.046219`　`{"ok":true,"version":"0.1.19"}` |
| 无签名 `/state` | `401\|0\|0.045779`　`{"ok":false,"error":{"code":"unauthorized","message":"missing authentication headers","details":{"missing":["X-Khc-Ts","X-Khc-Nonce","X-Khc-Sig"]}}}` |
| 正确 HMAC `/state` | `200\|0\|0.078217`　`{"ok":true,"host":{"hostname":"ip-172-26-8-31","os":"Debian GNU/Linux 12 (bookworm)","kernel":"6.1.0-53-cloud-amd64","uptime":902635.54,...},"adapters":[{"name":"p0-fail"...},{"name":"p0-noop"...}],"ports":[],"ops":{...},"agent":{...}}` |

`ssl_verify_result=0` 全程成立 → LE 证书被默认信任链校验通过，链路确为「可信证书 HTTPS」。

### 2.2 apply 写动作经 HTTPS 的幂等（任务 1 主项）

| 检查 | 真实输出 |
|---|---|
| apply #1（`idempotencyKey=p0v-idem-6a71dd1d6e59`） | `200\|0\|0.063006`　`{"ok":true,"rev":1,"appliedRev":1,"epoch":null,"changes":[],"result":{"cards":[]},"warnings":[]}` |
| apply #2（**同一 key**，新 `ts`/`nonce`、body 相同） | `200\|0\|0.045742`　`{"ok":true,"rev":1,"appliedRev":1,"epoch":null,"changes":[],"result":{"cards":[]},"warnings":[]}` |
| `[payload_identical]` | `True` |
| `[exec_counter]` | `after_1=1 after_2=1` → **第二次未重复执行** |
| `[idempotency_persisted]` | `True size=380`（`<base>/data/idempotency.json` 落盘） |
| 缺幂等键 | `400\|0\|0.045848`　`{"ok":false,"error":{"code":"idempotency_key_required","message":"写动作必须带 idempotencyKey","details":{"app":"p0-noop","action":"apply"}}}` |
| 不同 key | `200\|0\|0.062808`　`[exec_counter_after_diff_key] 2` → 去重作用域是 `(app, action, key)` |

`agent.log` 佐证：`khc: idempotent replay: p0-noop/apply key=p0v-idem-...`（前一轮同键回放日志）。
代码依据：`agent/khc/kernel.py` `IdempotencyStore.claim()` → `done` 直接回放缓存 / `running` 返回 `202 inProgress` / 异常 `abort(scope)`；`agent/khc/http.py:245-251` 按 `inProgress` 决定 200/202。

### 2.3 失败自动回滚

| 检查 | 真实输出 |
|---|---|
| `[target_before_fail]` | `'ORIGINAL\n'` |
| 失败 apply（`p0-fail`，`after_apply` 抛错） | `500\|0\|0.068072`　`{"ok":false,"error":{"code":"apply_failed","message":"应用失败，已自动回滚：适配器 after_apply 执行失败: P0 synthetic failure to exercise kernel auto-rollback","details":{"app":"p0-fail","stage":"after_apply","rolledBack":true,"cause":{"code":"adapter_error",...}}}}` |
| `[target_after_fail]` | `'ORIGINAL\n'` → **文件已恢复到 apply 前** |
| 同 key 重试 | `500\|0\|0.072505`　同一错误（不是缓存回放） |
| `[exec_counter_final]` | `4`（noop ×2 + fail ×2）→ 失败 key 被 `abort`、允许重试 |
| `idempotency.json` 条目 | 仅 2 条（`p0-noop/apply` 的 K1、K2），回滚 key 不在其中 |

结论：**失败自动回滚生效**，错误信封带 `rolledBack:true` 与 `stage`；失败不写 `appliedRev`；`idem.abort(scope)` 清除 in-progress 记录，同 key 重试会重新执行而非误命中缓存。代码依据 `agent/khc/kernel.py:960-990`（`_restore_backup` + `ApplyFailed`）。

### 2.4 证书过期 / 主机名不匹配报错

生成证书（`openssl x509 -noout -dates -subject`）：

```
[cert_valid]   notBefore=Nov  6 17:22:55 2026 GMT | notAfter=Nov  7 17:22:55 2026 GMT | CN=p0-verify.example.test
[cert_expired] notBefore=Jan  1 00:00:00 2020 GMT | notAfter=Jan  2 00:00:00 2020 GMT | CN=p0-verify.example.test
```

| 检查 | 真实输出 |
|---|---|
| 主机名不匹配（`--cacert valid.crt` 打 `https://127.0.0.1:19443/health`） | `http=000 ssl_verify=1 curl_exit=60`；`curl: (60) SSL: no alternative certificate subject name matches target host name '127.0.0.1'`；body 空 |
| 对照组（正确主机名 + `--resolve`） | `200\|0\|0.005442`　`{"ok":true}` |
| 证书过期（正确主机名，`--cacert expired.crt`） | `http=000 ssl_verify=10 curl_exit=60`；`curl: (60) SSL certificate problem: certificate has expired`；body 空 |
| 真实 LE 证书 + 错误主机名（裸 IP `203.0.113.10:443`，`--resolve` 到本机） | `http=000 ssl_verify=1 curl_exit=35`；`curl: (35) OpenSSL/3.0.22: error:0A000438:SSL routines::tlsv1 alert internal error` |

结论：
- **证书过期**：客户端在 TLS 握手阶段拒绝，`curl (60)` / `ssl_verify_result=10`（`X509_V_ERR_CERT_HAS_EXPIRED`），请求根本到不了 Agent，故无 HTTP 状态码。
- **主机名不匹配**：确定性形态是 `curl (60)` + `SSL: no alternative certificate subject name matches target host name ...`；当服务器（Caddy）对未知 SNI 直接中止握手时，表现为 `curl (35)` + `tlsv1 alert internal error`，同样到不了 Agent。
- 生产口径一致：`apps/api/src/lib/node-client.ts:136-142` `describeChannelError()` 把 cert/tls/ssl 类错误转成人话（「证书校验失败…请改用 HTTP 直连地址或为节点安装受信证书」）；`docs/design-v3.md` §1.1 明确 `fetch()` 与 `cloudflare:sockets` 两条通道均由平台强制校验证书、**无跳过校验开关**。证书到期预警由 `/state` 的 `agent.tls.notAfter` 提供（见 §4.1 备注）。

### 2.5 断隧道错误形态

Quick Tunnel（复用 VM 上既有 `/tmp/khc-p0/cloudflared`，**未安装任何第三方工具**）：

```
[tunnel_host] https://<random>.trycloudflare.com
[tunnel_dns]  public_resolver(8.8.8.8)=203.0.113.18
              （Quick Tunnel DNS 传播需数十秒；未传播时 curl (6) Could not resolve host）
[tunnel_up]   200|0|0.647569   {"ok":true,"version":"0.1.19"}     ← 经 CF 边缘 → Agent /health
[cloudflared_killed] yes (SIGTERM by PID)
[tunnel_down] 530|0|0.109929   body: <!doctype html> ... <title>Cloudflare Tunnel error | <random>.trycloudflare.com | Cloudflare</title> ...
[cf_log_tail] "Initiating graceful shutdown due to signal terminated ..."
              "Connection terminated" / "no more connections active and exiting"
              "Tunnel server stopped" / "Metrics server stopped"
```

结论（可复现 + 明确结论）：
- 断隧道的典型形态 = **HTTP 530 + 非 JSON 的 Cloudflare 边缘错误页**（HTML，不是 Agent 的 `{ok:false,error:{code}}` 信封）；DNS 未传播时先看到 `curl (6) Could not resolve host`（传输层失败，`http=000`）。
- Worker 侧已有对应处理：`apps/api/src/lib/diagnostics/evaluate.ts:227` 把 530 映射为「隧道未连通（530）；cloudflared 可能已断开」；`node-client.ts:149-155` `hasAgentErrorCode()` 判定 HTML 非 Agent 信封；在 §3.8 / ADR-0012 的单方案语义下不再换路，直接 `HubUnreachableError('Hub 不可达（按选定方案接入失败）')`。

### 2.6 Access Service Token 403 —— 占位，未执行

```
[access_403] NOT RUN (placeholder) — missing credentials:
             CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, CF_ACCESS_APP_DOMAIN
```

`<local-volume>/临时文件/测试 VM 信息.md` 只含 4 个 VM 的地址/认证/开放端口、面板登录地址+密码、staging `workers.dev` URL；**没有 Cloudflare 账号凭据、具名隧道配置或 Access Service Token**。按禁令「不要臆造结果」，本轮**未执行、未产出任何 403 结果**；`scripts/p0-verify-20261107.py` 中保留占位段与所需环境变量名、验证命令模板（带/不带 `CF-Access-Client-Id` / `CF-Access-Client-Secret` → 期望 200 / 403 CF Access 错误页）。详见 §5。

---

## 3. P0 结论汇总

| 仍未测项 | 本轮结果 |
|---|---|
| apply 写动作经 HTTPS 的幂等与回滚 | **已测通过**：同 key 第二次为缓存回放、payload 完全一致、`exec_counter 1/1` 无重复执行；缺 key 400；不同 key 重新执行；失败 500 + `rolledBack:true` 且文件恢复 `'ORIGINAL\n'`，`idem.abort` 后同 key 可重试 |
| 证书过期报错 | **已测**：`curl (60)` / `ssl_verify_result=10` / `certificate has expired` |
| 主机名不匹配报错 | **已测**：`curl (60)` / `no alternative certificate subject name matches...`；真实 LE 证书遇未知 SNI 为 `curl (35)` / `tlsv1 alert internal error` |
| 断隧道错误形态 | **已测**：`tunnel_up 200` → kill → `tunnel_down 530` + CF HTML 错误页；DNS 未传播时为 `curl (6)` |
| Access Service Token 403 | **未测（缺凭据）**，脚本留占位，无臆造结果 |
| 失败不切换（需 §3.8 改造） | **不在本轮范围**：§3.8 已由并行代理落地（ADR-0012），见 §4.3；可另行安排验证 |

**范围说明**：本轮 apply 是「本机 → Caddy HTTPS → Agent」的直连写动作（任务书要求的形态），**未经面板 Worker/D1 转发**；面板 Worker 侧真实 `GET /api/v1/nodes/<id>/state`（`reachable:true / route:"direct" / via:"fetch"`）已于 2026-11-07 由前序验证通过（`docs/TODO-2026-11-06.md:101`）。两者互补，本轮补齐了写动作一侧。

---

## 4. P5 三项评估结论（只给结论，不硬造功能）

> 核对对象：`docs/TODO-2026-11-06.md` §2 P5（D1 状态对齐 / 直连观测改协议 / P2 隧道实现）。逐项给出「做 / 不做」与依据，含是否需推翻现有 ADR。

### 4.1 D1 状态对齐（扩展 `/state` 字段 / 补充节点运行时信息）→ **不做（已实现）**

- **已实现**：`agent/khc/state.py:129-139` `build_state()` 已含 `host`（hostname / os / kernel / uptime / load / disk / mem）、`adapters`（name / version / appliedRev / status）、`ports`、`ops`、`agent`（version / serverTime / mode / epoch）；`agent/khc/ops.py` 提供 CPU（核数/型号/使用率/load）、内存/Swap、磁盘（含 inode）、网络（默认路由/DNS/监听端口）、systemd 服务/failed units、Top5 进程、rebootRequired、采集时间；`agent/khc/http.py:224-231` 额外注入 `agent.tls`（`enabled` / `notAfter` / `names`）。实测 `/state` 200 响应已带完整 `host`/`ops`（§2.1）。
- **扩展无需动契约**：`packages/contracts/src/index.ts:425/439/450` 的 `agentOpsSchema` / `agentSelfSchema` / `agentStateSchema` 全部 `.passthrough()`，追加字段向前兼容；`apps/api/src/routes/nodes.ts:234-314` 原样转发 `agentStateSchema.safeParse` 结果；无需改 D1 schema / migration。
- **是否需推翻现有 ADR**：不需要。ADR-0009 / ADR-0010 约束的是「观测轮询的 Worker 配额」，与 `/state` 字段扩展无冲突。
- 遗留**文档**（非代码）小项：`docs/design-v3.md:61` 写「`/state` 新增 `tlsCertExpiry` 字段」，实际字段是 `agent.tls.notAfter`（`http.py` `_CertInfoCache`）；且该字段仅在 Agent 自身 `--tls-cert` 启 TLS 时出现，方案 A 由 Caddy 终止 TLS 时 Agent 不上报。按红线 9a 属文档同步，本轮禁令不改现有 docs，列入 §8 待收口项。

### 4.2 直连观测改协议 → **不做（已由 ADR-0010 拍板落地，且 TODO 自述「可延后」）**

- **现协议已完整**：有可信 HTTPS 域名时浏览器直连 `GET /_live/snapshot?ticket=`（scope=`snap`、TTL 15min、有效期内可复用、CORS 回显 Origin + `Vary`），由 `agent/khc/http.py:43-45,127-159` 在**同一 TLS 控制端口**提供（节点不装 Caddy 也能直连观测）；或由 Caddy `/_live/*` 反代 `127.0.0.1:8899`。无域名时走 Worker `GET /nodes/:id/snapshot` + HMAC 转发 Agent `/snapshot`（单 isolate 2s 去重，尽力而为）。见 `docs/live-observation.md` §8、`apps/api/src/routes/live.ts`。
- **ADR 已拍板**：ADR-0010（主人 2026-11-04 方案 A）定为「可见时 10s 快照轮询 / 隐藏即停 / 10 分钟-60 次上限」，SSE 停用但代码保留；`live-observation.md:185-187` 明确「直连失败…**不会自动回退控制面快照**」。
- **是否需推翻现有 ADR**：改协议必须新 ADR 取代/修订 ADR-0010，并动契约 + 双端 + 前端，属 `AGENTS.md` 红线 1 方案确认门禁；当前无明确痛点、无需求，TODO 原文即标「可延后 / 需与 live observation 协调」。**不做**。

### 4.3 P2 隧道实现（Cloudflared 集成完整实现 / 隧道健康检查 / 自动降级与恢复）→ **不做（自动降级与恢复须推翻刚拍板的 ADR-0012，方向相反）**

- **「Cloudflared 集成完整实现」已具备**：方案 B 是既有能力组合——`docs/design-v3.md` §1.1 line 54/70（节点侧常驻 `cloudflared` 出站、Agent 绑 `127.0.0.1`、`tunnel_endpoint` 填隧道域名、Worker 只连 CF 可信边缘、节点侧零公网入站端口）；D1 有 `tunnel_endpoint` 列（`apps/api/src/db/d1/rows.ts:8`）；P0 方案 B 已实测通过（`docs/TODO-2026-11-06.md:84,97`）。`cloudflared` 是节点侧第三方工具（安装按工作准则需主人明确许可），Worker 侧不需要「集成」它，本轮也只用 VM 上既有二进制、未安装。
- **「隧道健康检查」已有只读形态**：`POST /nodes/probe`（`apps/api/src/routes/nodes.ts:165-230`，用免鉴权 `/health` 探测可达）与诊断映射 `apps/api/src/lib/diagnostics/evaluate.ts:227`「隧道未连通（530）；cloudflared 可能已断开」——本轮实测断隧道 530 与该映射完全一致。若要新增「主动周期性健康检查」属新可观测能力，可单独评估，但**不需要也不应绑定自动切换**。
- **「自动降级与恢复」明确不做**：权威口径 `docs/design-v3.md` §1.1（2026-11-06 修订，**取代 D-3「直连首选 / Tunnel 备用」**）、`docs/security-boundaries.md:9`、以及本分支刚落地并拍板的 **ADR-0012**（2026-11-07 已接受，line 12 / 38-41 / 53 / 62）一致要求：三种方案**并列**、节点创建/配置时**选定其一**、运行时只走该方案、失败即报错、**无主备、无跨方案回退、运行时不改写 `preferred_route`**；ADR-0012 line 62 明写「单方案故障不再自愈…恢复路径是人工改选方案」。工作区代码已按此改造：`node-client.ts:66-78` `orderedRoutes()` 只返回单一目标、`:199-201` 注释「同方案内 fetch→TCP 属双传输通道，不是跨方案回退」、`:323` `const [target] = orderedRoutes(node)`，`onRouteSuccess` 自动回写已删除。
- **是否需推翻现有 ADR**：**是，但强烈不建议**。实现「自动降级与恢复」等于推翻 ADR-0012 与 `design-v3.md` §1.1 / `security-boundaries.md` §1（也会把 ADR-0001 line 21「再失败 → tunnel」这条已被 2026-11-06 修订取代的旧条款重新请回来），并与 ADR-0010「不回退」原则冲突；按红线 1 必须先出方案（≥2 选项 + 推荐）+ 新 ADR 明确取代，还要重做 P0「失败不切换」验证。
- 附带：P0「仍未测」中的「失败不切换（需 §3.8 改造）」现已被并行代理的 ADR-0012 + 代码改造**解封**，可另行安排验证，本轮未纳入。

---

## 5. 未测项与所需凭据

| 未测项 | 缺什么 / 为何未测 | 复现脚本状态 |
|---|---|---|
| **Access Service Token 403 形态** | 需 Cloudflare 账号（域名托管在 CF）+ **具名隧道**（Quick Tunnel 挂不了 Access）+ 隧道入口的 **CF Access 应用** + **Service Token**（`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`）+ Access 保护的主机名（`CF_ACCESS_APP_DOMAIN`）。上述凭据均不在 `<local-volume>/临时文件/测试 VM 信息.md`；且本轮禁令禁止臆造结果、禁止安装第三方工具 | `scripts/p0-verify-20261107.py` §10 与本地收尾段已留占位：缺变量即打印 `NOT RUN (placeholder)`，写明所需 env 与「带/不带 service-token 头 → 200 / 403 CF Access 错误页」命令模板。**未执行、无结果** |
| `caPool` / `originServerName`（方案 C 托管隧道段） | `docs/TODO-2026-11-06.md:85,98-99` 另列的方案 C 未测子项，需托管隧道 + CF 账号凭据；不属 §2 行 102 的「仍未测」清单，本轮未纳入 | 未写脚本，按需另排 |
| **失败不切换** | 原依赖项 §3.8 改造已由并行代理落地（ADR-0012），现已具备验证条件，但属另一批次 | 待主人排期 |
| 面板 Worker 侧真实 **apply** 调用 | 本轮按任务书走「Caddy HTTPS → Agent」直连写动作；未走 Worker/D1 的 `POST .../apps/<app>/apply` 转发路径 | 面板侧真实 `/state` 调用已由前序验证通过（`TODO-2026-11-06.md:101`） |

---

## 6. 进程回收与端口确认

脚本 `finally: cleanup()` 对 Agent / Caddy 第二实例 / cloudflared / 两个 TLS demo server 逐一 `killpg(SIGTERM)`（超时 SIGKILL），并额外注册 `SIGHUP`/`SIGTERM` 处理器保证 SSH 断连时也回收；报告镜像写 `report.txt`。

最终一轮输出：

```
[result] OK — all executed checks complete
[cleanup] all child processes signalled; checking 443/8443
[port_443_8443] NONE
[note] pre-existing listeners 2087/2096 (python3 -m http.server, Nov 4) are NOT ours; left untouched
[cleanup] DONE
[local_port_check] VM:443 -> RELEASED
                  VM:8443 -> RELEASED
```

独立复核（本机 + VM 双路，本机 `ps`/`lsof` 受限故用 `nc -z` + VM `ss -tlnp`）：

```
VM ss -tlnp :443/:8443            → NONE
VM 临时进程（khc-p0v-* / khc_agent.py run / cloudflared tunnel / tls-server.py / caddy run --config）→ NONE
原本系统 Caddy :80                → LISTEN，curl 127.0.0.1:80/ → 200（保留）
pre-existing 2087/2096            → python3 -m http.server（Nov 4，非本次启动，未触碰）
本机 nc -z 203.0.113.10 443/8443 → RELEASED / RELEASED
```

VM `/tmp/khc-p0v-*` 临时目录按禁令**未删除**（不写系统目录、不含任何口令/token）；本机 `HTTP_PROXY` 未改动。

---

## 7. 新增文件清单

| 文件 | 说明 |
|---|---|
| `scripts/p0-verify-20261107.py` | 自包含、可重跑、`finally` 回收全部子进程、仅写 VM `/tmp`、不写系统目录、不回显任何口令/token；含 Access 403 占位段。语法经 `python3 -m py_compile` 校验，连续 3 轮实跑（最后一轮 `remote_exit=0`） |
| `docs/verification/2026-11-07/p0-closeout.md` | 本文件（新目录 + 新文件，按红线 9a 带状态块） |

未改 `docs/README.md` 索引（按主人「统一收口」）。`py_compile` 自身生成的 `scripts/__pycache__/p0-verify-20261107.cpython-313.pyc` 已清理（仅本脚本字节码，非任何既有文件）；残留的空 `scripts/__pycache__/` 目录为 gitignore 项、不含文件。

---

## 8. 需主人 / 收口方补的项（提醒）

1. **`docs/README.md`「工程流程」表登记本文件**（红线 9a 硬性要求；本文件未触碰索引）。建议行：`| P0 收口核验与 P5 评估（2026-11-07） | docs/verification/2026-11-07/p0-closeout.md | apply 幂等/回滚、证书错误、断隧道 530 实测 + P5 三项结论 |`。
2. `docs/TODO-2026-11-06.md` §2 P0「仍未测」与 §2 P5 勾选/结论同步（本轮禁令不改现有 docs）。
3. `docs/design-v3.md:61` 字段名 `tlsCertExpiry` → `agent.tls.notAfter` 的文档同步（见 §4.1）。
4. （可选）`docs/runbook/node-onboarding.md` §4.1 补「断隧道 530 / 证书过期与主机名不匹配」运维排障形态。
5. 若需关闭 Access 403 / `caPool` / `originServerName` 未测项，请补 Cloudflare 账号凭据与具名隧道配置。
6. ADR-0012 与 `node-client.ts` §3.8 改造由并行代理在本分支进行；合入时请把本文件索引登记与 ADR-0012 放同一 PR（ADR-0012 line 8 亦注明索引由并行代理负责）。
