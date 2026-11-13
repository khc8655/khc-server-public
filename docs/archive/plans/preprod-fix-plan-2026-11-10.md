# 上生产前缺陷分型与修复方案（preprod-fix-plan-2026-11-10）

> 状态：**已批准，按 §5 批次执行中（2026-11-10）** ｜ 适用范围：`docs/verification/2026-11-10/preprod-test-report.md` 中 S2/S3 缺陷与部分 P1 的根因归并、A/B 方案与批次 ｜ 最后核验：2026-11-10（只读代码取证，未改任何产品代码） ｜ 关联：`docs/verification/2026-11-10/preprod-test-report.md`、`AGENTS.md` 红线 1/2/9、`docs/diagnostics.md`、`docs/host-ops.md`、`docs/backup.md`

---

## 0. 这份文档怎么用

1. **本文只出方案，不授权改代码**。§7 的决策项等主人拍板后再开工。
2. 本轮不做"点状补丁"：每个缺陷先归到根因（R1–R7），**同一根因合并成一次改动**（§5 批次表）。
3. 每个根因给出 A（点修）与 B（结构性改法）。标注"推荐 B"的，**A 只作为 B 落地前的临时止血，不作主选**。
4. 证据等级：**【代码】**＝读实现确认；**【实测】**＝本轮测试已复现；**【文档】**＝来自现有文档。

---

## 1. 结论摘要

| 问题 | 结论 | 一句话 |
|---|---|---|
| 两个假设①：所有 app action 读参都不统一？ | **不成立（部分）** | 4 个适配器都走各自的 `_params()`；真正的问题是**没有统一契约 + 5 份重复实现 + 2 个动作绕过**，影响面是 2 个动作端到端失效，不是"全部" |
| 两个假设②：cron 校验只做在前端？ | **不成立** | Agent 也校验，但三处（web/Agent/contracts）各写一份且**规则本身不完整**；contracts/Worker 侧为零校验 |
| PP-C-05 根因 | **Agent 读错层级**（不是契约不一致） | Worker 已把 `params` 送到 Agent；`takeover`/`restore` 直接读 `body.get("hash")`，永远拿不到 |
| 可归并数量 | 13 项 → **5 组根因 + 2 组灾备 + 1 组纯文案 + 3 项非缺陷/阻塞** | 见 §2 |

**修复主线**：先把"动作参数契约"（R1）和"校验单一权威"（R2）两个结构口子补上，再修诊断闭环（R3）与备份语义（R6/R7）；PP-E-03 等定性后再动传输层。

---

## 2. 根因归并总表

| 根因 | 归入的缺陷/现象 | 改哪一层 | 是否动 contracts/核心 | 推荐 |
|---|---|---|---|---|
| **R1 动作参数契约缺失 + 读法分裂** | PP-C-05、`caddy_import_restore`（备份恢复动作）、`hash_password` 的兼容层 | Agent 内核 + 适配器（+ 可选 contracts） | 是（`agent/khc/`） | **B** |
| **R2 校验规则多处复制且语义弱** | PP-F-08；同类：web 侧重复正则 | Agent（host-ops + `khc-host`）+ web | 否 | **B** |
| **R3 诊断/修复闭环不完整** | C-08（P1-5 残留 unit）、P1-10（443 冲突无提示） | 适配器 + 编排层 + web 动作注册 | 否（contracts 已支持 `action`） | **B** |
| **R4 单池准入、健康检查无隔离** | PP-E-03 | Agent 传输层 `khc/http.py` | 是（`agent/khc/`） | 先定性，见 §4 |
| **R5 文档/阈值与实现不一致** | PP-H-03 升级间隔、B-08 的 8s 预算、G-05/G-06 手册漂移 | 常量 + 文档 + 测试断言 | 否 | **B** |
| **R6 备份脱敏靠字段名黑名单** | 备份中的 basicauth bcrypt 哈希 | Worker `backup.ts` + contracts backup schema | 是（contracts） | **B**（需先定语义） |
| **R7 主密钥恢复流程缺失** | G-02 解密失败 | 导出清单 + 脚本 + DR 文档 | 是（contracts backup schema） | **B** |
| 纯文案 | appUnknown、观测失败文案 | web 文案 | 否 | 直接改（§6） |
| 非缺陷 | C-04（通过）、C-06（缺 F3 凭据阻塞）、B-08（缺证据，归 R5） | — | — | 不改代码 |

---

## 3. 逐根因证据与方案

### R1 动作参数契约缺失 + 读法分裂（PP-C-05 等）

**证据【代码】**

- 契约层：`packages/contracts/src/index.ts:347-351` —— `appActionRequestSchema.params = z.record(z.string(), z.unknown())`，**没有任何 per-action 参数 schema**；未知键被 zod 静默剥离。
- 路由层：`apps/api/src/routes/apps.ts:193-219` —— 所有动作共用 `POST /nodes/:id/apps/:app/:action`，Worker 只校验外层信封，`params` 原样透传。
- 内核层：`agent/khc/kernel.py:606-625` 只读 `idempotencyKey`；`663-680` 的 `_action_meta` 只认 `mode/write/description`；`agent/khc/adapters.py:387-393` 的 `actions` 元数据**没有参数声明**。
- 读法分裂（完整清单见附录 A）：
  - `app_catalog.py:38-42`、`certificates.py:767-779`、`host_ops.py:736-747`、`wireguard.py:2088-2096`、`caddy_site.py:2536-2543` —— **5 份各自的 `_params()`**，回退键集分别是 0/8/7/3/1 个。
  - `caddy_site.py:2899` `_text(body.get("hash"))`、`caddy_site.py:2948` `body.get("backupPath")` —— **仅这 2 个动作直接读顶层业务键**，绕过了 `_params()`。
- 前端传参是对的：`apps/web/src/data/apps.ts:63-77` 固定 `{ params }`；`apps/web/src/apps/caddy/page.tsx:803` 传 `{ hash: block.hash }`、`:859-860` 传 `{ backupPath }`。

**实测（本轮）【实测】**：`{'params':{'hash':'0'*64}}` 与 `{'hash':'0'*64}` 都返回 `400 hash 不合法`。前者说明 `params` 已到达 Agent、但动作读不到；后者被 zod 剥离成 `params={}`。反证：面板 BasicAuth 的 `hash_password` 走 `_params()`，C-04 实测可用 → **Worker→Agent 的 params 链路本身没问题**。

**影响面**：外部 Caddyfile 接管与"恢复备份"两条链路端到端失效（C-05 / D-08）；未来任何新动作都没有契约守卫，只能靠人记得用 `_params()`。

**A 点修**：`caddy_site.py:2899`、`:2948` 各改 1 行改用 `self._params(body)`，补 2 条单测。风险低，但 5 份 `_params` 与"无参数契约"原样保留，下次仍会踩。

**B 结构性改法（推荐）**：
1. `agent/khc/adapters.py` 提供**唯一访问器** `params(body, allowed: Iterable[str] | None = None)`：只认 `body["params"]`，未知键可选拒绝；删除 5 份复制实现。
2. `actions` 元数据增加最小参数声明（键名 / 类型 / 是否必填），`kernel.handle_action` 在 dispatch 前统一校验（仍属 `agent/khc/`，需按红线 2 说明必要性）。
3. 增加**守卫测试**：AST/grep 断言 `agent/adapters/**` 的 `action_*` 内不得出现 `body.get("<业务键>")`（信封字段除外）。
4. contracts 暂不引入 per-action zod（Python/TS 双写会漂移）；Worker 保持只校验信封。

- 影响面：`agent/khc/adapters.py`、`agent/khc/kernel.py`、5 个适配器、`agent/tests/`；不动 D1/迁移/Worker 路由；前端无改动。
- 迁移成本：中（一次性改 5 份 `_params`，但都是机械替换）。
- 风险：`actions` 元数据加参数声明后，旧面板/旧 Agent 混跑要保证向后兼容（缺声明 = 不校验）。

**推荐**：B，分两步落地 —— B1（访问器 + 2 处修复 + 守卫测试）即可修好 C-05；B2（元数据校验）随后续动作逐步接入。

---

### R2 cron 校验多处复制且语义弱（PP-F-08）

**证据【代码】**

- contracts：grep `cron`/`hostOps` **0 命中** —— 没有可共用的规则。
- web：`apps/web/src/data/hostOps.ts:913-997` 自带 `CRON_NAME_RE`、`validateCronName`、`validateCronContent`（只查空 / ≤100 行 / 单行 ≤512 / 控制字符）；`OpsSegments.tsx:395-412` 保存前调用。
- Agent：`agent/adapters/host_ops/khc_host.py:103`（控制字符）、`:118`（名称正则）、`:121-122`（100 行/512 字符）、`:1870-1881`（`_cron_validate_content` 同样只查这四项）；`:1884+` 的 `cron_set_verb` 先验名称，再由 `_cron_paths`（`:1820-1826`）**无条件加 `khc-` 前缀**。
- 结论：**不是"只在前端"**，而是"三处各写一份、都只做长度/字符级校验"；`@reboot`、`; && || | $() \``、五段字段语义全部放行。

**影响面**：面板管理员可写入任意 root 定时任务（面板本身即 root 级遥控器，不构成提权，但白名单承诺失效，误操作可定时重启）。

**A 点修**：在 `_cron_validate_content` 加分隔符/`@` 检查，并同步改 `hostOps.ts` 一份。风险：两份规则会再次漂移；`echo "a;b"` 这类合法写法可能被误伤。

**B 结构性改法（推荐）**：
1. **单一权威在 Agent**：把 cron 内容解析写成纯函数（5 段时间字段 + 命令，拒绝 `; && || | $() \`` 与换行；`@reboot/@daily` 默认拒绝，除非主人拍板允许），`khc-host` 打包版本同步 bump。
2. web 删除复制规则，只保留"名称字符集/长度"的即时提示；内容错误由 Agent 400 带 `field` 定位（面板已能渲染 Agent 错误）。
3. 若坚持前端即时校验，则规则以**数据**形式由 Agent 导出（capabilities 或发布清单），web 读同一份 JSON，禁止手写第二份。

- 影响面：`host_ops` 适配器、`khc_host.py`（含 `SCRIPT_VERSION` 与打包产物）、`package.sh`、web `data/hostOps.ts`、`docs/host-ops.md`；不动 Worker 路由/契约。
- 迁移成本：中；风险：收紧后可能影响已在用的面板外脚本（但只管理 `khc-*`，影响可控）。

**推荐**：B。附带产品决策：`@reboot`/`@daily` 是否允许（见 §7-2）。

---

### R3 诊断/修复闭环不完整（C-08、P1-10）

**C-08 证据【代码】**：`agent/adapters/wireguard.py:1708-1764` 的 `_problems` 只覆盖 `interface_down`、`port_conflict`、`rotation_stuck`，**没有"unit active 但不在面板配置里"的检测**；诊断动作经 `apps/api/src/lib/diagnostics/evaluate.ts:404-435` 原样渲染，`hints.ts:8` 的 `fix.mode=action` 只允许 3 个动作（重新 apply / 重启服务 / 取消换钥）。所以残留 `wg-quick@khc0` 既不报、也没有修复入口。

- A：`_problems` 加一条 `orphan_unit`（约 15 行），动作复用 `app.apply`。风险：apply 只写配置并重启，**可能不会停掉孤儿 unit**，变成"报了但修不了"。
- B（推荐）：定义通用"残留资源"模型 —— 适配器上报 `problems[].action{id:'app.cleanupResidual'}`，`hints.ts` 允许动作扩到 4 个，`registry/actions.ts` 注册，诊断行按 L2 直接执行；清理动作复用 host-ops `cleanup` 能力，知识留在适配器。影响面：wireguard 适配器 + `hints.ts` + web 注册表 + `docs/diagnostics.md`；contracts 已支持 `action`，**无需改契约**。

**P1-10 证据【代码】**：`apps/api/src/lib/mode.ts:46-57` 已把"443 端口"类阻断码删除；站点 plan 的端口提示来自适配器 `caddy_site.py:1324-1330`，只查 `ports.json` 登记表，**不知道 Agent 自身占用 443**。

- A：web 在站点表单/plan 前用节点 endpoint 端口比对 `listenPort`，命中提示（约 20 行）。风险：Tunnel 模式没有端口，漏判；应用知识落在页面，违反红线 2。
- B（推荐）：适配器 plan 阶段做**真实端口占用预检**（`/proc/net/tcp` 或 `ss -ltnp`，识别 khc-agent），命中给 plan warning；Worker `apps/api/src/lib/app-diagnostics/` 只在拿不到 Agent 时兜底。影响面：`caddy_site.py` + 少量采集；不动 contracts。前置：确认 Agent 自身端口可被可靠发现（argv/env/systemd unit）。

**推荐**：两项都 B；C-08 的清理动作与 P1-10 的预检可同批，但属两条独立改动。

---

### R4 单池准入、健康检查无隔离（PP-E-03）

**证据【代码】**：`agent/khc/http.py:492-506` 在 `process_request` 里**握手前**抢全局 `BoundedSemaphore(64)`，抢不到直接 `request.close()`；注释写"优先保护健康检查与已有请求"，但 `/health` 同样要抢这个池 —— 注释与事实不符。`process_request_thread:508-525` 只负责释放。

#### 情形一：主人判定"设计性保护"（不改代码）

- 结论：行为符合"资源上限优先"，8/20 探活失败属于预期代价；断开后 10/10 恢复已实测。
- 必须做的三件事：① 在 `docs/security-boundaries.md` 写明 `max_workers=64` 与拒绝策略；② 修正 `http.py:496` 的误导注释；③ 调整 E-03/C-03 用例预期为"洪水期间可能被拒，但服务不崩、断开即恢复"。
- 风险：面板在洪水窗口会显示"节点不可达"；由 30s cooldown + 控制面快照兜底，可接受。

#### 情形二：判定"缺陷"

- A 点修：池满时返回 503 + `Retry-After`。**注意**：槽位在 TLS 握手前抢，此时还写不了 HTTP 响应，只能先关闭 —— 所以 A 实际只能是"加大池 + 给播测预留几条"，改动小但治标。
- B（推荐）：**分层准入** —— accept 后先做带 10s 超时的 TLS 握手，再按路径分池（`/health`、`/_live/*` 小池 8；业务池 56）；业务池满对已握手连接返回 503 + `Retry-After`；未握手连接仍受全局上限保护。
- 影响面：仅 `agent/khc/http.py`（核心传输层，需 ADR 说明）；不动 contracts；需真机复跑 50 空 TCP + 50 慢 TLS 压测。
- 风险：慢速握手仍可能占满小池 → 小池也必须带超时 + 上限；需压测确认 `/health` p95。

**当前不给结论**：等主人回答"设计保护 or 缺陷"（§7-1）。

---

### R5 文档/阈值与实现不一致（PP-H-03、B-08、G-05/G-06）

**证据**：UI `apps/web/src/i18n/zh.ts:1938-1939` 要求"≥60 秒"；`docs/agent-lifecycle.md:121-122` 写"约 40s 内触发重叠回滚"（实测 19s 被弹回）；`docs/runbook/troubleshooting.md:115` 又写 60 秒。B-08：用例期望 8s，`apps/api/src/routes/nodes.ts:339` 的 `/state` 预算是 10s；离线时返回 `200 + reachable:false`（`:393-403`），没有机器可读 `code`。

- A：把文档数字统一成 60s、8s 改成 10s。风险：数值仍散落各处，下次再漂移。
- B（推荐）：阈值**单一来源** —— Agent 侧 `WATCHDOG_*` 常量与 web `UPGRADE_MIN_INTERVAL_MS` 各自导出并互相引用；文档只写常量名与"保守阈值"；测试断言 UI 文案中的数字 == 常量。B-08 另需补一次**离线实测并落盘**（请求/响应/耗时），再决定是改文档还是把预算降回 8s。
- 影响面：`zh.ts`、`agent-lifecycle.md`、`troubleshooting.md`、少量常量与测试；不动 contracts。迁移成本低。

**推荐**：B（数值常量 + 测试断言 + B-08 补证）。

---

### R6 备份脱敏靠字段名黑名单（备份 bcrypt）

**证据【代码】**：`apps/api/src/routes/backup.ts:17-39` 的 `SECRET_KEYS` 只有 `privatekey/presharedkey/private_key/preshared_key/psk` 五个键；`stripSecrets` 按名剥离，**`basicauth` 里的 bcrypt 哈希保留**；`findings-e.md` 判"不可逆、可接受"。

- 说明：本条与 R1 的 `caddy_import_restore` 不同 —— 后者是"恢复动作读不到参数"，本条是"导出内容是否该带可离线爆破的凭据"。

- A：`SECRET_KEYS` 追加 `basicauth`/`password`/`passwordHash`。风险：误删普通字段；导入后站点认证失效且无提示。
- B（推荐）：显式**备份清单** —— export 增加 `manifest: { stripped: [...], encKeyId }`；basicauth 哈希默认剥离，import 时按稳定标识保留旧值（复用 `restoreSecrets`，与 privateKey 同机制）；`docs/backup.md` 写明"备份可恢复配置，但不含可爆破凭据"。
- 影响面：`backup.ts`、contracts `backupExportSchema`、`docs/backup.md`、测试。迁移成本低；需主人先确认备份语义（§7-3）。

---

### R7 主密钥恢复流程缺失（G-02）

**证据【代码/实测】**：`apps/api/src/lib/crypto.ts:6-11, 88-94` —— 新密文带 `enc:v2:<keyId>:`，解密先试当前钥、再试 `MASTER_ENC_KEY_PREVIOUS`；G-02 回放后报 `keyId=k1` 不匹配。**导出文件不含密钥信息**，`docs/backup.md` 未把"密钥托管 + keyId 核对"列为前置。

- A：DR runbook 补一句"回放需同一 `MASTER_ENC_KEY`"。
- B（推荐）：export manifest 带 `keyId`（复用密文前缀）；新增 `scripts/verify-backup`：用给定 key 抽样解密并校验 keyId；DR runbook 把"密钥托管 → keyId 核对 → 解密抽样"列为恢复前置。
- 影响面：`backup.ts`（与 R6 同一次改动）、新脚本、`docs/backup.md`/`docs/runbook/disaster-recovery.md`；不动 D1。

**推荐**：B，与 R6 合批（同一个导出清单）。

---

## 4. PP-E-03 定性（不替主人决定）

| 主人回答 | 结论 | 要做什么 | 是否需要 ADR |
|---|---|---|---|
| **设计性保护** | 不是缺陷，不改代码 | 写 `security-boundaries.md` 的 64 并发上限与拒绝策略；修正 `http.py:496` 注释；调整 E-03/C-03 用例预期 | 否（文档同步） |
| **缺陷** | 需要修，走 B | 分层准入 + 按路径分池 + 503/Retry-After；真机复跑压测 | 是（改传输层准入模型） |

两种情形都必须做的一件事：**修正那句与事实不符的注释**（"优先保护健康检查"），否则后续维护者会被误导。

---

## 5. 批次与顺序（同一根因合并成一次改动）

| 批次 | 包含 | 改动层 | 验证方式 | 版本 |
|---|---|---|---|---|
| **0 文案与文档** | §6 全部（appUnknown、观测失败文案、升级间隔、B-08 阈值文档） | web 文案 + docs | `pnpm typecheck && pnpm test`；文案 grep；无需真机 | 面板 patch（0.7.13），可与下批合并 |
| **1 R1** | 唯一 `params()` 访问器 + caddy 2 处修复 + 守卫测试 | `agent/khc/` + `caddy_site.py` | Agent 单测；真机用扫描返回的真实 hash 走通 takeover 到"目标站点块已变化"；restore 成功路径；`./scripts/verify.sh` | Agent 0.1.36 |
| **2 R2** | cron 内容单一权威 + web 去重复规则 | `host_ops`/`khc_host.py` + web | 6 类恶意载荷（换行/多行/`@reboot`/`;`/`$()`/反引号）全部拒绝；合法 5 段仍可写；`khc-host` 打包冒烟 | Agent 0.1.37（`SCRIPT_VERSION` 1.5.1） |
| **3 R3** | 残留资源诊断+修复动作；站点端口预检 | 适配器 + `hints.ts` + web 注册表 | 单测；真机造残留 unit 出现诊断并可一键清理；站点 443 plan 出现 warning | Agent 0.1.38 + 面板 0.7.14 |
| **4 R4**（取决于定性） | 分层准入 / 或只改文档 | `agent/khc/http.py` 或 docs | 压测复跑 E-03 + C-03；断开恢复 | Agent 0.1.39（若改代码） |
| **5 R6+R7** | 备份清单 + basicauth 剥离 + keyId + 校验脚本 | `backup.ts` + contracts + docs + scripts | 导出/导入单测；隔离 D1 回放 + 解密抽样；非法 key 报错可读 | 面板 0.7.15 |
| **独立** | B-08 补测；C-06 等 F3 | 无代码 | 落盘请求/响应/耗时 | — |

> 若 1–3 合并成一次发版，只需 bump 一次（Agent 0.1.36 + 面板 0.7.13）；**不要**每个小批各发一次，避免测试面扩散。批次 4/5 因涉及核心与备份语义，建议单独 PR。

---

## 6. 纯文案/文档类（可直接改，无需方案）

| 项 | 位置 | 改法 |
|---|---|---|
| appUnknown | `apps/web/src/i18n/zh.ts:848`、`pages/HubOverviewPage.tsx:176-188` | 改成「未读取」或「—」；仅 Tunnel/不可达时出现，不再用"未知" |
| 观测失败文案 | `apps/web/src/data/snapshot.ts:644` | 用户侧只留「实时观测暂不可用」+「读取控制面快照」；CORS/`KHC_LIVE_ORIGINS` 等术语进可展开详情 |
| 升级间隔 | `zh.ts:1938-1939`、`docs/agent-lifecycle.md:121` | 统一 60s，文档标注"保守阈值；理论重叠窗口约 40s" |
| B-08 阈值 | 用例文档 / `nodes.ts:339` | 以 10s 实现为准改文档；或补实测后决定是否降回 8s |
| 本方案索引 | `docs/README.md` | 登记本文（提案） |

以上已随 2026-11-10 批准一并执行（批次 0），不单独发 PR。

---

## 7. 待主人拍板

| # | 决策 | 影响 |
|---|---|---|
| 1 | PP-E-03：设计保护 or 缺陷 | 决定批次 4 是否改 `http.py`、是否写 ADR |
| 2 | cron 内容策略：是否允许 `@reboot/@daily`；命令里允许哪些字符 | 决定 R2 的严格度与误伤范围 |
| 3 | 备份语义：basicauth bcrypt 哈希是否随导出 | 决定 R6 是"剥离"还是"标注保留" |
| 4 | C-08 修复动作：是否新增 `app.cleanupResidual`（允许动作从 3 扩到 4） | 决定 R3 是"能报能修"还是"只报" |
| 5 | P1-10 端口预检：是否允许适配器在 plan 阶段读 `/proc/net/tcp` | 决定 R3 第二项落点 |
| 6 | R1 是否动 `agent/khc/`（红线 2） | 批准后才开工批次 1 |

**已确认（2026-11-10 主人批准，按推荐值执行）**：

1. PP-E-03 定性为**设计性保护**，不记缺陷；只修拒绝时的 503 语义与 `agent/khc/http.py` 的错误注释，不改准入模型。
2. cron **不允许 `@reboot`**；白名单只保留明确的时间表达式（5 段时间字段 + 命令）。
3. 备份**默认剥离** basicauth 哈希链，导入时保留旧值。
4. **不新增 `app.cleanupResidual`**；本批只做 status 上报 + 运维指引。
5. **允许** plan 阶段只读 `/proc/net/tcp` 做真实占用检查。
6. 批准改 `agent/khc/`（红线 2 例外），范围严格限定 R1 的唯一参数访问器 + 禁止直读顶层的守卫测试；**不动协议、签名、D1 schema**。若 R1 需要超范围，先停下说明，不得自行扩大。

**R4 定稿（2026-11-10 真机复测后，主人确认「接受现状」）**：

- 明文模式：池满返回 `503 Service Unavailable` + `Retry-After: 1` + `{"ok":false,"error":{"code":"overloaded"}}`（真机实测通过）。
- TLS 模式：槽位在握手前获取，此时没有可写的 HTTP 层，物理上只能断开连接（真机实测 `SSLEOFError`）；这是已批准边界，**不改为分层准入**。
- 泄洪释放后全部恢复（两种模式真机均回到 200），`/health` 无独立池、洪水期间可能被拒属预期；完整口径见 `docs/security-boundaries.md` §4.1。

---

## 附录 A：app action 参数读取完整清单【代码】

| 适配器 | 访问器 | 回退键 | 使用动作（行号） | 结论 |
|---|---|---|---|---|
| `app_catalog.py` | `_params`（38-42） | 无 | `recipe_install:86`、`recipe_uninstall:96` | 只认 `params` |
| `certificates.py` | `_params`（767-779） | 8 个（domains/days/keyType/provider/credentials/ca/certPem/keyPem） | `:347/548/608/676` → `issue_selfsigned/inspect/install_tls/issue_acme` | 兼容顶层 |
| `host_ops.py` | `_params`（736-747） | 7 个（peerId/host/port/user/target/verb/params/password） | `probe:838`、`onboard:1007`、`call:1117` | 兼容顶层 |
| `wireguard.py` | `_params`（2088-2096） | 3 个（peer/allowedIps/allowed_ips） | `:2105/2132/2160/2181/2304/2351` | 兼容顶层 |
| `caddy_site.py` | `_params`（2536-2543） | 1 个（password） | 仅 `hash_password:2546` | **没被其他动作使用** |
| `caddy_site.py` | **无**（直接读顶层） | — | `caddy_import_takeover:2899`、`caddy_import_restore:2948` | **缺陷（R1）** |
| `agent/khc/kernel.py` | 直接读顶层 | — | `idempotencyKey:615`、`purge:781-783`、`config:757` | 信封字段，可接受 |

**结论**：假设①"所有动作读法都不统一"不成立；成立的是"5 份重复访问器 + 2 处绕过 + 零参数契约"。

## 附录 B：cron 校验三处对照【代码】

| 层 | 位置 | 名称 | 内容 | 语义校验 |
|---|---|---|---|---|
| contracts/Worker | `packages/contracts/src/index.ts`、`apps/api/src/routes/apps.ts:205` | 无 | 无 | 无（`params` 为无类型 record） |
| web | `apps/web/src/data/hostOps.ts:913-997`、`OpsSegments.tsx:395-412` | `^[A-Za-z0-9_-]{1,32}$` | 空/≤100 行/≤512 字符/控制字符 | 无 |
| Agent | `khc_host.py:118,121-122,1870-1881` | 同上 | 同上 | 无；`@reboot`、`;`、`&&`、`\|`、`$()`、反引号全部放行 |

**结论**：假设②"只在前端一层"不成立；真正问题是"三处各写一份、规则本身不完整"。

## 附录 C：PP-C-05 已确认的因果链【实测 + 代码】

1. 前端传 `{ params: { hash } }`（`data/apps.ts:70`、`caddy/page.tsx:803`）→ Worker 校验信封后原样转发（`routes/apps.ts:217`）→ Agent 收到 `body.params.hash`。
2. `caddy_site.py:2899` 读 `body.get("hash")` → `None` → `_text` 转空 → 正则失败 → `400 hash 不合法`。
3. 对照：`hash_password` 走 `_params()`，C-04 实测可用 → 传输链路正常，问题只在读取层级。
4. 因此报告 §4 PP-C-05 的"根因（疑似）：契约不一致 / 期望 id 或数组"应更正为：**适配器读取层级错误**。
