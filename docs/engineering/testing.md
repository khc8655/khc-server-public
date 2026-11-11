# 测试与验收规范

> 状态：现行（强制） ｜ 适用范围：测试分层、功能覆盖矩阵、发版类型必测项、真机验收与缺口计划 ｜ 最后核验：2026-11-08（补齐功能矩阵与发版类型矩阵） ｜ 关联：`./scripts/verify.sh`、`docs/engineering/release.md`、`docs/auto-deploy.md`、`docs/release-versioning.md`、`.github/workflows/ci.yml`

本文回答三个问题：**平台有哪些功能要测、每一层怎么测、不同类型的发版分别必须跑哪些测试**。所有数量以实跑为准，不在文档里写死“应有 N 个用例”。

## 1. 现状快照（2026-11-08）

| 资产 | 位置 | 规模 | 说明 |
|---|---|---|---|
| Worker / 契约单测 | `apps/api/test/`、`scripts/test/` | 35 + 2 个文件 | Hono 路由、D1 仓库、HMAC/加密、传输、慢请求/并发隔离、并发 apply、发布链 |
| Web 组件/路由测试 | `apps/web/src/**/*.test.ts(x)` | 38 个文件 | 纯函数 + jsdom smoke（内存路由 + fetch mock） |
| Agent 单测 | `agent/tests/test_*.py` | 27 个文件 | 内核、适配器、任务、回滚、安装/升级逻辑（含 0.1.30–0.1.32→0.1.33 升级矩阵） |
| 本地全量门禁 | `./scripts/verify.sh` | 12 个步骤 | typecheck、vitest、build、compileall、Agent 单测、发版一致性、包留存、catalog drift、D1 迁移、安装器生命周期、shell 语法 |
| CI 门禁 | `.github/workflows/ci.yml` | 3 个 job | Agent 单测 / typecheck+vitest+build+D1 迁移+发版一致性+包留存 / 生产部署前后校验 |
| 测试脚本 | `scripts/*-test.sh`、`scripts/caddy-tls-modes-e2e.sh` | 6 个 | host-ops 端到端、安装器预检/用户模式/系统模式、D1 迁移、Caddy TLS 四模式 |
| 手工验收 | `docs/verification/**`、PR 自检清单 | 按批次 | 真机证据、截图、回归结论 |

**结论**：纯函数、适配器逻辑、慢状态隔离、升级矩阵、安装器双模式、Caddy TLS 四模式与 D1 迁移前向兼容已覆盖；真实公网 ACME、真实内核/设备、浏览器交互仍是主要缺口（见 §8）。

## 2. 平台功能清单（测试对象）

### 2.1 四个发布单元

| 发布单元 | 代码入口 | 产物 | 版本规则 |
|---|---|---|---|
| Worker 控制面 | `apps/api/src/` | Cloudflare Worker + assets | `package.json` version + CHANGELOG |
| Web 面板 | `apps/web/src/` | 静态 assets（随 Worker 部署） | 同上 |
| Agent 内核 | `agent/khc_agent.py`、`agent/khc/` | `khc-agent-<VERSION>.tar.gz`（签名清单） | `agent/khc/util.py` VERSION |
| 应用适配器 | `agent/adapters/*.py` | 随 Agent 包 | 随 Agent VERSION |
| 数据模型 | `migrations/0001–0011` | D1 schema（只增不改） | 迁移文件序号 |

### 2.2 功能矩阵

| # | 功能域 | 关键能力 | 代码入口 | 主要测试层 | 现有覆盖 | 风险 |
|---|---|---|---|---|---|---|
| 1 | 登录与会话 | 口令登录、session 过期、TOTP、限流 | `routes/auth.ts`、`lib/session|crypto` | L1/L2/L3 | 较全 | 中 |
| 2 | 节点接入 | IP 直连 / 域名 HTTPS / Tunnel、探活、改接入、删除 | `routes/nodes.ts`、`AccessForm` | L1/L2/L3/L6 | 较全 | 高 |
| 3 | 状态观测 | `/state` 一次性探测、10s 快照、直连/转发、停表手动刷新 | `routes/snapshot|live.ts`、`data/snapshot.ts` | L1/L2/L3/L6 | 中 | 高 |
| 4 | 应用配置 | 保存（纯 D1）、plan/apply/rollback、rev/appliedRev、失败回滚 | `routes/apps.ts`、`lib/agent-commands` | L2/L4/L6 | 中 | 高 |
| 5 | Caddy 站点 | 反代/静态/重定向、TLS 四模式、端口、健康、启停/校验/重载、接管外部配置 | `adapters/caddy_site.py`、`apps/caddy/` | L1/L4/L3/L6 | 中 | 高 |
| 6 | 证书 | 自签/ACME 签发、inspect、安装到 Agent TLS、续期、到期诊断 | `adapters/certificates.py`、`routes/certs.ts` | L1/L4/L2/L6 | 中 | 中 |
| 7 | WireGuard | 接口、Peer CRUD、配置导出、换钥生命周期、迁移、状态解析 | `adapters/wireguard.py`、`apps/wireguard/` | L1/L4/L3/L6 | 较全 | 高 |
| 8 | 端口转发 | 规则 CRUD、端口冲突、socat systemd、应用/回滚 | `adapters/port_forward.py`、`ForwardsCard` | L1/L4/L3/L6 | 较全 | 中 |
| 9 | 主机运维 | 服务/进程/文件/防火墙/SSH 公钥/cron、异步任务、护栏 | `adapters/host_ops/`、`apps/host-ops/` | L1/L4/L3/L6 | 中 | 高 |
| 10 | 诊断 | 7 核心码、适配器 problems、证书到期、排序/截断/脱敏 | `lib/diagnostics/*`、`routes/diagnostics.ts` | L1/L2/L3/L4 | 较全 | 中 |
| 11 | 双模式 | 预检阻断/警告、切换、收敛等待、影响摘要 | `lib/mode.ts`、`routes/mode.ts` | L1/L2/L3/L6 | 中 | 高 |
| 12 | Agent 生命周期 | 安装/卸载/升级命令、签名校验、拉取升级、看门狗、回滚 | `routes/agent_lifecycle.ts`、`lib/agent-commands.ts` | L1/L2/L4/L5/L6 | 中 | 高 |
| 13 | Cloudflare DNS | 多凭据、Token 只写不读、Zone、记录增改删、节点代建/联动删除 | `routes/cfDns.ts`、`lib/cf-dns.ts` | L1/L2/L3 | 较全 | 中 |
| 14 | Tunnel 配置 | 全局隧道 CRUD、Token 密文、被引用禁删 | `routes/tunnels.ts` | L1/L2/L3 | 较全 | 低 |
| 15 | SSH 公钥库 | 规范化、SHA256 指纹、重复 409、引用 | `routes/sshKeys.ts` | L1/L2/L3 | 较全 | 低 |
| 16 | 备份/恢复 | 节点配置导出、导入预览/冲突/覆盖 | `routes/backup.ts`、`data/backup.ts` | L1/L2/L3 | 中 | 中 |
| 17 | 发布链 | 包构建、签名清单、sha 校验、留存上限、版本门禁、catalog drift | `scripts/*.mjs`、`agent/package.sh` | L5 + CI | 较全 | 高 |
| 18 | 安全边界 | HMAC 重放/时间窗、写盘白名单、符号链接、密钥 0600、零凭据回显 | 跨层 | L1/L2/L4/L6 | 中 | 高 |

## 3. 测试分层与执行方式

### L0 静态与一致性（每次提交必跑）

| 项 | 命令 | 覆盖 |
|---|---|---|
| TypeScript 类型 | `pnpm typecheck` | 3 个 workspace 包 |
| Python 编译 | `python3 -m compileall -q agent` | 语法/导入 |
| Shell 语法 | `bash -n agent/install.sh …` | 全部安装/部署脚本 |
| Agent 发版一致 | `node scripts/verify-agent-release.mjs --repo` | VERSION ↔ 包 ↔ 签名清单 |
| 面板发版一致 | `node scripts/check-release-consistency.mjs --repo` | package.json ↔ CHANGELOG |
| 包留存 | `node scripts/prune-agent-packages.mjs --check` | 只保留清单版 + 最近 N-1 |
| Catalog 漂移 | `node scripts/gen-app-catalog.mjs --check` | 应用目录生成结果与仓库一致 |

### L1 契约 / 纯函数（`pnpm test`）

- 契约：`packages/contracts/src/index.ts` 的 zod schema 正反例、默认值、枚举。
- 纯函数：传输选路、TCP 响应解析、HMAC、加密/脱敏、站点 render/validate、WireGuard 状态解析、端口冲突、诊断排序/截断、快照合并、筛选/排序工具。
- 要求：不依赖网络、D1、root、真实二进制；输入输出可枚举。

### L2 Worker API 集成（`apps/api/test/`）

- 使用 `makeTestContext` + 注入 `cfFetch` / `fetchImpl` / `tcpFetchImpl`，走真实 Hono 路由。
- 每个新端点至少覆盖：**成功、参数校验失败、未授权、资源不存在、Agent 不可达**。
- D1 仓库测试必须覆盖：唯一约束、事务/批量写、迁移后字段默认值。
- 传输测试必须覆盖：fetch/TCP 双通道、超时、非 JSON、Content-Length/chunked/close、cooldown 去重。

### L3 Web 组件 / 路由（jsdom smoke）

- 使用内存路由 + `vi.stubGlobal('fetch')`，从真实 URL 进入页面，不直接渲染内部组件（除非纯组件）。
- 每页至少覆盖：首屏正常、空态、加载态、错误态、离线禁用、主操作成功后的列表/抽屉刷新。
- 交互范式回归：唯一抽屉、L2/L3 确认、SaveBar、行内按钮 ≤2、无“抽屉上叠 Dialog”。
- 复杂状态派生（channels、snapshot、writeGuard）必须有纯函数单测，不靠 UI 断言。

### L4 Agent 单测（`agent/tests/`）

- 注入 `RecordingRunner` / mock downloader / 临时 data 目录，绝不执行真实 `systemctl`、`wg`、`caddy`。
- 每个适配器必须覆盖：`render` 纯函数、`validate` 正反例、`plan` diff、`apply` 成功、`apply` 失败回滚、幂等、任务状态、`status().problems`。
- 内核必须覆盖：HMAC、时间窗/重放、版本闸门、任务取消、升级校验、状态快照。
- 安装器：`scripts/install-preflight-test.sh` 覆盖 `--check` 的 PASS/WARN/FAIL 分支；`scripts/install-lifecycle-test.sh` 用临时 HOME 覆盖用户模式安装/重装/卸载/`--purge`；`scripts/install-system-test.sh` 在专用 Linux/容器以 root 覆盖系统模式落位与清理（需显式执行，不进入默认 verify）。

### L5 发布链（CI + 本地）

- Agent：`VERSION` bump → `agent/package.sh` 出包 → `build-agent-release.sh` 签名 → `release-manifest.json` → `verify-agent-release.mjs --repo`。
- 面板：`package.json` version + `CHANGELOG` 对应版本段 → `check-release-consistency.mjs`。
- 包留存：`prune-agent-packages.mjs --check`。
- 部署链（CI）：`versions upload` 预览冒烟（health/version）→ 拓扑闸门（`workers_dev` 与 `/cdn-cgi/trace`）→ 部署 → 生产入口 health/version → 线上包 sha256 → release tag。

### L6 真机 E2E（按发版类型触发）

| 场景 | 环境 | 通过标准 |
|---|---|---|
| 节点接入 | 测试 Hub（IP/域名/Tunnel） | 安装后 5s 内 `/state` 可达，面板状态与真机一致 |
| 应用 apply | 测试 Hub + 真实 Caddy/WireGuard/socat | plan diff 正确、apply 后服务/端口/文件生效、失败回滚 |
| Peer / 转发 | 测试 Hub + 独立 Peer | 握手、ping、`ssh -p`、外网 200 |
| host-ops | `scripts/host-ops-peer-e2e.sh` | 读/写/护栏/自动回滚全过，缺 Peer 明确 SKIP |
| 安装器（系统模式） | 专用 Linux/容器（root） | `install-system-test.sh`：落位/幂等/卸载/`--purge` 全过 |
| Caddy TLS 四模式 | 有 caddy 的 Linux/容器 | `caddy-tls-modes-e2e.sh`：off/manual/internal 实际访问 200，auto validate 通过 |
| D1 迁移 | 本地 wrangler D1 | `d1-migration-local-test.sh`：顺序/幂等/存量数据前向兼容 |
| 升级 | N-1 → N | 拉取升级、服务重启、配置与证书保留、可回滚 |
| 清理 | 测试机 | 进程/端口/目录/unit/DNS/公钥/站点/Peer/转发全部删除 |

### L7 UI 与机型（UI 改动必做）

- 浅色 / 深色 / 390px 三组截图；空/加载/错误/离线四态说明。
- 键盘可达、焦点可见、danger 操作二次确认、术语统一（`ui-guidelines.md` §8.6）。
- 不在测试里做像素级视觉断言；视觉走查证据放 PR 或 `docs/verification/YYYY-MM-DD/`。

### L8 非功能（当前以手工为主）

- 性能：`/state` 目标 < 2s、10s 快照不叠加、页面首屏无长阻塞。
- 稳定性：慢节点/断网/Agent 重启/Tunnel 断开时 UI 不误报“永久离线”。
- 安全：401/403、HMAC 重放、错误零凭据回显、密钥 0600、写盘白名单。
- 并发：同一节点多标签页、同时 apply、重复点击。

## 4. 分模块必测用例清单

> 下表是“最低必测”，不是穷举；新增能力按同一形状补行。

### 4.1 登录与会话

| 用例 | 期望 |
|---|---|
| 正确口令 | 200 + session cookie，跳转 `/` |
| 错误口令 | 401，内联错误，不泄露细节 |
| 连续失败 | 触发限流（次数/窗口与实现一致），响应稳定 |
| session 过期 | 401 → 重新登录，写操作不静默成功 |
| TOTP 开启/关闭 | 开启后登录需动态码；错误码拒绝；恢复码/关闭流程正确 |
| 写请求缺 Origin/JSON | 按写守卫拒绝（若启用），错误可读 |

### 4.2 节点接入

| 用例 | 期望 |
|---|---|
| IP 直连创建 | endpoint 为 `http://IP:8880`，明文风险确认后可提交 |
| 域名 HTTPS 创建 | 只能选已有 DNS 记录，端口按协议推导（443） |
| Tunnel 创建 | 只带 `tunnelId`，对外地址自动生成 |
| 探活成功/失败 | 成功更新列表状态与 lastSeen；失败给 3 条排查提示 |
| 改接入方式 | 保存后入口地址切换，旧入口失效；离线时仍可保存 |
| 删除节点 L3 | 必须输入节点名；勾选联动删除 DNS；卸载脚本可复制 |
| DNS 代建 | IP 节点创建后自动建 A/AAAA；失败不阻断节点创建 |
| 同名/冲突记录 | 置灰并说明原因，不静默共用域名 |

### 4.3 状态观测

| 用例 | 期望 |
|---|---|
| 直连快照 | 有 HTTPS 域名时浏览器直连 Agent，10s 一帧 |
| 转发快照 | 无域名时经 Worker `/snapshot`，2s 去重 |
| 多标签页 | BroadcastChannel 只允许 leader 发请求 |
| 停表 | 达到上限后显示“已停止自动刷新 · 截至时间”，提供“手动刷新” |
| 降级 | 直连失败回退控制面快照，并给出原因 |
| 控制面探测失败但快照正常 | 显示“仅观测可达/未确认”，不误报永久离线 |
| `/state` 慢/超时 | 页面可重试，不把未返回当离线；其他节点不受影响 |

### 4.4 应用配置与执行

| 用例 | 期望 |
|---|---|
| 保存 | 仅写 D1，`rev+1`，`appliedRev` 不变；离线也允许 |
| plan | 返回 diff，不落盘 |
| apply 成功 | 任务完成，`appliedRev=rev`，页面同步失效 |
| apply 失败 | 返回错误码/日志，自动回滚到原文件/原服务，`lastApplyError` 可诊断 |
| 重复 apply | 幂等键命中，响应一致，`exec_counter` 不重复累加 |
| 节点缺适配器 | 诊断报 `agent.state_invalid`，不假装成功 |
| 删除/卸载 | 文件、unit、端口、状态全部清理 |

### 4.5 Caddy / 证书

| 用例 | 期望 |
|---|---|
| 三种站点类型 | proxy/static/redirect render 正确，非法组合被拒 |
| TLS 四模式 | auto/manual/internal/off 的监听与访问方式符合定义 |
| `tls=off` 健康探测 | 连 `127.0.0.1:<端口>` + `Host`，DNS 未就绪不误报 down |
| 端口冲突 | 同机同端口被拒绝，提示冲突对象 |
| 启动/重载/校验 | validate 失败不启动；成功后抽屉状态刷新 |
| 接管外部配置 | 扫描分类正确，接管/恢复可逆，备份存在 |
| 自签/ACME | 签发、inspect、安装到 Agent TLS、热重载、到期续期 |
| 证书绑定 | 明文节点拒绝 bind；域名节点安装后 HTTPS 生效 |

### 4.6 WireGuard / 端口转发

| 用例 | 期望 |
|---|---|
| 接口校验 | 名称/地址/CIDR/端口非法被拒 |
| Peer CRUD | 新增/改名/禁用/删除，导出 .conf 与一键脚本 |
| 换钥生命周期 | pending → cutover → confirm/cancel，超时可恢复旧钥 |
| 配置迁移 | 跨节点迁移后 Peer 地址/路由正确 |
| 状态解析 | `wg show` 多 Peer、离线、握手时间解析正确 |
| 端口转发 | 冲突/保留端口被拒；apply 后 systemd active；卸载清理 |
| 真机转发 | `ssh -p <端口>` 到达 Peer，socat 缺失时提示清晰 |

### 4.7 主机运维

| 用例 | 期望 |
|---|---|
| 服务列表/日志/重启 | 读正常；重启走 L2；受保护服务禁用 |
| 进程列表/结束 | 结束走确认；受保护进程/PID 1 拒绝 |
| 文件读写 | 白名单内可写；符号链接/越权路径拒绝 |
| 防火墙/公钥/cron | 变更可回滚；受限公钥只能执行允许命令 |
| 异步任务 | 进度/取消/失败/超时状态正确，页面可刷新 |

### 4.8 诊断 / 双模式 / 生命周期

| 用例 | 期望 |
|---|---|
| 7 核心码 | 每个码有正例与误报防护（超时、401、时钟、版本、结构、待应用） |
| 适配器 problems | 上报后渲染为 `khc.<app>.<code>`，不占用核心码 |
| 排序/截断/脱敏 | error→warn→info；≤30 条；日志/令牌不出现明文 |
| 模式预检 | 阻断 4 类（换钥/端口/未应用/Caddy 未运行），警告进影响摘要 |
| 模式切换 | 应用后 60s 内收敛；失败给出可执行修复 |
| 安装命令 | 域名+HTTPS 自动带 `--acme`；裸 IP+HTTPS 明确阻断 |
| 升级 | 签名/sha 校验失败拒绝；成功保留配置与证书；可回滚到旧版本 |

### 4.9 发布链

| 用例 | 期望 |
|---|---|
| Agent 改了但未 bump | `verify-agent-release --diff` 失败 |
| 面板改了但未 bump/CHANGELOG | `check-release-consistency --diff` 失败 |
| 包与源码不一致 | `--repo` 失败 |
| 清单签名/sha 不匹配 | `verify-agent-release` 失败 |
| 历史包超限 | `prune --check` 失败 |
| CI 部署 | 预览冒烟、拓扑闸门、生产溯源、线上包 sha、release tag 全过 |

## 5. 发版类型 → 必测矩阵

| 类型 | 典型改动 | 版本要求 | 自动必跑 | 真机/E2E | 上线前 | 证据 |
|---|---|---|---|---|---|---|
| **D 文档/注释** | `docs/**`、README | 不需要 bump | `verify.sh`（至少 shell 语法） | 否 | 无 | PR 链接 |
| **U 文案/样式** | i18n、tokens、CSS、纯展示 | 面板 bump + CHANGELOG（改了 `apps/web/src`） | typecheck + vitest + build | 涉及交互时 1 台测试 Hub | 浅/深/390 截图 | PR 自检清单 |
| **W 面板逻辑** | `apps/web/src` 数据/页面 | 面板 bump + CHANGELOG | `verify.sh` 全量 | 至少 1 台测试 Hub 走主链路 | 版本预览 URL 冒烟 | 交互录屏/截图 + 断言 |
| **A Worker/契约/D1** | `apps/api`、`packages/contracts`、`migrations` | 面板 bump + CHANGELOG（D1 只增迁移） | `verify.sh` 全量 + 迁移测试 | 1 台测试 Hub + 1 台 Peer | 预览冒烟 + 迁移核对 | 路由测试 + D1 前后查询 |
| **G Agent 适配器/内核** | `agent/adapters/*`、`agent/khc/*` | `VERSION` bump + 出包签名 + CHANGELOG | `verify.sh` 全量 + 发版一致性 | **必须**：目标适配器真机 plan→apply→回滚→卸载 | 先升级 1 台测试节点 | 真机命令输出 + 状态截图 |
| **P 安装器/发布包/签名** | `install.sh`、`package.sh`、`scripts/*release*` | Agent bump + 新包 + 清单 + prune | `verify.sh` + `install-preflight-test.sh` | 干净 Debian/Ubuntu 各 1 台 | 新包 `--check` + 真机安装 | 安装日志 + sha/签名核验 |
| **X 跨层/架构** | 契约 + Worker + Web + Agent | 双版本 bump | `verify.sh` 全量 + 兼容矩阵 | 全部关键链路 | 预览版本 + 测试 Hub/Peer | 验收报告 + 回滚演练 |
| **H 紧急热修** | 单点故障 | 同对应类型 | 最小相关测试 + `verify.sh` | 复现环境回归 | 预览冒烟 | 复现用例 + 修复前后对比 |

### 5.1 每次发版固定 8 步

1. 明确发版类型（上表）并确认版本 bump / CHANGELOG / Agent 包。
2. 跑 `./scripts/verify.sh` 全绿（本地全量，CI 是其子集）。
3. 按类型补做真机/E2E；修复 bug 必须先有失败测试。
4. UI 改动附浅/深/390 截图与四态说明。
5. `npx wrangler versions upload` → 预览 URL 冒烟（health/version）。
6. 部署（main 推送由 CI 执行；本地兜底 `deploy-local.sh`）。
7. 部署后核对：`/api/v1/version` 的 commit/versionId、线上 Agent 包 sha256。
8. 记录证据；清理测试残留；更新相关文档与 CHANGELOG。

## 6. 测试环境与数据

- **生产 = staging 同一 Worker/D1（ADR-0008）**：不存在独立预发环境，上线前靠版本预览 URL 冒烟。
- **允许改动的测试节点**：测试 Hub、测试 Peer、`node-test-2`（按主人约定）；`node-prod-1` 等生产节点只读观察，禁止改配置。
- **命名**：测试资源统一 `ux-*` / `e2e-*` 前缀（节点、站点、Peer、转发、DNS、SSH 公钥），便于清理。
- **清理清单**：节点/隧道、DNS 记录、SSH 公钥、站点、Peer、端口转发、Agent 进程/unit、测试 HTTP 服务、acme.sh/cron、临时目录。
- **禁止**：测试依赖 root（除明确标注的真机步骤）、访问外网第三方 API（用注入 mock）、把真实凭据写进仓库/日志。

## 7. 缺陷回归与用例补充规则

1. **先复现再修**：bug 必须先补一个会失败的测试，再改代码。
2. **线上事故补门禁**：每起 P0/P1 事故至少补一条自动门禁或检查清单项（例：`workers_dev=false` 事故 → 部署拓扑闸门）。
3. **误报也是缺陷**：诊断/健康检查的假阳性必须有“正常场景不报警”的用例（例：零站点 Caddy 未运行、acme.sh 在非 PATH）。
4. **flaky 隔离**：不稳定用例标记原因并限期修复，不允许长期 `skip` 掩盖。
5. **测试与实现同 PR**：不允许“先合代码、后补测试”。

## 8. 已知缺口与补充计划

### P0（2026-11-08 已补齐）

| 项 | 覆盖方式 | 证据 |
|---|---|---|
| `/state` 慢或并发时 `reachable` 抖动 | `apps/api/test/state-slow.test.ts`：预算内慢响应、超时标记、慢节点不阻塞、失败不写 `lastSeenAt` | 3 项集成测试 |
| Agent 升级 N-1 → N | `agent/tests/test_upgrade.py`：0.1.30/0.1.31/0.1.32→0.1.33，配置/端口/证书/任务保留与旧版本回滚 | 升级矩阵用例 |
| 安装器系统模式（root/systemd 落位） | `scripts/install-system-test.sh`（专用 Linux/容器）；用户模式由 `install-lifecycle-test.sh` 覆盖 | 测试机实跑 23 项 + verify 22 项 |
| Caddy TLS 四模式 | `scripts/caddy-tls-modes-e2e.sh`：off/manual/internal 实际访问，auto 配置校验 | 测试机实跑 7 项 |
| D1 迁移在真实 SQLite/D1 语义下的前向兼容 | `scripts/d1-migration-local-test.sh`（wrangler local D1）+ `migrations.test.ts` | 脚本 38 项；CI 已接入 |
| 并发 apply / 重复点击 | `apps/api/test/apps-concurrency.test.ts`：同/异幂等键、成功+失败并发 | 3 项集成测试 |

> 仍需人工/生产侧执行：把迁移应用到 remote D1（先导出备份）、真实公网域名下的 ACME 自动签发。这两项属于发布操作，不是代码测试缺口。

### P1（覆盖明显不足）

| 缺口 | 建议用例 |
|---|---|
| Cloudflare DNS/Tunnel 真实 API | 录制/回放 fixture + 可选 `CF_TOKEN` 的 opt-in 契约测试（权限不足/冲突/分页） |
| WireGuard 换钥真实内核 | 真机 pending→cutover→confirm/cancel + 超时恢复 |
| host-ops 全动作 E2E | 扩展现有脚本：文件/防火墙/cron/受保护单元负例 |
| 多标签页/断网恢复 | BroadcastChannel leader、停表恢复、离线保存后回上线 |
| 限流跨 isolate | 基于 D1 的固定窗口并发测试 |
| 浏览器交互自动化 | 关键路径（登录→建节点→发布站点→Peer→转发）用真实浏览器脚本回归 |
| 性能预算 | `/state` P95、10s 快照请求量、首屏 bundle 大小阈值 |

### P2（体验与长期质量）

| 缺口 | 建议用例 |
|---|---|
| 视觉回归 | 浅/深/390 关键页截图对比（允许阈值） |
| 可访问性 | 键盘走查、焦点顺序、对比度、表单 label |
| i18n 完整性 | 所有 `zh.*` key 被引用、无硬编码中文 |
| 混沌测试 | apply 中途杀 Agent、D1 写失败、Tunnel 断开 |
| 多节点规模 | 20/50 节点概览与快照负载 |

## 9. 验收清单（复制到 PR / 验收报告）

```text
[ ] 发版类型已判定：D / U / W / A / G / P / X / H
[ ] ./scripts/verify.sh 全绿
[ ] 版本 bump：面板 package.json / Agent VERSION（按类型）
[ ] CHANGELOG 已更新
[ ] 新增/修改功能有对应测试（bug 先有失败用例）
[ ] Agent 改动：新包已出、已签名、manifest 已更新、prune 通过
[ ] UI 改动：浅/深/390 截图 + 空/加载/错误/离线四态
[ ] 真机/E2E：按 §5 矩阵完成并留存命令输出
[ ] 预览版本 health/version 冒烟通过
[ ] 部署后 version/commit/versionId 与线上 Agent 包 sha256 核对通过
[ ] 测试残留已清理（节点/DNS/公钥/站点/Peer/转发/进程/unit）
[ ] 回滚方案明确（旧 Agent 包 / 上一提交 / D1 迁移只增）
```
