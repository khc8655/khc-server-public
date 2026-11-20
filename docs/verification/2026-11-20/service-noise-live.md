# 「系统单元失败」降噪后的真机复核（2026-11-20）

> 状态：历史（证据）｜ 关联：`docs/verification/2026-11-20/panel-module-smoke.md` §3 第 7 项、PR #96 / #97

## 1. 问题与口径

走查时 aws-hui-us 的运维页状态带摆着红色「3 个失败」，服务段三行全红。实际三条都是发行版自带单元：

| 节点 | 失败单元 | 归属 |
| --- | --- | --- |
| aws-hui-us | `fwupd.service`、`fwupd-refresh.service`、`apt-daily-upgrade.service` | 发行版 / OEM |
| unicom-cn-1 | `cloud-final.service` | cloud-init |
| oracle-x86-2 | 无 | — |

这些单元的启动逻辑由发行版负责，面板既不能修也不该催；长期红灯的结果是用户学会无视整块告警，
真出问题时（`khc-agent` 挂了）反而看不见。所以本轮把口径收敛为一条：

**红色只留给面板受管的单元** —— `khc-*` / `caddy` / `wg-quick@*`，名单仍然只有
`apps/web/src/data/managedUnits.ts` 一份（判定收口在新文件 `apps/host-ops/serviceStatus.ts`）。
系统单元失败仍然如实显示，但改为中性文字 / 黄色行，不计入「待处理」。

## 2. 行为复核（面板 0.19.4）

### 2.1 状态带「服务」瓦片（三节点）

`data-tone` 为状态带瓦片实际渲染属性，直接读页面：

| 节点 | 渲染文本 | data-tone |
| --- | --- | --- |
| oracle-x86-2 | 服务 正常 | `neutral` |
| aws-hui-us | 服务 3 个系统单元失败 | `neutral` |
| unicom-cn-1 | 服务 1 个系统单元失败 | `neutral` |

修复前 aws-hui-us 是「3 个失败」+ `danger`（红色）。「读不到失败单元」（旧 Agent 且 `/state`
也没给）现在显示「未知」而不是「正常」，这条由 `serviceStatus.test.ts` 覆盖。

### 2.2 服务段行色调

aws-hui-us 服务段实测（取 `ui-dot-*` / `ui-badge-*` 类名）：

| 单元 | 状态 | 渲染 |
| --- | --- | --- |
| `caddy.service` | active | `ui-dot-ok` / `ui-badge-ok` |
| `khc-agent.service` | active | `ui-dot-ok` / `ui-badge-ok` |
| `apt-daily-upgrade.service` | failed | `ui-dot-warn` / `ui-badge-warn` |
| `fwupd.service` | failed | `ui-dot-warn` / `ui-badge-warn` |

表头上方同时给一行说明：「另有 N 个系统自带单元处于失败状态（如 fwupd、apt-daily）：面板不管理
它们的启动逻辑，只作提示，不算待处理。」行内的重启 / 清除失败状态入口保持不变。

### 2.3 受管单元失败仍然是红色（对照组）

「降噪」不能顺手把真问题也降掉，所以造一条受管失败来对照：在 aws-hui-us 上临时放一个
`khc-e2e-fail.service`（`Type=oneshot` + `ExecStart=/bin/false`），`systemctl start` 后为 failed。
刷新运维页：

| | 渲染 | 结论 |
| --- | --- | --- |
| 瓦片 | 「服务 1 个失败」+ `danger` | 只数受管那条，红色保留 |
| `khc-e2e-fail.service` 行 | `ui-dot-danger` / `ui-badge-danger` | 受管失败仍是红色 |
| `fwupd.service` 行 | `ui-dot-warn` / `ui-badge-warn` | 系统单元仍是黄色 |
| 说明行 | 「另有 2 个系统自带单元…」 | 两类分开计数 |

> 顺带证到：`fwupd-refresh.service` 被 `reset-failed` 后会被自己的 timer 再次拉起并再次失败，
> 所以「清失败标记」对这类单元只是暂时消痕 —— 这正是面板不该替它报警的原因。

## 3. 文案统一（面板 0.19.5）

0.19.4 之后同一件事还有两个叫法：状态带 / VM 运维卡片是「N 个系统单元失败」，节点概况那行入口
仍是「系统服务 N 个失败」。0.19.5 统一为「N 个系统单元失败」，复验：

- 节点概况主机卡片入口：`3 个系统单元失败 ›`（点击进运维页，行为不变）；
- 控制台页脚：`面板 v0.19.5`。

## 4. 现场恢复

| 项 | 处理 | 复查 |
| --- | --- | --- |
| `khc-e2e-fail.service` | `reset-failed` + 删 unit + `daemon-reload` | `list-units --state=failed` 只剩 `apt-daily-upgrade` / `fwupd`（`fwupd-refresh` 由 timer 再次失败） |
| 临时公钥 | `host-ops` → `keys.remove`（`SHA256:RA65…ZAo`） | `keys.list` 只剩既有的 `ubuntu_vm_key`；本机 `ssh root@3.145.75.134` 回到 `Permission denied (publickey)` |
| socat | 由 `socat-install-live.md` 的安装任务装回 | `dpkg -l socat` 正常 |

## 5. 门禁

- `./scripts/verify.sh` 全绿：Agent 1168 passed、前端 938 passed（97 files / 5 skipped）、typecheck、
  docs-lint、发版一致性、安装/卸载生命周期 22 项。
- 新增单测：`apps/web/src/apps/host-ops/serviceStatus.test.ts`（7 条：受管/系统单元色调、三态计数）；
  页面冒烟新增 1 条（系统单元失败行仍列出并给说明）。
- 合并链：`38989d6`（#96，面板 0.19.4）→ 文案统一（#97，面板 0.19.5）。
