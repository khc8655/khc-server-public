# 故障排查手册（troubleshooting）

> 状态：现行 ｜ 最后核验：2026-11-10 ｜ 关联：`docs/runbook/node-onboarding.md`、`docs/diagnostics.md`、`docs/agent-lifecycle.md`
> 范围：控制面（Worker/面板）与 Agent 的线上故障排查；按症状组织，每节 = 症状 → 判定链 → 处置 → 验证

## 1. Agent 离线 / 节点不可达

判定链（从外到内）：

1. **云防火墙**：目标端口（如 8443/tcp）是否放行；裸 IP 还要确认没被安全组默认拒绝。
2. **进程**：`systemctl status khc-agent`（user 模式加 `--user`）；`Restart=on-failure` 会自拉起，频繁重启看 `journalctl -u khc-agent -e`。
3. **本机健康**：`curl -s http://127.0.0.1:<端口>/health` 应返回 `{"ok":true,...}`（无鉴权）。
4. **传输通道**：Worker→Agent 双通道——域名走原生 fetch，裸 IP 一律走 `cloudflare:sockets` TCP 通道（裸 IP 的 fetch 恒为 Cloudflare 403 error 1003，属平台行为不是故障）。节点 `/state` 的 `via` 字段标明实际通道（`"tcp"`/`"fetch"`）。
5. **路由内回退与冷却**（feat/server-capabilities 后行为）：**同一次调用**中域名 fetch 失败（403/1003、超时、连接拒绝等网络类错误）会**自动回退 TCP 直连**，幂等键不变、回退后重新签名，不会重复执行写动作；回退在日志/诊断里可见（routeErrors 逐通道记录）。全部通道失败后该节点进入 **30s 探测冷却**——冷却期内面板对该节点直接报冷却剩余秒数，不再反复重试拖慢交互（诊断探测不受冷却限制）。彻底不可达时错误为 `HubUnreachableError` 502 + 逐通道明细。
6. **自签证书节点**：若错误信息为「证书校验失败（节点可能使用自签名证书…）」，这不是网络不可达——域名 fetch 通道与裸 IP 的 TCP 通道 TLS **均由平台强制校验证书，自签证书不可用**。处置优先级按 D-3 传输加密口径（见 node-onboarding §4.1）：**可信证书直连首选**（公网域名/IP 证书）→ 明文 `http://<IP>:<端口>` 仅限可信网络临时用 → **cloudflared Tunnel 备用**（国内 VM 备案/端口受限时）；Agent 侧 `--tls` 自签的限制见 node-onboarding §5.3。
7. **偶发不可达但重试即恢复** → 见 §6 超时踩线，不是真离线。

## 2. 防火墙锁死与恢复

host-ops 的 `fw.*` 只管理 `table inet khc_fw`（nftables），安全网设计（修复后行为，report §7 P1-B 实机复验）：

- **锁定保护**：`deny` 规则按「协议 + 端口」两维判定——tcp 侧保护 SSH 端口 + Agent 实际监听端口（从 `/proc` 实测 Agent 进程的 LISTEN socket，无 8880 硬编码）；udp 侧保护 WG 端口。命中即拒绝 `E_LOCKOUT`，规则不生效。
- **协议不匹配不误拦**：`deny udp/22`（SSH 是 TCP）、`deny tcp/51820`（WG 是 UDP）都会正常放行执行。
- **60 秒确认机制**：`fw.apply` 成功后用 `systemd-run --on-active=60` 预约自动回滚；**必须在 60s 内 `fw.confirm`** 才持久化。实测不确认约 70s 后规则自动回滚、`fw.show` 状态复位 `none`，SSH 会话全程不受影响。
- **回读校验**（feat/server-capabilities，`6816fd5`）：`nft -f` 成功后 Agent 会**回读 `nft list table inet khc_fw` 实际内容**与生成的 ruleset 比对（签名集合 + 基线子串，兼容 nft 排版差异）；不一致抛 `E_FW_VERIFY`，message 带差异摘要与可操作提示。校验失败时**不写新状态、不取消 60s 回滚定时器**——旧规则会自动恢复，不再出现"已应用"假成功。遇到 `E_FW_VERIFY` 属静默失败被拦下，按 message 提示处理后重试。
- `fw.apply` 报 `E_UNSUPPORTED（systemd-run 不可用）` = 回滚定时器建不起来，规则**未**被修改（保护性失败）。

**锁死恢复**（确认机制失灵或手工误操作 nft 时）：

```bash
sudo nft list table inet khc_fw          # 看当前规则（accept 保护行在链首）
sudo systemctl list-timers 'khc-fw-*'    # 看回滚定时器是否还在
sudo nft delete table inet khc_fw        # 兜底：整表删除（Agent 侧 state 会在下次操作时复位）
```

云防火墙（Lightsail/Oracle 控制台）与机内 nftables 是两层，排查时先分清在哪一层拦的。历史上保护端口硬编码 8880 与 hub 实际 8443 不符的问题已修复（P1-B）；如再遇「deny 自己入口端口却没报 E_LOCKOUT」，优先检查 Agent 进程是否在运行（保护端口靠 `/proc` 实测，Agent 没跑就没有固定保护端口）。

## 3. host-ops keys.* 失败（家目录不可见）

修复后（report §7 P0-1）：unit 为 `ProtectHome=read-only` + `ReadWritePaths=...:-/root/.ssh`——Agent 可读全部家目录、仅可写被授权用户的 `.ssh`（hub self 默认用户 root，即 `/root/.ssh`）。`keys.list/add/remove` 已实机复验正常。

若仍失败：

```bash
systemctl cat khc-agent | grep -E 'ProtectHome|ReadWritePaths'   # 确认 unit 是新渲染的（旧 unit 需重装/重启生效）
sudo /var/lib/khc-agent/host-ops/khc-host keys.list              # 绕过 Agent 沙箱手工执行（hub self 路径；stdin 可传 JSON 参数）
```

管理**非 root 用户**的 keys 需在安装时授权该用户家目录（install.sh 渲染对应 `ReadWritePaths`）；对未授权用户家目录的写操作会被沙箱拦截，属设计行为。【待实测补写：多用户授权场景的完整验证（当前仅 root 单用户实机验证过）】

## 4. hub self `fw.apply` 失败（E_UNSUPPORTED / 找不到脚本）

修复后（report §7 P0-2）：`khc-host` 脚本路径按部署形态解析——环境变量 `KHC_HOST_SCRIPT_PATH` > `__file__` 实际位置 > 兜底 `/usr/local/sbin/khc-host`。两种形态：peer 装在 `/usr/local/sbin/khc-host`，hub self 在 `<data_dir>/host-ops/khc-host`（data_dir 默认 `/var/lib/khc-agent`）。STATE_DIR 同样按形态解析。

若升级后仍报错：确认 Agent 进程重启过（路径解析在进程内）、`ls -l <data_dir>/host-ops/khc-host` 存在。

## 5. 证书失败

签发走 `acme.sh` **DNS-01**（`issue_acme` 任务：domains + provider + credentials，凭据来自面板「设置」的 DNS 提供商配置，见 ADR-0006）。排查顺序：

1. 面板「设置」里 DNS 凭据是否有效（provider/credentials 拼写、权限）。
2. 域名 NS 是否指向该 DNS 服务商。
3. 节点任务日志：`GET /nodes/:id/tasks/:tid` 看 `issue_acme` 的错误详情（`_record_acme` 会记录成败）。
4. 目标机器上 `acme.sh` 是否存在（适配器依赖）；Caddy reload 失败看 `journalctl` 与 Caddyfile 片段。
5. 自建/自签证书不会被 Agent 升级链路接受（发布包 Ed25519 签名清单机制，见 `docs/security-boundaries.md` §5）；但证书内容本身无此限制，仅 Agent 软件包有。

## 6. WG peer 不通 / 超时踩线

**peer 不通**排查（从下往上）：

1. 握手：hub 上 `sudo wg show` 看 peer 的 `latest handshake`（有握手 = 隧道层通，问题在路由/上层）。
2. 云防火墙：51820/udp 必须放行（两台都要）。
3. AllowedIPs：客户端与 hub 的 CIDR 是否重叠/缺失——**apply 前校验会拒**（400 `invalid_config`，且失败不碰运行配置，实测 conf sha256 不变）。
4. apply 删 peer 后内核残留：已修复（P1-A）——peer-only apply 会对比 conf 与 `wg show dump`，内核残留 peer 自动 `wg set ... peer ... remove`；复核命令 `sudo wg show wg0 peers` 应与 conf 一致（实测 PUT `peers=[]` + apply → 内核 peers=0）。
5. **apply 后状态校验**（feat/server-capabilities，`6816fd5`）：wg apply 完成后 Agent 校验接口存在（`ip link`）与 peer 数量（兼容轮换 overlay 的双记录）；unit 未起会先在同一次操作内尝试启动（幂等安全）。校验失败抛 `code=wg_verify_failed`，错误信息明确"哪一步没生效 + 下一步做什么"（journalctl / ip link / wg show）。面板收到的 `ApplyFailed.message` 会带具体原因，不再只有笼统的"应用失败，已自动回滚"。
6. Agent 重装后 peer 恢复：已修复（P1-A）——`/etc/wireguard/<name>.conf` 仍在时，重装后重新 apply 同一 rev 会从 conf 恢复接口私钥与 peer 公钥（AllowedIPs 严格匹配才恢复），实测 conf 不变、客户端 ping 不中断。
7. 面板看不到 peer 列表/显示未知：已知未修（P1-6）——D1 不回存 peer 公钥（取舍：避免私钥出 Agent / 应用知识进核心路由）。以 hub 上 `wg show` 为准。【待实测补写：如后续决定回写 D1 再更新本节】

**超时踩线**（P1-7）：TCP 通道 `/state` 实测 2.1–2.4s，逼近 3s 超时；ops 页偶发「不可达」但重试即恢复。处置=重试即可；超时参数调优待主人拍板（现状 3s 不动）。

## 7. 登录 / HMAC 401

**面板 401**：会话 cookie `khc_sess` 过期（8h）→ 重新登录。

**Agent 401**（Worker 转发报鉴权失败）按概率排查：

1. **token 不匹配**：重装 Agent 时 `install.sh` 若发现 token 文件缺失会**重新生成** token（并只显示一次），与面板记录不一致 → 401。处置：把面板侧 token 重新写入机器（onboarding §5.2 的非交互写法），或在面板轮换节点 token。注意：实测记录过卸载后 token 文件被清除的情况，重装前建议先备份 `/etc/khc-agent/token`。
2. **时钟漂移**：签名时间窗 ±60s。`timedatectl status` 看 RTC 偏差；`sudo timedatectl set-ntp true` 同步后重试。
3. **nonce 重放**：同一请求重放（120s 内同 nonce）会 401——属防重放设计，正常操作不会触发。
4. 对 `/state` 之外的所有 Agent 端点 401、`/health` 正常 = 鉴权层工作正常的表现（实测 F1/F2：伪造/缺失签名全 401）。

## 8. 登录限流

阈值 10 次失败 / 300s / 每源 IP，第 11 次 429（`Too Many Requests`）。存储三级降级（P1-C，迁移 0006）：D1 原子 upsert（主路径，跨 isolate）→ KV（未绑定时跳过）→ 进程内内存。

- 本地 dev / 未跑迁移 0006 的环境：退化为单 isolate 内存限流（多实例下计数不共享，属已知降级）。
- 生产复验（2026-11-02）：迁移 0006 已对生产 D1 执行并先于 Worker 部署（main `02f13b2`）；连打 12 次错误口令，第 1–10 次 401、第 11–12 次 429（`too_many_attempts`），D1 计数行 `count=12` 落库，异 IP（hub VM）登录不受影响。

## 9. 配置二维码不显示

已知问题（P2-8）：WG 客户端配置的 `qr` 字段为 null，扫码引导缺失。现状用人工路径：把 `PUT/apply` 响应里的客户端配置文本导入官方 WireGuard 客户端。【待实测补写：修复 + 浏览器走查补验后更新】

## 10. 删除节点/Peer 时的本机残留清理

feat/server-capabilities（`01cdd8f`）起，面板删除节点/删除 Peer 的确认框带「同时清理本机服务」复选（默认勾选）：

- **清理范围**（khc-host `cleanup` 动词，幂等可重复、逐项回读校验）：停用 `wg-quick@wg0` 并删 `wg0.conf`、清空 `/etc/caddy/khc.d` 并 reload caddy、停用并删除全部 `khc-forward-*.service` + daemon-reload、停删已确认的防火墙产物（`khc-fw.service`、nft `table inet khc_fw`、fw 规则/状态文件——默认 `/etc/khc-host/` 与 Agent 数据目录 `fw-state/` 两处布局都清）、清理 `/opt/khc` 与 `/etc/khc`。**khc-agent 自身不在清理范围**（卸载 Agent 仍走 `uninstall.sh`）。
- **通道**：节点 = hub self（本机）；Peer = 经主机运维 SSH 通道（须已 onboard）。未 onboard / 不可达时会报错提示。
- **残留即阻止**：清理后仍有残留（如服务停不下来）会**阻止删除**并列出 cleaned/remaining/skipped 清单；可取消勾选明确改为"仅删除面板记录"，此时本机服务保持原样。`skipped` 中的 `/opt/khc`、`/etc/khc` 是 Agent 沙箱 ReadWritePaths bind mount（挂载点无法 rmdir）：内容已清空、目录保留，**不算残留、不阻止删除**，也无需宿主侧处理。
- **排查**：删除被阻止时看返回的 remaining 清单，上机处置（多为服务被外部依赖占用），再重试删除。

## 11. Agent 远程升级的纪律与失败判定

**升级操作纪律（强制）：**

1. **同一节点两次升级（含重试）间隔 ≥60 秒**。连续下发会让看门狗检测到「多轮升级重叠」并触发回滚；执行后等面板版本回显更新再决定下一步，不要连点。
2. **升级失败先看节点上的 `/var/lib/khc-agent/upgrade.json`**，不要直接重试：
   - `ok` / `status`：本次升级的判定结果；
   - `fromVersion` / `targetVersion`：期望的版本跨越；
   - `recoveredFrom`：进程重启后从中间态恢复的标记；
   - `watchdog`：看门狗 unit 与脚本位置；`backup` 指向上一版目录（默认 `/opt/khc-agent.prev`）。
3. **判定以 `/health` 回显为准**：`curl -s http://127.0.0.1:<端口>/health` 的 `version` 是升级是否真正生效的唯一事实。实测存在 `upgrade.json` 记 `ok:false / status:unknown` 但 `/health` 已回显目标版本的假失败（2026-11-10，0.1.23→0.1.35），此时**不要重试**，否则会撞上第 1 条的重叠回滚。
4. 需要人工回退时，停服务 → 把 `backup` 目录换回 `/opt/khc-agent` → 重启，再核对 `/health`；看门狗/重叠检测本身属已知缺陷（`docs/agent-lifecycle.md` §13），修复单独立项，**不要在执行升级时顺手改**。
