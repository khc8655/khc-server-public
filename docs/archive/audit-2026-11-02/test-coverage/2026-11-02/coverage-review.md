# 测试覆盖评估报告（架构路径）

```yaml
状态: 已归档（历史记录；一次性评估产物，不得作为开发依据，AGENTS.md 红线 9c）
适用范围: 全仓库测试体系（agent Python / apps/api / apps/web / migrations）
最后核验: 2026-11-03（修复状态复核）
关联: AGENTS.md §3.7/§7、docs/engineering/testing.md、docs/engineering/d1-migrations.md、docs/archive/audit-2026-11-02/server-test/2026-11-02/report.md
```

> 修复状态（2026-11-03）：第一优先级空白已由批次 F 补齐（`6eac34f`：D1 契约双跑、迁移顺序与幂等、rotate_peer API 层断言、会话语义）；vitest/agent 用例数以 `./scripts/verify.sh` 实跑为准。

> 说明：本报告为只读评估，未修改任何代码/测试。按文档门禁应登记 `docs/README.md` 索引，
> 因任务约束"只新增本任务报告文件"未同步索引，请主人决定归档口径（建议视为一次性评估产物）。

## 1. 现有测试盘点（实测数据）

统计口径：`python3 -m unittest discover -s agent/tests -t agent` = **757 用例全绿（13.2s）**；
`vitest run` = **305 用例全绿（41 文件）**。合计 1062。无 packages/contracts 独立测试、无真机/CI 集成测试。

### 1.1 Agent 侧（Python unittest，757 用例 / 18 文件）

| 测试文件 | 用例数 | 类型 | 覆盖对象 |
|---|---:|---|---|
| test_caddy_site.py | 175 | 单测（FakeRunner/mock） | Caddy 站点适配器 |
| test_host_ops.py | 146 | 单测（FakeRunner mock nft/systemd） | 主机运维：防火墙护栏、回滚、保护端口、任务锁 |
| test_wireguard.py | 111 | 单测（FakeRunner mock wg） | WG 配置/轮换/peer prune/内核同步 |
| test_port_forward.py | 76 | 单测 | 端口转发适配器 |
| test_kernel.py | 45 | 单测 | khc 内核动作调度/apply/rollback |
| test_certificates.py | 35 | 单测 | 证书颁发/续期/fallback |
| test_adapters.py | 27 | 单测 | 适配器契约通用行为 |
| test_http.py | 22 | 单测 | Agent HTTP 服务 |
| test_upgrade.py | 20 | 单测 | 升级：sha 校验、tar 防穿越、重启失败回滚、watchdog |
| test_util.py | 17 | 单测 | 工具函数 |
| test_auth.py | 15 | 单测 | HMAC 签名/时间窗/nonce 重放/多 token |
| test_node_exporter.py | 15 | 单测 | 指标上报 |
| test_live.py | 9 | 单测 | live 票据重放/过期、连接上限、CORS |
| test_cli.py | 9 | 单测 | CLI token 子命令（0600） |
| test_tasks.py | 9 | 单测 | 异步任务 |
| test_ops.py | 5 | 单测 | 运维动作 |
| test_state.py | 5 | 单测 | 状态构建 |
| test_package.py | 2 | 单测 | 打包/卸载残留 |

特点：全部为纯函数 + Fake 外部命令的**单测层**；`install.sh`/`uninstall.sh` 仅 `bash -n` 语法检查（verify.sh L22）；
真机验证仅手动执行（docs/archive/audit-2026-11-02/server-test/2026-11-02/report.md、scripts/host-ops-peer-e2e.sh）。

### 1.2 API 侧（vitest，17 文件 138 用例）

| 测试文件 | 用例数 | 类型 | 说明 |
|---|---:|---|---|
| agent_lifecycle.test.ts | 29 | 路由级（FakeAgentClient） | 安装/升级/卸载命令生成、token 不内嵌、shellQuote、bash -n、fail-closed 清单、审计脱敏 |
| diagnostics.test.ts | 31 | 单测+路由 | 传输错误分类（timeout/abort/TLS/530/522/524）、诊断编排 |
| mode.test.ts | 19 | 单测 | 预检/模式编排 |
| node-client.test.ts | 7 | 单测（mock fetch/socket） | 直连失败切隧道、5xx 切换、双败 HubUnreachable、IP 走 tcpFetch |
| apps.test.ts | 6 | 路由级 | plan/apply expectRev、appliedRev 回写、rollback=旧配置新 rev、client_config 透传 |
| rate-limit.test.ts | 6 | 路由级+单测 | D1 计数、D1/KV 异常降级内存、集成第 11 次错误口令 429（P1-C 修复配套） |
| tcp-fetch.test.ts | 5 | 单测（socket stub） | 裸 IP 走 TCP、Content-Length/chunked/无长度/非法响应 |
| backup.test.ts | 5 | 路由级 | 备份剥离私钥、恢复按 public identity 匹配保留旧 peer 私钥 |
| nodes.test.ts | 5 | 路由级 | CRUD、一次性 token、/state 可达性、400 校验 |
| auth.test.ts | 4 | 路由级 | 401 不回显、HttpOnly Cookie、未登录 401、缺 SECRET fail-closed |
| password.test.ts | 4 | 单测 | 口令哈希 |
| health.test.ts | 3 | 冒烟 | health/version/404 JSON |
| live.test.ts | 3 | 单测 | live 票据签发/验签、scope |
| crypto.test.ts | 3 | 单测 | 加解密、IV、token 随机性 |
| smoke-offline-save.test.ts | 1 | 冒烟 | 离线保存→apply 失败记错→恢复后 apply 最新 rev |
| audit.test.ts | 1 | 路由级 | 审计查询 |
| **db/d1/*.ts（6 个实现）** | **0** | — | **SQL 仓储层零测试**（所有 API 测试用 Memory 仓储） |

### 1.3 Web 前端侧（vitest，24 文件 167 用例）

- data 层逻辑单测 11 文件（client 3/channels 4/writeGuard 3/live 2/mode 7/hostOps 16/sites 10/backup 10/diagnostics 6/agent 8/forwards 8）——逻辑质量较好；
- 组件冒烟渲染 12 文件（多为 happy-path 渲染，`error: null`，错误/离线态断言少）；
- LoginForm.test.tsx 3 用例（正常提交/空口令禁用/错误信息），**未覆盖 429 提示与 token 过期跳转**；
- feedback.test.ts 3 用例（Banner tone→图标映射，PR #59 修复配套）。

## 2. 关键路径覆盖矩阵

| # | 关键路径 | 判定 | 测试层级 | 证据与缺口 |
|---|---|---|---|---|
| 1 | peer 密钥轮换 | **部分覆盖** | Agent 单测厚；API/跨层无 | Agent：`test_rotate_creates_pending_new_peer_only`、`test_rotate_wg_set_failure_does_not_persist_state`（内核 set 失败不落盘）、`test_concurrent_rotate_only_one_succeeds`、`test_pending_rotation_survives_other_peer_apply_syncconf`、`test_rollback_restores_conf_and_ports`、`test_apply_removing_peer_prunes_kernel_peer`（P1-A）。API：**grep rotate 零命中**，apps.test.ts 只测 client_config 透传；rotate 后面板 save 的 expectRev 冲突、rotate 结果在面板呈现无测试 |
| 1a | ├ D1 已写、Agent 未生效 | 有（路由级） | FakeAgent | apps.test.ts apply 失败不回写 appliedRev；smoke-offline-save 记 last_apply_error、恢复后补 apply（对应迁移 0004） |
| 1b | ├ 内核已改、面板未更新 | **无** | — | rotate 是 Agent 本地状态，面板读 /state 卡片，该链路无任何测试 |
| 2 | Agent 装卸/重装一致性 | **部分覆盖** | 单测厚、脚本薄 | 命令生成 29 用例扎实；upgrade 20 用例（sha mismatch 保留旧装、tar 穿越、重启失败恢复）；P1-A 卸载重装 peer 身份恢复有 166 行测试。**install.sh/uninstall.sh 真实行为**（幂等、token 保留、purge 范围、systemd 单元重建）仅 bash -n，无自动化 |
| 3 | 双通道切换/超时/降级 | **较好（单测层）** | 单测（mock） | node-client 7（切隧道/双败）、diagnostics 31（错误分类）、tcp-fetch 5（协议）、web channels 4 象限 + writeGuard 3、agent live 9（票据重放/过期、连接上限）。缺：超时时限本身、证书过期对直连通道、弱网抖动回切滞回、SSE 断线重连 |
| 4 | 防火墙安全网 | **单测覆盖好** | 单测（FakeRunner） | `test_apply_lockout_on_protected_port/hub_source`、`test_apply_lockout_proto_mismatch_is_allowed`（锁定误报，P1-B）、`test_confirm_persists_and_stops_timer`、`test_rollback_restores_previous_state`、`test_rollback_scheduler_failure_keeps_firewall`、`test_rollback_timer_uses_resolved_script_path`（P0-2）。60 秒为 fake clock；真实 nft 语义只能真机（host-ops-peer-e2e.sh 手动、E2E_WRITES=1） |
| 5 | D1 迁移与模型约束 | **无测试** | — | migrations 0001–0006 无顺序/幂等/重复执行测试；db/d1 6 实现 0 测试；SQL 与 schema 漂移只能生产暴露（0006 上线时"先迁移后部署"靠 runbook 约定，无 CI 防呆） |
| 6 | 认证/JWT/HMAC/限流 | **良好偏薄** | 单测 | Agent HMAC 15（公式、GET 空 body、篡改、过期/未来 ts、窗口边界、nonce 重放、多 token）；API auth 4——缺 cookie 过期/登出/篡改签名；限流 6（D1 计数、双级降级、429 集成）——缺窗口翻转边界、并发竞争、429 后恢复 |
| 7 | Hub 异常恢复 | **部分覆盖** | 单测 | 限流 D1 故障降级有测试；Worker 无状态重启天然低风险；D1 不可用时登录/节点列表等主路径行为无测试；证书为 Agent 侧 ACME（fallback 有测试），Worker 证书由 CF 托管不适用 |

## 3. 缺口与风险（按危害排序）

1. **D1/SQL 层完全无测试（最高危）**：全部 138 个 API 用例跑在 Memory 仓储上。列名漂移、约束错误、JSON 序列化不匹配
   会在部署后第一次读写才爆；线上症状为面板全量 500 或数据静默丢失（staging=生产，ADR-0008，无预演环境缓冲）。
2. **迁移无幂等/顺序防护**：0001–0006 重复执行或漏执行（如 0006 漏跑即部署）会触发限流表缺失 →
   限流 500/降级，或更糟：schema 与代码不一致。0006 上线已真实暴露过顺序依赖，目前只靠 runbook 文字约定。
3. **rotate_peer API 层与跨层一致性无测试**：轮换由面板触发走 apps.ts 透传，该入口零断言；轮换后用户在面板"保存并生效"
   新配置是否覆盖/保留 pending rotation，只有 Agent 侧证据，端到端无防护。症状：换钥后旧 peer 失联、面板显示与内核状态分叉。
4. **install.sh/uninstall.sh 仅语法检查**：多 agent 迭代改脚本（P0-2、P1-A 都动过）时，脚本回归只能真机人肉发现。
   症状：新装节点装不上、卸载残留 systemd 单元/私钥文件（安全残留）。
5. **会话生命周期与限流边界**：cookie 过期后行为、429 后窗口恢复、并发登录竞争无测试。症状：偶发登出/无法登录难复现。
6. **smoke 测试多数为 happy-path**："四态"规范中错误/离线态在多数页面无渲染断言（c3.smoke 仅 `error: null`），
   UI 改造回归靠人眼走查（audit-2026-11-02 就是这么发现 Banner 图标 P0 的）。
7. **真机不可模拟域无系统性回归**：systemd 沙箱（ProtectHome，P0-1 只能真机）、CF Worker→Agent 的 sockets 通道
   （裸 IP 403 error 1003 是历史实坑）、nft 真实语义、live SSE 弱网——目前依赖一次性手动验证，无固定演练脚本清单。

### 看似覆盖、实则无效的测试

- API 路由级测试的 FakeAgentClient 只断言"透传了请求 + 归一化了响应"，**真实 Agent 协议漂移**（字段改名、cards 结构变化）不会被它发现；缓解项：agent 侧 test_auth 有"契约公式对齐"用例，但 apps 侧 cards 归一化无 Agent 侧对应用例。
- node-client 的通道切换测试全部 mock fetch/socket，真实 CF 环境差异（sockets 连接超时、TLS 行为）测不到——历史上 error 1003 即此类。
- 部分 smoke 用例仅断言"渲染不抛错"，对状态带/抽屉关键交互无断言，UI 回归防线实际是人眼。

## 4. 补测方案（测试矩阵）

原则：**单测保逻辑，契约测试保双实现一致，真机脚本保环境事实，CI 跑前两者**。

| 优先级 | 补测项 | 层级 | 进 CI | 规模 | 验收 |
|---|---|---|---|---|---|
| P0-1 | D1 仓储契约测试：NodeRepo/AppConfigRepo/AuditRepo 等写一套共享契约用例，同时跑 Memory 与 db/d1（vitest + wrangler d1 --local 或 miniflare；如引依赖需先报批，可先用"迁移产物 schema 对照脚本"过渡） | 单测+集成 | 是 | 中 | db/d1 行为与 Memory 一致；SQL 漂移在 CI 即爆 |
| P0-2 | 迁移顺序/幂等脚本：本地 D1 按 0001→0006 执行两遍 + 断言表/列存在，并校验"代码引用的表 ⊆ 迁移产物" | 集成 | 是 | 小 | 重复执行零报错；漏迁移可被 CI 发现 |
| P0-3 | rotate_peer API 透传 + rotate 后 save/expectRev 冲突 2–3 例（apps.test.ts 补齐） | 单测 | 是 | 小 | rotate 入口有断言 |
| P0-4 | 会话生命周期：cookie 过期、登出、签名篡改（auth.test.ts 补齐） | 单测 | 是 | 小 | 会话边界有防护 |
| P1-1 | install.sh/uninstall.sh 脚本级测试：临时目录 + mock systemctl/wg（可测幂等、token 保留、purge 范围、白名单防逃逸），不依赖 root | 脚本单测 | 是 | 中 | 两个脚本有行为断言，不止 bash -n |
| P1-2 | 限流边界：窗口翻转、并发、429 后恢复（D1 路径） | 单测 | 是 | 小 | 边界与竞态有防护 |
| P1-3 | UI 错误/离线态渲染断言：按 page-specs 六类页面逐页补错误/离线/空态断言 | 组件测试 | 是 | 中（分批） | 四态不再靠人眼 |
| P1-4 | 真机演练清单固化：把 2026-11-02 端到端验证 + host-ops-peer-e2e.sh 整理为可重跑 runbook（沙箱/双通道断网/防火墙 60s 锁定/卸载重装 peer/升级回滚），按需手动，结果记录 docs/archive/audit-2026-11-02/server-test/ | 真机集成 | 否（手动） | 中 | 每次发版前可执行 |
| P2-1 | contracts 包独立 zod 单测 | 单测 | 是 | 小 | 契约边界自证 |
| P2-2 | node-client 超时/滞回参数化测试 | 单测 | 是 | 小 | 弱网策略可调可证 |

**必须真机验证（单测永远无法覆盖）**：systemd 沙箱效果（ProtectHome/ReadWritePaths）、nft 真实语义与 60 秒锁定实弹演练、
CF Worker→Agent sockets 通道（含裸 IP 403 坑）、live SSE 弱网断连、卸载→重装 peer 身份恢复、升级失败 systemd 回滚、D1 生产迁移（先迁移后部署）。

## 5. 总体判断

- **数量够、结构偏**：1062 个用例对纯逻辑层（Agent 适配器、防火墙护栏、HMAC、通道编排）覆盖扎实，五项 P0/P1 修复全部带测试；
- **最薄的三层**：D1/SQL 实现层（零测试）、迁移防护（零）、真机环境事实（无固定演练）；
- 结论：**单测层"够用"，架构层"不够用"**——风险集中在 Memory mock 与真实世界之间的那道缝上。
