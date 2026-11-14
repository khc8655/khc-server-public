# TLS 证书落地与运行时前置检查（提案）

> 状态：**已拍板并全部分批实施**（2026-11-14）｜ 最后核验：2026-11-14 ｜ 关联：`docs/runbook/node-onboarding.md`、`docs/live-observation.md`、ADR-0010
>
> 四个批次的 PR：批次 1 #45、批次 4 #46、批次 3 #47、批次 2 #48。

## 1. 背景

2026-11-14 在联通云境内节点（`unicom-cn-1`，Ubuntu 24.04 / systemd 255）+ 新加坡 NAT Peer（`sg-nat`）上做全功能验收。功能面全部跑通：Peer 真实握手、Peer 上发布应用、端口转发指向 Peer、host-ops 纳管 Peer、`via=fetch` 域名接入、浏览器 10s 直连快照。

过程中撞到四个缺陷，均**不阻断主流程**，但都会让运维动作失败或给出错误结论。本提案把它们收拢成四个批次。

现场事实（可复现）：

| 编号 | 现象 | 现场证据 |
|---|---|---|
| P1 | `caddy-site` 用 `tls.mode=manual` 下发证书后 Caddy 起不来 | `reload` 报 `open /etc/caddy/khc-certs/unicom-hub.khc66.top.key: permission denied`，systemd 卡在 `reloading` 直到超时被杀 |
| P2 | 面板页脚显示「证书状态：未签发（该域名未建站点，Caddy 不会申请证书）」，但该域名 HTTPS 实际可用 | 同一时刻 `curl https://unicom-hub.khc66.top:8443/health` = 200，证书 CN/issuer 正常 |
| P3 | 受限网络下 `install.sh --acme` 无法签发 | 国内 80/443 入站被墙，TLS-ALPN-01 与 HTTP-01 均不可达；只能手工 `acme.sh --dns dns_cf` |
| P4 | host-ops 接入命令在缺 python3 的机器上报错方向误导 | `khc-host` 首行 `#!/usr/bin/env python3` → `env: 'python3': No such file or directory`，UI 提示「主机上的运维脚本不存在，请重新执行接入命令」 |

## 2. P1：`caddy-site` manual 证书文件属主

### 根因

`agent/adapters/caddy_site.py` 生成证书文件时只给 mode，不给属主：

```python
files[path] = File(path, content, mode=0o600)
```

而 `File` 本身**已支持** `owner` / `group`（`agent/khc/adapters.py:67-75`，注释写明「如 Caddy 需要读取的证书」），内核也已有落地实现（`agent/khc/kernel.py:934` 调 `_apply_owner`）。也就是说基础设施齐备，适配器没用。

`0600 root:root` 在「Caddy 以 root 运行」的假设下没问题；但发行版包（Debian/Ubuntu `caddy.service` 默认 `User=caddy`）读不了，reload 直接失败。

### 方案

- **A（推荐）适配器探测 Caddy 运行用户并传给 `File`**：从 `systemctl show caddy -p User`（或 `/proc/<pid>/status` 的 `Uid`）取运行用户，`owner`/`group` 同时传；探测失败或用户不存在时保持 root（`_apply_owner` 对不存在的用户已做忽略）。改动集中在 `_cert_files()` 一处，约 15 行。
- **B 在文档里声明「必须让 Caddy 以 root 运行」**：不改代码，但 apt/repo 装的 Caddy 必然踩坑，且降低加固，不推荐。
- **C 把 `khc-certs` 目录设成 `caddy` 组 + `0640`**：仍然要知道组名，等于 A 的简化版，但目录权限改动会影响回滚语义，不推荐。

### 附带要修的行为

reload 失败后 systemd unit 停在 `reloading`，需要人工 `systemctl restart caddy` 才恢复。apply 失败路径应在 reload 超时后主动 `restart` 或把 unit 复位，否则下一次 reload 也无法生效。

## 3. P2：证书状态判定只看面板托管站点

### 根因

`apps/web/src/pages/HubOverviewPage.tsx:126-150` 用两个来源判定：`caddy-site` 的 `siteHealth`（按 `site.domain === node.domain` 过滤）与面板内 `sites` 列表。二者都只覆盖**面板托管的** Caddy 站点。

当 TLS 由外部承载（本机引导配置、上游负载均衡、Tunnel 源站），面板会报「未签发」。文案本身是诚实的（「该域名未建站点」），但前置的标签是「证书状态」，运维读到的是**证书没签**，与事实相反。

### 方案

- **A（推荐）改判定依据为「节点 endpoint 的真实 TLS 结果」**：Agent 已有 `certificates.inspect` 思路可复用；更直接的是 Worker 在 `/state` 探测时若 endpoint 是 `https://`，就把握手拿到的证书（subject / issuer / notAfter / 是否可信）一并回传，前端优先展示它。附带好处：Tunnel 与外部反代场景同样受益。
- **B 只改文案**：把「未签发」改成「面板未托管该域名的站点，证书状态未知」。一行改动，成本最低，但仍不告诉运维证书到底有没有。
- **C Agent 自报**：Agent 不知道自己对外的域名是什么（`accessMode=ip` 时尤其），信息不全，不推荐。

A 的代价是每次 `/state` 多一次 TLS 握手；可用与 `/state` 相同的 2s 去重窗口缓存，或在打开工作区时探一次。

## 4. P3：`install.sh --acme` 只支持 80/443 验证

### 根因

`agent/install.sh:424,490` 固定用 `--issue --alpn`（失败回退 `--standalone`，即 HTTP-01）。两条路都需要公网入站 80/443。境内未备案主机、只开非标端口的节点全都不满足，脚本只能打印提示让用户手工 `acme.sh --dns dns_cf`。

另外 acme.sh 自动续期依赖 crontab：脚本已尽力安装 cron 并在失败时 WARN，容器镜像里常装不上，此时证书到期需人工续签，且这个降级**只在安装输出里出现一次**，面板侧无任何可见状态。

### 方案

- **A（推荐）新增 `--acme-dns <provider>`**：透传给 `acme.sh --issue --dns <provider>`，凭据从环境变量读（`CF_Token` 等），与 `agent/adapters/certificates.py` 已有的 `_PROVIDER_DNS` / `_CREDENTIAL_FIELDS` 保持同一套 provider 命名。同时把续期载体从 crontab 改为 **systemd timer**（Agent 已以 root 运行，timer 不依赖 cron 是否存在）。
- **B 只在文档里写清「受限网络请手工签发」**：现状，运维每次都要照抄命令，不推荐。
- **C 走 Caddy 自带 ACME**：需要 DNS provider 插件，发行版 Caddy 包不含（`caddy list-modules | grep dns.providers` 为空），只能自编译，不推荐。

续期结果建议由 `certificates` 适配器的 `status()` 上报 `problems`（如「证书 30 天内到期且续期未生效」），让面板诊断能显示，而不是只在安装日志里说一次。

## 5. P4：host-ops 接入命令缺少运行时预检

### 根因

接入命令只做三件事：建 `khcops` 用户、投递 `khc-host`、写受限 `authorized_keys`。但 `khc-host` 是 Python 脚本，命令**不检查目标机是否有 python3**。

失败后的映射也不准：`_map_ssh_failure`（`agent/adapters/host_ops.py:1286-1305`）把 `rc == 127` 归为 `E_SCRIPT_MISSING`，于是 UI 说「主机上的运维脚本不存在，请重新执行接入命令」，把运维引向重跑命令（无效），而真实原因是缺运行时。

### 方案

- **A（推荐）接入命令里加前置检查**：执行前探测 `command -v python3`，缺失则以清晰错误退出（`E_RUNTIME_MISSING`，提示安装 python3 后重跑）。同时在 `_map_ssh_failure` 里把「`env: 'python3': No such file`」与一般的 `command not found` 区分开。
- **B 把 `khc-host` 改成纯 POSIX shell**：彻底去掉运行时依赖，但 118 KB 的 Python 逻辑重写成本与回归风险都高，不推荐。
- **C 接入命令里自动装 python3**：越权（接入不应主动装包），不推荐。

## 6. 范围与不做

做：上述四个批次的适配器/安装脚本/前端判定与对应测试、文档同步。

不做：

- 不改 `packages/contracts` 的核心表结构；P2 若确需给 `/state` 增加字段，走契约变更并单独评审。
- 不动 `agent/khc/kernel.py` 的写入语义（`File.owner` 已够用）。
- 不引入 Caddy 的 DNS 插件与自编译。
- 不改动 `docs/verification/`、`docs/archive/`。

## 7. 批次

每个批次一个 PR，从最新 main 拉分支。全部为 PATCH 级修复，无破坏性契约变更。

### 批次 1：`caddy-site` 证书属主（Agent bump）

- 改动：`agent/adapters/caddy_site.py`（`_cert_files` 传 owner/group）、`agent/adapters/caddy_site.py` 内 Caddy 用户探测、reload 失败后复位 unit；`agent/tests/test_caddy_site.py`。
- 验收：构造 `User=caddy` 环境，manual TLS apply 后 `systemctl is-active caddy` = active，`https` 站点可访问；`User=root` 环境行为不变。
- 必测：`python3 -m unittest discover -s agent/tests -t agent`；`./scripts/verify.sh`。
- bump：`agent/VERSION` PATCH。

### 批次 2：证书状态以 endpoint 实测为准（面板 bump）

- 改动：`apps/api` 的 `/state` 探测路径（若需新字段先改 `packages/contracts`）、`apps/web/src/pages/HubOverviewPage.tsx` 判定与文案、`apps/web/src/i18n/zh.ts`；补充 `HubOverviewPage` 相关测试。
- 验收：域名节点证书正常时显示「已签发 + 到期日」；证书过期/不受信时显示对应告警；无域名时文案不变；外部承载 TLS 的节点不再误报「未签发」。
- 必测：`./scripts/verify.sh`；UI 改动附浅色/深色/390 宽截图与四态说明。
- bump：面板 PATCH。

### 批次 3：`install.sh --acme-dns` 与 systemd timer 续期（Agent bump）

- 改动：`agent/install.sh`（新增 `--acme-dns`、凭据环境变量、timer 单元）、`agent/adapters/certificates.py`（`status().problems` 上报即将到期）、`docs/runbook/node-onboarding.md` §4.1。
- 验收：`--acme-dns cloudflare` 在 80/443 全关的机器上签发成功；`systemctl list-timers` 能看到续期 timer；去掉 cron 后仍能自动续期。
- 必测：shell 脚本 dry-run 路径；`./scripts/verify.sh`；`node scripts/docs-lint.mjs`。
- bump：`agent/VERSION` PATCH。

### 批次 4：host-ops 运行时预检（Agent bump）

- 改动：`agent/adapters/host_ops.py`（接入命令加 python3 检查、`_map_ssh_failure` 细分）、`agent/tests/test_host_ops.py`。
- 验收：缺 python3 的机器上执行接入命令给出明确提示；有 python3 时行为不变；`E_RUNTIME_MISSING` 在面板上有对应文案。
- 必测：`agent/tests/test_host_ops.py`；`./scripts/verify.sh`。
- bump：`agent/VERSION` PATCH。

## 8. 拍板结果（2026-11-14）

1. **P2 走 A（控制面实测）**：给 `/state` 增加**可选**字段 `tls`（`additive`，旧客户端/旧 Worker 双向兼容，不破坏既有契约）。落地时进一步收窄了范围——不是「读证书字段」（Workers 的 `fetch` 与 `cloudflare:sockets` **都不暴露 peer cert**），而是**用探测结果本身作证据**：平台对 https 请求做完整且不可关闭的校验，探测成功即「证书对该主机名有效且受信」，证书类失败即反证，网络类失败只能说未知。零额外握手、零外部依赖。见批次 2。
2. **P2 的探测频率**：不额外探测——复用 `/nodes/:id/state` 已有的那次调用，页面每 10s 刷新即天然带上结论，不加缓存层也没有第二次握手。
3. **P3 的凭据来源**：环境变量（可脚本化）。凭据缺失在**改动系统之前**就 `exit 1`，并在提示里给出可直接复制的 `CF_Token=... ./install.sh ...` 形式；凭据不写盘。
4. **P1 的探测方式**：两条都试，顺序为 `/proc/<pid>` → `systemctl show -p User` → 回退用户名 `caddy`。`_find_process_uid` **优先返回非 root 候选**，避免误取适配器自己以 root 跑的 `caddy validate` 子进程。
5. **批次顺序**：实际按 1 → 4 → 3 → 2 推进。1/3/4 都改 `agent/` 且都要 bump `VERSION`，同一行反复冲突，因此 4 堆叠在 1、3 堆叠在 4（#45 → #46 → #47，合并顺序固定）；批次 2 只动面板与契约，从 main 拉出独立合并（#48）。

### 实施结果

| 批次 | 内容 | PR | 门禁 |
|---|---|---|---|
| 1 | caddy-site manual 证书属主跟随 Caddy 运行用户；reload 失败复位 unit | #45 | 1074 tests |
| 4 | host-ops 接入命令 python3 预检 + `E_RUNTIME_MISSING` | #46 | 1075 tests |
| 3 | `install.sh --acme-dns`（DNS-01）+ systemd timer 续期 + 证书到期上报 | #47 | 1083 tests |
| 2 | 证书状态以控制面实测为准（`tls.state` 四态） | #48 | 1071 py + 87 vitest files |

### 仍未闭环

- **批次 3 的 DNS-01 实签发与 `systemctl list-timers`** 需在有 root + 真实 DNS 凭据的节点上验证；本批次只覆盖了参数校验、预检报告与逻辑单测。
- **批次 2 的 UI 截图**（浅色/深色/390 宽）未出图，四态由 jsdom 冒烟测试断言页脚渲染文本覆盖。
- **`hk-nat` 节点**仍留在配置中（离线），保留或回滚待定。
- **acme.sh 续期**：`unicom-cn-1` 现有证书是手工签发的，尚未安装 `khc-acme-renew.timer`；重跑一次带 `--acme` 的安装命令即可补上（证书已存在会跳过签发）。
