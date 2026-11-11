# KHC 面板端到端验收报告（2026-11-08）

> 状态：现行（验证记录；2026-11-11 脱敏后由根目录并入） ｜ 适用范围：2026-11-08 端到端验收（三种接入方式、Caddy、WireGuard/Peer、端口转发） ｜ 最后核验：2026-11-08 执行、2026-11-11 脱敏复核 ｜ 关联：`docs/verification/2026-11-08/ux-interaction-audit.md`、`docs/verification/2026-11-10/preprod-test-report.md`、`docs/ui-redesign/ui-guidelines.md`

> 脱敏说明：真实面板域名、公网 IP、机器名与 SSH 用户名已替换为占位符；结论与证据保持原样。原文件仅存在于旧私有库工作区。

## 1. 测试环境

| 角色 | 标识 | 说明 |
| --- | --- | --- |
| 面板 | `https://<panel-domain>` | 生产 Worker + D1（只读观察 + 临时节点） |
| Hub 测试机 | `203.0.113.10`（test-hub，Debian，<ssh-user>） | 临时节点 `e2e-1108-hub` / `e2e-1108-domain` |
| Peer 测试机 | `203.0.113.11`（test-peer，<ssh-user>） | WireGuard Peer `e2e-peer`（10.99.0.2） |
| 生产节点 | `node-test-2`、`node-prod-1` | **未做任何配置变更、未升级** |

接入方式：IP 直连（8880）→ 改 Tunnel → 删除后 HTTPS + 域名（`e2e-dns-probe.example.com`，Agent 443，手动证书）。

## 2. 总览

| 模块 | 结论 |
| --- | --- |
| 1 全局配置（DNS 凭据 / SSH 公钥） | 通过但有瑕疵（DNS 修改/删除受环境限制；SSH 公钥全链路通过） |
| 2 三种接入方式 | 通过（IP、域名）；Tunnel 仅配置层验证，环境限制未验证 |
| 3 Caddy 安装与站点 | 通过但有瑕疵（面板不能启动未运行的服务；外网访问全部核实） |
| 4 WireGuard + Peer 应用发布 | 通过但有瑕疵（改端口后发布侧不自动同步） |
| 5 端口转发 | 通过（经 Hub 8880 登录 Peer 并执行命令） |

## 3. 模块 1：全局配置

### 1.1 Cloudflare 凭据列表 / 查看

- 步骤：设置 → 域名。
- 预期：列出凭据、账号、已启用 Zone 数、Token 状态；Token 不回显。
- 实际：两条既有凭据（`默认（旧单 Zone）`、`example.org`）正常展示，Token 列显示「已配置」；编辑抽屉中 Token 为只读占位「已保存（加密存储，不回显）」。
- 结论：通过。

### 1.2 新增凭据 + Token 校验失败路径

- 步骤：添加凭据 → 名称 `e2e-invalid-token` + 伪造 Token → 「验证并添加」。
- 预期：服务端校验失败，给出明确错误，不落库。
- 实际：抽屉内红色提示「Cloudflare Token 无效或已失效：Invalid access token」；列表未新增记录；Zone 区显示「该 Token 下没有可用 Zone」。
- 结论：通过（错误提示准确、无凭据回显）。

### 1.3 修改 / 删除凭据

- 步骤：尝试对既有凭据改名、取消 Zone、删除。
- 实际：`默认（旧单 Zone）` 为 legacy 单 Zone 凭据，行操作只有「删除凭据」，没有「修改」入口；其余凭据可编辑，但保存/删除都需要有效 Token 对应的真实 Zone 数据。
- 结论：**环境限制未验证**（现场只有生产凭据，按要求不动生产配置；没有可安全使用的第二套有效 Token）。

### 1.4 Zone 解析记录（只读浏览）

- 步骤：编辑凭据 → 勾选 Zone →「查看解析记录」。
- 实际：`example.com` 显示 9 条记录，含类型、Proxy 状态、内容，以及「面板代建」「已绑定节点 xxx」标签；记录编辑/删除按钮存在（本次仅用于清理测试记录，见 §8）。
- 结论：通过。

### 1.5 DNS 代建自动创建（缺陷，P1）

- 步骤：启用「DNS 代建」后，用 IP 直连方式添加节点。
- 预期：自动在 Zone 下创建 A 记录。
- 实际：Cloudflare 无对应记录；`apps/web/src/data/cfDns.ts` 的 `createCfDnsRecordForNode()` 在全仓**没有任何调用点**；`apps/api/src/routes/nodes.ts` 创建节点也不触发 DNS 代建。
- 结论：失败（功能未接线）。测试期间改用浏览器内 `POST /api/v1/cf-dns/records` 手工造记录继续域名模式验证。

### 1.6 SSH 公钥库 CRUD

| 场景 | 预期 | 实际 | 结论 |
| --- | --- | --- | --- |
| 新增 | 指纹服务端计算、公钥/注释入库 | 成功，列表出现指纹 `SHA256:****` | 通过 |
| 重复新增 | 拒绝并提示 | 提示公钥已存在 | 通过 |
| 重命名 | 名称更新 | 成功（`e2e-1108-renamed`） | 通过 |
| 展示 | 名称/指纹/注释/更新时间 | 均展示；快照中单元格为空是 a11y 树未展开嵌套节点，DOM innerText 完整 | 通过 |
| 删除 | 仅从库移除，不影响节点 | 成功，`GET /api/v1/ssh-keys` 返回空数组 | 通过（列表需手动刷新，见 UI-4） |

### 1.7 主机运维「从公钥库选择 → 添加公钥」下发

- 步骤：主机运维 → SSH 公钥 → 从公钥库选择 `e2e-1108-renamed` → 自动填入公钥与备注 → 「添加公钥」。
- 预期：写入节点 `authorized_keys` 的 khc 标记块内。
- 实际（节点侧核对）：

```
/root/.ssh/authorized_keys
# >>> khc managed >>>
ssh-ed25519 AAAA… e2e-1108-renamed
ssh-ed25519 AAAA… wt
# <<< khc managed <<<
```

- 补充：备注（label）会覆盖公钥自带注释写入 authorized_keys；表格「来源」列正确显示「本系统管理」。
- 结论：通过（此前一次误判为"未落盘"，原因是按公钥原注释 `khc-e2e-test` 搜索，实际写入注释被 label 覆盖）。

### 1.8 主机侧移除公钥

- 步骤：行内「更多操作 → 移除公钥」→ 确认。
- 实际：节点侧 `grep` 计数为 0；确认弹窗文案明确「只会删除本系统标记块内的公钥，块外手工公钥不受影响」。
- 结论：通过（列表未自动刷新，见 UI-4）。

## 4. 模块 2：三种接入方式

### 2a IP 直连

| 项 | 内容 |
| --- | --- |
| 步骤 | 添加节点，endpoint `http://203.0.113.10:8880`，按面板命令安装 Agent |
| 预期 | 节点上线，各页状态带正常 |
| 实际 | Agent 8880 监听，面板状态「在线」；`/snapshot` reachable=true |
| 结论 | 通过 |

说明：Cloudflare `fetch()` 对裸 IP 返回 403 error 1003，Worker 侧走 `cloudflare:sockets` 的 `connect()` 才通；这条链路本身工作正常。

### 2b 改为 Tunnel

- 步骤：同一节点在「节点设置 → 修改接入方式」改为 Tunnel 并保存。
- 实际：配置保存成功；由于测试机没有部署 cloudflared 隧道 / Token，面板探测不可达，节点显示离线（符合"改了接入方式但隧道未建立"的预期）。
- 结论：**环境限制未验证**（仅验证配置切换与状态回退，未验证真实隧道连通）。

### 2c 删除后以 HTTPS + 域名重新添加

| 项 | 内容 |
| --- | --- |
| 步骤 | 删除 IP 节点 → 域名方式添加 `e2e-dns-probe.example.com`（A 记录指向测试机）→ 签发证书 → 安装 Agent |
| 预期 | `https://域名` 可访问 Agent，节点上线 |
| 实际 | 手动证书安装到 `/etc/khc-agent/tls`，Agent 以 `--port 443` 启动后上线 |
| 结论 | 通过（有 P1 缺陷，见 D-01） |

三种方式差异与浏览器侧限制：

- 面板 → 节点由 Worker 发起（`fetch` / `cloudflare:sockets`），**不经过浏览器**，因此无 mixed content / CORS 问题。
- 浏览器直接访问 `http://IP:8880` 属于明文端口；若嵌在 https 页面里会被 mixed content 拦截（本次未构造该场景）。
- 域名方式依赖 Cloudflare 代理端口（443/8443/2053/2083 等）；裸 IP 只能走 sockets。
- 域名 + 自定义端口要求 `compatibility_date >= 2024-09-02`（仓库已在 AGENTS.md 记录）。

## 5. 模块 3：Caddy

| 步骤 | 预期 | 实际 | 结论 |
| --- | --- | --- | --- |
| 面板安装/启用 Caddy | 安装后可启动服务 | 安装成功，但面板只有「重载 Caddy」；服务 inactive 时重载失败，需 SSH `systemctl start caddy` | 通过但有瑕疵（D-05） |
| 添加站点 2083 → `127.0.0.1:9001` | 外网可访问 | `http://203.0.113.10:2083` 返回 200 | 通过 |
| 添加站点 2053 → `10.99.0.2:80` | 经 WireGuard 到 Peer 应用 A | 外网 200 | 通过 |
| 添加站点 8443 → `10.99.0.2:3000` | 到 Peer 应用 B | 外网返回 `peer app B :3000` | 通过 |
| 添加站点 8083 → `127.0.0.1:9009` | 上游不存在时应报错 | 外网上游不可达（测试残留错误上游） | 记录了问题，但该端口为测试误配，不计产品缺陷 |
| 修改站点监听端口并保存 | 新端口生效、旧端口停用 | 「保存并生效」成功，Caddy 重载后按新端口提供服务 | 通过 |

说明：站点配置写入 `/etc/caddy/khc.d/caddy-site.caddy`，由主 Caddyfile `import khc.d/*` 引入；面板用外部配置解析时把 `:80` 根目录块误判为「反代/自动签发」（D-08，UI 层解析缺陷）。

## 6. 模块 4：WireGuard 与 Peer 应用发布

| 步骤 | 预期 | 实际 | 结论 |
| --- | --- | --- | --- |
| 面板安装 WireGuard | 安装后 `khc0` 可启动 | 成功；`khc0` = 10.99.0.1/24，监听 51820 | 通过 |
| 新建 Peer | 生成配置、可导出 | Peer 10.99.0.2，配置导出成功 | 通过 |
| Peer 侧导入并连接 | 握手成功 | `wg show` 显示 latest handshake，双向流量正常 | 通过 |
| Peer 上跑应用 A(:80)/B(:3000) | 可从 Hub 访问 | Hub 侧 curl 正常 | 通过 |
| 在 Hub 发布 Peer 应用 | 生成站点，外网可访问 | 2053/8443 外网访问成功（见模块 3） | 通过 |
| 修改 Peer 应用端口 | 发布侧自动同步 | 发布侧**不自动同步**上游端口，需要手工改站点上游 | 通过但有瑕疵（D-09） |

环境限制：Peer 的 iptables 只允许 22/443/80/3000，8080 被 REJECT（`EHOSTUNREACH`），因此 8443 站点改用 3000；该现象为测试机安全策略，不是产品缺陷。

## 7. 模块 5：端口转发

| 步骤 | 预期 | 实际 | 结论 |
| --- | --- | --- | --- |
| 添加转发：Hub 8880 → `10.99.0.2:22` | 生成 socat systemd 单元 | `khc-forward-e2e-peer-ssh.service` 运行中 | 通过 |
| 经 Hub 建立 SSH | 能登录 Peer | `ssh -p 8880 <ssh-user>@203.0.113.10` 成功 | 通过 |
| 执行命令 | 返回真实输出 | `hostname; whoami` → 输出 `FORWARD_OK`（Peer 主机名 / <ssh-user>） | 通过 |

## 8. 缺陷清单（按严重度）

### P1

**D-01 域名（443）接入时安装命令端口错误**
- 复现：以域名方式添加节点（endpoint 无显式端口，默认 443）→ 复制「安装 Agent」命令。
- 实际：命令带 `--port 8880`，Agent 监听 8880，面板按 443 探测 → 节点长期离线；手动改成 `--port 443` 后才上线。
- 根因指向：`apps/api/src/lib/agent-commands.ts` 的 `buildAgentInstallCommand()` 使用 `nodeAgentPort(node.endpoint)`；端点无显式端口时回落 8880，而域名模式面板默认访问 443。调用点见 `apps/api/src/routes/agent_lifecycle.ts`。

**D-02 Agent 卡死（443 监听但请求不接受）**
- 状态：**已修复（Agent 0.1.35，2026-11-09）**。根因确认为 TLS 握手在 `serve_forever` 的 accept 主线程里同步执行——一条只建 TCP 不发数据的连接即可永久冻结 accept 循环（0.1.34 下 1 条空连接 3/3 次 `/health` 8s 超时；0.1.35 下 20 条空连接并发，`/health` 稳定 5ms）。修复：监听 socket 保持明文，握手移入工作线程并带 10s 超时，失败只关单条连接。回归测试见 `agent/tests/test_tls_transport.py::TlsHandshakeIsolationTests`。
- 复现：域名节点运行一段时间（期间做过状态轮询与 WireGuard 状态读取）后，面板与本地均无法访问 `/snapshot`，health 超时；443 端口 LISTEN 但 accept 队列堆积。
- 恢复：`systemctl restart khc-agent` 立即恢复。
- 根因指向：疑似适配器/状态轮询阻塞主线程（WireGuard 状态采集）；`agent/khc/` 的请求处理路径需加超时/隔离。属可用性风险。

**D-03 节点页状态粘滞，写入被误禁用**
- 复现：节点列表显示在线、`/snapshot` reachable=true、节点侧配置已生效，但节点页仍显示「节点不可达 / 待上线后生效 / 待应用」，应用与保存按钮被禁用；刷新列表 + 强制刷新页面后恢复。
- 根因指向：`apps/web/src/apps/caddy/page.tsx` 等页面的 `unreachable = nodeOffline || !channels.canApply` 状态来源（`hubQuery.data.status` 与 HubChannels 上下文）与快照探测结果不同源，且失败后不自动重算。

**D-04 启用「DNS 代建」后新增 IP 节点不自动建记录**
- 见 §1.5。根因：`apps/web/src/data/cfDns.ts#createCfDnsRecordForNode` 无调用点；Worker `POST /api/v1/cf-dns/records` 只能被显式调用。

### P2

**D-05 Caddy 服务未运行时面板无法启动**
- 复现：面板安装 Caddy 后直接去站点页操作；服务为 inactive，面板只有「重载 Caddy」，重载失败且无「启动」入口。
- 影响：首次安装后必须 SSH 手动 `systemctl start caddy`。

**D-06 节点列表加载瞬间渲染空态**
- 复现：在节点列表与其它页面之间切换（或刷新）。
- 实际：先出现「还没有节点 / 添加节点后…」，约 1–2 秒后表格才出现（本次复现于清理后最终核对）。
- 根因指向：列表页把 `isLoading`/未就绪与「空数据」共用同一空态分支。

**D-07 主机运维实时观测中断后不自动恢复**
- 复现：主机运维页停留一段时间后，实时数据停止更新，需要点「重新连接」才恢复。

**D-08 外部 Caddy 配置解析误判**
- 复现：站点页读取节点既有 Caddy 配置。
- 实际：`:80` 的根目录静态块被识别成「反代 / 自动签发」。
- 根因指向：`apps/web/src/apps/caddy/page.tsx` 的外部配置解析分支（按端口/关键字猜测类型）。

**D-09 修改 Peer 应用端口后发布侧不同步**
- 状态：**已修复并真机闭环（2026-11-09，见 §13）**。发布站点时写入 `sourcePeer`/`sourcePort`；改 Peer 地址/端口时列出受影响站点并支持一键同步上游（保留站点当前端口）；手工改过端口的站点明确提示并保留现状，不静默覆盖。
- 复现：Peer 应用端口 8080 → 3000，Hub 上已发布站点上游仍指向旧端口，外网 502。
- 根因指向：`apps/web/src/apps/wireguard/page.tsx` 的 `publishSite()` 只做一次性预填（`<peerIp>:80`），没有"应用 ↔ 发布站点"的关联或同步逻辑。

### P3

**D-10 公钥移除/删除成功后列表不自动刷新**
- 两处：主机运维 → SSH 公钥（`OpsSegments.tsx`）；设置 → SSH 公钥库（`SshKeys.tsx`/相关 mutation）。
- 实际：节点侧与后端已生效，列表仍显示已删除条目，需手动点「刷新」或重进页面。

**D-11 接入方式文案固定为「域名（ACME）」**
- 实际：使用手动证书接入时，节点设置仍显示「域名（ACME）」，与实际签发方式不符。

不构成缺陷的观察：
- 端口数字被鼠标悬停滚轮改写（8080→8075、9001→9009）是 ego-browser 指针滚轮落在 number input 上的**测试工具伪影**，已改用原生 setter 复测，不计产品缺陷。
- DNS 测试记录未随节点删除被清理：该记录是测试期间用 `POST /api/v1/cf-dns/records` 手工创建，托管键归属与最终删除的节点 id 不一致；按测试构造处理，已手工清理，不计产品缺陷（但「面板代建」标签在节点删除后仍可能存在孤儿记录，值得产品侧确认）。

## 9. UI 问题清单

| 编号 | 类型 | 位置 | 表现 |
| --- | --- | --- | --- |
| UI-1 | 四态 | 节点列表 | 加载中渲染「还没有节点」空态（D-06） |
| UI-2 | 状态/门控 | 节点页（站点/内网穿透/主机运维） | 节点实际在线时按钮仍显示不可用，文案「待上线后生效」（D-03） |
| UI-3 | 文案 | 节点设置 | 「域名（ACME）」与手动证书实际不符（D-11） |
| UI-4 | 刷新 | 主机运维 SSH 公钥 / 设置公钥库 | 删除成功后列表残留，需手动刷新（D-10） |
| UI-5 | 布局 | 节点列表 | 403 宽度下直连地址换行成三段（`http://203.0.113` / `.12:8880`），可读性差 |
| UI-6 | 交互 | 主机运维 | 实时观测断开后无自动重连提示（D-07） |

范式核对（ui-guidelines）：
- 行内按钮 ≤2：DNS 记录行（编辑/删除）2 个、SSH 公钥行仅「更多操作」1 个 —— 符合。
- 唯一详情入口：节点、凭据、公钥均以整行打开同一抽屉 —— 符合。
- 抽屉内不嵌套 Dialog：删除 DNS 记录时先关闭抽屉再弹页面级确认；移除公钥用页面级 Dialog —— 符合。
- 危险操作确认：删除节点要求输入节点名 + L3 确认；删除凭据/记录用 ConfirmAction —— 符合。
- 术语一致性：本次未见「节点/站点/Peer/保存并生效」混用。

## 10. 请求量统计（估算）

未保留 HAR，以下按操作记录与页面打开时长估算：

| 类别 | 次数（约） | 说明 |
| --- | --- | --- |
| 快照轮询 `/snapshot`（10s） | 220–260 | 各 Hub 页面打开累计约 35–45 分钟 |
| `/state` 一次性探测 | 10–12 | 每次进入 Hub 页面一次 |
| 节点/站点/转发/WG 写操作 | 18–22 | 接入 3 次、站点 4 次 + 端口修改、WG 接口/Peer、转发 1 次、公钥 3+2 次、DNS 2 次 |
| apply/任务轮询 | 15–20 | 每次「保存并生效」后的任务查询 |
| 只读查询（列表/记录/keys.list） | 25–35 | 含 DNS 记录浏览、公钥刷新 |
| 合计 | **≈ 300–350** | 全程无循环轮询、无重复刷新 |

## 11. 测试残留清理结果

面板（D1）：
- 删除临时节点 `e2e-1108-domain`（含 IP 阶段节点），节点总数回到 3：`node-prod-1`、`node-test-2`、`azure`；生产节点状态与配置未变。
- 删除测试 DNS 记录 `e2e-dns-probe.example.com`（Zone 记录数 9 → 8）。
- 删除公钥库条目 `e2e-1108-renamed`（`GET /api/v1/ssh-keys` 返回空）。
- 未留下测试 DNS 凭据（伪造 Token 未落库）。

Hub `203.0.113.10`：
- 停止并移除 `khc-forward-e2e-peer-ssh.service`；`wg-quick@khc0` 停止、disable，删除 `/etc/wireguard/khc0.conf`。
- 删除 `/etc/caddy/khc.d/caddy-site.caddy`，Caddy 停止并 disable（恢复为测试前的未运行状态；caddy 包为 10-27 既有安装，未卸载）。
- 卸载 khc-agent：停止/disable 服务、删除 `/etc/systemd/system/khc-agent.service`、`/etc/khc-agent`、`/opt/khc-agent`、`/var/lib/khc-agent`。
- 结束 `:9001` 的 python http.server，删除 `/tmp/e2e-web`、`/tmp/e2e-web.log`；删除 `~/.acme.sh` 与 crontab 中的 acme 任务；卸载本次安装的 `cron`/`cron-daemon-common`。
- 复核：443/8880/51820 无监听，`wg show` 为空，`/etc/khc-agent` 不存在。

Peer `203.0.113.11`：
- `wg-quick down e2e`、disable `wg-quick@e2e`、删除 `/etc/wireguard/e2e.conf`。
- 停止 `:80`、`:3000` 的 python http.server；删除 `/tmp/e2e-peer-a`、`/tmp/e2e-peer-b`、日志、`/tmp/e2e-wg`、`/tmp/e2e-install*.sh`；确认 Peer 上无 khc-host 常驻产物。

本地：
- 删除 `/tmp/khc-e2e`（测试密钥对）。
- 关闭 ego-browser 任务空间（未保留页面）。

## 12. 建议优先级（仅建议，未改代码）

1. D-01 安装命令端口推导（P1，影响域名接入可直接失败）。
2. D-02 Agent 请求阻塞（P1，影响可用性）。
3. D-03 状态来源统一（P1，导致"看着在线却不能操作"）。
4. D-04 DNS 代建接线（P1，功能承诺未兑现）。
5. D-05/D-09/D-06（P2，首次使用与一致性体验）。

## 13. 2026-11-09 收口记录

### D-02 收口

- 修复随 Agent 0.1.35 发布（`apps/web/public/agent/khc-agent-0.1.35.tar.gz`）。
- 证据见 §8 D-02 状态行与 `docs/agent-lifecycle.md` §12。

### D-09 真机闭环（node-prod-1）

- 待补：本轮真机流程（建 Peer + 站点、改 Peer 端口出现「受影响站点」、同步后上游更新、手工端口不被覆盖、清理前后对照）。

### 新的已知问题（记录，未修）

**D-12 两轮升级重叠时看门狗误回滚（P2）**
- 触发条件：连续两次升级间隔 < 约 40s（上一轮看门狗窗口 = 重启延迟 + 8s + 约 30s 探测），且第二轮为降级/换包；第一轮已排定的 systemd 看门狗定时器不会被第二轮取消。
- 影响：第一轮看门狗在第二轮已生效的版本上探测，判定"版本不符"后把 `.prev` 换回，刚升级成功的版本被弹回，`upgrade.json status=rolled_back`。实测 0.1.35→0.1.34 降级成功后 19s 被弹回 0.1.35。单次升级/正常使用不受影响。
- 建议修法（需单独立项）：①新一轮升级开始时 `systemctl stop` 旧看门狗 timer；②看门狗脚本校验 `upgrade.json` 的 requestId/targetVersion，不一致直接退出；③用 flock 让升级跨重启互斥。
- 详情：`docs/agent-lifecycle.md` §13。
