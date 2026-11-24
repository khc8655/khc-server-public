# plan: 按需安全日志诊断与防火墙白名单收口

> 状态：草案 ｜ 最后核验：2026-11-24 ｜ 关联：[host-ops](../host-ops.md)、[diagnostics](../diagnostics.md)、[security-boundaries](../security-boundaries.md)

## 1. 背景与实机观察

基于 `联通 vm`（`106.74.24.207`）实机排查与日常运维使用习惯，现有链路暴露出两类高价值痛点：

1. **公网暴力扫描日志缺乏归纳与诊断提示**：实机近 24 小时 `journalctl -p 0..3` 共 `6,409` 条错误中，`6,387` 条（99.7%）是 `sshd` 遭公网暴力扫描引发的 `kex_exchange_identification` 与 `MaxStartups throttling`。目前这些异常淹没在原始错误折叠区里，点「诊断」无法直接看清节点正遭遇高频爆破及可执行的防线建议。同时主人明确要求日志分析**不写入 D1 数据库、平时 0 流量、主机运维保持按需只读**。
2. **精简云镜像缺少 `nftables` 用户态包且防火墙缺白名单收口**：实机内核自带 `nf_tables.ko.zst`，apt 源亦有 `nftables 1.0.9`，仅因镜像未预装 `nft` 二进制（及 `iptables`/`ufw`/`firewalld`）而在防火墙页报错。同时 UI 当前叠加两条内容重复的红色/黄色提示。更关键的是，现有 `table inet khc_fw` 为 `policy accept`（仅拦自定义 `deny`），且硬锁放行 `DEFAULT_SSH_PORT = 22`，无法满足「只对公网开放面板受管应用端口，必要时关闭 22 端口、应急走云厂商 VNC」的收口需求。

---

## 2. 方案对比与推荐

| 需求 | 方案 A | 方案 B（推荐） | 推荐原因 |
|---|---|---|---|
| **安全/攻击日志诊断** | 后台 Cron/上报定时聚合写入 D1 审计或监控表 | **诊断按需触发 + 节点侧只读聚合（`journalctl`），不落 D1** | 严格遵守控制面不存高噪声运行日志的定位，不占 Workers/D1 免费额度；仅点击「诊断」时 3 秒预算内返回脱敏摘要 |
| **防火墙补齐与收口** | 兼容/改写多套 `iptables`/`ufw`/`firewalld` 后端 | **保持单一权威 `table inet khc_fw`：一键装 `nftables` + 增加白名单收口模式（`policy drop`） + 可选关 22 端口** | 延续现有原子替换与 60s 失联自动回滚机制，避免多防火墙表互相打架；只在确定兼容的 Hub 上启用 |

---

## 3. 范围与不做

- **范围**：按需安全日志聚合与诊断项；`nftables` 缺失诊断与一键安装修复；防火墙页重复提示去噪；`khc-fw` 白名单模式（`allowlist`）与 Hub 本机可选关闭公网 22 端口。
- **明确不做**：
  1. 不在节点跑 Fail2ban / 实时 IDS 常驻守护进程或自动封禁 IP。
  2. 不把原始日志或攻击记录写入 D1，不新增 Cron / WebSocket / 后台轮询。
  3. 不改动 `table inet khc_fw` 之外的第三方或云厂商 nft/iptables 链规则。
  4. **Peer 节点不开放**「远程安装 `nftables`」与「关闭 SSH 22 端口」——Hub 对 Peer 的唯一运维通道依赖 WG 上的 SSH，关掉或锁死且通常无带外 VNC 将导致不可恢复失联。

---

## 4. 设计要点

### 4.1 按需安全诊断（全只读、0 D1、遵守 64KB 上限）

- **采集来源（`agent/adapters/host_ops/khc_host.py` / `agent/adapters/host_ops.py`）**：
  - 在「诊断」按需查询链路中复核近 24 小时 `journalctl`（只读、限制扫描上限行/秒数，如 `-n 2000`、`timeout=2s`）：
    - 统计 `sshd` 失败/扫描特征（`kex_exchange_identification`、`Invalid user`、`Failed password`、`Connection closed by authenticating user`、`MaxStartups throttling`）的 24h 命中次数。
    - 提取 Top 5 来源 IPv4/IPv6（只取格式合法的 IP 字面量，严禁回显用户名/密码/命令）。
    - 若面板 Caddy 站点存在明显高频异常或可用日志（可选轻量扩展），只统计脱敏计数。
- **诊断呈现（`apps/api/src/lib/app-diagnostics/host.ts`）**：
  - 按需将异常结果转为 `khc.host.ssh_bruteforce`（或通用安全告警问题项，严格遵循 `≤300` 字文案与 `64KB` 总响应上限）。
  - 达到告警阈值时 `severity: 'warn'`，提示 24h 扫爆次数与 Top IP 摘要，并引导至「主机 → 防火墙」开启白名单收口或关闭公网 SSH 22 端口；**结果仅随当次响应返回前端，不入 D1**。

### 4.2 `nftables` 缺失区分与面板一键修复

- **真实能力探测（`agent/adapters/host_ops/khc_host.py`）**：
  - `version` 与 `fw.show` 细化探测字段：`nft`（二进制是否存在）、`nftInstallable`（仅 Hub 本机 + root + `apt-get` 可用且内核支持 `nf_tables` 模块或已加载，则可一键安装）、`nftUnavailableReason`。
- **一键安装动作（`host-ops`）**：
  - 新增仅 Hub 本机、`target === 'self'`、写锁保护的异步动作（或复用任务机制）：调 `khc.pkg.ensure_packages(["nftables"])`（仅允许硬编码白名单包 `("nftables",)`，禁止前端传包名），安装后执行 `nft --version` 验证并刷新 `fw.show`。
- **UI 去噪（`apps/web/src/apps/host-ops/FirewallSegment.tsx`）**：
  - 消除截图中重复的红、黄两条 `不支持 nftables` 提示：当 `error.code === 'E_UNSUPPORTED'` 且状态带/提示区已给出不可用说明时，不再叠加第二条相同报错横幅；若 `nftInstallable === true`，在单一卡片/横幅内提供 L2 确认按钮「一键安装 nftables」。

### 4.3 防火墙白名单收口模式（仅开放面板应用与自定义放行）

- **状态模型兼容**：
  - `fw.nft` / `fw_state.json` 及 `fw.show` / `fw.apply` 契约向后兼容地增加 `mode: "open" | "allowlist"`（缺省为 `"open"`，存量规则零变化）。
- **`allowlist` 规则生成（`table inet khc_fw`）**：
  - `chain input` 使用 `type filter hook input priority filter - 5; policy drop;`。
  - **强制自动放行集合**（先于自定义规则与最终 drop）：
    1. `ct state established,related accept`、`iifname "lo" accept`、`meta l4proto icmp accept` / `icmpv6 accept`（必要 ICMPv6 保证 IPv6 邻居发现）；
    2. Hub WG 地址（如有）；
    3. `agent_ports`（按运行中的 `khc-agent` 实际监听端口）；
    4. `wg_ports`（`ports.json` 与 `/etc/wireguard/*.conf`）；
    5. **面板受管应用端口**：汇总 `ports.json` 中由 `caddy-site` 与 `port-forward` 等适配器登记并激活的 `tcp` / `udp` 监听端口；
    6. `ssh_ports`（当 `closePublicSsh === false` 时默认放行；见 §4.4）；
    7. 用户自定义的 `allow` 规则（如自定义业务端口、白名单管理 IP）。
  - 延续既有 `nft -c -f` 预校验 + `systemd-run --on-active=60` 自动回滚机制：若开启后把 Agent 入口阻断导致面板无法调用 `fw.confirm`，60 秒后自动回退到上一个可用防火墙状态。

### 4.4 可选「关闭公网 SSH 22 端口」（L3 强确认）

- 仅当 `mode === "allowlist"` 且为 Hub 本机时开放 `closePublicSsh: boolean`（默认 `false`）。
- 启用后：
  - `build_ruleset` 不再自动把 `22` / `ssh_ports` 写入全网放行规则，改为由 `policy drop` 拦截公网对 22 端口的直接扫描；
  - 对主动保留特定管理源的例外，用户仍可在规则列表手动添加带具体 `source` CIDR（或仅允许 WireGuard 接口/网段）的 `allow tcp/22` 规则；`rule_lockout_reason` 对 22 端口在 `closePublicSsh === true` 时放行，但对 `agent_ports` 与 `wg_ports` **永远拒绝拦截**。
- **L3 强确认护栏**：UI 开启「关闭公网 SSH」并应用时，弹出 L3 确认要求勾选「我已验证云厂商 VNC 控制台可用」并输入节点名确认；成功后仍进入 60 秒二次确认回滚窗口。

---

## 5. 实施批次

| 批次 | 改动范围 | 验收标准 | 必测项 | 是否 bump |
|---|---|---|---|---|
| **批次 1：按需安全日志诊断** | `agent/adapters/host_ops/khc_host.py`、`host_ops.py`、`apps/api/src/lib/app-diagnostics/host.ts`、诊断单测、文档 | 点「诊断」返回 24h SSH 爆破/异常统计与 Top IP（脱敏，≤64KB），D1 零写入，节点只读执行 | Agent Python 单测（日志聚合与脱敏、耗时/行数上限）+ Worker `diagnostics.test.ts` + `./scripts/verify.sh` | Panel patch、Agent patch |
| **批次 2：`nftables` 一键安装与横幅去重** | `khc_host.py`、`host_ops.py`、`apps/web` `FirewallSegment.tsx` / `hostOps.ts`、测试、文档 | 缺 `nft` 但内核支持时只显示 1 条提示并支持一键安装；安装后立即可加载并编辑规则 | Agent 单测（能力探测/包名白名单/`run` mock）+ Web `hostops.smoke.test.tsx` + UI 三截图（浅/深/390）与四态 | Panel minor/patch、Agent patch |
| **批次 3：白名单收口与关闭公网 22 端口** | `khc_host.py`、`host_ops.py`、`FirewallSegment.tsx`、`FirewallRulesEditor.tsx`、契约（按需扩展 `packages/contracts`）与测试、文档 | 切至「仅开放面板应用」自动放行 Agent/WG/Caddy/转发端口并阻断其余端口；开启关闭公网 22 需 L3 确认且支持 60s 回滚 | Agent 防火墙规则生成 & `E_LOCKOUT` 单测 + Web 抽屉/L3 确认测试 + 测试机 `aws-e2e`（有 VNC/私钥复核后）或 `106.74.24.207` 实机验收（遵循先 `nft -c` 再 60s 回滚） | Panel minor、Agent minor |

---

## 6. 待主人拍板项

1. **SSH 爆破告警默认阈值**：建议近 24 小时异常/爆破连接 **≥ 50 次**触发 `warn`（低于 50 次仅作正常过滤或低噪提示），**≥ 500 次**给出高风险提示。是否认可该阈值？
2. **关闭公网 22 端口后的管理访问策略**：开启「关闭公网 SSH 22 端口」后，是**彻底全网拦截 22（应急全走云厂商 VNC）**，还是自动保留来自本节点 **WireGuard 内网地址（如 `10.x.y.z/24`）** 的 SSH 访问？
3. **安全与权限边界确认**：是否为防无带外 VNC 导致永久失联，明确把「一键安装 `nftables`」与「关闭公网 SSH 22 端口」限定**仅对 Hub 节点本机开放**，Peer 节点维持现有强制 SSH 保护？
