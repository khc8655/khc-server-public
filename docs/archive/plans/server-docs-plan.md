# 服务端文档整理与补齐计划（server-docs-plan）

> 状态：提案·部分落地（节点接入 Runbook / 故障排查手册 / 安全边界说明已于 2026-11-02 提交至 `docs/runbook/` 与 `docs/security-boundaries.md`；其余条目待主人排期） ｜ 适用范围：服务端（控制面 + Agent）文档的现状盘点与补齐规划，本文本身不含正文内容 ｜ 最后核验：2026-11-02（基于 fix/server-issues 工作区 + docs/archive/audit-2026-11-02/server-test/2026-11-02 测试报告） ｜ 关联：`docs/archive/audit-2026-11-02/server-test/2026-11-02/report.md`、`docs/README.md`（文档门禁）

---

## 0. 背景与前提

- 本计划基于 2026-11-02 线上端到端测试（report.md：20 PASS / 1 FAIL / 1 PARTIAL / 2 BLOCKED）与代码抽查产出，**只做盘点与提纲，不写正文**。
- 两个进行中的分支会改变文档基线，落地前必须先合入：
  - `docs/consolidation`（本地，5 commits）：已重写 release / auto-deploy / production-readiness，新增 ADR-0008（生产复用 staging Worker/D1）与 `docs/engineering/d1-migrations.md` runbook，修正 agent/README（适配器清单、TLS 表述、测试数口径），现行文档已补状态块。
  - `fix/server-issues`（进行中）：P0-1（ProtectHome）已见未提交修改（unit 改 `ProtectHome=read-only` + `ReadWritePaths=-/root/.ssh`）；P0-2（SCRIPT_PATH 硬编码）、P1-3（保护端口 8880 硬编码）尚未见修复。
- **凡引用修复后行为的章节，一律标"待修复落地后实测补写"**（见 §4 各提纲内标注与 §5 清单）。

## 1. 现状盘点（文档清单表）

判定口径：✅ 覆盖且与代码一致；⚠ 部分覆盖或有缺口；❌ 缺失；💤 已在 `docs/consolidation` 分支完成待合入（避免重复劳动）。

### 1.1 部署与接入

| 文档 | 状态 | 缺口 | 是否需重写 |
|---|---|---|---|
| `docs/engineering/release.md`（main 版） | ⚠ → 💤 | main 版仍写"独立 staging 不影响生产"（与 ADR-0008 事实相反）；consolidation 分支已重写 | 否（合入即可） |
| `docs/auto-deploy.md`（main 版） | ⚠ → 💤 | "临时停用"段落已成历史；consolidation 分支已重写 | 否 |
| `docs/production-readiness.md`（main 版） | ⚠ → 💤 | consolidation 分支已改为"上线后余项跟踪"；**需追加**：登录限流 KV 未绑定已被 F5 实测证实（P1-5），从"待验证"升级为"已确认缺口，待主人选型" | 小幅增补 |
| `docs/engineering/d1-migrations.md` | 💤（仅 consolidation 分支） | main 上不存在；落地 D1 迁移操作时无 runbook | 合入后即齐 |
| `docs/install.md` | ⚠ | 只覆盖 `install.sh --check` 预检。缺：user/system 模式差异与选择依据；**非交互安装**（面板命令的 `read </dev/tty` 在管道 SSH 下挂起，绕过步骤见 setup-notes §2.2——测试实测踩坑，正式文档完全没有）；8880/8443 端口选择依据（代码默认 8880，线上 hub 实际 8443，为何、何时用哪个无任何文档） | 扩充，不重写 |
| 首次接入 runbook | ❌ | **完全没有**。从"面板建节点 → 拿 token → 装 Agent → 上线确认"的端到端路径只散落在 setup-notes（测试实录，非正式文档）。目标读者是接手者/未来生产机（node-test-2）操作者 | 新增（见 §2.1） |

### 1.2 架构与机制

| 文档 | 状态 | 缺口 | 是否需重写 |
|---|---|---|---|
| `docs/design-v3.md` | ⚠/💤 | consolidation 分支已补路由/表清单。仍缺：**传输层实测数据**——TCP 通道 `/state` 实测 2.1–2.4s 逼近 3s 超时（P1-7），§1.1 的超时参数（state 3s）需补实测依据与调优决策记录 | 小幅增补 |
| ADR-0001–0007 | ✅ | 与代码一致（此前审计已核） | 否 |
| ADR-0008 | 💤（仅 consolidation 分支） | main 上不存在 | 合入即可 |
| `docs/data-layering.md` | ✅ | 无缺口（0005 迁移即按此执行） | 否 |
| `docs/diagnostics.md` | ✅ | 7 核心码与代码一致；D4 实测行为相符 | 否 |
| `docs/dual-mode.md` / `docs/live-observation.md` | ✅ | 与实测一致（SSE CORS 修复已在 CHANGELOG） | 否 |
| `docs/host-ops.md`（+ async/e2e） | ⚠ | 机制覆盖全，但三处与代码/实测脱节：① **khc-host 双路径无说明**（peer 装在 `/usr/local/sbin/khc-host`，hub self 实际在 `/var/lib/khc-agent/host-ops/khc-host`，正是 P0-2 根因）；② **Agent 沙箱边界无文档**（`ProtectHome` 各值对 keys.*/fw.* 的影响，P0-1 修复后需写明 `read-only + ReadWritePaths=-/root/.ssh` 的安全权衡）；③ 防火墙锁定保护行为（P1-3/P1-4 修复后：保护端口从何读取、锁定判定逻辑） | 增补章节（见 §2.6） |
| `docs/port-forward.md` / `docs/caddy-management.md` | ✅ | 与实测一致（C2/B2 PASS） | 否 |
| `docs/backup.md` | ⚠ | 节点配置导出/导入覆盖了；**卸载后 token 保留语义存疑**：uninstall.sh 代码（L135 `! -name token`）说非 purge 保留 token，实测却整体清除（setup-notes §3.3）——代码与实测矛盾未定位（面板命令默认 purge=false，不应清 token），恢复步骤文档化前必须先复核 | 复核后增补 |
| 故障排查手册 | ❌ | **完全没有**。Agent 离线/防火墙锁死/证书失败/peer 不通/HMAC 401/超时踩线，全部只有测试报告里的散点记录 | 新增（见 §2.2） |

### 1.3 Agent 侧

| 文档 | 状态 | 缺口 | 是否需重写 |
|---|---|---|---|
| `agent/README.md`（main 版） | ⚠ → 💤 | main 版仍有三处过时（适配器只列 2 个、`AGENT_TLS_CERT/KEY` 不存在的环境变量、"231 项"写死数字）；consolidation 分支已修 | 否（合入即可） |
| `agent/adapters/host_ops/README.md` | ⚠ | 只讲 khc_host.py 双重加载；缺 self/peer 两侧脚本安装路径差异表（P0-2 修复后必须写清） | 增补 |
| `docs/agent-lifecycle.md` | ⚠ | 命令生成覆盖全（A4 PASS 证实）；**缺"重装 SOP"**：P2-11 实测的完整恢复路径（token 另存 → install → 各 app 显式 `POST /install` → apply → 全部 peer 重新 onboard，因 hub 密钥指纹改变）完全没有文档；token 保管提醒（卸载前另存）也没有 | 增补章节或独立 runbook（见 §2.3） |
| `docs/agent-releases.md` | ✅ | #32 签名清单机制与实测一致（自建包被 `release_not_in_manifest` 拒绝 = 按设计工作，报告 A4） | 否 |

### 1.4 测试与运维

| 文档 | 状态 | 缺口 | 是否需重写 |
|---|---|---|---|
| `docs/archive/audit-2026-11-02/server-test/2026-11-02/*`（test-plan / report / setup-notes） | ✅（一次性记录） | 质量高但属测试实录；**可复用的操作知识（真实命令、踩坑）应沉淀进 runbook，而不是让接手者翻测试报告** | 不改；作为取材源 |
| `docs/engineering/testing.md` | ⚠ | 缺"线上 E2E 流程"一节：server-test 是范例（计划→执行→清理→报告的四件套结构），值得作为流程固化引用 | 小幅增补 |
| 日常运维手册 | ❌ | 备份恢复、D1 迁移、版本升级、节点清理、日志排查散在 6+ 份文档，无操作顺序视角的汇总 | 新增（见 §2.4） |
| 安全与边界说明 | ❌ | 分散在 ADR-0005/0006/0007、agent/README、AGENTS.md 红线；无一份面向"这台机器上 Agent 到底能做什么/不能做什么"的边界说明（沙箱、白名单、防火墙锁定、HMAC、日志零泄露） | 新增（见 §2.5） |

## 2. 拟新增文档清单（含章节提纲）

> 每章要点 + 需要的实测证据；标注【待修复落地后实测补写】的章节，在对应 fix 合入并线上验证前不得凭空编写。
> 落地时按文档门禁（`docs/README.md` §3，consolidation 分支）：归类 + 状态块 + 同 PR 登记索引。

### 2.1 `docs/runbook/node-onboarding.md` — 首次接入 runbook

- **目的**：接手者拿到一台干净机器（以 node-test-2 为参照），从零接入面板直至 `/state` reachable。
- **目标读者**：主人 / 未来接手的 agent；不需要了解内部架构。
- **提纲**：
  1. **前置条件**：系统要求（Debian 12 / Ubuntu 24.04，Python ≥3.11，实测两台均满足）；网络要求（出站可达 `https://panel.example.com/` 下载发布包；Lightsail/Oracle 云防火墙需放行的端口清单——测试机实测仅 80/443/8443/tcp + 51820/udp）。证据：test-plan §1.1/§1.2、G1 预检结果（PASS=11 WARN=3 FAIL=0）。
  2. **预检**：`install.sh --check` 逐项含义（wg/caddy/socat 缺失属 WARN 正常）。证据：G1。
  3. **面板建节点与 token**：`POST /nodes` → 一次性 token 的保管要求（仅显示一次）。证据：A3。
  4. **安装**：面板 install-command 的标准路径（真人终端，`read </dev/tty` 交互输入 token，#31 防泄露设计）；端口选择：默认 8880 何时可用、何时选 8443（Worker 经 `cloudflare:sockets` 任意端口可达；若走 Cloudflare 代理域名则受端口白名单约束）。证据：setup-notes §2.2、report B1（`via:"tcp"`）。
  5. **非交互安装（自动化/重装）**：先 `install -m 600` 写 token 再跑 install.sh 的绕过步骤（完整命令）。证据：setup-notes §2.2（实测两次超时后得出的结论）。
  6. **上线确认**：`/health`、面板 `/state` reachable、`/nodes/:id/state` 各字段含义。
  7. **常见安装期故障 → 指向 troubleshooting.md 对应小节**。
- **依赖**：无（不依赖待修复项），可最先写。

### 2.2 `docs/runbook/troubleshooting.md` — 故障排查手册

- **目的**：按症状组织的排查决策树，覆盖测试中实际遇到过或高风险的故障模式。
- **目标读者**：运维操作者（面板报警/peer 报障时按图索骥）。
- **提纲**（每节 = 症状 → 判定链 → 处置 → 验证）：
  1. **Agent 离线/节点不可达**：判定链（云防火墙 → systemd `systemctl status khc-agent` → `/health` 本机 curl → 端口/沙箱）；区分"真离线"与 TCP 通道延迟踩线（P1-7：`/state` 2.1–2.4s 逼近 3s 超时，ops 页偶发"不可达"但重试即恢复——处置=重试，根因=超时参数）。证据：E1、report P1-7、setup-notes §3.6。
  2. **防火墙锁死恢复**：nft `table inet khc_fw` 手工清除步骤、`fw.confirm`/60s 自动回滚机制说明（实测 70s 生效）、云防火墙与机内 nftables 双层排查。【待修复落地后实测补写】P1-3（保护端口 8880 硬编码 vs 实际 8443）、P1-4（锁定误报）修复后的新行为。证据：D2、report P1-3/P1-4。
  3. **host-ops keys.* 失败（家目录不可见）**：`ProtectHome` 沙箱边界速查 + 手工绕过（直接 SSH 跑 `/var/lib/khc-agent/host-ops/khc-host`）。【待修复落地后实测补写】P0-1 修复后应不再出现，保留为历史排查项。证据：D1、report P0-1。
  4. **hub self `fw.apply` 失败（E_UNSUPPORTED）**：khc-host 双路径说明。【待修复落地后实测补写】P0-2 修复后行为。证据：report P0-2。
  5. **证书失败**：LE 签发失败的排查（域名 DNS、80/443 放行、Caddy 日志）；自签/手动证书路径。证据：B2（LE 成功路径）、ADR-0006。
  6. **WG peer 不通**：握手/路由/AllowedIPs 冲突（E2 实测 400 `invalid_config` 且运行配置完好）→ 逐层排查（`wg show` 握手 → ping WG 网 → 云防火墙 51820/udp）；【待修复落地后实测补写】P1-9（apply 删 peer 不同步内核）修复后的复核步骤（`wg show wg0` 确认内核无残留）。证据：C1、E2、report P1-9、setup-notes §3.5。
  7. **登录/HMAC 401**：面板 401（cookie 过期）；Agent 401（时钟漂移 ±60s、nonce 重放、token 不匹配——F1/F2 实测全 401 属正常防护）；时钟同步处置（`timedatectl`）。
  8. **登录限流不生效**：【待主人决策 + 实施后实测补写】KV 绑定 vs D1 计数（P1-5，wrangler.toml 无 KV 绑定，需改生产 Worker 配置）；F5 复测步骤（连打错误口令至 429）。
  9. **二维码不显示**：P2-8（`qr` 字段 null）现状 + 人工验证路径。证据：report P2-8（BLOCKED 项）。

### 2.3 `docs/runbook/agent-reinstall.md` — Agent 卸载/重装 SOP（或并入 agent-lifecycle.md 作独立章节，推荐后者避免文档碎片化）

- **目的**：把 P2-11 实测出的完整恢复路径固化为可执行清单，避免重装后"看起来好了其实 peer 全断"。
- **目标读者**：执行节点级灾难恢复的操作者。
- **提纲**：
  1. **卸载前必做**：token 另存（实测卸载会清 `/etc/khc-agent`，与 uninstall.sh 代码"保留 token"矛盾——**先复核此矛盾再定稿本章**：面板 uninstall-command 是否带 `--purge`、或 uninstall.sh 行为与代码不符）；导出各 app config（backup.md 路径）。
  2. **卸载**：面板命令 vs 手工 `uninstall.sh`；purge/非 purge 差异表。证据：B3、setup-notes §2.3。
  3. **重装**：token 写回（§2.1 非交互路径）→ install.sh → `/health` 确认。证据：B3（0.1.4 sha256 校验 OK）。
  4. **应用层恢复**：逐 app `POST /install` 再 apply（实测 PUT+apply 只恢复 known_hosts，**不重建** hub 密钥/脚本）。证据：report P2-11。
  5. **Peer 重新 onboard**：hub 密钥重建 → 指纹改变 → **全部已 onboard peer 失联**（`E_SSH_DENIED`），需逐个重新 onboard 的完整步骤 + authorized_keys 残留清理（P2-10：`sed /khc-hub/d`）。证据：report P2-10/P2-11、setup-notes §2.5。
  6. **【待修复落地后实测补写】**：P1-6（peer 公钥映射丢失→面板 peers=[]/未知）修复后（公钥回写 D1，涉契约变更需走方案确认门禁）的重装复核步骤：重装后 `/state` 应直接可见 peers。
- **依赖**：P1-6/P1-9 修复合入前，第 4–6 章只能写"当前已知缺陷下的操作姿势"。

### 2.4 `docs/runbook/daily-ops.md` — 日常运维手册

- **目的**：操作顺序视角的汇总入口，正文尽量引用既有权威文档而非复制。
- **提纲**：
  1. **备份与恢复**：节点配置导出/导入（指向 `docs/backup.md`）+ 实测要点（导出无 token/私钥、导入不自动 apply、`appliedRev=null`）。
  2. **D1 迁移**：指向 `docs/engineering/d1-migrations.md`（consolidation 分支）。
  3. **版本升级**：面板（CI 自动部署，指向 release.md/ADR-0008）+ Agent（拉取式 upgrade 命令，指向 agent-lifecycle.md）。
  4. **节点清理**：删除节点的完整清单（D1 记录 + 机上 agent + WG peer 内核残留复核——P1-9 教训 + 测试 H1 清理对照表作模板）。证据：report §5。
  5. **日志排查**：agent journal / audit 表 / state.json 的位置与 grep 姿势（含 F4 的 token 泄露自查命令）。
  6. **历史遗留节点清理**：当前 D1 有 6 个残留测试节点（report §6.3），清理决策与操作。
- **依赖**：§2 需 consolidation 分支合入；§4 吸收 P1-9 修复后行为。

### 2.5 `docs/security-boundaries.md` — 安全与边界说明

- **目的**：一份面向"这台机器/这个 Worker 到底被授权做了什么"的边界总览，收拢分散在各 ADR 的安全设计。
- **目标读者**：主人审计、以及任何担心"装了这个 Agent 会不会失控"的读者。
- **提纲**：
  1. **控制面**：会话（JWT 24h `khc_sess`）；登录限流现状（【待主人决策】P1-5：KV 未绑定=多 isolate 下形同虚设，实测 12 次错误无 429）；传输（Worker→Agent HMAC + `cloudflare:sockets`）。
  2. **Agent 沙箱**：systemd unit 逐项防护（ProtectHome/ProtectSystem/ReadWritePaths 白名单）；【待修复落地后实测补写】P0-1 修复后 `ProtectHome=read-only + ReadWritePaths=-/root/.ssh` 的权衡说明（为何必须开 root 家目录写权限：keys.* 管理 authorized_keys）。
  3. **写盘白名单**：Agent 可写路径清单（etc/wireguard、apps 等、data、caddy、`/root/.ssh`）；原则：白名单外不可写。
  4. **命令防泄露**：#31 `read </dev/tty` 设计（token 不进 shell 历史/进程参数）；代价=非交互场景挂起（指向 onboarding §5）。
  5. **发布包信任**：#32 Ed25519 签名清单（自建包被拒=按设计，A4）；sha256 校验。
  6. **防火墙安全网**：锁定保护（SSH/WG/Agent 端口强制保留）+ 60s 确认回滚（实测 70s）；【待修复落地后实测补写】P1-3/P1-4 修复后的保护范围。
  7. **密钥与凭据**：token 存储（Agent 明文本地 0600 / D1 加密）、peer 私钥（只在客户端配置绝不进服务端 conf）、证书私钥 AES-GCM（ADR-0005/0006）。
  8. **验证方法**：F1–F4 的自查命令集（HMAC 边界、越权、未知 verb、日志零泄露 grep）。
- **依赖**：多数章节可立即写（证据齐全）；沙箱与防火墙两章等修复定稿。

### 2.6 既有文档增补（不新增文件）

| 文档 | 增补内容 | 依赖 |
|---|---|---|
| `docs/install.md` | user/system 模式差异、非交互安装、端口选择依据（= §2.1 的 4/5 章正文落点，避免 runbook 与 install.md 双写——runbook 引用） | 无 |
| `docs/host-ops.md` | khc-host self/peer 双路径表；Agent 沙箱边界小节；fw 锁定保护机制（修复后行为） | P0-1/P0-2/P1-3/P1-4 修复落地 |
| `docs/agent-lifecycle.md` | "重装 SOP"章节（= §2.3 正文落点）；token 保管提醒 | backup token 矛盾复核；P1-6 |
| `agent/adapters/host_ops/README.md` | 脚本安装路径差异表 | P0-2 修复落地 |
| `docs/engineering/testing.md` | "线上 E2E 流程"一节（以 server-test 四件套为模板：计划→实录→报告→清理） | 无 |
| `docs/production-readiness.md`（consolidation 版合入后） | B6 增补：P1-5 已证实、待选型 | 主人 KV/D1 决策 |
| `docs/design-v3.md` | §1.1 补 TCP 通道实测延迟数据与超时调优决策（P1-7） | 主人对超时参数的取舍 |

## 3. 与代码一致性抽查记录（2026-11-02）

| 抽查项 | 代码事实 | 文档现状 | 结论 |
|---|---|---|---|
| Agent 默认端口 | `agent/install.sh` L18 `PORT="${KHC_PORT:-8880}"`；线上 hub 实际 `--port 8443` | agent/README 写默认 8880（对）；但 8443 的使用场景无任何文档 | 缺端口选择说明 |
| ProtectHome | 工作区未提交修改：`read-only` + `ReadWritePaths=-/root/.ssh` | 无文档 | P0-1 修复落地后必须补 |
| SCRIPT_PATH | `khc_host.py` L134 仍硬编码 `/usr/local/sbin/khc-host` | host-ops.md 无双路径说明 | P0-2 修复落地后必须补 |
| FW_PROTECTED_FIXED_PORTS | `khc_host.py` L67 `(8880,)` 硬编码 | 无文档说明保护端口来源 | P1-3 修复落地后必须补 |
| 登录限流 | `rate-limit.ts` 支持 KV，`wrangler.toml` 无 KV 绑定 | production-readiness（旧版）未记录此缺口 | F5 实测证实，需记录 |
| 卸载 token 保留 | `uninstall.sh` L135 非 purge 保留 token | setup-notes 实测"整体清除" | **代码与实测矛盾，未定位**，重装 SOP 定稿前必须复核 |

## 4. 补齐顺序与依赖

```
P0 前置（非文档工作，但决定文档能否写准）：
  ① docs/consolidation 合入 main（否则 release/README/agent-README 双改冲突）
  ② fix/server-issues（P0-1/P0-2 + P1-3/P1-4）合入并线上验证

第一批（不依赖任何修复，立即可写）：
  1. node-onboarding.md        ← setup-notes §1/§2.2 + install.md 增补（同 PR）
  2. troubleshooting.md 骨架    ← 第 1/5/7 章（离线判定、证书、HMAC、时钟）
  3. security-boundaries.md 第 1/4/5/7/8 章
  4. testing.md 增补"线上 E2E 流程"

第二批（依赖 ②）：
  5. troubleshooting.md 第 2/3/4/6 章（防火墙锁死恢复、keys.*、双路径、peer 内核残留）【实测补写】
  6. host-ops.md / host_ops README / security-boundaries 第 2/6 章增补【实测补写】

第三批（依赖 P1-6/P1-9 修复 + token 矛盾复核，且 P1-6 涉契约需主人先拍板）：
  7. agent-reinstall SOP（agent-lifecycle.md 增补章节）【实测补写】
  8. daily-ops.md（节点清理吸收 P1-9 修复后行为；D1 迁移引用 consolidation 产物）

收尾：
  9. production-readiness / design-v3 小幅增补（P1-5 选型、P1-7 超时取舍——均待主人决策）
```

## 5. 必须等修复/决策落地才能写的内容（汇总）

| 内容 | 阻塞项 |
|---|---|
| 防火墙锁死恢复的准确步骤、保护端口行为 | P1-3/P1-4 修复合入 + 线上实测 |
| keys.* 沙箱边界定稿、`ReadWritePaths=-/root/.ssh` 权衡 | P0-1 修复合入 + 线上实测（keys.list/add PASS） |
| khc-host 双路径表、self fw.apply 恢复 | P0-2 修复合入 + 线上实测 |
| 卸载/重装后 peer 恢复步骤、peers=[] 修复说明 | P1-6（涉契约：公钥回写 D1，需方案确认门禁）+ P1-9 修复合入 |
| 卸载 token 保留语义 | 代码与实测矛盾未定位（面板命令 purge 标志？uninstall.sh 行为？）——先复核 |
| 登录限流 429 行为与配置说明 | P1-5：主人拍板 KV vs D1 + 生产 Worker 配置变更实施 |
| 二维码使用说明 | P2-8：qr 字段 null 待修 + 浏览器走查补验 |
| TCP 超时调优结论 | P1-7：主人对 3s 超时/前端重试的取舍 |

## 6. 需要主人拍板的事项

1. 本计划整体（新增 5 份文档 + 7 处增补的范围与提纲）是否认可；`docs/runbook/` 目录命名是否可接受（备选：并入 `docs/ops/`）。
2. agent-reinstall SOP 独立成文 vs 并入 agent-lifecycle.md（本计划推荐后者）。
3. §5 所列阻塞项的修复排期（与 fix/server-issues 的 P0/P1 优先级对齐）。
4. P1-5（限流）、P1-6（公钥回写 D1，涉契约）、P1-7（超时）三项技术选型。
