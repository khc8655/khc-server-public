# 主机运维轻量化优化：服务精简、一键 Swap/调优表与组件更新检查（提案）

> 状态：草案 ｜ 最后核验：2026-11-26 ｜ 关联：docs/host-ops.md、docs/ui-redesign/page-specs.md、docs/ui-redesign/ui-guidelines.md

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

- **「服务」分段**：工具条左侧增加轻量切换 `[面板与异常 | 可精简系统服务]`（默认「面板与异常」不变）。切到「可精简系统服务」后，按内存 RSS 降序只展示可评估的常见非核心系统单元（表头不新增说明块），4 列保持极简：
  - `服务`（`unit` 名 + 4–10 字极短中文标签，如 `snapd · 应用沙盒包管理`）
  - `内存`（等宽 MB，如 `118 MB`）
  - `状态`（`运行中`/`已停用` 徽标 + 中性短标 `建议关闭` 或 `按需`）
  - `操作`（行内仅一个主切换按钮 `[停用]` / `[启用]` + `[日志]`；移动端收进 `⋯`）
  - 点击 `[停用]` 弹出页面级 L2 `ConfirmAction`（一句后果说明 + 恢复提示）；已停用单元始终展示 `[启用]` 可一键恢复。
- **「进程」分段**：**不增加新列**、不在行内堆说明。仅当命中前端静态字典（首批覆盖 35–50 个 Ubuntu/Debian/云镜像常见进程）时，在名称下方显示 4–8 字中文短标；点击行打开现有 `ProcessDrawer`，在详情里追加两行 `KeyValue`（`用途`、`建议`），若归属可停用 systemd 服务且当前在运行，底部给出 `[前往停用该服务]`（先关闭抽屉再跳「服务」分段「可精简系统服务」视图；不提供直接 `kill` 进程，不在抽屉内弹 Dialog）。

### 3.2 `/hubs/:id/ops` → 新增分段「优化」（可扩展工具表）

沿用类型 E `Segmented`（`服务 | 进程 | 防火墙 | SSH 公钥 | 定时任务 | 优化`），**只用一张标准 4 列 `Table`** 承载（不堆独立卡片、不写大段说明，右上仅 `[刷新]` 按钮）：

| 项目 | 当前状态 | 摘要 | 操作 |
|---|---|---|---|
| `Swap 交换空间` | `未开启` / `已开启 · 2.0 GB` | `推荐 2G` / `已用 12%` | `[开启 2G]`（已开启则 `[关闭]`） |
| `TCP BBR 加速` | `未开启` / `已开启` | `fq + bbr` | `[开启]` / `[关闭]` |
| `系统日志（journald）` | `占用 320 MB` | `未限额` / `上限 100 MB` | `[清理并限 100M]` |
| `APT 缓存清理` | `占用 180 MB` | `安装包缓存` | `[清理]` |

- **抽屉承载低频选项**：点击 `Swap 交换空间` 行打开唯一 `Drawer`，提供 `1G / 2G / 4G` 档位选择及创建/删除后的结果反馈；默认列表直接一键 `[开启 2G]`（L2 确认，不逼用户点进抽屉）。
- **四态规范**：未就绪显示行骨架；离线禁用所有操作并提示；加载/动词失败表格上方展示 `InlineError + [重试]` 保留既有行；写操作执行完 Toast 提示并触发单次状态刷新。
- **后续可扩展架构**：前端新增声明式 `HOST_TUNE_ITEMS` 注册表（定义 `id`、名称、状态映射、L2 主动作与可选抽屉），Agent 侧提供 `tune.status` 单次聚合只读状态 + 独立白名单动词。后续接入 zram、时区同步、Docker 清理等只需追加注册项与一个动词，零架构重构。

### 3.3 `/hubs/:id/settings?tab=components` →「内置组件」手动检查更新

- **极简触发**：不加新表、不加长段提示，仅在「内置组件」卡头右侧放一个 `[检查更新]` 次按钮（纯手动触发，绝不自动/后台轮询）。
- **克制反馈**：
  - 无可用更新时，仅右上 Toast 提示「当前组件均为仓库最新版本」，界面零变动；
  - 有可用更新时，在对应行 `状态` 或 `说明` 处轻标 `2.8.4 → 2.9.1`，并在 `操作` 列多出 `[更新]`（L2 `ConfirmAction` + 复用 `ComponentsCard` 既有 `installTask` 异步任务进度条）。
- 托管应用（`sing-box`、`magpie` 等）继续保留在「应用」页 `InstalledAppDrawer` 升级，不在此重复造入口。

## 4. 架构、安全边界与核心冻结说明

- **不改核心路由与 D1**：`apps/api/`、`migrations/`、`packages/contracts/` **零改动**。全部操作继续复用 `host-ops` 既有 `call`（只读/短操作）与 `call_task`（异步任务：Swap 创建、系统包检查/升级）。
- **核心触碰说明（仅 P3）**：P3 需在 `agent/khc/pkg.py` 补充 `check_package_updates` 与 `upgrade_package`，原因是不应把包管理器拼装与 `systemd-run` 沙箱逃逸逻辑在 `host_ops` 中复制第二套；仍严格锁死原有白名单 `ALLOWED_PACKAGES = ("caddy", "wireguard-tools", "socat", "nftables")`。
- **Agent 端强制护栏（不信任前端）**：
  1. **身份与目标边界**：所有写动词与系统调优仅允许 Hub `self` 且 `root`（`target != self` 返回 `E_PEER_FORBIDDEN`，非 root 返回 `E_NO_PRIV`）；`ProtectSystem=full` 下的 `/etc`、`/swapfile`、`/usr` 写操作统一走 `systemd-run` 一次性 unit 沙箱外执行，严禁 shell 字符串拼接。
  2. **服务停用硬黑名单**：除 `systemd-*`、`ssh`/`sshd`、`dbus` 外，硬拒绝 `networking`、`NetworkManager`、`systemd-networkd`、`khc-agent*`、`caddy`、`wg-quick@*`、`khc-fw`（`E_PROTECTED`）；仅允许常见可控服务或已知精简列表操作，写后回读 `systemctl is-active` 校验。
  3. **Swap 安全检查**：已有激活 swap 时拒绝重复叠加；根分区可用空间必须 `>= 目标大小 + 1 GiB`；`/swapfile` 强制 `0600`；Btrfs 用 `chattr +C` + `dd` 创建，ext4/xfs 优先 `fallocate` 回退 `dd`；OpenVZ/LXC 容器不支持 `swapon` 时返回明确可理解错误；`/etc/fstab` 使用 `# khc-managed-swap` 注释标记实现幂等增删，并落盘 `/etc/sysctl.d/99-khc-swap.conf`（`vm.swappiness=10`）。
  4. **包升级边界**：仅检查与升级白名单 4 个系统包（`apt-get install --only-upgrade -y <pkg>`，dnf/yum/apk 同理）；**绝不执行全系统 `apt full-upgrade`**，不修改系统 apt 源配置；升级后校验二进制与受管服务状态。

## 5. 范围与不做

- 不做：后台定时检查更新/自动升级、直接 `kill` 进程、全系统包更新、Web Shell/任意命令框、Peer 侧写调优、独立监控常驻进程。

## 6. 分批计划

| 批次 | 改动范围 | 验收标准 | 必测项 | 是否 bump |
|---|---|---|---|---|
| **P1 服务精简与中文指南** | `agent/adapters/host_ops/`、`apps/web/src/apps/host-ops/`、`zh.ts` | 前端静态字典覆盖常见系统进程/服务（短标 + 详情建议）；「可精简系统服务」支持查看内存并安全 `停用/启用`；核心服务硬保护不可关 | Agent 单测（黑名单拦截、停用/启用幂等与非 root 拒绝）；Web 烟测 + 浅/深/390px 截图 | 面板 minor + Agent minor |
| **P2 主机「优化」标准表** | `agent/adapters/host_ops/`、`apps/web/src/apps/host-ops/`、`HubOpsPage.tsx`、`page-specs.md`、`docs/host-ops.md` | 4 列标准表 + `HOST_TUNE_ITEMS` 可扩展注册；一键 2G Swap（含 1G/2G/4G 抽屉与删除）、BBR 开关、journald 清理限 100M、APT 缓存清理全部走通 | Agent 单测（空间不足、已有 swap、Btrfs、fstab 幂等、BBR、journald）；Web 烟测 + 测试机真机实测 | 面板 minor + Agent minor |
| **P3 内置组件手动检查更新** | `agent/khc/pkg.py`、`agent/adapters/host_ops.py`、`apps/web/src/apps/node-settings/ComponentsCard.tsx` | 卡头 `[检查更新]` 手动探测白名单包可升级版本；无更新只 Toast，有更新行内展示候选版本并支持异步升级与日志回显 | `test_pkg.py`（跨包管理器 mock、非白名单拒绝、升级失败不破坏现运行）；Web 组件烟测 | 面板 minor + Agent minor |

## 7. 待拍板项

1. **P2「优化」表首批 4 项**（Swap 2G / BBR / journald / APT 缓存）是否全部保留，还是有需要增减的项？
2. **分批实施顺序**：默认按 `P1（服务指南与精简）→ P2（一键 2G Swap 与优化表）→ P3（组件检查更新）`，还是先做最迫切的 `P2`（一键 Swap）？
3. **极简 UI 方案确认**：按「列表仅留名称 + 状态/数值 + 单动作，解释进抽屉/确认框」规范落地并合入本提案后，即可派发第一批开发。
