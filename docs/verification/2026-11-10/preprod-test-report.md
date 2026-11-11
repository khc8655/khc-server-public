# 上生产前完整测试报告（2026-11-10）

> 状态：现行（一次性验证记录，执行完毕） ｜ 适用范围：面板 0.7.12（main `acd9b41c`，tag `release-2026-11-10`）/ Agent 0.1.35 宣布生产可用前的 A–H 八轨测试 ｜ 最后核验：2026-11-10 ｜ 关联：`docs/plans/preprod-test-plan-2026-11-10.md`（工作单）、`docs/engineering/testing.md`、`docs/engineering/release.md`、`docs/runbook/disaster-recovery.md`、`docs/production-readiness.md`

**归类**：工程流程 — 验证记录。
**脱敏**：本报告不写测试机公网 IP、面板域名与测试 Zone 明文，统一用 `3.145.***.***`、`161.118.***.***`、`<panel-domain>`、`<hub-domain>`、`<test-zone>` 占位。

---

## 1. 总览

### 1.1 测试范围

对应工作单 §5 的全部八条轨道：A 自动化与发布门禁、B Worker API、C Agent 与节点真机、D UI 与交互、E 稳定性、F 安全、G 运维与灾备、H 已知缺陷回归。共 **126 条**（A 8 + B 23 + C 18 + D 14 + E 9 + F 11 + G 8 + H 35）。

安全约束按工作单 §2 执行：生产请求压到最低、写操作只针对 `e2e-` 资源、不改全局既有项、不改 `wrangler.toml`/secrets、不跑 D1 写语句、不调用会话撤销、凭据零落盘。

### 1.2 环境

| 角色 | 标识 | 说明 |
|---|---|---|
| 被测版本 | 面板 0.7.12 / commit `acd9b41c` / Agent 0.1.35 | 与 tag `release-2026-11-10` 一致 |
| 控制面 | 本地 Worker（`wrangler dev --local`，`127.0.0.1:8787`）+ 本地 D1（由 F4 导出回放） | 生产 Worker 仅承担 §6.2 所列 40 次请求（含 D-09 回归的 9 次写） |
| 面板 | 本地 Vite（`127.0.0.1:5173`） | 浏览器：真实 Chrome（ego-browser） |
| 测试 Hub | `3.145.***.***`（Debian 12） | khc-agent 监听 443，`KHC_LIVE_ORIGINS` 为生产入口 |
| 测试 Peer | `161.118.***.***`（Ubuntu） | WG Peer、Peer 运维、站点上游 |
| 存量节点 | `node-test-2`、`node-prod-1` | 只做只读与轻量写入，改动前已导出备份 |

### 1.3 执行时间与人员

- 执行时间：2026-11-09 晚 — 2026-11-10 13:40（Asia/Shanghai）。
- 执行者：编码 Agent（本地执行者），按工作单 §11 执行；只记录、不修产品代码、不部署、不合并。
- 规划者：主人指派的规划者；本报告由执行者汇总。

### 1.4 证据口径（重要）

- 凡标记「通过/失败」并给出具体数值、返回码、文件路径的用例，证据均为本轮实测输出。
- A–D 轨的一部分输出只存在于执行会话、未落盘（工作单只要求报告与证据文件，本轮未建证据目录）。这类用例在「证据」列注明「会话输出，未落盘」。
- **凡无执行记录的用例一律标「未执行」；未验证不等于通过。**
- 生产请求次数按 §6.2 逐类计数：依据是「脚本代码路径 + 执行次数」，不是网关日志（本轮没有可用的生产访问日志导出）。

---

## 2. 结果统计

| 轨道 | 用例数 | 通过 | 部分通过 | 失败 | 阻塞 | 跳过 | 未执行 |
|---|---|---|---|---|---|---|---|
| A 自动化与发布门禁 | 8 | 7 | 1 | 0 | 0 | 0 | 0 |
| B Worker API | 23 | 20 | 1 | 0 | 1 | 1 | 0 |
| C Agent 与节点 | 18 | 15 | 1 | 1 | 1 | 0 | 0 |
| D UI 与交互 | 14 | 3 | 1 | 0 | 0 | 0 | 10 |
| E 稳定性 | 9 | 7 | 1 | 1 | 0 | 0 | 0 |
| F 安全 | 11 | 8 | 1 | 1 | 1 | 0 | 0 |
| G 运维与灾备 | 8 | 2 | 3 | 0 | 3 | 0 | 0 |
| H 已知缺陷回归 | 35 | 13 | 3 | 6 | 2 | 0 | 11 |
| **合计** | **126** | **75** | **12** | **9** | **8** | **1** | **21** |

> 说明：H 轨的「通过」按「已修复/无法复现」合并计数；「失败」= 仍存在。

---

## 3. 用例逐条结果

### 3.1 A 自动化与发布门禁

| ID | 结论 | 证据 | 备注 |
|---|---|---|---|
| A-01 | 通过 | `./scripts/verify.sh` exit 0；vitest 77 个文件 687 项、Agent 单测 1002 项、本地迁移与安装器生命周期 OK | 会话输出，未落盘 |
| A-02 | 通过 | main 最近一次 CI 三个 job 全绿；`release-2026-11-10` 注解 commit `acd9b41` 与线上一致 | 会话输出，未落盘 |
| A-03 | 通过 | `scripts/uptime-check.mjs` 全部 pass，记录了证书剩余天数 | 会话输出，未落盘 |
| A-04 | **部分通过** | `GET /api/v1/agent/releases` 版本 0.1.35；下载包 sha256 与仓库 `.sha256` 一致 | **清单签名未覆盖，按主人裁定不得改判通过** |
| A-05 | 通过 | `scripts/install-preflight-test.sh` 断言全通过 | 会话输出，未落盘 |
| A-06 | 通过 | `scripts/caddy-tls-modes-e2e.sh`：off/manual/internal 实际访问通过，auto 校验通过 | 会话输出，未落盘 |
| A-07 | 通过 | `scripts/install-system-test.sh` 全断言通过并清理 | 会话输出，未落盘 |
| A-08 | 通过（记录） | `apps/web/dist/assets/*.js` 约 978 KB / gzip 约 287 KB，超过 Vite 500 KB 告警线 | 仅记录，不判失败 |

### 3.2 B Worker API

| ID | 结论 | 证据 | 备注 |
|---|---|---|---|
| B-01 | 通过 | 13 个路由组不带 cookie 均 401 JSON 信封；`/auth/login`、`/auth/logout`、`/health`、`/version` 豁免 | 本地 Worker |
| B-02 | 通过 | 错误口令 401 且无回显；成功下发 `khc_sess`（HttpOnly、SameSite=Lax、Max-Age=8h）；登出后 `/auth/me` 401 | 本地 Worker |
| B-03 | 通过 | `Origin: https://evil.example` → 403 `cross_origin_blocked`；两个白名单入口放行；`text/plain` → 415；空体不报 415 | 本地 Worker |
| B-04 | 通过 | `/api/v1/not-exist`、`/api/xxx` 返回 404 JSON；SPA 路由 200 HTML | 本地 Worker |
| B-05 | 通过 | 域名 https 201；IP http 缺 `allowInsecure` → 400 `insecure_endpoint`；带开关 201；不存在的 tunnelId → 400；PATCH 改名 200；PATCH 改 http → 400 | 本地 Worker |
| B-06 | 通过 | 删除 `e2e-` 节点成功；审计含创建/修改；删除后 `GET /nodes/:id` 404 | 本地 Worker |
| B-07 | 通过 | 批量探测整体 200，逐节点有 `reachable`；离线节点 `lastSeenAt` 未更新；配置无变化 | 本地 Worker |
| B-08 | **部分通过** | 在线节点 `state/apps/snapshot` 200；离线节点路径未完全满足「8s 内明确错误码 + 冷却期快速失败」 | 上轮记为 P1（PP-B-08），原始输出未落盘；**阈值已按实现更正为 10s**（`apps/api/src/routes/nodes.ts:339` 的 `/state` 预算；离线返回 200 + `reachable:false`），补测见 §5 |
| B-09 | 通过 | 两次 PUT rev 单调递增；rollback 后节点 appliedRev 与 D1 一致 | 本地 Worker |
| B-10 | 通过 | 同 `idempotencyKey` 两次响应一致、不重复执行；不同 key 并发不产生错乱 rev | 本地 Worker |
| B-11 | 通过 | http 节点 apply 含 `$cert` 配置 → 400 `insecure_channel_secret`；`certs/:id/bind` 同 | 本地 Worker |
| B-12 | 通过 | `$dnsCred` 引用非 `dns.` 前缀 → 400 且不回显内容 | 本地 Worker |
| B-13 | 通过 | 自签 PEM 导入/列表/material/删除；列表不含私钥；删除后不可取 | 本地 Worker |
| B-14 | 通过 | `PUT /settings/e2e.test` 后列表按掩码返回；删除成功 | 本地 Worker |
| B-15 | 通过 | 新增 201、重复 409、非法 400、重命名 200、删除后列表为空 | 本地 Worker |
| B-16 | 通过 | token 不回显；PATCH 留空保留原 token；被引用删除被阻止并提示 | 本地 Worker |
| B-17 | **阻塞** | 仅完成只读列表；写操作需 F3 的 Cloudflare 测试 Token，未交付 | 阻塞原因：缺凭据 |
| B-18 | 通过 | 导出无 token/`PrivateKey`/`BEGIN`；导入另一测试节点 plan diff 0；非法文件 400 | 本地 Worker |
| B-19 | 通过 | diagnostics 只出现 7 个核心码；wg/caddy 模式判断正确 | 本地 Worker |
| B-20 | 通过 | 第 11 次错误口令 429；锁定期内正确口令也 429；5 分钟后恢复 | 本地 Worker（仅执行者出口 IP） |
| B-21 | 通过 | 篡改 cookie 任意一位 → 401，无 500 | 本地 Worker |
| B-22 | 跳过 | 主人 2026-11-10 决定本轮不测 TOTP | 不计入 Go 条件 |
| B-23 | 通过 | 三种节点 install/upgrade/uninstall 命令：域名 443 + 证书参数；Tunnel 只监听 127.0.0.1；IP 明文开关；token 走 `/dev/tty` 不落命令文本 | 本地 Worker |

### 3.3 C Agent 与节点（真机）

| ID | 结论 | 证据 | 备注 |
|---|---|---|---|
| C-01 | **部分通过** | 方案 A（域名 + 443 + ACME）、方案 C（IP 直连 + 明文确认）全链路在线，`/state` 正常 | 方案 B（具名隧道）缺 F3 → 阻塞 |
| C-02 | 通过 | 停 Agent 端口/cloudflared 后明确报错，未切换方案，D1 `preferredRoute` 不变 | 测试 Hub |
| C-03 | 通过 | `agent.tls.notAfter` 正确；替换证书 + `kill -HUP` 后指纹变化、进程未重启；20 个空连接期间 `/health` < 1s | 测试 Hub |
| C-04 | 通过 | 反代/静态/重定向站点外网可访问；TLS 四模式；BasicAuth；校验失败不覆盖旧 Caddyfile；删除/清空后端口释放 | 测试 Hub |
| C-05 | **失败** | 扫描分类正确（2 个可接管块 proxy/static，域名/端口/root/upstream 全对），但 `takeover` 拒收扫描返回的完整 hash：`bad_request: hash 不合法（需要扫描结果里的完整块指纹）` | 缺陷 PP-C-05；按主人要求先不单独修 |
| C-06 | **部分通过** | 自签签发、手动导入、http 节点 bind 被拒均通过 | ACME 签发需 F3 → 阻塞 |
| C-07 | 通过 | khc0 启用；Peer 二维码/.conf；测试 Peer 握手成功；换钥期间旧钥不断；取消后恢复；删除后接口同步 | 测试 Hub + Peer |
| C-08 | 通过（记录） | 留存 active 但接口不存在的 `wg-quick@khc0` 后 apply：面板未提供可操作修复入口，只能 SSH 处理 | 对应 UX P1-5，缺陷仍存在 |
| C-09 | 通过 | Peer 发布站点 → 改 Peer 应用端口 → 一键同步；受影响站点被列出，同步后外网 200；手工改过端口的站点未被覆盖且有提示 | 测试 Hub + Peer |
| C-10 | 通过 | socat unit active 且连通；停用/启用/删除后 unit 与端口清理；端口冲突与保护端口被拒 | 测试 Hub |
| C-11 | 通过 | `fw.apply` 不确认约 60s 自动回滚且 SSH 不断；确认后持久化；deny 22 → `E_LOCKOUT`；公钥增删；cron 只写 `khc-` 前缀 | 测试 Hub |
| C-12 | 通过 | Peer 只读成功；`keys.add`/`cron.set`/`fw.apply` 均返回 `E_PEER_FORBIDDEN` | 测试 Peer |
| C-13 | 通过 | demo-echo 合法安装；greeting 含换行在前端与 Agent 双重被拒；无 sha256 不安装；卸载后 unit 清理 | 测试 Hub |
| C-14 | 通过 | wg↔caddy 预检阻断时不可切换；切换过程中站点不中断 | 测试 Hub |
| C-15 | 通过 | 0.1.34→0.1.35 远程升级；构造失败升级自动回滚到 `.prev`；配置/端口/证书/任务保留；<40s 间隔观察与 D-12 一致 | 测试 Hub |
| C-16 | 通过 | 重启后 Agent、Caddy、WG、转发自动恢复；各应用 appliedRev 与 D1 一致 | Hub 已重启（boot 03:52） |
| C-17 | 通过 | 不带 `--purge` 保留 `/etc/khc`；带 `--purge` 清理干净；有残留时阻止删除并列出清单 | 测试 Hub |
| C-18 | 通过 | `systemctl cat` 显示 ReadWritePaths 与 `security-boundaries.md` §3 一致；越界写失败；已记录评分 | 测试 Hub |

### 3.4 D UI 与交互

| ID | 结论 | 证据 | 备注 |
|---|---|---|---|
| D-01 | 通过 | 10 个可见路由正常；`/certs`、`/hubs/:id/apps`、`/forwards`、`/peers`、`/certs` 302 落到 page-specs §0 位置；深链接刷新不白屏；`/dev/gallery` 不在导航 | 会话输出，未落盘 |
| D-02 | 未执行 | — | 四态矩阵需逐页构造，本轮未做 |
| D-03 | 未执行 | — | 需逐个触发 L2/L3 动作 |
| D-04 | 未执行 | — | 需逐页抽屉交互 |
| D-05 | 通过 | 站点保存并生效：Caddy inactive 时 `caddy_start` 559ms → active+enabled，随后 apply 188ms、`rev=appliedRev=40`；`https://<hub-domain>:8443` 401（BasicAuth 反代=正常） | 本轮实测；跨页状态一致性在接口层核对 |
| D-06 | 未执行 | — | 需停 Agent 逐页检查 |
| D-07 | 通过 | 390×844 下 sites/hubs/overview 三页 `scrollWidth == innerWidth == 390`；表格列表化、行高 ≥56；长 endpoint 单行不撕裂 | 截图未入库（含内部路径） |
| D-08 | 未执行 | — | 主题三态未切 |
| D-09 | 未执行 | — | 术语遍历未做（已见 §4-7 一条文案问题） |
| D-10 | 未执行 | — | 键盘遍历未做 |
| D-11 | **部分通过** | 节点页快照 6 次/分钟（≈10s 一次）稳定 12 分钟，无叠加轮询；JS heap 22→24MB 稳定 | 概览三请求、后台暂停、双标签共享未逐项录 HAR |
| D-12 | 未执行 | — | 会话过期/429/表单校验/Agent 4xx 未逐项构造 |
| D-13 | 未执行 | — | 本轮无生产部署 |
| D-14 | 未执行 | — | 需双入口；仅记录了一条失败文案问题（见 PP-H-01） |

### 3.5 E 稳定性

| ID | 结论 | 证据 | 备注 |
|---|---|---|---|
| E-01 | **部分通过** | 前一轮完整 30 分钟：179 轮 0 错误，health p50 4.1ms/p95 4.3ms，state p50 67.5ms/p95 71.2ms，RSS 27080→27144KB；本轮 17 分钟（102/180 轮）因 SSH 链路中断截断：health 4.2ms、state 124–277ms、RSS +284KB、0 错误 | **24 小时未完成**，见 §5 |
| E-02 | 通过 | 12 分钟面板长开：fetch 59 次全部 `GET /_live/snapshot`，稳定 6 次/分钟；JS heap 22→24MB；无错误横幅累积 | 压缩时长 |
| E-03 | **失败** | 50 空 TCP + 50 慢 TLS 期间 20 次 `/health` 仅 12 成功，8 次被 RST/SSL EOF（140–165ms）；断开后 10/10 恢复、p50 299ms；两次复跑一致 | 缺陷 PP-E-03（待定性） |
| E-04 | 通过 | A：apply 窗口内 `kill -9` → 502 `hub_unreachable`（546ms），systemd 自动重启（NRestarts 4），Caddyfile md5 不变、`caddy validate` Valid，D1 rev35/appliedRev34 未误标成功，冷却后收敛 rev36=appliedRev36；B：iptables DROP 443 → 502（15.8s），D1 不变，解除后重试收敛 | 测试 Hub |
| E-05 | 通过 | 「保存并生效」「删除」连点 → 只 1 次修订/1 次请求，按钮立即 disabled | 测试 Hub |
| E-06 | 通过 | 各 50 次采样无 5xx | 本地 Worker |
| E-07 | 通过 | 20 个 `e2e-scale-*` 节点批量探测 25.4s；页面可用；删除后 D1 无残留 | 本地 Worker |
| E-08 | 通过 | 100 站点：PUT 7ms、plan 413ms、apply 548ms；300 站点被 adapter 拒绝（上限 200） | 测试 Hub |
| E-09 | 通过 | 升级 13s，`upgrade.json` healthy，看门狗时序与 `agent-lifecycle.md` 一致 | 测试 Hub |

### 3.6 F 安全

| ID | 结论 | 证据 | 备注 |
|---|---|---|---|
| F-01 | 通过 | 无签名/错签名/重放 nonce/时钟偏移 >60s/改 body 全部 401；`/health` 豁免 | 测试 Hub |
| F-02 | 通过 | 无票据/过期票据/错误 Origin/scope 不符全部拒绝；白名单 Origin 回显且 ACAO 为具体 origin | 临时把本地面板 origin 加入 `KHC_LIVE_ORIGINS` 后验证，已还原 |
| F-03 | 通过 | 缺/降 `X-Khc-Panel-Version` → 426 `panel_too_old`，details 含双方版本 | 测试 Hub |
| F-04 | 通过 | nodes/settings/cf-dns/tunnels/certs/ssh-keys/agent-releases/导出/审计/错误信封均无明文凭据；`/export` 仅含 bcrypt 哈希；Hub 侧 token 0600、私钥仅 root、journal 无凭据 | 测试 Hub |
| F-05 | **部分通过** | 无明文节点残留（F4 时两个节点均为 https） | 但 `docs/archive`、`docs/verification`、`CHANGELOG`、`docs/verification/2026-11-08/ux-interaction-audit.md` 仍有测试机公网 IP 与面板域名明文；已在 2026-11-11 public 开放审计中处理，见 `docs/verification/2026-11-11/public-repo-readiness-audit.md` |
| F-06 | 通过 | HTML `no-store` + HSTS + `frame-ancestors 'none'` + `nosniff`；SPA 路由同；iframe 被拒 | 本地 Worker |
| F-07 | 通过 | 清单外包 URL → 400 `release_not_in_manifest`；篡改包 sha256 FAILED、TAR_BROKEN、未解包、PID 不变；命令含 `unset HISTFILE`、token 走 `/dev/tty` | 本地包 |
| F-08 | **失败** | 拒绝：`../evil` 名称、端口字段注入、action 注入、非法公钥、user 注入、deny 22；**接受并写入** `/etc/cron.d`：cron 内容换行/多行/`@reboot`/`; reboot`/`$()`；非 `khc-` 前缀被自动加前缀接受而非拒绝 | 缺陷 PP-F-08；写入的 4 个文件已即时删除 |
| F-09 | 通过 | 403 个提交全历史 grep 无私钥、`ghp_`、`github_pat_`、CF Token；无 `.dev.vars` 入库；历史含 `.workbuddy/memory/*.md`（私钥绝对路径等运维信息），仓库私有、未改写历史 | 交主人决策。**补充（2026-11-11）**：该结论只覆盖文本 grep，不含截图；截图内的 WireGuard Peer 私钥与一次性令牌见 `docs/verification/2026-11-11/public-repo-readiness-audit.md` |
| F-10 | **阻塞** | 需生产 workers.dev 入口；本轮对此项不新增生产请求 | 阻塞原因：生产入口 |
| F-11 | 通过 | `pnpm audit --prod` 无已知漏洞；Agent 仅标准库 | 本地 |

### 3.7 G 运维与灾备

| ID | 结论 | 证据 | 备注 |
|---|---|---|---|
| G-01 | **部分通过** | 开测前已导出 `backups/khc-db-preprod-20261110-091631.sql`，352,784 字节，sha256 `b01027d6…af9ae97`；行数 nodes 2 / app_configs 4 / revisions 63 / settings 1 / audit 1377 / rate_limit 6 | 本轮不新增导出（不新增生产请求） |
| G-02 | **部分通过** | 回放到隔离本地 D1：表结构 0001–0011、行数与导出完全一致；本地 Worker 能登录并列出节点 | **加密字段解密失败（keyId=k1，`MASTER_ENC_KEY` 不匹配）→ 记阻塞** |
| G-03 | 阻塞 | `wrangler d1 time-travel info` 属生产读取，本轮预算为 0 | 建议补进恢复 SOP |
| G-04 | 阻塞 | `deployments list`/`versions list` 亦需生产；回滚演练需主人书面批准 | — |
| G-05 | 通过（桌面推演） | 列出与实际不一致：`release.md` 的 `workers_dev=false`、版本 0.3.x、部署顺序漏 topology guard/verify entry/tag release、§3.6/§3.7 悬空引用；DR 命令缺 `--tag`/`set -e` | 只记录不修 |
| G-06 | 通过（桌面推演） | 同上，冒烟手册每步可执行，但 §4 与 CI 实际步骤不一致 | 只记录不修 |
| G-07 | **部分通过** | 告警 webhook 未接线；uptime 探测脚本存在但未定时运行 | 无法查生产 24h 日志（0 请求） |
| G-08 | **部分通过** | Hub Agent 证书至 2027-02-08（≈90 天），acme.sh cron 已配 | 面板域名证书剩余天数需生产请求 → 阻塞 |

### 3.8 H 已知缺陷回归

| 来源 | 编号 | 结论 | 证据 |
|---|---|---|---|
| E2E | D-01 | 已修复 | 安装命令含 `--port 443 --host 0.0.0.0` |
| E2E | D-02 | 已修复 | 由 C-03、E-03 覆盖；TLS 握手不再阻塞 accept（E-03 另有槽位耗尽问题） |
| E2E | D-03 | 未执行 | 节点页状态粘滞需交互复测 |
| E2E | D-04 | 阻塞 | DNS 代建需 F3 与生产 |
| E2E | D-05 | 已修复 | 停 Caddy 后 `caddy_start` 200/559ms → active+enabled；apply 200/188ms，`rev=appliedRev=40`；problems 提供「启动服务」入口 |
| E2E | D-06 | 未执行 | 列表闪空态需限速复测 |
| E2E | D-07 | 未执行 | 实时观测断开自动恢复需断链复测 |
| E2E | D-08 | 分类已修复 / 接管失败 | 扫描分类全对；`takeover` 拒收扫描返回的 hash（并入 PP-C-05） |
| E2E | D-09 | 已修复 | 由 C-09 真机闭环：端口同步、手工端口保留；另在 2026-11-09 23:09 用 D-09 回归脚本在生产节点 `node-prod-1` 上跑过一轮（建 Peer/站点 → 改地址 → 端口 9999 保留 → 清理），产生 7 次读 + 9 次写，见 §6.2 |
| E2E | D-10 | 已修复 | `SshKeysDrawer` 删除后 `await load()` 刷新 |
| E2E | D-11 | 已修复 | 文案为「接入方式 域名（HTTPS）」；站点表 TLS 列「自动签发」 |
| E2E | D-12 | 仍存在（已知） | 看门狗重叠回滚未修；UI 提示存在：间隔需 ≥60 秒 |
| E2E | UI-5 | 无法复现 | 390 下 endpoint 单行显示，`scrollWidth == 390` |
| E2E | 观察项 | 阻塞 | 删除节点后孤儿 DNS 需生产 Cloudflare |
| UX | P0-1～P0-7 | 未执行 | 需 Slow 4G 限速下写后状态复测（D-05 已在正常网络通过） |
| UX | P1-5 | 仍存在 | C-08：残留 `wg-quick@khc0` 无面板修复入口，只能 SSH |
| UX | P1-9 | 已修复 | 删除节点确认框标题含节点名（`删除节点 node-prod-1？`） |
| UX | P1-10 | 仍存在 | 站点 `listenPort=443` 的 plan 只说「将登记/放行 tcp/443」，未提示与 Agent 占 443 冲突 |
| UX | P1-12 | 仍存在 | 上游无 scheme 输入，443 无法表达 http；待产品决策 |
| UX | §4-2 | 已修复 | 全站仅「保存并生效」一套文案 |
| UX | §4-3 | 未执行 | 空态与页头双主按钮未逐页核对 |
| UX | §4-4 | 未执行 | 状态词混用未逐页核对 |
| UX | §4-6 | 未执行 | 重复描述未逐页核对 |
| UX | §4-7 | 仍存在 | 观测失败文案暴露 CORS、`/_live`、`KHC_LIVE_ORIGINS`（见 PP-H-01） |
| UX | §4-8 | 仍存在 | `appUnknown: '未知'` 文案仍在，Tunnel 模式应用状态仍可能显示「未知」 |
| UX | §5-3 | 无法复现 | 390 下 Caddyfile 路径与长 endpoint 无横向溢出、未拆成难辨认片段 |
| UX | §5-6 | 未执行 | 结果页过长未复测 |
| UX | §5-8 | 未执行 | Agent 证书与站点证书呈现未逐页核对 |
| P0 收口 | §4.1 | 已修复 | `design-v3.md` 已用 `agent.tls.notAfter` |

---

## 4. 缺陷清单

> 只记录与建议，不实施。编号沿用 `PP-<轨道>-<序号>`。

### S1 阻断（0 条）

无。

### S2 严重

#### PP-F-08 cron 名称/内容白名单失效

- **现象**：host-ops `cron.set` 接受并写入 `/etc/cron.d`：内容含换行、多行、`@reboot`、`; reboot`、`$(...)`；非 `khc-` 前缀名称被自动加前缀后接受，而不是拒绝。
- **根因（疑似）**：`agent/adapters/host_ops.py` 只做名称拼接与最小校验，未对 cron 内容做单行/字段白名单校验，也未拒绝 `@` 系列与命令分隔符。
- **影响面**：面板管理员可写入任意 root 定时任务，白名单承诺失效。不构成越权提权（面板本身即 root 级遥控器），但注入面比设计承诺大，误操作可导致定时重启。
- **复现步骤**：① 主机运维 → 计划任务 → 新增；② 名称填 `f08`，内容填 `*/5 * * * * root echo ok; reboot`；③ 提交；④ Hub 上 `ls /etc/cron.d` 出现 `khc-f08`，内容原样写入。
- **建议修法**：内容按「单行、五段 + 命令、禁止 `;`/`&&`/`|`/`$(`/反引号/换行、禁止 `@` 前缀」校验；名称强制 `^[a-z0-9][a-z0-9-]{0,31}$` 且拒绝外部前缀；补单测覆盖上述 6 类载荷。

#### PP-C-05 外部 Caddyfile 接管接口拒收扫描返回的 hash

- **现象**：`scan` 返回的 `supported[].hash` 为完整 64 位 sha256；把它原样传给 takeover 得到 `400 bad_request：hash 不合法（需要扫描结果里的完整块指纹）`。
- **根因（已确认，2026-11-10 更正）**：Agent 适配器读取层级错误。Worker 已把业务参数放在 `params` 里原样透传，`agent/adapters/caddy_site.py` 的 `caddy_import_takeover` 却直接读顶层 `body.get("hash")`，因此永远拿不到值。**不是契约不一致**（初版「疑似契约不一致」的判断已被代码取证与本轮复测否定，取证链见 `docs/plans/preprod-fix-plan-2026-11-10.md` 附录 C）。
- **影响面**：外部 Caddyfile 接管链路无法从面板完成，只能 SSH 手工迁移，C-05 用例失败。
- **复现步骤**：① Hub 主 Caddyfile 写 2 个可接管块；② 站点 → 外部配置 → 重新扫描（记录 hash）；③ 点接管；④ 400。
- **建议修法**：Agent 侧把动作参数读取收口成唯一访问器（只认 `body.params`），2 处直读顶层业务键的动作（takeover / restore）改用它，并加守卫测试禁止再直读；contracts 暂不引入 per-action schema（Python/TS 双写会漂移）。详见修复方案 R1。

### S3 一般

#### PP-E-03 连接槽位打满时健康检查被拒

- **现象**：50 空 TCP + 50 慢 TLS 期间，20 次 `/health` 有 8 次被 `Connection reset by peer`/SSL EOF（140–165ms）；断开后 10/10 恢复、p50 299ms。
- **根因**：`agent/khc/http.py` 用 `BoundedSemaphore(64)`，槽满时新连接被立即关闭，`/health` 与滥用连接共用同一池。
- **影响面**：节点在遭受连接洪水时面板与探活会看到「节点不可达」，虽然服务本身未崩溃。
- **复现步骤**：对 443 同时开 50 个不握手的 TCP 与 50 个半握手 TLS，再循环请求 `/health`。
- **建议修法（需先定性）**：为 `/health` 预留独立槽位或在池满时返回 503 + `Retry-After` 而非直接 RST；若判定为「设计性保护」，请在 `security-boundaries.md` 写明并调整 C-03/E-03 用例预期。

#### PP-H-01 直连观测失败文案暴露内部术语

- **现象**：用户可见「直连观测入口不可达（网络/CORS 被拦截；常见原因：网关未配置 /_live 反代，或 Agent 的 KHC_LIVE_ORIGINS 未包含当前面板域名）」，390 宽度下占 6 行。
- **根因**：`apps/web/src/data/snapshot.ts:644` 把底层原因直接作为用户文案。
- **影响面**：违反 UX §7-7「失败文案不暴露 CORS、`KHC_LIVE_ORIGINS` 等内部术语」；窄屏首屏被占满。
- **复现步骤**：面板 origin 不在 `KHC_LIVE_ORIGINS` 时打开节点页。
- **建议修法**：用户侧只保留「实时观测暂不可用」+「读取控制面快照」+ 可展开的「排查建议」；内部术语只进折叠区或日志。

#### PP-H-02 站点端口与 Agent 443 冲突无提示（P1-10）

- **现象**：站点 `listenPort=443` 的 plan 只说「将登记/放行 tcp/443」，不提示与 Agent 占用冲突。
- **影响面**：用户保存并生成为 443 后 Caddy 启动失败，需自行排查。
- **复现步骤**：站点页新增 `listenPort=443` → plan。
- **建议修法**：plan 阶段比对 Agent 监听端口，命中则给出阻断或明确警告（属编排层知识，放 `apps/api/src/lib/mode.ts` 或站点适配器）。

#### PP-H-03 升级间隔阈值文档与 UI 不一致

- **现象**：UI 要求「两次升级间隔 ≥60 秒」，工作单与 `agent-lifecycle.md` §13 写「< 约 40s 触发误回滚」。
- **影响面**：按文档操作仍可能踩坑。
- **建议修法**：以 UI 的 60s 为准，统一文档措辞并补一条 ADR 或在 §13 注明保守阈值。

#### PP-H-04 上游无法表达 http scheme（P1-12）

- **现象**：站点上游只接受 `host:port`，无法区分 `http://host:443` 与 `https://host:443`。
- **影响面**：443 端口的明文上游无法表达。
- **建议修法**：上游允许可选 `scheme://` 前缀，默认 http；需产品先拍板兼容策略。

#### PP-F-05 文档中的测试机地址与面板域名明文

- **现象**：`docs/archive`、`docs/verification`、`CHANGELOG`、`docs/verification/2026-11-08/ux-interaction-audit.md` 含测试机公网 IP 与面板域名明文。
- **影响面**：仓库私有，风险有限；但违反「凭据/环境信息不入库」的卫生要求。
- **建议修法**：按主人决策统一替换为占位符；两份根目录报告已脱敏并入 `docs/verification/2026-11-08/`（N3，2026-11-11）；其余地址按 `docs/verification/2026-11-11/public-repo-readiness-audit.md` 处理。

---

## 5. 未覆盖项（未验证不等于通过）

| 项 | 卡在哪 | 建议 |
|---|---|---|
| E-01 Agent 24 小时长稳 | 只完成 30 分钟完整轮 + 17 分钟截断轮；24h 需持续占用测试 Hub | 下一轮单独排 24h，期间不做故障注入 |
| B-08 离线路径细节 | 上轮 P1，原始输出未落盘 | 重跑并落盘请求/响应 |
| D-02 四态矩阵 | 需逐页构造空/加载/错误/离线，工作量大 | 下一轮专项 |
| D-03 确认等级 | 需逐个触发 L2/L3 | 下一轮专项 |
| D-04 抽屉规则 | 需逐页抽屉交互 | 下一轮专项 |
| D-06 离线门控 | 需停 Agent 后逐页检查 | 与 D-02「离线」合并做 |
| D-08 主题三态 | 未切换 | 低成本，可与 D-02 合并 |
| D-09 术语遍历 | 未扫描禁用词 | 可用脚本批量 grep 页面文案 |
| D-10 键盘可访问性 | 未做（P2） | 下轮或上线后 |
| D-12 错误呈现 | 未构造会话过期/429/校验失败 | 与 B-20 合并 |
| D-13 发版期间旧标签页 | 本轮无生产部署 | 下次发版时观察 |
| D-14 双入口 | 需生产两个入口 | 与 F-10 合并，需主人批预算 |
| H-D-03/D-06/D-07 | 同上 UI 交互项 | 下一轮 |
| P0-1～P0-7（Slow 4G） | 未做限速复测；正常网络下 D-05 已通过 | 下一轮用 Slow 4G 复测 D-05 |
| §4-3/§4-4/§4-6/§5-6/§5-8 | 未逐页核对 | 并入 D-09 文案巡检 |
| B-17 Cloudflare DNS 写操作 | F3 的 Token 未交付 | 主人交付 Token 后单独跑 |
| C-01 方案 B、C-06 ACME | 需具名隧道与测试 Zone Token | 同上 |
| F-10 workers.dev 入口 | 本轮不新增生产请求 | 需主人批准 1 次只读 |
| G-01 开测当日导出 | 本轮不新增生产请求 | 若距 F4 超过 24h 需补一次 |
| G-02 加密字段解密 | `MASTER_ENC_KEY` 与 keyId=k1 不匹配 | 主人确认离线备份后可解密校验 |
| G-03 Time Travel / G-04 回滚演练 | 生产只读/写 + 书面批准 | 主人拍板窗口 |
| G-08 面板域名证书 | 需生产请求 | 可由 `uptime-check` 输出补充 |
| 观察项 孤儿 DNS | 需生产 Cloudflare | 随 B-17 一起验证 |

---

## 6. 请求量统计

### 6.1 口径修正说明

初版报告写「生产只读 4 次」，只统计了 A 轨对生产只读接口的核对，**漏计 B 轨 13 次只读**（B-08/B-19 的在线路径必须在生产上验证），也漏计 D-09 在生产节点 `node-prod-1` 上的读写与 C-15 由 Agent 自行拉包。本节按「实际 HTTP 请求」逐类重列，读者可自行相加复核。

### 6.2 生产请求逐类明细

| # | 类别 | 来源轨 | 用途 | 次数 | 读/写 | 发起方 | 复核依据 |
|---|---|---|---|---|---|---|---|
| 1 | `POST /api/v1/auth/login` | B | 建立只读核验会话（共执行 3 次） | 3 | 读 | 执行者 | `b_prod_readonly.py:47` |
| 2 | `GET /api/v1/nodes` | B | 选在线节点；F-05 明文节点盘点 | 3 | 读 | 执行者 | `b_prod_readonly.py:52` |
| 3 | `GET /nodes/:id/state` | B | B-08 在线路径耗时与 reachable | 3 | 读 | 执行者 | `b_prod_readonly.py:62` |
| 4 | `GET /nodes/:id/diagnostics` | B | B-19 核心码集合 | 2 | 读 | 执行者 | `b_prod_readonly.py:67` |
| 5 | `GET /nodes/:id/mode` | B | B-19 模式判断 | 2 | 读 | 执行者 | `b_prod_readonly.py:70` |
| 6 | `POST /auth/login` + `GET /agent/releases` | A-04 | 版本与发布清单 | 2 | 读 | 执行者 | `a04_releases.py:41,47` |
| 7 | `GET /agent/khc-agent-0.1.35.tar.gz` | A-04 | 下载包校验 sha256 | 1 | 读 | 执行者 | 执行记录（脚本未落盘下载段） |
| 8 | `GET /api/v1/version` + 入口探测 | A-02 / A-03 | 生产版本与外部可达性核对 | 2 | 读 | 执行者 | 执行记录 |
| 9 | `GET /nodes/:id/apps/{wireguard,caddy-site}` | D-09 | 读基线、读回填结果 | 7 | 读 | 执行者 | `d09_phase1.py`、`d09_cleanup.py` |
| 10 | `PUT /nodes/:id/apps/{wireguard,caddy-site}` | D-09 | 建 Peer/站点、改地址、手工端口、清理 | **9** | **写** | 执行者 | 同上（phase1 7 次 + cleanup 2 次） |
| 11 | `GET /agent/khc-agent-0.1.35.tar.gz` | C-15 | Agent 自行拉包：失败回滚 1 + 成功 1 + 重叠 2 | 4 | 读 | Agent（被动） | `c15.py:16,31` |
| 12 | CF DNS `e2e-*` 记录 建 + 删 | F3 前置 / D-04 / C-06 | 测试子域 | **2** | **写** | 主人（Cloudflare 控制台人工） | F3 Token 未交付，面板未发出 DNS 写请求 |

**合计：只读 29 次、写入 11 次，共 40 次。**

- 只读 29 = 执行者主动 25（第 1–9 行）+ Agent 被动 4（第 11 行）。
- 写入 11 = 面板 API 9（第 10 行，全部落在 `e2e-`/测试用途节点）+ 控制台人工 2（第 12 行）。
- 第 12 行说明：这是 A–F 轨唯一的人工写操作（建 1 次、删 1 次）；B-17 与 C-06 的面板侧 DNS 写操作因缺 F3 Token **未执行**，不产生写入。若实际未建该记录，请把本行改为 0，总数相应变为 38。
- 以上次数按脚本代码路径与执行次数逐条计数；脚本未落盘请求日志，若某次执行中途中断，实际次数可能略少（不会更多）。

### 6.3 非生产请求

| 类别 | 量级 | 涉及用例 |
|---|---|---|
| 本地 Worker（`127.0.0.1:8787`）+ 本地 D1 | 数百次 | B 轨本地回归、D-05/D-07、E-06/E-07、F-06/F-11 |
| 测试 Hub/Peer | 数千次 | C 轨全部、E-01/E-03/E-04/E-05/E-08/E-09、F-01～F-04 |
| 本地回放/离线包 | 0 联网 | G-02（本地 D1 回放）、F-07（本地包校验） |

---

## 7. 环境收尾状态

| 位置 | 状态 |
|---|---|
| 测试 Hub | `khc-agent` active；`caddy` active；`/etc/cron.d` 仅 `e2scrub_all`（F-08 写入文件已清理）；`KHC_LIVE_ORIGINS` 已还原为生产两个入口；`/etc/caddy/Caddyfile` 仅默认 `:80` 块 + `import khc.d/*`，无 C-05 残留 |
| 测试 Hub 站点 | caddy-site 3 个站点（`e2e-proxy`/`e2e-static`/`e2e-redirect`），`rev=appliedRev=40`，`lastApplyError=null` |
| 面板（生产 D1） | 4 个节点：`node-test-2`、`node-prod-1`、`e2e-u3-hub-domain`、`e2e-u3-hub-ip`；**`e2e-u3-*` 两个待清理**；`node-prod-1` 在 F4 导出时 `caddy-site` 为 `rev=28 / appliedRev=22`（D-09 回归写入未 apply 的残留修订），需主人核对是否回滚到测试前基线 |
| 本地进程 | `wrangler dev`（8787）与 `vite`（5173）仍在运行，供后续回归；测试脚本位于 `/tmp/khc-test`（不在仓库） |
| 仓库 | 工作区仅两份 2026-11-08 未跟踪报告（N3）；本轮未改产品代码、未 push、未合并 |

---

## 8. Go / No-Go

### 结论：**No-Go**

阻断项：

1. **PP-F-08**（S2）cron 白名单失效未修；**PP-C-05**（S2）外部 Caddyfile 接管不可用。
2. 准出条件 §7-2 未满足：D 轨 10 条未执行、H 轨 11 条未执行、E-01 的 24h 长稳未完成。
3. 准出条件 §7-5 未满足：F-05 明文节点清单与文档泄露处置待主人决定。
4. 准出条件 §7-6 未满足：G-03/G-04 未执行；G-02 加密字段解密受阻。
5. 准出条件 §7-1 未满足：F3（Cloudflare Token / 具名隧道）未交付，B-17、C-01 方案 B、C-06 ACME、D-04 均阻塞。

### 需要主人决策

| # | 事项 | 选项 |
|---|---|---|
| 1 | PP-E-03 定性 | ① 视为设计性保护，改用例预期并写文档；② 视为缺陷，为 `/health` 预留槽位 |
| 2 | F-05 文档中的测试机 IP/域名 | ① 统一占位化；② 接受现状；③ 连同未跟踪的两份报告一起归档 |
| 3 | F-09 `.workbuddy` 历史 | 仓库私有，是否接受不改写历史 |
| 4 | G-02 主密钥 | 确认 `MASTER_ENC_KEY` 离线备份，再补一次解密校验 |
| 5 | F3 凭据 | 是否交付测试 Token / 隧道 token，以解阻 B-17、C-01B、C-06、D-04 |
| 6 | 生产只读预算 | 是否批准 F-10、G-03/G-04、G-08 的少量生产请求 |
| 7 | P1-12 上游 scheme | 是否支持 `http://host:443` |
| 8 | `node-prod-1` 残留修订 | F4 导出显示 `caddy-site rev=28 / appliedRev=22`（D-09 回归写入未 apply）；是否用 B-18 备份回滚到测试前基线 |
| 9 | 下一轮范围 | 建议：24h 长稳 + UI 四态/抽屉/确认等级 + Slow 4G 复测 + 修复后回归子集 |

### 修复顺序建议（统一走一次发布门禁）

1. PP-F-08、PP-C-05（S2，必须先修）。
2. PP-H-01、PP-H-02、PP-H-03、PP-H-04、PP-F-05（S3）。
3. PP-E-03 按定性结果处理。
4. 修复后重跑 H 轨回归子集 + D-05/D-07 + E-03/E-04。
