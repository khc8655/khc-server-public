# 主机运维轻量化优化：服务精简、一键 Swap/调优表与组件更新检查（提案）

> 状态：已实施 ｜ 最后核验：2026-11-27 ｜ 关联：docs/host-ops.md、docs/ui-redesign/page-specs.md、docs/ui-redesign/ui-guidelines.md

## 1. 背景与设计原则

多数节点为 1G/2G 低内存 VM，需要「一键 2G Swap、常见 Ubuntu/Debian 进程与服务中文说明及安全精简、已安装组件手动检查更新、轻量系统优化工具」。遵循两条核心原则：

1. **零常驻负担**：沿用现有按需 HTTPS 调用模型，操作时执行、完即退出；不新增守护进程、心跳、定时巡检或后台轮询。
2. **极简 UI 克制**：严格遵守 `ui-guidelines.md`（复用类型 D/E 现有 `Segmented` / 4 列 `Table` / 唯一 `Drawer` / `ConfirmAction`，零新色板/字号/导航层级）。**默认列表只展示「名称 + 状态/数值 + 一个动作按钮」**，禁止铺陈说明段落与多层灰色 Banner；详细解释与低频选项仅在点击进抽屉或 L2 确认框内呈现（一句话封顶）。

## 2. 方案对比与推荐

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A 引入外部面板 | 部署 Cockpit / 1Panel 类重组件 | 功能全 | 额外常驻消耗 100–300MB 内存，无中文精简字典，两套 UI 割裂 |
| B 堆叠独立工具卡 | 主机运维页并排摆监控卡、Swap 卡、BBR 卡、说明卡 | 信息直铺 | 首屏臃肿，违反类型 E 规范，低内存小屏满页说明文字 |
| **C 适配 `host-ops` + 极简标准表（推荐）** | `host-ops` 白名单动词按需执行 + 前端静态中文字典 + 标准 4 列 `Table` | 零常驻、不改 Worker/D1、UI 与现有表完全统一、后续扩工具只加注册行 | 仅在 P3 扩展 `agent/khc/pkg.py` 复用系统包白名单 |

## 3. 极简 UI 设计（三处落位，零新路由）

### 3.1 `/hubs/:id/ops` →「服务」与「进程」（只标关键名与可停用项）

- **「服务」分段**：工具条左侧增加轻量切换 `[面板与异常 | 可精简系统服务]`（默认「面板与异常」不变）。切到「可精简系统服务」后，**只展示 Agent 白名单（§4.1）中本机实际存在的单元**，按内存降序；本机一个都没有时不显示该切换（精简镜像上这是常态）。4 列保持极简：
  - `服务`（`unit` 名 + 4–10 字极短中文标签，如 `ModemManager · 拨号与蜂窝猫`）
  - `内存`（等宽 MB，读 `MemoryCurrent`，如 `18 MB`；已停用为空）
  - `状态`（`运行中`/`已停用` 徽标；**不标「建议关闭」**，停不停由主人决定）
  - `操作`（行内仅一个主切换按钮 `[停用]` / `[启用]` + `[日志]`；移动端收进 `⋯`）
  - 点击 `[停用]` 弹出页面级 L2 `ConfirmAction`（一句后果说明 + 「可随时启用恢复」）；因为列表按白名单逐项查询状态，已停用单元始终在列表中，可一键 `[启用]` 恢复。
  - **只停用、不卸载**：不提供任何卸载入口，`disable --now` 随时可逆。
- **「进程」分段**：**不增加新列**、不在行内堆说明。仅当命中前端静态字典（首批覆盖 35–50 个 Ubuntu/Debian/云镜像常见进程）时，在名称下方显示 4–8 字中文短标；点击行打开现有 `ProcessDrawer`，在详情里追加两行 `KeyValue`（`用途`、`建议`），若归属可停用 systemd 服务且当前在运行，且该服务在 §4.1 白名单内，底部给出 `[前往停用该服务]`（先关闭抽屉再跳「服务」分段「可精简系统服务」视图；不提供直接 `kill` 进程，不在抽屉内弹 Dialog）。

### 3.2 `/hubs/:id/ops` → 新增分段「优化」（可扩展工具表）

沿用类型 E `Segmented`（`服务 | 进程 | 防火墙 | SSH 公钥 | 定时任务 | 优化`；6 段需 390px 截图确认不换行/不溢出），**只用一张标准 4 列 `Table`** 承载（不堆独立卡片、不写大段说明，右上仅 `[刷新]` 按钮）：

| 项目 | 当前状态 | 摘要 | 操作 |
|---|---|---|---|
| `Swap 交换空间` | `未开启` / `已开启 · 2.0 GB` | `推荐 2G` / `已用 12%` | `[开启 2G]`（已开启则 `[关闭]`） |
| `TCP BBR 加速` | `未开启` / `已开启` | `fq + bbr` | `[开启]` / `[关闭]` |
| `系统日志（journald）` | `占用 320 MB` | `未限额` / `上限 100 MB` | `[清理并限 100M]` |
| `APT 缓存清理` | `占用 180 MB` | `安装包缓存` | `[清理]` |

- **逐项说明**：
  - Swap：已有 swap 分区/zram 时不叠加，状态列如实显示（如 `已开启 · 512 MB（系统自带）`），操作列为空。
  - BBR：先读 `net.ipv4.tcp_available_congestion_control`，不含 `bbr`（OpenVZ/LXC 等）时整行置灰并注明「内核不支持」。BBR 只作用于 TCP（Caddy、SSH），对 QUIC（sing-box TUIC/Hysteria2）无效。
  - journald：写 drop-in `/etc/systemd/journald.conf.d/99-khc.conf`（`SystemMaxUse=100M`）并重启 journald，再 `--vacuum-size`；只 vacuum 不限额会复涨。
- **入口提示**：内存 ≤ 2 GB 且无任何 swap 时，状态带「内存」格显示中性短标 `未开 Swap`，点击下钻到「优化」分段；有 swap 后不显示（功能开启才显示）。
- **抽屉承载低频选项**：点击 `Swap 交换空间` 行打开唯一 `Drawer`，提供 `1G / 2G / 4G` 档位选择及创建/删除后的结果反馈；默认列表直接一键 `[开启 2G]`（L2 确认，不逼用户点进抽屉）。
- **四态规范**：未就绪显示行骨架；离线禁用所有操作并提示；加载/动词失败表格上方展示 `InlineError + [重试]` 保留既有行；写操作执行完 Toast 提示并触发单次状态刷新。
- **后续可扩展架构**：前端新增声明式 `HOST_TUNE_ITEMS` 注册表（定义 `id`、名称、状态映射、L2 主动作与可选抽屉），Agent 侧提供 `tune.status` 单次聚合只读状态 + 独立白名单动词。后续接入 zram、时区同步、Docker 清理等只需追加注册项与一个动词，零架构重构。

### 3.3 `/hubs/:id/settings?tab=components` →「内置组件」手动检查更新（推荐移入 backlog，见 §6）

> 评审结论：4 个白名单包里只有 Caddy 值得跟版本；准确检查必须先 `apt-get update`（1G 机器上数十秒、上百 MB 内存），与「零负担」冲突。推荐整批移入 backlog，等 Caddy 有需要跟进的安全版本时再做；若做，范围收窄为仅 Caddy，下面是那时的 UI 设计。

- **极简触发**：不加新表、不加长段提示，仅在「内置组件」卡头右侧放一个 `[检查更新]` 次按钮（纯手动触发，绝不自动/后台轮询）。
- **克制反馈**：
  - 无可用更新时，仅右上 Toast 提示「当前组件均为仓库最新版本」，界面零变动；
  - 有可用更新时，在对应行 `状态` 或 `说明` 处轻标 `2.8.4 → 2.9.1`，并在 `操作` 列多出 `[更新]`（L2 `ConfirmAction`，后果写明「升级会重启 Caddy，所有站点短暂中断」+ 复用 `ComponentsCard` 既有 `installTask` 异步任务进度条）。
- 托管应用（`sing-box`、`magpie` 等）继续保留在「应用」页 `InstalledAppDrawer` 升级，不在此重复造入口。

## 4. 架构、安全边界与核心冻结说明

- **不改核心路由与 D1**：`apps/api/`、`migrations/`、`packages/contracts/` **零改动**。全部操作继续复用 `host-ops` 既有 `call`（只读/短操作）与 `call_task`（异步任务：Swap 创建、系统包检查/升级）。
- **核心冻结**：P1、P2 **不改 `agent/khc/`**。P3 若启动：只读检查（`apt-cache policy caddy` 等）放在 `host_ops` 适配器；只有「升级」需要在 `agent/khc/pkg.py` 增加 `upgrade_package`（复用其 `systemd-run` 沙箱外执行，不在适配器复制第二套），届时在 PR 中按 AGENTS.md 说明必要性，范围仅 `caddy`。
- **新写动词与审计**：`svc.disable`、`svc.enable`、`tune.swap`、`tune.bbr`、`tune.journal-vacuum`、`tune.apt-clean` 加入 `WRITE_VERBS` 并补审计事件（与 `svc.restart` 同口径）。命名避开既有 `cleanup`（卸载清理）。只读聚合为 `tune.status` 与 `svc.slim-list`。Worker 不硬编码动词，零 API 改动成立。
- **Agent 端强制护栏（不信任前端）**：
  1. **身份与目标边界**：所有写动词与系统调优仅允许 Hub `self` 且 `root`（`target != self` 返回 `E_PEER_FORBIDDEN`，非 root 返回 `E_NO_PRIV`）；`ProtectSystem=full` 下的 `/etc`、`/swapfile`、`/usr` 写操作统一走 `systemd-run` 一次性 unit 沙箱外执行，严禁 shell 字符串拼接。
  2. **服务停用：Agent 端硬编码白名单，宁少勿多**（见 §4.1）。白名单外一律 `E_PROTECTED`，前端字典只负责中文标签，不参与判定。写操作为 `systemctl disable --now`，作用于该条目登记的整组单元（service + socket/timer），写后回读 `is-enabled` 与 `is-active` 校验；启用为 `enable --now` 同组。
  3. **Swap 安全检查**：创建走 `call_task`（慢盘上 dd 2G 可能超过同步超时）；已有激活 swap 时拒绝重复叠加并回报现状；根分区可用空间必须 `>= 目标大小 + 1 GiB`；`/swapfile` 强制 `0600`；Btrfs 用 `chattr +C` + `dd` 创建，ext4/xfs 优先 `fallocate` 回退 `dd`；OpenVZ/LXC 容器不支持 `swapon` 时返回明确可理解错误；`/etc/fstab` 使用 `# khc-managed-swap` 注释标记实现幂等增删，并落盘 `/etc/sysctl.d/99-khc-swap.conf`（`vm.swappiness=10`）。
  4. **包升级边界**：仅检查与升级白名单 4 个系统包（`apt-get install --only-upgrade -y <pkg>`，dnf/yum/apk 同理）；**绝不执行全系统 `apt full-upgrade`**，不修改系统 apt 源配置；升级后校验二进制与受管服务状态。

### 4.1 可停用服务白名单（保守版）

入选必须同时满足：不在启动、网络、SSH、时间同步、安全更新、磁盘挂载链路上；停掉后本机无任何运行时依赖；在云 VM 上无用武之地（桌面、硬件、上报类）。标准是「即使完全卸掉也不影响服务器」，但面板只做停用。

| 条目 | 单元组 | 用途 | 安全理由 |
|---|---|---|---|
| ModemManager | `ModemManager.service` | 拨号与蜂窝猫 | VM 无猫 |
| udisks2 | `udisks2.service` | 桌面磁盘管理 | 服务器挂载不经过它 |
| packagekit | `packagekit.service` | 图形包管理后端 | apt 不依赖 |
| fwupd | `fwupd.service`、`fwupd-refresh.timer` | 固件升级 | VM 无可刷固件 |
| apport | `apport.service` | 崩溃报告 | 仅上报 |
| whoopsie | `whoopsie.service` | 崩溃上传 | 仅上报 |
| motd-news | `motd-news.timer` | 登录欢迎语新闻 | 纯展示 |
| accounts-daemon | `accounts-daemon.service` | 桌面账户服务 | 服务器不用 |
| avahi | `avahi-daemon.service`、`avahi-daemon.socket` | 局域网发现 | 云上无意义 |
| cups | `cups.service`、`cups.socket`、`cups.path` | 打印 | 云上无意义 |
| bluetooth | `bluetooth.service` | 蓝牙 | 云上无意义 |
| snapd（有条件） | `snapd.service`、`snapd.socket`、`snapd.seeded.service` | snap 包管理 | **仅 `snap list` 为空时允许**，否则 `E_PROTECTED`：部分云的管理代理用 snap 安装（如 AWS Ubuntu 的 SSM Agent、Oracle 的 cloud-agent） |

**明确排除**（不展示、不允许）：`multipathd`、`iscsid`（部分云块存储依赖）、`cloud-init*`（部分厂商每次开机下发网络与密钥）、`unattended-upgrades`（安全补丁）、`chrony`、`systemd-timesyncd`（时间不准导致 TLS/TOTP 失败）、`qemu-guest-agent` 与各厂商云代理（控制台重置密码/快照）、`rsyslog`、`cron`、`polkit`、`getty@*`（VNC 救援入口），以及既有保护：`systemd-*`、`ssh`/`sshd`、`dbus`、网络类、`khc-*`、`caddy`、`wg-quick@*`。

## 5. 范围与不做

- 不做：卸载任何系统包或服务、白名单外的服务停用、后台定时检查更新/自动升级、直接 `kill` 进程、全系统包更新、Web Shell/任意命令框、Peer 侧写调优、独立监控常驻进程。

## 6. 分批计划

| 批次 | 改动范围 | 验收标准 | 必测项 | 是否 bump |
|---|---|---|---|---|
| **P2 主机「优化」标准表（第一批）** | `agent/adapters/host_ops/`、`apps/web/src/apps/host-ops/`、`HubOpsPage.tsx`、`page-specs.md`、`docs/host-ops.md` | 4 列标准表 + `HOST_TUNE_ITEMS` 可扩展注册；一键 2G Swap（含 1G/2G/4G 抽屉与删除）、BBR 开关、journald 清理限 100M、APT 缓存清理全部走通 | Agent 单测（空间不足、已有 swap/zram、Btrfs、fstab 幂等、BBR 不支持置灰、journald drop-in）；390px 截图；Web 烟测 + 测试机真机实测 | 面板 minor + Agent minor |
| **P1 服务精简与中文指南（第二批）** | `agent/adapters/host_ops/`、`apps/web/src/apps/host-ops/`、`zh.ts` | 前端静态字典覆盖常见系统进程/服务（短标 + 详情建议）；「可精简系统服务」支持查看内存并安全 `停用/启用`；只列白名单中本机存在的单元；白名单外一律拒绝 | Agent 单测（白名单外拒绝、snapd 有 snap 时拒绝、socket/timer 成组停用与启用、幂等、非 root 拒绝）；Web 烟测 + 浅/深/390px 截图 | 面板 minor + Agent minor |
| **P3 内置组件手动检查更新（推荐移入 backlog）** | `agent/adapters/host_ops/`（只读检查）、`agent/khc/pkg.py`（仅 upgrade，需说明必要性）、`apps/web/src/apps/node-settings/ComponentsCard.tsx` | 卡头 `[检查更新]` 手动探测Caddy 可升级版本；无更新只 Toast，有更新行内展示候选版本并支持异步升级与日志回显 | `test_pkg.py`（跨包管理器 mock、非白名单拒绝、升级失败不破坏现运行）；Web 组件烟测 | 面板 minor + Agent minor |

实施顺序：P2 → P1 → P3。理由：1G VM 最大的风险是 OOM 杀掉 Caddy/Agent，一键 Swap 收益最大、风险最小；停用服务节省有限（通常数十 MB）且误停代价高，放第二批；P3 价值最低。

## 7. 待拍板项

1. P2「优化」表首批 4 项（Swap / BBR / journald / APT 缓存）按 §3.2 修正后全部保留？（推荐：是）
2. 实施顺序 P2 → P1 → P3？（推荐：是）
3. §4.1 白名单是否认可，是否有要再删掉的条目？（主人已定原则：宁少勿多、只停用不卸载）
4. P3 移入 backlog，还是仅做 Caddy？（推荐：移入 backlog）

## 8. 评审修订记录

- 2026-11-26：服务精简由黑名单改为 Agent 端白名单（§4.1），只停用不卸载，成组处理 socket/timer，不标「建议关闭」；顺序改为 P2 → P1 → P3；P3 不动 `agent/khc/` 只读部分并推荐移入 backlog；补 Swap/BBR/journald 细节、新动词与审计、状态带「未开 Swap」提示、6 分段 390px 校验。
- 2026-11-26：主人拍板合入（P2 首批 4 项全保留、按 P2 → P1 顺序开工、认可 §4.1 保守白名单、P3 移入 backlog）。
- 2026-11-27：P2（#186）与 P1（#187）已合入发布，提案归档，P3 记入 docs/plans/backlog.md。
