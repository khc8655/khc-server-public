# 用户真实流程走查记录（2026-11-02 下午）

> 状态：已归档（一次性走查记录，历史资料；不得作为开发依据，AGENTS.md 红线 9c） ｜ 适用范围：面板 https://panel.example.com/ 生产环境 + aws hub（203.0.113.10，可随意折腾）+ arm-1（203.0.113.11，作 peer）；node-test-2 仅只读未动 ｜ 最后核验：2026-11-02 ｜ 关联：`docs/archive/audit-2026-11-02/server-test/2026-11-02/report.md`（上一轮测试，其 P0/P1 修复已合入 main 但**未随发布包上线**，见问题 #1）
>
> 修复状态（2026-11-03，feat/server-capabilities）：走查问题 #1 发布链路漂移 → `5165cad`；#2 首个 apply 写盘失败 → `a498aa7`；#4 删除残留清理 → `01cdd8f`；#5 fw 回读校验 / #6 wg0 校验 → `6816fd5`；配套双通道回退 `b23d66a`。截图为当时线上状态，修复后界面可能不同。
>
> 脱敏与移除（2026-11-11）：真实 IP/域名/节点名已替换为占位符；含一次性安装令牌、WireGuard Peer 私钥、SSH 公钥与用户名的截图（`03-node-token-install-cmd.png`、`20-peer-export.png`、`24-peer-ops-onboarded.png`）已从公开树移除。

## 走查环境与前提

- 面板生产环境（main `02f13b2`，含全部 P0/P1 修复的**控制面**）；Agent 发布通道仍为旧构建 0.1.4（sha256 `1592311d…`，**不含** P0/P1 修复，main 新构建为 `b1de1b7f…`）——多个卡点根因在此。
- 香港机（203.0.113.13:<ssh-port>）TCP 不通，本轮全程未用；node-test-2 未做任何操作。
- 面板起点：节点列表为空（上一轮清理后）。
- 截图：本目录 `NN-*.png`（31 张）。

---

## 一、添加 VM

### 1.1 IP 方式添加并上线 —— ✅ 顺畅

**实际操作**：首页空状态「添加节点」→ 表单填 `wt-hub` / `http://203.0.113.10:8443`（endpoint 提示清晰）→ 创建成功弹出一次性令牌 + 一键安装命令 → `ssh -tt` 提供TTY 执行命令（粘贴 token）→ agent 0.1.4 active，约 2 分钟节点在线。
截图：`01-home-empty.png`、`02-add-node-dialog.png`、`03-node-token-install-cmd.png`、`04-node-online.png`

**卡点**：
- 安装完成后立即刷新节点页仍显示「未知/未确认」，等约 10 秒再刷新才「在线」（状态拉取时序）。
- 一键命令用 `read </dev/tty` 读 token：必须真 TTY，管道 SSH 下直接挂起无提示（绕过方法只在测试笔记里，命令本身不提示）。
- 安装结束输出把 token 又回显了一遍（防泄露设计被自己破坏，程度轻）。

**一句话**：不会骂人——路径顺、引导全，tty 陷阱折腾一次就想骂。

### 1.2 域名 / HTTPS IP 方式 —— 部分可用

**实际操作与结果**：
- `https://203-0-113-10.sslip.io`（Caddy 自动签发 LE 真证书，反代 agent 8443）：PATCH 节点 endpoint 后 `state` 立即 `reachable:true via:"fetch"` ✅（比 IP+HTTP 还顺，fetch 通道免 TCP 兜底）。
- 自签证书（caddy-site `tls internal`，Caddy 内部 CA，浏览器访问正常、证书仅 12h）：作为节点 endpoint 时 Worker 返回 **HTTP 526**（fetch 与 `cloudflare:sockets` 两通道都校验证书）→ **不能用于节点接入**。
- HTTPS + 裸 IP：Agent 内核无 TLS（代码无 ssl/certfile），裸 IP 证书也无 CA 可签 → 不成立，只能靠 Caddy 反代域名。

**结论**：域名+真证书是正路且已验证可用；自签证书只能给人浏览用。缺一份「endpoint 该怎么填（http IP / https 域名 / 自签为什么不行）」的用户文档。
**一句话**：会骂人——"TLS 用 https://域名:8443"的提示写得出来，但没人告诉我自签不行、也没人告诉我先去建反代站点。

### 1.3 一键安装是否连带 Caddy / 自签证书服务 —— ❌ 不装

**事实**：`install.sh` 只装 Agent（--check 对 caddy/wg/socat 仅 WARN）；caddy-site 适配器 `install()` 也不装 Caddy（缺了直接报错「请自行 apt 安装」）；UI 站点页「Caddy 服务」弹窗只有状态/重载，无安装动作。自签证书 = caddy-site 的 `tls internal` 模式，Caddy 在才有。
**一句话**：会骂人——"一键安装"装了个半成品，还得自己 SSH 上去 apt 装 Caddy。

### 1.4 发布测试应用（node-exporter）—— ❌ 阻断

**实际操作**：扩展应用 tab → node-exporter 应用页（默认参数已预填）→ 安装（确认弹窗 → 任务日志实时滚动，0.84s 完成，体验好）→「保存并生效」。
截图：`06-ext-apps.png`、`07-node-exporter-page.png`、`08-save-apply-noop.png`

**卡点（本走查最严重的产品级故障）**：
1. apply 崩溃：Agent 500 `OSError [Errno 30] Read-only file system: '/etc/khc'`——unit 的 `ReadWritePaths=-/etc/khc`（`-` 前缀=不存在就跳过）在全新机器上不生效，写 `/etc/khc` 的应用（node-exporter 等）首个 apply 必失败。诊断里 errorCode 显示 `hub_unreachable`，掩盖真实错误。
2. install() 返回的 cards（「Metrics 地址 http://127.0.0.1:9100/metrics」）**没有在 UI 任何地方展示**——"一键脚本安装后输出访问地址/用户名/密码"这个核心场景，地址用户根本看不到；且地址写成 127.0.0.1（远程服务器上照抄必不通）。
3. 任务记录刷新页面即消失（「任务 0 / 还没有任务」），安装证据不留痕。
4. 「保存并生效」点击后无 loading/结果反馈（实际上保存成功+apply 失败，失败横幅要再刷新才见到）。

**一句话**：会骂人——装完就报错，报错还看不懂，装的地址也找不到。

### 1.5 运维走查（3.2）—— 部分可用

**进程**：✅ 按 CPU/内存排序、刷新、只读详情（无 kill，符合精简决策）。截图 `13-ops-processes.png`
**防火墙**：读取正常（锁定规则+自定义规则表格，编辑模式体验好）；但「应用」**静默失败**——按钮从「应用中」恢复为「应用」，无任何 toast/错误，机器上 khc_fw 表根本没建（直调 API 才看到 E_UNSUPPORTED/OSError；`systemd-run 不可用` 报错误导——旧包 khc-host 路径解析问题，P0-2 已修但未发布）。锁定行仍是硬编码 8880（agent 实际 8443 未受保护，P1-B 同样未发布）。截图 `14-ops-firewall.png`、`15-fw-applied.png`
**SSH 公钥**：UI 表单完整，但 keys.add 从面板调用必失败（「请求参数不合法」；直调脚本用同样参数成功——面板↔旧包 host-ops 协议偏差）；错误提示模糊无详情。截图 `16-ops-sshkeys.png`
**cron 定时任务**：❌ **完全缺失**——host-ops 动词表无 cron，UI 四个分段（服务/进程/防火墙/SSH 公钥）没有定时任务入口。用户明确期望「读取与管理系统定时任务」。

**一句话**：会骂人——防火墙点了没反应、公钥加不上，没人告诉我为什么；想管 cron？没这功能。

### 1.6 hub 自身管理（3.3）—— ✅ 入口齐全但内容空转

节点设置页有「升级 Agent」「卸载 Agent」「安装 Agent」入口，Agent 卡片显示版本。但「升级」生成的命令指向**同一个旧包**（发布通道未更新，见问题 #1）——升级按钮是假希望。无远程执行（命令需上机粘贴，安全设计如此）。截图 `17-node-settings-agent.png`
**一句话**：不骂但失望——按钮都在，点了等于没点。

---

## 二、WireGuard

### 2.1 下发安装指令能力 —— hub 侧有、peer 客户端无

- hub：保存并生效时适配器自动 `apt install wireguard-tools` ✅（无需手动装）。
- peer 客户端：**只有 .conf 导出/下载**（无 QR 码——P2-8 已知、无一键安装脚本），peer 机要自己装 wireguard、自己导入 conf。
- peer 的 host-ops 接入另有一键命令（见 2.4），但那是运维接入，不是 WG 客户端安装。

### 2.2 peer 创建 → 一键脚本 → 连接 —— ✅ 顺畅（除"脚本"）

**实际操作**：添加 Peer（表单预填 tunnel IP/keepalive）→ 保存后**自动弹出「导出 Peer 配置」**（时机刚好）→ conf 手工放到 arm-1（`wg-quick up wt0`）→ 握手成功 2.5ms，面板 peer 行显示「在线/最新握手/流量」。
截图：`18-wg-empty.png`、`19-wg-applied.png`、`20-peer-export.png`、`21-peer-online.png`

**卡点**：
- **首次 apply 后 wg0 接口没有起来**：conf 已写、面板无警示、appliedRev=1，但机器上 `wg show` 为空，需手工 `systemctl restart wg-quick@wg0` 才有接口。面板「已同步」与机器实际不符（可能与本机残留的 stale unit 状态有关，但面板未发现也未告警）。

**一句话**：不太骂——除了"面板说好了、隧道其实没起来"这一点会骂。

### 2.3 peer 网络策略（默认路由）—— ✅ 正确

导出 conf 的 peer 侧 `AllowedIPs = 10.99.0.0/24`（仅隧道网段，**非** 0.0.0.0/0 全隧道）；arm-1 实测：默认路由仍走原生网卡，`ifconfig.me` 出口 IP 不变。符合"默认不应全量走 WG"的预期。
**缺口**：无 UI 选项调整 peer 侧路由范围（想全隧道/加网段做不到）；add-peer 表单里的「允许的地址」是 hub 侧 AllowedIPs，概念易混。
**一句话**：不骂——默认正确；想改范围的人会骂。

### 2.4 hub 应用配置与端口转发 —— ✅ 可用

- 端口转发：添加转发表单（目标来源下拉自动匹配 peer IP，联动体验好）→ 保存生效 → socat unit `khc-forward-wt-fwd` 建立、**socat 缺失时适配器自动 apt 安装** ✅ → hub 本机 curl :9101 经隧道达 peer:8080 HTTP 200（外网 9101 被 Lightsail 云防火墙挡，环境限制）。UI 状态「生效」与实际一致。
截图：`26-port-forward.png`
- **hub vs peer 运维对比**：hub=服务/进程/防火墙/SSH 公钥四段+诊断+升级；peer=进程/防火墙/SSH 公钥三段（无服务管理）+ 丰富快照（CPU/内存/磁盘/负载/DNS/默认路由/Top 进程/待重启服务列表）。peer 经 hub SSH 隧道按需连接（`10.99.0.2:22`、restrict+command 锁定的 authorized_key，安全设计到位）。差异合理（受限白名单），快照质量高。
截图：`23-peer-ops.png`、`24-peer-ops-onboarded.png`、`25-peer-ops-live.png`

**一句话**：不骂——peer 运维这块是全场体验最好的功能。

---

## 三、卸载

### 3.1 删除 peer —— hub 清了、peer 机没清

面板删除（确认文案：「删除后该 Peer 会立即断开，配置随之失效」）：hub 侧内核 peer 同步移除 ✅。但：
- **peer 机上 wt0 接口仍在跑、conf 仍在**（僵尸隧道，keepalive 无响应）——面板无法清理非受管 peer 可以理解，但确认文案没有任何"peer 侧需自行清理"提示。
- host-ops 的 `peers` 配置残留孤立引用（wt-peer-arm1 已删，host-ops app config 里还在），且删 peer 后 peer 运维入口消失，该清理也无入口。
截图：`31-peer-deleted.png`

**一句话**：会骂人——"删除生效"四个字背后，peer 机上留着一堆东西，没人告诉我。

### 3.2 删除 hub —— Agent 干净、应用全残留

官方卸载命令（`uninstall.sh --purge --system`）执行后：agent unit/进程/三目录全清 ✅。**残留**：
- `wg-quick@wg0` active + wg0.conf + wg0 接口（隧道还在）
- `khc-forward-wt-fwd.service` active（socat 还在监听 9101）
- caddy 站点配置仍生效（`/etc/caddy/khc.d/` + import 行——sslip.io 反代还在指向已死的 8443）
- node-exporter 二进制（/opt/khc/apps）
卸载输出明确提示"应用的 unit 不会自动删除，请先在面板卸载应用"——但**删除节点后就没有应用卸载入口了**：正确顺序（先逐应用卸载→再删节点→再上机卸载 agent）没有任何流程引导，直接删节点（用户最常见操作）= 残留永留。
截图：`32-node-deleted.png`

**一句话**：会骂人——"卸载完成"的机器上还跑着隧道、转发和站点。

### 3.3 远程下发卸载 —— 无（设计如此，但摩擦大）

节点设置「卸载 Agent」对话框明确"命令由你在目标节点上粘贴执行，面板不会远程执行"（合理的安全设计）；peer 运维里也有「卸载命令」生成按钮 ✅。卡点：**卸载命令必须手填安装包地址+sha256**（placeholder 还是 example.com）——升级对话框有预填，卸载没有；用户为了卸载还得先去找包地址。
**一句话**：会骂人——让我卸载还要我自己填下载地址？

---

## 四、重点观察

### 4.1 hub 重启/服务异常时面板表现 —— ✅ 良好

`systemctl stop khc-agent` 后：节点列表「离线」；主机运维页状态带「Agent 连接 离线」、CPU/内存/磁盘/运行变「—」、顶部警示「节点不可达，以下为缓存状态，执行类操作已禁用」✅。小瑕疵：其他指标清空后「服务 正常」仍显示旧缓存。`start` 后约 10 秒恢复在线（via tcp）。
截图：`27-hub-agent-down.png`
**一句话**：不骂——离线状态表达是清晰的。

### 4.2 peer 密钥轮换与回退 —— ✅ 核心正确，反馈有瑕疵

轮换流程完整：编辑抽屉高级区「轮换密钥」→ 确认（文案明确"旧密钥保持有效直到新设备握手"）→ 弹出新配置（新旧公钥、自动取消期限、复制按钮）→ arm-1 换新钥后握手成功，hub 双 peer 并存。**回退验证**：面板取消轮换 + 应用配置后，arm-1 切回旧钥立即恢复握手（2.4ms）✅。
瑕疵：① 取消轮换后对话框不关闭、无 toast 反馈（以为没点上，实际 API 已取消）；② 新钥握手后观察约 1 分钟 pending 未自动 cutover（需手动「确认完成」或依赖更慢的周期检查）。
截图：`28-peer-rotate.png`、`30-rotation-cancelled.png`
**一句话**：不骂——敢轮换敢回退，这个功能是放心的。

### 4.3 面板控制 vs 浏览器直连切换 —— 部分（环境受限）

节点概况「实时状态：在线 · 直连」正常展示（浏览器直连 agent live SSE 工作）。弱网/端口不可达场景下的通道切换稳定性未模拟（本机到两台 VM 网络均正常），标注**未验证**。

---

## 清理动作记录（走查结束后已执行）

- **aws hub（203.0.113.10）**：停止并删除 `wg-quick@wg0`、`khc-forward-wt-fwd`；删 wg0.conf；删 `/etc/caddy/khc.d`、`/opt/khc`；Caddyfile 去除 khc import 行并 validate+reload；agent 已由官方卸载命令移除（--purge）；`/tmp/wt-*` 脚本删除。验证：无 khc unit/进程/端口、`/etc` 无 khc 残留。
- **arm-1（203.0.113.11）**：`wg-quick down wt0` + 删 conf；`userdel -r <ssh-user>`；删 `/usr/local/sbin/khc-host`；删 iptables 8080 测试放行规则；停临时 http.server；`/tmp/wt-*` 删除。验证：无 wt0/<ssh-user>/khc-host/8080 规则。
- **面板**：节点 `wt-hub` 已删（面板删除流程本身即走查内容），`GET /nodes` 返回空。D1 全局证书库存在上轮遗留测试证书（ui.test/site.test 域名下拉可见），非本轮创建，未动。
- **本地**：临时密钥对、下载包、脚本已删。
- 注意：清理中两次误用 `pkill/pgrep -f` 匹配到自身 SSH 命令行导致会话中断（AGENTS.md §8 已有此坑记录，仍踩，引以为戒）。

---

## 问题清单（按阻断程度排序）

### 阻断

| # | 问题 | 影响 |
|---|---|---|
| 1 | **发布通道 Agent 包是旧构建**：线上 0.1.4（sha `1592311d…`）不含已合入 main 的 P0/P1 修复（main 构建 `b1de1b7f…`）；「升级 Agent」也指向同一旧包 | 一切新装节点都踩旧缺陷；修复"修了但没生效"。需：版本号 bump + 重打包签名发布（发版流程缺"合入后必须出包"环节） |
| 2 | **全新机器上首个应用 apply 必失败**：`ReadWritePaths=-/etc/khc` 在目录不存在时被跳过 → `OSError Read-only file system`；诊断误标 `hub_unreachable`，UI 无真实错误 | "发布应用"核心路径不可用；错误归因还误导排障（即便换新包，`-` 前缀陷阱仍需修） |

### 很烦

| # | 问题 | 影响 |
|---|---|---|
| 3 | 防火墙「应用」静默失败（无 toast/错误，按钮恢复如初） | 用户以为成功了；锁死风险场景下最致命 |
| 4 | WireGuard 首次 apply 后 wg0 接口未创建，面板却显示"已同步" | 面板状态与机器实际不符；用户要到 peer 连不上才发现 |
| 5 | 卸载顺序死结：删节点后应用残留永留（wg0/socat/caddy 站点/node-exporter），且再无应用卸载入口；卸载命令不预填包地址+sha256 | "卸载完成"名不副实；正确顺序无任何引导 |
| 6 | cron 定时任务管理完全缺失 | 用户明确期望的能力（读/管系统定时任务）没有 |
| 7 | 删 peer 不清 peer 机服务（wt0/conf 留存）且无提示；host-ops peers 孤立残留 | 僵尸隧道+配置垃圾 |
| 8 | 应用安装产出信息（cards：访问地址等）不展示；任务记录刷新即丢；地址用 127.0.0.1 误导 | "装完应用去哪访问"这个最基本的问题没有答案 |
| 9 | 面板↔旧包 host-ops 协议偏差：keys.add 必失败且报"请求参数不合法"（模糊） | SSH 公钥管理不可用（换新包可解，但错误提示质量需单修） |

### 可接受

| # | 问题 | 影响 |
|---|---|---|
| 10 | 装完 agent 后节点"未知"延迟 ~10s 才在线 | 略困惑 |
| 11 | 一键命令需真 TTY，管道下挂起无提示 | 自动化场景踩坑（有文档绕过） |
| 12 | peer 客户端配置无一键脚本/QR 码（仅 conf 导出） | 手工导入可接受，体验一般 |
| 13 | 取消轮换后对话框不关、无反馈；自动 cutover 不及时 | 疑惑"点没点上" |
| 14 | agent 离线时「服务 正常」缓存残留（其他指标已置"—"） | 轻微不一致 |
| 15 | peer 侧路由范围（AllowedIPs）无 UI 选项 | 进阶需求不满足 |
| 16 | 自签证书不能作节点接入（两通道都校验）；LE 真证书可用但需要域名+建反代站的前置知识 | 设计限制，缺用户文档说明 |
| 17 | 安装结束回显 token、endpoint 概念（http IP/https 域名/自签）无引导 | 轻微 |

### 受环境限制未验证

- 香港机 SSH 不通（TCP 超时）——该机无法参与任何流程。
- 弱网/端口不可达下「面板控制 ↔ 浏览器直连」切换稳定性未模拟（正常网络下直连在线状态正常）。
- LE 新签发未走完整 ACME 流程（命中 Caddy 本地缓存证书，签发路径上一轮 B2 已验证过）。
- node-test-2 未做任何操作（约束只读）。
- 多节点并发、面板 429 限流等不在本轮范围。
