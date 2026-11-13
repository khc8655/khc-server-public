# 架构审查与整改计划（arch-review-remediation-2026-11-03）

> 状态：**执行中（2026-11-03 六项决策已全部拍板，见 §5.1；批次 1/2 已上线，批次 3 = rev epoch + 三项决策落地；遗留项已归入 §9 待办表）** ｜ 适用范围：控制面（Worker/D1）、传输层、Agent 内核与 host-ops 的架构评审结论与可执行整改任务 ｜ 最后核验：2026-11-03（补 §9 待办与后续增强；基线 main `087ac82`；vitest 393 项 + Agent 单测 856 项全绿；批次 3 后 verify.sh 复跑全绿） ｜ 关联：`docs/design-v3.md`、`docs/security-boundaries.md`、`docs/backup.md`、`docs/engineering/adr/ADR-0001`、`ADR-0007`、`ADR-0008`、`AGENTS.md` 红线 1/2/9

---

## 0. 这份文档怎么用（给执行 Agent 的交接须知）

1. **本文是计划，不是授权**。§5 的决策项（D-1…D-6）必须先由主人拍板，拍板前只许做"只读确认"和"文档纠正"，不许改代码。
2. **一次 PR 只做一条任务（T-x.y）**，分支名 `feat/` `fix/` `docs/` `chore/` 按 `AGENTS.md` §4 命名；PR 模板照 `.github/pull_request_template.md`。
3. 动到 `apps/api/src/routes/`、`packages/contracts/`、`migrations/`、`agent/khc/` 的任务，PR 描述必须写"为什么必须改核心"（`AGENTS.md` 红线 2）。
4. 每条任务的验收都要求 `./scripts/verify.sh` 全绿；有 UI 改动的附浅/深/390 截图与四态说明（红线 3）。
5. **禁止顺手改无关文件**。发现新问题先记到本文 §4 末尾的"新发现"，不要混进当前 PR。
6. 证据等级标注：**【实测】**＝本次审查跑过代码验证；**【代码】**＝读实现得出结论；**【文档】**＝来自现有文档；**【外部】**＝Cloudflare 平台事实查证（见附录 B）。

---

## 1. 结论摘要

| 维度 | 评价 | 一句话 |
|---|---|---|
| 架构方向 | ✅ 正确 | 控制面/数据面分离、节点被动、配置仓库 + plan/apply/回滚、"控制通道不走 WG"、防火墙 commit-confirmed —— 不要推翻 |
| 稳定性 | ⚠️ 中等偏上 | 有 3 个**实测**缺陷：业务 5xx 被误判为 Hub 不可达（且重复执行写动作）、节点重建/D1 恢复后 rev 冲突导致永久 apply 失败、同步超时重试分支实际失效 |
| 安全性 | ⚠️ 中等 | 控制通道**默认公网明文 HTTP**（无机密性、响应无完整性）；面板是**单因素口令**却握着全节点 root 级能力；另有一处文档与平台事实不符（自签 TLS 在 TCP 通道不可用） |
| 可维护性 | ⚠️ 偏复杂 | 2.3 万行 / 7 适配器 / 三条传输路径；低频单人使用下，复杂度本身即风险 |

**结论**：核心不动，重点整改两件事——**把信任边界补上（传输加密 + 面板强认证）**，**修掉三个稳定性缺陷**。

---

## 2. 审查范围与基线

- 文档：`design-v3.md`、`plan-v4.md`、`security-boundaries.md`、`docs/engineering/adr/*`、`backup.md`、`host-ops.md`、`live-observation.md`、`auto-deploy.md`、`runbook/*`。
- 代码：Worker 全部 `apps/api/src/**`；Agent 全部 `agent/khc/**`、`agent/adapters/**`、`install.sh`、`khc-agent.service`；`packages/contracts`；`.github/workflows/ci.yml`。
- 基线验证：`pnpm test` → 49 files / 393 tests 通过；`python3 -m unittest discover -s agent/tests -t agent` → 856 tests OK。
- 临时探针（已删除，仓库零改动）复现了 §4 中标注【实测】的四条结论，复现方法见附录 A。

---

## 3. 不可动的既有约束（执行时必须保留）

1. **控制通道不走 WireGuard**（`docs/design-v3.md:67`）——任何传输改造都不得让面板依赖节点自身的 WG 隧道。
2. **apply 的原子性契约**：`render → validate → 备份 → 原子替换 → 重启/重载 → 健康检查 → 失败自动回滚`（`agent/khc/kernel.py:849-944`），不得简化。
3. **防火墙 60s commit-confirmed**（`docs/host-ops.md:§5.3`）与 `E_LOCKOUT` 保护行，不得移除。
4. **幂等键跨路由复用**（`apps/api/src/lib/node-client.ts:183-236` + Agent `idempotency.json`），修 5xx 分类时不得破坏。
5. **核心冻结**：适配器/页面之外的改动必须说明必要性；不得把应用知识写进 `agent/khc/` 或 `lib/diagnostics/*`（`AGENTS.md` 末尾"编排层例外"）。
6. **发布包签名清单 + 拉取式升级 + `.prev` 回滚**（`agent/khc/upgrade.py`、`apps/api/src/lib/agent-releases.ts`）。

---

## 4. 问题清单

### 4.1 P0（安全底线，必须先做）

| ID | 问题 | 证据 | 影响 |
|---|---|---|---|
| **S-1** | 控制通道默认 `http://IP:8880` 明文，Agent 监听 `0.0.0.0`；HMAC 只签请求、**不签响应** | 【代码】`apps/api/src/lib/node-client.ts:104-122`（仅请求签名）、`agent/khc/auth.py:143-156`、`agent/khc_agent.py:53`、`agent/khc/http.py:306-340` | ① 被动窃听：WireGuard 客户端私钥（`agent/adapters/wireguard.py:217`）、证书私钥与 DNS 凭据（`apps/api/src/routes/apps.ts:198-203` 解析 `$cert/$dnsCred` 后发送）② **主动中间人可替换响应**：客户端配置/二维码里的 `Endpoint`/`PublicKey` 被换掉 → 用户导入攻击者的 VPN ③ 响应无完整性，无法察觉代理层篡改 |
| **S-2** | 面板单因素口令 + 8h 无状态会话，却是全节点总闸门 | 【代码】`apps/api/src/routes/auth.ts:38-66`、`lib/session.ts:3-4`、`lib/password.ts:3`（PBKDF2 100k，平台上限【外部】） | 口令泄露 = 所有节点 token 泄露（`routes/agent_lifecycle.ts:73-103` 明文返回 token）= 全部主机 root 级控制；无二次验证、无登录审计、限流仅按 IP |
| **S-3** | 文档声称"自签 TLS 可用"与平台事实相反 | 【文档】`docs/runbook/node-onboarding.md:87`、`docs/runbook/troubleshooting.md:14`、`apps/api/src/lib/tcp-fetch.ts:120-126`；【外部】Cloudflare `cloudflare:sockets` TLS 模式强制校验证书，无 `rejectUnauthorized:false` | 用户以为开了 `--tls` 就安全，实际握手失败或根本未启用；误导安全判断 |

### 4.2 P1（稳定性，实测确认）

| ID | 问题 | 证据 | 影响 |
|---|---|---|---|
| **R-1** | Agent 业务 5xx（`apply_failed`/`adapter_error`/`command_failed`/`internal_error`）被真实客户端当作传输失败：丢弃响应体、换路由重试 | 【实测】见附录 A-1；【代码】`node-client.ts:312-315` vs `agent/khc/util.py:118-131` | ① 用户看到"Hub 不可达"而非"应用失败，已自动回滚：<真实原因>"，与 `troubleshooting.md:74` 的承诺相反；② 配置了隧道的节点上，同一写动作会被**执行两次**（Agent 失败时 `idem.abort()`，重试命中不了缓存，`kernel.py:617-620`） |
| **R-2** | 节点重建 / D1 时点恢复后，Worker 的 rev 从 1 重新计数，Agent 记住的 `applied_rev` 仍很高 → 永久 409 | 【实测】见附录 A-2；【代码】`agent/khc/kernel.py:801-808`、`apps/api/src/db/d1/apps.ts:68-97`、`db/d1/nodes.ts:93-101` | `docs/backup.md:§8` 的 token 轮换 SOP（删节点→重建→导入→逐项 apply）卡在第 ⑥ 步；D1 Time Travel 回滚后同样卡死。对不熟 Linux 的用户等于恢复流程失效 |
| **R-3** | `callWithSyncPoll` 用中文字符串匹配判断超时（`timeout/timed out/超时`），真实客户端 message 恒为"Hub 不可达（直连与隧道均失败）" | 【实测】见附录 A-3；【代码】`apps/api/src/routes/apps.ts:107-117` | 慢 apply 在 TCP 回退不可达时直接报失败，Agent 实际已成功 → D1 `applied_rev` 不更新，面板长期显示"有未应用的改动" |

### 4.3 P2（安全加固与可靠性）

| ID | 问题 | 证据 | 建议方向 |
|---|---|---|---|
| A-1 | 无任何安全响应头（CSP / frame-ancestors / HSTS / nosniff） | 【代码】`apps/api/src/app.ts:71-79` 仅改 Cache-Control | 加 `frame-ancestors 'none'`、`X-Content-Type-Options`、HSTS |
| A-2 | 服务端不校验 `content-type` 与 `Origin`，CSRF 只靠 `SameSite=Lax` | 【实测】附录 A-4：`POST /nodes` 带 `text/plain` 仍 201 | 写请求校验 Origin + 强制 JSON；同注册域下的站点属 same-site，Lax 挡不住 |
| A-3 | `/api/v1/agent/releases` 未鉴权 | 【实测】附录 A-4：无 cookie 返回 200 | 改为 `/api/v1/*` 默认鉴权 + 白名单（login/health/version） |
| A-4 | live 观测层 Origin 校验默认关闭 | 【代码】`agent/khc_agent.py:129`、`live.py:132-135`；`install.sh` 从未设置 `KHC_LIVE_ORIGINS`/`KHC_NODE_ID` | install.sh 渲染面板域名进 unit |
| A-5 | Agent 升级的签名清单校验只在 Worker 侧，Agent 只验 https+sha256 | 【代码】`agent/khc/upgrade.py:184-220` vs `apps/api/src/lib/agent-releases.ts` | 若要端到端保证，Agent 内置公钥自验清单 |
| A-6 | host-ops 的"Hub 失陷也拿不到 shell"不成立：`cron.set` 可写任意 crontab 行、`keys.add` 可加任意公钥，且对 Peer 开放 | 【代码】`agent/adapters/host_ops/khc_host.py:116-134`、`:1836-1847`、`keys_add_verb` | 限 `target=self`，或 Peer 侧本地 opt-in 开关文件（Hub 不可远程覆盖） |
| A-7 | systemd 沙箱可写 unit 目录 / cron.d / root `.ssh`，且 Agent 以 root 运行 | 【代码】`agent/khc-agent.service:36-40` | 沙箱防误写不防越权；文档不得当作安全边界；可把 unit 目录收窄到 `khc-*` 前缀 |
| A-8 | 写锁是 per-app，文档写的是 per-node | 【代码】`kernel.py:1799-1805` vs `design-v3.md:§2.2` | 改 per-node 串行 |
| A-9 | 任务状态只在内存 | 【代码】`agent/khc/tasks.py:143-175` | 与 `upgrade.json` 一样落盘，重启后可查 |
| A-10 | 无任何可观测性配置 | 【代码】`wrangler.toml` 无 `[observability]` | 打开 Workers Logs |
| A-11 | 加密无 key-id / 无 AAD | 【代码】`apps/api/src/lib/crypto.ts:20-41` | 加 `enc:v2:<keyId>:` 前缀，为轮换留路径 |
| A-12 | 备份刻意剥离私钥，换机恢复后 WG 身份会变 | 【代码】`routes/backup.ts:17-39`；【文档】`backup.md:§1` | 至少 UI 明确"恢复后需重生成接口密钥并重新下发 peer 配置" |

### 4.4 P3（低优先，记录在案）

| ID | 问题 | 证据 |
|---|---|---|
| B-1 | `tcp-fetch` chunked 解析按"字符"切"字节"（chunk size 是字节） | `apps/api/src/lib/tcp-fetch.ts:37-51`；Agent 总带 Content-Length，故当前未炸 |
| B-2 | `nodes.update()` 读-改-写全字段，与并发 PATCH 可能互相覆盖 | `db/d1/nodes.ts:58-91` + `routes/nodes.ts:149` |
| B-3 | `D1AppConfigRepo.put()` 的 `rev=max+1` 非原子（batch 内 PK 冲突会整体失败） | `db/d1/apps.ts:68-97` |
| B-4 | Python ≥3.11 硬门槛（Ubuntu 22.04 自带 3.10 会 FAIL） | `agent/install.sh:153,309` |
| B-5 | `HttpAgentClient` 每请求新建，`cooldown` Map 不跨请求生效 | `apps/api/src/index.ts:12-18` + `node-client.ts:158` |
| B-6 | Agent 单测/Worker 测试用 `FakeAgentClient`，绕过了真实客户端的 5xx 分类逻辑（R-1 因此漏网） | `apps/api/test/helpers/context.ts:14-40` |

### 4.5 新发现（执行批次一并补充）

| 日期 | 发现 | 处置建议 |
|---|---|---|
| 2026-11-03 | S-3 的错误口径除已列三处外，还残留在 Agent 侧两处：`agent/khc/http.py:319-320` docstring（"自签可用：控制面 IP 直连走 cloudflare:sockets，不做证书校验"）与 `agent/tests/test_http.py:389` 注释（"自签：控制面也不校验证书"）。均为注释/docstring，无逻辑影响 | 属 Agent 代码，本批（batch1，不出包）不改，避免触发 CI 版本一致性检查与出包；建议随下一个涉 Agent 代码的批次一并纠正，口径同 T1.3 |
| 2026-11-03 | T1.3 引用的 `tcp-fetch.ts:120-126` 行号有偏移：该文件实际不含"自签可用"表述，头部注释原本未提证书校验——第三处是**补写**正确口径而非改错 | 已按 T1.3 意图在头部注释补写，无实际差异 |
| 2026-11-03 | 【实测】`install.sh`/`uninstall.sh` 存在 locale 相关隐患：UTF-8 locale（含 macOS bash 3.2、C.UTF-8）下 bash 把 `$PROFILE，`（变量名后紧跟全角逗号等多字节字符）解析为**一个未定义变量名**，`set -u` 直接报错退出——`--check` 与安装主路径均受影响；C locale 下正常，故真机（root 无 LANG）一直没炸。已随 T4.4 一并修复（受影响处全部改 `${VAR}`）。**T4.14 执行时发现 `scripts/install-preflight-test.sh` 同样中招**（`$label（` 同款），verify.sh 因 C 掩护未暴露；已一并修复（30/30 复跑通过） | 已修复；A-4 的 install.sh 渲染测试在 UTF-8 locale 下即回归用例 |
| 2026-11-03 | T4.11 顺带项"unit 目录收窄到 `khc-*` 前缀"**评估后不做**：`ReadWritePaths` 是目录级权限、无法按文件名前缀过滤；`khc-forward-*.service`/`khc-fw.service` 必须位于标准 unit 目录（`/etc/systemd/system`）才能被 `systemctl enable` 加载，改专属子目录需引入 `systemctl link` 等非小改，不满足"改动小且可测"门槛 | 已把该结论与沙箱定位（防误写，不构成对越权代码的边界）写入 `docs/security-boundaries.md` §2/§3，代码级 `khc-*` 白名单（port-forward/host-ops/cron）为实际边界 |
| 2026-11-03 | 批次 3 T2.2 执行时发现 `docs/design-v3.md` §2.3 的迁移登记表漏了 `0006_rate_limit.sql`（批次 2 加表时未同步该表，docs/README.md 索引无恙） | 已在 T2.2 同批补登（含 0007 行），文档登记完整 |

---

## 5. 需要主人拍板的决策

| ID | 决策 | 选项 | 推荐 |
|---|---|---|---|
| **D-1** | 面板强认证 | (a) Cloudflare Access 前置（免费额度够用，SSO/OTP/硬件密钥，零代码）(b) 面板内加 TOTP（要写代码 + 密钥管理）(c) 维持单口令 + 20 位随机串 | **a**，口令作第二因素；同时处理 `wrangler.toml` 的 `workers_dev = true`（Access 只挂自定义域名时它是绕过路径） |
| **D-2** | R-2 的修法 | (a) **rev epoch**：apply 请求带控制面 epoch（nodeId 或独立字段），Agent 侧 epoch 变化即归零 `applied_rev`（契约改动，恢复全自动）(b) 导入时把 rev 起点设为 Agent `/state` 的 `appliedRev`（Agent 不在线时不成立）(c) 面板加"重置该应用 rev"按钮（要人点） | **a**；契约改动需登记 `packages/contracts` + `docs/design-v3.md` §2 |
| **D-3** | 控制通道加密方案 | (a) **Cloudflare Tunnel 为首选**（Agent 绑 127.0.0.1，零入站端口，TLS 由 CF 托管，隧道入口加 Access Service Token）(b) 真证书 HTTPS 端点（Let's Encrypt / IP 证书，Worker 走 fetch 或 TCP+TLS）(c) 两者并存：Tunnel 首选 + 真证书直连兜底 | **c**（已有 `tunnel_endpoint` + `preferred_route` 选路，改动最小；国内节点若 Tunnel 不稳可只走 b） |
| **D-4** | 是否加响应 HMAC | (a) 加（`HMAC(token, nonce|status|sha256(body))`，防代理/中间人篡改响应）(b) 不加（认为 TLS 已够） | **a**，成本约 30 行，作为传输加密之外的纵深 |
| **D-5** | host-ops 危险动词（A-6） | (a) 保留现状，接受"Hub 失陷 = Peer 失陷"，并**改 ADR-0007 与 `docs/host-ops.md` 的说法** (b) `cron.set` / `keys.add` 仅允许 `target=self` (c) Peer 侧本地开关文件 opt-in（Hub 不可远程覆盖，最安全但要多一步人工） | 先做 **(a) 文档如实化**（当天可完成），(c) 作为后续增强 |
| **D-6** | 生产/预发 | (a) 维持 ADR-0008（main 推送即生产）(b) 用 Workers 版本 + preview URL 做上线前冒烟（无新资源） | **b**，成本低；顺带删除 `wrangler.staging.toml` 脚枪（ADR-0008 已提"待拍板"） |

### 5.1 拍板记录（2026-11-03，主人六项全部拍板）

| ID | 拍板结果 | 落地情况 |
|---|---|---|
| **D-1** | **暂缓**——不上 Cloudflare Access，改用**面板 TOTP**，等开发稳定后再上；`workers_dev` 处置一并推后。理由：现在上会让测试变麻烦 | 未动（T1.1 挂起；后续按"面板 TOTP"另立任务） |
| **D-2** | **做**——采纳方案 (a) rev epoch（节点记录带纪元，重建/恢复时换新值，Agent 发现不一致即重置基线） | 批次 3 已完成（T2.2，feat/rev-epoch：迁移 0007 + contracts + Worker + Agent 内核，兼容现役 0.1.12 三态验证） |
| **D-3** | **口径**——只改文档与引导，不新增实现：**公网可信证书直连首选，cloudflared Tunnel 备用**（国内 VM 受备案/端口限制时） | 批次 3 已完成（四文档统一口径，node-onboarding §4.1 为准） |
| **D-4** | **不做**——TLS 已足够，不加响应 HMAC（T3.3 取消；理由：可信证书直连/Tunnel 备用落地后，传输已有 TLS 完整性保障，30 行 HMAC 属冗余纵深） | 未动（T3.3 关闭，不再列任务） |
| **D-5** | **先只改文档，不做能力收窄**——"Hub 失陷也拿不到 shell"改为如实表述（拿不到交互式 shell，但白名单动词 `cron.set`/`keys.add` 可被滥用）；收窄范围列为待办 | 批次 3 已完成文档如实化（T4.6：ADR-0007 复核补记 + host-ops.md §0.1）；收窄（`target=self` 或 Peer 本地 opt-in）列为待办，等后续拍板 |
| **D-6** | **已完成（2026-11-03，chore/remove-staging-toml）**——`wrangler.staging.toml` 已删除；冒烟路径改为 `npx wrangler versions upload` + 预览 URL（已实测，报告 §20）。配置唯一来源 `wrangler.toml` | 已落地：release.md §4（新流程）、testing.md §3/§4、auto-deploy.md、production-readiness.md、ADR-0008 补记、README/AGENTS 同步；CI 仍 `wrangler deploy` 即生产 |

---

## 6. 任务分解

> 每条任务都可独立成 PR。带 🔒 的必须等对应决策拍板。

### 批次 T1：安全底线（不需要改业务代码）

**T1.1 🔒 Cloudflare Access 前置（D-1）**
- 目标：面板访问先过 Access（邮箱 OTP 或 SSO），口令作为第二因素。
- 步骤：Access Application 绑定面板自定义域名 → 策略仅允许主人邮箱/IdP → 处理 `workers_dev`（关闭或同样挂 Access）→ 若关闭，CI 的 `Verify deployed agent package` 步骤（`.github/workflows/ci.yml` 用 workers.dev URL 校验）需改走自定义域名。
- 验收：未登录 Access 直接访问域名被拦；Access 放行后仍要求面板口令；CI 部署步骤通过。
- 禁止：把 `MASTER_ENC_KEY`/`SESSION_SECRET` 挪进任何前端可见位置。

**T1.2 Workers Logs**
- 改动：`wrangler.toml` 增 `[observability] enabled = true`（按当前 Cloudflare 文档写法）。
- 验收：部署后 Workers 控制台可见调用日志；`./scripts/verify.sh` 不受影响。

**T1.3 文档纠正：自签 TLS（S-3）**
- 改动：`docs/runbook/node-onboarding.md:87`、`docs/runbook/troubleshooting.md:14`、`apps/api/src/lib/tcp-fetch.ts` 头部注释——统一改为"TCP 通道的 TLS 由平台强制校验证书，自签不可用；必须使用公网可信证书（含 IP 证书），否则退回 HTTP（仅限可信网络）或改用 Tunnel"。
- 验收：三处口径一致；`docs/security-boundaries.md` 若有相关表述一并核对。

### 批次 T2：稳定性缺陷（代码）

**T2.1 修 R-1：5xx 分类**
- 改动点：`apps/api/src/lib/node-client.ts` 的 `call()`——仅当"连接层失败"或"5xx 且 body 不是合法 Agent 信封"时换路由；body 含 `error.code` 时按普通响应返回（交给 `routes/apps.ts:222-227` 的 400/5xx 分支处理）。
- 必须新增回归测试：**用真实 `HttpAgentClient`**（注入 fake fetch）覆盖 `apply_failed` 500，断言返回响应而非抛 `HubUnreachableError`；再断言隧道场景下只调用一次。
- 验收：`pnpm test` 全绿；`docs/runbook/troubleshooting.md:74` 的承诺变成事实。
- 禁止：改动幂等键透传与重签名逻辑（`node-client.ts:183-236`）。

**T2.2 🔒 修 R-2：rev epoch（D-2）**
- 契约：`packages/contracts` 的 apply payload 增 `revEpoch`（或复用 `nodeId`，需在 PR 里说明选择）；同步 `docs/design-v3.md` §2.1/§2.2。
- Worker：`routes/apps.ts` 的 apply / rollback 带上 epoch。
- Agent：`kernel.py` 的 `StateStore` 记录 epoch；epoch 变化时把该 app 的 `applied_rev` 归零后继续。
- 测试：Agent 单测（epoch 变化 → apply 成功 + `appliedRev` 从 1 起）；Worker 单测；**新增**"删除重建节点后 apply 成功"的集成用例。
- 验收：附录 A-2 的复现脚本改成"期望 ok"。

**T2.3 修 R-3：超时判定**
- 改动点：`apps/api/src/routes/apps.ts:107-117` 改为按错误类型/`routeErrors` 标记判断（如给 `HubUnreachableError` 加 `timedOut: boolean`），不再匹配中文串。
- 测试：复用 T2.1 的真实客户端注入，断言超时会进入重试循环、非超时立即抛出。
- 验收：`SYNC_DEADLINE_SECONDS`（Agent 12s）与 Worker 15s 预算的余量在代码注释里写明。

### 批次 T3：传输层加密（需 D-3）

**T3.1 真证书 HTTPS 端点可通（先做，风险最低）**
- 内容：选 1 台节点，用现有证书适配器签发（DNS-01 或 IP 证书）→ Agent/Caddy 同端口 HTTPS → 节点 `endpoint` 改 `https://`。
- 验收：`/state` 通过；**并额外验证自签证书确实失败**（作为 T1.3 的实证）。
- 禁止：为通过验证而在 Worker 侧放宽证书校验。

**T3.2 Tunnel 化（首选路径）**
- 内容：`cloudflared` 常驻出站 → Agent 绑 `127.0.0.1` → 节点 `tunnelEndpoint` 填隧道域名 → `preferred_route` 设 tunnel → 隧道入口挂 Access Service Token。
- 代码：`install.sh` 增 `--tunnel` 选项（渲染 unit 的 `--host 127.0.0.1` 与 tunnel 相关环境变量）；文档更新 `docs/install.md`、`docs/runbook/node-onboarding.md`。
- 验收：公网直接访问 `<域名>:8880` 不可达；面板经隧道完成 `/state` + apply；断隧道时按 `preferred_route` 回退直连（两端都加密）。

**T3.3 🔒 响应 HMAC（D-4）**
- 契约：响应头加 `X-Khc-Resp-Sig = HMAC(token, nonce|status|sha256(body))`（nonce 取自请求）。
- Agent：`khc/http.py` `_send_json` 统一加签；Worker：`node-client.ts` 校验，失败即视为通道异常。
- 验收：单测覆盖正常/篡改/缺头三种；老版本 Agent 无该头时按"降级告警不阻断"处理，并在 `docs/agent-releases.md` 记录版本门槛。

### 批次 T4：加固与清理（可并行）

| 任务 | 内容 | 验收要点 |
|---|---|---|
| **T4.1** A-1 | `app.ts` 静态资源分支统一加安全头（`frame-ancestors 'none'`、`X-Content-Type-Options: nosniff`、HSTS） | 头存在；深/浅主题页面无回归（截图） |
| **T4.2** A-2 | 写请求校验 `Origin`（或 `Sec-Fetch-Site`）+ 强制 `content-type: application/json` | 附录 A-4 的两条探针用例变成"被拒绝"；同源前端不受影响 |
| **T4.3** A-3 | `/api/v1/*` 默认鉴权 + 白名单（login/health/version） | 未登录 `/agent/releases` 返回 401 |
| **T4.4** A-4 | `install.sh` 渲染 `KHC_LIVE_ORIGINS`（面板域名）与 `KHC_NODE_ID` | 未知 Origin 的 SSE 被 403；面板实时观测仍正常 |
| **T4.5** A-5 | Agent 内置发布公钥，自验签名清单 | 自建包被 Agent 侧拒绝；正常升级通过 |
| **T4.6** 🔒 A-6 | 按 D-5 执行；**无论选哪个都要改** `docs/host-ops.md:§0` 与 `ADR-0007` 的"Hub 失陷也拿不到 shell"表述 | 文档不再作错误承诺；若有行为改动附单测 |
| **T4.7** A-8 | 写锁改 per-node | 并发 apply 不同 app 时第二个返回 `409 busy`；现有 app 内串行测试仍绿 |
| **T4.8** A-9 | 任务状态落盘（与 `upgrade.json` 同风格） | 重启后 `/tasks/:id` 仍可查；过期清理有上限 |
| **T4.9** A-11 | 密文加 `enc:v2:<keyId>:` 前缀（兼容旧无前缀行） | 新旧数据可读；轮换 SOP 更新到 `docs/backup.md:§8` |
| **T4.10** A-12 | 备份恢复说明：UI + `docs/backup.md` 明写"恢复后需重生成接口密钥并重新下发 peer 配置" | 文案一致 |
| **T4.11** A-7 | `docs/security-boundaries.md`：沙箱定位改为"防误写，不构成对越权代码的边界" | 措辞与 `khc-agent.service` 实际白名单一致 |
| **T4.12** B-1 | `tcp-fetch` 的 chunked 解析改为按字节（`Uint8Array`） | 新增中文多字节 chunked 用例 |
| **T4.13** B-2/B-3 | `nodes.update` 改单列 UPDATE；`put()` rev 用单语句原子递增（或唯一约束重试） | 并发测试 |
| **T4.14** B-4 | `docs/install.md` 明写 Python ≥3.11 与 Ubuntu 22.04 的处置方式 | 文档 + `install.sh --check` 提示文案 |
| **T4.15** B-6 | 增加"真实客户端"测试夹具，后续传输层测试默认用它 | 至少 T2.1/T2.3 使用 |

---

## 7. 执行顺序与依赖

```
T1.3（文档纠正）─┐
T1.2（日志）─────┤  可立即并行
T2.1 ─ T2.3（同一真实客户端夹具，建议一人连做）
T2.2 🔒 ← 依赖 D-2 拍板
T3.1 → T3.2 ← 依赖 D-3；T3.1 也会产出 S-3 的实证
T3.3 🔒 ← 依赖 D-4，建议在 T3.2 之后（有 TLS 再加签名是纵深）
T4.* ← 与上面无依赖，可并行；T4.2/T4.3 建议先做（改动小、收益直接）
T1.1 🔒 ← 依赖 D-1，**建议最早做**（最高性价比）
```

**建议排期**：T1.1 + T1.3 + T2.1 + T2.3 为第一批（1–2 天）；T2.2 为第二批；T3 为第三批；T4 按需滚动。

---

## 8. 统一验收基线

- `./scripts/verify.sh` 全绿（typecheck / vitest / build / compileall / Agent 单测 / 发布一致性 / shell 语法）。
- UI 改动：浅/深/390 截图 + 四态（空/加载/错误/离线）说明，PR 模板 UI 自检清单逐项勾选。
- 契约/核心改动：`packages/contracts` 与 `docs/design-v3.md` 同步；PR 写明必要性。
- 文档改动：头部状态块 + `docs/README.md` 索引登记（红线 9a）；被取代的文档 `git mv` 入 `docs/archive/` 并改状态块。
- 行为变化：同 PR 更新 `CHANGELOG.md`。

---

## 附录 A：复现脚本（本次审查用过，可原样重跑）

> 均在工作区外创建临时探针；跑完删除，仓库保持零改动。需要把 `vitest` 的 `cloudflare:sockets` 别名指向 `apps/api/test/helpers/sockets-stub.ts`。

**A-1 / A-3 真实客户端对 5xx 与超时的行为**

```ts
const APP_500 = { ok: false, error: { code: 'apply_failed', message: '应用失败，已自动回滚：caddy validate 失败' } };
const client = new HttpAgentClient(async () => new Response(JSON.stringify(APP_500), { status: 500 }), undefined, async () => { throw new Error('no tcp'); });
await client.call(node, 'tok', 'POST', '/apps/caddy-site/apply', { config: {} });
// 实测：抛 HubUnreachableError，message='Hub 不可达（直连与隧道均失败）'，routeErrors={direct:'HTTP 500'}
// 带 tunnelEndpoint 时：直连与隧道各被调用一次（写动作重复执行）
```

**A-2 节点重建后 rev 回退**

```python
kernel._apply(adapter, {"expectRev": 12, "config": {...}, "idempotencyKey": "k12"})  # applied_rev=12
kernel._apply(adapter, {"expectRev": 1,  "config": {...}, "idempotencyKey": "k1"})
# 实测：409 conflict: expectRev 落后于已应用版本: expect=1, applied=12
```

**A-4 鉴权与 content-type**

```ts
await ctx.app.request('/api/v1/agent/releases', { method: 'GET' }, ctx.env);      // 实测 200（应 401）
await ctx.app.request('/api/v1/nodes', { method:'POST', headers:{ cookie, 'content-type':'text/plain' }, body: JSON.stringify({...}) }, ctx.env); // 实测 201（应 400）
```

---

## 附录 B：外部查证来源

1. Cloudflare Docs — TCP sockets（`connect()` / `secureTransport` / `startTls`；TLS 校验证书，无关闭开关）。
2. `workers-unsafe-https`（npm）：明确写"Cloudflare 内置 fetch / node:https / node:tls / cloudflare:sockets TLS 模式always validate the server certificate，不支持 rejectUnauthorized:false"。
3. Cloudflare Community + HN：Workers 运行时 PBKDF2 迭代上限 100,000（超限 `NotSupportedError`）。
4. Cloudflare Docs — D1 Time Travel：可回滚 7 天（Free）/ 30 天（Paid）。
5. Cloudflare Docs — Workers VPC Services（open beta）：Tunnel 后接私有服务、支持 Cloudflare Origin CA，可作为 Tunnel 方案的进阶选项（当前不建议作为主路径，因仍在 beta）。

---

## 附录 C：本次已排除的假设（避免后续 Agent 重复论证）

| 假设 | 结论 |
|---|---|
| "cloudflare:sockets 不做证书校验，自签 TLS 可用" | **错误**（与平台事实相反），见 S-3 / T1.3 |
| "Worker 测试全绿 ⇒ 传输层逻辑正确" | **不成立**：`FakeAgentClient` 绕过了真实客户端，R-1 正是漏在这里（B-6 / T4.15） |
| "HMAC 签名 ⇒ 通道安全" | 只覆盖请求的完整性与防重放；**无机密性、无响应完整性**（S-1） |
| "host-ops 白名单动词 ⇒ Hub 失陷拿不到 shell" | **不成立**：`cron.set` 等价任意 root 命令、`keys.add` 等价任意公钥登录（A-6） |
| "D1 + MASTER_ENC_KEY 是单点" | 成立，但已有 `docs/backup.md:§7` 的离线备份 SOP + D1 Time Travel；本次不重复提 |

---

## 9. 待办与后续增强（2026-11-03 主人同意挂账）

> 本节只登记**尚未开工**的遗留项，供后续接手 Agent 一眼看到；不是授权，开工前仍按 §0 与 `AGENTS.md` 红线 1 先给方案、等主人拍板。

| 项 | 内容 | 触发条件 / 前置 | 现结论与理由 |
|---|---|---|---|
| **面板强认证（原 D-1）** | 改用**面板内 TOTP**（替代 Cloudflare Access 前置的方案） | 等开发稳定、不再频繁手工测试之后再上；上线时必须一并处置 `workers_dev` 这个绕过入口（否则 TOTP 可被 workers.dev 子域绕过） | **暂缓**：当前处于频繁手工联调阶段，TOTP 会让每次测试都要掏手机/写脚本，拖慢验证；且 `workers_dev` 关停会连带影响 CI 里用 workers.dev URL 校验发布包的步骤（需改走自定义域名），属于要单独安排的改动 |
| **响应 HMAC（原 D-4）** | 对 Agent 响应加签名（`HMAC(token, nonce\|status\|sha256(body))`），防止中间人篡改客户端配置里的 `Endpoint`/`PublicKey` | 当前传输已有 TLS 完整性保障（可信证书直连首选、Tunnel 备用；ADR-0007 已如实描述） | **不做（除非威胁模型变化）**：可信证书/Tunnel 落地后，响应篡改需先攻破 TLS，30 行 HMAC 只是冗余纵深；**若将来控制通道出现明文 HTTP 场景（例如临时排障走 `http://IP:8880` 且长期保留），需重新评估本项** |
| **host-ops 能力收窄（原 D-5 后半）** | 限制 `cron.set`/`keys.add` 等白名单动词的可用范围：按节点授权、按时间窗，或操作前二次确认 | 对应 `ADR-0007` 与 `docs/host-ops.md` §0.1 已如实描述"Hub 失陷"边界（拿不到交互式 shell，但白名单动词可被滥用） | **待后续拍板**：文档层面已完成如实化，能力层收窄有多个可选实现（`target=self` 限制 / Peer 侧本地 opt-in 开关 / 时间窗），彼此取舍不同且会改变运维手感，需主人选定后再动 `agent/adapters/host_ops/` |
