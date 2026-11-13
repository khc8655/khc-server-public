# 主机诊断增强与面板终端（提案）

> 状态：已拍板（2026-11-13，按推荐值）；§8 评审增补待拍板 ｜ 最后核验：2026-11-13（main `8779452`） ｜ 关联：`docs/diagnostics.md`、ADR-0007、`docs/security-boundaries.md`

> **执行者须知**：§7 已记录主人的决定。批次 1–3 已批准、可直接开工（§6），互不依赖，一个批次一个 PR。批次 4（面板终端）已原则批准，但**被 §7 第 6 条阻塞**——必须先在生产面板启用 TOTP 并由主人确认后才能开工；在此之前不要动批次 4 的代码。发现提案与代码不符时，在 PR 里提出，由规划者改提案，不要自行扩大范围。**§8 是评审后的增补，逐条拍板前一律不实施**；拍板后由规划者把结论并入 §6、§7，执行者以 §6、§7 为准。

## 1. 背景

主人提出两个目标：

1. 提升诊断：能发现常见的系统级问题（磁盘满、内存不足、OOM 杀进程、服务崩溃等），不只是连接与应用问题。
2. 通过面板以 SSH 的方式在节点上安装软件，包括带交互菜单的第三方一键脚本。

主人提供了一份外部方案（`khc_server_public_best_architecture_plan.md`，未入库）。§2 是对它的审查，§3 起是本提案。

## 2. 外部方案审查

方向基本可取：不引入外部监控组件、沿用 Agent 纯标准库、复用 `caddy-site` 发布站点。但它对现有代码的多处描述与事实不符，按原样执行会失败或越过已有的安全边界。

| 外部方案的说法 | 实际情况（main `8779452`） | 影响 |
|---|---|---|
| 进程 CPU% 加「连续超限计数」即可识别持续高占用 | `khc_host.py` `_collect_processes_proc` 的 CPU% 是「进程累计 CPU 时间 ÷ 系统开机时长」，不是瞬时值；新启动的高占用进程会显示得很低 | 在这个值上做计数没有意义；需要先改成两次采样求差 |
| 计数器挂在 `/snapshot` 和 SSE 上持续判定 | 快照只在页面可见时每 10 秒拉一次，SSE 已停用（ADR-0010）；关掉页面就没有采样 | 「持续 N 次超限」只在有人看着页面时成立 |
| 用 Worker Cron 每 5 分钟巡检并告警 | `AGENTS.md` §1 明确「不做 Cron」 | 需要主人单独决定是否放开 |
| 在 Agent 的 `live.py` 里 `pty.fork()` 起 bash 跑一键脚本 | Agent 运行在 systemd 沙箱里（`ProtectSystem=full`、`ProtectHome=read-only`），子进程继承沙箱：`/usr`、`/etc` 只读 | 绝大多数安装脚本会因写不了 `/usr`、`/etc/systemd/system` 而失败；必须用 `systemd-run` 跳出沙箱（`upgrade.py` 已有先例） |
| 复用 host-ops 的私钥 `ssh -tt` 直接进入 Peer 终端 | Peer 上的授权公钥是 `restrict,command="sudo -n /usr/local/sbin/khc-host",from=<Hub WG IP>`（`host_ops.py:912`），只能执行受限脚本，拿不到 shell | Peer 终端走不通，这正是 ADR-0007 的设计目的 |
| 终端能穿过 Worker 代理和 Tunnel | Worker 只转发 `GET /nodes/:id/snapshot`；浏览器直连节点只适用于 HTTPS 入口（域名或 Tunnel）。IP 直连节点是明文 http，HTTPS 面板直接访问会被浏览器拦截（混合内容） | 终端只能覆盖域名和 Tunnel 节点 |
| Cloudflare `connect()` 不能连 22 端口 | Cloudflare 文档只禁止 25 端口和 Cloudflare 自身 IP 段 | 外部方案对路径 B 的否定理由不成立，但路径 B 仍需把 sshd 暴露公网并在面板保存 SSH 凭据 |
| 用正则抓取终端里的账号密码，存进 `app_configs` 的摘要字段 | 迁移 `0012` 明确规定 `summary_json` 禁止写入密码；正则抓取在不同脚本上命中率不可控 | 不能这样存；凭据要么不落库，要么走加密存储 |
| 前端嵌入 xterm.js | `ui-guidelines.md` §9 明确禁止新增「终端模拟器」类运行时依赖 | 需要主人拍板解除 |
| 诊断里加 Web 终端 | `docs/diagnostics.md` §7「明确不做：Web Shell、任意命令」；ADR-0007 的边界是「Hub 失陷也拿不到交互式 shell」 | 终端是一次安全边界的方向性改变，必须新写 ADR |

**结论**：诊断增强可以做，而且大部分数据已经在 `/state.ops` 里，成本低。面板终端技术上可行，但它会让「面板登录 = 所有开启终端的节点的 root」，这是这个项目迄今最大的一次安全边界变化，需要主人明确接受并配套前置条件（§4.2）。

## 3. 诊断增强

### 3.1 现状

- 诊断只有两个来源：核心 7 码（连接与 Agent）和适配器 `status().problems`（应用问题），外加 Worker 侧的证书补充（`app-diagnostics/certificates.ts`）。
- `/state.ops` 已经采集了内存与 swap、CPU、磁盘与 inode、监听端口、failed systemd 单元（最多 10 个）、是否需要重启，但诊断**没有使用**这些数据。主机运维页能看到数字，诊断却不会提示「磁盘快满了」。

### 3.2 方案对比

| 方案 | 做法 | 改动面 | 结论 |
|---|---|---|---|
| A Worker 侧派生 | 新增 `apps/api/src/lib/app-diagnostics/host.ts`，从 `/state.ops` 派生主机问题，形状与证书补充一致 | 只改 Worker；Agent 只为新增指标补字段 | **推荐** |
| B Agent 侧上报 | 在 host-ops 适配器 `status().problems` 里判定 | 每次改阈值都要发 Agent 版本；Peer 节点无本地适配器 | 不推荐 |

### 3.3 新增的主机问题（`khc.host.*`）

| code | 严重度 | 判定 | 数据来源 |
|---|---|---|---|
| `disk_full` | warn ≥ 85%，error ≥ 95% | 根分区或数据目录的空间或 inode 使用率 | 已有 `ops.disks` |
| `memory_low` | warn | 可用内存 < 10% 且 swap 使用率 > 50%（无 swap 时只看内存 < 5%） | 已有 `ops.memory` |
| `units_failed` | warn | 存在 failed 单元；evidence 列出前 5 个名字；受管单元（caddy、`khc-*`、`wg-quick@*`）由对应适配器已报的不重复报 | 已有 `ops.services.failedUnits` |
| `reboot_required` | info | 系统提示需要重启（内核更新等） | 已有 `ops.rebootRequired` |
| `oom_killed` | warn | 24 小时内发生过内核 OOM 杀进程 | **新增**：Agent 读 `/proc/vmstat` 的 `oom_kill` 计数，与数据目录里记录的上次值比较，上报 `ops.oom = {total, lastIncreaseAt}`；不起子进程 |
| `fs_readonly` | error | 根文件系统被内核改为只读 | **新增**：Agent 读 `/proc/mounts`，上报 `ops.rootReadonly` |
| `memory_pressure` | warn | 内存压力 `/proc/pressure/memory` 的 `some avg60` > 20 | **新增**：可选字段，旧内核没有该文件时不上报 |

规则：

- 全部只读，阈值写在 `host.ts` 一处；没有一键修复，hint 写清手工处理方法和对应的主机运维页面位置。
- 新增字段在契约中都是可选的，旧 Agent 不上报时对应检查自动跳过。
- `lib/diagnostics/` 核心目录不改，核心 7 码不变。

### 3.4 进程 CPU 显示修正

主机运维进程列表的 CPU% 改为两次采样求差（间隔 0.5 秒）：同一请求内先读一次 `/proc/[pid]/stat`，等 0.5 秒再读一次。这修正当前显示偏低的问题，代价是该请求多 0.5 秒。改在 `khc_host.py`，需要升 `SCRIPT_VERSION` 和 Agent 版本。

不做「持续高占用」计数：拉取模式下没有持续采样，计数结论不可靠。

### 3.5 近期系统错误日志（按需查看）

主机运维页新增只读的「系统错误」分段，用户点开时才调用新的 host-ops 只读动词 `logs.errors`：返回最近 24 小时 `journalctl -p 0..3` 的最多 50 条（每条 ≤ 300 字，统一脱敏），以及内核 OOM 记录。Peer 同样可读（只读动词不受 `E_PEER_FORBIDDEN` 限制）。

不放进诊断：它要起 `journalctl` 子进程，放在 `/state` 里会拖慢每次打开页面。诊断里的 `oom_killed`、`units_failed` 提示会链接到这个分段。

### 3.6 后台告警（只列选项，本提案不实施）

关掉页面后的主动告警与「不做 Cron」冲突。可选路线：① 放开一个 Worker Cron；② 用 GitHub Actions 定时任务调用诊断接口（需要新增一种 API 令牌鉴权）；③ 维持现状，只靠打开面板时的诊断和已有的 `uptime-check.mjs`。**推荐 ③**，作为待拍板项保留。

## 4. 面板安装软件

### 4.1 方案对比

| 方案 | 体验 | 安全影响 | 工作量 |
|---|---|---|---|
| **T-A 面板终端**（交互式） | 网页里打开 Hub 节点的 root 终端，能回答脚本的交互菜单 | 面板会话 = 节点 root shell | 大：Agent 终端会话与传输、新票据类型、前端终端组件、ADR |
| **T-B 一次性脚本任务**（非交互） | 粘贴脚本命令，可预填对交互问题的回答（按行喂给 stdin），按任务执行，日志在任务抽屉里看 | 面板会话 = 节点上任意 root 命令（与 T-A 同级） | 中：复用任务机制与现有动作通道，无新 UI 依赖，三种接入方式都能用 |
| **T-C 不在面板执行** | 用户用自己的 SSH 客户端装；面板只补「把本机监听端口一键发布为站点」 | 无变化 | 小：只改前端，数据已在 `/state.ops.network.listening` |

T-A 和 T-B 的核心风险相同：都允许从面板在节点上以 root 执行任意命令。区别只在于是否交互。

**推荐**：

1. **T-C 无论如何都做**（批次 3）：成本低，覆盖外部方案的「看到端口后一键发布」需求，且没有新风险。
2. 如果主人接受 §4.2 的前置条件，**做 T-A**，因为带交互菜单的一键脚本是主人提出的痛点，T-B 解决不了。不建议同时做 T-B。
3. 如果主人不接受面板持有 root shell，只做 T-C。

### 4.2 T-A 的前置条件与边界（全部满足才开工）

1. **强制 TOTP**：节点开启终端后，面板必须已启用 TOTP；新增终端票据前校验，未启用则拒绝签发。
2. **节点侧显式开启，面板无法远程打开**：只有安装时带 `--enable-terminal` 的 Agent 才提供终端接口，开关写在节点本地配置里。即使面板被攻破，也不能给未开启的节点开终端。
3. **只支持 Hub 自身**，不支持 Peer。Peer 的受限公钥设计保持不变。
4. **只支持 HTTPS 入口**（域名或 Tunnel）。IP 直连节点不提供终端。
5. **会话限制**：同一节点最多 1 个会话；空闲 10 分钟或总时长 60 分钟自动断开；票据一次性、60 秒内有效、绑定面板 Origin。
6. **审计**：开始、结束、时长写入 D1 `audit`。是否在节点本地记录完整输入（0600 文件，保留 7 天）作为待拍板项。
7. **执行方式**：会话通过 `systemd-run --pty` 在 Agent 沙箱之外启动登录 shell，这样安装脚本才能写系统目录；会话结束即回收临时单元。
8. **前端依赖**：解除 `ui-guidelines.md` §9 对终端模拟器的禁令，仅限终端页使用；xterm.js 按路由懒加载，不进主包。
9. **传输**：浏览器直连节点主端口（与 `/_live/snapshot` 同一条路径和 Origin 校验），下行用流式响应，上行用 POST。不经过 Worker，不引入 Durable Objects 或 WebSocket。下行响应用 `Content-Type: text/event-stream`，Caddy 上 `/_term/*` 路由设 `flush_interval -1`，避免经 Caddy 与 Tunnel 时被缓冲导致输出卡顿。
10. **凭据不落库**：终端输出不存储。安装后的端口由 T-C 的「发布本机端口」入口处理；账号密码由用户自行保存，面板不做正则抓取。

### 4.3 需要先核验的事实

面板现有的「安装 Caddy / wireguard-tools」按钮经 `ctx.run()` 在 Agent 沙箱内执行包管理器。在 `ProtectSystem=full` 下这条路径能否写入 `/usr`，我没有找到真机证据。批次 1 先在测试节点上验证；如果失败，改为与 §4.2 第 7 条相同的 `systemd-run` 方式，作为缺陷修复。

## 5. 范围与不做

- 不做：持续高占用进程计数、Worker Cron 告警（§3.6 待拍板）、Peer 终端（第二期路径见 §8 R-7，待拍板）、IP 直连节点终端、终端输出存储与账密抓取、Durable Objects、WebSocket、把 sshd 暴露给 Worker 的路径（外部方案路径 B）。
- 不改：核心 7 码、`lib/diagnostics/` 目录、D1 schema（审计复用 `audit` 表）。

## 6. 批次

| 批次 | 内容 | 改动范围 | 验收标准 | 必测 | 版本 |
|---|---|---|---|---|---|
| 1 | §3.3 主机诊断（含 Agent 新增 `oom`、`rootReadonly`、`memory_pressure` 字段）；§4.3 核验 | `agent/khc/ops.py`、`packages/contracts`（可选字段）、`apps/api/src/lib/app-diagnostics/host.ts`、`docs/diagnostics.md` | 7 类问题各有单测（含旧 Agent 不上报时跳过）；`lib/diagnostics/` 应用名 grep 断言仍通过；诊断响应 ≤ 64KB | 测试节点上：用 `fallocate` 把磁盘填到 > 85% 出现 `disk_full`，清理后消失；停一个测试单元使其 failed 出现 `units_failed`；§4.3 的真机结论写进 PR | Agent minor、面板 minor |
| 2 | §3.4 进程 CPU 两次采样；§3.5 `logs.errors` 动词与「系统错误」分段 | `khc_host.py`（`SCRIPT_VERSION`）、`host_ops.py`、主机运维页、`page-specs.md` | 用 `yes > /dev/null` 起一个进程，列表 CPU% 接近 100；Peer 上 `logs.errors` 可读、写动词仍被拒；四态与 390 截图 | Hub 与 Peer 各一台 | Agent patch、面板 minor |
| 3 | §4.1 T-C「发布本机监听端口」 | 站点页 / 对外服务页，复用 `caddy-site` 与站点抽屉 | 在测试节点起 `python3 -m http.server 9000`，面板列出 9000 并一键预填站点抽屉，保存并生效后外网可访问；已发布的端口不重复列出 | 1 台测试 Hub | 面板 minor |
| 4（待 §7 拍板） | T-A 面板终端：ADR-0020、TOTP 前置校验、Agent `--enable-terminal` 与会话管理、终端票据、前端终端页 | Agent、Worker、契约、前端、`security-boundaries.md`、`ui-guidelines.md` §9 | §4.2 每一条都有对应测试或真机证据；未开启的节点签发票据被拒；TOTP 未启用时拒绝；空闲 10 分钟断开；会话内 `apt-get install -y htop` 成功；Tunnel 节点上 `top` 流畅刷新（无明显成段卡顿） | 域名节点与 Tunnel 节点各一台 | Agent minor、面板 minor |

批次 1–3 互不依赖，可以并行派发。批次 4 拍板后再细化，届时可能再拆成 2–3 个 PR。

## 7. 已拍板（2026-11-13，主人按推荐值批准）

1. **诊断用方案 A**（Worker 侧从 `/state.ops` 派生，新增 `apps/api/src/lib/app-diagnostics/host.ts`）。
2. **接受 §3.3 阈值**：磁盘 warn ≥ 85% / error ≥ 95%，内存可用 < 10%（无 swap 时 < 5%），OOM 取 24 小时窗口。阈值集中在 `host.ts`，后续调阈值只改这一处、不必改 Agent。
3. **后台告警维持现状（§3.6 选项 ③）**：不放开 Worker Cron；关页面后的巡检仍只靠 `scripts/uptime-check.mjs`。
4. **装软件做 T-C + T-A**：T-C 随批次 3 落地；T-A 原则批准，但必须满足 §4.2 全部前置条件，且被下面第 6 条阻塞。不做 T-B。
5. **T-A 记录终端输入**：会话内的输入在节点本地落 0600 文件，保留 7 天后自动清理；这条写进批次 4 的 ADR 与验收。
6. **T-A 开工前置（阻塞项，只有主人能解除）**：先在生产面板启用 TOTP 并确认。未完成前批次 4 不开工。已登记到 `docs/plans/backlog.md`。

批次 1–3 不受第 6 条影响，拍板即可派发。

## 8. 评审增补（2026-11-13，待拍板）

PR 评审时提出。方向与 §7 一致，补的是「报出问题之后能不能处理」「终端在真实网络下好不好用」和「VM 上装应用」三个缺口。每条给出选项和推荐；未拍板前不实施，也不阻塞批次 1–3 按 §6 现有范围开工。

| # | 增补 | 选项 | 推荐 | 影响批次 |
|---|---|---|---|---|
| R-1 | **诊断附处理入口**：`units_failed` 卡片内直接显示该单元最后 20 行日志（已有只读动词 `svc.logs`），并提供「重启」按钮（已有动词 `svc.restart`，L2 确认） | A 做，`docs/diagnostics.md` §5 一键修复白名单由 3 个扩到 4 个（新增 `svc.restart`，不新增能力）；B 只显示日志，不给重启；C 不做，维持 §3.3「只给 hint」 | A | 1（前端与白名单）；动词已存在，Agent 不改 |
| R-2 | **磁盘满时说明谁占的**：新增只读动词 `disk.top`，列出根分区下最大的 10 个目录，以及 journal、apt 缓存、docker 各自占用；`disk_full` 卡片链接到它 | A 只做 `disk.top`；B 再加两个写动作 `journal.vacuum`（`journalctl --vacuum-size=200M`）与 `apt.clean`（L2 确认，Peer 上拒绝）；C 不做 | A，B 留待真实需要时再加 | 2（`khc_host.py` 升 `SCRIPT_VERSION`） |
| R-3 | **已发布应用的链路诊断**：对每个反代站点逐段判断：域名解析是否指向本节点（Worker 用 DoH 查询）→ 证书是否有效 → Caddy 到上游是否可达（`siteHealth`）→ 上游若属于某个 Peer，再看 WG 最近握手是否超过 3 分钟。输出一句结论，例如「grafana 打不开：office-vm 已 3 天没有 WG 握手」 | A 新增批次 5，Worker 侧派生（`app-diagnostics/site-chain.ts`），code 为 `khc.site.*`，只读、无一键修复；B 只在站点抽屉里显示分段状态，不进诊断；C 不做 | A | 新批次 5，只改 Worker 与前端；DoH 是 Worker 新增的出站请求，需在 PR 中说明 |
| R-4 | **终端断线不杀进程**：浏览器断开后会话保留 10 分钟，Agent 保留最近 64KB 输出；同一面板重新打开终端时自动接回原会话。只有用户主动退出或空闲超时才回收临时单元。修订 §4.2 第 7 条「会话结束即回收」 | A 做（推荐）；B 维持断开即回收 | A。手机锁屏或网络抖动会把跑到一半的 apt 或安装脚本一起杀掉，留下半装状态 | 4 |
| R-5 | **会话时长**：§4.2 第 5 条的 60 分钟总时长会打断编译类脚本 | A 去掉总时长，只保留空闲超时，「空闲」定义为 10 分钟内既无输入也无输出；B 总时长放宽到 4 小时；C 维持 60 分钟 | A | 4 |
| R-6 | **输入记录会记下密码**（修订 §7 第 5 条）：脚本提示输入密码时，按键会落进 0600 文件 | A 只记录「回车前的整行」，提示符含 `password`、`passwd`、`密码` 等关键字后的那一行写为 `***`；B 只记录会话元数据（开始、结束、时长、退出码），不记输入；C 维持 §7 第 5 条原样 | A | 4 |
| R-7 | **Peer（VM）终端第二期**：应用多半装在内网 VM 上。路径：VM 上安装只开终端的 Agent（`--enable-terminal --terminal-only`，只监听 WG 地址），Hub 的 Caddy 经 WG 把 `/_term/<peer>/` 反代过去，鉴权沿用同一种一次性票据。**不改 ADR-0007 的受限公钥** | A 批次 4 的 ADR-0020 预留此路径，第二期单独拍板实施；B 明确不做 | A | 4（仅 ADR 预留）；实施为后续批次 |
| R-8 | **脚本库**：全局设置里保存常用一键脚本（名称 + 命令，不存任何凭据）；在节点上点一下即打开终端并自动输入该命令，交互部分由用户完成；结束后提示接到 T-C「发布本机端口」 | A 随批次 4 之后做（依赖终端）；B 不做 | A | 4 之后，前端 + D1 新表（需迁移，届时另附方案） |

拍板方式：逐条回复选项即可（例如「R-1 A，R-2 A，R-6 B」）。规划者据此更新 §5、§6、§7，必要时拆出批次 5。
