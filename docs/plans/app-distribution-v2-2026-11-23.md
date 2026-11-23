# 应用分发 v2：声明式应用包与免发版适配（提案）

> 状态：已拍板 ｜ 最后核验：2026-11-23 ｜ 关联：`docs/hosted-apps.md`、`docs/plans/app-manifests-2026-11-15.md`、ADR-0006

> **执行者须知**：§12 已全部拍板。开发只按 §13 列出的批次开工说明施工，一个批次一个 PR；本文只写决策与验收口径。

## 1. 背景

### 1.1 目标（主人 2026-11-23）

应用分发是面板的核心功能。一期已做 magpie；后面要接主人自己开发的工具（首个样例：khcsearch 数据面节点，见附件 `node-provisioning-api.md`）。要求：**以后加应用不影响面板整体架构，最好不发版。**

### 1.2 一期已经做到的

- 应用定义（脚本正文 + sha256 + 参数 + 运行身份）存 D1 `app_manifests`，Worker 安装时按 `manifestId` 注入，路由不认识应用名（`apps/api/src/routes/apps.ts` `resolveManifestParams`）。
- Agent 侧校验 sha256、降权执行（`root` 经 `systemd-run`；`create` 建 nologin 账号后 `runuser`）、`KHC_PARAM_*` 传参、`KHC_RESULT` 回传、密钥抹除（`agent/khc/app_manifests.py`）。
- **改脚本不用发版**。这一层方向正确，本提案保留。

### 1.3 还没做到的（2026-11-23 `main` 核实）

| # | 卡点 | 位置 | 后果 |
|---|---|---|---|
| G1 | 清单字段是 `.strict()` 封闭集合 | `packages/contracts` `appManifestDefinitionSchema` | 应用需要一种新能力（多端口、健康检查、控制面步骤），就要改契约 + Worker + Agent + 前端 |
| G2 | 生命周期只有 install / uninstall / installed | `agent/adapters/app_catalog.py`、`run_manifest` 只认两个动作 | 无升级、启停、状态、日志；出问题只能重装或登录 VM |
| G3 | 前端按参数名特判 | `InstallAndPublishDrawer.tsx:195-201`（`public_url`）、`:806`（第一个 http 值当登录链接） | magpie 的约定写进了面板代码 |
| G4 | 内置清单打包进 Worker | `apps/api/src/lib/builtin-manifests.ts` 导入 magpie JSON | 改内置应用要发面板 |
| G5 | 发布只有一个 HTTP 本机端口 | `appManifestPublishSchema` | 多端点、非 HTTP、`0.0.0.0` 监听的应用表达不了 |
| G6 | 看不到运行状态；旧 recipe 通道仍随 Agent 包 | `installed.json` 只记安装时刻；`agent/recipes/catalog.json` | 不知道应用是否在跑；旧 recipe 改动要发 Agent |
| G7 | 参数只有 string / integer / boolean | `appManifestParamSchema` | 「模式 / 规格」这类单选做不了 |

### 1.4 khcsearch 带来的新需求

| 需求 | 文档依据 | 一期能否满足 |
|---|---|---|
| R1 安装前要在**控制面**调第三方 API 签发票据，用面板持有的 `PROVISION_API_KEY` | §3.1「面板 Key（推荐）」 | 否：Worker 只会注入清单 |
| R2 安装脚本由 Hub 按票据**动态生成**，无法固定 sha256 | §3.2 | 只能用固定的包装脚本去 `curl` 它，信任关系没有声明 |
| R3 需 root：apt 装依赖、写 `/opt`、`/etc/default`、system unit `khcsearch-node` | §4 | 可（`runtime.mode=root`） |
| R4 模式单选 `lite` / `full`，`full` 需 ≥0.8GB 内存 | §3.1 preset 表、§4 | 否：无 enum，无资源预检 |
| R5 健康检查 `GET /health`，首次拉配置可能 401 持续 5–60s | §3.4、§4 | 否：无健康检查，无启动宽限 |
| R6 监听 `0.0.0.0:7860`，多个 MCP 路径，客户端要另一枚 `MCP_BEARER_TOKEN` | §4 | 部分：只能发一个端口，不能声明鉴权提示 |
| R7 换端口 / 换模式要新票据；provision Key 不能吊销节点 | §6、§1 | 否：无升级动作；卸载后 Hub 留孤儿节点 |

## 2. 设计原则

1. **面板需要理解的才进声明，节点上的事全交给脚本。** 声明只覆盖面板必须看懂的：表单、控制面步骤、预检、健康、端点发布、结果展示。下载、编译、写配置、建 unit 全在脚本里，平台不解释。
2. **能力一次实现，应用只是数据。** 每种能力（如「控制面 HTTP 步骤」「HTTP 健康检查」）由平台实现一次、全部应用共用；代码里不出现任何应用名（延续 `AGENTS.md` §6）。
3. **加能力要发版，加应用不发版。** 声明词汇覆盖不到的新能力（如 Docker 运行时）发一次平台版本，此后所有应用都能用。
4. **版本协商代替悄悄失败。** 清单声明它要用的能力，Agent 上报它支持的能力；不匹配时安装前就明确告诉主人「该节点 Agent 需升级到 ≥x」。

## 3. 方案对比

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A 声明式应用包 v2（推荐）** | 扩充清单为固定能力词汇（§5），平台通用实现 | 加应用零代码；行为可审计；与一期兼容 | 一次性平台改动较大（契约 + Worker + Agent + 前端） | 采用 |
| B 每个应用写适配插件 | 每个应用在 Worker / 前端各写一段逻辑 | 灵活 | 每个应用都要发版，违背目标；`AGENTS.md` §6 禁止路由按应用名分支 | 否决 |
| C 全部交给节点脚本 | 不扩声明，provision Key 当 secret 参数下发节点，脚本自己调 Hub | 平台不改 | 签发 Key 扩散到每台 VM（任一节点 root 可无限签发）；面板看不到状态、无法升级 / 启停 | 否决 |

R1 的两种做法单列对比（§8 待拍板第 1 项）：

| 做法 | 密钥落点 | 失败影响 |
|---|---|---|
| **控制面步骤（推荐）**：Worker 用加密保存的 Key 调 provision，只把票据下发节点 | Key 只在 Worker 内存 | 票据单次、1 小时过期，泄漏面小 |
| 下发 Key 到节点 | 每台 VM 的进程环境 | 节点被攻破即可签发任意节点 |

## 4. 目标架构

```
设置 → 应用管理 ──CRUD / 导入──▶ Worker ──▶ D1 app_manifests（v2 清单 + 脚本）
                                     │          settings app.<id>.*（应用凭据，加密）
节点 → 应用 → 安装 ──▶ Worker：① 预检（Agent preflight）
                                ② 控制面步骤 hooks.preInstall（HTTP，凭据只在内存）
                                ③ 注入清单 + 步骤输出 ──HMAC──▶ Agent 执行器
                                                                 │ 校验 → 降权 → 脚本
                                                                 │ → 健康检查（带宽限）
                                                                 ▼
                                               installed 记录（版本、单元、端点、事实）
/state ◀── app_catalog.status()：每个已装应用的单元状态 + 健康 + 版本（受 B4 截止时间约束）
```

三层边界：

| 层 | 内容 | 变更方式 |
|---|---|---|
| L0 平台 | 契约 v2、Worker 步骤执行器、Agent 执行器、前端通用渲染 | 发版（低频） |
| L1 能力词汇 | §5 的字段集合与语义 | 随平台发版扩充，向后兼容 |
| L2 应用 | 清单数据 + 脚本 + 应用凭据 | **只改 D1，不发版** |

## 5. 清单 v2 能力词汇

新增 `schema: 2`。所有字段都是可选的，不用的能力不写。

| 字段 | 作用 | 执行方 | 解决 |
|---|---|---|---|
| `params[]` | 增 `type: enum`（`options[{value,label,requires?}]`）；已有的 `secret: true` 语义扩展到输入框掩码与 hooks 抹除；`derive: "endpoint:<id>.publicUrl"` 由面板推导、不进表单 | 前端 + Agent | G3、G7、R4 |
| `requires` | `arch[]`、`os[]`（debian / ubuntu / rhel 家族）、`memMB`、`diskMB`、`commands[]`；enum 选项可追加。所需的 Agent 能力由 Worker 按清单用到的字段自动推导，作者不写 | Agent 预检 + Worker 版本协商 | R4 |
| `runtime` | 不变（`root` / `create`） | Agent | R3 |
| `hooks` | 控制面 HTTP 步骤：`preInstall`、`preUpgrade`（不声明则升级时不执行控制面步骤，**不回退**到 preInstall，避免重复创建第三方资源；2026-11-23 V2 审核修订）、`preUninstall`；见 §6 | Worker | R1、R7 |
| `scripts` | `install`（必填）、`upgrade`（缺省用 install 并置 `KHC_ACTION=upgrade`）、`uninstall` | Agent | G2 |
| `units[]` | 声明本应用的 systemd 单元：`{name, scope: system\|user}`，名称可含 `{{instance}}`。平台据此通用实现启动 / 停止 / 重启 / 日志 / 运行状态 | Agent | G2、G6 |
| `health` | `{type: http\|tcp\|unit, url / port, expect, versionPointer?, graceSec, timeoutMs}`；只允许探测本机回环；安装后在宽限期内等它通过才报完成 | Agent | R5、G6 |
| `endpoints[]` | 替代 `publish`：`{id, label, protocol: http\|tcp, port / portParam, bind: loopback\|any, paths[]?, publish: caddy\|direct\|none, auth?: {type, hint}}`；可多个 | 前端 + Caddy / 防火墙 | G5、R6 |
| `outputs` | 统一 `KHC_RESULT`：`cards[]` 复用现有 `resultCardSchema`（`title, value, copy?, qr?`），新增可选 `kind: url\|secret\|text\|command` 与 `primary`；`facts{}`（非密钥事实，如外部节点 id、实际版本，写入 installed 记录）；旧 `access[]` 由 Agent 转成 cards | Agent → 前端 | G3、R7 |
| `sources[]` | 声明脚本会访问的外部来源：`{host, purpose, pinned}`；只做展示与审计，节点出站平台管不住，如实标注 | 前端展示 | R2 |

v1 清单在 Worker 读取时**内存升级**为 v2（`publish` → `endpoints[0]`，`access` → `cards`），D1 记录不改写，保存时才落 v2。

## 6. 控制面步骤（hooks）

```jsonc
"hooks": { "preInstall": {
  "method": "POST", "url": "https://xng.khc6.cn/api/admin/provision",
  "headers": { "Authorization": "Bearer {{secret.provision_key}}" },
  "body": { "name": "{{node.name}}-{{instance}}", "preset": "{{params.preset}}" },
  "extract": { "ticket": "/install/ticket", "script_url": "/install/script_url", "hub_node_id": "/node/id" },
  "public": ["hub_node_id"]
} }
```

- **模板只有固定变量**：`node.id`、`node.name`、`instance`、`params.<key>`、`secret.<name>`；无表达式、无代码执行。
- **提取用 JSON Pointer**（RFC 6901），每项 ≤4KB、最多 8 项；输出经 `KHC_HOOK_<KEY>` 环境变量交给脚本，默认按密钥处理（日志抹除、不进 D1 / 审计 / 任务结果），只有 `public` 列出的才进 `facts`。
- **出站约束**：只允许 https；不跟随重定向；10s 超时；响应 ≤64KB；不自动重试（第三方有副作用）。
- **凭据决定能发往哪里**：应用凭据存 settings 加密命名空间 `app.<manifestId>.<name>`，每条自带 `allowHosts`。`{{secret.x}}` 只能出现在发往其 `allowHosts` 的请求里。改清单换一个 URL 不能把 Key 带走（防的是 SSRF 式外泄，不依赖「只有主人能改清单」）。
- **顺序**：先 Agent 预检（可达 + `requires`），再执行步骤，最后下发安装任务。避免节点不可达时白白签发票据。
- **失败**：非 2xx 返回 502 `hook_failed`，带状态码与第三方 `error` 字段（截断 200 字符，绝不回显请求头 / 体）；写审计（主机、状态码，不含内容）。
- **卸载**：`preUninstall` 可选，在下发卸载任务**之前**执行：Worker 先同步读取节点 installed 记录里的 `facts`（如 `hub_node_id`），调用第三方注销，再下发卸载脚本。不放在卸载之后，是因为卸载是后台任务，Worker 不等任务结束；注销后节点被第三方吊销，随后卸载脚本清理即可。步骤失败默认中止卸载；主人可勾选「跳过控制面步骤」强制卸载（写审计），结果卡片提示第三方需人工处理。

## 7. 生命周期、状态与安全

### 7.1 动作

| 动作 | 实现 | 是否需要脚本 |
|---|---|---|
| 预检 | Agent 同步动作：架构 / 系统 / 内存 / 磁盘 / 命令 | 否 |
| 安装、升级 | 任务：hooks → 脚本 → 健康检查宽限 | 是 |
| 启动、停止、重启 | `systemctl [--user]`（按 `units` 声明） | 否 |
| 状态 | `is-active` + 健康检查 + installed 记录 | 否 |
| 日志 | `journalctl` 尾读 200 行，抹除密钥 | 否 |
| 卸载 | `preUninstall` → 任务：脚本 | 是 |

前端按清单有无对应声明决定显示哪些按钮，不需要改代码。

### 7.2 状态

- installed 记录（节点本地，0600）增加：清单版本、`schema`、单元、端点、`facts`、最近一次健康结果。
- `app_catalog.status()` 并发探测健康（每个 ≤1s），受 B4 的 2s 截止时间与过期兜底约束，随 `/state` 下发，不新增轮询。
- 「可升级」= 已装版本 ≠ D1 当前版本，在节点应用页显示。

### 7.3 安全口径（在一期 §6 基础上追加）

| 风险 | 处理 |
|---|---|
| 动态脚本无法固定 sha256（R2） | 仅允许来自 `sources` 声明的主机；包装脚本先下载到文件，把 sha256 打进任务日志再执行；应用管理页标「动态脚本」。信任前提是该主机由主人运营 |
| 应用监听 `0.0.0.0` | 端点 `bind: any` 时，安装向导检查宿主防火墙：未打算 `direct` 发布的端口应保持关闭；给出提示，不阻断 |
| 凭据外泄 | §6 凭据自带 `allowHosts`；凭据值不进清单、D1 清单行、审计、日志 |
| 健康检查被当作 SSRF | 只允许 `127.0.0.1` / `::1` |
| 声明与实际不符 | `sources`、`writes` 只作审计说明；平台不承诺拦截节点出站，文档如实写明 |

### 7.4 版本协商

- Agent 在 `/state.agent.capabilities.appManifest` 上报 `{schemas:[1,2], features:[...]}`；契约在 `agentSelfSchema` 上新增可选的类型化字段（向后兼容）。
- 安装前 Worker 经 Agent 预检动作取得节点能力，与按清单推导出的所需能力比对，不满足返回 409 `agent_upgrade_required`，并写明需要的最低 Agent 版本。
- v1 清单在旧 Agent 上照常工作；v2 清单要求节点支持 `schema 2`。

## 8. 应用库：内置清单去打包

- **仓库是编写与评审源，D1 是运行源。** `apps/manifests/<id>/` 保留，继续由 `verify-app-manifests.mjs` 和卸载测试守护。
- 删除 `builtin-manifests.ts` 打包与「缺就补、旧就升」逻辑；现有 D1 的 magpie 记录保留。
- 「应用管理」新增**导入**：粘贴 JSON、上传文件、从 https URL 拉取（如仓库 raw 地址）。导入前展示与 D1 当前版本的字段差异和脚本 sha256 新旧对比，确认后写入并审计。
- 新增 `scripts/publish-app-manifest.mjs`：用管理员会话调 API 推送仓库里的清单（口令只读环境变量），便于在 CI 之外一键更新。
- 旧 recipe 通道（`agent/recipes/` 的 sing-box、generic-service、demo-echo）**直接删除**（§12 第 4 项）：删 `agent/recipes/`、`agent/khc/recipes.py` 与 `app_catalog.py` 的 recipe 分支、`scripts/verify-app-catalog.mjs`、相关测试与 `verify.sh` 条目、`install.sh` 的 catalog 预检；`khc.pkg.ensure_packages` 被 caddy / wireguard / port-forward 共用，**保留**。删除前先用 `/state` 核对生产节点没有经旧 recipe 安装的应用，有则先卸载。

## 9. khcsearch 适配草图（V6 只交数据）

```jsonc
{ "schema": 2, "name": "khcsearch", "version": "20261121-01",
  "runtime": { "mode": "root" },
  "params": [
    { "key": "preset", "type": "enum", "default": "all_lite_api", "options": [
      { "value": "all_lite_api", "label": "全部工具 · 纯 API（~60MB）" },
      { "value": "all_full", "label": "全部工具 · 浏览器渲染", "requires": { "memMB": 800 } },
      { "value": "search_only", "label": "仅搜索" }, { "value": "image_only", "label": "仅生图 / 搜图" } ] },
    { "key": "port", "type": "integer", "default": 7860, "min": 1024, "max": 65535 } ],
  "requires": { "arch": ["amd64", "arm64"], "os": ["debian", "ubuntu", "rhel"], "diskMB": 1500 },
  "hooks": { "preInstall": "（见 §6）" },
  "scripts": { "install": "<包装脚本>", "uninstall": "<卸载脚本>" },
  "units": [{ "name": "khcsearch-node", "scope": "system" }],
  "health": { "type": "http", "url": "http://127.0.0.1:{{params.port}}/health", "expect": 200, "versionPointer": "/version", "graceSec": 120 },
  "endpoints": [{ "id": "mcp", "label": "MCP 端点", "protocol": "http", "portParam": "port", "bind": "any",
    "paths": ["/mcp", "/search/mcp", "/image/mcp", "/mcp/sse"], "publish": "caddy",
    "auth": { "type": "bearer", "hint": "需要 Hub 签发的 MCP_BEARER_TOKEN" } }],
  "sources": [{ "host": "xng.khc6.cn", "purpose": "按票据生成的安装脚本", "pinned": false },
              { "host": "huggingface.co", "purpose": "运行时文件", "pinned": false }] }
```

包装脚本要点：用 `KHC_HOOK_SCRIPT_URL` 带超时下载 → 打印 sha256 → 按 preset 选 `--lite` / `--full` 与 `--port` 执行；`KHC_RESULT` 回传 `cards`（各 MCP 端点 URL、鉴权提示）与 `facts.hub_node_id`。卸载脚本：停用并删除 `khcsearch-node`，删 `/opt/khcsearch`、`/etc/default/khcsearch`，逐项复查。

**对 khcsearch Hub 的配套建议**（主人自己的仓库，不在本提案实施范围）：

1. 安装脚本支持 `--host 127.0.0.1`：节点只监听回环，由 Caddy 带 TLS 发布。
2. provision Key 可吊销**自己签发的**节点，或提供节点用自身令牌注销的接口：供 `preUninstall` 使用，消除孤儿节点。
3. 为已有节点重新签发票据（换端口 / 模式不新建节点）：供 `preUpgrade` 使用。
4. provision 按 `name` 幂等，或返回已存在节点：安装失败重试不产生重复节点。
5. 在 claim 或 provision 响应中可选返回 MCP 客户端令牌，或说明获取方式：面板可展示「如何接入」。

## 10. 范围与不做

- **做**：清单 v2 与 v1 兼容、控制面 HTTP 步骤、应用凭据、预检、单元生命周期、健康检查、多端点发布、统一结果卡片、版本协商、内置去打包与导入、旧 recipe 退役、khcsearch 作为首个免发版样例。
- **不做**：Docker / 容器运行时（留给以后加能力）；应用间依赖；多副本 / 集群编排；节点出站强制管控；签名验证（维持一期「不签名靠审计」，`release_verify.py` 能力保留）；khcsearch Hub 自身的改动。

## 11. 批次

| 批次 | 内容 | 改动范围 | 关键验收 | 类型 / bump |
|---|---|---|---|---|
| V1 契约与 ADR | 清单 v2 schema、v1→v2 归一化、能力上报字段、`$appSecret` 引用；ADR-0023；改写 `docs/hosted-apps.md` 结构 | contracts、文档 | v1 magpie 归一化后与原行为等价（快照测试）；未知字段仍拒绝 | X，面板 minor |
| V2 Worker | 控制面步骤执行器、应用凭据（`allowHosts`）、预检编排、版本协商、审计 | `apps/api` | 步骤：模板、提取、https / 无重定向 / 超时 / 大小、凭据越界拒绝、失败不回显，全部有测试；路由无应用名 | A，面板 minor |
| V3 Agent | 执行器 v2：upgrade、units 生命周期、日志、健康 + 宽限、预检、`KHC_HOOK_*`、cards / facts、能力上报、installed 记录扩展 | `agent/khc/`、`agent/adapters/app_catalog.py` | 单测覆盖每个动作；健康只允许回环；B4 截止时间下 `/state` 不被拖慢；真机 plan→apply→回滚不受影响 | G，Agent minor |
| V4 前端通用化 | 表单（enum / secret / derive）、多端点发布、卡片渲染、已装应用（状态 / 健康 / 版本 / 升级 / 启停 / 日志）、应用凭据与 `sources` 展示；删除 `public_url` 与正则特判 | `apps/web`、`page-specs.md` | 源码扫描：前端无应用名、无参数名特判；四态 + 浅色 / 深色 / 390 截图 | W，面板 minor |
| V5 应用库 | 去打包、导入（粘贴 / 文件 / URL + 差异确认）、`publish-app-manifest.mjs`、旧 recipe 删除（§8）、magpie 转 v2 数据 | `apps/api`、`apps/web`、`agent/recipes`、`scripts` | 改 magpie 脚本后不发版即可在测试节点重装生效 | A + W + P，面板 minor、Agent patch |
| V6 khcsearch | 只写 `apps/manifests/khcsearch/` 与文档，经导入上线 | **只有数据** | **不发版验收**：`git diff --stat` 只含 `apps/manifests/khcsearch/` 与文档；测试节点完成预检→安装→健康→发布→重启→升级→卸载全链路 | D，不 bump |

依赖：V1 → V2、V3（可并行）→ V4 → V5 → V6。`AGENTS.md` §6「两类应用」条款在 V1 同步修订（脚本式应用 = 清单数据，深度集成仍写适配器）。本提案合入时，`docs/plans/app-manifests-2026-11-15.md`（R1 / R2 已实施）移入 `docs/archive/plans/`。

## 12. 拍板结果（2026-11-23）

| # | 事项 | 结论 |
|---|---|---|
| 1 | khcsearch provision 的调用方 | **控制面步骤**：Worker 持有 Key，节点只拿一次性票据 |
| 2 | 动态安装脚本（不固定 sha256） | **允许**：仅限 `sources` 声明的主机，下载后先记 sha256 再执行，应用管理页标「动态脚本」 |
| 3 | 应用凭据存放 | settings 加密命名空间 `app.<manifestId>.<name>`，值为 `{value, allowHosts[]}`，不新增表（按推荐） |
| 4 | 旧 recipe（sing-box、generic-service、demo-echo） | **直接删除**（做法见 §8） |
| 5 | 内置 magpie | 去打包；现有 D1 记录保留，以后经导入更新（按推荐） |
| 6 | `bind: any` 的应用 | 仅提示 + 防火墙检查，不阻断（按推荐） |
| 7 | 批次顺序与验收样例 | 按 §11；V6 khcsearch 作为不发版验收样例。§9 的 Hub 配套由主人在 khcsearch 仓库自行排期：第 2、3 条未就绪时，V6 的升级 / 卸载只验收「面板侧完成 + 结果卡片提示 Hub 侧需人工处理」，其余环节照常验收 |

## 13. 批次开工说明

| 批次 | 开工说明 | 状态 |
|---|---|---|
| V1 | `docs/plans/app-distribution-v2-2026-11-23-v1.md` | 可开工 |
| V2 | `docs/plans/app-distribution-v2-2026-11-23-v2.md` | V1 合入后开工 |
| V3 | `docs/plans/app-distribution-v2-2026-11-23-v3.md` | V1 合入后开工（与 V2 并行） |
| V4–V6 | V1 合入后由设计任务按最终契约补写 | 待写 |

开发中发现提案或开工说明有误，在 PR 里提出，由设计任务修订；开发 PR 不修改 `docs/plans/` 下的文件。
