# Changelog

格式基于 Keep a Changelog，版本遵循 SemVer。

## [Unreleased]

### Docs

- 新增面板信息架构与 UI 重组提案 `docs/plans/ui-ia-redesign-2026-11-12.md` 及 ADR-0014 / 0017 / 0018（提议，未改产品代码）。

### Security

- Agent 发布签名换钥（2026-11-11，方案 B）：旧 Ed25519 私钥按疑似泄露处理，新钥仅用于
  Agent 0.1.39 及之后的包与清单；0.1.39 内置新公钥，不再内置旧公钥。存量节点需用
  安装/升级命令手工切换到 0.1.39，旧钥随之下线。
- 加固 `scripts/build-agent-release.sh`：`SIGN_KEY_FILE` 只接受私钥**文件路径**并做存在性
  校验；旧 `SIGN_KEY` 变量显式拒绝；所有失败路径不回显变量内容，避免私钥进入命令输出。

## [0.10.0] - 2026-11-11

- Caddy 存量纳管（方案 A：只读发现 + 影子导入 + 保存时接管）：
  - 新增只读动作 `caddy_import_preview`：按扫描指纹返回将生成的面板站点草稿、将写入
    `khc.d/caddy-site.caddy` 的片段、将摘除的主 Caddyfile 行区间、首次纳管是否会追加
    `import khc.d/*`，以及「摘块 + 新片段」整树 `caddy validate` 结果（临时镜像目录，不落盘）。
  - 外部站点抽屉先展示影子预览；只有 `supported` 且整树校验通过才允许「接管并生效」，
    仍需 `ConfirmAction` 明确确认。旧 Agent 无该动作时降级为原有接管流程。
  - 接管顺序改为「先落 D1 草稿（不 apply）→ 摘块 → apply」：任一步失败都不会让主 Caddyfile
    先行缺失站点；摘块前失败回滚 D1 草稿。主 Caddyfile 仍只在首次 apply 时追加 import 行，
    备份与 `caddy_import_restore` 回滚路径不变。
  - 扫描/接管保留 `lbPolicy` / `healthUri` / `logPath`，避免接管时静默丢配置；`log` 只有能
    无损识别 `log { output file <path> }` 才允许接管，裸 `log`、多条 `log`、`stdout` 等阻断并给原因。
  - 仅端口/无域名、`handle`/`route`/自定义证书等形态继续只读展示并阻断，不猜着转换。

## [0.9.2] - 2026-11-11

- 文案去重（0.9.1 的收尾，非新增功能）：首页令牌行已显示「站点 0」，紧随其后的注记不再重复对象名，
  由「站点 · 已安装 · 暂无站点」改为「已安装 · 暂无站点」。判定分支不变。

## [0.9.1] - 2026-11-11

- 修正标注语义（非新增功能）：「已安装但没有站点」不再被标成「外部安装 · 未纳管」。0 站点只说明
  D1 期望配置为空，不等于存在未托管的第三方配置；混为一谈会让人误判有外部配置待接管。
  - 节点已安装 + D1 有行 + 生效条数为 0 → 「已安装 · 暂无站点」/「已安装 · 暂无规则」；
  - 节点已安装 + D1 无该应用行 → 「已安装 · 面板无配置」；
  - D1 有行但 `installed === false` → 仍为「未安装 / 未生效」，不降级成"暂无站点"；
  - 「外部安装 · 未纳管」只在站点页 `caddy_import_scan` 确实返回 `blocks > 0` 时出现，
    接管入口仍是既有的扫描 → 接管流程。
  首页与节点概况页同一口径，不新增请求、不改交互范式；补了 `appPresence` 单测覆盖上述情形。

## [0.9.0] - 2026-11-11

- 手工安装的应用「可见 + 可接管」：`POST /nodes/probe` 改用 Agent `GET /state`（10s 预算），
  响应新增可选 `apps: [{name,installed,running}]`（只含名称与布尔值，不含任何 secrets）；
  首页仍只发 1 次 probe，`/state` 超时/结构不合法时 apps 缺失或为空、不影响 `reachable`。
  首页卡片与节点概况页把 D1 期望配置与在线实装做差集：D1 有行但节点未安装 → 「未安装 / 未生效」
  （不再显示肯定的「组网节点」）；实装但 D1 无行、或 Caddy 实装但站点计数为 0 → 「外部安装 · 未纳管」，
  入口复用站点页既有 `caddy_import_scan` → `takeover`，不新造操作范式；WireGuard 无接管流程，
  只显示状态并进入现有应用页。`lib/node-summary.ts` 仍为纯 D1 派生，不塞在线探测。
- 摘要语义修正：有配置行但条数为 0 时 `summary.sites` / `summary.forwards` 返回 0（不再折成 null），
  首页与详情页明确显示「站点 0 / 转发 0」，不再与「未配置」混成空白。
- `app_configs` 新增可空 `summary_json`（迁移 `0012_app_configs_summary.sql`，只增列）：
  `put` 时用明文 config 派生模式与计数落库，`GET /nodes` 与 `GET /nodes/:id` 改读明文摘要、零解密；
  `summary_json IS NULL` 的旧行整批回退 `listForSummary()` 解密派生，一次性回填后观察一版再删。
  硬约束：摘要只含模式与计数，不得写入私钥、证书、密码或哈希（已有测试断言防回归）。
  旧版本 Worker 的显式列名查询不受影响（该列为可空、无默认值）。

## [0.8.0] - 2026-11-10

- 首页节点卡新增应用摘要令牌行：模式徽标（组网节点 / Caddy 网关）+ Peer / 站点 / 转发计数。
  显示即开启、只写对象名 + 数字，停用等异常才注记，未配置项不渲染。数据全部来自 D1 期望配置
  （`GET /nodes` 新增可选 `summary` 字段，`GET /nodes/:id` 同返回），首页保持 3 请求预算、
  零节点连接；派生逻辑集中在编排层 `apps/api/src/lib/node-summary.ts`（`desiredMode` 唯一真源）。
- 摘要读取改为 D1 分页最小投影（`AppConfigRepo.listForSummary`，每页 200 行）：修复单次查询
  1000 行上限的静默截断，且只取 `node_id/app/config_json`、不读也不返回 `secrets_enc`；
  路由仍只做按 node 分组，应用名知识不下沉到核心路由。
- 节点概况页重排（page-specs §2.1）：页头模式徽标改用 D1 摘要（离线可见，不再请求 `/mode`）；
  4 指标为 实时状态 / 站点（类型分布）/ Peer 在线（接口·端口）/ 负载（内存·磁盘）；
  「应用与发布」卡只列已配置应用，单徽标（运行中 / 未运行 / 待生效 / 未读取）+ 关键参数，
  无已配置应用时整卡不渲染；移除「未配置」「还没有站点」「已安装+运行中双徽标」等负向占位与冗余文案；
  `summary` 缺失（POST/PATCH 响应、旧缓存）时回退到同源 WireGuard 配置，WireGuard 行与 Peer 指标不消失。

## [0.7.14] - 2026-11-10

- 发布 Agent 0.1.37：存量节点升级时把 unit 里 `ReadWritePaths=/etc/wireguard` 这类硬路径
  原地改为可选前缀 `-path`（其余条目与沙箱强度逐字符不变、不新增放宽项），修复 0.1.36
  只对全新安装生效、已升级节点仍保留硬路径的覆盖缺口。`/etc/wireguard` 被误删时服务
  照常启动，WireGuard 适配器以 `wireguard_dir_missing` 上报不可用。

## [0.7.13] - 2026-11-10

- 发布 Agent 0.1.36（预发复测 13 项缺陷按 R1–R7 成批修复）：
  - 动作参数统一走 `action_params(body)` 唯一访问器，修复 CaddyFile 接管/恢复（C-05）与
    备份恢复时「参数读错层级」导致的失败；适配器内置 AST 守卫阻止再次直读顶层键。
  - cron 校验收敛为 Agent 单一权威：拒绝 `@reboot` 等快捷表达式、shell 分隔符注入
    （`;` / `&&` / `||` / `|` / `$()` / 反引号）、段数不足与越界时间字段；面板侧只保留格式提示。
  - `status` 新增 `orphan_unit`（残留 `wg-quick@*`）与 `wireguard_dir_missing`（`/etc/wireguard`
    缺失降级，不再拖垮 Agent 启动）；站点 plan/apply 读 `/proc/net/tcp{,6}` 做真实端口预检。
  - 过载拒绝语义明确：明文池满返回 503 + `Retry-After`，TLS 握手前只能断连（见
    `docs/security-boundaries.md` §4.1）。
- 备份默认剥离 basicauth 密码哈希并在 manifest 记录 `stripped`/`encKeyId`，导入时保留目标
  节点旧值；新增 `scripts/verify-backup.mjs` 与灾难恢复「回放前自检」。
- 面板文案：直连观测不可用时明确「不回退控制面快照」；未知状态改为「未读取」。
- Agent unit 的 `/etc/wireguard` 白名单改为可选前缀，目录被误删时 Agent 仍可启动。

## [0.7.12] - 2026-11-10

- 面板节点「Agent」卡新增升级纪律提示：同一节点两次升级间隔需 ≥60 秒，升级失败先看
  节点上的 `/var/lib/khc-agent/upgrade.json` 再决定是否重试（看门狗重叠回滚属已知缺陷，单独立项）。
- 新增外部 uptime 探测脚本 `scripts/uptime-check.mjs`：检查 `/api/v1/health`、
  `/api/v1/version` 的 commit 与 TLS 证书到期；告警 webhook 未配置时显式提示「未配置」，
  不静默通过（告警地址待提供后接线）。

## [0.7.11] - 2026-11-09

- 修复改 Peer 地址后站点上游同步延迟数秒：`commitPeer` 原先把配置重拉（两个跨境 GET）
  排在 Peer 与站点两个 PUT 之间；现改为两个写请求连续发出、写完后统一重拉。站点 PUT
  失败仍走原失败提示，半成功状态照常重拉可见，保存与关抽屉行为不变。
- 修复节点在线时被误报「节点不可达」：站点页与 WireGuard 页的离线横幅原来用
  `offline || !canApply` 判断，探测中/探测失败（未确认）也会命中；现仅在明确离线时提示，
  未确认状态沿用按钮 tooltip「暂时无法确认节点连接，请稍后重试」。basic-auth 密码哈希的
  离线拦截文案同步改用该提示；站点页「外部配置（未托管）」的禁用提示不再写成
  「节点不可达」，改为中性说明「需确认节点连接与 Caddy 适配器」。

## [0.7.10] - 2026-11-09

- 发布 Agent 0.1.35：修复 TLS 握手在 accept 主线程执行导致的连接冻结（一条只建 TCP
  不发数据的空连接即可让 `/state`、`/health` 全部超时）；握手改到工作线程并带 10s 超时。
- 升级定时器改用 `--timer-property AccuracySec=1us`（默认 1min 精度会让 2s 定时器在
  2–60s 随机触发）；看门狗定时器 = 重启延迟 + 8s，并等待旧进程退出后再做健康探测。
- Agent 启动时清理被 kill -9 遗留的 `.khc-agent-upgrade-*` 目录，并把 `upgrade.json` 的
  `restart_scheduled`/`downloading` 中间态归一为 `unknown`/`failed`。
- 已知问题（未修）：两轮升级重叠时，上一轮看门狗的定时器可能在下一轮执行后回滚版本，
  详见 `docs/agent-lifecycle.md` §13。

## [0.7.9] - 2026-11-09

- 修复「设置 → 应用目录」在旧版 Agent 上仍显示原始报错
  `recipe 清单不存在或不是 JSON 对象: …` 的问题：该动作以 HTTP 错误返回时前端直接抛出，
  未经过友好转换；已安装列表读取、安装、卸载与任务刷新统一转为升级引导文案。

## [0.7.8] - 2026-11-09

- 修复站点页「外部配置（未托管）」在旧版 Agent 上直接显示原始报错
  `未知动作: caddy_import_scan` 的问题：扫描失败统一转成「需要升级节点 Agent 后可用」
  的引导文案；该页其余动作错误也走同一层友好转换。

## [0.7.7] - 2026-11-08

- DNS 代建：多凭据模型下未显式选择 Zone 时，只有唯一启用 Zone 才自动代建；存在多个
  启用 Zone 时返回 `cf_dns_zone_required` 并明确提示选择，不再只读旧单 Zone 配置。
- 新增 IP 直连节点时可在接入表单里选择 Zone 与子域名；代建失败（含未启用、多 Zone
  未选择等 409）改为显式 toast 提示，不再静默吞掉。
- 控制面探测请求本身失败（浏览器↔Worker 断链）时自动有限补探 3 次（1.5s 缓冲），
  不再只能手动点「重试」；仍然不做周期轮询。
- 旧版 Agent 的原始错误（`未知动作: caddy_import_scan`、`recipe 清单不存在…`）统一
  转成「需要升级节点 Agent 后可用」引导，站点导入扫描与应用目录均生效。
- 站点记录来源 Peer：从 WireGuard 发布站点时写入 `sourcePeer`/`sourcePort`；改 Peer
  地址时列出受影响站点并支持一键同步上游（保留站点当前端口）。旧站点无来源字段时按
  上游地址匹配兜底；手工改过端口/主机的站点会明确提示并保留现状，不静默覆盖。
- 发布包继续携带 Agent 0.1.34 的 `wg show` 5s 短超时修复（D-02）。

## [0.7.6] - 2026-11-08

- 节点列表：确认不可达且距最后在线 ≥1 天的节点标「离线 · 已失联 N 天」，并给出
  「删除失联节点」横幅入口（复用 L3 确认 + 卸载脚本生成，不新增删除链路）。
- 节点状态复核：探测到离线后按 60s/120s/240s 最多自动再探 3 次；全部在线、手动刷新
  或离开页面即停。停在后台超过 60 秒再回到页面时补探一次；仍无常驻轮询。
- `POST /nodes/probe` 的 `/health` 单节点预算从 3s 放宽到 5s，降低跨区/弱网建连被误判离线。

### Agent 0.1.34

- 主机运维做减法：`/state` 去掉进程 Top5 与一次重复的 `systemctl is-active`；服务段只返回
  failed 单元与面板受管单元（`caddy` / `khc-*` / `wg-quick@*`）；进程列表改为单次 `ps`
  排序后只读取入选行的 `/proc` 详情；防火墙不再读取其他 nft 表与 `iptables -S INPUT`
  自动放行规则；服务日志上限收紧到 200 行。

### Agent 0.1.33

- `certificates` 识别 acme.sh 的非 PATH 安装路径（`~/.acme.sh/acme.sh`、`/root/.acme.sh/acme.sh`、
  `/usr/local/bin/acme.sh`、`/usr/bin/acme.sh`）；状态检查与 `--issue/--install-cert` 共用同一解析结果，
  不再把已安装的 acme.sh 误报为缺失。
- `caddy-site` 诊断只在已配置站点（`sites > 0`）时把「服务未运行」报为 error；装了 Caddy
  但还没发布站点的节点不再永久红灯。

### Agent 0.1.32

- `--acme` 安装 acme.sh 前检测并尽力补齐 `cron`（apt/dnf/yum/apk）；安装器因缺 cron
  返回失败但 acme.sh 已就位时只告警，不再中断证书签发。
- 站点健康探测在 `tls.mode=off` 时改连 `127.0.0.1:<端口>` 并带 `Host: <域名>`，
  避免域名解析/DNS 未就绪时把正常站点误报为 down。

### Agent 0.1.31

- 端口转发「已安装」判定修正：只有存在转发配置时才算已安装；`socat` 仅作为运行依赖
  （ACME 自动签发也会安装它），不再因为节点上有 socat 就显示端口转发已启用。

### Agent 0.1.30

- `--acme` 自动签发前检查 `socat`（acme.sh 的 TLS-ALPN-01 依赖它），缺失时按发行版自动安装；
  仍失败会清晰提示并回退 HTTP-01。

### Agent 0.1.29

- 一键安装自动签发证书：域名 + HTTPS 且系统模式时，安装命令自动带 `--acme <域名>`；
  证书缺失时 `install.sh` 安装 acme.sh，优先 TLS-ALPN-01（只占用 443），失败回退
  HTTP-01（80），写入 `/etc/khc-agent/tls/` 后继续安装。只需入站 443、出站 443；
  Cloudflare 记录必须「仅 DNS」（灰云）。已有证书自动跳过，user 模式仍需手动签发。
- 安装命令不再在缺证书时中止（域名 + system），避免「一键安装过不去」；
  裸 IP + HTTPS 仍明确阻断。

### Agent 0.1.28

- `caddy-site` 新增 `caddy_start`（写）：服务未运行时先 `caddy validate`，通过后
  `systemctl enable + start`；校验失败不启动。解决面板装完 Caddy 后服务 inactive
  只能重载、必须 SSH 手动 start 的问题。
- `caddy_import_scan` 的分类修正：`:80` / `http://` 块不再标成「自动签发」；
  不受支持的块也按指令给出真实类型（root/file_server → 静态），不再回落到默认「反代」。
- WireGuard 状态采集（`wg show`）加 5s 短超时：内核/设备卡住时不再长时间占用
  请求线程（排查「443 监听但请求不返回」的可用性风险）。

### 修复（2026-11-08 E2E 验收）

- 域名接入（无显式端口）的安装命令按协议推导端口：`https` → 443（此前回落 8880，
  Agent 监听到面板探测不到的端口）。
- 启用 DNS 代建后，新增 IP 直连节点会自动创建 A/AAAA 记录（失败不影响节点）。
- 节点列表首次加载渲染骨架屏，不再闪「还没有节点」空态。
- 控制面探测失败但观测面仍有快照时自动补探（最多 3 次），修复节点在线但按钮
  长时间停留在「待上线后生效」。
- 主机运维实时观测静默断链（60s 无新帧）自动用新票重连；仍失败时显示「重新连接」入口。
- 接入方式文案「域名（ACME）」改为「域名（HTTPS）」（手动证书同样适用）。
- 主机运维/进程列表新增「名称」列：解释器进程显示脚本名（如 `khc_agent.py`），
  内核 comm 被截断时用命令行补全（如 `networkd-dispatcher`）；进程详情抽屉标题
  改为「名称（PID）」。「只看业务进程」补充云镜像守护进程（multipathd、ssm-agent、
  chronyd、irqbalance 等），不再混进业务视图。
- 节点概况「主机与服务」卡片修复系统服务恒为空：服务清单改取一次性 `/state`
  （10s 轻量快照本就不采集），并区分「x / y 个运行中」。
- 节点概况负载卡补充内存已用/总量（如 `245 MiB / 412 MiB（59%）`），不再只有百分比。
- 窄屏（≤639px）列表行标题与摘要允许换行：诊断、进程等列表不再整行截成「…」，
  无需 hover 才能看全文。

### Agent 0.1.27

- `caddy-site` 新增接管能力（配合面板 0.7.4）：
  - `caddy_import_scan`（只读）：解析主 Caddyfile，列出已存在但未托管的站点块
    （域名、类型、上游/根目录/跳转、TLS、行号、原文）；只读解析，不改文件。
  - `caddy_import_takeover`（写）：按块指纹把站点块从主 Caddyfile 摘除；先校验整棵
    配置树、再写 0600 备份（保留最近 10 份）、最后原子写入；不 reload，由面板随后
    保存站点并 apply 生效。
  - `caddy_import_restore`（写）：从接管前的备份恢复主 Caddyfile 并 reload。
  - 自定义证书（`tls <cert> <key>`）、`handle`、通配符、仅端口、IPv6、header 块等
    无法无歧义映射的块标记为不可自动接管，避免把私钥带进控制面。

### Agent 0.1.25

- 修复 `install.sh` 漏拷 `recipes/`：安装时把包内 `recipes/` 复制到 `$PREFIX/recipes`，
  并按可选项处理旧版包缺目录（警告降级，不阻塞安装）；补回归测试。
- 卸载仍按整个 `$PREFIX` 清理，`recipes/` 随程序目录一并删除。

## [0.7.5] - 2026-11-08

- 主机运维精简：服务段只显示 failed 与受管单元；进程段收敛为 Top 20；移除防火墙
  「其他表 / iptables 自动放行」只读展示；节点概况不再展示 Top5 进程摘要。

## [0.7.4] - 2026-11-07

### Added（接管已有 Caddy 站点）

- 站点页新增「外部 Caddy 配置」分区：只读扫描主 Caddyfile，列出已存在但未由面板托管的
  站点块（域名/类型/目标/TLS/行号），可查看原文。
- 支持逐站点「接管为面板站点」：先把站点块从主 Caddyfile 摘除（先校验、失败不落盘、
  自动备份），再写入面板站点并生效；行内仅一个主操作，冲突/不可接管会说明原因。
- 接管失败可「重试应用」；也可「恢复 Caddyfile」从备份还原（先移除面板新增站点并生效，
  再恢复旧块，避免同域名重复导致校验冲突）。

## [0.7.3] - 2026-11-07

### Fixed（目标下拉「自定义」可选，PR5）

- 端口转发与 Caddy 站点的目标来源下拉选择「自定义」后，主机地址输入框现在会真正切换为可编辑，
  不再自动弹回原来的 Peer/本机选项。

## [0.7.2] - 2026-11-07

### Added（Peer 跨节点迁移，PR4）

- 内网穿透 Peer 抽屉「高级」区新增「迁移到其他节点」：在目标节点现场生成新密钥、保存并应用配置，
  输出覆盖客户端 `/etc/wireguard/khc0.conf` 的一键脚本；源节点 Peer 不自动删除。
- 目标节点未配置内网穿透 / 纯网关模式 / 无公网地址时，迁移按钮禁用并说明原因；
  目标有未应用改动时提示会一并应用。
- 新建内网穿透配置的接口名默认固定为 `khc0`，接口设置抽屉中的名称改为只读（客户端一键脚本统一 khc0）。

## [0.7.1] - 2026-11-07

### Changed（站点表单统一，PR3）

- Caddy 站点编辑抽屉新增「危险操作」卡片：可直接删除当前站点，卡片内联确认（不叠加 Dialog），
  删除后保存并生效；行内删除入口保留。
- 站点/端口转发的目标下拉统一为「Peer 列表 + 本机 + 自定义」，参数不手填主机地址。

## [0.7.0] - 2026-11-07

### Added（域名接入证书自动化 PR2）

- 证书库记录 ACME 签发参数（provider / 凭据设置键 / CA / 密钥类型）；详情抽屉新增「续期」，
  续期成功后原位替换证书材料，并自动重新安装到来源节点。
- 新增 `POST /api/v1/certs/:id/bind`：把证书 PEM/私钥安装到节点 Agent 的 TLS 目录并热重载；
  域名接入节点在签发成功后自动执行。明文 `http` 节点拒绝下发私钥（400 `insecure_channel_secret`）。
- 新增 `PUT /api/v1/certs/:id` 用于续期材料原位更新，不再产生重复证书记录。
- 节点作用域的证书页新增「节点入口（HTTPS）」卡片，展示接入方式、Agent TLS 状态与证书到期时间。
- 新增迁移 `0011_cert_acme_meta.sql`（证书 ACME 元数据列）。
- Agent 0.1.26：`certificates` 适配器新增 `install_tls`（PEM 配对校验 → 原子写入 0600 → SIGHUP 热重载）。

## [0.6.0] - 2026-11-07

### Added（全局接入配置 PR1）

- 全局配置新增「域名」「隧道」分段：DNS 记录可直接编辑/删除；隧道配置统一维护
  「对外域名 / 源站端口 / Token」，供节点下拉引用，不再在添加节点时手填或新建域名。
- 节点新增显式接入方式：域名（ACME）/ Tunnel / IP 直连；添加与修改共用同一接入表单。
- Tunnel 节点安装命令自动注册 `cloudflared` 并以 `127.0.0.1:<源站端口>` 运行 Agent；
  IP 直连必须显式确认明文入口，生产环境不再静默放行 http。
- 删除节点默认保留全局 DNS 记录与隧道配置，可复用给其他节点。
- 新增迁移 `0010_node_access.sql`（`nodes.access_mode/tunnel_id/allow_insecure` + `tunnels` 表）。

## [0.5.16] - 2026-11-07

### Fixed（UI 走查 P2 批次）

- SSH 重命名抽屉在「公钥」下展示完整公钥（只读多行），不再只显示截断指纹。
- Cloudflare 凭据名称 / API Token 为空时禁用保存，并提示缺少项。
- WireGuard 接口已在节点上运行但面板未配置时，提示「保存并生效后按面板配置同步」；
  接口公钥展示完整值。
- 删除 Peer 确认框移除无关的「同时清理该 Peer 本机服务」，删除只处理面板配置。
- Agent 远程升级抽屉展示完整 SHA256 并支持复制。
- 出口网卡不再默认写死 `eth0`；留空时由 Agent 按节点默认路由探测（eth0 / ens3 / ens5），
  面板补充帮助文案（探测能力随配套 Agent 版本生效）。

## [0.5.15] - 2026-11-07

### Fixed（抽屉内叠加 Dialog 破坏交互范式）

- 站点编辑、WireGuard 接口设置、Peer 放弃修改、Agent 远程升级四处，改为
  「保存变更 → 关闭抽屉 → 页面级确认」，符合 ui-guidelines §8.3；
- 抽屉在有未保存修改时只在抽屉内提示，不再叠加 Dialog；补充内联提示样式。

## [0.5.14] - 2026-11-07

### Fixed（应用目录参数缺少客户端校验）

- 安装表单按 recipe 定义做与服务端一致的校验（必填 / 整数 / 范围 / 长度 / 正则全匹配）；
- 非法值就地提示并禁用安装按钮，避免提交后才在节点侧失败。

## [0.5.13] - 2026-11-07

### Added（应用目录已安装列表与卸载）

- 设置 → 应用目录新增「已安装应用」卡片：按节点读取 `recipe_installed`，展示版本与安装时间；
- 每个已安装应用提供卸载入口，走 L3 确认调用 `recipe_uninstall`，任务完成后自动刷新列表；
- 不再需要重建 Agent 包即可使用已安装/卸载能力。

## [0.5.12] - 2026-11-07

### Fixed（手动导入证书无法选择全局）

- 手动导入证书的「来源节点」可选「全局（不绑定节点）」，提交时不再强制绑定节点；
- 修正导入文案：导入不会在任何节点上执行签发，来源节点仅作标记；
- 未选择节点时隐藏「解析」按钮并提示先选择来源节点。

## [0.5.11] - 2026-11-07

### Fixed（新增 Peer 应用失败后无法重试）

- 「保存并生效」失败时先保存配置、再应用；应用失败则关闭抽屉并在页面级提示原因，
  不再停留在「添加」模式、也不会因 Peer 名称已存在而无法重试；
- 成功新增后仍自动打开导出抽屉。

## [0.5.10] - 2026-11-07

### Fixed（L3 确认框输入框塌成一行文字）

- 修复「删除节点」等 L3 确认框输入框只有 18.5px 高的问题：`.ui-input` 自带
  `flex: 1 1 0%`，被直接放进 column flex 的 `.ui-dialog-field` 后 `flex-basis: 0`
  压过了 `height`，高度塌成一行文字。现对 `.ui-dialog-field .ui-input` 显式
  `flex: none`，桌面回到 32px（`--h-control`），≤639 为 40px（`--h-control-lg`）。
- 同类扫描同步修正：表格工具条搜索/筛选由手写 28px 提到 32px（`--h-control`），
  ≤639 提到 40px；移动端搜索框字号 16px，避免聚焦触发 iOS 自动放大；机密字段
  与只读字段在 ≤639 也补到 40px（只读字段桌面由 36px 收敛到 32px）。
- 规范补齐：ui-guidelines §8.9 新增「表单控件」行（桌面 32 / ≤639 40、任何容器不得低于
  该高度）、§8.11 Field/SecretField 写明两档高度；tokens.css 补充 `--h-control`
  与 `--h-control-lg` 的语义注释。

## [0.5.9] - 2026-11-07

### Fixed（HTTPS 节点一键安装的证书缺环）

- 面板生成的安装命令在**提示粘贴 token 之前**先校验证书文件与安装环境；缺失时立即失败并
  打印可直接复制的 acme.sh 签发命令，不再让用户先粘贴 token 才在最后一步报错。
- 裸 IP + HTTPS 入口明确阻断，提示改用域名或 Cloudflare Tunnel，不降级为自签/明文。
- 修正「同时安装 Caddy 会自动签 Let's Encrypt」的误导文案：Caddy 只装软件包，不会写
  Agent 证书；`--tls-cn` 仅在自签时生效，非自签时 install.sh 明确警告并忽略。
- runbook §4.1 增加方案 A 的 acme.sh DNS-01 / HTTP-01 完整命令与 80/443 端口说明。

### Agent 0.1.24

- `install.sh` 证书缺失提示补齐 acme.sh 完整命令；`--tls-cn` 在非自签模式下不再静默忽略。

## [0.5.8] - 2026-11-07

### Fixed（接入方式补首选路由）

- 节点「修改接入方式」抽屉新增**首选路由（直连 / 隧道）**：两种入口都配置时明确选择
  控制面走哪一条，保存后立即按新路由探测；选择隧道但未填隧道入口时内联报错。
- 回归：只改名时不再连带提交 `endpoint`，避免存量 http 节点被生产 TLS 门禁误拦。

## [0.5.7] - 2026-11-07

### Fixed（节点接入与 Cloudflare DNS 的四处体验缺口）

1. **设置 → Cloudflare DNS 能看到已有解析**：凭据抽屉里每个已勾选 Zone 增加「查看解析
   记录」，按需展开只读 A/AAAA/CNAME（名称/内容/代理/被哪个节点绑定/面板代建）；
   「重新拉取 Zone」同时刷新已展开记录并 toast 报条数，权限/网络错误内联可重试。
2. **域名节点默认 443 入口**：创建节点选用已有记录时，接入地址固定生成
   `https://<记录名>[:端口]`，端口默认 443（省略），可选 443/8443/2053/2083/2087/2096，
   并在表单里只读预览，不再沿用 IP 模式的 8880/http。
3. **已添加节点可改接入方式**：节点设置「Agent 与接入」新增「接入方式」卡与抽屉，
   支持改名、域名（默认 https 443）或自定义地址、隧道入口、首选路由（直连/隧道）；
   PATCH `/nodes/:id` 契约补 `domain`，保存即时生效，离线也可改。
4. **删除节点总有卸载脚本**：删除确认不再提供「是否生成」开关，删除前总会由控制面
   生成卸载脚本（不依赖节点在线），失败时抽屉内给出失败原因与手工兜底；节点离线时
   「卸载 Agent」按钮也保持可用。安装抽屉补充「重装覆盖程序/token、保留 `/etc/khc`
   应用配置、`--purge` 才删数据」说明。

## [0.5.6] - 2026-11-07

### Changed（两个面板入口同时放行，不再二选一）

`LIVE_ORIGINS` 原来只写了 `https://panel.example.com`。但 `panel.example.com` 是 CDN 域名，
`<worker-name>.<account>.workers.dev` 是 Workers 原生域名，**两个入口地位对等、
都要能用**——只配一个，从另一个入口打开面板时浏览器的跨域观测请求会被 Agent 按
Origin 403（表现为页面顶部「实时观测不可用」，0.5.5 真机已复现）。

- `[vars] LIVE_ORIGINS` 改为逗号分隔的两个 origin：
  `https://panel.example.com,https://<worker-name>.<account>.workers.dev`。
- 同一份配置同时用于两处，语义保持一致：CSRF 写请求 Origin 白名单（`app.ts`）与
  Agent 观测层 `--live-origins`（`agent_lifecycle.ts`，0.5.5 起读这里）。
- 无需改代码：多 origin 逗号拼接与空白裁剪已由 0.5.5 的回归用例覆盖
  （`agent_lifecycle.test.ts`「LIVE_ORIGINS 多个 origin 逗号拼成一个参数」）。
- 存量节点：unit 里仍是单值的，跑一次面板新生成的安装/升级命令即可补成两个。

## [0.5.5] - 2026-11-07

### Fixed（重装后节点详情页报「实时观测不可用」，安装命令写错了 Origin）

真机闭环：卸载 → 离线 → 面板生成安装命令 → 重装 Agent 0.1.23 → 节点在线，但节点详情页
顶部一直挂着：

> 实时观测不可用：直接观测入口不可达（… 或 Agent 的 KHC_LIVE_ORIGINS 未包含当前面板域名）

- **根因**：`liveObservationOptions()` 用 `new URL(c.req.url).origin` 渲染 `--live-origins`，
  而生产入口是第三方边缘，Worker 看到的回源 Host 是 `*.workers.dev`；浏览器实际用的是
  `https://panel.example.com`。两者不一致 → systemd unit 里的 `KHC_LIVE_ORIGINS` 装成了
  workers.dev，浏览器直连节点观测层的跨域请求被 Agent 按 Origin 校验拒掉（403）。
- **修复**：改为优先读 `[vars] LIVE_ORIGINS`（对外入口白名单，与 CSRF 白名单同一份事实），
  多个 origin 逗号拼接；**只有未配置时才退回请求 origin**（本地 dev / 测试行为不变）。
  旧节点 unit 里没有 `KHC_LIVE_ORIGINS` 时 Agent 不校验 Origin，所以存量节点不受影响，
  下次升级/重装命令会顺带纠正。
- 回归测试：`agent_lifecycle.test.ts` 新增「配置 `LIVE_ORIGINS` 时用它而不是回源 Host」
  与「多 origin 逗号拼接、空白裁剪」两条；原用例明确为「未配置 → 退回请求 origin」。
- 影响面：只影响**新生成**的安装/升级命令文本，不改 Agent 行为，不涉及版本协商与升级流程。

## [0.5.4] - 2026-11-07

### Fixed（离线时不能生成安装命令 → 卸载成了单程票）

真机卸载测试：在 node-test-2 上执行完 UI 生成的卸载命令（`uninstall.sh --system`，unit 与
`/opt/khc-agent` 都被删掉）后，节点自然变成离线；此时回到面板点「安装 Agent → 生成命令」，
得到 **「控制面无法访问 Hub，写操作已禁用」**，无法重装。

- **根因**：前端写闸门 `apps/web/src/data/writeGuard.ts` 把 `/nodes/:id/agent/install-command`
  当成"执行类"（要转发给 Hub）拦截。它其实只读 D1（解密 token）+ 发布清单，**返回一段给人
  在节点上粘贴的文本，完全不触达 Hub**。
- **修复**：把 `install-command` / `uninstall-command` 加入放行名单（离线时正是因为要装/卸才
  需要它）。真正的执行类（`/agent/upgrade`、`apply`、`plan` 等）仍然拦截。
- 回归测试：`writeGuard.test.ts` 增「离线放行生成安装/卸载命令，但仍拦截下发升级」。

### Fixed（CI 时序用例偶发耗尽，连拦两次部署）

`apps/api/test/apps-actions.test.ts` 的 `driveUntilSettled` 假时钟推进上限 200 步，在 main 的
高并发 CI 上连续两次挂掉「传输超时 + 同一幂等键重试」这条最长用例（PR 上同代码却通过）。
放宽到 800 步——只影响失败时的耗时，不改变语义；单独跑该文件 6/6 通过。

## [0.5.3] - 2026-11-07

### Fixed（批量探测被 `socket.close()` 拖到 20 秒）

「打开即探测」上线后实测 `POST /nodes/probe` **稳定 19.8 秒**（curl 与浏览器一致），页面要转 20 秒才出结论。

- **根因**：`apps/api/src/lib/tcp-fetch.ts` 的 `finally` 里 `await socket.close()`。对**黑洞主机**
  （SYN 被丢、连接一直挂在 TCP 重传）`close()` 会等到系统层 connect 超时才 resolve（实测 ~20s）。
  于是 3s 的超时定时器早就触发、错误也记下了，请求却仍陪跑满 20s。
- **修复**：改为 `void socket.close()`（只发起、不等待）。close 幂等，连接资源由运行时回收。
  同时补回归测试 `apps/api/test/tcp-fetch-timeout.test.ts`：用永不 resolve 的 `close()` 模拟黑洞主机，
  断言 `tcpFetch(timeoutMs=120)` 在 1s 内以 `TcpTimeoutError` 收场（改回 `await` 时该用例会挂死，
  已验证能抓到旧实现）。
- 影响面：所有走 TCP 通道的节点调用（`/state`、`/snapshot`、host-ops、探测）在节点不可达时
  不再被迫等 20 秒。

## [0.5.2] - 2026-11-07

### Fixed（**Agent 0.1.23**：回环自检豁免，修掉"升级永远回滚"）

0.1.22 只给**新版**看门狗模板加了自检头，实测仍回滚——因为**看门狗脚本是升级前由旧版本
（0.1.18）生成的**，旧模板不会凭空长出这个头。0.1.18 → 0.1.22 依旧在 65 秒后被判不健康并回滚。

- **改为按来源豁免**：`127.0.0.1` / `::1` / `::ffff:127.0.0.1` 发起的请求跳过面板版本协商
  （HMAC 仍照验，只有持节点 token 的本机进程能过来）。这样无论看门狗脚本由哪个旧版本生成，
  升级后的新 Agent 都不会把它判成 426。
- 自检头 `X-Khc-Self-Check: 1` 保留（对未来来自非回环的自检有用）。
- 测试：新增 `SelfCheckSourceTests`（回环无头 → 200；同请求来自 `203.0.113.9` → 仍 426），
  版本协商负例类显式关闭回环豁免（`SELF_CHECK_SOURCES = ()`），避免测试恒真。
- **Agent 0.1.23 出包重签**（sha256 `708cf649b46a…`），退役 0.1.20。

### Fixed（**Agent 0.1.22**：看门狗自检头 —— 不足，已被 0.1.23 取代）

真机升级测试暴露的**严重回归**（0.1.21 引入）：升级到 0.1.21 后一切正常，但 **63 秒后自动回滚到 0.1.18**，
连续两次复现，且第二次全程没有人为干预。

- **根因**：升级流程会安排一个 30s 的看门狗做健康检查，它除了 `GET /health`，还会用 node token 调
  `GET /state` 验证"适配器没半坏"。0.1.21 起 `/state` 要求 `X-Khc-Panel-Version ≥ 0.4.0`，
  而看门狗**不是面板、不带这个头** → 被 426 `panel_too_old` 拒绝 → 看门狗判定"新版本不健康"
  → 停服务、恢复 `.prev`、重启旧版。**结果：任何节点都升不到 0.1.21。**
- **修复**：
  - Agent 侧新增自检豁免头 `X-Khc-Self-Check: 1`：带该头时跳过版本协商（**HMAC 仍然照验**，
    不豁免鉴权，只有持节点 token 的本机进程能用）。
  - 升级看门狗脚本的 `/state` 自检请求带上该头。
- **Agent 0.1.22 出包重签**（sha256 `c990254c02f9…`）。
- 回归测试：`test_http.py` 增"自检头跳过版本协商"与"自检头仍要求 HMAC"；
  `test_tls_transport.py` 断言看门狗脚本必须带自检头。

### Fixed（假在线：探测未出结论时不再信任列表租约）

真机验证抓到的第二个问题：在 node-test-2 上 `systemctl stop khc-agent` 之后，
面板列表仍显示「**在线** · 43 秒前」，实际节点已经停了。

- **根因**：`/nodes` 返回的 `status` 是「最近一次成功探测是否新鲜」（D1 租约），
  而 0.5.0 的探测合并逻辑在**本次探测还没返回**时直接沿用列表 status，
  租约窗口内的旧记录就被当成"在线"。
- **修复**：`useHubProbe` 不再信任列表 status——没有本次探测结论的节点一律置为 `unknown`，
  由 `hubStatusView` 呈现「探测中…」；只有本次探测给出 `reachable` 才显示在线/离线。
  统计数字（在线/离线计数）同步改为只以本次探测为准。
- **回归测试**：新增「列表租约仍是 online 但本次探测未返回：不显示在线」用例，
  并验证探测返回 `reachable:false` 后落到「离线」。

## [0.5.1] - 2026-11-07

### Fixed（探测中的文案不再"报喜"）

0.5.0 上线后浏览器采样发现中间态自相矛盾：探测还在进行时，卡片显示「节点总数 **0 / 2**」，
副标题却写「所有节点都在正常运行」，页面摘要也是同一句。

- 探测进行中（`phase === 'probing'`）：
  - 页面摘要改为「正在探测节点状态…」；
  - 「节点总数」数值显示 `— / N`（避免把"还没探测出结果"读成"0 个在线"），副标题显示「探测中…」。
- 探测完成后再按实际在线/离线与告警数给结论，口径不变。

## [0.5.0] - 2026-11-07

### Changed（节点状态：打开即探测，彻底去掉「未探测」）

主人反馈："首页打开的时候不是要主动探测一下么？为什么还有未探测"——原实现确实分裂：
概览页自动批量探测，**列表页完全不探测**（靠 D1 租约显示「未探测」），且概览页在探测返回前
的首屏也会闪一下「未探测」。

- **新增 `apps/web/src/data/useHubProbe.ts`（两页共用）**：
  - 挂载即 `POST /nodes/probe` **批量探测**（一次请求覆盖全部节点，不 fan-out；
    列表页原先逐节点打 `/state` 的实现已删除）；
  - **15s 内复用结果**：概览 ↔ 列表来回切换不会重复探测；
  - 探测结论同步回 `['hubs']` 列表与 `['hubs', id]` 详情缓存，侧栏/详情页口径一致。
- **用户可见状态只剩三种**：`探测中…` / `在线` / `离线`。
  - 「从未探测」「租约过期」「探测还没返回」统一呈现为 `探测中…`，从第一帧起就不会出现「未探测」；
  - 只有**探测请求整体失败**（控制面/网络异常）才显示「未知」+ 顶部横幅「状态探测失败」。
- **删除 `未探测` 文案与「未探测节点」卡片**：后者改为「**最近探测**」，值为相对时间
  （刚刚 / 2 分钟前），副标题说明"打开页面自动探测 · 失败可手动刷新"。
- **「刷新状态」语义改为强制再探一轮**（绕过 15s 复用），不再拉列表 + 逐节点 fan-out。
- 后端 `status: unknown`（从未探测或租约过期）**保留在数据层**——它是事实，只是不再直接暴露。

### 测试

- `hubsStatus.smoke.test.tsx` 重写为 4 项：打开列表页即探测一次且全文不出现「未探测」、
  探测挂起期间三行都是「探测中…」、探测整体失败落到「未知」+ 横幅、手动刷新强制再探。

## [0.4.0] - 2026-11-07

### Added（版本协商：Agent 自检面板版本）

- **协议头**：面板在每次 HMAC 请求里附 `X-Khc-Panel-Version`（值 = `APP_VERSION`，**不参与签名**，
  签名串仍是 `method|path|ts|nonce|bodyHash`，与 Agent 端契约不变）。
- **Agent 侧自检**：新增 `MIN_PANEL_VERSION = "0.4.0"`（`agent/khc/util.py`）。鉴权通过后校验
  面板版本，不满足返回 **426 `panel_too_old`**，`details` 带
  `reason`（`panel_too_old` / `panel_version_missing` / `panel_version_invalid`）+
  `panelVersion` + `minPanelVersion` + `agentVersion`。
  - 校验顺序：先 HMAC 再版本 —— 未授权请求得 401，不会暴露"版本要求"。
  - `/health` 与浏览器直连观测 `/_live/snapshot` 豁免；`/health` 现在返回 `minPanelVersion`，
    排查时直接能看到要求值。
  - 预发布版本按 semver 视为更旧（`0.4.0-rc.1 < 0.4.0`）。
- **面板侧可读化**：`node-client` 把 426 `panel_too_old` 信封改写成
  「节点 Agent 0.1.21 要求面板 ≥ 0.4.0，当前面板 0.3.0；请先升级面板（Agent 已拒绝本请求，未执行任何动作）」；
  `/state`、`/snapshot` 对 426 单独给文案，不再报成「返回格式不合法」。
- **Agent 0.1.21 出包并重签**（`VERSION` 0.1.20 → 0.1.21，`release-manifest.json` 重签）。
- **升级顺序（必须遵守）**：**先升面板，后升 Agent**。反向顺序会让新 Agent 拒绝旧面板的请求
  （426），这也是该机制的设计目的——把静默的协议错配变成明确报错。

### Changed

- `agent/tests/support.py` 的签名夹具默认带 `X-Khc-Panel-Version = MIN_PANEL_VERSION`，
  既有用例无需逐个修改；新增 `panel_version=` 参数用于版本协商负例。
- 新增 `agent/tests/test_version_gate.py`（parse_version / compare_versions / header_value 纯函数）。
- 新增 `PanelVersionNegotiationTests`（8 项：等于/高于/低于最低版本、缺头、非法版本、
  预发布、`/health` 豁免、鉴权先于版本）。
- 兼容矩阵在 `docs/engineering/release.md` §1.1 补双向口径（面板 0.4.x ↔ Agent 0.1.21）。

## [0.3.0] - 2026-11-07

### Added（发版分层，ADR-0013）

- **面板版本单一来源**：`package.json` 的 `version` + `khcRelease` 成为唯一来源，
  `apps/web/src/version.ts` 与新增的 `apps/api/src/version.ts` 都从它读取；删除
  `apps/api/src/app.ts` 里硬编码的 `APP_VERSION`。此前两处硬编码靠人同步，实际结果是
  面板版本自 2026-10-31 起再未更新（8 天的功能全压在 `v0.2.0 · 2026-10-31` 下）。
- **构建标识（L3 溯源）**：`wrangler.toml` 启用 Cloudflare 官方 `[version_metadata]`
  binding；`wrangler deploy --tag <commit sha 前 12 位> --message` 由 CI 注入（本地
  `pnpm deploy` 也带 tag）。`GET /api/v1/version` 与 `/api/v1/health` 现在返回
  `commit` / `builtAt` / `versionId`（全部 optional，旧客户端不受影响），
  线上可以直接反查到提交与 Worker Version ID。
- **发布锚点（L1）**：CI 在每次成功的生产部署后自动打 `release-<khcRelease>` 标签
  （同日多次发布自动加 `-2`/`-3`），注解记录「面板版本 / Agent 版本 / Worker Version ID /
  提交」。此前仓库 0 个 tag，线上只有 CF Version ID，无法回答"这是哪个提交、回滚到哪"。
- **面板 bump 门禁**：新增 `scripts/check-release-consistency.mjs`
  （规则 P1：`apps/(api|web)/src` 非豁免文件变更 ⇒ `package.json` version 必须变；
  P2：版本变更 ⇒ CHANGELOG 必须有对应版本段；P3：`[skip-release]` 可豁免纯内部整理），
  与 `--repo` 静态自检（semver/日期合法、CHANGELOG 有当前段、版本来源不得回潮为硬编码）。
  接入 `ci.yml`（PR 与 main 都跑）与 `scripts/verify.sh`。
- **测试**：`scripts/test/release.test.ts`（semver 比较、日期校验、bump 档位、CHANGELOG 解析、
  功能代码判定、豁免标记、以及两个脚本对当前仓库自洽）。

### Changed（产物留存）

- **旧 Agent 包退役**：新增 `scripts/prune-agent-packages.mjs`，保留「当前 VERSION + 清单登记版本
  + 最近 N-1 个」（默认 3 个，绝不删清单指向的包），`--check` 接入 CI 与 `verify.sh`。
  本次执行一次：`apps/web/public/agent` 由 18 个包 / 3.3MB 收敛到 3 个包（0.1.18/0.1.19/0.1.20）/
  652KB，减少每次部署的 assets 上传量。
- **文档**：新增 `docs/engineering/adr/ADR-0013-release-layering.md`（三层模型：发布单元 /
  产物版本 / 构建标识，含 semver 语义表与门禁清单）；重写 `docs/release-versioning.md`
  为面板 + Agent 统一口径；`docs/engineering/release.md`、`docs/agent-releases.md`、
  `docs/README.md` 索引同步。
- **Agent 本批不动**：未修改 `agent/` 运行时代码，`VERSION` 保持 `0.1.20`、包不重出。
  这正是分层的目的——面板发版不必连带 Agent 出包。

### Fixed（发布锚点取证）

- **标签注解取权威 Version ID**：`Tag release` 原先从 `https://panel.example.com/api/v1/version`
  curl 取 `versionId`，实测在部署后立刻取值会拿到**上一个版本**的 ID（边缘回源有传播延迟，
  2026-11-07 首次落地即命中：注解写 `756bb1e7…`，实际是 `9816f651…`）。改为从 `wrangler deploy`
  输出的 `Current Version ID` 取，由 Deploy 步骤通过 `$GITHUB_OUTPUT` 传给下游。
- **`Verify production entry` 增加溯源断言**：轮询（最多 60s）要求线上
  `/api/v1/version` 的 `commit` 等于本次提交前 12 位、且 `versionId` 等于 Deploy 输出的 Version ID，
  不等即失败并提示"部署未生效或 version metadata binding 未绑上"。这是 L3 构建标识
  **真的生效**的硬证据，而不是只看 HTTP 200。

### Fixed（2026-11-07 上线事故：`workers_dev = false` 导致整站 404，已修复并加门禁）

> 承接下方「2026-11-07 TODO 收口批次」。该批已合并 main（`f59ed9b`，PR #86）并触发部署 run `42267241348`，`Deploy` 成功但 `Verify deployed agent package` 失败。

- **现象**：部署后 `Verify deployed agent package` 报「线上包 sha256 `e3b0c44…` ≠ 本次构建 `baa400e8…`」。`e3b0c44…` 是空文件 sha256 —— curl 实际拿到 404 空体，**不是包不一致**。
- **实际影响**：`https://panel.example.com` 上**所有路径**（`/`、`/api/v1/health`、`/api/v1/version`、`/agent/*`）返回 `404` + `error code: 1042`，即整站不可用，持续约 3.5 小时（18:06Z 起）。
- **根因**：生产入口 `panel.example.com` 不是 Cloudflare Workers 自定义域名，而是第三方边缘 —— `CNAME <edge-host> → 203.0.113.16`（`server: Edge/1.1.35`），其**回源 Host 就是 `<worker-name>.<account>.workers.dev`**（`curl https://panel.example.com/cdn-cgi/trace` → `h=<worker-name>.<account>.workers.dev`；直连该 workers.dev 域名返回与站点**完全一致**的 404/1042）。§3.7 把 `workers_dev` 置 `false`，等于关掉生产入口的源站。
- **修复**：`wrangler.toml` 回滚 `workers_dev = true`（保留 `preview_urls = true`）并加显著注释说明拓扑；重新部署后生产 5 个入口全部 **200**，线上 `khc-agent-0.1.20` sha256 与仓库一致（`baa400e85f45…`）。
- **新增两道门禁**（`.github/workflows/ci.yml`）：
  - 部署前 **Guard deploy topology**：用 `/cdn-cgi/trace` 的 `h=` 实测生产入口真实源站，若命中 `*.workers.dev` 且配置为 `false` 则 `exit 1` 阻断部署（本地已跑正/反例验证）。
  - 部署后 **Verify production entry**：先判 `health=200 && ok:true`、`version=200`，失败时打印 health 体 / trace / 直连 workers.dev 响应头，避免整站故障被误报成 sha 不符；随后 `Verify deployed agent package` 同时校验 HTTP 200。
- **为什么原门禁没挡住**：部署前冒烟查的是 `wrangler versions upload` 的预览 URL（版本级入口，不受 `workers_dev` 影响），必然通过；故障只在 `wrangler deploy` 应用配置的瞬间产生。
- **遗留**：§3.7 的原始诉求（关闭 workers.dev 直接访问）在当前拓扑下不可执行，需先把 Worker 挂上真正的 Cloudflare 自定义域名、再改第三方边缘源站；见 `docs/TODO-2026-11-06.md` §3.7 与 `docs/auto-deploy.md`「事故记录 2026-11-07」。
- 证据：`docs/verification/2026-11-07/incident-workers-dev-as-origin.md`。

### Changed（2026-11-07 TODO 收口批次，多 Agent 并行，文档最终收口）

> 本批落在分支 `feat/todo-closeout-2026-11-07`（基线 `2668075`），已 squash 合并 main（`f59ed9b`，PR #86）并部署；上线结果见上方「Fixed（2026-11-07 上线事故）」。

- **§3 挂账 8 项全部落地**（详见 `docs/TODO-2026-11-06.md` §3，各条带「✅ 2026-11-07 已落地」标注与改动文件）：
  - **3.1 cooldown 失效**：模块级 `WeakMap`（以 `env.DB` 为键）缓存 `{ agent, app }` 单例，单 isolate 内跨请求共享 cooldown Map 与 snapshot inflight 去重，未引入 KV/DO；决策见 ADR-0012。
  - **3.2 生产强制 TLS**：`nodes.ts` 对新建/改 `http://` 明文 endpoint 返回 `insecure_endpoint`；存量 `http://` 节点不阻断，不破坏共享契约与存量数据。
  - **3.3 recipe 下载源签名**：catalog 强制 `https` + `sha256` 校验、`install.sh` 前置校验；`docker` 模式可省略 `sha256` / `downloadUrl`，**`binary` 模式脚本层强制**二者并校验（缺 `sha256` 即中止、不安装不启服务）。附带修复 `/tmp` 运行时 recipe 路径重复与 `PARAM_KEY_RE` 放宽。
  - **3.4 TOTP + 会话撤销**：新增 `apps/api/src/lib/totp.ts`；settings 加密表 3 个 key（`auth.totp_secret` / `auth.totp_pending` / `auth.session_epoch`）；session 引入 `ver` epoch，启用/禁用 TOTP 或 `POST /auth/logout-all` 递增版本即撤销全部既有会话；旧 cookie 部署后仍有效直至 8h 自然过期。
  - **3.5 host-ops Peer 收窄**：新增 `E_PEER_FORBIDDEN`，Peer 拒绝 `keys.add` / `keys.remove`、`cron.set`、`fw.apply` / `fw.confirm`、`cleanup`；Hub `self` 不变。
  - **3.6 CI 部署前冒烟**：`wrangler versions upload` + 预览 URL `health` / `version` 冒烟，失败阻断 deploy。
  - **3.7 `workers_dev = false`**：~~关闭 `.workers.dev` 暴露，部署后校验 URL 改固定自定义域名~~ → **已回滚为 `true`**：生产入口的源站就是 workers.dev，关闭后整站 404（见上方「Fixed（2026-11-07 上线事故）」）。`preview_urls = true` 保留。
  - **3.8 接入方案化改造**：`orderedRoutes()` 只返回选定方案单一目标、删跨路由重试与 `onRouteSuccess` 自动回写；三种并列方案、节点选定其一、无跨方案回退；同方案内 `fetch` → TCP 双通道保留。
- **P0 收尾实测**（`docs/verification/2026-11-07/p0-closeout.md`）：apply 同 `idempotencyKey` 两次响应完全相同、`exec_counter` 不变；失败自动回滚（500 `apply_failed` + `rolledBack:true`，文件恢复 `ORIGINAL`）；证书过期 `curl(60)` / `ssl_verify_result=10`；主机名不匹配 `curl(60)`；断隧道 530（CF Tunnel error 页）均实测通过。**仍未测**：Access Service Token 403（缺 CF 账号 / 具名隧道 / Service Token）、方案 C `caPool` / `originServerName` / 默认校验（需具名隧道凭据）、「失败不切换」验证（§3.8 代码已落地、验证待补）。
- **P5 三项结论（F 评估）**：D1 状态对齐「不做，已实现」（`state.py` 已含 `host` / `adapters` / `ports` / `ops` / `agent`，契约 `.passthrough()` 无需改）；直连观测改协议「不做」（ADR-0010 已定 10s 轮询，改协议须新 ADR）；隧道实现 / 自动降级「不做，与 ADR-0012 冲突」。详见验证报告 §4。
- **加密批次暂缓**：主人 2026-11-07 明确「加密的事情放一放，暂时不做」；§2 P1 的 14 个 `[ ]` 保持未勾，不得由后续 Agent 擅自开工。
- **附带发现已修**：① 添加节点抽屉文案改为「隧道地址（方案 B）」+「并列方案不会自动切换」（`apps/web/src/i18n/zh.ts`）；② `/tmp` 运行时 `app-catalog` recipe 路径重复 `demo-echo/demo-echo/install.sh` 已修复（`agent/khc/recipes.py` 路径拼接 + `PARAM_KEY_RE` 放宽）。
- **Agent 0.1.20 出包**：本批改动了 `agent/recipes/*`、`agent/khc/recipes.py`、`agent/adapters/host_ops.py` 等运行代码，按发布防漂移规则 bump `VERSION` 0.1.19 → 0.1.20，重新出包并用仓库外 Ed25519 私钥重签 `release-manifest.json`（sha256 `baa400e85f45…`，URL 带 `?v=baa400e85f45`）；脚本内 `--repo` 自检确认包内 Agent 源码与仓库 `agent/` 逐文件一致，签名密钥未变，生产 `AGENT_RELEASE_PUBKEY` 无需改动。
- **文档收口**：47 个过时复选框统一改 `[x]` 并加注记；新建 ADR-0012 并登记 `docs/README.md` 索引；`docs/README.md` 工程流程表登记本批验证报告；`docs/design-v3.md` §1.1、`docs/security-boundaries.md`、`docs/runbook/node-onboarding.md` §4.1 的「待批次 B 改造 / 仍是双路由回退」注记更正为「已按 ADR-0012 落地」。

### Added（2026-11-07 Worker/面板侧真实调用验证通过）
- 用 ego-browser 登录面板，新建测试节点 `p0-scheme-a`（`https://203-0-113-10.sslip.io:8443`），用面板签发的一次性令牌在测试 VM 上启动 Agent + Caddy（复用 Let's Encrypt 证书）。
- 面板 Worker 经 `fetch()` 真实调用：`GET /nodes/<id>/state` **200**（`reachable:true / route:direct / via:fetch`，返回完整主机状态）、`GET /nodes/<id>/apps` **200**；UI「刷新状态」后节点**在线**。至此方案 A 的「Worker → HTTPS 可信证书 → Agent → HMAC 鉴权」全链路闭环。
- 测完清理：删除测试节点（D1 恢复为原有 2 个）、回收 VM 临时进程、关闭浏览器任务空间。
- 附带发现（2026-11-07 已修复）：添加节点抽屉文案已改为「隧道地址（方案 B）」+「并列方案不会自动切换」（`apps/web/src/i18n/zh.ts`），不再与三种并列方案口径冲突；`/tmp` 运行时 `app-catalog` recipe 路径重复（`demo-echo/demo-echo/install.sh`）已修复（`agent/khc/recipes.py` 路径拼接 + `PARAM_KEY_RE` 放宽），已不再复现。
- 详见 `docs/TODO-2026-11-06.md` §2 P0 实测记录与上方「2026-11-07 TODO 收口批次」。该次验证为只读实测记录；两项 UI/脚本修复由并行代理落地，未触发部署。

### Added（2026-11-07 P0 方案 A 端到端补测通过）
- 主人放行 443/8443 并补充 IPv6 `2001:db8::10`（双协议栈）。确认此前 443/8443 测 closed 的根因是 **VM 无进程监听**而非防火墙；`ssh -6` 与双栈 80 直连（绕过本机代理）均验证可用。
- 用 `/tmp` 临时 Caddyfile 起第二实例（`http_port 8080`、`admin off`、独立 `XDG_DATA_HOME`，**未改系统 Caddyfile**）反代 Agent，自动 ACME 为 `203-0-113-10.sslip.io` 签发 **Let's Encrypt** 证书（YE2，有效期至 2027-02-04）。
- 本机公网客户端实测：443 与 8443 的 `/health` **200 + ssl_verify=0**、无签名 `/state` **401**、HMAC `/state` **200**（两端口，返回 `adapters/agent/host/ok/ops/ports`）；443 耗时 0.5s。
- 测试后临时 Caddy、Agent、脚本全部回收，443/8443 已释放，仅原有系统 Caddy（80）保留。方案 A / B / C 三种并列方案均已有节点侧或端到端实测证据；仍未测面板/Worker 侧真实调用（需登录与节点记录）。见 `docs/TODO-2026-11-06.md` §2 P0 实测记录。

### Added（2026-11-06 P0 三种接入方案真机验证，境外测试 hub）
- 在 `test-hub 203.0.113.10`（Debian 12 / Python 3.11.2）实测：Agent 0.1.19 的 HTTP 与自签 TLS 监听、HMAC 鉴权（无签名 401 / 正确签名 200）、SIGHUP 证书热重载（指纹变化）；cloudflared 连接前检查全 PASS 并注册 `sin13/quic`；Quick Tunnel 经 CF 可信证书端到端 `/health` 200 / HMAC `/state` 200（VM 与本机两个公网客户端）；自签源站加 `--no-tls-verify` 得 200。
- 结论：方案 B 链路成立；方案 C 自签需显式信任源站证书；方案 A 因该 VM 仅放行 80、所有 HTTPS 入站端口 closed 而未端到端完成，放行 443/8443 后可补测。
- 完整实测数据、未测项与进程回收说明见 `docs/TODO-2026-11-06.md` §2 P0 实测记录、`docs/runbook/node-onboarding.md` §4.1。仅文档与测试，未改产品代码、未触发部署。

### Changed（2026-11-06 接入方案口径纠偏，仅文档）
- **口径修订**：控制通道由「D-3 直连首选 / Tunnel 备用 + 失败自动回退」改为**三种并列接入方案**——A `https` + 域名 + 公网可信证书直连、B Cloudflare Tunnel、C `https` + 域名 + 自签；每台节点创建/配置时**选定其一**，运行时只走所选方案，失败即报错，**无主备关系、无跨方案切换**。
- **地域口径**：cloudflared 主动出站到 Cloudflare 边缘，节点在境内境外机制相同；P0 验证不再要求国内节点，备案/端口限制只是「选方案 B」的理由，不是运行时切换的触发条件。
- **方案 C 边界**：Worker 直连自签在平台侧不可行（`fetch()` / `cloudflare:sockets` 一律校验证书，无跳过校验或自定义 CA 开关）；可行形态是把自签放在 Tunnel 源站段（`caPool` / `originServerName`）或 Workers VPC 私有服务段，Worker 侧始终面对可信证书。
- **实现差距如实登记**：`apps/api/src/lib/node-client.ts` 目前仍是 `orderedRoutes()` 双路由 + `onRouteSuccess` 自动回写 `preferred_route` 的历史主备实现；改为「选定方案、无跨方案重试」涉及核心传输层与契约，按 `AGENTS.md` 红线 1 需先出方案 + ADR 并拍板，登记在 `docs/TODO-2026-11-06.md` §3.8。本次**不改代码**。
- 同步文档：`docs/design-v3.md` §1.1/§9、`docs/security-boundaries.md` §1、`docs/runbook/node-onboarding.md` §4.1/§5.3、`docs/plan-v4.md` §0.2、`docs/TODO-2026-11-06.md` P0/§3.8/§8。
- 无代码改动、未触发部署（docs-only）。

### Changed（2026-11-06 集成上线：P1 直连传输加固 + 安全批次 B + 审查批次 A）
- **集成方式**：三个已推送分支（审查批次 A `9cf6b67`、P1 `bdd14a3`、安全批次 B `77db7a1`）合并进单一集成分支 `release/2026-11-06`，一次 PR 合入 main，避免三次独立部署造成的中间态。
- **Agent 0.1.19**：Agent 支持直接 TLS 监听（`--tls-cert` / `--tls-key`，主端口复用）、SIGHUP 证书热重载、`/state.tlsCertExpiry` 到期上报；安装脚本新增 `--tls-cert/--tls-key/--insecure-http`；Worker 新增 `secure-channel.ts`，明文 `http://` 通道拒绝下发 `$cert` / `$dnsCred` 密钥（400 `insecure_channel_secret`，development 豁免）。
- **安全批次 B**：recipe 字符串参数统一加 `pattern` 白名单（防 systemd unit 注入与 http 下载源），`$dnsCred` 引用限定 `dns.` 命名空间。
- **发布清单**：用仓库外 Ed25519 私钥重签 `release-manifest.json` 至 0.1.19（sha256 `efe84e18c746…`，URL 带 `?v=` cache-buster）；已验证签名公钥与 0.1.18 清单同源，生产 `AGENT_RELEASE_PUBKEY` 无需变更。
- **文档**：`docs/TODO-2026-11-06.md` 补齐状态块并登记 `docs/README.md` 索引，更新完成状态；`docs/design-v3.md` / `docs/security-boundaries.md` 已于当日同步口径。
- **验证**：`./scripts/verify.sh` 全绿（typecheck / vitest / build / compileall / Agent 单测 / 发布一致性含包内源码比对 / catalog drift / shell 语法）。

### Fixed（服务端审查批次 A，2026-11-06）
- **卸载命令默认路径必现 500**：`agent_lifecycle.ts` 的响应回显 `body.packageUrl/sha256`（未传时为 `undefined`），而 `agentCommandResponseSchema` 要求两者非空 → `parse()` 抛错 → 500，并卡住前端「删除节点」流程的第一步。改为回显 Worker 从签名清单注入后的局部变量；新增「清单存在 → 200 且回显注入值」回归用例（此前只覆盖「清单缺失 → 503」）。
- **Agent 自身的 403 被误判为 Cloudflare 边缘拦截**：`node-client.ts` 原先对任何 403 都丢弃响应、改走 TCP 重发同一写请求，掩盖 token 不匹配等真实原因。改为仅当 403 响应体**不是**合法 Agent 错误信封时才回退；新增 403 信封 / 非信封 403 / 404 三条用例。
- **app_configs 并发保存 rev 与配置错位**：`ON CONFLICT` 无条件覆盖 `config_json` 而 `rev` 只取 MAX，乱序落库会出现「rev=6 但配置是 rev=5」。改为 `WHERE excluded.rev > app_configs.rev RETURNING rev`，被挡下时回读当前生效记录返回；新增「库内已有更大 rev」确定性用例与「app_configs.config == 对应 revision」断言。
- **CI 防漂移门禁名实不符**：`--diff origin/main` 在 push main 时恒为空差异，且 `--repo` 只核对 VERSION/sha256、不比对源码。改用 `github.event.before`（PR `base.sha` / dispatch `HEAD~1`）为基线并支持全零 SHA 兜底；`--repo` 逐文件比对包内 Agent 源码与仓库 `agent/`；`workflow_dispatch` 增加 main 分支限制；部署后校验包 URL 补 `?v=<sha12>`。
- **测试夹具**：`makeTestContext` 支持注入真实 `AgentClient`（`agentClient` 字段），默认仍为 `FakeAgentClient`；新增一条 apply 全链路集成用例，断言真实 HMAC 签名头、幂等键与 `appliedRev` 回写，且 fake 完全不参与。本批共新增 7 条回归用例（1 + 2 + 1 + 2 + 1）。
- 同步文档：`docs/engineering/release.md` §7.3、`docs/auto-deploy.md`、`docs/engineering/testing.md` §1；本批未改 `agent/` 运行代码，Agent 包与签名清单无需重出。

### Fixed（真机实测问题一次修复，2026-11-05）
- **Agent 版本**：`0.1.17 → 0.1.18`（WireGuard `status.installed` 语义修正需要随包发布），发布包与签名清单已同步入库。
- **无 body 写请求被判 415（阻塞）**：`apiRequest` 对所有写方法（POST/PUT/PATCH/DELETE）一律带 `content-type: application/json`，无 body 时发 `{}`；Worker 守卫改用 `hasEmptyBody()`，零长度 body 视为无 body（不再只看 `raw.body !== null`）。覆盖首页 `POST /nodes/probe`、`DELETE /ssh-keys/:id` 及全部 bodyless 写路由。
- **WireGuard「未安装」误判**：适配器 `status.installed` 改为表示工具链是否安装（`wg --version`），与「是否已有配置」解耦；已安装但无配置时横幅显示「尚未配置」，安装按钮仍仅在 `capabilities.pkgInstall && !installed` 时出现。Caddy 页同类语义一并校正。
- **实时观测不给死路**：直连失败时明确显示「实时观测不可用：<原因>；不会自动回退控制面快照」，并新增**手动**「读取控制面快照」按钮（一次点击只读一次，不改变 mode/status、不重启自动循环）；ADR-0010 的「不自动回退」口径不变。Caddy `liveGateway` 在 node-test-2 实际启用并验证 `/_live/snapshot`（详见 `docs/live-observation.md` §8.5）。
- **主机运维添加公钥**：抽屉补「从公钥库选择」下拉（按需读取 1 次公钥库，失败不阻塞手动粘贴），选择后填充公钥文本。
- **跨应用预取噪音**：站点页的反代 Peer 列表、内网穿透页的 port-forward 配置改为按需/已配置后请求，消除未配置节点的 404 预取。
- **证书库链接**：站点页「管理全局证书库 →」补 `?tab=certs`。
- **远程升级包地址**：签名清单里的包 URL 少了 `/agent` 前缀，节点下载到 SPA HTML 后退回 `sha256_mismatch`；已按 `PUBLIC_BASE=https://<worker>/agent` 重建清单，并在 `build-agent-release.sh` 增加「PUBLIC_BASE 必须以 `/agent` 结尾」的校验。包 URL 同时带 `?v=<sha 前 12 位>`，避免同名包重建后 CDN 命中旧字节再次触发 `sha256_mismatch`。

### Changed（Agent 发布清单随部署发布，ADR-0011，2026-11-05）
- **消除发版手动尾巴**：签名清单入库 `apps/web/public/agent/release-manifest.json`，随 Worker assets 与包同一次部署生效；Worker 读取时**静态资源优先**，`AGENT_RELEASE_MANIFEST` secret 仅在清单缺失时兜底，不再需要每次 bump 版本手动 `wrangler secret put`。
- 清单存在但 JSON 损坏/验签失败 → 明确报错（503 `release_manifest_invalid` / 403 `release_signature_invalid`），不静默回退；`GET /api/v1/agent/releases` 契约与鉴权行为不变；A-5 转发给 Agent 的清单原文同样来自该来源。
- CI 防漂移：`scripts/verify-agent-release.mjs --repo` 用 Agent 内置公钥验签仓库清单，并核对清单包含当前包 sha256。
- 单测：`apps/api/test/agent_lifecycle.test.ts` +4（清单优先/缺失回退/签名不匹配/JSON 损坏）；`apps/api/test/verify-agent-release.test.ts` +2。

### Fixed（Agent 任务终态落盘与测试清理竞态，2026-11-05）
- **根因**：`Task.fail/finish` 先在锁内置终态、随后才 `_persist_task()` 写 `<data>/tasks/<id>.json`；测试只轮询到终态就 `TemporaryDirectory.cleanup()`，与落盘线程并发，CI 偶发 `OSError: [Errno 39] Directory not empty: 'tasks'`。
- **修复**：`TaskManager.join_all()` 供 Agent 关闭/夹具 teardown 等待线程；`wait_task` 在返回终态前 join；port-forward / host-ops / certificates / http 夹具清理前统一 join；移除 host-ops/certificates 的 `ignore_cleanup_errors=True` 掩盖。
- Agent 0.1.16 出包入库 `apps/web/public/agent/khc-agent-0.1.16.tar.gz`。

### Changed（观测通道改为 10s 快照轮询，验证分支，2026-11-04）
- **ADR-0010（方案 A）**：页面可见时每 10 秒拉一次轻量快照，隐藏立即停；10 分钟或 60 次到顶停表并显示「已停止自动刷新 · 数据截至 xx:xx」+ 手动刷新。**SSE/`/_live/` 前端引用停用（代码保留不可达）**，避免两套机制并存。
- **Agent 新增 `GET /snapshot`**（HMAC）：只读 `/proc` + `statvfs`，返回 CPU/内存/磁盘/负载，不起子进程、无常驻线程；CPU 计数器差分，首次/过久/过快时请求内双采样 1 秒。
- **直连/转发选路**：有可信 HTTPS 域名 → 浏览器直连 `/_live/snapshot?ticket=`（snap 票 15 分钟可复用 + `Access-Control-Max-Age: 600`）；无域名 → Worker `GET /nodes/:id/snapshot` 转发（同节点 2 秒去重、5 秒超时）。
- **请求预算**：直连每次会话仅 1 次 Worker 签票 + 0 次轮询转发；无域名转发每标签页每次会话 ≤60 次 Worker 请求（打开 1 次 + 每 10 秒 1 次）；重数据 `/state` 仍只在打开工作区时取一次。
- **UI 文案**：`实时（10s）` / `无域名 · 仅快照` / `已停止自动刷新 · 数据截至 xx:xx`；沿用状态带与既有组件，不新增页面范式与导航层级。
- 单测：`apps/web/src/data/snapshot.test.ts`（节奏/可见性/上限/环形缓冲/失败恢复）、`apps/api/test/snapshot.test.ts`（鉴权/转发/去重/不可达）、`agent/tests/test_snapshot.py`（双采样/HMAC/轻量形状）。
- 稳定性实测与遗留风险见 `docs/verification/2026-11-04/snapshot-stability.md`；**未合并、未部署**。

### Changed（Worker 请求预算整改，2026-11-04）
- **全局关闭自动重试与自动重拉**：`QueryClient` 默认 `retry:false`、`refetchOnWindowFocus:false`、`refetchOnReconnect:false`、`mutations.retry:false`；全仓无 `refetchInterval`。
- **概览页不做按节点 fan-out**：`/` 只读 `/nodes` + `/certificates`；删除每节点 `/apps`、`/mode`、`/state` 查询与「模式」列，运行数据只在节点页或浏览器直连观测查看。
- **`/hubs` 打开不探测**：仅在点 [刷新状态] 时手动探测（1 + N 次，单次）；无自动重试，探测失败显示提示条，由用户再次手动刷新。
- **按需拉取**：Hub 运维诊断只在打开诊断抽屉时请求；证书→站点占用映射只在打开证书详情或删除确认时按节点拉取。
- **写操作进度改退避回执**：host-ops 任务 1→2→4→8s（≤120s 约 16 次）；WireGuard 模式收敛 2→4→8→10s（≤60s 约 7 次）；均可取消，不再是 1s 定时轮询。
- 请求预算：一次打开发起 1–3 次 Worker 请求（`/hubs` 手动刷新为 1 + N）；典型使用（每月约 10 次打开）每月 < 200 次。预算表见 `ADR-0009` §请求预算、`docs/data-layering.md` §7、验证报告 §26.4。
- 同步文档：`docs/engineering/adr/ADR-0009-ops-data-live-only.md`、`docs/data-layering.md`、`docs/ui-redesign/page-specs.md` §1.2/§1.3、验证报告 §26。

### Fixed（运维数据只走浏览器直连观测；控制面不再承载快照，2026-11-04）
- **删除周期性 ops 轮询与 `/state` 回退**：`HubChannelsProvider` 的 5s 探测、WireGuard 3s、Caddy/端口转发 5s 轮询全部移除；`/state` 只在打开工作区时探测一次（可达 + 写闸门 + 租约），并支持手动重试；live 断开不自动周期重试。
- **主机运维 / 运行态只来自 live**：`HubOpsPage`、WireGuard、Caddy、端口转发、Peer 运维缓存不再读取 `/state` 快照；未连接时显示「实时观测未连接」+ [重新连接]，不展示运维数据（避免实时性差与 Worker 配额消耗）。
- **观测入口自动推导**：`toPublicNode` 用 `domain` 推导 `liveEndpoint=https://<domain>`；节点设置删除手填表单、创建表单删除死字段。
- **卸载免填包信息**：卸载命令契约的 `packageUrl`/`sha256` 改为可选，Worker 用已签名最新发布包注入（无清单返回 503）；卸载抽屉隐藏这两个字段。
- **删除节点入口回到 `/hubs`**：行内第二个动作（L3 输入节点名），确认框可勾选「同时生成卸载 Agent 脚本」，删除后脚本仍可复制/下载；节点设置移除危险区，由 4 分区收敛为 3 分区。
- 同步文档：`docs/live-observation.md` §1/§6、`docs/data-layering.md` §1/§3–§6、`docs/design-v3.md` 定位、`docs/ui-redesign/page-specs.md` §1.3/§2.5/§2.6，新增 `ADR-0009`，验证报告 §26。

### Fixed（节点状态三态：未探测不再误显示为离线，2026-11-04）
- **列表状态拆成三态**：`GET /api/v1/nodes` 的 `status` 只表示「最近一次成功探测」的 300s 租约——窗口内= `online`，从未探测/租约过期= `unknown`，`offline` 不再由列表推断。前端 `/hubs` 页打开时探测一次全部节点，只有 `reachable=false` 才置离线；探测请求本身失败不当作离线证据，保持「未探测」。侧栏与节点概况沿用同一份缓存。
- **`/hubs` 增加 [刷新状态]**：手动重新拉列表并探测全部节点；失败节点 60s 自动重试、最多 3 次，恢复或手动刷新后停止，不做常驻轮询。
- 同步文档：`docs/data-layering.md`（`last_seen_at` 语义）、`docs/ui-redesign/page-specs.md` §1.3（三态与刷新边界）、验证报告 §25。

### Changed（收尾三项：安装命令去自签、CSRF 白名单、Caddy 端口自动放行，2026-11-03）
- **安装命令默认不再带 `--tls`**：域名节点自动渲染 `--with-caddy --tls-cn=<域名>`，证书由 Caddy 自动申请 Let's Encrypt；`--tls`（Agent 自签）仅在显式勾选时附加，Worker 传输层不接受自签。UI 提示、`docs/cf-dns.md`、`docs/runbook/node-onboarding.md` 同步改正。
- **写请求 CSRF 白名单可配置**：新增 `[vars] LIVE_ORIGINS`（逗号分隔 origin）。未配置时保持既有"仅同 host"行为；配置后白名单 Origin 放行、跨站伪造仍 403。`wrangler.toml` 已加入 `https://panel.example.com`。
- **caddy-site 端口自动放行**：`port_claims` 声明 `release=True`，apply 后内核自动维护 `khc-auto:caddy-site` iptables 入站规则（无需手工规则）；`siteHealth` 探测支持站点 `healthUri`（未配置仍探根路径）。
- **Agent 0.1.14**（本批改动 `adapters/caddy_site.py`，触发发版）：出包入库 `khc-agent-0.1.14.tar.gz`（sha256 `df311cb08571…`）并用既有私钥重签清单；节点升级到 0.1.14 后 caddy 站点端口由内核自动放行，不再需要手工 iptables。

### Added（DNS 与添加节点打通 + 主机运维进程默认精简，2026-11-03）
- **添加节点读取已有 CF 解析记录（只读）**：`GET /api/v1/cf-dns/records?zoneId=` 返回已启用 Zone 的 A/AAAA/CNAME；创建抽屉新增「已有解析记录」下拉，选中后域名与主机只读带入（端口可改），提交不建、不改 DNS 记录，仅把记录名写入 `nodes.domain` 并渲染 `--with-caddy --tls-cn=<域名>`。同名多条/同名 CNAME 和已绑定其他节点的记录置灰不可选；读取失败（权限/网络）提示具体原因并保留手填子域名代建兜底。权限实证：现有 Token 读取 DNS 记录 HTTP 200（9 条 A），无需新增权限；此前问题是代码未实现列记录。
- **CF DNS 多凭据/多 Zone**：`settings.cf_dns_accounts` 存多条 `{id,name,accountName,encToken,enabled,zones,enabledZoneIds}`；新增 `GET/POST /cf-dns/accounts`、`PUT/DELETE /cf-dns/accounts/:id`、`POST /cf-dns/accounts/:id/refresh`、`GET /cf-dns/zones`。一个 Token 可覆盖同账号多 Zone、不同账号分开添加；旧单 Zone `cf_dns` 首次多凭据写入时自动迁移为 `legacy` 凭据并删旧键，旧端点保留兼容。Token 仍只写不回显。
- **添加节点选域名**：迁移 `0008_node_domain.sql` 为 `nodes` 加 `domain`；创建抽屉加 [Zone | 子域名] 两格（子域名留空取节点名），创建成功后代建 A/AAAA、写 `nodes.domain`，安装命令自动带 `--with-caddy --tls-cn=<域名>`（可见可改；默认不带 `--tls`）。代建失败不阻断节点创建，抽屉内 danger Banner 写明具体原因。
- **节点概况新增「域名 / 证书状态」**：只认 Agent `caddy-site` 实测——无域名=未绑定；无站点=未签发（不会申请 ACME）；拿不到探测=「未知（Agent 未上报）」；仅 HTTPS 校验通过才显示已签发，不用绿色兜底。
- **主机运维进程默认精简（Web 层过滤）**：进程抽屉工具条加 [只看业务进程 | 显示全部]（默认只看业务）；规则依据 node-test-3 / node-test-2 实机 `/proc` 观察（内核线程按 ppid=2、系统守护进程按命令首段、snapd/oracle-cloud-agent/unattended-upgrades 按路径），表格下方 12px 灰字显示真实隐藏数，切换同步更新。**不改协议、不动 Agent、不出包**。
- 同步文档：`docs/cf-dns.md`、`docs/design-v3.md`（CF DNS 路由/0008）、`docs/engineering/d1-migrations.md`（0001–0008）、`docs/ui-redesign/page-specs.md`（设置页/创建抽屉/节点概况/进程分段）。

### Changed（D-6：删除 `wrangler.staging.toml`，上线前冒烟改用版本预览，2026-11-03）
- **删除 `wrangler.staging.toml`**：配置唯一来源改为 `wrangler.toml`（`ENVIRONMENT=production`），不再存在"staging 部署命令"。此前该文件与 `wrangler.toml` 指向同一 Worker，用它 deploy 会把生产 `ENVIRONMENT` 翻成 `staging`（实测确认线上活动版本确为 `env: staging`）。
- **上线前快速验证**（`docs/engineering/release.md` §4，新增）：`npx wrangler versions upload`（不带 `--env`）→ 预览 URL（形如 `https://<versionId 前 8 位>-<worker-name>.<账号子域>.workers.dev`）→ 冒烟 `/api/v1/health`、首页 200、登录、未登录 `/api/v1/nodes` 401 → 主人 `npx wrangler deploy`。版本预览不切生产流量、不新建独立 Worker/计费单元；预览 URL 依赖 `workers_dev = true`（已启用，**无需面板额外开关**）。
- 实测（wrangler 4.152.0）：上传成功、预览 URL 各项冒烟全通过；另发现 `/health` 是 SPA 兜底（HTML 200），**探活须用 `/api/v1/health`**，已更正 release/testing 的旧写法。
- 同步文档：`AGENTS.md` §5/§7、`README.md`、`docs/agent-releases.md`、`docs/engineering/testing.md` §3/§4、`docs/auto-deploy.md`、`docs/production-readiness.md`（B3/B4 顺带刷新为 0007/0.1.13）、`ADR-0008` 补记、计划文档 §5.1（D-6 标已完成）、验证报告 §20。

### Changed（架构整改批次 3：rev epoch 与决策落地，arch-review-remediation-2026-11-03）
- **Agent 0.1.13**（本批改动 kernel/state 内核，触发发版）：出包入库 `khc-agent-0.1.13.tar.gz`（sha256 `eb76a50adeb3…`）并用既有发布私钥重签清单。rev epoch 能力与版本绑定：节点需升级到 ≥0.1.13 才具备"旧纪元判定 + 自动重置基线"；旧 Agent（0.1.12）照常工作，按"待升级"处理。
- **D-2/T2.2（rev 分叉导致恢复流程永久 409，R-2 根因修复）**：节点记录带 **rev epoch（纪元）**——迁移 0007 为 `nodes` 加 `rev_epoch` 列并给存量节点回填随机 16 字节 hex，此后 `create()` 应用层生成；节点重建/重装/恢复 = 新节点行 = 新纪元。Worker 在 apply/rollback 载荷携带当前纪元；Agent（0.1.13+）持久化收到的纪元（`state.json` 顶层）并在 `/state` 与 apply 响应回传，**apply 发现纪元不一致即判定"旧纪元"：清除全部应用的 `appliedRev` 基线（保留配置快照供适配器钩子做增量 diff），控制面重新计数的低 rev 下发不再 409**——节点重建/D1 恢复后自动恢复，peer 不再失联，backup.md §8 SOP 第⑥步不再卡死。Worker `/state` 对比回传纪元，不一致响应 `epochStale:true`（首次 apply 后自愈）。**兼容现役 Agent 0.1.12 三态验证**：旧 Agent 忽略载荷新增字段（行为不变）、不回传纪元时 Worker 按"待升级"处理不判定、升级后首次 apply 直接采纳不清基线（现有节点零感知）。新增 agent 单测 7 例 + Worker 迁移幂等/存量回填、repo 契约、载荷、/state 三态测试。
- **D-3（传输加密口径拍板：直连首选、Tunnel 备用，只改文档不新增实现）**：四个文档统一口径——**首选公网可信证书直连**（域名/IP 证书，endpoint 填 `https://`，TLS 由平台强制校验、自签不可用，Worker 侧零配置），**备用 cloudflared Tunnel**（仅国内 VM 受备案/端口限制直连走不通时；前置条件=域名托管在 Cloudflare Free 计划，Tunnel 本体免费，Access Service Token 免费计划 50 用户额度内）。落点：`node-onboarding.md` 新增 §4.1（含明文 HTTP 仅限可信网络的如实警告）、`troubleshooting.md` §1.6 处置优先级、`security-boundaries.md` §1（明文 HTTP 无传输机密性如实表述）、`design-v3.md` §1.1（Tunnel 由"兜底"改"备用"、IP 证书路径）。不引入 provider 抽象或新代码路径。
- **D-5/T4.6（host-ops 安全边界如实化，先只改文档不做能力收窄）**：ADR-0007 与 `docs/host-ops.md`（新增 §0.1）把"Hub 失陷也拿不到 shell"改为如实表述——Hub 失陷 + host-ops 凭据 → 可在已接入 Peer 上执行白名单动词（`fw.apply`/`keys.add`/`cron.set`）：拿不到交互式 shell，**但白名单动词本身可被滥用**（`keys.add` 注入公钥后可带外 SSH 登录等价拿到 shell；`cron.set` 可带外升级任意命令执行；`fw.apply` 拦不住故意放行）。B2 的真实价值定位为"显著抬高门槛与留痕"而非"Hub 失陷无害"；`keys.add`/`cron.set` 收窄为 `target=self` 或 Peer 本地 opt-in 列为**待办不实现**，等后续拍板。

### Changed（架构整改批次 2：安全加固与可靠性，arch-review-remediation-2026-11-03）
- **Agent 0.1.12**（本批改动 install.sh/http.py/kernel/tasks/upgrade 等内核与脚本，触发发版）：出包入库 `khc-agent-0.1.12.tar.gz`（sha256 `9f8c3a7c38f3…`）并用既有发布私钥重签清单；实链核对——包内内置公钥自验 0.1.12 清单通过，篡改 sha/未知 url 均被拒（A-5 fail-closed 生效）。
- **B-4（Python ≥3.11 硬门槛无发行版处置说明）**：`docs/install.md` 新增 §1.1——明写 3.11 是已验证支持基线、`--check` 对低版本 FAIL（不是 WARN），Ubuntu 22.04（自带 3.10）处置二选一（deadsnakes PPA 装 `python3.11` + `PYTHON=` 覆盖，或换 24.04/Debian 12），并指出 `apt install python3` 在 22.04 上解决不了 FAIL；`install.sh --check` 的"版本过低"FAIL 提示文案对齐（含 deadsnakes 路径与 `PYTHON=` 用法，预检 30/30 复跑通过）。顺带修复 `scripts/install-preflight-test.sh` 的同款 locale 隐患（`$label（` → `${label}（`，UTF-8 locale 下 unbound 报错；verify.sh 因 C 掩护未暴露，记入计划文档 §4.5）。
- **B-2/B-3（D1 读改写竞态：nodes.update 丢列、put() 撞 rev）**：`D1NodeRepo.update` 由"读整行→全字段 UPDATE"改为**单列 UPDATE**（只 SET 补丁出现的列）——并发写者刚落库的其他列（如 /state 轮询写的 `last_seen_at`）不再被读到的旧值覆盖；空补丁直接只读返回。`D1AppConfigRepo.put` 的 rev 由"先 SELECT MAX 再 +1 写入"（加密切割出真实并发窗口，两个并发保存算出同一 rev，后者撞 revisions 主键整批失败）改为 **INSERT 子查询原子分配 + RETURNING 拿回实际值**；app_configs 指针的 rev 加 `MAX(旧值, 新值)` 只升不降保护（乱序落库不回退）。取舍：revisions 写入与 app_configs upsert 不再同一 batch（原全有或全无），失败可能留下孤儿 revision，不影响后续 put/apply。补并发测试 2 例（并发写者不丢列 / 并发 put 不撞 rev 且指针不回退）。
- **B-1（tcp-fetch chunked 解析按字符串下标切，多字节内容取串）**：`tcp-fetch` 的响应解析整体改为**按字节（Uint8Array）**——`tcpFetch` 读取循环不再流式 TextDecoder 提前转字符串（多字节字符的字节偏移就此丢失），而是字节累积后统一解析；chunked 解码按 chunk-size 行的字节数切分（中文等多字节 UTF-8 内容不再取串/错位），Content-Length 同样按字节截取（不再多拿尾部字节）；截断保护（`index+size` 越界丢弃）。`parseHttpResponse(string)` 保留为测试/兼容薄包装（UTF-8 编码后走字节路径）。新增 3 例：中文多字节 chunked、中文多字节 Content-Length 截断、多字节跨 chunk 的 Uint8Array 直接解析。
- **A-7（沙箱被文档表述为安全边界）**：`docs/security-boundaries.md` §2 明确 systemd 沙箱定位为**防误写层，不构成对越权代码的边界**（Agent 以 root 运行，可经 D-Bus/`systemd-run`/remount 写出白名单，`ReadWritePaths` 无法按文件名前缀过滤）；真正边界 = 代码级 `khc-*` 白名单（port-forward/host-ops/cron）+ 发布包信任链 + 写操作鉴权 + 审计回滚。§3 unit 目录行口径同步（只写 `khc-forward-*.service`/`khc-fw.service`）。顺带项"unit 目录收窄到 `khc-*` 前缀"评估后不做：unit 必须位于标准 unit 目录才能被 `systemctl enable` 加载，专属子目录需 `systemctl link` 非小改（结论记入计划文档 §4.5）。纯文档改动。
- **A-12（备份恢复缺少"恢复后必做"说明）**：备份卡片文案（导出/导入两处 notice）与 `docs/backup.md` §1 明写——备份不含节点 token/证书私钥/DNS 凭据，恢复到新节点后需①重生成接口密钥并写入机器 token 文件、②重新下发 peer 客户端配置（旧配置身份/密钥不再匹配）；只回滚到同一台机器（数据未丢）时不需要。纯文案变更，无行为改动；节点设置 smoke 测试复跑通过（26 例）。**390 截图自检发现并修复**：`ui-banner-desc` 原为 `nowrap+ellipsis`，加长后的新文案在 390px 被单行截断——改描述行自然换行（标题保留省略号策略），线上复截确认完整 4 行显示、无溢出（浅/深/390 三张截图见 `docs/verification/2026-11-03/shots/`）。
- **A-11（加密无 key-id，无轮换路径）**：密文新增 `enc:v2:<keyId>:` 前缀（`MASTER_ENC_KEY_ID`，缺省 `k1`），旧的无前缀行继续可解；`app_configs` 不再叠加 `enc:v1:` 包装前缀（历史 `enc:v1:` 行兼容读）。解密先试当前钥、失败回退可选的 `MASTER_ENC_KEY_PREVIOUS`（轮换窗口），都失败报 503 并提示配置旧钥——`MASTER_ENC_KEY` 从"不建议轮换（无平滑路径）"变为有完整 SOP：新钥+旧钥并行 → 存量行随每次保存自动重加密 → SQL 按前缀核对迁移完成 → 删除旧钥（`docs/backup.md` §8.1）。`MASTER_ENC_KEY` 轮换不再等于全量重建。补 crypto 单测 6 例（前缀/兼容/回退/缺旧钥报错/双钥失配）+ repo 旧格式行回归 1 例。
- **A-9（任务状态只在内存）**：`TaskManager` 支持任务状态落盘——每任务一个 `<data>/tasks/<id>.json`（与 `upgrade.json` 同风格：原子写、0600、失败只告警），在状态迁移（start/finish/fail/cancel）时写入；Agent 重启后 `GET /tasks/:id` 仍可查历史任务（含结果与日志尾部），未完成任务一律改写为 `error(agent_restarted)` 而非假装 running；清理有上限——重启加载时按保留期（7 天）与数量上限（max_tasks，默认 200）删除过期/超量记录，内存淘汰时同步删文件。新增 5 例单测（重启可查/中断改写/过期清理/超量清理/坏记录丢弃）。
- **A-8（写锁 per-app 与文档口径不符）**：Agent 内核写锁由按应用分锁改为 **per-node 节点级单锁**——同一时刻整节点只允许一个写动作（任何应用），并发写第二个请求（不论应用）返回 `409 busy`（`details.app` 标注被拒请求的应用）；文档 `design-v3.md` §2.2 本就写的是节点级串行，本次是代码对齐文档，文档零改动。补跨应用并发测试（demo 锁占用时 rival 写动作 409、释放后恢复）。
- **A-5（升级签名清单只在 Worker 侧校验）**：Agent 新增 `khc/release_verify.py`——内置发布公钥（Ed25519 raw）+ 纯 Python RFC 8032 验签（stdlib 无 Ed25519）+ 与 `sign-agent-release.mjs` 逐字节对齐的 canonical JSON；`POST /upgrade` 的 `validate_request` 改为 **fail-closed**：Worker 把签名清单原文（`AGENT_RELEASE_MANIFEST`）随请求转发，Agent 独立验签并核对 `(packageUrl, sha256) ∈ payload.releases`，缺清单 `release_manifest_missing`、验签失败 `release_signature_invalid`、自建包 `release_not_in_manifest`。自此 Hub/Cloudflare 账号失陷也无法向节点远程下发未签名包；自建包仍可走人工 upgrade-command 路径。Ed25519 实现以 node crypto（OpenSSL）离线生成向量为正例（防自签自验闭环），Agent 新增单测 16 例（含缺清单拒绝/自建包拒绝/伪造清单拒绝/升级 HTTP 层走通）。
- **A-4（观测层 Origin 校验默认关闭）**：`install.sh` 新增 `--live-origins`/`--node-id`，渲染进 systemd unit 的 `KHC_LIVE_ORIGINS`/`KHC_NODE_ID`；面板生成的安装/升级命令自动带上面板域名与节点 ID（升级命令会重渲染 unit，必须带上否则丢 allowlist；Agent 拉取式自升级只补沙箱行不受影响）；手动重装不带参数时从现有 unit 继承。未知 Origin 的 SSE 一律 403（既有行为，此前因 allowlist 恒空形同虚设）；同源面板实时观测不受影响（EventSource 的 Origin 即面板地址）。顺带修复 `install.sh`/`uninstall.sh` 的 locale 隐患：UTF-8 locale 下 bash 把 `$VAR，`（变量名紧跟多字节字符）解析为一个未定义变量名，`set -u` 直接报错退出——受影响处全部改 `${VAR}`（记入计划文档 §4.5）。
- **A-1（无任何安全响应头）**：静态资源分支统一补三个安全头——`Content-Security-Policy: frame-ancestors 'none'`（禁止面板被任意站点 iframe 嵌入，防点击劫持）、`X-Content-Type-Options: nosniff`（禁 MIME 嗅探）、`Strict-Transport-Security: max-age=31536000; includeSubDomains`（强制 HTTPS）。HTML 仍保持 no-cache 防白屏，hash 静态资源保留原长缓存头；纯响应头变更，UI 渲染零改动（浅/深/390 无影响）。API JSON 响应不套用（nosniff 对 application/json 无意义，且会破坏 SSE 等流式端点的既有行为）。

### Fixed（架构整改批次 1：稳定性缺陷 R-1/R-3，arch-review-remediation-2026-11-03）
- **R-1（Agent 业务 5xx 被误判为 Hub 不可达）**：`node-client` 的 `call()` 仅在「连接层失败（无任何响应）」或「5xx 且响应体不是合法 Agent 信封（代理/网关错误页）」时才换路由重试；Agent 业务 5xx 信封（含 `error.code`，如 `apply_failed`）按普通响应原样返回，交由路由层 5xx 分支转成用户可读失败原因——面板不再把「应用失败，已自动回滚：<真实原因>」误报成「Hub 不可达」，配置了隧道的节点上同一写动作不再被换路由重复执行（Agent 失败时 `idem.abort()` 使幂等缓存失效，重试命中不了去重）。幂等键透传与回退重签名逻辑未动。补真实 `HttpAgentClient`（注入 fake fetch，`cloudflare:sockets` 走既有 sockets-stub 别名）回归测试 3 例（5xx 信封原样返回 / 隧道场景只调用一次 / 网关错误页仍换路由）。
- **R-3（同步动作超时重试分支失效）**：`callWithSyncPoll` 的超时判定由消息字符串匹配（`timeout/超时`——真实客户端 message 恒为「Hub 不可达（直连与隧道均失败）」，该分支永不命中）改为传输层类型化标记：`tcpFetch` 超时改抛 `TcpTimeoutError`、`HttpAgentClient` 按路由聚合超时标记并在 `HubUnreachableError` 新增 `timedOut` 字段；注释写明 Agent 同步死线 `SYNC_DEADLINE_SECONDS`(12s) 与 Worker 单次传输预算 `SYNC_TIMEOUT_MS`(15s) 的余量关系。补测试：node-client 3 例（双超时 timedOut=true / 连接拒绝 false / 混掺 true）+ 路由级 2 例（超时进重试且同一幂等键、非超时立即抛仅调用一次）。
- **A-2（写请求不校验 Origin/content-type，CSRF 只靠 SameSite=Lax）**：`/api/v1/*` 写方法（POST/PUT/PATCH/DELETE）统一校验——`Origin` 存在且非同源 → 403 `cross_origin_blocked`；`Sec-Fetch-Site: cross-site/same-site` → 403；带 body 的写请求必须 `content-type: application/json` → 否则 415 `unsupported_media_type`（附录 A-4 探针 `POST /nodes` 带 text/plain 由 201 变 415）。两头都缺省视为非浏览器客户端（curl 等）放行；无 body 写请求（logout）与 GET 不受限；同源面板前端（fetch 自动带 Origin、client.ts 已设 application/json）不受影响。
- **A-3（部分 API 未鉴权）**：`/api/v1/*` 改为**默认鉴权**——app 层统一挂 `requireAuth`，白名单仅放行 `auth/login`、`auth/logout`（幂等清 cookie）、`health`、`version`；附录 A-4 探针 `GET /api/v1/agent/releases` 无 cookie 由 200 变 401（该端点无外部机器消费者：install-command 由登录后的面板生成、CI 校验走静态资产路径）。未实现的 `/api/v1/*` 路径无会话时也返回 401（不再泄漏路径存在性）；各路由内部既有 `requireAuth` 保留作纵深防御。
- 批次其余：T1.3 自签 TLS 文档口径三处统一（TCP 通道 TLS 由平台强制校验证书，自签不可用）；T1.2 `wrangler.toml` 开启 `[observability]`（Workers Logs）。

### Added（服务端能力补齐 feat/server-capabilities，2026-11-03）
- **六步能力**：
  - 安装链路增强（`2e6e76c`）：`install.sh` 系统包代装白名单（`--with-caddy/--with-wireguard/--with-socat/--with`，仅 wireguard-tools/caddy/socat）+ `--tls` 自签证书同端口 HTTPS（`--tls-cn`）+ peer 一键安装脚本（`peer_install_script`：装工具→写 conf→启用→回连验证，导出抽屉 conf/脚本双 Tab）。
  - 主机运维收口（`629a949`）：svc.list/logs/restart 与 cron 受控管理接入面板；AgentCard 远程自升级替换命令复制。
  - 删除语义做实（`01cdd8f`）：khc-host `cleanup` 动词（停删 wg0/Caddy khc.d/转发 unit/`/opt/khc` `/etc/khc`，幂等 + 回读校验）；删除节点/Peer 确认框「同时清理本机服务」默认勾选，有残留阻止删除，可取消勾选仅删记录。
  - Cloudflare DNS 集成（`e57357e`）：设置卡片（最小权限 Token，单 Zone `Zone→DNS→Edit + Zone→Zone→Read`，加密只写不回显）+ endpoint 为 IP 的节点自动代建 A/AAAA + 删除节点联动删记录；用法见 `docs/cf-dns.md`。
- 控制面灾备（响应架构审查保命项）：`docs/backup.md` §7 MASTER_ENC_KEY 离线备份 SOP + D1 导出步骤、§8 密钥手动轮换 SOP（**不再做 rotate_token 自动轮换**，design-v3 §1.1 相应标注）。

### Fixed（架构审查与走查缺陷，feat/server-capabilities）
- 轮换稳定性（`b391be2`）：overlay 按记录 oldPublicKey 对齐面板写回时机（R1/R3），PENDING 超时保留记录供面板一键恢复 D1 旧公钥（R2）。
- 路由内 fetch→TCP 回退（`a00924f`）+ onRouteSuccess 异常隔离（H3/T3）；回退补超时预算、30s 探测冷却、通道可观测与自签证书人话提示（`b23d66a`，双通道）。
- 走查缺陷：全新机器首个 apply 必写盘失败（`a498aa7`，阻断 #2）；fw.apply 回读校验 `E_FW_VERIFY` + wg apply 后状态校验 `wg_verify_failed`，ApplyFailed.message 带具体原因（`6816fd5`，#5/#6）。
- 发布链路（走查卡点 #1，`5165cad`）：Agent 0.1.4 → 0.1.7，包入 `apps/web/public/agent/` 随 assets 部署；CI 加版本一致性检查（agent 代码变更必须 bump VERSION、VERSION 变更必须已出包、部署后线上包 sha256 == 仓库包）；`AGENT_RELEASE_MANIFEST` 更新步骤与未更新时的线上表现（400 `release_not_in_manifest` fail-closed）写入 `docs/engineering/release.md` §6.2。
- 轮换链路回归修复（实机复验发现，`0.1.5` 从未发布、直接以 `0.1.6` 出包）：WireGuard 动作预期失败 error 由字符串改为 `{code, message[, details]}` 对象（字符串 error 会被 Worker `agentEnvelopeSchema` 拒收成 500）；换钥看门狗 ctx 在起线程前解除同步动作 12s 窗口 deadline（此前线程内 `ctx.run` 全部 `sync_deadline_exceeded`，轮换永远停在 pending）。
- cleanup 双缺陷修复（批次 I 发现项 F-1/F-2，Agent `0.1.7`、khc-host `1.4.1`）：F-1 挂载点目录（Agent 沙箱 `ReadWritePaths` bind mount，rmdir 必然 `EBUSY/EROFS`）不再强删——只清空内容、目录保留并记入新增 `skipped` 清单（明确上报原因，不算残留、不阻断删除流程）；F-2 补齐已确认防火墙产物清理（stop/disable/delete `khc-fw.service` + daemon-reload、`nft delete table inet khc_fw`、fw 规则/状态文件 `fw.{nft,backup.nft,state.json,state.backup.json}`——默认 `/etc/khc-host/` 与 Agent 数据目录 `fw-state/` 两处布局都清），全部幂等、单项失败带 errno 上报且不破坏其余清理项；`docs/security-boundaries.md` §11 与 `docs/runbook/troubleshooting.md` §10 同步。
- F-3 修复（批次 J 发现，Worker 契约）：`PATCH /nodes/:id` 的明文 `token` 此前不在 `updateNodeRequestSchema` 中、被 zod 静默剥离导致 token 永不更新且无报错——现显式支持 token 轮换（路由层 `MASTER_ENC_KEY` 加密写入 `tokenEnc`，响应零回显、审计只记 `tokenRotated: true` 不落明文；非法格式返回 400 `validation_failed`），补 2 例路由测试（轮换生效 + 密文存储 + 审计脱敏 / 格式校验）。
- 批次 L 发现项修复（F-L1/F-L2/F-L3，Agent `0.1.8`；F-L2 竞态修复 `0.1.9`）：
  - **F-L1**（Worker）：CF DNS 代建记录不再发送 `tags`（最小权限 Token 无 record tags 配额，带 tags 被 CF 拒绝 `cf_dns_auth`）——标记只保留 comment `khc-server managed`，联动删除本就按 D1 登记的 recordId 执行、不依赖 tags；`docs/cf-dns.md` 与 `docs/security-boundaries.md` §10 同步为"最小权限、不需要 tags 权限"。
  - **F-L2**（Agent 升级）：升级流程在重启前补建新版所需数据目录（与 install.sh / `Paths.ensure_dirs` 同集合，`/etc/wireguard` 0700；沙箱内 EROFS 时经 `systemd-run --wait` 临时 unit 在沙箱外 root 补建 + 10s 轮询兜底，仍失败按重启失败回滚）——"目录不存在的旧版机器"升级不再 crash loop 依赖看门狗兜底。0.1.8 实测暴露并修复于 0.1.9 的竞态：`systemd-run` 返回 rc=0 时临时 unit 可能尚未执行（journal 顺序实证），立即 `isdir` 检查会误判失败 → 补 `--wait` 同步 + 轮询，含回归测试。注意：**修复自它随版本落地后的下一次升级起生效**（0.1.7→0.1.8 这一跳仍由 0.1.7 旧代码执行，目录缺失场景仍会 crash→回滚，node-test-2 实测复现）。
  - **F-L3**（Agent 升级）：升级流程对比包内新模板，把旧 unit `ReadWritePaths` 缺失条目（0.1.4 时代 unit 缺 `/etc/cron.d`、`/root/.ssh` 等）**只增不减**追加并 `daemon-reload`——hub 上 cron 管理在升级后可用；`docs/security-boundaries.md` §3 白名单表与 §3.1 同步。
- **F-M1 根治**（批次 N，Worker 侧，main `5b6d47c`，Agent 无改动维持 0.1.9）：`/state` 链路"同 nonce 重放"回退坑——① `node-client` 回退不再复用已发出的签名材料：fetch 超时/失败（含边缘 403 拦截）后 TCP 回退**重新生成 nonce/ts 并重签**（原实现同 nonce 被 Agent NonceCache 401 `nonce_replayed` 拒绝），幂等键跨尝试保留；② `nodes.ts` /state 超时预算 3s→10s（最重端点，系统繁忙期必踩线）；③ `nodes.ts` 按 HTTP status 区分报错——401/403 归鉴权/签名类错误（附 Agent 原始信息与可操作提示），不再误报"格式不合法"，其他非 200 带状态码。测试：回退重签（nonce/sig 不同 + 幂等键保留）、401/403 不误报、非 200 带状态码（超时预算不叠加既有用例保留）；`./scripts/verify.sh` 退出 0。上线后生产复验：/state 连续轮询 **100/100 稳定**（零"格式不合法"/零鉴权错误）、双通道 fetch+tcp 各命中、Agent 0.1.9 与 manifest 一致。peer 一键脚本实机验证：安装/conf 0600/自启/密钥匹配/分流默认（仅 10.99.0.0/24 走隧道）全过；回连 ping 因 **Oracle 安全列表丢弃入站 UDP 51820** 按脚本设计失败并给出可操作提示（tcpdump 0 packets 实证，需主人在 OCI 控制台放行）；适配器无 peer 卸载脚本（缺口，手动清理已清干净），建议下批补 `peer_uninstall_script`。证据见 `docs/verification/2026-11-03/report.md` §12。

### Added（批次 O：peer 一键卸载脚本，main `9af4c4b`，Agent `0.1.10`）
- `peer_uninstall_script` 全链路：`wireguard.py` 新增卸载脚本模板（`KHC_WG_IFACE` 可选接口、systemctl stop/disable 幂等判断、删 conf 与私钥、`KHC_WG_PURGE_TOOLS=1` 门控卸载 wireguard-tools 系统包（**默认保留**）、清理结果清单（空则"已是干净状态"）、失败可操作提示）+ 纯函数 `render_peer_uninstall_script` + 动作注册；安装脚本同步补"安装结果（peer xxx）"汇总段；导出抽屉 conf/安装/卸载三页签。
- `ensure_dirs` 外部目录降级（生产事故根治，Agent `0.1.10`）：`/etc/wireguard` 等安装器拥有的目录被外部清除后，沙箱内重建 EROFS 不再 crash loop，降级为 WARNING + 宿主机 `mkdir -m 0700` 可操作提示；khc 自有目录保持硬失败。x86-2 热装 0.1.10 时实证触发并止血（宿主补建目录恢复），修复后删目录重启实测正常启动 + WARNING。
- arm-1 实机全链路：安装（预期回连失败 exit 1 + 可操作提示）→ 卸载（3 项已清理 + 清单 + 默认保留 tools）→ 幂等重跑（全跳过 + "已是干净状态"）→ `PURGE_TOOLS=1` 路径（tools 卸载）全过；线上生成卸载命令内容核对全项命中。证据见 `docs/verification/2026-11-03/report.md` §13。

### Fixed（批次 P：浏览器走查缺陷，main `3ffb605` + `1ca53b3`，纯 Worker/UI 无出包）
- **B-1（阻断）暂存 Peer 导出报「peer 不存在」**：暂存态（rev ≠ appliedRev）导出不再走 Agent（D1 侧无私钥、Agent 侧未下发，硬调必报错）——抽屉改为「该 Peer 尚未下发到节点」引导 + 「去应用配置」入口（控制通道不可用时禁用并说明）；Agent 侧 `peer 不存在/尚未 apply` 兜底转译为同款引导，原始文案不允许直出。补漏（`1ca53b3`）：保存后自动打开的导出抽屉因闭包旧值（保存前 rev==appliedRev）误判为已应用态仍走 Agent——改读 queryClient 最新配置态判定；mockApi 改有状态（PUT 后 GET 返回最新），补「保存新 Peer 后自动打开导出」回归测试（审计原始场景）。线上页面复验：自动弹出的抽屉显示引导 + 无「peer 不存在」+ 未调 Agent。
- **P0-1 安装命令 Caddy/自签选项**：契约 `agentInstallOptionsSchema`（withCaddy/tls/tlsCn，CN 白名单 `^[A-Za-z0-9.*-]+$` 校验）→ 安装命令按勾选实时重生成追加 `--with-caddy/--tls/--tls-cn`（与 `agent/install.sh` 参数对齐，bash 语法测试）；节点令牌抽屉与节点设置安装命令抽屉镜像勾选，**默认全不勾**，附端口/域名约束提示（自签 HTTPS 需域名 + CF 代理 HTTPS 端口）；升级命令忽略 installOptions。线上 API 三态复验：带选项/默认不带/非法 CN 400 全对。
- **P1-3 删除节点 L3 确认占位**：补「输入节点名 {name} 以确认」（与远程升级同款表达）；删除/升级等待期忙碌态由 ConfirmDialog 既有 pending 机制核验覆盖（确认后按钮禁用 + loading 防重复点击）；P1-1 侧栏「添加节点」直达抽屉核验已实现（AppShell `?create=1`）。P1-2（保存后中间态）未列入本批，记录备查。
- 证据见 `docs/verification/2026-11-03/report.md` §14、`docs/archive/ui-redesign/audit-2026-11-03/clicks-audit.md` §0.1（历史资料）。

### Fixed（批次 S：主机 iptables 自动放行 + onboard shell 善后，main `36b03f5`，Agent `0.1.11` / khc-host `1.5.0`）
- **主机 iptables 自动放行（方案 B）**：修批次 R 记录的「配好了却不通」——OCI 类主机 iptables INPUT 尾链 REJECT 拦掉 WG/端口转发监听端口，`khc_fw` 早链 accept 非最终裁决（实测否决方案 A）。`port_claims` 带 `release: true` 的端口（wireguard `udp/listenPort`、port-forward 各 `listenPort`；caddy 不参与）在 apply 管道由内核新模块 `khc/hostfw.py` 自动插/收带 `khc-auto:<app>` 注释的 INPUT ACCEPT：条件触发（仅链上存在 REJECT/DROP 或 policy DROP）、幂等、只删自身注释规则、只增 ACCEPT（锁定保护结构上不可被绕过）、失败降级不阻断 apply；plan 预览、rollback 收敛、uninstall 全量收回；apply 回显 `hostFw` + 「已自动放行 …」。`fw.show` 新增 `autoRules`（标注非用户策略），面板防火墙卡片同步展示。边界见 `docs/security-boundaries.md` §6.1。
- **host-ops onboard shell 善后**：修批次 R 记录的「留下脏状态」——改 peer 用户 shell 前记录原值（`/etc/khc-host/original-shell`：既有用户记原值/新建记 `__created__`/已存在不覆盖）；卸载按记录分支：既有用户恢复原 shell 且不再 userdel、`__created__` 才 `userdel -r`、无记录缺省安全；`status` 新增 `onboard` 块，面板 peer 抽屉显示「已临时修改 shell」。
- 实机零手工复验（node-test-2 + arm-1，全程不补 iptables）：peer 一键安装一次通过（回连验证 EXIT=0，上批需手工补规则）、ping avg 0.858ms、运维通道/端口转发经 WG 全通（13–16ms）、卸载后 iptables 无 khc-auto 残留、ubuntu shell 恢复且用户未删、Agent/SSH 全程在线。勘误批次 R §16.4「fw.apply 才管主机 iptables」表述。证据：`docs/verification/2026-11-03/report.md` §17。

### Fixed（批次 Q：删除流程清理默认值，main `568e69b`，纯 UI 无出包）
- **删除 Peer/节点的「同时清理本机服务」按实际能力决定默认值**：走查发现未接入 host-ops 的 Peer 在默认勾选下删除必报 `E_NOT_ONBOARDED`——现按 host-ops 配置预判接入状态：未接入的 Peer 清理项**默认不勾且禁用**，提示「该 Peer 未接入运维通道，无法远程清理」；已接入保持默认勾选；取消勾选仅删记录的行为不变。删除节点场景同款检查：节点清理走 `'self'`（失败模式 `E_SCRIPT_MISSING`），以 adapters 是否含 host-ops 前置判断，未装时默认不勾且禁用。补 wireguard/node-settings smoke 测试各 1 例，既有删除用例补接入态 mock。
- 生产收尾：清理走查残留节点 `ui-test-node`（127.0.0.1、从未上线）；最终一致性核对六项全过（首页/登录/Agent 包 sha/D1 节点=面板/docs 索引/CHANGELOG），见 `docs/verification/2026-11-03/report.md` §15。

### Verified（批次 R：peer 隧道补验，2026-11-03，纯验证无代码改动）
- OCI 安全列表放行后实测入站 UDP 51820 可达（hub tcpdump 抓到 arm-1 实发包 3 packets）；**环境发现**：hub 主机 iptables INPUT 链尾 REJECT 拦掉 51820 与新转发端口（wg/port-forward apply 不写主机 iptables，fw.apply 才管），临时补规则后全链路通过——记录不修，生产起用 WG/端口转发需 fw.apply 放行 listenPort。
- peer 隧道全链路实测通过（hub=node-test-2，peer=node-test-3）：一键安装脚本幂等重跑 EXIT=0；`ping 10.99.0.1` 5/5 avg 1.1ms；分流默认（仅 10.99.0.0/24 走 khc0，其余原网关）；peer 经 WG 访问 hub Agent `/health` 200；host-ops probe/onboard/status/processes 经 WG 全通（onboard 自动取 hubWgIp）；端口转发经 WG（tcp/18322 → 10.99.0.2:22，SSH banner + 3 次连接 ~15ms）。
- 验证后全量清理与恢复：peer 卸载脚本（`KHC_WG_PURGE_TOOLS=1`）+ host-ops uninstall 命令 + hub 侧 peer 记录与内核同步清理（wireguard rev 10 applied、peers=[]）、host-ops/port-forward 配置重置为空、临时 iptables 规则与 socat 移除，两机恢复起测前状态。另一记录项：host-ops onboard 会把 peer 用户 shell 改为 `/bin/sh` 且卸载命令不恢复（arm-1 已手工还原）。证据见 `docs/verification/2026-11-03/report.md` §16。

### Changed（测试补齐，`6eac34f`）
- D1 仓储契约测试双跑（Memory 与 db/d1 同套用例：增删改查/事务/唯一约束/分页排序/软删）；迁移 0001→0006 顺序与幂等脚本化入 verify；rotate_peer API 层断言（透传/expectRev 冲突/PENDING 重复调用/取消超时）；会话语义（过期/登出失效/签名篡改拒绝/限流不影响正常登录）。用例数以 `./scripts/verify.sh` 实跑为准（当前 vitest 382、agent 817 全绿）。

### Docs（红线 9 登记，2026-11-03）
- 5 份 2026-11-02 一次性评估报告（架构审查 / 功能缺口 / 流程走查 / 测试覆盖 / 服务端 E2E 测试）归档至 `docs/archive/audit-2026-11-02/` 并登记归档索引，各带状态块与 2026-11-03 修复状态表；可长期遵循的结论沉淀进现行文档。
- runbook 对齐实现：node-onboarding（代装/自签/peer 脚本）、troubleshooting（回读校验/双通道回退冷却/卸载清理）、security-boundaries（代装白名单/CF Token 最小权限/删除清理）、release（发布链路与 manifest fail-closed）；新增 `docs/cf-dns.md` 并登记 `docs/README.md`。

### 上线（批次 K，2026-11-03，main `8cd2e1a`）
- feat/server-capabilities（批次 A–K，16 commits）squash 合入 main 并推送；CI 三 job 全绿（Agent tests / Typecheck+Test+Build / Deploy production Worker），生产部署完成。
- `AGENT_RELEASE_MANIFEST` 已用既有私钥（本地 `.khc-local/release-keys/`，与线上公钥指纹一致）更新为 0.1.7 清单；线上 `GET /api/v1/agent/releases` 与安装链接下载包 sha 均与仓库一致。
- 部署后复验全过：首页/登录、限流 429（10 次/300s/IP）、节点创建删除、CF DNS 未配 Token 优雅降级；证据与上线后待办见 `docs/verification/2026-11-03/report.md` §9。

### 运维收尾（2026-11-02，main `02f13b2` 上线后）
- 迁移 0006 已先于 Worker 部署对生产 D1 执行（`rate_limit` 表已建）；生产复验登录限流：第 11 次错误口令 429、D1 计数落库、异 IP 不受影响。
- 清理 D1 全部 7 个历史测试节点（含测试 hub `sp-vm-aws`），面板节点列表已清空；aws hub 与 arm-1 上的 Agent、wg 接口、Caddy khc 配置已卸载/清除（VM 本体保留）。清单见 `docs/archive/audit-2026-11-02/server-test/2026-11-02/report.md` §6.3。
- 文档状态收口：production-readiness（限流已解决、迁移 0001–0006）、d1-migrations（清单与核对表补 0006）、troubleshooting（生产 429 复验结果）。

### Fixed（阶段一测试 P0/P1 修复，fix/server-issues，2026-11-02）
- **P0-1** Agent 沙箱：unit `ProtectHome=true` → `read-only` + `ReadWritePaths=-/root/.ssh`（hub self keys.* 恢复可用，其余沙箱限制不变）。
- **P0-2** khc-host 脚本路径：`SCRIPT_PATH`/`STATE_DIR` 按实际部署形态解析（env 覆盖 > `__file__` realpath > `/usr/local/sbin` 兜底），hub self `fw.apply` 不再恒 `E_UNSUPPORTED`。
- **P1-A** WireGuard：Agent 重装后从现存 `/etc/wireguard/<name>.conf` 恢复接口私钥与 peer 公钥（AllowedIPs 严格匹配）；peer-only apply 后自动 `wg set ... peer ... remove` 清理内核残留 peer。不做 D1 回写（私钥不出 Agent）。
- **P1-B** 防火墙锁定保护：Agent 入口端口按运行中的 khc-agent 进程 `/proc` 实测（去 8880 硬编码）；`rule_lockout_reason` 改「协议+端口」两维匹配并移除源网段维度（`0.0.0.0/0` 源不再误报 `E_LOCKOUT`）。
- **P1-C** 登录限流：改用 D1 固定窗口计数（迁移 `0006_rate_limit.sql`，单语句原子 upsert，跨 isolate；D1 → KV → 内存三级降级），生产未绑 KV 时不再失效。
- 测试：agent 新增 13 项（wireguard 10 + host_ops 3）、API 新增 6 项；测试 hub 真机复验记录见 `docs/archive/audit-2026-11-02/server-test/2026-11-02/report.md` §7。
- 新增运维文档：`docs/runbook/node-onboarding.md`、`docs/runbook/troubleshooting.md`、`docs/security-boundaries.md`。

### Fixed（全局 /certs 暗路由 302）
- 补上 ui-redesign 声称但缺失的全局 `/certs` 302 重定向（→ `/settings?tab=certs`，与节点层暗路由处置一致）；`router.tsx` 新增 `certsRedirectRoute`，`c3.smoke.test.tsx` 补测试。此前 `/certs` 直接 404。

### Changed（文档整合 docs/consolidation，2026-11-02）
- 文档地图 `docs/README.md` 重写为"现行权威表 + 归档索引"，新增文档门禁（新增文档必须归类 + 状态块 + 同 PR 登记索引；被取代只归档不删除；archive 不得作为开发依据），AGENTS.md 同步（红线 9 与 §6.3/§6.4 修订）。
- UI v2.2 规范体系归档：`docs/ui/` → `docs/archive/ui-v2.2/`、`docs/ui-changes/001–016` → `docs/archive/ui-changes/`（带索引）；变更单流程废止，并入 PR 模板与 issue 模板；设计令牌唯一权威 = `apps/web/src/styles/tokens.css`；`design-v1/v2`、验收记录等历史文档 → `docs/archive/2026-11/`。
- 运维文档对齐实际：新增 ADR-0008（生产复用 staging Worker/D1）与 `docs/engineering/d1-migrations.md` runbook；重写 release / auto-deploy / production-readiness；清理 ci.yml 死代码。
- 修正过时数字与口径：migrations 已应用 0001–0005（6 表）、design-v3 路由/表清单、agent/README 适配器清单与 TLS 表述；测试数量口径统一为"以 `./scripts/verify.sh` 实测为准"。
- 现行文档头部补状态块（状态 / 适用范围 / 最后核验 / 关联）。

### Changed（面板 UI 统一改造 feat/ui-redesign，2026-11-02）
- 全站按六类页面范式（A 概览 / B 列表对象 / C 详情 / D 配置表单 / E 运维动作 / L 登录）重构：导航收敛为全局 3 项 + 节点层 5 项一级结构，删除 HubBar 二级胶囊；术语统一（节点 / 站点 / 内网穿透 / Peer / 保存并生效）。
- 内网穿透合并：`/wireguard` 吸收 `/forwards`（端口转发卡）与 `/peers`（行内"运维"抽屉）；站点页 Segmented 三段 [站点 | 扩展应用 | 证书]，吸收 `/apps` 与 `/certs`（节点级）。
- 主机运维重做：状态带（Agent/CPU/内存/磁盘/服务/运行，异常下钻）+ 服务/进程/防火墙/SSH公钥四分段 + 页面唯一抽屉（五种内容）；诊断降级为状态带右侧入口（DiagnosticsCard/DiagnosticsDrawer 并入 DiagnosticsPanel）；诊断修复动作改为抽屉内直接执行（去二级确认）。
- 节点设置分区化：[Agent 与接入 | 节点模式 | 备份与恢复 | 危险区] 四分段；备份导入改抽屉内三步（选择文件 → 预览 → 确认）；删除节点从列表行内移入危险区并升 L3（输入节点名确认）。
- 旧路由处置：`/certs`、`/hubs/:id/apps|forwards|peers|certs` 共 5 条改 302 重定向过渡（不留第二入口，后续移除）。
- 服务重启能力占位：注册 `hostOps.svcRestart` 动作但恒禁用并提示"能力尚未开放"（Agent `svc.restart` 白名单 verb 待拍板）。
- 规范固化：`docs/ui-redesign/ui-guidelines.md` / `page-specs.md` 与实现对齐，新增 `changelog.md` 落地备案；`AGENTS.md` 新增 §6.4 强制约束（新增页面必须归类六类、复用既有范式，不合规范不予合入）。

### Fixed（SSE 浏览器跨域）
- SSE 增加 `Access-Control-Allow-Origin`（按 allowlist 回显）、`Vary: Origin`、`Referrer-Policy: no-referrer`；401/403 也返回 CORS，否则浏览器 EventSource 只能降级。
- `agent/tests/test_live.py` 增加 CORS 断言并修复测试客户端跨包读取；新增 `scripts/live-sse-check.mjs` 生产验收脚本；Agent 0.1.4。

### Changed（#52 写闸门拆分 + 观测层 SSE）
- 前端写闸门拆两级：`channels.canSave`（保存配置/节点字段，纯 D1 写，永远允许）+ `channels.canApply`（plan/apply/rollback 等执行类，需控制面可达）；`canMutate` 保留为 `canApply` 兼容别名。
- `writeGuard` 放行保存类 PUT（`/nodes/:id/apps/:app`、`/nodes/:id`），继续拦截执行类 POST——Hub 离线时仍可编辑并保存配置，恢复后一键应用（git-ops：rev 领先 appliedRev = 已保存待应用）。
- 应用编辑页新增「已保存，待应用」Banner 与 toast 区分（`configSavedPending`）；PageHeader sync 在 `rev > appliedRev` 时显示 queued；节点设置页实时观测入口保存解锁。
- 观测通道 WebSocket → **SSE**：`agent/khc/live.py` 重写（`GET /_live/?ticket=` → `text/event-stream`，事件 hello/state，15s 心跳注释行，select 断开检测），删除手写 RFC 6455 帧协议。
- nudge 由双向 WS 改为 `POST /_live/nudge`（ticket 在请求体，scope=nudge）；live scope 票据走 URL 查询串（EventSource 限制），观测服务不打访问日志。
- 契约：`liveTicketResponse.wsPath` → `livePath`；前端 `data/live.ts` 改用 `EventSource`（票据一次性，断开后 10s 重新取票，不依赖 EventSource 自动重连）。
- 新增冒烟测试 `apps/api/test/smoke-offline-save.test.ts`（离线保存/apply 失败记录/恢复后 expectRev 生效）；`test_live` 重写为 SSE 版（8 项）。
- 文档：`docs/plan-gate-split.md`（方案）、`docs/live-observation.md`（SSE 修订）、UI 变更单 #016。

### Changed（#50 双模式精简 + 移除主机运维 kill）
- 节点模式 7 态 → 3 态（`wg` / `caddy` / `unknown`）；删除 `switching_*`、`degraded_*` 与 `unconfigured`，切换进行中只由按钮 loading 表达。
- 预检 13 码 → 4 个阻断（换钥中 / 端口冲突 / 未应用配置 / Caddy 未运行）+ 1 条 `MODE_WARN_IMPACT` 影响摘要。
- 删除码：`MODE_WARN_FIREWALL`、`MODE_WARN_ROOT_UNKNOWN`、`MODE_WARN_TASK_UNKNOWN`、`MODE_BLOCKED_PORT_443_UDP`（并入 `MODE_BLOCKED_PORT_CONFLICT`，details 带 `{proto,port,reason}`）、`MODE_BLOCKED_FORWARDS_ENABLED`、`MODE_BLOCKED_CADDY_UNHEALTHY`（改为 `MODE_BLOCKED_CADDY_NOT_RUNNING`）、`MODE_WARN_WG_DEPENDENT_SITES`、`MODE_WARN_ALL_SITES_DEPEND_ON_WG`、`MODE_WARN_PEERS_OFFLINE`、`MODE_WARN_HOSTOPS_PEERS`。
- 模式契约删除 `state` / `desired` / `effective` / `counts`，改为 `mode` + `target` + `reachable` + `blockers` + `warnings`。
- 判定逻辑移入 `wireguard` / `caddy-site` / `port-forward` / `host-ops` 的 `status().modeImpact`；`apps/api/src/lib/mode.ts` 不再出现应用名。
- 模式抽屉改为一屏（当前模式 / 阻断 / 影响摘要 / 确认 / 切换），删除 Steps、进度页、结果页与「切回/撤销」。
- 主机运维删除 `kill` 写动词（含 force/SIGKILL、受保护名单与 `_send_signal`）；`WRITE_VERBS` 不再含 kill；`khc-host` 1.1.1。
- 进程抽屉只读：保留 Top 列表与详情，删除行内「结束」、强制开关、二次确认、`hostOps.kill` 动作与 `hostops.killed` 审计。
- `call_task` 保留给 `fw.apply`；`docs/host-ops*.md`、ADR-0007、UI 变更单 #015、e2e 脚本同步。

### Changed（诊断精简 #49，2026-10-29）
- 核心诊断从 38 码缩到 7 码：`transport.unreachable`、`transport.auth_401`、`agent.clock_skew`、`agent.offline`、`agent.version_unsupported`、`agent.state_invalid`、`config.pending_apply`
- 应用问题改由适配器 `status().problems` 上报（`{code,severity,title,hint,action?,evidence?}`），核心只做通用渲染；`apps/api/src/lib/diagnostics/` 不再出现任何应用名（含 grep 测试）
- 适配器精简问题：wireguard `interface_down/port_conflict/rotation_stuck`、caddy-site `inactive/config_failed/upstream_down`、certificates `expiring/acme_failed`、port-forward `unit_failed`
- 删除 basic/full 深度（只调一次 `/state`）、OK 行、未知行、延迟告警、Peer 离线、未托管应用、动作失败诊断
- 响应移除 `summary`；`checks` 只含问题，全部正常时为空；`NodeDiagnosticsResponse` 去掉 `summary`，新增 `AdapterProblem`/`DiagnosticAction`
- 一键修复只保留三个安全动作：`app.apply`、`caddy.service`、`peer.cancelRotation`

#### 旧码映射

| 旧码 | 新位置 |
|---|---|
| `khc.transport.timeout` / `tls` / `bad_response` / `cf_1003` / `cf_522` / `cf_524` / `cf_530` | `khc.transport.unreachable`（原因/CF 码进 evidence） |
| `khc.transport.unreachable` / `khc.transport.auth_401` | 保留 |
| `khc.agent.offline` / `clock_skew` / `version_unsupported` | 保留 |
| `khc.agent.release_manifest_missing` | 删除；由升级页展示 |
| `khc.agent.state_invalid` | 保留，并合并 `config.adapter_missing` |
| `khc.config.unmanaged_app` | 删除（信息噪音） |
| `khc.agent.root_required` / `action_failed` | 删除；动作错误在操作处展示 |
| `khc.config.stuck_pending` | 合并进 `khc.config.pending_apply`（>10 分钟为 warn） |
| `khc.config.invalid_config` | 删除；apply 失败在配置页展示 |
| `khc.wireguard.interface_down` / `port_conflict` / `rotation_stuck` | 适配器 `problems`：`khc.wireguard.<slug>` |
| `khc.wireguard.peer_offline` / `rotation_pending` | 删除（Peer/WG 页面已展示） |
| `khc.caddy.inactive` | 适配器 `khc.caddy-site.inactive` |
| `khc.caddy.validate_failed` / `reload_failed` | 合并为 `khc.caddy-site.config_failed` |
| `khc.caddy.upstream_down` | 适配器 `khc.caddy-site.upstream_down` |
| `khc.cert.expiring` / `expired` | `khc.certificates.expiring`（按剩余天数定级） |
| `khc.cert.acme_failed` / `dns_credential` / `acme_env_missing` | 合并为 `khc.certificates.acme_failed`（reason 进 evidence） |
| `khc.forward.unit_failed` / `socat_missing` | 合并为 `khc.port-forward.unit_failed`（reason=socat_missing） |
| `khc.forward.port_conflict` | 删除；apply 时 409 已提示 |
| `khc.hostops.*`（16 个） | 退出诊断目录；动作错误按原错误信封展示 |


### Docs（主机运维）
- 主机运维设计 `docs/host-ops.md`、ADR-0007（Hub 经 SSH 按需调用 + Peer 静态受限脚本）、UI 变更单 #008

### Fixed（UI 一致性 #014，2026-10-29）
- 表格行内菜单改为 portal 定位（不再被单元格裁切）；列宽弹性化 + 低优先级列 <1024 隐藏
- `--text-3` 对比度过 AA；禁用按钮原因可悬停可见；抽屉/对话框焦点陷阱与归还；浮层动效
- 顶栏图标语义化、手机搜索入口、退出收进用户菜单；概览 T1 分栏；平板 56px 图标栏；登录页品牌与状态行
- 复审修正：手机保留用户菜单（退出入口）；菜单自身滚动不再误关闭

### Added
- v4 规划、旧功能清单、UI 规范 v2.2 导入、ADR/测试/发版流程
- P0 传输双通道：`fetch()` + `cloudflare:sockets`（IP 直连）
- 自定义应用动作透传（`client_config` / `rotate_peer` 等）
- 应用配置（含私钥）在 D1 中以 AES-GCM 加密保存（ADR-0005）

### Changed
- Agent 默认入口改为 `0.0.0.0:8880`（用户拍板）
- 节点 endpoint 允许 IP（撤销“禁止裸 IP”校验）

### Fixed（#44–#48 稳定性，2026-10-29）
- #44 WireGuard 换钥状态写回 conf，syncconf/重启不再丢新 peer
- #45 Agent HTTP 10s 超时 + 64 并发上限 + 先验 HMAC 信封再读 body
- #46 写锁按应用拆分；host-ops 只读动词不占锁/不缓存；只读任务不占锁
- #47 幂等进行中返回 202、幂等结果落盘；同步写 12s 截止并触发回滚
- #48 host-ops SSH ControlMaster + snapshot 动词；面板一次往返

### Fixed（#40/#41/#42，2026-10-27）
- #40 安装命令包子 shell、`read </dev/tty`；失败不断 SSH
- #41 生产缺发布清单 fail-closed，诊断 warning
- #42 看门狗清理脚本/校验 `/state`，peer 公钥复用缓存

### Fixed（systemd hardening，2026-10-27）
- install.sh 的 systemd unit 增加 `/etc/wireguard` 可写（ProtectSystem=full 下 WireGuard apply 不再 EROFS）

### Fixed（#30 真机回退，2026-10-27）
- 看门狗使用 Agent 实际端口；新 Hub 坏包升级约 42s 自动回退 0.1.0，`.failed`/`rolled_back` 正确

### Fixed（open issues #29/#30/#31/#33/#34，2026-10-27）
- #29 备份导入不按下标错配私钥，公私钥不一致拒绝
- #30 升级后 30s 看门狗自动回退 `.prev`
- #31 安装/升级命令不再内嵌长期 token（安装从 stdin 读取，UI 单独展示）
- #33 `/state.agent.mode` 改由适配器 `state_summary` 汇总，内核不再认识 wireguard
- #34 双模式预检提示 host-ops Peer 将失联
- #32 发布清单 Ed25519 签名 + `AGENT_RELEASE_BASE`；staging 已启用

### Fixed（发布包 AppleDouble，2026-10-27）
- 修复 macOS `._*` 进入 Agent tar 导致升级后适配器加载崩溃；`package.sh` 禁用 xattrs，loader 跳过点文件
- 新增 `test_package.py`；真实升级 0.1.0↔0.1.1 双向通过

### Added（最小版最近操作，2026-10-27）
- 节点概况「最近操作」：仅最近 5 条 audit；移除全局/节点活动导航与占位路由

### Added（C5/C2/C3 收尾，2026-10-27）
- Agent 拉取式自升级/重装（安全解包/原子替换/失败保留上一版）
- install.sh `--check` + 用户模式验收
- C2 真机 CUTOVER：真实客户端旧钥失效、新钥握手成功
- C3 真实 ACME DNS-01 生产签发（Cloudflare）
- Caddy 站点导入/导出（前端，预览后保存，不自动 apply）

### Fixed / Verified（#14，2026-10-27）
- 独立 Peer 真机 E2E：99 PASS / 0 FAIL / 2 SKIP；含 fw 60s 自动回滚与 nft 只保留上一条
- E2E 脚本修复：Agent 直连 idempotencyKey、config 顶层、params 归一化、断言健壮化

### Added（Wave 4）
- Agent 生命周期命令生成：安装/升级/卸载（Worker 三接口 + UI 卡/抽屉），命令含 token 但审计不落 token
- staging：命令 `bash -n` 通过、非法 URL 400

### Added（Wave 3）
- WireGuard `enabled` 双模式 + `GET /nodes/:id/mode` 只读预检
- D6 `app_configs.last_apply_error` + D7 `/state.agent{version,serverTime,mode}`
- 节点模式 UI：设置卡/四视图切换抽屉/概况徽章/caddy 模式 Banner
- staging wg↔caddy 往返：Caddy 站点 200、WG 端口释放/恢复

### Added（Wave 2）
- C4 诊断只读 API（53 hints / 21 checks）+ 节点概况「活动与诊断」卡片/抽屉
- #16 应用页面目录迁移（apps/<app>/page.tsx，URL/行为不变）
- C4 Hub 双模式设计 docs/dual-mode.md

### Added（Wave 1）
- host-ops `call_task` 任务模式 + UI 轮询（#17）；staging fw.apply 异步实测
- `scripts/host-ops-peer-e2e.sh` + `docs/host-ops-e2e.md`（#14 预备）
- C4 诊断知识库设计 `docs/diagnostics.md` + UI #011

### Fixed（issues #12/#13/#15/#18）
- host-ops nft：规则/回滚改为 delete+重建，修复追加导致回滚失效（真机 A/B/C 三步验证）
- backup：导出剥离 WireGuard privateKey/presharedKey；导入保留目标已有私钥/PSK
- core audit：改为适配器信封 `audit{write,target,verb}` 通用记录，移除 apps.ts 的 host-ops 硬编码
- port-forward：socat unit 使用 DynamicUser/最小权限/ProtectSystem 等 hardening

### Added（C4 备份/恢复）
- `GET /nodes/:id/export` / `POST /nodes/:id/import`：节点公开信息 + app_configs，不含 token/证书私钥；导入只写配置不自动 apply
- 节点设置「备份与恢复」页：导出下载、文件预览、L2 确认导入、新 rev 结果
- staging：导出 5 应用 → 新节点导入 5 条配置，appliedRev 为空

### Added（C4 端口转发）
- `port-forward` 适配器：socat systemd unit，tcp/udp，端口登记/冲突，停用清理，status/install
- 转发页：列表/添加/编辑/启停/删除、固定安全警示、手机布局
- 真机：tcp 7001→127.0.0.1:22 可通；停用后 unit/端口清理

### Added（主机运维 B2）
- `host-ops` 适配器：Hub 本机 + Peer 按需 SSH，受限公钥/静态脚本，白名单动词
- 进程查看/结束、nftables 自有表防火墙（60s 确认回滚）、authorized_keys 标记块管理、状态/脚本版本
- UI：VM 运维卡片三入口 + WireGuard Peer「运维」Tab（接入向导/状态/三个抽屉）；截图 docs/ui/shots/hostops-*.png
- Worker：host-ops 写动作 D1 审计（target/verb/结果，不记参数）

### Added（VM 运维状态）
- Agent `ops.py`：CPU/内存/Swap/磁盘/网络/服务/Top 进程/重启标记，5s 缓存
- `/state.ops` 随 6.4a live 通道 1s 推送；节点概况「VM 运维」卡片

### Added（Caddy 管理）
- caddy-site 1.1.0：proxy/static/redirect、多上游/lb/health/pathRoutes、TLS auto/manual/internal/off、BasicAuth、headers/HSTS/安全头/压缩/限流/IP、日志、liveGateway、siteHealth、caddy_service/validate/reload/config
- 站点页完整 UI：类型化抽屉、健康状态、清空站点、Caddy 服务抽屉/导出；Worker 透传 Agent error details

### Added（6.4a 观测层）
- 节点 `liveEndpoint` 字段 + 节点概况「实时观测」卡片（页面可见才连，隐藏断开，降级快照）
- Worker `POST /nodes/:id/live-ticket`（60s 一次性 HMAC ticket）
- Agent `khc/live.py` 只读 WS（127.0.0.1:8899，首消息 ticket，live/nudge，连接上限/Origin/jti）

### Added（C3）
- 证书库（全局）：自签/ACME/导入、加密存储、导出、`$cert` 密钥引用
- Caddy 站点适配器：auto/manual/off TLS、BasicAuth、Header、TLS1.3、整树 validate、reload 回滚、端口登记钩子
- 证书适配器：openssl 自签、acme.sh DNS-01、inspect
- UI：证书页、设置页（DNS 凭据只写不读）、站点页；内核文件 owner/chown 与私钥 diff 脱敏

### Added（C2）
- WireGuard 适配器：interface/peers 渲染、`wg syncconf` 无闪断、`client_config`/`rotate_peer`/`confirm_rotation`/`cancel_rotation`、无损换钥状态机与看守线程
- UI v2.2 外壳（tokens/ui/patterns/registry/i18n/data/pages/gallery）

## [0.1.0] - 2026-10-25

### Added
- C1：Worker 4 张表、节点/应用配置/版本/审计、HMAC 客户端、直连/隧道选路
- Agent 内核 + node-exporter 适配器 + 安装/卸载/打包脚本
- React 面板：登录、节点、应用页（Schema 表单/diff/任务/回滚）
- staging 部署与真机验收
