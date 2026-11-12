# 面板信息架构与 UI 重组方案（ui-ia-redesign-2026-11-12）

> 状态：**提案（待主人拍板，未授权改代码）** ｜ 适用范围：控制台前端信息架构、页面区块、视觉收敛，以及为此需要的 Agent / Worker / 契约最小改动 ｜ 最后核验：2026-11-12（基线 `cfc54ec`，只读代码取证，未改产品代码） ｜ 关联：`AGENTS.md` 红线 1/2/3/6/9、`docs/ui-redesign/page-specs.md`、`docs/ui-redesign/ui-guidelines.md`、`apps/web/src/styles/tokens.css`、ADR-0010、ADR-0014（提议）、ADR-0017（提议）、ADR-0018（提议）

---

## 0. 这份文档怎么用

1. **只出方案，不改代码**。按红线 1，§10 的决策项需要主人逐条拍板；拍板后按 §9 的批次开 PR，每批一个 PR。
2. 方案以**现有代码和已拍板的约束**为准。代码里没有的能力，一律标【新增】并写明改哪个文件、改什么、怎么测。
3. 证据等级：**【代码】**＝已读实现确认；**【文档】**＝来自现行文档；**【新增】**＝本方案要加的东西；**【待核】**＝落地前要再确认一次的细节。
4. 原型图在 `docs/plans/assets/ui-ia-2026-11-12/`。图中所有节点名、域名、IP 都是虚构的 `example.com` / 文档地址段，**不是生产截图**，不违反 `docs/README.md` 的“公开仓库不含 UI 截图”约定。原型只表达信息结构，具体取值以 `tokens.css` 为准。

| 图 | 内容 |
|---|---|
| `1-overview.png` | 全局首页 |
| `2-hub-overview.png` | 节点概况 |
| `3-services.png` | 节点层新页面「应用」（对外服务） |
| `4-flow-add-hub.png` | 添加节点流程 |
| `5-flow-wg-peer.png` | WireGuard 与 Peer 流程 |
| `6-flow-publish-remote.png` | 发布应用与远程访问流程 |

> 图 2、4、5 的区块结构仍是上一版，只更新了视觉；其中与 §4.2、§4.6、§4.7 不一致的地方以正文为准，B5 开工前补图。

---

## 1. 结论摘要

| # | 要解决的问题 | 方案 | 后端改动 |
|---|---|---|---|
| 1 | 看不出“这台节点对外提供了哪些服务，后端在哪”。站点和端口转发分在两个模块里，内网 VM 只显示裸 IP | 新增节点层页面 **「应用」**：一行对应一个对外服务，分「网页应用」（Caddy 反代站点）和「远程访问」（端口转发）两张表。后端按地址**自动识别**为本机或某台内网 VM，并串起 VM 的在线状态 | **无**，纯前端从现有数据推导（ADR-0017） |
| 2 | 各页任务进度靠手动点「刷新进度」 | 任务摘要**随现有 10 秒快照下发**，前端统一由 TaskTracker 接管；顶栏「任务」按节点显示 | Agent `build_snapshot` 增加 `tasks` 字段，契约加可选字段（ADR-0018） |
| 3 | 规范禁止打开页面自动探测，实现却挂载即探测并自动复核 | 规范向实现看齐：承认 2026-11-07 主人反馈后的“挂载即探测 + 15 秒复用 + 离线有限复核” | **无**（ADR-0014，只改规范） |
| 4 | 只有 Caddy 必装，其他模块按需安装，但界面把“未安装”当成异常 | 未安装 = 中性；不进待办、不标琥珀、侧栏不显示未安装模块 | **无** |
| 5 | 界面“AI 味”重：彩色胶囊、蓝色主色、阴影、解释性副标题、蓝色「进入 →」 | 视觉收敛：状态只用圆点加文字，主按钮改中性深色，去阴影、减圆角，删解释性副标题，整行可点替代「进入 →」 | **无**，改 `tokens.css` 和少量组件 |

**明确不做**：
- 面板与 hub 的长连接、Durable Object、D1 任务表。面板只在打开页面时连一次（主人定案）。
- 托管安装程序（面板替用户装 magpie 等）。现状是**手动安装**程序，再由 Caddy 发布。托管安装只在 §8 作为未来方向记录，**不进本轮任何页面主线**，界面上也不暗示已支持。
- 恢复 SSE。观测仍走 ADR-0010 的 10 秒快照轮询。

---

## 2. 现状取证

### 2.1 产品定位（主人 2026-11-12 口述，以此为准）

- **WireGuard**：用来连接没有公网地址的 VM，再把 VM 上装的应用发布出去。
- **端口转发**：用来把这类 VM 的 SSH、远程桌面转发出来。
- **应用发布**：程序**手动安装**在节点或 VM 上（例：magpie 本机监听 `127.0.0.1:3245`），再由 Caddy 发布为 `magpie.example.com:8443`。将来针对部分应用做“安装 + 发布”适配，由面板完全托管。
- **必装组件只有 Caddy**。WireGuard、端口转发、扩展应用、目录应用都按需安装和启用。

### 2.2 代码事实

| 主题 | 事实 | 证据 |
|---|---|---|
| 观测通道 | 前端 10 秒快照轮询，页面可见才轮询，10 分钟或 60 次后停止；有可信域名时浏览器直连 `/_live/snapshot`，否则经 Worker `/nodes/:id/snapshot` 转发。SSE 代码保留，但前端不再引用 | 【代码】`apps/web/src/data/snapshot.ts`（`SNAPSHOT_POLL_MS=10_000`、`SNAPSHOT_MAX_POLLS=60`），`apps/web/src/data/channels.ts`；【文档】ADR-0010 |
| 快照内容 | `build_snapshot` 只返回 `ok/ts/host/ops/agent`，没有适配器状态，也没有任务 | 【代码】`agent/khc/state.py:142` |
| 重数据 | 适配器运行态、站点健康 `siteHealth`（含 `latencyMs`）、转发 `active`、Peer `latestHandshake` 只在打开工作区时由一次性 `/state` 提供 | 【代码】`apps/web/src/data/sites.ts:103-517`、`agent/adapters/port_forward.py:519-614`、`agent/adapters/wireguard.py:1924` |
| 快照轮询范围 | `HubChannelsProvider` 挂在 `AppShell` 的节点工作区外层，节点内所有页面共享一条快照轮询 | 【代码】`apps/web/src/app/AppShell.tsx:271` |
| 任务注册表 | `TaskManager` 记录 `id/app/action/state/progress/logs/created_at/updated_at`，最多 200 条、保留 7 天；`to_dict()` **不含** `app/action/时间` | 【代码】`agent/khc/tasks.py:42-189` |
| 任务读取 | Agent 只有 `GET /tasks/<id>`；Worker 透传 `GET /api/v1/nodes/:id/tasks/:taskId` | 【代码】`agent/khc/http.py:265`、`apps/api/src/routes/apps.ts:306` |
| 任务前端 | taskId 存在各页组件 state 中：`caddy/page.tsx`、`certificates/page.tsx`、`settings/AppCatalog.tsx`、`wireguard/page.tsx`、`pages/AppPage.tsx`；AppCatalog 有「刷新进度」按钮 | 【代码】grep `taskId` / `刷新进度` |
| 站点上游 | `upstreams[]` 接受 `host:port`、`scheme://host:port`、`unix//path` | 【代码】`agent/adapters/caddy_site.py:281-313` |
| 站点类型 | `kind` 为 `proxy` / `static` / `redirect`，另有 `pathRoutes`、`healthUri`、`liveGateway` | 【代码】`caddy_site.py:7-24,138` |
| 端口转发 | 规则字段 `name/listenPort/protocol/targetHost/targetPort/enabled/note`，用 socat 实现，**无应用层鉴权**，不写防火墙 | 【代码】`agent/adapters/port_forward.py:1-12` |
| Peer | `allowedIps[]`；运行态 `latestHandshake`、`online` | 【代码】`wireguard.py:201,698,1924` |
| 探测 | `useHubProbe` 挂载即探测，15 秒复用，离线节点 60/120/240 秒最多复核 3 次；注释写明是 2026-11-07 主人的要求 | 【代码】`apps/web/src/data/useHubProbe.ts:1-45` |
| 规范冲突 | `page-specs.md` §1.2 写“不轮询、不自动重试”，与上一行冲突 | 【文档】 |
| 导航 | 节点层侧栏写死 5 项：概况 / 站点 / 内网穿透 / 主机运维 / 节点设置 | 【代码】`AppShell.tsx:110-150`、`registry/routes.ts:22-31` |
| 色板 | `--accent: #2F6BFF`，有 `--shadow-sm/md` | 【代码】`tokens.css:6-33` |

### 2.3 当前体验问题

1. 用户想知道“magpie 发布在哪、后端是谁、通不通”，要在「站点」看域名，再记住上游 IP，去「内网穿透」核对是哪台 Peer、是否在线。
2. VM 掉线时，站点页只显示站点不可达，看不出原因是 Peer 离线。
3. 远程访问（SSH/RDP 转发）埋在内网穿透页的转发卡里，没有“直接可用的连接方式”。
4. 任务发出后要手动刷新进度；离开页面后 taskId 丢失。
5. 未安装的模块在首页显示琥珀“未安装 / 未生效”，看起来像故障。

---

## 3. 信息架构

### 3.1 导航

**全局层**（不变）：概览 / 节点 / 设置。

**节点层**（建议，见 §10 D-1）：

| 顺序 | 名称 | 路由 | 显示条件 | 说明 |
|---|---|---|---|---|
| 1 | 概况 | `/hubs/:hubId` | 始终 | 节点健康和待办 |
| 2 | **应用** | `/hubs/:hubId/services`【新增】 | 始终（Caddy 必装） | 对外服务总览：网页应用 + 远程访问 |
| 3 | 站点 | `/hubs/:hubId/sites` | 始终 | Caddy 站点的完整管理：跳转、静态、路径规则、高级配置、证书分段 |
| 4 | 内网穿透 | `/hubs/:hubId/wireguard` | WireGuard 或端口转发**已安装或已配置** | 接口、Peer、转发规则的底层配置 |
| 5 | 主机运维 | `/hubs/:hubId/ops` | 始终 | 不变 |
| 6 | 节点设置 | `/hubs/:hubId/settings` | 始终 | 不变；按需安装模块的入口放这里 |

- 路由用 `services`，不复用 `/hubs/:hubId/apps`：后者现在是 302 跳到站点页“扩展应用”分段，且 `/hubs/:hubId/apps/:app` 是适配器详情页。复用会让“应用”一词同时指对外服务和适配器。界面文案仍叫「应用」。
- 侧栏计数：「应用」显示网页应用数 + 远程访问数；有异常时计数变红。「内网穿透」显示 `Peer 在线/总数`。

### 3.2 「应用」和「站点」「内网穿透」的关系

```
            ┌───────────── 应用（对外服务视图，只读聚合 + 快捷操作）
            │   网页应用 = caddy-site 中 kind=proxy 的站点
            │   远程访问 = port-forward 中的规则
            │
  编辑 ─────┼──▶ 站点页的同一个站点抽屉（URL 驱动：?drawer=site:<name>）
            └──▶ 内网穿透页的同一个转发抽屉（?drawer=forward:<name>）
```

- 「应用」**不引入新数据**，也不新增保存路径。所有写操作复用站点、转发现有的保存 + apply 链路。
- 「站点」保留完整能力；`static`、`redirect` 站点和 `liveGateway` 观测入口不进「应用」，「应用」页底部只写一行“另有 N 个跳转/静态站点，见「站点」”。
- 「内网穿透」退为底层配置页：接口、Peer、转发规则表。

### 3.3 按需安装模块的显示规则

| 情况 | 侧栏 | 首页令牌 | 概况 | 待办 |
|---|---|---|---|---|
| 未安装且 D1 无配置 | 不显示 | 不显示 | 不显示 | 不进 |
| 已安装，D1 无配置 | 显示 | 中性「已安装 · 面板无配置」 | 中性 | 不进 |
| 已安装，有配置 | 显示 | 计数令牌 | 正常 | 只有运行异常才进 |
| D1 有配置，节点未安装 | 显示 | **中性**「未安装」 | 中性，附「安装」按钮 | **不进**（见 D-4） |
| Caddy 未安装 | — | 红色 | 红色 Banner | 进（Caddy 必装） |

安装入口统一放在「节点设置 → 模块」分区（现有 `AppCatalog` 能力的节点版），不放在横幅里催促。

---

## 4. 页面设计

所有页面遵守 `ui-guidelines.md` 的六类范式。本节只写**和现行 `page-specs.md` 不同的地方**；需要修订的规范条文见 §7。

### 4.1 `/` 全局概览（类型 A）— 图 1

区块顺序：页头 → 指标条 → 需要处理 → 节点表。

1. **页头**：标题「概览」；副标题一行：`3 个节点 · 2 件事需要处理 · 2 分钟前探测 刷新`。「刷新」是带下划线的文字按钮，不是蓝色链接。右侧「添加节点」主按钮（首页空态和日常都能开始添加，复用现 `/hubs` 的创建抽屉）。
2. **指标条**：一条横向数字带，替代 4 张 Stat 卡：`节点在线 2/3 · 站点 7 · Peer 5 · 端口转发 2 · 证书 5（1 张即将到期）`。数据全部来自 `GET /nodes` 的 `summary` 与 `GET /certificates`，**不增加请求**。“未探测节点数”删掉：探测已经是挂载即发（ADR-0014），用户看不到“未探测”状态。
3. **需要处理**：一行一件事，行内带动作按钮（不再是“点 chip 跳页后再找按钮”）。
   - 离线节点：`离线 hub-jp-3 已失联 2 天 · 最后在线 … · Tunnel`，按钮「排查」（跳节点设置的接入分区）、「删除节点」（L3 确认）。
   - 临期证书（≤14 天）：`证书 *.example.com 9 天后到期 · 被 hub-sg-1、hub-hk-2 使用`，按钮「续期」（复用证书页现有续期动作）。
   - **不进**：未安装模块、0 站点、0 规则。
4. **节点表**：替代节点卡片矩阵。列：节点（名称 + 系统 · 地区）/ 状态 / 接入（方式 + 地址，等宽字）/ 应用（摘要令牌）/ 最后在线。整行可点进入节点概况；悬停时整行浅灰底、行尾出现灰色「›」。表头右侧灰色文字「全部节点」跳 `/hubs`。**不出现蓝色「进入 →」。**

请求预算不变：`POST /nodes/probe` + `GET /nodes` + `GET /certificates` 共 3 次。

### 4.2 `/hubs/:id` 节点概况（类型 A）— 图 2

和现行 §2.1 相比：

- **「应用与发布」卡改为「对外服务」摘要**：最多 5 行，取自「应用」页同一份推导结果（§4.3.3），每行 `名称 · 对外地址 · 后端 · 状态`；底部灰色「全部应用」进入 `/services`。原先按模块列行（内网穿透 / 站点 / 端口转发 + 单徽标）的写法删除，模块状态只在侧栏和节点设置中出现。
- **需要处理**增加一类：后端 VM 离线导致的服务不可达，合并成一行：`office-vm 离线 3 天，影响 grafana、office-vm SSH`，按钮「查看 Peer」。
- 未安装模块不出现（§3.3）。
- 其余（指标、主机与服务、接入摘要）不变。

### 4.3 `/hubs/:id/services` 应用（类型 B，新增）— 图 3

#### 4.3.1 目的与首屏

- 目的：回答“这台节点对外提供了什么，后端在哪，现在通不通”。
- 页头：标题「应用」，**不写副标题**。右侧两个按钮：「远程访问」（次按钮）、「发布应用」（主按钮）。
- 区块：网页应用表 → 远程访问表 → 底部一行 `另有 1 个跳转站点，见「站点」`。
- 某一类为空时整张表不渲染，只保留页头对应按钮。两类都空时显示 EmptyState：「还没有对外服务」+「发布应用」。

#### 4.3.2 表格列

**网页应用**（来源：`caddy-site` 配置中 `kind=proxy` 的站点）

| 列 | 内容 | 来源 |
|---|---|---|
| 应用 / 对外地址 | 第一行站点名（加粗），第二行 `域名:端口`（等宽灰字） | D1 站点配置 `name`、`domains[0]`、`listenPort`（默认 443，443 时不写端口） |
| 后端 | 第一行 `本机 127.0.0.1:3245` 或 `内网 VM office-vm 10.99.0.4:3000`；第二行 `Peer 在线` / `Peer 离线 3 天`（仅 VM） | `upstreams[0]` + WireGuard 配置与 `/state` 推导（§4.3.3） |
| 状态 | 圆点 + 文字：`正常 38ms` / `后端不可达` / `不可达` / `未生效` / `未读取` | `/state` `siteHealth` + 推导 |
| 证书 / 访问 | `证书自动 · 公开` / `证书库 *.example.com` / `· Basic Auth` | 站点 `tls`、`basicauth` |
| 操作 | 「编辑」+「⋯」（打开、复制地址、停用、删除） | 复用站点抽屉 |

多上游（`upstreams.length > 1`）时后端列显示第一个，后面写 `+N`；`pathRoutes` 不展开，写 `+N 条路径规则`。

**远程访问**（来源：`port-forward` 配置）

| 列 | 内容 | 来源 |
|---|---|---|
| 名称 / 连接地址 | 第一行 `note` 不为空时用 note，否则用 `name`；第二行 `节点主机名:listenPort` | 转发规则 + 节点接入地址 |
| 目标 | `内网 VM office-vm 10.99.0.4:22` + Peer 在线状态 | `targetHost` 推导 |
| 状态 | `可连接` / `目标不可达`（Peer 离线）/ `转发未运行` / `未生效` | `/state` 中 port-forward 状态的 `active`、`error` + 推导 |
| 协议 | `TCP` / `UDP`，转发服务异常时追加说明 | `protocol` |
| 操作 | 「复制连接命令」或「复制连接地址」+「⋯」 | 前端生成 |

复制规则：`targetPort === 22` → `ssh -p <listenPort> <host>`；`targetPort === 3389` → `<host>:<listenPort>`（RDP 客户端直接粘贴）；其余 → `<host>:<listenPort>`。不猜用户名。

#### 4.3.3 后端识别规则（前端纯函数，ADR-0017）

新文件 `apps/web/src/data/services.ts`，导出 `classifyBackend(hostPort, ctx)` 和 `deriveServices(input)`，**不发请求**，输入全部来自已有查询缓存：

- `caddy-site` 配置（D1）与 `/state` 中 `caddy-site` 的 `siteHealth`；
- `port-forward` 配置（D1）与 `/state` 中的 `port-forward` 状态；
- `wireguard` 配置（D1，`interface.address`、`peers[].allowedIps`、`peers[].name`）与 `/state` 中的 Peer 运行态（`online`、`latestHandshake`）。

识别顺序：

1. 先剥掉 `http://` / `https://` 前缀，记下 scheme；`unix//` 开头 → `本机套接字`。
2. 主机是 `localhost`、`127.0.0.0/8`、`::1` → **本机**。
3. 主机是某个已启用 Peer 的 `allowedIps` 中的 `/32` 地址（或落在其网段内）→ **内网 VM**，带 Peer 名和在线状态。
4. 主机落在 `interface.address` 网段内但没有对应 Peer → **内网（未登记）**，琥珀提示“没有找到对应的 Peer”。
5. 其他 IP 或域名 → **外部**。

状态推导（取第一条命中的）：

| 条件 | 网页应用状态 | 远程访问状态 | 颜色 |
|---|---|---|---|
| 站点或规则未 apply（有待生效） | 未生效 | 未生效 | 琥珀 |
| `/state` 未读取（节点离线或无可写通道） | 未读取 | 未读取 | 灰 |
| 后端是 VM 且 Peer 离线 | 后端不可达 | 目标不可达 | 红 |
| `siteHealth.state === 'down'` / 转发 `active !== true` | 不可达 | 转发未运行 | 红 |
| 其余 | 正常 `Nms` | 可连接 | 绿（只有圆点和文字是绿色） |

单测覆盖：每条识别规则、每行状态表、IPv6、带 scheme 上游、多上游、Peer 停用、WireGuard 未安装（此时所有 10.x 上游归为“外部”，不报错）。

#### 4.3.4 交互

- 整行可点打开编辑抽屉。行内按钮不超过 2 个（`ui-guidelines` §8.12）。
- VM 离线的行整行浅红底，状态列写原因。同一 Peer 影响的多行在概况页合并成一条待办（§4.2）。
- 数据刷新跟随现有 `/state` 失效机制：任何 apply 成功后失效 `state` 查询，表格自然更新。**不加轮询**。

### 4.4 发布应用抽屉 — 图 6 左

入口：「应用」页「发布应用」，或站点页「新建站点」选“反向代理”。两处打开**同一个抽屉组件**，最终写入同一个 `caddy-site` 配置。

字段（自上而下）：

1. **后端**：单选卡片「本机端口」/「内网 VM」/「其他地址」。
   - 本机端口：输入端口号 → 上游 `127.0.0.1:<port>`。
   - 内网 VM：下拉选择 Peer（只列已启用的，显示在线状态）+ 端口 → 上游 `<peer /32 地址>:<port>`。WireGuard 未安装时此项置灰，提示“需要先在节点设置中安装 WireGuard”。
   - 其他地址：自由输入 `host:port`（即现行行为）。
   - 下方开关「后端使用 HTTPS」：开启时上游写成 `https://host:port`；关闭且端口为 443 时写成 `http://host:443`，解决“443 跑明文 HTTP”的歧义。Agent 的 `normalize_upstream` **已支持** scheme 前缀【代码】，无需后端改动。
2. **域名**：输入域名；有 Cloudflare 账号时右侧显示「同时创建 DNS 记录」复选框，调用现有 `POST /cf-dns/records/:zoneId`【代码：`apps/api/src/routes/cfDns.ts:612`】；Zone 由域名后缀匹配 `GET /cf-dns/zones` 结果，匹配不到时不显示复选框。
3. **端口**：默认 443；节点已有非标准 HTTPS 端口（如 8443）时，默认与已有站点一致。
4. **证书**：自动（ACME）/ 证书库选择 / 关闭。
5. **访问**：公开 / Basic Auth（复用现有 `hash_password` 动作）。
6. 底部：「保存并生效」主按钮。保存 = 现有 D1 写入；生效 = 现有 `apply`。前端顺序调用两个接口，apply 失败时保留草稿并在抽屉顶部显示错误，「重试生效」。

**生效后验证**（图 6 中）：apply 成功后自动对该站点做一次健康探测（复用 `/state` 失效重取，读取 `siteHealth`），抽屉内显示 `✓ 已生效 · 后端可达 38ms` 或 `后端不可达：connection refused`，并给「查看站点」「完成」。这一步**不新增接口**。

### 4.5 远程访问抽屉 — 图 6 右

入口：「应用」页「远程访问」。写入 `port-forward` 配置。

1. **目标**：选择 Peer（同上）或输入地址。
2. **服务**：SSH（22）/ 远程桌面（3389）/ 其他端口。
3. **对外端口**：默认推荐一个未占用端口。占用检查用 `/state.ports`（内核端口登记表）【代码】做前端预检，最终以 Agent `port_claims` 校验为准。
4. **名称**：默认 `<peer>-ssh` / `<peer>-rdp`，写入 `name`；显示名写入 `note`。
5. **安全提示**（固定文案，不可关闭）：“端口转发没有额外鉴权，任何人都能连到这个端口。请确认目标服务自身的密码或密钥足够安全，并在主机防火墙中放行该端口。”附「去主机防火墙」链接（`/hubs/:id/ops` 防火墙分段）。
6. 「保存并生效」同 §4.4。

### 4.6 `/hubs/:id/wireguard` 内网穿透 — 图 5

- 前提改为“WireGuard 已在节点设置中按需安装”。未安装时侧栏不显示此页；直接访问 URL 时显示 EmptyState「WireGuard 未安装」+「去节点设置安装」，**不再**在页面顶部用横幅催促安装。
- 添加 Peer 抽屉最后一步：除现有“导出一键脚本”外，增加「下一步：发布这台 VM 上的应用」次按钮，跳到发布抽屉并预选该 Peer。
- Peer 行展开的“被引用”区：列出引用该 Peer 地址的网页应用和远程访问（用 §4.3.3 同一函数反查）。删除 Peer 时，L2 确认框列出这些引用。
- Peer 地址变化时**不自动改**站点上游，只在保存后的提示里列出受影响的服务（见 D-6）。

### 4.7 添加节点流程 — 图 4

- 入口增加首页「添加节点」。
- 流程最后一步“完成”页只检查 Caddy（必装）和 Agent 在线；其他模块不出现在检查清单里。给出两个后续入口：「发布第一个应用」「安装模块」。

### 4.8 顶栏「任务」— 配合 ADR-0018

- 顶栏右侧「任务」按钮：有进行中的任务时显示数字和旋转图标。
- 点开为下拉面板（不是抽屉，不占唯一抽屉位），按节点分组；每行 `应用 · 动作 · 进度% · 最后一行日志`；结束的任务保留 10 分钟，显示 `完成` / `失败：原因`。
- 点行打开任务详情：调用现有 `GET /api/v1/nodes/:id/tasks/:taskId` **一次**取完整日志，不轮询。
- 当前节点没有观测通道（`readSource === 'none'`）时，该节点分组只显示“未连接，进度暂不可见”和「重新连接」，不替它猜进度。
- 删除各页的「刷新进度」按钮和组件内 taskId state（§6.3）。

---

## 5. 视觉收敛（去 AI 味）

原则：运维面板，信息密度优先，颜色只给异常（与 `ui-guidelines` §8.1“正常状态不大面积铺绿色”同向，本次更彻底）。

| # | 现状 | 改为 | 落点 |
|---|---|---|---|
| V1 | Badge 是带底色的胶囊 | 状态只用 7px 圆点 + 同色文字，无底色；分类标注（info）用灰色文字 | `ui/Badge` 变体；`ui-guidelines` §8.1、§8.7 |
| V2 | 主按钮、选中导航、链接用 `--accent #2F6BFF` | 主按钮改为 `--text`（#18181B）实底白字；导航选中改为浅灰底 + 深色字；链接改为深色文字 + 下划线。蓝色只保留给焦点环 | `tokens.css`：新增 `--primary-solid`、`--primary-solid-hover`，组件改引用；`--accent` 保留给 focus |
| V3 | 卡片、抽屉有阴影 | 卡片无阴影；只有浮层（抽屉、下拉、对话框）保留 `--shadow-overlay`，但减弱 | `tokens.css` `--shadow-sm` 置为 `none`，`--shadow-overlay` 减半 |
| V4 | 圆角偏大 | 卡片 6px、按钮和输入框 5px、标签 3px | `tokens.css` 圆角令牌 |
| V5 | 页头副标题写解释句（“这台节点对外提供的服务：……”） | 副标题只放事实和计数，或者不写 | 文案规则 `ui-guidelines` §8.6 增补 |
| V6 | 蓝色「进入 →」「管理 →」「去管理 →」 | 整行可点；悬停浅灰底 + 行尾灰色「›」；卡片右上角改为灰色文字（如「全部节点」） | `ui-guidelines` §8.12 增补；`page-specs` §2.1 删除“去管理 →” |
| V7 | 地址、端口混在正文字体里 | 地址、IP、端口、命令统一等宽灰字 | 已有 `--font-mono` 令牌 |
| V8 | 彩色字母图标块、emoji 式符号 | 删除；图标只用 `ui/icons.ts` 现有集合 | 已是现行规范，补走查 |
| V9 | 正常状态的绿色胶囊铺满一列 | 正常只有圆点是绿色，文字为默认色（见 D-7） | `ui/StatusDot` |

深色主题按同样规则改 `tokens.css` 的 `[data-theme=dark]` 段：主按钮用 `--text`（浅色）实底深字。

验收：浅色、深色、390 宽三张截图；四态（加载、空、错误、正常）。

---

## 6. 后端与前端改动清单

### 6.1 Agent（ADR-0018）

| 文件 | 改动 | 说明 |
|---|---|---|
| `agent/khc/tasks.py` | 新增 `TaskManager.summaries(*, window_s=600, limit=10, log_tail=3)` | 返回进行中任务 + `updated_at` 在 `window_s` 内结束的任务，按 `updated_at` 倒序，最多 `limit` 条；每条 `{id, app, action, state, progress, logTail, createdAt, updatedAt, error?}`。持锁复制，不阻塞任务线程 |
| `agent/khc/state.py` | `build_snapshot` 增加 `"tasks": kernel.tasks.summaries()` | 只读内存，不执行子进程，不增加快照耗时 |
| `agent/tests/test_tasks.py` | 新增用例 | 窗口过滤、条数上限、日志截断、重启后改写为 `error(agent_restarted)` 的任务也会出现 |
| `agent/tests/test_state.py` 或同类 | 快照包含 `tasks` 且是列表 | |

- **不新增**任务列表 HTTP 接口：刷新页面后第一帧快照就带有任务，足够补全。
- 不改 `GET /tasks/<id>`。
- Agent 版本号按 `docs/release-versioning.md` 递增 patch。

### 6.2 契约与 Worker

| 文件 | 改动 |
|---|---|
| `packages/contracts/src/index.ts` | 新增 `agentTaskSummarySchema`；`agentSnapshotSchema` 增加 `tasks: z.array(agentTaskSummarySchema).optional()`（`.passthrough()` 已存在，旧 Agent 不带此字段也能通过） |
| `apps/api/src/routes/snapshot.ts` | **无需改动**：转发模式原样返回 `snapshot` |
| Worker 其他 | 无。不建 D1 表，不加路由 |

### 6.3 前端

| 文件 | 改动 |
|---|---|
| `apps/web/src/data/snapshot.ts` | 解析 `tasks`，放入 `SnapshotObservation.tasks`。**有进行中的任务时**本轮不计入 60 次上限（会话总时长上限仍为 30 分钟，见 D-3） |
| `apps/web/src/data/tasks.ts`【新增】 | `TaskTracker`：合并“本页刚提交的 taskId”（来自写操作响应）和快照里的任务摘要；任务从非终态变终态时，按 `app` 映射失效查询（`state`、对应 app 配置、证书列表等）；导出 `useHubTasks(hubId)`、`useTrackTask()` |
| `apps/web/src/app/TaskMenu.tsx`【新增】 | 顶栏任务下拉（§4.8） |
| `apps/web/src/apps/caddy/page.tsx`、`certificates/page.tsx`、`settings/AppCatalog.tsx`、`wireguard/page.tsx`、`pages/AppPage.tsx` | 删除组件内 taskId state 和「刷新进度」，改为 `useTrackTask()(taskId)` |
| `apps/web/src/data/services.ts`【新增】 | §4.3.3 推导函数 + 单测 |
| `apps/web/src/pages/HubServicesPage.tsx`【新增】 | 「应用」页 |
| `apps/web/src/apps/caddy/` | 抽出 `SiteDrawer`，加“后端”选择和 HTTPS 开关，供站点页和应用页共用 |
| `apps/web/src/apps/wireguard/ForwardsCard.tsx` | 抽出 `ForwardDrawer`，加服务选择、端口推荐、固定安全提示 |
| `apps/web/src/registry/routes.ts` | 增加 `{ path: '/hubs/:hubId/services', scope: 'hub', template: 'T2', title: 'services', primary: 'service.publish' }`；顺手删除无调用方的 `routes` 导出或接入使用（审计遗留） |
| `apps/web/src/app/AppShell.tsx` | 节点侧栏插入「应用」；「内网穿透」按 §3.3 条件显示 |
| `apps/web/src/i18n/zh.ts` | 新增文案键；删除「刷新进度」 |
| `apps/web/src/styles/tokens.css` + `ui/` | §5 视觉改动 |

### 6.4 请求预算

| 场景 | 现在 | 方案后 |
|---|---|---|
| 打开「应用」页 | — | 0 次新增：复用工作区已有的 `/state` 和 D1 配置查询 |
| 任务进行中 | 用户手动点刷新，每次 1 个 Worker 请求 | 直连：0 个 Worker 请求；转发模式：沿用 10 秒快照，本来就有 |
| 任务详情 | — | 点开时 1 次 `GET /tasks/:id` |

---

## 7. 规范修订（拍板后与代码同一 PR 合入）

| 文档 | 章节 | 修订 |
|---|---|---|
| `page-specs.md` | §0 路由总表 | 新增 `/hubs/:id/services`（B）；10 个用户可见路由改为 11 个 |
| `page-specs.md` | §1.2 | 区块改为“页头 → 指标条 → 需要处理 → 节点表”；删“未探测节点数”；“不轮询、不自动重试”改为引用 ADR-0014；“操作入口”增加「添加节点」 |
| `page-specs.md` | §1.2 / §2.1 纳管状态 | “D1 有配置但未安装”改为中性「未安装」，不进需要处理 |
| `page-specs.md` | §2.1 | 「应用与发布」卡改为「对外服务」摘要；删“去管理 →”；需要处理增加“VM 离线影响服务” |
| `page-specs.md` | 新增 §2.2a | 「应用」页（§4.3 全文） |
| `page-specs.md` | §2.4 | 去掉安装横幅；加“被引用”区与“发布这台 VM 上的应用”入口 |
| `ui-guidelines.md` | §8.1、§8.7 | Badge 无底色，圆点 + 文字；info 改灰字 |
| `ui-guidelines.md` | §8.6 | 新增“副标题只写事实，不写解释句”；术语表新增「应用（对外服务）」「网页应用」「远程访问」「后端」 |
| `ui-guidelines.md` | §8.12 | 新增“整行可点 + 悬停 ›，不用蓝色箭头链接” |
| `ui-guidelines.md` | §8.14 | 任务进度来自快照，不手动刷新 |
| `ui-guidelines.md` | §10 | 自检清单增加：无蓝色箭头链接、无彩色胶囊、副标题无解释句 |
| `docs/live-observation.md` | §1、§3 | 快照增加 `tasks`；有进行中任务时上限规则 |
| `tokens.css` | — | §5 V2–V4 |
| `docs/engineering/adr/` | — | ADR-0014、0017、0018 状态改为“已接受” |

---

## 8. 未来方向：托管安装（不在本轮）

记录在这里，避免后续设计和本轮冲突：

- 目标：对部分应用（先 magpie 一类单二进制或单容器应用）做“安装 + 发布”适配，由面板托管。
- 本轮为它预留的接口只有两处：发布抽屉的“后端”单选将来可以多一个「托管应用」选项；「应用」页后端列将来可以显示「托管」。**本轮界面不出现这两个选项，也不出现“手动安装”字样。**
- 现有阻碍【代码】：`generic-service` 的 binary 模式单元名固定 `khc-generic.service`、目录固定，同一节点无法装两个自有程序；`installed.json` 按 recipe id 记录，一个 recipe 只能装一份；recipe 只有 install/uninstall，没有 update/restart/logs；站点上游与 recipe 之间没有引用关系。
- 到时需要单独提案：程序来源走通用 Docker/二进制，还是每个程序各写 recipe（遗留问题，本轮不决）。

---

## 9. 分批落地

每批一个 PR，按顺序，前一批合入后再开下一批。每批都要通过 `./scripts/verify.sh`，UI 批次附浅色、深色、390 截图和四态截图。

| 批次 | 内容 | 依赖 | 测试 | 回滚 |
|---|---|---|---|---|
| B0 | 本文档 + ADR-0014/0017/0018（提议） | — | 文档门禁 | 关闭 PR |
| B1 | 视觉收敛（§5）：`tokens.css` + Badge/StatusDot/Button + 全站去「进入 →」 | D-7 | 现有组件快照测试更新；gallery 页人工走查 | revert，令牌回退 |
| B2 | 规范对齐：ADR-0014 生效，`page-specs` §1.2 改写；按需安装显示规则（§3.3）；侧栏条件显示 | D-4 | `AppShell` 侧栏测试；首页令牌测试 | revert |
| B3 | 任务机制：Agent `summaries` + 快照字段 + 契约 + TaskTracker + 顶栏任务 + 删各页刷新进度 | D-3 | Agent 单测；`snapshot.test.ts`；`tasks.test.ts`；各页 smoke 测试；staging 安装一个目录应用观察进度 | 前端恢复各页 taskId；Agent 字段可保留（可选字段） |
| B4 | 「应用」页 + `services.ts` + 站点/转发抽屉抽取与增强 | D-1、D-2、D-5 | `services.test.ts` 覆盖 §4.3.3 全部规则；页面 smoke；staging 发布一个本机程序和一个 VM 程序 | 去掉路由和侧栏项，抽屉保留 |
| B5 | 概况页、内网穿透页、添加节点流程按 §4.2/§4.6/§4.7 调整；规范收尾 | B4 | 页面 smoke；走查 | revert |

CHANGELOG：每批在 `[Unreleased]` 写一条；B3 带 Agent 版本号。

---

## 10. 待拍板

| # | 问题 | A | B | 推荐 |
|---|---|---|---|---|
| D-1 | 导航 | 新增「应用」，保留现有其他名称（§3.1） | 采用 2026-11-11 方案：入口 / 组网 / 应用 / 主机 / 设置整体改名 | **A**：改动小，用户已熟悉现有名称；「应用」承担“对外服务”入口 |
| D-2 | 「应用」页的编辑方式 | 打开站点页同一抽屉（URL 驱动），页面停留在「应用」 | 跳到站点页再打开抽屉 | **A** |
| D-3 | 任务进行中时快照上限 | 有进行中任务时不计入 60 次，会话最长 30 分钟 | 不变，到顶后进度停在最后一帧，用户手动刷新 | **A**：长任务（证书签发、安装）常超过 10 分钟 |
| D-4 | “D1 有配置但节点未安装” | 中性「未安装」，模块页给安装按钮，不进待办 | 维持现行琥珀「未安装 / 未生效」 | **A**：符合“只有 Caddy 必装”的定案 |
| D-5 | 发布时同时建 DNS 记录 | 提供复选框，默认勾选（有 CF 账号时） | 不提供，DNS 去设置页单独建 | **A** |
| D-6 | Peer 地址变化联动站点上游 | 只提示受影响的服务 | 自动改写上游并一起 apply | **A**：自动改写跨两个适配器，失败回滚复杂 |
| D-7 | 正常状态的颜色 | 只有圆点绿色，文字默认色 | 圆点和文字都绿色 | **A**：正常状态不吸引注意 |
| D-8 | 无观测通道时的任务进度 | 只显示“未连接”，不提供兜底 | 任务下拉中提供「查询一次」按钮，经 Worker 读 `GET /tasks/:id` | **B**：一次性手动请求，不违反“不长连接” |
| D-9 | 待生效模型 | 保留“保存（草稿）+ 生效”两步，抽屉主按钮为「保存并生效」，失败留草稿 | 取消草稿态，只有「保存并生效」 | **A**：现有 `canSave`/`canApply` 分离（节点离线也能保存）有价值 |

---

## 11. 风险

| 风险 | 缓解 |
|---|---|
| 后端识别规则误判（例如 VM 地址和 Peer `allowedIps` 不是 `/32`） | 网段匹配作为第二规则；无法确定时归为“外部”，不报错；单测覆盖 |
| 快照体积变大 | 任务最多 10 条，每条日志 3 行，每行截断到 200 字符，约增加 2–4 KB |
| 旧 Agent 不带 `tasks` | 字段可选；前端此时降级为“提交后可在任务详情手动查看” |
| 视觉改动影响面大 | B1 独立 PR，只改令牌和基础组件，gallery 页一次走查 |
