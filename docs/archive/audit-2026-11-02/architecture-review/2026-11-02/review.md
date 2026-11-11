# khc-server 架构专项深度审查（2026-11-02）

> 状态：已归档（历史记录；一次性评估产物，不得作为开发依据，AGENTS.md 红线 9c） ｜ 适用范围：全仓架构（Worker / D1 / Agent / 传输层） ｜ 最后核验：2026-11-03（修复状态复核） ｜ 关联：docs/design-v3.md、docs/engineering/adr/、docs/backup.md、docs/agent-lifecycle.md
>
> 审查方式：以代码为准（关键路径读到实现并标注文件:行号），只读分析，未改代码、未部署、未动生产 D1。测试 VM 只读观察未启用——本次所有结论均可在代码层闭环，无需运行时证据。

## 0.1 修复状态（2026-11-03 复核，feat/server-capabilities 分支）

| 报告条目 | 状态 | 修复位置 |
|---|---|---|
| R1/R3 轮换 overlay 与面板写回时机不一致 | **已修** | `b391be2`（overlay 按 oldPublicKey 对齐；RotationStore 保留 finalized 记录） |
| R2 超时取消不回滚 D1 | **已修（按建议 3 的最小形态）** | `b391be2`（超时保留记录，面板据此一键恢复 D1 旧公钥） |
| T1 路由内无 fetch→TCP 回退 | **已修** | `a00924f`（域名 fetch 失败自动回退 TCP，幂等键/重签名一致）+ `b23d66a`（超时预算、30s 冷却、通道可观测、自签证书人话提示） |
| H3/T3 onRouteSuccess 异常吞成路由失败 | **已修** | `a00924f`（回调内 try/catch，只记日志不影响响应） |
| 债 #2 MASTER_ENC_KEY 无备份要求、D1 无导出 runbook | **已修（文档）** | `docs/backup.md` §7–§8（离线备份 + D1 导出 + 手动轮换 SOP） |
| 债 #1/#5 | 已修（见上 R1/R3/R2） | — |
| 债 #8 节点 token 轮换未实现 | **决策：不做自动轮换**，以手动 SOP 替代 | `docs/backup.md` §8（design-v3 §1.1 的 rotate_token 双窗口不再排期） |
| H2 备份剥离 secrets、R4/R5、T2 明文通道取舍、债 #9 卸载不清轮换、债 #10 audit 膨胀 | **未修**（部分需主人拍板，部分低优先级保留） | — |

---

## 0. 总览

| 主线 | 健康度结论 |
|---|---|
| Hub 端稳健性 | 架构天然可降级（节点自愈、零流量），但 **D1 + MASTER_ENC_KEY 构成不可恢复的单点**，备份路径只覆盖"部分场景可用" |
| Peer 密钥轮换 | 状态机本身扎实（make-before-break + 宽限 + 超时 + 重启恢复），但 **面板 D1 写回时机与 Agent 侧 overlay 假设不一致**，多个部分失败场景会打破"不断线"承诺 |
| 双通道传输 | 路由级切换干净（preferred_route + 幂等键透传），但 **路由内没有 fetch→TCP 回退**（偏离 design-v3 §1.1），且控制通道机密性完全依赖 HMAC 而非传输层 |

---

## 1. Hub 端稳健性

### 1.1 现状机制

- **Worker 无进程状态**：会话是 HMAC 签名 cookie（[session.ts:22-56](../../../apps/api/src/lib/session.ts)），密钥 `SESSION_SECRET`，TTL 8h。Worker 重启 / 发版对会话零影响。
- **登录不依赖 D1**：密码哈希在 env（`ADMIN_PASSWORD_HASH`）；限流三级降级 D1→KV→进程内 Map（[rate-limit.ts:8-45](../../../apps/api/src/lib/rate-limit.ts)），D1 异常不阻塞登录主路径。
- **其余一切依赖 D1**：节点、配置、审计、证书、设置全部走 D1 仓库（[index.ts:12-25](../../../apps/api/src/index.ts)）。D1 抛错落入统一错误处理返回 500 `internal_error`（[app.ts:79-97](../../../apps/api/src/app.ts)），面板全功能不可用。
- **节点侧自愈**：Agent 由 systemd 管理（`Restart=on-failure`, `RestartSec=3`，[khc-agent.service:22-23](../../../agent/khc-agent.service)），设计上"面板关闭时零流量"，Hub 不可达只影响可遥控性，不影响已应用配置的运行。
- **在线状态**：无心跳，`last_seen_at` 只在面板拉 `/nodes/:id/state` 时更新（[nodes.ts:130](../../../apps/api/src/routes/nodes.ts)），5 分钟窗口判在线（[helpers.ts:15-22](../../../apps/api/src/routes/helpers.ts)）。
- **选路写回**：`onRouteSuccess` 只在路由变化时写 D1（[index.ts:13-18](../../../apps/api/src/index.ts)）。
- **加密**：`token_enc`、`app_configs.config_json`（整记录 AES-GCM 密文，[db/d1/apps.ts:16-19](../../../apps/api/src/db/d1/apps.ts)）、`secrets_enc`、certificates、settings 全部用 `MASTER_ENC_KEY` 派生的 AES-GCM（[crypto.ts:9-41](../../../apps/api/src/lib/crypto.ts)）。

### 1.2 风险与失败场景

| # | 风险 | 等级 | 场景与后果 |
|---|---|---|---|
| H1 | **MASTER_ENC_KEY 丢失 = 全部数据不可恢复** | P0（恢复路径） | 该 secret 只存在于 Cloudflare wrangler secret，仓库与备份均不含。D1 导出物是密文，无 key 解不开：节点 token、全部应用配置、WireGuard 私钥、证书私钥、DNS 凭据一起丢失。当前没有任何文档要求备份此 key |
| H2 | **备份导出刻意剥离 secrets，灾备场景断裂** | P1 | [backup.ts:17-39](../../../apps/api/src/routes/backup.ts) 剥离 `privatekey/presharedkey/psk`。全新节点恢复时：① wireguard 的 `interface.publicKey` 保留而 `privateKey` 被剥 → apply 直接被 Agent 拒绝（"publicKey 已有值但缺少 privateKey"，[wireguard.py:715-725](../../../agent/adapters/wireguard.py)）；② 即使手动清掉 publicKey，apply 会重新生成接口私钥 → 服务端身份变化 → 全部 peer 设备失联；③ 节点 token 不在备份内，D1 重建后需逐节点重新注册 token。备份只适用于"目标节点已有密钥"的局部恢复 |
| H3 | **onRouteSuccess 异常被吞成路由失败** | P2 | [node-client.ts:201-205](../../../apps/api/src/lib/node-client.ts)：`onRouteSuccess` 写 D1 失败会落入外层 catch，被当成该路由的传输错误——Agent 已成功返回的请求被误报 `hub_unreachable` 并换路由重试（幂等键保护写动作，但面板会闪错误） |
| H4 | **preferred_route 写回是读-改-写** | P2 | [db/d1/nodes.ts:58-91](../../../apps/api/src/db/d1/nodes.ts) 先 get 再 UPDATE 全字段，与 `last_seen_at` 更新（nodes.ts:130）并发时可能互相覆盖。低频面板下实际概率很小 |
| H5 | **生产=staging 同一 Worker**（ADR-0008） | P2（已决策） | `wrangler.staging.toml` 误用会翻转生产 ENVIRONMENT（AGENTS.md 已记录）。属已拍板取舍，此处仅提示操作风险 |
| H6 | **证书过期面** | P2 | 默认直连 `http://:8880` 无证书问题；Caddy 8443 用 Origin CA（15 年）；cloudflared 隧道证书由 Cloudflare 托管。灰云 acme.sh 证书续期依赖 Hub 上的续期任务，面板不监控其过期（可在 diagnostics 侧补充证书剩余天数检查） |

### 1.3 单点清单

1. Cloudflare 平台（Worker + D1）：平台级故障面板不可用，节点继续运行，可接受。
2. D1（`<d1-name>`）：面板数据唯一副本，依赖 Cloudflare 内部持久性，**用户侧无导出 runbook**。
3. `MASTER_ENC_KEY` / `SESSION_SECRET` / `ADMIN_PASSWORD_HASH`：丢失/轮换的后果分别是 全部数据不可解 / 全部会话失效（可接受）/ 无法登录（重设即可）。

### 1.4 改进建议（低成本、零新依赖）

1. **立即**：在 `docs/engineering/release.md` 增加"secrets 备份"条目——`MASTER_ENC_KEY` 离线保存一份；写一个 `wrangler d1 execute --command ".dump"` 或 `export` 的定时/手动导出步骤（主人手动执行，不新增 Cron）。
2. **备份契约二选一**（需拍板）：
   - a) 维持剥离 secrets，但导出前把 wireguard `interface.publicKey` 一并清空（标记"恢复后需重新生成身份"），并在备份响应中显式列出"恢复后需人工处理项"；
   - b) 增加 `?includeSecrets=1` 的加密全量备份（用登录会话派生密钥加密或直接依赖 HTTPS + 面板下载），灾备可用性换取传输面变大。
3. H3：`onRouteSuccess` 回调内部 try/catch，失败只记日志不影响响应（3 行改动）。
4. H6：`/state` 或 diagnostics 中加证书剩余天数字段（适配器知识，放 certificates/相关适配器）。

---

## 2. Peer 密钥轮换（原子性 / 回滚窗口 / 部分失败）

### 2.1 现状机制（实现与设计基本一致）

- 状态机 `pending → cutover → finalized`，持久化于 `<data_dir>/wg-rotation.json`（0600，[wireguard.py:361-418](../../../agent/adapters/wireguard.py)），Agent 重启后恢复看守（L977、L1522 测试覆盖）。
- `rotate_peer`（L1786-1860）：生成新钥 → `wg set peer <NEW> allowed-ips ""`（旧 peer 一字不动）→ 落记录 → 返回新客户端配置 + 私钥（面板写回 D1，U4 可重复下载）。
- 看守线程 1s 轮询 `latest-handshakes`，新钥握手后把 allowedIps 抢到新 peer（L2046-2059，秒级切换）；宽限 24h；PENDING 7 天超时自动删新 peer（L2034-2039）。
- `cancel_rotation`（L1932-1968）：cutover 态先把 IP 挪回旧 peer 再删新 peer——回滚期间流量不断。
- overlay（L1147-1198）把进行中轮换写进 conf，防 syncconf/重启把新 peer 抹掉（#44）。
- 同一 peer 同时只允许一个轮换（L1819-1825）；`_rotation_lock` + `RotationStore` 文件锁保证并发安全（测试 L1540 覆盖）。

**做得好的**：本地持久化 + 重启恢复、`wg set`/`syncconf` 增量变更（禁止 down/up）、控制通道不走 WG（铁律成立）、finalized 后由 overlay 等 D1 写回再清理记录（设计意图正确）。

### 2.2 发现的缺陷（核心：**面板写回时机与 Agent overlay 假设不一致**）

面板在 `startRotation` 中**立即**把新 publicKey/privateKey 写回 D1（[page.tsx:531-546, 568-570](../../../apps/web/src/apps/wireguard/page.tsx)）。而 `_overlay_rotations` 的 pending/cutover 分支（[wireguard.py:1185-1198](../../../agent/adapters/wireguard.py)）隐含假设"config 里的 peer 仍是旧钥"——它把 config peer 原样保留作为"旧 peer"，再追加一条新钥 peer。

| # | 场景 | 等级 | 失败链与后果 |
|---|---|---|---|
| R1 | **PENDING 期间触发 apply（D1 已写回新钥）** | **P1（高危）** | render→`_resolve_effective`：config peer 携带新钥对（L755-764 校验通过）→ overlay pending 分支输出 **两条相同 PublicKey 的 peer**（一条原 ips、一条空 ips）→ conf 中**旧公钥彻底消失** → `after_apply` 走 `syncconf`（后条覆盖前条，新 peer allowed-ips 可能被清空）+ `_prune_kernel_peers`（L1281-1307）**把内核里的旧 peer 删掉** → 旧设备立刻断流，新设备尚未导入新配置 → **该 peer 完全离线**直至用户导入新配置。直接违反 design-v3 §5.3 "PENDING 期间旧钥流量不中断"。cutover 分支同样产生重复条目。面板未禁用轮换期间的"保存并生效"（[page.tsx:1219,1372](../../../apps/web/src/apps/wireguard/page.tsx) 只挡 dirty/offline）。现有测试 `test_pending_rotation_survives_other_peer_apply_syncconf`（[test_wireguard.py:1497](../../../agent/tests/test_wireguard.py)）**没有覆盖此场景**——它 apply 的 config 不带 publicKey（keystore 供旧钥），恰好落在 overlay 的假设内 |
| R2 | **PENDING 7 天超时自动取消，不回滚 D1** | P1 | tick 超时路径（L2034-2039）只删新 peer + 记录；D1 里已是新钥（rotate 时已写回）。用户手机一直是旧钥 → 下次任何 apply 用新钥渲染 → **旧设备失联**。只有面板手动 cancel（[page.tsx:655-680](../../../apps/web/src/apps/wireguard/page.tsx)）才会把 D1 恢复旧公钥。自动超时 + 面板长期不打开 = 隐性定时炸弹 |
| R3 | **finalized 分支是死代码；auto-finalize 后 D1 分歧无保护** | P1 | `RotationStore._read`（L369-385）过滤掉非 pending/cutover 记录 → overlay 的 finalized 分支（L1175-1184）**永远不可达**。宽限期到自动 finalize（L2062-2069）时 Agent adopt 新钥；若 D1 仍是旧钥（写回失败且用户没回来 confirm），下次 apply 会把内核切回旧钥 → **已换新钥的设备失联** |
| R4 | rotate 响应丢失（网络断） | P2 | 新私钥只在响应中完整给一次，但持久化在记录里（newPrivateKey）。面板拿不到 → 无法重新出二维码（client_config 返回旧钥）→ 用户只能 cancel 重来。可恢复，UX 死胡同 |
| R5 | cancel 回滚依赖旧 peer 仍在内核 | P2 | cutover 态回滚执行 `wg set peer <OLD> allowed-ips ...`（L1950）；若旧 peer 已被 R1 的 `_prune_kernel_peers` 删除，`wg set` 对不存在 peer 的行为未验证，回滚可能失败 |

### 2.3 改进建议（按性价比排序）

1. **R1（推荐方案 A，纯 Agent 侧，~20 行）**：overlay 的 pending/cutover 分支改为按 `record.oldPublicKey` 对齐——当 `peer.publicKey == newPublicKey`（面板已写回）时，用记录里的 oldPublicKey/privateKey 重建"旧 peer"条目，保证 conf 永远同时含新旧两把钥匙。配套补测试：apply 的 config 携带新钥对。
   - 方案 B（面板侧）：写回延迟到 confirm（secrets_enc 先存、publicKey 后改）——改动分散、与 U4 冲突，不推荐。
   - 方案 C（最粗暴）：轮换进行中 Agent 对 apply 返回 409 `rotation_pending`——保护彻底但打断无关变更，体验差。
2. **R3**：`RotationStore._read` 保留 finalized 记录（只跳过已删除的），让 overlay finalized 分支真正生效——D1 写回新公钥后由 overlay 清理记录（该清理逻辑 L1176-1179 已写好，只是读不到）。
3. **R2**：超时路径之外，`/state` 的 rotations 视图加 `timeoutCanceled` 事件残留（或 status 里暴露"上次超时取消的 peer + 新旧钥"），面板据此提示一键恢复 D1 旧公钥；最小实现是 tick 超时后保留记录 24h 并标记 `expired`，面板看到即提示。
4. **R4**：`client_config` 动作支持 `peer + rotation=latest`，从记录取新私钥重新生成配置（私钥本来就在 Agent 本地，只是没暴露读取口）。

---

## 3. 面板控制与浏览器直连：双通道配合

### 3.1 现状机制（角色 / 切换 / 超时）

**三条通路**：

| 通路 | 角色 | 实现 |
|---|---|---|
| Worker→Agent 原生 `fetch()` | 域名 endpoint 的默认传输（自定义端口，compat date 2026-10-01 已满足） | [node-client.ts:173-178](../../../apps/api/src/lib/node-client.ts)，`AbortSignal.timeout` |
| Worker→Agent `cloudflare:sockets` | 裸 IP / 非标端口的**唯一**传输（fetch 对裸 IP 一律 403 error 1003） | [tcp-fetch.ts:113-187](../../../apps/api/src/lib/tcp-fetch.ts)，手写 HTTP/1.1，支持 TLS、chunked、1MiB 上限、单超时覆盖建连+读 |
| 浏览器→Agent SSE（观测层） | 直连 `live_endpoint`（Agent `127.0.0.1:8899`，Caddy 反代），一次性 ticket 由 Worker 签发 | [live.ts](../../../apps/api/src/routes/live.ts)、[khc_agent.py:128-143](../../../agent/khc_agent.py)（live 启动失败仅降级为 warning，不影响控制 API） |

**路由选择**（[node-client.ts:62-71, 144-209](../../../apps/api/src/lib/node-client.ts)）：
- 两条路由：direct（endpoint）+ 可选 tunnel（cloudflared）；`preferred_route` 决定顺序，成功后变化才写回 D1。
- 失败条件：网络异常 / ≥500 / 非 JSON 响应 → 换下一条路由重试（**同一个 idempotencyKey**，Agent 侧去重；每条路由重新签名，新 ts/nonce）。
- 全部失败 → `HubUnreachableError` 502，带每路由错误明细（面板分别展示直连/隧道错误）。

**超时**：state/diagnostics/mode 3s；同步 action 15s（[apps.ts:30](../../../apps/api/src/routes/apps.ts)）；tasks 5s；agent upgrade 10s；默认 10s。

### 3.2 弱网 / 端口被封 / 自签证书 / CF 中间层变更下的行为

- **弱网抖动**：单路由节点（无 tunnel）对瞬时错误没有同路由重试——设计文档说"网络错误重试 1 次"，实现只有"换路由重试"（见 T5）。
- **直连端口被封**：若配置了 tunnel 则自动切换并写回 preferred；未配置则 502 + 明细。符合设计。
- **自签证书**：TCP 路径 `secureTransport:'on'` 未传任何校验参数（[tcp-fetch.ts:122-126](../../../apps/api/src/lib/tcp-fetch.ts)）——cloudflare:sockets 不做证书校验，自签可用（是特性），但也意味着 https-over-TCP 无法防主动 MITM。
- **Cloudflare 中间层变更**：fetch 对域名自定义端口的行为受 CF 政策约束（AGENTS.md 高频坑）。若政策变化导致域名 fetch 失败，**不会**回退到 TCP socket（见 T1），只能依赖 tunnel。

### 3.3 缺陷与改进

| # | 风险 | 等级 | 说明 |
|---|---|---|---|
| T1 | **路由内无 fetch→TCP 回退（偏离 design-v3 §1.1）** | P1 | `chooseTransport`（[tcp-fetch.ts:29-35](../../../apps/api/src/lib/tcp-fetch.ts)）一次性决定：域名必 fetch、IP 必 TCP。设计写明"fetch 适用→先 fetch；否则或失败→TCP socket"。当域名 fetch 因 CF 政策/端口问题失败时，TCP 明明可达却不尝试，直接降级 tunnel/报错。改进：`call()` 里 fetch 传输抛网络错误时，用 tcpFetch 对同一 URL 补一发（仅域名 + 非 443 端口场景），~15 行 |
| T2 | **控制通道机密性依赖 HMAC 而非传输层** | P1（威胁模型需确认） | 默认 `http://IP:8880` 明文（用户拍板）。HMAC 保证完整性/防重放（±60s + nonce 120s，[auth.py:3-11](../../../agent/khc/auth.py)），但被动窃听可见：全部配置 JSON、`rotate_peer` 响应中的**新客户端私钥**。有域名的节点建议引导 https（8443）或 tunnel；无域名 IP 节点维持现状属家庭实验场景的可接受取舍——需主人确认 |
| T3 | onRouteSuccess 异常吞成路由失败 | P2 | 见 H3 |
| T4 | TCP 1MiB 响应上限 | P2 | 超限直接报错（[tcp-fetch.ts:151](../../../apps/api/src/lib/tcp-fetch.ts)）。tasks 通道日志若超 1MiB 会整单失败而非截断——建议 Agent 侧任务日志截断（如保留尾部 256KB）双保险 |
| T5 | 无同路由重试 | P2 | 只读 GET（state/diagnostics）加一次 500ms 级快重试，可显著降低弱网抖动的误报离线 |
| T6 | SSE 观测层与控制通道独立失败 | P2 | live 端口未暴露/反代未配时观测层静默缺失（面板有降级提示）。属已知边界，登记即可 |

### 3.4 结论

路由级 failover 的实现质量高于设计文档承诺（幂等键透传、逐路由重签名、preferred 惰性写回、非 JSON 响应防御都做了）。真正的缺口在**路由内传输回退缺失**与**明文通道的机密性边界未被文档显式声明**。

---

## 4. 其余架构判断点

### 4.1 Agent 生命周期

- **升级**：拉取式 + sha256 + 尺寸上限 + 安全解压 + 版本自检 + 原子 swap + `.prev` 备份 + detached 重启 + 30s 看门狗（[upgrade.py:238-358](../../../agent/khc/upgrade.py)）——链路完整，失败恢复路径明确。健康。
- **卸载/重装一致性**：卸载清 data_dir（keystore/runtime/rotation 丢），conf 保留；重装后 apply 走 `_conf_recovery`（[wireguard.py:1232-1307](../../../agent/adapters/wireguard.py)）从 conf 恢复接口私钥与 peer 公钥映射（P1-A 已落地并有测试）。自洽。
- **缺口**：卸载时**进行中的轮换记录随 data_dir 一起被清**，conf 里 overlay 进去的新 peer 仍在（内核里也在）——之后无人看守，PENDING 永不 cutover 也永不超时。低频但值得在 uninstall 流程里先 cancel 全部轮换（适配器 `uninstall()` 可做，~10 行）。

### 4.2 并发与幂等

- 每 app 一把写锁 + 全局 tasks 锁（[kernel.py:480, 1705-1726](../../../agent/khc/kernel.py)），409 busy；IdempotencyStore **落盘** `idempotency.json`（L469，TTL 600s）——重启后幂等回放仍有效，超出设计承诺。健康。
- nonce 防重放缓存是进程内存（[auth.py:49-85](../../../agent/khc/auth.py)）：Agent 重启后 120s 内的旧 nonce 在 ±60s 签名窗口内理论可重放——窗口极窄且需持有有效签名报文，记为 P2 已知边界即可。
- `ThreadingHTTPServer` + daemon_threads（[http.py:275-276](../../../agent/khc/http.py)）：state 查询不会被长任务阻塞（任务在线程执行器跑）。健康。

### 4.3 数据模型约束

- `app_configs.config_json` 整记录 AES-GCM 密文：安全侧强，但 D1 侧不可局部更新/查询，每次 PUT 全量重写；revisions 同为密文快照，历史完整。可接受（配置体积小）。
- rev 乐观锁（expectRev/appliedRev，409 conflict）按冻结语义实现。健康。
- `nodes.remove` 手动 batch 级联删（[db/d1/nodes.ts:93-102](../../../apps/api/src/db/d1/nodes.ts)），顺序正确。audit 无清理策略（只增）——长期会膨胀，P2。

### 4.4 错误码与降级

- 统一错误信封 + 7 核心诊断码（grep 测试保证无应用名泄漏）；`mode`/`diagnostics` 在节点不可达时仍 200（unknown/降级视图），不写 D1。`HubUnreachableError` 携带逐路由明细。整体**优于**常见水平。
- `hub_unreachable` 502 与 Agent 业务错误的区分清晰（transport 层 vs envelope 层）。

### 4.5 节点 token 轮换：设计有、实现无

design-v3 §1.1 承诺的"双窗口 token 轮换"（rotate_token 动作 + 24h 双 token）**未实现**：全仓 grep `rotate_token` 仅命中设计文档；Agent 侧多 token 能力已具备（`Auth(tokens)`、KHC_TOKEN+文件双源，[khc_agent.py:77-105](../../../agent/khc_agent.py)），Worker 侧没有对应路由。token 疑似泄露时只能手动改 Agent token 文件 + D1。P2，按需排期。

---

## 5. 架构技术债清单（按危害排序）

| # | 债 | 危害 | 修复成本 |
|---|---|---|---|
| 1 | 轮换 overlay 与 D1 写回时机不一致（R1/R3 同根） | 高频路径（apply）× 低频操作（轮换）交叠时 peer 全断，且现有测试未覆盖 | 小（Agent 侧 ~20 行 + 测试） |
| 2 | MASTER_ENC_KEY 无备份要求；D1 无用户侧导出 runbook | 灾难场景全部数据不可恢复 | 极小（文档 + 手动流程） |
| 3 | 备份剥离 secrets 导致全新节点恢复断裂（H2） | 灾备路径名存实亡 | 中（契约变更需拍板） |
| 4 | 路由内无 fetch→TCP 回退（T1） | CF 政策变化时域名节点全量失联（有 tunnel 者除外） | 小 |
| 5 | PENDING 超时自动取消不回滚 D1（R2） | 7 天后隐性定时炸弹 | 小-中 |
| 6 | 明文控制通道 + TCP TLS 不校验证书（T2） | rotate 响应私钥可被被动窃听 | 取舍确认 + 引导配置 |
| 7 | onRouteSuccess 异常吞成路由失败（H3/T3） | 成功请求误报 502 | 极小 |
| 8 | token 轮换未实现（4.5） | 泄露时响应慢 | 中 |
| 9 | 卸载不清进行中轮换（4.1） | 卸载重装后轮换悬死 | 极小 |
| 10 | audit 只增不清 / TCP 1MiB 任务日志上限（T4） | 长期膨胀 / 大日志整单失败 | 小 |

---

## 6. 需要用户拍板的取舍

1. **R1 修复方案**：A）Agent overlay 按 oldPublicKey 对齐（推荐，改动集中）；B）面板延迟写回；C）轮换期间禁 apply。是否授权实施。
2. **备份策略**：维持"剥离 secrets + 显式标注恢复限制"（安全优先），还是增加加密全量备份选项（可用性优先）。
3. **明文控制通道威胁模型**：家庭实验场景是否接受 http:8880 + HMAC（当前默认）；有域名节点是否引导 https/tunnel。
4. **R2 超时回滚的产品形态**：Agent 状态暴露 + 面板一键恢复，还是文档化"超时后手动检查"。
5. **token 轮换（rotate_token）排期**：现在补 Worker 路由，还是接受手动流程。
6. **MASTER_ENC_KEY 离线备份**：确认后补入 release runbook（本轮可直接做，属文档）。

---

## 附：本次审查读取的关键代码

- 传输层：`apps/api/src/lib/node-client.ts`、`tcp-fetch.ts`、`routes/helpers.ts`、`index.ts`
- 轮换：`agent/adapters/wireguard.py`（RotationStore / action_rotate_peer / confirm / cancel / tick_rotations / _overlay_rotations / _persist_rotations / _prune_kernel_peers / _conf_recovery）、`apps/web/src/apps/wireguard/page.tsx`（startRotation / writeBackRotation / cancelRotation）、`apps/web/src/data/wireguard.ts`
- Hub：`app.ts`、`lib/session.ts`、`lib/crypto.ts`、`lib/rate-limit.ts`、`routes/backup.ts`、`db/d1/nodes.ts`、`wrangler.toml`
- Agent：`khc_agent.py`、`khc/http.py`、`khc/kernel.py`（锁/幂等/备份/回滚）、`khc/upgrade.py`、`khc-agent.service`、`install.sh`
- 测试佐证：`agent/tests/test_wireguard.py`（L1497-1557）、`agent/tests/test_package.py`
