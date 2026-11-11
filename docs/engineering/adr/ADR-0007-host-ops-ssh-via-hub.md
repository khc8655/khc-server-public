# ADR-0007: 主机运维走“Hub 经 SSH 按需调用 + Peer 静态受限脚本”

- 状态：已接受（2026-10-29 补记：移除 `kill` 写动词，进程列表只读；2026-11-03 复核补记：D-5/T4.6 如实化"Hub 失陷"边界表述，收窄 `keys.add`/`cron.set` 列为待办）
- 日期：2026-10-26
- 决策者：主人

## 背景

主人需要在面板上对 Hub 与 Peer 做基础运维：看系统状态、结束异常进程、改防火墙端口策略、管理 SSH 公钥（详见 `docs/host-ops.md`）。使用频率很低（出问题时点一下），主人明确**不希望在 Peer 上安装守护进程**。控制面在 Cloudflare，进不了 WireGuard 网络；能进 WG 的只有 Hub。

## 选项

| 选项 | 做法 | 利 | 弊 |
|---|---|---|---|
| A Peer 装 Agent，Hub 中继 | Peer 跑同一 Agent，仅监听 WG IP | 实时、与 Hub 一致 | Peer 多一个常驻进程；需要核心加中继端点 |
| B1 免安装 SSH | Hub 用普通公钥 SSH，每次通过 stdin 推送采集脚本 | Peer 上只有一行公钥 | Hub 失陷 = 所有 Peer 的完整 shell |
| **B2 静态受限脚本（选定）** | Peer 放一个不运行的脚本 + `restrict,command=,from=` 受限公钥；Hub 经 WG SSH 调用白名单动词 | 无守护进程；Hub 失陷拿不到交互式 shell、只能执行白名单动词（但白名单本身可被滥用，见 2026-11-03 复核补记）；核心不动 | 脚本需人工更新；依赖 Peer 有 python3 与可达的 sshd |

## 决策

采用 **B2**。Hub 本机也通过同一脚本执行写操作（`target=self`），Hub 与 Peer 一套动词、一套输出。实现为适配器 `host-ops` + 页面，**不改冻结核心**。

## 影响 / 迁移 / 回滚

- 新增：`agent/adapters/host_ops*`、`apps/web/src/apps/host-ops/`、UI 变更单 #008。
- 无 D1 迁移、无契约变化；运维结果不落库，写动作照常审计。
- 回滚：在界面执行卸载命令，或删除适配器；Peer 上留下的只有静态文件，可一键清理。
- 安全：脚本不可被 Hub 远程覆盖；Hub SSH 私钥只在 Hub 本地；主机密钥严格校验。

## 验证

见 `docs/host-ops.md` §10 的 staging 真机清单。

## 补记（2026-10-29，#50）

- 移除 `kill` 写动词：经 WG SSH 远程结束进程误杀 sshd/WG/Agent 的风险高、需求低；
  `WRITE_VERBS` 只剩 `fw.apply` / `fw.confirm` / `keys.add` / `keys.remove`。
- 脚本 `SCRIPT_VERSION` 升到 1.1.1；旧脚本的 `kill` 不再被 Hub 调用，Peer 按既有
  `E_SCRIPT_OLD` 提示更新。
- 面板 ProcessDrawer 只保留按 CPU/内存排序的只读进程列表与详情；无结束入口/二次确认。
- `E_PROTECTED` 保留给 `keys.*`（Hub 运维公钥与标记块外条目不可删）。

## 复核补记（2026-11-03，D-5/T4.6 如实化）

- 早期表述"Hub 被攻破时拿不到 shell"**过于乐观**，如实口径为：**Hub 失陷 + host-ops 凭据
  （Hub 侧 SSH 私钥 + Agent 通道）→ 攻击者可在已接入的 Peer 上执行白名单动词**。拿不到
  交互式 shell（`restrict,command=` 锁死、动作全审计、脚本不可被 Hub 远程覆盖），但白名单
  动词本身可被滥用：
  - `keys.add` 可向任意允许用户的 authorized_keys 注入公钥，攻击者随后**带外**直接 SSH 登录
    该 Peer（等价于拿到完整 shell）；
  - `cron.set` 可写定时任务行，带外升级为任意命令执行；
  - `fw.apply` 可改动 Peer 防火墙（有 `E_LOCKOUT` 护栏与 60s 回滚，但拦不住故意放行）。
- 结论：B2 的真实价值是**显著抬高门槛与留痕**（无守护进程、无交互式 shell、写动作全审计、
  脚本不可远程覆盖），**不是**把"Hub 失陷"降为无害。
- 待办（本批明确不做、仅列档，等后续拍板）：`keys.add` / `cron.set` 收窄为仅 `target=self`，
  或 Peer 侧本地 opt-in 开关文件（Hub 不可远程覆盖）作为接入前置条件。
