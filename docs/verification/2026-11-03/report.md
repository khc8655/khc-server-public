# 服务端能力复验报告（feat/server-capabilities 批次 I + 批次 J 修复复验，2026-11-03）

> 状态：现行（一次性复验证据；结论已同步 `CHANGELOG.md`；F-1/F-2/F-3 已闭环——批次 J/K，见 §8/§9；批次 L 缺陷 F-L1/L2/L3 已于批次 M 修复并上线复验，见 §11；F-M1 已于批次 N 修复上线并复验，见 §12；批次 Q 删除清理默认值修复与最终一致性核对见 §15；批次 R peer 隧道补验全通过，见 §16；批次 S 方案 B 修复（§16 两缺陷）见 §17；架构整改批次 2 见 §18、批次 3（rev epoch）见 §19；D-6 删 `wrangler.staging.toml` 与版本预览实测见 §20；CF DNS 多凭据/节点域名/进程过滤见 §21；读取已有解析记录、合并上线与真机闭环见 §23/§24） ｜ 适用范围：feat/server-capabilities 分支的实机验证与清理记录 ｜ 最后核验：2026-11-03 ｜ 关联：`docs/archive/audit-2026-11-02/`（上轮报告）、`docs/engineering/release.md` §6.2（0.1.7 实例）
>
> 测试环境：本地 `wrangler dev --remote`（代码本地 + 远程真实 D1）+ 仓库构建产物直装 Agent 0.1.6。
> 测试机：test-hub 203.0.113.10（hub）、node-test-3 203.0.113.11（peer）；node-test-2 **只读跳过未动**（§24 起用于新节点真机闭环）；香港 NAT 机 SSH 端口不可达（与上轮 server-test §2 一致）。

## 1. 结论概览

- `./scripts/verify.sh` 全绿，**27.9s**（user 43.9s / sys 7.9s / 185% cpu）：typecheck、vitest 380、web build、compileall、agent 单测 **812**、Agent 包一致性（0.1.6，sha256 `50a03ffa…`）、迁移幂等、shell 语法。
- 实机复验本轮修复全部通过：**发现并修复两个本轮引入的回归**（见 §2，属于用户指令"本次修复引入的明显错误可修并说明"例外条款），轮换全往返/cancel/peer 脚本负路径/svc.logs 实机通过（见 §3）。
- 两个新发现项（不修，归下一批）：cleanup 动词对 `/opt/khc` `/etc/khc` 的删除在 Agent 沙箱内必然失败（§4 F-1）；cleanup 不覆盖已 confirm 的防火墙产物（§4 F-2）。
- 测试环境已清理至可重复起测状态（§6）。

## 2. 本轮引入回归的修复与实机证据（例外条款：修并说明）

批次 D–G 的修复在实机复验中暴露两个回归，均为本轮引入（`b391be2` 轮换 overlay / `5165cad` 发布链路窗口内引入），已修并以 0.1.6 出包：

### R-1 WireGuard 动作 error 为字符串（Bug A）
- **现象**：`peer_install_script` 预期失败（如 peer 不存在）返回 `{"ok": false, "error": "…"}`，字符串 error 被 Worker `agentEnvelopeSchema` 拒收 → 面板侧 500。
- **修复**：wireguard 适配器 4 个动作（client_config / peer_install_script / rotate_peer / confirm_rotation / cancel_rotation）共 27 处预期失败统一改 `_action_error()` → `{code, message[, details]}` 对象（契约见 `agent/adapters/certificates.py` 顶部）；单测补 `error_body()` 形状断言与 `peer_not_found` code/details 断言。
- **实机证据**：0.1.6 下未知 peer → `{"code":"peer_not_found","message":"peer 不存在: ghost","details":{"peer":"ghost"}}`（HTTP 200 + ok:false，信封解析正常）；缺 peer 参数 → `missing_param`。

### R-2 换钥看门狗复用过期 deadline（Bug B）
- **现象**：hub journalctl 每 1s 刷 `wireguard rotation tick failed: 同步动作超过 Worker 窗口，已中止并回滚`（0.1.5 实测 10 分钟 537 次）；轮换永远停在 pending。
- **根因**：`_ensure_watchdog` 把请求 ctx 存给后台线程复用，ctx 携带同步动作 12s 窗口 `deadline`，过期后线程内所有 `ctx.run` 抛 `sync_deadline_exceeded`。
- **修复**：`_ensure_watchdog` 起线程前 `ctx.deadline = None`（Ctx 为内核每次调用新建，改动安全；注释已说明）；单测 `test_ensure_watchdog_clears_sync_deadline` 回归。
- **实机证据**：热装 0.1.6 重启后 **0 次** tick 报错；遗留的 pending 轮换（arm1b）在重启后 1 个 tick 内自动推进 **cutover**。

版本处置：0.1.5 打包后未发布（manifest 仍指向 0.1.4），按 `docs/engineering/release.md` §6.2 流程 bump 0.1.6 重打包，0.1.5 包已从仓库移除。

## 3. 实机通过项矩阵

| 复验项 | 结果 | 证据 |
|---|---|---|
| 首个 apply 不再因 /etc/khc 只读失败 | ✅（前一轮已验，本轮热装后未复现） | `a498aa7` 修复；/opt/khc /etc/khc 由 apply 正常创建 |
| fw.apply 回读校验 + 假成功报错 | ✅（前一轮已验） | `E_FW_VERIFY`；本轮 cleanup 前确认 confirm 规则真实生效（nft `udp dport 51820 accept` 存在） |
| wg0 首次 apply 校验（接口必须真起） | ✅（前一轮已验） | wg_verify_failed 链路 |
| svc.list / svc.restart / svc.logs | ✅（logs 本轮补测） | `svc.logs khc-agent.service` 返回 journal 尾读，且负路径（服务名不带 `.service` → `E_BAD_REQUEST`）校验生效 |
| cron 管理 | ✅（前一轮已验） | cron.list/set |
| peer 一键安装脚本 | ✅（前一轮已验 arm1b 回连） | 负路径本轮补验（§2 R-1） |
| 手动轮换往返（换钥失败可回退且不失联） | ✅ **全往返** | rotate→pending→（新钥握手）→自动 cutover→confirm_rotation→arm-1 ping 10.99.0.1 3/3（RTT 2.5ms）；再 rotate→cancel→ping 仍 3/3，隧道全程未断 |
| 删除 peer/hub 的服务清理（cleanup 动词） | ✅（主体功能） | cleaned: wg-conf/wg-service/caddy-khcd/caddy-reload + khc-forward unit；残留清单正确上报（见 F-1/F-2） |
| install.sh --with-caddy 与自签证书编排 | ✅（前一轮已验） | Caddy 2.11.7 安装并运行，khc.d import 生效 |
| 双通道 TCP（公网裸 IP） | ✅（via tcp-fetch，dev remote 模式实测） | wrangler dev --remote 全程经 cloudflare:sockets 连裸 IP hub |
| 0.1.6 热装（仓库构建产物直装） | ✅ | scp + 覆盖 /opt/khc-agent + 重启，health 200，adapter 清单正常 |

## 4. 新发现项（批次 I 发现；F-1/F-2 已于批次 J 修复，见 §8）

### F-1 cleanup 动词无法删除 /opt/khc 与 /etc/khc（残留清单阻断删除流程）
- **现象**：`cleanup` 返回 `remaining: opt-khc（Errno 16 Device or resource busy）`、`etc-khc（Errno 30 Read-only file system）`，目录为空仍删不掉。
- **根因**：agent unit `ProtectSystem=full` + `ReadWritePaths=… /etc/khc /opt/khc …` 使这两个目录成为 systemd bind mount；khc-host 在 Agent 命名空间内对 mountpoint 执行 `rmdir` 必然 EBUSY/EROFS。
- **复现步骤**：全新 hub 安装 agent（unit 含 ReadWritePaths）→ 面板 apply 任一应用（创建 /opt/khc /etc/khc）→ `POST /apps/host-ops/call {"verb":"cleanup"}` → remaining 含 opt-khc/etc-khc；在宿主 shell `sudo rmdir /opt/khc /etc/khc` 成功。
- **影响**：面板「删除节点/Peer（同时清理本机服务）」会被残留清单持续阻断，只能退化为"仅删记录"；`docs/runbook/troubleshooting.md` §10 卸载清理可补充此说明。

### F-2 cleanup 不覆盖已 confirm 的防火墙产物
- **现象**：fw.confirm 后规则持久化在 `table inet khc_fw` + `/etc/systemd/system/khc-fw.service`；cleanup 后两者残留（本次手工 `nft delete table inet khc_fw` + 删 unit 清除）。
- **复现步骤**：fw.apply + fw.confirm → cleanup → `nft list ruleset | grep khc` 仍有表；`/etc/systemd/system/khc-fw.service` 仍在。
- **建议方向（下一批）**：cleanup 增加 fw 未 confirm 的回滚（复用 60s 窗口机制）或显式列入 remaining。

## 5. 待部署后复验项（未在本地验证，不伪造通过）

| 项 | 原因 |
|---|---|
| 双通道 fetch→TCP 回退 E2E（生产 Worker） | dev remote 模式代码在本地 workerd，fetch 路径行为与生产 isolate 存在差异 |
| CF DNS 实 Token 代建 A/AAAA 与联动删除 | 需真实 Cloudflare Token + Zone，未在本轮使用 |
| Agent 远程自升级 UI（0.1.6） | 需先部署 Worker 且主人更新 `AGENT_RELEASE_MANIFEST`（含 0.1.6 条目） |
| 线上包 sha256 == 仓库包 | CI deploy job 自动核对；`GET /api/v1/agent/releases` 人工核对 |

## 6. 环境清理记录（已恢复可重复起测状态）

- **test-hub（hub）**：cleanup 动词（wg0/Caddy khc.d/转发 unit）→ 手工 `rmdir /opt/khc /etc/khc`（F-1 workaround）→ 手工删 `table inet khc_fw` 与 `khc-fw.service`（F-2 workaround）→ `uninstall.sh --purge`（unit/程序/数据/配置/token）→ 删 `/usr/local/sbin/khc-host`、`/etc/sudoers.d/khc-host` → /tmp 包文件删除。核对：/opt/khc-agent、/etc/khc-agent、/var/lib/khc-agent、/etc/wireguard 均不存在，nft 无 khc 表。Caddy 2.11.7 与空 khc.d 目录 + Caddyfile import 保留（install 幂等，可重复起测）。
- **node-test-3（peer）**：`wg-quick down khc0` → 删 `/etc/wireguard/khc0.conf` → 卸载 wireguard-tools。核对：wg 无接口、/etc/wireguard 不存在。
- **面板 D1**：测试节点 `nd_xxxxxxxxxxxxxxxx` 已删除，`GET /api/v1/nodes` 返回空列表（本轮无其他测试数据）。
- **本地**：`wrangler dev --remote` 已停止；`.dev.vars` 已还原（移除本轮临时追加的 `ADMIN_PW_HASH`）；/tmp 临时文件（cookie、dev 日志、verify 日志）已删除。
- **node-test-2（生产预用）**：只读跳过，未做任何改动。

## 7. 耗时与测试规模（批次 I）

- `./scripts/verify.sh`：27.9s（vitest 380 用例 5.1s、agent 812 用例 13.6s、build 1.0s，其余为 typecheck/compileall/包校验/shell 语法），CI 时间可控。
- Agent：0.1.4（线上）→ 0.1.6（0.1.5 未发布被取代）；sha256 `50a03ffaf283…`。

## 8. 批次 J 追记：F-1/F-2 修复与实机复验（2026-11-03，Agent 0.1.7 / khc-host 1.4.1）

### 8.1 F-1 挂载点目录（修复 + 实机通过）

- **修复**：`_cleanup_rmtree` 放弃 `os.path.ismount` 预判（对同设备 bind mount 在部分 Python 版本判定 False，实机第一轮未生效）——改为 errno 兜底：rmtree 抛 `EBUSY/EROFS` 时降级为只清空目录内容；内容清空则记入新增 `skipped` 清单（目录保留、明确上报原因、不阻断删除流程），清空失败才记 `remaining`（带 errno）。
- **实机证据**（test-hub，Agent 0.1.7 热装后）：`/opt/khc`、`/etc/khc` 各放 marker 文件 → cleanup → 两目录内容清空、目录保留、`skipped: [opt-khc（EBUSY）, etc-khc（EROFS）]`、`remaining` 不含两项 → 面板删除流程不再被阻断。
- **幂等**：干净状态复跑 cleanup，`ok:true`、`remaining: []`、skipped 语义稳定（两项仍为内容已清空的挂载点）。

### 8.2 F-2 已确认防火墙产物（修复 + 实机通过）

- **修复**：cleanup 第 5 步补齐 fw 产物清理：stop/disable/删除 `khc-fw.service` + `daemon-reload`、`nft delete table inet khc_fw`（先 probe，表不存在直接记 cleaned）、fw 规则/状态文件 `fw.{nft,backup.nft,state.json,state.backup.json}` **双布局都清**（宿主直跑默认 `/etc/khc-host/` 与 hub self 的 Agent 数据目录 `fw-state/`，按路径去重）。
- **实机证据**：fw.apply（1 条管理规则）→ fw.confirm（`persisted:true, unitEnabled:true`）→ cleanup → `cleaned` 含 fw-unit/fw-table/fw-rules×2/fw-backup×2/fw-state×2；机器核对 `nft list table inet khc_fw` 不存在、`khc-fw.service` not found、`fw-state/` 目录空。
- **单测**：新增 8 例（挂载点 skipped/部分失败 EACCES 上报/fw 全产物清理+幂等/fw 表删除失败 remaining/fw 状态目录 override 双布局），agent 单测 812 → **817** 全绿；`./scripts/verify.sh` 退出 0。

### 8.3 F-3 新发现：PATCH /nodes/:id 的 token 被静默丢弃（批次 K 已修，见 §9）

- **现象**：换 token 后 Agent 全部请求 401 `bad_signature`（tcpdump 实证 Worker 已发出新 HMAC）。
- **根因**：`PATCH /nodes/:id` 路由把含明文 `token` 的 patch 透传给 D1 层，而 d1 实现只认 `tokenEnc`，明文字段被静默丢弃 → token 永不更新，且无任何报错。
- **当前 workaround（也是文档化流程）**：`POST /nodes` 创建时响应里的一次性 token 写入 Agent 侧 `/etc/khc-agent/token` 并重启；token 轮换需求出现时再立项修（改 d1 层支持明文 token 写入或路由层显式报 400）。

### 8.4 环境清理（批次 J 复验后）

- **test-hub**：cleanup（F-1/F-2 生效后零残留核对：nft 无 khc 表、无 khc-fw.service、/etc/khc-host 空、fw-state 空、/opt/khc /etc/khc 空）→ 批次 I 遗留的 `/etc/khc-host` 三个宿主直跑残留文件（沙箱只读删不掉）宿主侧手工 `sudo rm` → `uninstall.sh --purge` → `rmdir /opt/khc /etc/khc /etc/khc-host` → /tmp 包文件删除。核对：/opt/khc-agent、/etc/khc-agent、/var/lib/khc-agent 不存在，nft 无 khc 表，sudoers.d 无 khc 条目。
- **面板 D1**：测试节点 `nd_xxxxxxxxxxxxxxxx` 已删除，`GET /api/v1/nodes` 返回空列表。
- **本地**：`wrangler dev --remote` 已停止；`.dev.vars` 已还原（移除临时 `ADMIN_PW_HASH`）；/tmp 临时文件（cookie、fw-apply/task JSON、dev 日志、临时 pem）已删除。
- Agent 发布链：0.1.7 包（sha256 `804056143c02…`）入库 `apps/web/public/agent/`，CI `verify-agent-release` 通过。

## 9. 批次 K：F-3 修复 + 上线（2026-11-03，提交 8cd2e1a）

### 9.1 F-3 修复（Worker 契约）

- 根因更正：明文 `token` 不在 `updateNodeRequestSchema` 中，被 zod 默认剥离——PATCH 静默成功但 token 永不更新。
- 修法（方案 A，支持轮换）：契约加 `token`（16–128 字符）；路由层用 `MASTER_ENC_KEY` 加密为 `tokenEnc` 写入 D1；响应零回显；审计只记 `tokenRotated: true`（不再整包落 patch）；非法格式 400 `validation_failed`。补 2 例路由测试（轮换生效 + 密文存储 + 审计脱敏 / 格式校验），vitest 382 全绿。
- 批次 J 的 workaround（一次性 token 反写 `/etc/khc-agent/token`）不再是唯一路径，标准流程回归：`PATCH /nodes/:id {"token": "…"}`。

### 9.2 合并与部署

- `feat/server-capabilities`（16 commits，批次 A–K）squash 合入 `main`（`8cd2e1a`，遵循仓库"squash + 合入说明"风格）并推送；CI 三 job 全绿：Agent tests（21s）/ Typecheck+Test+Build（1m49s）/ Deploy production Worker（46s）。
- 本地 `./scripts/verify.sh` 退出 0；`verify-agent-release --repo` 一致。

### 9.3 发布清单（AGENT_RELEASE_MANIFEST）

- 本地找到既有签名私钥 `<home>/Documents/alivm/.khc-local/release-keys/agent-release-private.pem`（与线上 `AGENT_RELEASE_PUBKEY` 公钥指纹一致，旧 0.1.4 清单即此钥签发，**未新造钥**）。
- 签发含 0.1.7 条目的新清单（url `https://panel.example.com/agent/khc-agent-0.1.7.tar.gz?v=20261103`，sha256 `80405614…`）并 `wrangler secret put AGENT_RELEASE_MANIFEST`；清单文件留存本地 `release-manifest-0.1.7.json`（私钥不入仓库）。

### 9.4 部署后复验（真实执行，2026-11-03，https://panel.example.com）

| 项 | 结果 |
| --- | --- |
| `GET /`（面板首页） | 200 |
| `GET /api/v1/health` | `{"env":"production"}` |
| 登录 | 200（cookie 下发正常） |
| 限流 429 | 错误口令第 10 次起 429 `too_many_attempts`（10 次/300s/IP），持续 429 ✓ |
| `GET /api/v1/agent/releases` | 返回 0.1.7，sha256 `804056143c02…` == 仓库包；签名验证通过（即钥匹配） |
| 面板安装链接下载包 | 下载 sha256 == 仓库 `khc-agent-0.1.7.tar.gz` sha ✓ |
| 节点创建/删除 | `POST /nodes`（k-smoke，返回一次性 token）→ `DELETE` 均 200，终态节点列表为空 |
| CF DNS 未配 Token | `GET /cf-dns` → `{enabled:false, configured:false, hasToken:false}`（无报错）；`POST /cf-dns/test` → 明确 `cf_dns_not_configured` ✓ |

### 9.5 上线后待办（批次 I/J 遗留整理；批次 L 复验后状态见 §10.5 修订）

1. **F-3 后续（可选）**：面板 UI 暂无 token 轮换入口（本轮只修 API）；如需面板操作再加（属 UI 红线，需方案确认）。
2. **限流锁定提醒**：批次 K 复验触发过本机 IP 的登录限流（10 次/5 分钟窗口，已过期）；如主人即刻登录遇 429，等 5 分钟即可。
3. ~~**生产节点升级 0.1.4 → 0.1.7**~~：已在批次 L 完成（node-test-2，见 §10.1）。
4. ~~**备份文件清理**~~：`backup-20261102.sql` 已在批次 L 删除（主人确认）。
5. **批次 J 未尽事项**：无（F-1/F-2/F-3 均已闭环）。
6. **后续观察**：Cloudflare TCP socket 通道在生产的错误率（面板"传输"诊断页，批次 E 加的冷却/预算指标）上线一周后复核一次。

## 10. 批次 L：远程升级验证 + 生产链路 E2E（2026-11-03，主人授权 node-test-2 全权使用）

环境前提（与预期不同，如实记录）：node-test-2 实为**无 Agent 的干净机器**（D1 亦无节点），"0.1.4 在线"前提不成立——批次 L 先装 0.1.4 再走真实升级。Oracle 安全列表仅放行 80/443/8443（8880/2052 超时）；主机 iptables 默认 REJECT 全部——批次 L 为主机放行 tcp/80 并持久化（netfilter-persistent），并用手工创建的 DNS A 记录 `node-test-2.example.com`（DNS-only，手工经 CF API 建，原因见 F-L1）作为节点域端点。

### 10.1 远程升级 0.1.4 → 0.1.7（面板 → Worker → Agent 全链路，正式验证）

- 0.1.4 安装（install.sh --system --port 80）+ 节点注册（一次性 token 写 `/etc/khc-agent/token`）→ 节点在线 0.1.4。
- `POST /nodes/:id/agent/upgrade {packageUrl, sha256}` → `{accepted, fromVersion:"0.1.4"}` → Agent 拉包/校验/替换/重启。
- **第一次升级失败并自动回滚（真实发生）**：0.1.7 启动即 crash loop（`ensure_dirs` 建 `/etc/khc` EROFS，见 F-L2）→ 看门狗健康检查失败 → **自动回滚 0.1.4，服务恢复在线**（失败回滚机制实证 ✓）。
- 宿主侧补建 `/etc/khc` `/opt/khc` 后重试升级 → 成功：文件 0.1.7、journal `khc-agent 0.1.7 starting`、`state.agent.version=0.1.7`、6 适配器加载、节点恢复在线。
- 版本回显：面板节点列表/详情正常；升级 taskId 在 Agent 重启后查不到（任务存内存，重启即失）——记录为已知行为。

### 10.2 生产链路 E2E（真实面板 → Worker → node-test-2）

| 项 | 结果 |
| --- | --- |
| 首次应用 apply（/etc/khc） | node-exporter install（下载 1.8.2 二进制）+ apply → `/etc/khc/apps/node-exporter/node_exporter.args` 写入、khc-node-exporter active ✓ |
| wg0 首次起接口 | wireguard hub 配置 apply → `/etc/wireguard/wg0.conf` 生成、wg-quick@wg0 active、`wg show` 公钥/监听 51820 ✓ |
| 防火墙 apply 回读 | fw.show（锁定端口清单）→ fw.apply（60s 回滚窗 + token）→ fw.confirm（persisted/unitEnabled）→ `nft list table inet khc_fw` 实存 ✓ |
| cron 读写 | cron.list ✓（managed/unmanaged）；**cron.set ✗（F-L3：hub 沙箱 /etc/cron.d 只读）** |
| 服务重启/日志 | svc.logs（3 行 journal）✓；svc.restart khc-node-exporter → restarted+active 回读 ✓ |
| peer 一键脚本 | onboard 生成 installCommand（内联 base64 khc-host + 受限 authorized_keys，结构完整）✓；**真实 peer 机执行未做**（需第二台机器改动，超出本轮范围） |
| 删除时服务清理 | host-ops cleanup（经生产 Worker）→ cleaned 全项（wg-conf/wg-service/fw-unit/fw-table/fw 双布局文件）、remaining=[]、skipped={opt-khc,etc-khc}；机器核对 wg0 消失、nft 表消失、cron 无 khc-*、/etc/khc/apps /opt/khc/apps 清空、khc-fw.service 不存在 ✓；node-exporter 需面板 uninstall（设计内），已补卸载 |

### 10.3 双通道 E2E（生产 Worker，真实执行）

- **fetch 命中**：node-test-2（域端点 `node-test-2.example.com:80`）→ `state.via="fetch"` ✓。
- **TCP 命中 + fetch 失败回退**：test-hub 临时节点（裸 IP `203.0.113.10:8880`）→ fetch 对裸 IP 403 失败 → 回退 TCP socket → `state.via="tcp"`、0.1.7 在线 ✓（测毕节点已删、Agent 已 purge）。

### 10.4 CF DNS

- Token 配置（PUT /cf-dns）+ test ✓：zone 自动发现（example.com）、状态 active。Token 留存于面板设置（主人可随时清除）。
- **代建 ✗（F-L1）**、**联动删除未验证**（同因被 F-L1 阻断，无 managed record 可删）。节点域名 A 记录系手工经 CF API 创建（proxied=false），不在面板管理清单内。

### 10.5 批次 L 缺陷清单（全部**未修**，待主人判断）与待办修订

缺陷（按用户指令不顺手修，列出来停下）：

1. **F-L1（CF DNS 代建失败）**：`createRecord` 发送 `tags:[KHC_RECORD_TAG_KEY]`，而文档承诺的最小权限 Token（Zone→DNS→Edit + Zone→Zone→Read）不含 record tags 配额 → CF 返回 "DNS record has 1 tags, exceeding the quota of 0" → 面板报 `cf_dns_auth`。修法二选一：去掉 tags（改用 comment 标记）或文档改为要求 Token 含 tags 权限。
2. **F-L2（升级缺目录 → crash loop，回滚兜底）**：Agent 自升级流程不创建新版本引入的数据目录（`/etc/khc`、`/opt/khc`；unit `ReadWritePaths` 带 `-` 前缀忽略缺失）→ 升级到 0.1.7 后新版本 `ensure_dirs` EROFS 崩溃循环，靠看门狗回滚保命。影响所有从 ≤0.1.6 升级且目录不存在的机器。修法：升级流程在重启前创建 install.sh 定义的目录集。
3. **F-L3（hub self 模式 cron.set 不可用）**：unit ReadWritePaths 未含 `/etc/cron.d` → E_NO_PRIV（错误消息自己提示"hub 沙箱需将 /etc/cron.d 加入白名单"）。cron 管理实际仅 peer 场景可用；属文档/实现不一致。

未验证项（如实标注）：

- CF DNS 联动删除（被 F-L1 阻断）。
- peer 一键脚本在真实 peer 机上的执行（只验证了命令生成）。
- 面板 UI 交互（本轮全部经 API 执行；UI 点击流未走）。

最终状态：node-test-2 = 节点 `nd_xxxxxxxxxxxxxxxx`（node-test-2，域端点）在线、Agent 0.1.7（via fetch）、无测试残留（wg0/fw/cron/应用全清、/tmp 清理）；主机 iptables 放行 tcp/80（持久化，Agent 可达性所需，保留）；DNS A 记录 node-test-2.example.com 保留（节点端点在用）；test-hub 无 Agent、D1 无临时节点；仓库 `backup-20261102.sql` 已删除。

**修订（批次 M，2026-11-03）**：§10.5 缺陷清单 F-L1/F-L2/F-L3 已全部修复并上线实机复验通过（见 §11）；CF DNS 代建/联动删除与 hub cron.set 两项未验证项亦已补验通过（见 §11.3）。

## 11. 批次 M：F-L1/L2/L3 修复 + 上线复验（2026-11-03，Agent 0.1.8 → 0.1.9）

### 11.1 修复内容（main `43ae7c7` squash + `7885f66`）

1. **F-L1**（Worker）：`apps/api/src/lib/cf-dns.ts` 去掉 `tags` 字段（最小权限 Token 无 record tags 配额，CF 拒绝建带 tags 的记录），托管标记只保留 comment；联动删除本就按 D1 登记的 recordId 执行、不依赖 tags。`docs/cf-dns.md` 与 `docs/security-boundaries.md` §10 同步为"最小权限、不需要 tags 权限"。
2. **F-L2**（Agent）：`agent/khc/upgrade.py` 在重启服务前补齐新版数据目录——`_ensure_required_dirs()`（/etc/khc /opt/khc /etc/wireguard 0700 等 install.sh 目录集；沙箱内 EROFS 时经 `systemd-run --wait` + 轮询兜底）与 `_refresh_unit_sandbox()`（对比包内新模板把旧 unit `ReadWritePaths` **只增不减**追加 + `daemon-reload`）。升级流程由"当前运行版本的代码"执行，因此修复自其随版本落地后的**下一次**升级起生效。
3. **F-L2 竞态补丁（0.1.9）**：0.1.8 实测发现 `systemd-run` 返回 rc=0 时临时 unit 可能尚未执行（journal 顺序实证：回滚先于 `Started khc-upgrade-dirs-…service`），立即 isdir 检查误判失败触发回滚。0.1.9 加 `--wait` + 10s 轮询，回归测试覆盖。
4. **F-L3**（Agent）：hub 场景 cron 管理恢复可用——升级时经 §11.1-2 的 `_refresh_unit_sandbox` 把旧 unit（0.1.4 时代无 `/etc/cron.d`、`/root/.ssh`）的白名单补齐；`docs/security-boundaries.md` §3 白名单表 + §3.1"旧机器升级时的白名单补齐"同步。
5. 测试：`agent/tests/test_upgrade.py` 新增 6 例（目录补建/EROFS 回退 systemd-run/异步竞态回归/失败回滚/unit 白名单追加与跳过），upgrade 26 用例、agent 单测共 **823** 全绿；`./scripts/verify.sh` 退出 0。

### 11.2 发布与上线

- Agent 0.1.8（sha256 `879de2df…`，`43ae7c7`）与 0.1.9（sha256 `62966d65…`，`7885f66`）两次出包、签发清单（既有私钥，公钥指纹与线上一致，未新造钥）并入库 `apps/web/public/agent/`。
- 两次推送 CI 三 job 全绿并自动部署生产；`AGENT_RELEASE_MANIFEST` secret 两次更新；线上 `GET /api/v1/agent/releases` sha 与仓库包一致（0.1.9 = `62966d65…`）。

### 11.3 实机复验（node-test-2，真实执行）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 升级 0.1.7 → 0.1.8（目录存在） | ✅ 升级成功 | 0.1.8 在线健康；此跳由 0.1.7 代码执行，无新逻辑，符合预期 |
| 制造"目录缺失"场景升级（F-L2） | ✅（0.1.9） | 删 /etc/khc /opt/khc /etc/wireguard → reinstall → journal 实证 EROFS → `systemd-run` 临时 unit `install -d -m 755 /etc/khc`、`-m 700 /etc/wireguard` 成功 → 0.1.9 健康**无回滚**，目录权限正确 |
| 0.1.8 期的回滚实证（竞态） | ✅（缺陷→0.1.9 修复） | 0.1.8 reinstall 时 systemd-run rc=0 但 unit 异步未执行 → 误判回滚；0.1.9 `--wait` 后复验通过 |
| unit 白名单补齐（F-L3） | ✅ | 0.1.8→0.1.9 升级时 ReadWritePaths 追加 `-/root/.ssh -/etc/cron.d`（journal/unit 实证） |
| hub cron.set / cron.list | ✅ | 生产链路创建 `/etc/cron.d/khc-m-test`（按 khc_host 契约 `{"name","content"}`）、list 回显；测试条目已清理 |
| CF DNS 代建（F-L1） | ✅ | 新节点 `POST /cf-dns/records` → A 记录 `m-dns-test.example.com → 203.0.113.14` 创建 201，CF API 确认记录存在、comment 标记、无 tags |
| CF DNS 联动删除 | ✅ | 删除节点 → `DELETE /cf-dns/records/:nodeId` → `deleted:true`，CF API 该名下记录 count=0 |
| 双通道抽验 | ✅ | 域端点 fetch 命中（`via:"fetch"`）；裸 IP:80 回退 TCP 命中（`via:"tcp"`——实测澄清：cloudflare:sockets 对 80 可用，批次 L §10.3 的"仅非标端口"表述按此修正） |

机器终态：Agent **0.1.9** 在线（`/health {"ok":true,"version":"0.1.9"}`）、节点 online、cron 测试条目已清、目录/权限正确、`.prev` 升级备份保留（设计：下次升级时清理）；CF DNS 测试节点已删。

### 11.4 F-M1 新发现（已定位根因；**批次 N 已修复上线**，修法与实证见 §12）

- **现象**（批次 M 复验期观察到）：`GET /nodes/:id/state` 面板报 `reachable:true, state:null, error:"Agent /state 返回格式不合法"`，fetch/TCP 表现一致；同窗口直接从 Agent 抓取的 `/state` 真实响应（4529 字节）对 `agentStateSchema.safeParse` **通过**；事后线上端点复验正常。瞬时性 + 两路一致 → 排除 schema 静态不匹配与通道问题。
- **根因链**（代码 + 实机取证）：
  1. `/state` 是最重的 Agent 端点（ops 收集：systemctl/ps/df 多次子进程），而 `nodes.ts` 对它用全库最短的 `timeoutMs: 3000`；升级复验窗口 systemd 忙（进程表 systemd 22% CPU）时收集可超 3s。
  2. fetch 3s 超时中断，但请求已送达 Agent、**nonce 已被消耗**；`node-client` 的 fetch→TCP 回退**复用同一签名头（同 nonce）**。
  3. Agent `NonceCache`（120s 防重放）对重放 nonce 返回 **401 错误信封**（实机实证：同 nonce 二次请求 → `401 {"ok":false,"error":{"code":"unauthorized","message":"nonce already used","details":{"reason":"nonce_replayed"}}}`）。
  4. `nodes.ts` 不看 `response.status`，把 401 错误信封当 state 做 safeParse → 失败 → 报"格式不合法"——把鉴权拒绝误报为格式问题。
- **影响**：升级等系统繁忙期，面板节点详情页运行快照可能持续显示"格式不合法"（每次调用都走同一条链），且报错误导排障方向；系统空闲后自愈。
- **建议修法（下一批）**：三处任选/组合——① `/state` 路由放宽超时（对齐 10s 默认）；② `nodes.ts` 按 `response.status`/错误信封区分报错（401 → "Agent 鉴权失败"而非"格式不合法"）；③ `node-client` TCP 回退时对签名头重新生成 nonce（或 Agent 侧 nonce 例外）。按指令本轮不修。
- **取证残留清理**：实机 `/tmp/state.json`（sudo 创建）已删除。

### 11.5 文档与收口

- `CHANGELOG.md` 批次 M 条目（F-L1/L2/L3 + 竞态 + 升级语义说明）已登记；`docs/cf-dns.md`、`docs/security-boundaries.md`（§3 表、§3.1、§10、头部核验行）已同步；均为现行文档，`docs/README.md` 索引无需新增登记。

## 12. 批次 N：F-M1 根治 + peer 一键脚本实机验证（2026-11-03，main `5b6d47c`，Agent 无改动维持 0.1.9）

### 12.1 F-M1 修复内容（全在 Worker 侧，Agent 无改动 → 不出包）

1. **回退重签**（`apps/api/src/lib/node-client.ts`）：`attempt()` 内每次传输尝试独立调用 `signAgentRequest` 生成新 nonce/ts/sig——fetch 超时/失败后 TCP 回退不再复用已发出的签名材料（原实现同 nonce 会被 Agent NonceCache 401 `nonce_replayed` 拒绝，§11.4 根因链第 2/3 环）；幂等键跨尝试保留（写动作仍由 Agent 侧去重兜底）。边缘 403 拦截→TCP 回退同样重签。
2. **/state 超时放宽**（`apps/api/src/routes/nodes.ts`）：`timeoutMs: 3000 → 10_000`（对齐默认预算；/state 是最重 Agent 端点，系统繁忙期 3s 必踩线）。
3. **按 status 区分报错**（`nodes.ts`）：401/403 归鉴权/签名类错误——报 `Agent 鉴权失败（HTTP <status>：nonce already used）——请核对节点 token 与面板记录是否一致，稍后重试`（附 Agent 原始错误信息，可操作），不再误报"格式不合法"；其他非 200 保留格式提示但带状态码。鉴权失败不更新可达租约。
4. **测试**（node-client.test.ts + nodes.test.ts，批次 E 的"回退复用同签名头"用例按新语义反转）：fetch 超时→回退 nonce/sig 不同且幂等键保留；边缘 403→回退同样重签；401/403 报鉴权类错误（含 Agent 消息、不含"格式不合法"）；非 200 带状态码；超时预算不叠加（既有用例保留，TCP 回退只拿剩余预算）。`./scripts/verify.sh` 退出 0（agent 823 全绿）、`verify-agent-release.mjs --repo` 通过。

### 12.2 上线

- 分支 `fix/batch-n-fm1` → squash 合 main `5b6d47c` → 推送 → CI 全绿（2m29s）自动部署生产。无 Agent 改动 → 不出包、`AGENT_RELEASE_MANIFEST` 不动；线上 manifest 最新 0.1.9（sha `62966d65…`）与仓库包一致，实机 `/health {"ok":true,"version":"0.1.9"}` 已是最新——"远程升级"复验项退化为确认版本一致。

### 12.3 上线后复验（生产，真实执行）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| /state 连续轮询稳定性 | ✅ **100/100 OK** | 生产端点连续轮询 100 次：全部返回真实 state、`via:"fetch"`、零"格式不合法"、零鉴权错误（修复前系统繁忙期必现） |
| 双通道命中 | ✅ | 域端点 100 次轮询全 `via:"fetch"`；临时裸 IP 节点 `http://203.0.113.14:80`（token 轮换后）`/state` 返回 `via:"tcp"` + 真实 state（host=khc-node-1）——回退重签未破坏 TCP 通道 |
| Agent 版本 | ✅ | 实机 0.1.9 = 线上 manifest 最新 0.1.9，sha 一致 |
| 环境清理 | ✅ | 见 §12.5 |

注：生产窗口期未自然出现 fetch 超时→回退事件（100 次全 fetch 直连成功），重签逻辑由单测实证（nonce/sig 不同断言）；线上复验证明修复后链路稳定且无回归。

### 12.4 peer 一键脚本实机验证（hub=node-test-2，peer=node-test-3，真实执行）

- **准备**：x86-2 经面板配置 wireguard hub（`wg0 10.99.0.1/24`、listenPort 51820、extIface `ens3`、publicEndpoint `203.0.113.14:51820`、peer `arm1n` 10.99.0.2/32）→ apply 成功（rev 4，appliedRev 4）：`wg0` 上线、hub 公钥 `clN5npQh…`、peer 注册正确。
- **脚本执行**（arm-1，root，真实跑完）：面板 `peer_install_script` 生成 2576 字符脚本 → scp 至 arm-1 执行：apt 装 wireguard-tools ✅ → 写 `/etc/wireguard/khc0.conf`（**0600** 实证 `stat`）✅ → `wg-quick@khc0` 启用并**开机自启**（is-enabled）✅ → `wg show khc0`：peer 公钥 `aIWmyLhn…` 与 hub 注册的 arm1n 公钥一致、Endpoint 正确 ✅。
- **分流默认** ✅：`ip route` 实证 `10.99.0.0/24 dev khc0` 为唯一隧道路由（`ip route get 10.99.0.1 → khc0`、公网/本网流量仍走 enp0s6）——脚本生成的 conf `AllowedIPs = 10.99.0.0/24`，与设计一致。
- **回连验证：不能直连，如实记录** ❌（预期内，脚本设计路径）：`ping 10.99.0.1` 失败，脚本按设计退出码 1 并输出可操作提示（"请检查 hub 是否已 apply、UDP 端口是否放行、Endpoint 是否可达"）——负路径按设计工作。**根因实证**：主机 iptables 已放行 udp/51820，x86-2 `tcpdump -i ens3 udp port 51820` 在 arm-1 持续发包（keepalive 25s）窗口 **0 packets captured**——UDP 在 **Oracle Cloud 安全列表（Security List）边缘被丢弃**，SSH 无法修复，需主人在 OCI 控制台放行入站 UDP 51820 后重跑脚本即可连通（hub/peer 两侧密钥与配置已实证就绪）。arm-1 → x86-2 ICMP、TCP/80 均通，排除网络路径问题。
- **卸载** ✅（有缺口，如实记录）：适配器只有安装脚本、**无 peer 卸载脚本**——手动清理（disable --now wg-quick@khc0、rm conf、apt purge wireguard-tools）后核对：无 khc0 接口、`/etc/wireguard` 不存在、包已卸载，机器恢复测试前状态。**缺口建议**：下一批补 `peer_uninstall_script` 动作（对称卸载：停用 unit → 删 conf → 卸包），面板同卡展示。
- **hub 清理** ✅：面板 uninstall wireguard（keystore/密钥 purge，面板配置回默认 rev 5、peers 空）+ 手工移除 iptables udp/51820 放行规则 + 清 `/etc/wireguard` 空目录残留；x86-2 无 wg 接口、无残留 unit、Agent 0.1.9 在线。

### 12.5 测试环境终态

- **node-test-3**：无 wg/khc0/wireguard-tools//etc/wireguard（恢复起测前状态）；/tmp 脚本已删。
- **node-test-2**：Agent 0.1.9 在线健康、无 wg 产物、iptables 无 51820 规则（tcp/80 属生产所需保留）、`/etc/wireguard` 已删。
- **面板 D1**：临时节点 `batchn-tcp-probe` 已删；批次 M 遗留 `audit-test-node`（203.0.113.10）已不在（本轮 DELETE 时返回 not_found，终态 `GET /nodes` 仅剩 node-test-2 online）；wireguard 配置 rev 5 默认态（peers 空、未 apply）。
- **本地**：/tmp 测试产物（cookie、peer 脚本、verify 日志）本轮收尾即删；无未提交工作区改动（除既有 untracked `.trae-html-share-packages/`、`docs/archive/ui-redesign/audit-2026-11-03/`（历史走查产物，2026-11-05 归档），非本轮产物，未动）。

### 12.6 剩余未验项（不伪造）

| 项 | 原因 |
| --- | --- |
| peer 实际隧道连通（握手/ping/走隧道传输数据） | **已于批次 R 实测通过**（主人放行 OCI 安全列表 + hub 主机 iptables 补 udp/51820 放行后）：握手、ping 1.1ms、分流默认、hub 服务、运维通道、端口转发全过，见 §16 |
| 生产环境自然发生 fetch 超时→TCP 回退（重签的线上自然样本） | 100 次轮询均 fetch 直连成功，无回退事件；重签逻辑由单测覆盖 |

## 13. 批次 O：peer 一键卸载脚本 + ensure_dirs 外部目录降级（2026-11-03，main `9af4c4b`，Agent `0.1.10`）

### 13.1 能力

- `peer_uninstall_script`（agent/adapters/wireguard.py）：`KHC_WG_IFACE` 可选接口（默认 khc0）、systemctl stop/disable 幂等判断（is-active/is-enabled 先查再动）、`rm -f` 删 conf（含私钥）、`KHC_WG_PURGE_TOOLS=1` 门控卸载 wireguard-tools（apt/dnf/yum/apk 四分支，**默认保留系统包**）、清理结果清单（空则输出"已是干净状态"；PURGED_TOOLS 标志区分"已卸载/保留"）；失败路径全部带可操作提示。安装脚本同步补"安装结果（peer xxx）"汇总段（RESULT_TOOLS/CONF/UNIT/PING 追踪）。
- 面板：导出抽屉 conf/安装/卸载三页签，卸载用法文案含 PURGE_TOOLS 说明。
- `ensure_dirs` 外部目录降级（agent/khc/util.py）：`/etc/wireguard` 等由安装器（root）拥有的目录在沙箱内 makedirs EROFS 时不再硬失败 crash loop，降级 WARNING + 宿主机 `mkdir -m 0700 …` 提示；khc 自有目录仍硬失败。

### 13.2 生产事故与根治（如实记录）

- **触发**：0.1.10 热装 node-test-2 时 agent crash loop：`OSError: [Errno 30] Read-only file system: '/etc/wireguard'`。根因：批次 N 清理时 `rmdir /etc/wireguard`，旧 unit（0.1.4 时代，`-` 前缀可选条目）不建目录，沙箱内 /etc 只读 makedirs 必崩。
- **止血**：宿主 `sudo mkdir -m 0700 /etc/wireguard`，服务立即恢复。
- **根治复验**（随 0.1.10）：删目录重启 agent → 正常启动 + WARNING 提示；khc 自有目录缺失仍硬失败（单测 mock EROFS 断言）。

### 13.3 实机验证（node-test-3，root，真实执行）

| 步骤 | 结果 |
| --- | --- |
| 一键安装脚本 | ✅ 装工具/写 conf 0600/自启/密钥匹配全过；回连 ping 因 Oracle SL 丢 UDP 51820 按设计失败（exit 1 + 可操作提示，与批次 N 结论一致） |
| 一键卸载脚本（默认） | ✅ stop/disable unit、删 conf（含私钥）实证清零；清单 3 项"已清理" + "保留：wireguard-tools"；无 khc0 接口 |
| 幂等重跑 | ✅ 全部跳过 + "已是干净状态，无需清理"，退出码 0 |
| `KHC_WG_PURGE_TOOLS=1` | ✅ wireguard-tools 卸载，清单显示"已卸载：wireguard-tools" |
| 对其他服务影响 | ✅ arm-1 上无 wg 残留、其余服务正常 |

### 13.4 发布与上线

- 0.1.10 出包 + 既有私钥签清单（sha256 `41b1e736…`），包入 `apps/web/public/agent/`，`AGENT_RELEASE_MANIFEST` secret 更新；`GET /api/v1/agent/releases` 线上 sha == 仓库包；`./scripts/verify.sh` 退出 0（831 agent 单测）。
- main `9af4c4b` squash 合入推送，CI 三 job 绿（Typecheck/Test/Build、Agent tests、Deploy）。
- 线上复验：面板生成卸载命令内容核对全项命中（接口变量/幂等分支/PURGE 门控/清单段）；x86-2 Agent 0.1.10 在线，wireguard 面板配置与节点一致（arm1o）。

## 14. 批次 P：浏览器走查缺陷修复（2026-11-03，main `3ffb605` + `1ca53b3`，纯 Worker/UI 无出包）

缺陷来源：`docs/archive/ui-redesign/audit-2026-11-03/clicks-audit.md`（历史资料；修复状态表见其 §0.1）。

### 14.1 B-1（阻断）：暂存 Peer 导出报「peer 不存在」

- **修法**：暂存态（rev ≠ appliedRev）导出不走 Agent（D1 无私钥、Agent 未下发，硬调必报错）——抽屉显示「该 Peer 尚未下发到节点」+ 引导文案 + 「去应用配置」按钮（复用页头 apply 动作；控制通道不可用禁用并说明原因）；Agent 侧 `peer 不存在/尚未 apply` 兜底转译为同款引导，原始文案不允许直出。
- **补漏（`1ca53b3`）**：首次部署后线上页面走查发现，保存后自动打开的抽屉命中的是兜底转译而非暂存分支——`openExport` 闭包里的 `unapplied` 是保存前渲染的旧值（rev==appliedRev），暂存被误判为已应用仍去调 Agent。修法：改读 queryClient 最新 rev/appliedRev；mockApi 改有状态（PUT 后 GET 返回最新），补「保存新 Peer 后自动打开导出」回归测试。
- **测试**：暂存态（行菜单导出：引导 + 不调 Agent + 无「peer 不存在」）、已应用态（调 Agent 拿到 .conf）、保存后自动弹出（审计原始场景）三条 smoke 路径全绿。
- **线上复验（页面）**：node-test-2 创建 test-peer-02 仅保存 → 自动弹出的导出抽屉显示「该 Peer 尚未下发到节点」+「去应用配置」按钮，未出现「peer 不存在」——PASS。

### 14.2 P0-1：安装命令 Caddy/自签证书选项

- 契约 `agentInstallOptionsSchema`（withCaddy/tls/tlsCn；CN 白名单 `^[A-Za-z0-9.*-]+$`、≤253）；Worker `buildAgentInstallCommand` 追加 `--with-caddy/--tls/--tls-cn`（与 `agent/install.sh` 参数对齐）；节点令牌抽屉与节点设置安装命令抽屉镜像勾选、命令实时重生成、**默认全不勾**、附端口/域名约束提示；升级命令忽略 installOptions。
- 测试：路由级（带选项命令含 flags + bash 语法、默认不带、非法 CN 400 validation_failed 含字段提示、upgrade 忽略）。
- **线上复验（API 三态）**：`installOptions:{withCaddy,tls,tlsCn:"agent.example.com"}` → 命令含 `--with-caddy --tls --tls-cn agent.example.com`；不带 → 无任何 flags；`tlsCn:"a b"` → 400 `validation_failed`——全对。

### 14.3 P1

- P1-1（侧栏直达）：核验 AppShell `?create=1` 已实现（走查后、批次 P 前落地），不再改。
- P1-3（删除节点 L3 占位）：补「输入节点名 {name} 以确认」（与远程升级同款）；删除/升级等待期忙碌态核验：ConfirmDialog 既有 pending 机制在确认后禁用按钮 + loading，防重复点击已覆盖。
- P1-2（保存后中间态）未列入本批范围，审计报告标记备查。

### 14.4 测试与上线

- `./scripts/verify.sh` 退出 0（typecheck + vitest 全量 + build + compileall + agent 831 单测 + release 一致性 + shell 语法）。
- main `3ffb605`（主体）+ `1ca53b3`（B-1 补漏）推送；两次 CI 三 job 全绿（Typecheck/Test/Build、Agent tests、Deploy production Worker）。

### 14.5 环境清理与终态

- 测试 Peer test-peer-01/02（均为暂存态、从未下发）已删：按「取消本机清理」等价路径 API 执行（PUT 配置去掉测试 peer + apply），与面板删除取消勾选清理同一语义（未接入 host-ops 的 peer 勾选清理会被 `E_NOT_ONBOARDED` 阻止——既有防御行为，与审计报告走查清单第 7 项描述一致）。
- 终态核对：wireguard rev 9 == appliedRev 9、peers=[arm1o]、节点侧 wg0 running/peers=[arm1o]、Agent 0.1.10 在线、`GET /nodes` 仅 node-test-2——面板与节点一致，无测试残留。
- /tmp 产物（cookie、wg-clean/wg-put JSON）收尾即删。

### 14.6 剩余未验项（不伪造）

| 项 | 原因 |
| --- | --- |
| 安装命令 Caddy/自签勾选的页面交互（浏览器点击勾选） | 复验走 API 三态（命令内容正确性）；页面勾选交互与节点设置抽屉同款实现，未逐像素走查 |
| P1-2 保存后中间态、P2-1/P2-2/P2-4 | 未列入批次 P 范围，待主人决定 |

## 15. 批次 Q：删除流程清理默认值修复 + 最终一致性核对（2026-11-03，main `568e69b`，纯 UI 无出包）

### 15.1 修复：删除 Peer/节点按 host-ops 接入状态决定清理默认值

- 背景：走查与批次 P 页面复验发现，删除未接入 host-ops 的 Peer 时「同时清理该 Peer 本机服务」**默认勾选** → cleanup 必报 `E_NOT_ONBOARDED`，对话框留错、用户需手动取消勾选重试。
- 修法（`apps/web/src/apps/wireguard/page.tsx`）：用 `hostOpsConfigQueryOptions` 预判接入状态——未 onboard 的 Peer 该项**默认不勾且禁用**，提示「该 Peer 未接入运维通道，无法远程清理；直接删除面板记录即可」；已 onboard 的 Peer 保持默认勾选；取消勾选仅删记录的行为不变。
- 删除节点同款检查（`apps/web/src/apps/node-settings/page.tsx`）：节点清理 target 为 `'self'`，失败模式是 `E_SCRIPT_MISSING`（脚本未装，**不是** `E_NOT_ONBOARDED`），且无 D1 配置可预判脚本是否安装——改用 `adapters` 是否含 `host-ops` 前置判断：未装时默认不勾且禁用 + 提示；适配器在但脚本缺的极端情形仍会报错（文案明确、可取消勾选），属防御行为，如实记录。
- 测试：wireguard smoke 12 个全绿（新增「删除未接入 host-ops 的 Peer：清理项默认不勾且禁用，确认后不调 cleanup」1 例；既有 2 个删除用例补 `hostOpsPeers` mock 接入态；mock host-ops 配置端点按 `appConfigResponseSchema` 包 `{app: …}`）；hubSettings smoke 11 个全绿（新增「host-ops 未安装时清理项默认不勾且禁用，确认后不调 cleanup」1 例，mock adapters 可开关）。

### 15.2 上线

- `./scripts/verify.sh` 退出 0（typecheck + vitest 全量 + build + compileall + agent 831 单测 + release 一致性 + shell 语法）。
- main `568e69b` 推送；CI 三 job 全绿（Typecheck/Test/Build、Agent tests、Deploy production Worker）。

### 15.3 最终一致性核对（只核对不新增功能，2026-11-03）

| # | 核对项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 线上首页可访问 | ✅ 通过 | `GET https://panel.example.com/` HTTP 200；`/api/v1/health` `{"ok":true,"service":"khc-server","version":"0.2.0","env":"production"}` |
| 2 | 登录 OK | ✅ 通过 | 全新 `POST /api/v1/auth/login` 200（会话至次日）；浏览器实测登录后面板正常加载（右上角 admin） |
| 3 | Agent 版本清单与仓库包一致 | ✅ 通过 | 线上 `GET /api/v1/agent/releases`：0.1.10 sha256 `41b1e7364ccf…076d2` == 本地 `agent/dist/khc-agent-0.1.10.tar.gz` 同值（与 verify.sh release 一致性检查同源） |
| 4 | D1 节点列表与面板一致 | ✅ 通过（清理后） | `GET /nodes` 仅 node-test-2；浏览器 /hubs 页仅显示 node-test-2（在线）。核对中发现走查残留节点 `ui-test-node`（endpoint 127.0.0.1、从未上线、今日上午创建）并已删除 |
| 5 | docs 现行索引与实际文件一致 | ✅ 通过（补登记后） | 非归档 47 个 md 与索引逐一对上；当时唯一缺口 `docs/ui-redesign/audit-icons.md`（2026-11-02 一次性走查产物、状态「历史记录」）未登记——本批补入 `docs/README.md` 工程流程表；该文件 2026-11-05 已归档至 `docs/archive/ui-redesign/audit-icons.md` |
| 6 | CHANGELOG 与最近提交一致 | ✅ 通过（本批补记后） | CHANGELOG 此前记至批次 P；本批补批次 Q（`568e69b`）条目后，最近 8 个提交（Q/P/O/N/M 及配套 docs 提交）全部有对应记录 |

### 15.4 未验项（如实记录）

| 项 | 原因 |
| --- | --- |
| 未接入 host-ops 场景的删除页面线上实测 | 生产当前仅 arm1o 一个 Peer（已接入 host-ops），无未接入 Peer 可测；行为由 smoke 测试覆盖（默认不勾/禁用/不调 cleanup/删除成功四断言） |

## 16. 批次 R：peer 隧道补验（2026-11-03，纯验证无代码改动）

> 背景：主人在两台 Oracle 机器的 OCI 安全列表放行端口（策略一致），补验 §12.6 遗留的 peer 隧道场景。
> 环境：hub = node-test-2（Agent 0.1.10 在线，wireguard rev 9 已 apply，peer `arm1o` 10.99.0.2/32，`wg0` 监听 51820）；peer = node-test-3（203.0.113.11）。全程真实执行，面板走 `https://panel.example.com`。

### 16.1 入站 UDP 51820 实测（不只看安全列表配置）

- hub `wg show`：`wg0` 上线、listening port 51820、peer `arm1o`（AllowedIPs 10.99.0.2/32）注册正确。
- hub `tcpdump -ni ens3 udp port 51820` + arm-1 实发 5 个 UDP 包：**抓到 3 packets**（203.0.113.11 → hub:51820）——OCI 边缘已放行 ✅（对比批次 N 同法 0 packets）。
- **环境级发现（非代码缺陷）**：包到达 hub 网卡但 `wg show` rx=0、握手为 0——**hub 主机 iptables INPUT 链尾 `REJECT all` 拦掉了 udp/51820**（批次 N 清理时移除了当时手动加的放行规则，wg apply 链路本身不管主机 iptables）。按批次 N 同款做法临时 `iptables -I INPUT -p udp --dport 51820 -j ACCEPT` 后握手即通（验证结束已移除该规则）。

### 16.2 peer 全链路实测（arm-1 重跑面板生成的一键安装脚本）

安装脚本首轮（未放行主机 iptables 前）：工具安装/conf 0600/自启全过，回连 ping 按设计 exit 1 报可操作提示；补规则后**重跑（幂等）EXIT=0，回连验证通过**。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| `ping 10.99.0.1` | ✅ | 5/5，rtt min/avg/max = 0.918/**1.128**/1.762 ms |
| 分流默认 | ✅ | `ip route` 仅 `10.99.0.0/24 dev khc0`；`ip route get 8.8.8.8` 仍走 enp0s6 原网关（默认路由未劫持） |
| hub 侧握手 | ✅ | arm-1 `wg show khc0`：latest handshake 16s、双向 transfer ~1.1 KiB |
| peer 访问 hub 侧服务 | ✅ | `curl http://10.99.0.1/health`（经 WG）200 `{"ok":true,"version":"0.1.10"}`，2.9 ms |
| 经 WG 的 peer 运维通道（host-ops） | ✅ | probe（hub ssh-keyscan `10.99.0.2:22` 取指纹）→ onboard（126 KB 内联脚本，hubWgIp 自动取自已 apply 的 WireGuard 配置 = 10.99.0.1，khc-host 1.4.1）→ arm-1 执行 EXIT=0 → 配置回填 hostKey 后 apply rev 2 |
| 只读运维动作经 WG | ✅ | `host-ops/call {target: arm1o, verb: status}`（CPU/mem/盘/网络/监听清单）与 `verb: processes`（50 进程，可见 arm-1 上 khc-host 自身）均 ok |
| 端口转发经 WG | ✅ | port-forward `r-test` tcp/18322 → `10.99.0.2:22`；arm-1 经 `10.99.0.1:18322`（WG 隧道 → hub socat → 反向再经 WG）取到 SSH banner `OpenSSH_9.6p1`，3 次连接 ~15 ms |

- 端口转发备注：hub 新 listenPort（18322）同样被 iptables 尾部 REJECT 拦，临时放行后通——与 §16.1 同一环境事实：**生产用端口转发/WG 入站需 fw.apply 放行或手工加主机规则**（本批只记录不修）。

### 16.3 卸载与恢复（验证后执行一键卸载）

- **arm-1 host-ops**：onboard 响应自带的 `uninstallCommand` 执行 → khc-host/config/sudoers/authorized_keys（khc-hub 行）清零核对。
- **arm-1 WireGuard**：面板 `peer_uninstall_script` + `KHC_WG_PURGE_TOOLS=1` → 停 khc0/取消自启/删 conf（含私钥）/卸载 wireguard-tools，EXIT=0；核对无 khc0 网卡、`/etc/wireguard` 不存在、unit not-found、包已卸载。
- **hub 面板侧**：port-forward uninstall（清 `khc-forward-r-test.service`，1 unit）、host-ops uninstall（清 4 个本地文件）；wireguard 删 peer `arm1o` → apply rev 10 == appliedRev 10，内核 `wg show wg0 peers` 计数 0（记录与内核同步清理 ✅）；host-ops/port-forward 配置重置为空并 apply（移除 D1 内 hostKey 与测试转发记录）。
- **hub 主机侧**：临时 iptables 规则（udp/51820、tcp/18322）已删；socat 已 `apt-get purge`（本批为验证临时安装）；核对无 khc-forward unit、host-ops 数据目录空、无 khc nft 表、Agent 0.1.10 全程在线。

### 16.4 发现项（只记录，未改代码/文档）

| 项 | 说明 |
| --- | --- |
| hub 主机 iptables 对新端口默认 REJECT | wg apply 与 port-forward apply 都不写主机 iptables（fw.apply 才管）；批次 N 移除手工规则后本轮即踩中。建议后续在 `docs/runbook/node-onboarding.md` 明示「起用 WG/端口转发需 fw.apply 放行 listenPort」，留主人决定 |
| host-ops onboard 把 peer 用户 shell 改为 `/bin/sh` | 安装命令内 `usermod -s /bin/sh`，uninstallCommand 不恢复；arm-1 已手工 `usermod -s /bin/bash ubuntu` 还原。属适配器行为取舍，仅记录 |

### 16.5 终态

- **node-test-3**：无 khc0/conf/unit/wireguard-tools/khc-host 痕迹，ubuntu shell 恢复 `/bin/bash`，/tmp 脚本已删——与起测前一致。
- **node-test-2**：wg0 保留运行（hub 生产态，批次 P 遗留配置）但 peers 空、rev 10 已 apply；无 khc-forward/host-ops 产物；iptables 无临时规则；socat 已卸载；Agent 0.1.10 在线健康。
- **面板 D1**：节点列表仅 node-test-2（在线）；wireguard peers=[]；host-ops/port-forward 配置空且已 apply（appliedRev 同步）。
- **本地**：/tmp 测试产物（cookie、脚本、onboard/uninstall 命令）收尾即删。

## 17. 批次 S：主机 iptables 自动放行（方案 B）+ onboard shell 善后（2026-11-03，Agent `0.1.11` / khc-host `1.5.0`）

> 目标：修掉批次 R 记录的两个真实缺陷（§16.4）——"明明配好了却不通"（iptables 尾链 REJECT 拦 WG/转发监听端口）与"留下脏状态"（onboard 改 peer 用户 shell 不恢复）。

### 17.1 方案拍板与 A 否决实证

- 主人拍板**方案 B**（主机 iptables 打标记自动放行）；条件触发（仅 INPUT 存在 REJECT/DROP 规则或 policy DROP 时才插）、幂等、只删带自身注释的规则、只增 ACCEPT。
- **方案 A（khc_fw 受管规则）实测否决**（x86-2 临时实验，环境已还原）：iptables-nft 下 `khc_fw`（priority `filter - 5` 早链）的 accept 命中后**不是最终裁决**——包继续走 iptables INPUT 链仍被尾部 `REJECT` 拒掉（arm-1 实发 20 个 UDP：早链规则计数 +20 的同时 REJECT 计数也 +20）。结论：khc_fw-only 方案无效，必须直接插 INPUT 链。

### 17.2 实现（方案 B）

- **内核新模块 `agent/khc/hostfw.py`**（编排层、零应用名）：`iptables -I INPUT 1 -p <proto> --dport <port> -m comment --comment "khc-auto:<app>" -j ACCEPT`；`sync_releases`（apply 管道入口，收敛到目标集合）、`remove_release`（按注释精确删、幂等）、`show_auto_rules`（只读上报）。iptables 不可用 → degraded 上报，**不阻断 apply**。
- **opt-in**：`port_claims` 声明带 `release: true` 才参与（wireguard `udp/listenPort`、port-forward 各转发 `listenPort`）；**caddy 不开标志**。当前与历史声明均为空的应用零 iptables 开销。
- **内核管道**（`kernel.py`）：apply（含无变更路径）成功后同步；plan 增加"将自动放行…"预览 warning；rollback 按回滚目标配置收敛；uninstall/`_cleanup_app` 收回全部 `khc-auto:<app>` 规则；apply 响应新增 `hostFw` 报告（messages 进 warnings 回显"已自动放行 …"）。
- **安全边界**（`docs/security-boundaries.md` §6.1）：结构上不可能产生 DROP/REJECT；只删 `khc-auto:<app>` 注释规则，不碰用户手工规则；锁定保护不被绕过。
- **fw.show**：`khc_host.py` 新增 `autoRules`（解析 `iptables -S INPUT` 过滤 khc-auto 注释，标注"非用户策略"）；面板防火墙卡片新增「系统自动放行（主机 iptables）」区块（Badge：`proto/port · 来源应用`）。apply 回显：WireGuard/转发保存后 toast hostFw 消息。

### 17.3 实现（缺陷 2：shell 记录与恢复，khc-host `1.4.1` → `1.5.0`）

- **onboard**：改 shell 前记录原值到 `/etc/khc-host/original-shell`（`user:shell`；既有用户记 getent 原值、已存在记录不覆盖=幂等；新建用户写 `user:__created__`）。
- **卸载分支**：有真实 shell 记录 = 既有用户 → `usermod -s <原值>` 恢复且**不再 userdel**；`__created__` = onboard 新建 → 保持 `userdel -r`；无记录（旧版本 onboard）→ 缺省安全：不动 shell 也不删用户。记录文件随卸载清理。
- **可见状态**：khc-host `status` 新增 `onboard` 块（originalShell/currentShell/shellModified/createdUser），面板 peer 运维抽屉显示「已临时修改 {user} 的登录 shell…卸载时自动恢复」Banner。

### 17.4 对 §16.4 的勘误

- §16.4 首行「wg apply 与 port-forward apply 都不写主机 iptables（**fw.apply 才管**）」表述有误：`fw.apply` 管理的是 nft `khc_fw` 表，**同样管不了 OCI 式 iptables INPUT 尾链 REJECT**（§17.1 实证）。正确表述：0.1.11 前的 wg/port-forward apply 与 fw.apply 都打不开这类端口，需手工放行；0.1.11 起 apply 管道自动放行（§17.2）。

### 17.5 测试与上线

- 单测：新增 `tests/test_hostfw.py` 16 例（插入/条件触发/幂等/收回/只删自身/锁定保护结构性断言/降级/内核管道 apply-plan-rollback-uninstall-禁用收缩）；`test_host_ops.py` 新增 9 例（fw.show autoRules 2 例、status onboard 块 5 例、install/uninstall 命令 shell 记录与分支 2 例，均过 `bash -n` 语法检查）；claims 断言 5 处更新。agent 单测 **856** 全绿，vitest **393** 全绿，`./scripts/verify.sh` 退出 0。
- 出包：Agent `0.1.11`（sha256 `1d3750b3372c…`），既有私钥签发 manifest；包入 `apps/web/public/agent/`。
- 上线：squash 合 main（`36b03f5`）→ 推送 → CI 三 job（Agent tests / Deploy production / Web checks）全绿 → `AGENT_RELEASE_MANIFEST` secret 更新 → 线上 `/api/v1/agent/releases` 返回 0.1.11，线上下载包 sha256 与仓库包**逐字节一致**。hub Agent 经面板远程升级 0.1.10 → 0.1.11（systemd 重启不中断 SSH）。

### 17.6 实机零手工复验（node-test-2 + arm-1，2026-11-03，全过）

> 核心验收点：**全程不手工补任何 iptables 规则**（与批次 R 对照：同链路上批需手工补 udp/51820、tcp/18322 才通）。

| 验收项 | 结果 | 证据 |
|---|---|---|
| hub 自动放行（零手工） | ✅ | wg apply（peer `arm1s`）后 INPUT 链首自动出现 `-A INPUT -p udp --dport 51820 -m comment --comment "khc-auto:wireguard" -j ACCEPT`；apply 回显「已自动放行 UDP/51820…」+ hostFw 报告 |
| peer 一键安装一次通过 | ✅ | 面板生成脚本 → arm-1 `sudo bash` 执行 EXIT=0，末行「回连验证通过：10.99.0.1 可达，peer 已上线」（批次 R 同步骤 exit 1 需手工补规则后重跑） |
| 隧道连通与延迟 | ✅ | `ping 10.99.0.1` 5/5，avg **0.858 ms**（批次 R 1.128 ms）；分流默认：default 走 enp0s6，仅 10.99.0.0/24 走 khc0 |
| peer 运维通道（经 WG） | ✅ | probe ssh-keyscan 经 10.99.0.2 取 3 指纹（ed25519 `dw4UWe…+lApg` 与批次 R 一致）；onboard khc-host 1.5.0 EXIT=0；call status 返回 onboard 块 `shellModified=true`（originalShell `/bin/bash`，currentShell `/bin/sh`）——「已临时修改 shell」可见状态生效 |
| 端口转发（自动放行 + 经 WG） | ✅ | 转发 `r-s` tcp/18322 → 10.99.0.2:22 apply 自动放行 tcp/18322；arm-1 经 `10.99.0.1:18322` 取 SSH banner `OpenSSH_9.6p1` 3/3（13–16 ms）。公网直连 18322 超时为 OCI 安全列表未放行该端口，与批次 R 同现象、与本缺陷无关 |
| 规则来源可见 | ✅ | `fw.show` autoRules 上报 2 条（wireguard udp/51820、port-forward tcp/18322），note「khc-agent 为 … 自动放行（非用户策略）」 |
| host-ops 卸载（缺陷 2） | ✅ | hub uninstall task done + peer uninstallCommand 执行 EXIT=0：**ubuntu shell 恢复 `/bin/bash`**（原值记录 `ubuntu:/bin/bash`）、**既有 ubuntu 用户未被删**（新分支不 userdel）、/etc/khc-host 整目录清理（original-shell 一并）、authorized_keys marker 清零、khc_fw nft 表删除 |
| port-forward 卸载收回 | ✅ | uninstall + 空配置 apply 后 tcp/18322 khc-auto 规则消失 |
| wireguard 禁用收回 | ✅ | `enabled=false` apply → 回显「已收回主机 iptables 自动放行 udp/51820」→ `iptables -S INPUT | grep khc-auto` **无输出**（无残留）、wg0 停；重新启用 apply → 自动重插（幂等路径双向验证） |
| peer 恢复原状 | ✅ | peer 卸载脚本 EXIT=0：khc0 移除、khc0.conf 删除（含私钥）、wireguard-tools 保留（默认）；ubuntu `/bin/bash`、无 khc-host 痕迹 |
| Agent / SSH 全程 | ✅ | 两机 SSH 全程可达；hub khc-agent 升级后持续 active，面板 state 直连 fetch reachable=true，节点 online（lastSeen 2s） |

**终态**：hub 恢复批次 R 终态（wg0 运行、peers=[]、host-ops/port-forward 配置空且 appliedRev 同步）+ 1 条 `khc-auto:wireguard udp/51820`（系统自动、fw.show 可查来源——wg 启用即放行是 0.1.11 设计行为）；hub socat 保留安装（apt 包依赖，非防火墙规则）；arm-1 干净。

## 18. 架构整改批次 2：上线与实机复验（2026-11-03，main `2945132`，Agent `0.1.12`）

> 范围：arch-review-remediation-2026-11-03 剩余无 🔒 T4 任务（A-1/A-4/A-5/A-7/A-8/A-9/A-11/A-12、B-1…B-4、S-3 残留），每任务独立 commit 后 squash 合 main。带 🔒 项（T4.6 等）待 D-1…D-6 拍板，未动。

### 18.1 上线链路

| 项 | 结果 | 证据 |
|---|---|---|
| verify.sh 全绿 | ✅ | agent 单测 879 例 OK + vitest 全量 + build + compileall + 发布一致性 + shell 语法 |
| CI 三 job | ✅ | Agent tests / Typecheck-Test-Build / Deploy production Worker 全绿（run 41597781963） |
| 线上 sha == 仓库包 | ✅ | `curl https://panel.example.com/agent/khc-agent-0.1.12.tar.gz` sha256 `9f8c3a7c38f3…de614` == 仓库 `.sha256` |
| manifest 更新 | ✅ | `wrangler secret put AGENT_RELEASE_MANIFEST`（既有私钥签 0.1.12 清单）；`GET /api/v1/agent/releases` 显示 0.1.12 |
| A-5 实链（包内公钥自验） | ✅ | 出包后本地用 `khc.release_verify` 实测：0.1.12 清单通过、篡改 sha/未知 url 均 fail-closed 拒绝 |

### 18.2 node-test-2 实机复验（面板 → Worker → Agent 真实链路）

| 验收项 | 结果 | 证据 |
|---|---|---|
| 远程升级 0.1.11 → 0.1.12 | ✅ | 面板 `POST /nodes/nd_xxxxxxxxxxxxxxxx/agent/upgrade` → 202 `{accepted, fromVersion:"0.1.11"}`；30s 后 `/opt/khc-agent/khc_agent.py version` = **0.1.12**、khc-agent active、journal `khc-agent 0.1.12 starting (profile=system)` |
| 升级后 /state 正常 | ✅ | 面板 state：agent 0.1.12、reachable=true、via=fetch、6 适配器加载 |
| A-9 任务落盘（端到端） | ✅ | `reinstall=true` 同版本重装 → taskId `6d4c64c1…` → Agent 自重启后 `/var/lib/khc-agent/tasks/6d4c64c1….json`（0600）实存；面板 `GET /nodes/:id/tasks/:taskId` **重启后仍可查**（state=done、logs 6 行完整）——补上了批次 L 记录的"升级 taskId 重启即失"缺口 |
| A-4 unit 渲染（设计确认） | ➖ | remote upgrade 仅 patch ReadWritePaths 行（`_refresh_unit_sandbox`），**不**重渲染 unit——`KHC_LIVE_ORIGINS/KHC_NODE_ID` 在下次 install.sh/upgrade-command 时渲染（T4.4 已有渲染测试覆盖）；本机 liveEndpoint=null 无功能影响 |

### 18.3 UI 截图自检（A-12 文案，浅/深/390）

- 截图：`docs/verification/2026-11-03/shots/batch2-backup-{light,dark,390}.png`（生产面板 node-test-2 节点设置页备份分区）。
- **390 自检发现并修复（main `a869c27`）**：`ui-banner-desc` 原 `nowrap+ellipsis` 单行截断，A-12 加长后的文案在 390px 被截断——改描述行自然换行（标题保留省略号策略），smoke 26 例复跑通过，CI 三 job 绿后线上复截确认完整 4 行、无溢出。另：同 push 的 Agent tests job 首跑因 `test_node_exporter` tearDown 的 rmtree 抖动失败（本 push 未动 agent，与改动无关），`gh run rerun --failed` 后三 job 全绿。

### 18.4 遗留/待拍板

- 带 🔒 任务（T4.6 等）与 D-1…D-6 待主人拍板，见计划文档。
- A-7 顺带项"unit 目录收窄到 khc-* 前缀"评估后不做（ReadWritePaths 无前缀过滤、unit 必须位于标准 unit 目录），记计划文档 §4.5。
- 本批新发现并已修：bash locale 隐患（install.sh/uninstall.sh 随 T4.4、install-preflight-test.sh 随 T4.14）；test_tasks 读盘句柄未关（ResourceWarning）。

## 19. 架构整改批次 3：rev epoch 上线与实机复验（2026-11-03，main `57cd3a3`，Agent `0.1.13`）

> 范围：D-2/T2.2 rev epoch（迁移 0007 + contracts + Worker + Agent 内核，PR #60 描述含红线 2 必要性）+ D-3/D-5 文档口径 + 决策记录（计划文档 §5.1）。旧 Agent 兼容三态单测 + 实机对照实验。

### 19.1 上线链路

| 项 | 结果 | 证据 |
|---|---|---|
| verify.sh 全绿 | ✅ | agent 单测 886 例 OK（新增 test_epoch.py 7 例）+ vitest 全量（新增迁移幂等/存量回填、repo 契约、载荷、/state 三态）+ build + compileall + 发布一致性 |
| CI 三 job | ✅ | run 41606949946：Typecheck/Test/Build + Agent tests + Deploy production 全绿 |
| D1 迁移 0007（remote） | ✅ | 迁移前 `wrangler d1 export` 备份（存 `.khc-local/backup-20261103-pre0007-d1.sql`）；`d1 execute --file=0007_rev_epoch.sql` 后 `PRAGMA table_info(nodes)` 含 `rev_epoch TEXT NOT NULL`，存量节点 node-test-2 回填 `f837339c…` |
| 线上 sha == 仓库包 | ✅ | `curl …/agent/khc-agent-0.1.13.tar.gz` sha256 `eb76a50adeb3…a8c6f` == 仓库 `.sha256` |
| manifest 更新 | ✅ | `wrangler secret put AGENT_RELEASE_MANIFEST`（既有私钥签 0.1.13 清单） |

### 19.2 node-test-2 实机验证（面板 → Worker → Agent 真实链路）

| 验收项 | 结果 | 证据 |
|---|---|---|
| **态三（旧 Agent，升级前）** | ✅ | 0.1.12 下 `/state`：epoch 缺省、epochStale 缺省——Worker 按"待升级"处理不判定，节点照常工作 |
| 远程升级 0.1.12 → 0.1.13 | ✅ | 面板 upgrade → taskId `ceba0850…` state=done；/state agent.version=0.1.13；**appliedRev=15 保留、epoch 缺省——在线升级不清基线，零感知** |
| **清空 Agent 状态重装** | ✅ | 节点清空 `state.json/ports.json/idempotency.json/tasks` 后重启：/state 全部 appliedRev=None（fresh 形态）；面板 apply wireguard → 200 rev=15、changes=0、**epoch 采纳 `f837339c…`**——恢复全自动，无需人工介入 |
| **R-2 对照实验（关键）** | ✅ | ① 纪元一致 + 伪造 appliedRev=999：apply rev=15 → **409 conflict**（rev 防回退保护未放松，旧机制如实保留）；② D1 换新纪元 `0d16ba9e…`（模拟节点重建/恢复）：/state **epochStale=true** 判定旧纪元 → 同一 apply → **200**、appliedRev 重接 15、epoch 更新——**rev 分叉永久 409 的根因消除** |
| 重置语义 | ✅ | 新纪元 apply 时全部应用基线被清（port-forward/host-ops appliedRev=None）→ 面板重新下发各自接回（4/7）；wireguard 配置快照保留，changes=0 快速成功 |
| 终态 peer 与 rev | ✅ | wireguard installed/enabled/running、problems=[]；重装前后 appliedRev=15、peers=0 一致；agent.epoch=`0d16ba9e…` == D1 节点纪元，epochStale 消失 |

### 19.3 遗留/待办

- D-1（面板 TOTP）暂缓——见计划文档 §5.1；D-6（删 `wrangler.staging.toml`）已于 2026-11-03 完成（见 §20）。
- D-5 收窄（`keys.add`/`cron.set` 限 `target=self` 或 Peer 本地 opt-in）列为待办，未实现。
- 实机节点纪元现为 `0d16ba9e…`（验证过程换新值，Agent 已一致采纳，属正常纪元值，无需处理）。

## 20. D-6：删除 `wrangler.staging.toml` 与版本预览实测（2026-11-03）

> 范围：主人确认后执行 D-6——删除脚枪配置；上线前冒烟改为 `npx wrangler versions upload` + 预览 URL。**未执行 `wrangler deploy`**（生产部署由主人/CI 执行）。

### 20.1 实测步骤与结果（wrangler 4.152.0，不带 `--env`）

| 步骤 | 命令 | 结果 |
|---|---|---|
| 1 | `npx wrangler versions upload` | ✅ 成功；上传 Worker Version，输出 Version ID `fd8f2f58…` 与 **Version Preview URL** `https://fd8f2f58-<worker-name>.<account>.workers.dev` |
| 2 | `GET <预览URL>/api/v1/health` | ✅ 200 `{"ok":true,"service":"khc-server","version":"0.2.0","env":"production",…}` |
| 3 | `GET <预览URL>/` | ✅ 200 `text/html`；安全头齐全（`strict-transport-security: max-age=31536000; includeSubDomains`、`content-security-policy: frame-ancestors 'none'`、`x-content-type-options: nosniff`） |
| 4 | `GET <预览URL>/api/v1/nodes`（不带 cookie） | ✅ 401 |
| 5 | `POST <预览URL>/api/v1/auth/login`（正确口令）→ 带 cookie `GET /api/v1/nodes` | ✅ 200 / 200 |
| 6 | `GET <预览URL>/health` | ⚠️ 200 `text/html`——`/health` 是 SPA 兜底页，**不是 API 探活端点**；探活须用 `/api/v1/health`（已写入 release.md §4） |
| 7 | 生产流量 | 未变化：`GET https://panel.example.com/api/v1/health` 仍返回原活动版本，`wrangler deployments status` 的活动 Version 未变 |

**预览 URL 需不需要在面板开什么？——不需要。** 预览 URL 走 Worker 的 `workers.dev` 子域路由（`wrangler.toml` 已 `workers_dev = true`），上传即得。若将来在面板关闭 workers.dev（Workers & Pages → 该 Worker → Settings → Domains & Routes 移除 `workers.dev` 路由），预览 URL 会不可用——届时需保留 workers.dev 或改用 wrangler 输出的其它入口。免费额度不受影响：版本预览不新建 Worker/独立计费单元，预览 URL 仅在有人访问时按该 Worker 请求计数。

### 20.2 附带发现（如实记录，未在本批修复）

- **线上活动版本的 `ENVIRONMENT` 实为 `staging`**：生产 `/api/v1/health` 返回 `"env":"staging"`，而上表的版本预览（读 `wrangler.toml`）返回 `"env":"production"`。说明该脚枪此前确实生效过（有版本是用 `wrangler.staging.toml` 部署的，并成为活动版本）。
- 影响：`apps/api/src/lib/agent-releases.ts` 中"生产必须配置 manifest"的硬门禁以 `ENVIRONMENT === 'production'` 判断，当前在线上处于**关闭**状态（manifest secret 仍在，故签名校验本身未失效，只是缺失时不会 fail-closed）。
- 处置：删除脚枪后，下一次生产部署（CI `wrangler deploy`，读 `wrangler.toml`）会把 `ENVIRONMENT` 写回 `production`。**已复核（2026-11-03）**：合并 PR #61 后 CI run `41620299611` 三 job 绿并完成部署，`GET https://panel.example.com/api/v1/health` 返回 `"env":"production"`，首页 200——翻车状态已修复。

## 21. 批次 4：CF DNS 多凭据 + 节点域名/证书状态 + 进程过滤（2026-11-03，main `e5772c2`，Agent 0.1.13）

> 范围：需求 1（Cloudflare DNS 与"添加 VM"打通：多凭据 + 按 Zone 代建 A 记录 + 安装命令自动带 Caddy/TLS + 节点证书状态）与需求 2（主机进程默认只看业务进程，Web 层过滤，不动协议/Agent）。草稿审计先于继续开发完成；本轮补齐进程分段（`OpsSegments.tsx`）此前只在进程抽屉生效的缺口。

### 21.1 草稿审计结论

| 草稿 | 结论 | 处置 |
|---|---|---|
| `packages/contracts` 多凭据/Zone/`nodes.domain` | 与确认结构一致 | 保留 |
| `apps/api`（`cf-dns.ts`、`routes/cfDns.ts`、`db/d1/nodes.ts`、迁移 0008） | 一致；旧 `cf_dns` 单 Zone 首次读取迁移为 legacy 账号 | 保留 |
| `HubOverviewPage` 证书状态 | 一致，但此前取错数据源 | 改为读 `agentState.adapters[caddy-site].status.siteHealth`，并按"未绑定/未知/未签发/已签发"分级 |
| `cfDns.notice` / `cfDnsWillCreate` | 仍是单 Zone 文案、证书描述误导 | 重写为多凭据/多 Zone；域名提示写明"安装命令自动带 Caddy 与自签 HTTPS（--tls-cn=<域名>）" |
| `ProcessDrawer` 过滤 | 只覆盖 Peer 运维抽屉 | 补到主机运维"进程"分段（默认只看业务进程），两处共用 `processFilter.ts` |

### 21.2 验证结果

| 项 | 结果 | 证据 |
|---|---|---|
| `./scripts/verify.sh` | ✅ 全绿 | typecheck + vitest 全量（含新增多凭据/迁移 0008/进程过滤用例）+ web build + compileall + agent 单测 + 发布一致性 |
| CI 三 job + 生产部署 | ✅ | run `41646488669`：Typecheck/Test/Build、Agent tests、Deploy production 全绿 |
| 迁移 0008（remote 生产） | ✅ | 迁移前 D1 导出备份（`.khc-local/d1-backup/<d1-name>-2026-11-03-before-0008.sql`）；`pragma_table_info('nodes')` 含 `domain` |
| 建域名 → 建 DNS | ✅ | 面板创建节点时按 Zone+子域名代建 A 记录 `x86-2-test.example.com → 203.0.113.14`，`nodes.domain` 落库；A 记录失败不阻断建节点（单测 `hubsCfDns.smoke` 断言抽屉显示具体失败原因） |
| 安装命令 | ✅ | `install-command` 返回 `--with-caddy --tls --tls-cn=x86-2-test.example.com`，面板可见可改 |
| 证书签发 | ✅ | x86-2 上 Caddy 2.6.2 + Let's Encrypt 签发 `CN=x86-2-test.example.com`、issuer `CN=YE2`、有效期至 2027-02-01；外部 `openssl s_client` 校验通过 |
| 面板显示证书 | ✅ | `/state` 的 `caddy-site.status.siteHealth[0]` = `ok`（根路径 200）；节点概况"证书状态：已签发（HTTPS 校验通过）" |
| 证书状态口径 | ✅ | 无 Agent 状态 → "未知（Agent 未上报）"；无匹配站点 → "未签发（该域名未建站点…）"；4xx → warn/未签发或校验失败；不使用绿色伪造成功 |
| 进程过滤（x86-2 实机） | ✅ | 进程分段默认"只看业务进程"，灰字"已隐藏 111 个系统进程"；切"显示全部"后灰字变"已显示全部进程（其中 111 个系统进程）"，列表出现 kworker/psimon 等；khc Agent 自身与 host-ops 辅助脚本按实机路径归入系统进程 |
| 进程过滤（arm-1） | ⚠️ 以实机 `/proc` 快照验证 | arm-1 未装 Agent、8880 被 VCN 阻断且 443 上有并存业务 Caddy（oc.example.org），为避免改动该机生产配置未部署 Agent；抓取 arm-1 `/proc`（158 进程）后跑真实 `processFilter.ts`：隐藏 152、业务 6（含抓取脚本自身），内核线程/sshd/dbus/cron/snapd 均正确归入系统进程 |
| UI 三态截图 | ✅ | `docs/verification/2026-11-03/shots/`：`ui-cf-dns-accounts-{light,dark,390}.png`、`ui-hub-create-domain-{light,dark,390}.png`、`ui-node-cert-{light,dark,390}.png`、`ui-process-filter-{light,dark,390}.png`、`ui-process-filter-all-light.png` |

### 21.3 过程与清理

- x86-2 当前测试形态：Agent 监听 `127.0.0.1:8880`，Caddy 站点 `x86-2-test.example.com:443`（`kind=proxy`，`/health|/state|/adapters|/upgrade|/tasks/*|/apps/*` 走 Agent，其余走 `127.0.0.1:8081` 静态服务）；节点直连地址仍为 `http://x86-2-test.example.com:80`（Caddy 自动 301/308 到 443）。
- 手工 iptables 放行 443/8880 未持久化；`127.0.0.1:8081` 由 systemd 临时单元提供，重启后需重建（仅测试用途）。
- 已清理：arm-1 临时探针单元与 8880 iptables 规则；x86-2 两条 `not-found failed` 的历史 port-forward 残影（`systemctl reset-failed`）。

### 21.4 附带发现（如实记录，未修复）

- **经 `https://panel.example.com` 发起的写请求会被 CSRF 拦截**：Worker 处 `c.req.url` 的主机是 `<worker-name>.<account>.workers.dev`，与浏览器 `Origin: https://panel.example.com` 不一致 → `403 cross_origin_blocked`；改从 workers.dev 域名访问则正常（本轮截图均走 workers.dev）。该差异属于既有部署形态，需主人确认对外入口应使用哪个域名。

## 22. 收尾三项（安装命令去自签 / CSRF 白名单 / x86-2 常驻测试节点，2026-11-03）

> 本节取代 §21.3 与 §21.4 的现场形态与"附带发现"（8081 静态服务、手工 iptables、panel.example.com 写请求 403 均已处置）。

### 22.1 改动

| 项 | 改动 | 证据 |
|---|---|---|
| 安装命令去自签 | 域名节点自动渲染只带 `--with-caddy --tls-cn=<域名>`；`--tls` 仅显式勾选时附加。UI 文案、`docs/cf-dns.md`、`docs/runbook/node-onboarding.md`、`docs/ui-redesign/page-specs.md` 同步改为"Caddy 自动签 LE，Agent 自签 Worker 传输层不接受" | `5cadd74`；`agent_lifecycle.test` 断言 `--with-caddy --tls-cn x` 且不含独立 `--tls`；`hubsCfDns.smoke` 断言 `tls:false` |
| CSRF 白名单 | 新增 `[vars] LIVE_ORIGINS`（逗号分隔 origin）；未配置时保持"仅同 host"，配置后白名单放行。`wrangler.toml` 加入 `https://panel.example.com`（域名不硬编码在代码） | `5cadd74`；`auth.test` 覆盖"未配置仍 403 / 白名单 201 / 伪造 403" |
| caddy 端口自动放行 | `caddy_site.port_claims` 声明 `release=True`，apply 后内核维护 `khc-auto:caddy-site` 入站规则；`siteHealth` 支持 `healthUri` | Agent 0.1.14 出包入库（`khc-agent-0.1.14.tar.gz`，sha256 `df311cb0…`），发布清单已更新 |

### 22.2 线上实测

- **CSRF 正向**：`POST /api/v1/nodes` 带 `Origin: https://panel.example.com` + 会话 cookie → `201`，创建 `csrf-probe-node`；随后同 Origin `DELETE` → `200`，探针节点已删除，节点列表现为 `node-test-2` / `node-prod-1`。
- **CSRF 反向**：同请求伪造 `Origin: https://evil.example` → `403 cross_origin_blocked`。
- **Agent 发布链**：`GET /api/v1/agent/releases` = `0.1.14`；`https://panel.example.com/agent/khc-agent-0.1.14.tar.gz?v=20261103` 下载 sha256 = 清单值；x86-2 经 `POST /nodes/:id/agent/upgrade`（Origin 白名单）返回 `202`，重启后 `khc.VERSION = 0.1.14`（手工补丁已被正式包取代）。
- **x86-2 现场**：`iptables -S INPUT` 只剩 `khc-auto:caddy-site`(443)、`khc-auto:wireguard`(51820) 与 22/80 基线/REJECT；`8081` 无监听、`khc-cert-test` 单元 not-found、`/var/www/khc-cert-test` 已删除；证书 `CN=x86-2-test.example.com`、issuer `Let's Encrypt YE2`、至 2027-02-01；`https://x86-2-test.example.com/health` = 200；面板 `/state`：`reachable=true`、Agent `0.1.14`、`caddy-site` appliedRev 4、`siteHealth=ok/200`。
- **CI 部署**：run `41653219429` 全绿（Agent tests、Typecheck/Test/Build、Deploy production）。
- **验证脚本**：`./scripts/verify.sh` 全绿（447 vitest、887 agent 单测、发布一致性 0.1.14、shell 语法）。

### 22.3 遗留

- 发布清单为单条目（仅 0.1.14），旧版本（≤0.1.13）不再被 install/upgrade 命令接受；节点应升级到 0.1.14。属既有清单机制，非遗留缺陷。
- `docs/archive/ui-redesign/audit-2026-11-03/clicks-audit.md`（历史资料）、本报告 §21.1/§21.2 中"`--tls --tls-cn`"是历史走查记录，非现行口径；现行口径以 §22 与 `page-specs.md` 为准。

## 23. CF DNS 读取已有解析记录（只读选择，2026-11-03）

### 23.1 权限实证（只读）

| 请求 | 结果 |
|---|---|
| `GET /user/tokens/verify` | HTTP 200，Token active |
| `GET /zones?per_page=100&status=active` | HTTP 200，1 个 Zone `example.com`，与面板存量的 Zone ID 一致 |
| `GET /zones/:id/dns_records?type=A` | HTTP 200，9 条 A |
| `GET ...?type=AAAA` / `?type=CNAME` | HTTP 200，0 条 |
| 样例 | `node-test-2.example.com → 203.0.113.14`（手工记录，comment null）；`node-prod-1…`（comment `khc-server managed`） |

结论：权限足够（`Zone→DNS→Edit` 含读取），无需新增权限；此前拉不到记录是面板只实现了创建、未实现列记录。

### 23.2 实现与实测

- 新增 `GET /api/v1/cf-dns/records?zoneId=`（只读 A/AAAA/CNAME，comment 命中标记时 `managed=true`）；创建抽屉新增「已有解析记录」下拉，选中后域名与主机只读带入、端口可改，提交只写 `nodes.domain`，不建不改 DNS；同名多条/同名 CNAME/已绑定其他节点置灰；读取失败提示权限/网络并保留手填子域名代建。`POST /nodes` 增加可选 `domain` 以原子写入所选记录名。
- 预览版 API：两个已启用 Zone 均返回 200（khc6 9 条 A、example.org 1 条 A）。
- UI（workers.dev 预览）实机：选 `node-test-2.example.com → 203.0.113.14`，主机只读 203.0.113.14、端口 8880，提交创建 `dns-read-e2e`，直连地址 `http://203.0.113.14:8880`、域名 `node-test-2.example.com`，安装命令为 `--with-caddy --tls-cn node-test-2.example.com`；未产生任何 CF 记录写调用。测试后已删除该节点，手工 A 记录仍在。
- 证书：在 node-test-2 现有 Agent 的 Caddy 上临时加入该域名站点并 apply，TLS 握手取得 Let's Encrypt 证书（CN=node-test-2.example.com，签发时间 2026-11-03 14:17 UTC）；随后恢复原 Caddy 配置并再次 apply。新节点本身未在主机上安装 Agent（本轮无 SSH 入口），故"新节点令牌装机"未执行；证书签发链路已在同一主机、同域名上验证（新节点链路已于 §24 闭环）。
- 兜底：Web 单测覆盖读取 403 → 权限文案 + 手填子域名继续代建；`./scripts/verify.sh` 全绿（459 vitest）。
- 截图：`docs/verification/2026-11-03/shots/dns-records-drawer-{light,dark,390}.png`、`dns-records-result-light.png`。

## 24. 合并上线与真机闭环（2026-11-03）

### 24.1 合并与部署

- 分支 `feat/cf-dns-read-records`（`b38716b`）以 squash 合入 `main`：`0304022`；合并前 `./scripts/verify.sh` 全绿（459 vitest）。
- CI run `41666658258` 全绿，Deploy production 执行（ADR-0008，`main` 推送即生产）。
- 生产冒烟（https://panel.example.com）：登录 200；`GET /api/v1/cf-dns/records?zoneId=<khc6>` 认证返回 200、9 条 A；同一请求未认证返回 401。

### 24.2 真机五步（node-test-2，新节点视角）

| 步骤 | 结果 | 证据 |
|---|---|---|
| 1. 面板用「已有解析记录」建节点 | ✅ | 选 `node-test-2.example.com → 203.0.113.14`，主机只读、端口改 8443；创建 `node-test-2`（endpoint `http://203.0.113.14:8443`，domain 正确）；安装命令含 `--with-caddy --tls-cn node-test-2.example.com` |
| 2. 用面板命令装 Agent | ✅ | 面板 `install-command` 原样执行；Agent 0.1.14 起于 `0.0.0.0:8443`，health 200；节点 state `reachable=true, via=tcp` |
| 3. 面板建站点并签发 LE | ✅ | 静态站点 `node-test-2.example.com`（`/var/www/<site>`，443，自动签发）保存并生效；节点概况显示「已签发（HTTPS 校验通过）」 |
| 4. 外部复核 | ✅ | `curl https://node-test-2.example.com` → 200，证书 `ssl_verify_result=0`；`CN=node-test-2.example.com`，Issuer `Let's Encrypt YE2`，`notBefore=2026-11-03 15:01:19 UTC`（LE 回拨 1h，实际签发约 16:01 UTC），`notAfter=2027-02-01` |
| 5. 不许假装成功复核 | ✅ | 停 Caddy 后证书状态显示「站点不可达：Connection refused」非绿；阻断 `/cf-dns/records` 后抽屉显示「读取已有解析记录失败…可继续手填子域名」且子域名输入可用；同名两条 A 记录在抽屉中均置灰（`冲突：同名多条记录`） |

### 24.3 清理与终态

- 删除旧节点 `nd_xxxxxxxxxxxxxxxx` 及其代建的 `x86-2-test` 记录；保留手工 `node-test-2.example.com` A 记录；删除冲突测试 `dup-e2e` 两条记录。
- 终态：节点 `node-test-2` 在线（tcp:8443），Agent/Caddy 均 active，证书有效；Zone 记录 8 条（原 9 条减去已删的 x86-2-test），手工记录仍在。
- 已知说明：为让 Agent 与 Caddy 共存，Agent 监听 8443 并在主机 iptables 放行 8443（OCI 安全列表已放行 80/443/8443）；8443 由面板安装命令的 `--port` 带入，未手工拼命令。
- 截图：`shots/e2e-record-selected-light.png`（选中记录）、`e2e-record-conflict-light.png`（同名冲突置灰）、`e2e-record-read-failed-light.png`（读取失败兜底）。

## 25. 节点状态三态：`node-prod-1` 显示离线根因与修复（2026-11-04）

### 25.1 根因（状态判断错，混合前端刷新缺陷）

- 实机：`http://203.0.113.15:8880/health` → 200；面板 `GET /api/v1/nodes/<node-prod-1>/state` → `reachable=true, via=tcp`，机器可达。
- 控制面：`apps/api/src/routes/helpers.ts` 原 `toPublicNode` 把 `lastSeenAt===null || now-lastSeen>300s` 判为 `offline`，即「从未探测/租约过期」被当成「离线」。
- 前端：`/hubs` 只渲染列表里的 DB 租约、不探测 `/state`（探测与 `useMarkHubsReachable` 原本只在概览页），历史租约过期后就一直显示离线。
- 结论：非真离线、无脏数据；`node-prod-1` 保留。`offline` 应由前端实际探测失败产生，而不是服务端按时间推断。

### 25.2 修复

| 层 | 改动 | 文件 |
|---|---|---|
| 控制面 | 列表 `status` 三态：窗口内 `online`；从未探测/过期 `unknown`；不再由列表推断 `offline` | `apps/api/src/routes/helpers.ts` |
| 前端列表 | 打开探测一次全部节点；`reachable=false` 才置离线，探测请求失败保持「未探测」；状态徽标 在线/离线/未探测 | `apps/web/src/pages/HubsPage.tsx` |
| 刷新边界 | 页头 [刷新状态] 手动重拉+探测全部；失败节点 60s 重试、最多 3 次，恢复或手动刷新即停（**2026-11-04 §26 起改为打开不探测、无自动重试**） | `HubsPage.tsx`、`registry/actions.ts` |
| 文案 | `status.unprobed='未探测'`；概览页同口径 | `i18n/zh.ts`、`pages/OverviewPage.tsx` |

### 25.3 本地验证

- `./scripts/verify.sh` 全绿（462 vitest + 887 agent 单测）。
- 新增 Worker 单测：新节点=`unknown`、`lastSeenAt=now-400`=`unknown`、`lastSeenAt=now`=`online`（`apps/api/test/nodes.test.ts`）。
- 新增前端烟雾测试：在线/离线/未探测各 1 行，未探测不显示为离线；点 [刷新状态] 触发第二轮探测（`apps/web/src/pages/hubsStatus.smoke.test.tsx`）。

### 25.4 合并与生产验证（2026-11-04，main `db9da5f`）

- PR #62 以 squash 合入 `main`（`db9da5f`）；CI run `41745798845`：Agent tests / Typecheck·Test·Build / Deploy production 全绿（ADR-0008，main 推送即生产）。
- 线上 `GET /api/v1/nodes`：`node-prod-1` 与 `node-test-2` 探测后均 `online`；`GET /state` 两节点均 `reachable=true, via=tcp`。
- 故意不可达节点 `status-check-unreachable`（`http://203.0.113.10:8880`）：创建后列表 `status=unknown`（未探测），`/state` 返回 200 + `reachable=false`（「Hub 不可达（直连与隧道均失败）」），面板详情页显示「离线」。
- 浏览器实机核对：三个节点详情页分别为「在线 直连」「在线 直连」「离线 直连」，控制面不可达提示正常；核对后已删除测试节点，终态仅保留 `node-prod-1`、`node-test-2` 两条在线记录。
- 截图：本次浏览器自动化环境受限未能落盘截图；三态渲染由 `hubsStatus.smoke.test.tsx` 覆盖（在线/离线/未探测各 1 行），线上以页面快照文本核对。

## 26. 运维数据只走浏览器直连观测（2026-11-04）

### 26.1 背景与改动

定位回归：面板只做配置读写与按需动作，**运维实时数据只由浏览器直连 Hub `/_live/`**。
本轮移除 10-26～11-01 逐步引入的控制面快照回退与周期轮询（溯源与取舍见 `ADR-0009`）：

| 层 | 改动 | 文件 |
|---|---|---|
| 通道探测 | `/state` 只在打开工作区探测一次；删除 5s 轮询；失败提示条提供 [重试控制面] | `HubChannelsProvider.tsx`、`channels.ts` |
| live 断开 | 不自动 10s 重试；进入「未连接」并等待用户 [重新连接] | `data/live.ts` |
| 运维页 | 状态带只读 live 快照；未连接显示横幅，不回退快照 | `pages/HubOpsPage.tsx` |
| 运行态 | WG / Caddy / 端口转发 / Peer 运维缓存只读 live；删除 3s/5s `/state` 查询 | `data/wireguard.ts`、`data/sites.ts`、`data/forwards.ts`、`PeerOpsPanel.tsx` |
| 观测入口 | `domain` 自动推导 `https://<domain>`；删除创建死字段与设置页手填 | `apps/api/src/routes/helpers.ts`、`HubsPage.tsx`、`node-settings/page.tsx` |
| 卸载 | 契约包信息可选；Worker 注入已签名最新发布包；抽屉隐藏字段 | `packages/contracts/src/index.ts`、`agent_lifecycle.ts`、`AgentCommandDrawer.tsx`、`data/agent.ts` |
| 删除节点 | 入口回到 `/hubs` 行内（L3）；可选生成卸载脚本，删后仍可复制/下载 | `HubsPage.tsx`、`node-settings/page.tsx` |
| 请求预算 | 全局 `retry:false`、关闭窗口焦点/重连自动重拉；概览页删除按节点 fan-out；`/hubs` 打开不探测；诊断/证书占用按需；任务进度改退避 | `main.tsx`、`OverviewPage.tsx`、`HubsPage.tsx`、`HubOpsPage.tsx`、`hostOps.ts`、`mode.ts`、`certificates/page.tsx` |

### 26.2 本地验证

- `./scripts/verify.sh` 全绿（见 §26.4 实跑输出）。
- Worker：卸载命令不传包信息且测试环境无发布清单 → `503 release_unavailable`；显式包信息路径保持（`agent_lifecycle.test.ts`）。
- 前端：`channels.test.ts` 断言 `readSource` 只有 `live`/`none`；`hubsStatus.smoke.test.tsx` 覆盖「打开不探测、点刷新才探测」与 `/hubs` 删除（L3 + 卸载脚本）；`c3`/`forwards`/`wireguard` 冒烟改为直连观测事件驱动。

### 26.3 上线后线上核对项

- `/hubs` 行内可见「删除节点」，L3 输入节点名解锁，可勾选生成卸载脚本；
- 卸载抽屉无「安装包地址 / sha256」字段；
- live 正常时 DevTools Network 无周期性 `/state` 请求；
- live 断开（断网/阻断观测入口）时主机运维页显示「实时观测未连接」，无控制面快照补位。

### 26.4 请求预算核对（2026-11-04）

| 场景 | 请求数 | 证据 |
|---|---|---|
| 打开 `/` 概览 | 2（`/nodes`、`/certificates`） | `OverviewPage.tsx` 仅两个查询；无 `useQueries` fan-out |
| 打开 `/hubs` | 1（`/nodes`）；刷新状态 1 + N | `hubsStatus.smoke.test.tsx`：打开时 `stateCalls=0`，点刷新才探测 |
| 打开节点工作区 | 1 + 1（`/state` 一次性）+ 2–3 配置 | `HubChannelsProvider` 无 interval |
| 打开 `/settings` | 3；证书占用仅在详情/删除确认按需 | `certificates/page.tsx` `usageEnabled` |
| 自动重试 / 轮询 | 0 | 全仓无 `refetchInterval`；`QueryClient` 默认 `retry:false` |
| 写操作进度回执 | host-ops 1→2→4→8s（≤120s 约 16 次）；模式 2→4→8→10s（≤60s 约 7 次） | `hostOps.ts`、`mode.ts`，均可取消 |

典型使用（每月约 10 次打开）**每月 < 200 次 Worker 请求**；放大场景均有硬上界，不会打爆额度。

### 26.5 合并与生产验证

- PR [#65](https://github.com/khc8655/khc-server/pull/65) squash 合入 `main`，commit `030a944`。
- CI run [41779436380](https://github.com/khc8655/khc-server/actions/runs/41779436380)：Typecheck/Test/Build、Agent tests、Deploy production Worker 全部通过。
- 生产 `https://panel.example.com/api/v1/health` → 200；首页引用新包 `assets/index-saosd6HP.js`（与本地 `pnpm build` 一致）。
- 线上 UI 核对（登录后）：打开 `/hubs` 时 Network 无 `/state` 探测；点 [刷新状态] 才出现 N 条；概览页只有 `/nodes`、`/certificates` 两条接口；断网恢复/切回标签页不触发额外请求。
