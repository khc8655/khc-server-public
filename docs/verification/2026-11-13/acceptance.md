# 主机诊断增强与面板装软件：批次 1–3 验收证据（2026-11-13）

> 状态：现行（一次性验收证据，写完不再修改） ｜ 最后核验：2026-11-13 ｜ 关联：`docs/plans/diagnostics-and-terminal-2026-11-13.md`

## 1. 环境

| 项 | 值 |
|---|---|
| 提案 | PR #27（已拍板，合并为 `a4e0288`） |
| 生产面板 | 最终 `0.12.6`，commit `b5a3e7ed5c95`，入口 `https://a.18888.bond` |
| 生产 Agent 包 | `0.1.44` → `0.1.45` → `0.1.46`（签名清单两版本回溯） |
| 测试节点 | oracle-x86-2（Ubuntu 24.04，Agent 拉取式升级到 0.1.46） |
| PR | #28（批次 1）、#29（批次 2）、#30（批次 3）、#31（§4.3 缺陷修复），均 CI 全绿并合并 |
| 本地门禁 | 每个 PR 合并前 `./scripts/verify.sh` 全绿（vitest 793 / D1 39 / 安装器 22 / Python 单测 / docs-lint 49 份） |

## 2. 批次 1：主机诊断（PR #28）

真机在 oracle-x86-2 上构造并复核：

- `fallocate` 把根分区填到 **88.3%** → 诊断出现 `khc.host.disk_full`（warn，evidence `metric=space, percent=88.3`）；删除填充文件回到 11%，告警消失。
- 造 `qa-diag-fail.service`（`ExecStart=/bin/false`）→ 出现 `khc.host.units_failed`（warn，`units=qa-diag-fail.service`）；`reset-failed` + 删单元后消失。受管单元（`caddy`/`khc-*`/`wg-quick@*`）过滤未误伤。
- `reboot_required`（info）随节点真实标记出现；ACME 仍为 info 降噪；响应 `reachable=true`、未截断。
- 节点实测新增 ops 字段：`oom={total:0,lastIncreaseAt:0}`、`rootReadonly=false`、`memoryPressure=0.0`。
- 清理后磁盘 11%、failed 单元 0 个、Agent active。

### §4.3 真机结论与修复

`systemctl cat khc-agent` 显示 `ProtectSystem=full`、`NoNewPrivileges=true`、`PrivateTmp=true`，`ReadWritePaths` 不含 `/usr`。以同等沙箱属性执行 `systemd-run --wait --pipe --collect --property=ProtectSystem=full --property=NoNewPrivileges=true /bin/sh -c 'touch /usr/bin/...'` 返回 **READONLY**，证实 `ctx.run()` 直接跑包管理器写不了 `/usr`。按提案 §4.3 开出修复 PR #31（`agent/khc/pkg.py` 改用 `systemd-run` 跳出沙箱）。

## 3. 批次 2：进程 CPU 与系统错误（PR #29）

- `yes > /dev/null`（ps 实测 99.6%）→ `host-ops` 动词 `processes`（target=`self`）返回该进程 **cpu=100**，`durationMs=904`（含 0.5 秒二次采样），`scriptVersion=1.5.3 / expectedVersion=1.5.3 / updateRequired=false`。
- `logs.errors`（target=`self`）返回 `windowHours=24`、`count=50`（上限生效），消息为脱敏后的系统错误与 OOM 段（0 条 OOM）；`write=false`，无凭据回显。
- 面板主机运维页 Segmented 仍为 5 项（服务 / 进程 / 防火墙 / SSH 公钥 / 定时任务），「系统错误（近 24 小时）」为服务分段内的折叠区；点开后才请求、无轮询，实测显示「最近 24 小时 · 50 条错误 · 0 条 OOM」。
- 测试进程已按 PID 清理，Agent 仍 active。
- **Peer 真机未测**：当前生产 2 台均为 Hub、Peer 0/0；只读放行与 `E_PEER_FORBIDDEN` 由 `test_peer_readonly_and_restart_verbs_allowed` / `test_peer_high_risk_write_verbs_rejected` 单测覆盖，待有 Peer 节点补测。

## 4. 批次 3：发布本机监听端口（PR #30）

- 起 `python3 -m http.server 9000 --bind 0.0.0.0` → 对外服务页「本机监听端口」列出 `9000 / 0.0.0.0 / tcp`；已有站点上游 `127.0.0.1:8443` **未重复列出**；保留端口 22/80/443/8880/8899 未出现。
- 点击 9000 → 复用既有站点抽屉，显示「目标来源：本机（127.0.0.1）」「目标端口 9000」「上游地址 127.0.0.1:9000」，打开时无写请求。
- 390 宽实测 `document.documentElement.scrollWidth === 390`。
- 测试服务已按 PID 清理，端口释放。
- **未执行「保存并生效后外网可访问」**：该步骤需新增/改动这台节点现有 Caddy 站点（域名、对外端口、TLS 证书），风险超出只读验收范围；保存链复用既有 `saveSite`/`applyNow`，冒烟测试覆盖预填与「无写请求」。建议后续在独立测试 Hub 补测。

## 5. §4.3 修复真机复核（PR #31）

升级节点到 Agent 0.1.46 后：

- `agent/khc/pkg.py` 含 `SYSTEMD_RUN_PREFIX = ("systemd-run","--quiet","--collect","--wait","--pipe")`。
- 同前缀执行 `touch /usr/bin/...` 返回 **WRITABLE**（对照修复前 READONLY），证明一次性 unit 在沙箱外。
- 同前缀执行 `apt-get install -y --no-install-recommends socat` 成功返回（已装包幂等，`0 newly installed`），输出经 `--pipe` 回传。
- 测试文件已清理；`khc-agent` active。

## 6. UI 四态与截图

| 页面 | 四态 |
|---|---|
| 主机运维「系统错误」折叠区 | 加载=骨架、空=EmptyState、错误=InlineError+重试、有数据=Table（6 条冒烟用例 + 390 宽） |
| 对外服务「本机监听端口」 | 加载=Table 骨架、空=EmptyState、错误=InlineError+重试、有数据=Table、离线=中性说明（7 条冒烟用例 + 390 宽） |

截图（真实 Chrome，浅色 / 深色 / 390）：

- `ops-system-errors-light.png` / `ops-system-errors-dark.png` / `ops-system-errors-390.png`
- `services-listening-ports-light.png` / `services-listening-ports-dark.png` / `services-listening-ports-390.png` / `services-listening-ports-drawer-light.png`

## 7. 遗留

- 提案批次 4（T-A 面板终端）按 §7 第 6 条仍阻塞：需主人先在生产面板启用 TOTP 并确认，代码未开工。
- Peer 侧 `logs.errors` 真机、「发布本机端口」的保存生效 + 外网可访问两项待补（§3 / §4）。
- 进程列表「入选 Top N」仍由 `ps --sort=-cpu` 生命周期均值决定；两次采样只修正显示值（提案 §3.4 已说明代价）。
  → 已修（#35）：改为先对全部进程采样、按采样 CPU% 排序再截 Top N，脚本 `1.5.4` / Agent 0.1.47，见 `docs/verification/2026-11-14/`。
