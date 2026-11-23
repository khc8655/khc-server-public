# V6 开工说明：khcsearch 应用包——只交数据的免发版验收

> 状态：已拍板 ｜ 最后核验：2026-11-23 ｜ 关联：`docs/archive/plans/app-distribution-v2-2026-11-23.md` §9、§11 V6、§12 第 7 项；khcsearch 接入文档（主人提供的 `node-provisioning-api.md`，文档版本 20261121-01）

> **给开发 agent**：开工前提：**V5a、V5b 已合入**，测试节点已是 Agent 0.8.1。本批是「加一个应用不发版」的验收：**只允许新增 `apps/manifests/khcsearch/` 与验证证据**，任何 `apps/`（除 manifests）、`packages/`、`agent/`、`scripts/`、`migrations/` 的改动都说明平台还有缺口——此时停下，在 PR 里写明缺什么，由设计任务补到平台批次，不要在本批绕过。认为本文有误时在 PR 里提出，不要改 `docs/plans/` 下的文件。

## 0. 速览

| 项 | 值 |
|---|---|
| 分支 | `feat/app-khcsearch` |
| PR 标题 | `feat(apps): khcsearch 数据面节点应用包（清单 v2）` |
| 发版类型 | D（只有数据与文档），**不 bump** |
| 验收门槛 | `git diff --stat main...` 只含 `apps/manifests/khcsearch/**` 与 `docs/verification/**` |

## 1. 交付文件

```
apps/manifests/khcsearch/
├── manifest.json            # {id: "khcsearch", enabled: true, manifest: {...v2...}}
├── install.sh
├── uninstall.sh
├── uninstall-fixture.json   # V5 定义的卸载测试现场
└── README.md                # 凭据配置、限制、排障
```

`node scripts/verify-app-manifests.mjs --sync` 回填正文与 sha256；`scripts/test/app-manifests.test.ts` 与 `./scripts/manifest-uninstall-test.sh khcsearch` 通过。

## 2. 清单（`manifest` 字段）

| 字段 | 取值 |
|---|---|
| `schema` / `name` / `version` | `2` / `khcsearch` / `20261121-01`（对齐 Hub 文档版本；包装脚本改动时追加 `-khc.N`） |
| `runtime` | `{mode: "root"}`（Hub 安装脚本要求 root：装依赖、写 `/opt`、`/etc/default`、system unit） |
| `params` | `preset`：enum，默认 `all_lite_api`，选项 `all_lite_api`「全部工具 · 纯 API（约 60MB）」、`all_full`「全部工具 · 浏览器渲染」（`requires.memMB: 800`）、`search_only`「仅搜索」、`image_only`「仅生图 / 搜图」；`port`：integer，默认 7860，1024–65535；`public_url`：string，`derive: "endpoint:mcp.publicUrl"` |
| `requires` | `arch: [amd64, arm64]`、`os: [debian, ubuntu, rhel]`、`diskMB: 1500`、`commands: [curl, sha256sum]` |
| `secrets` | `[{name: "provision_key", label: "khcsearch 签发 Key（PROVISION_API_KEY）", hint: "只能签发新节点；允许主机填 xng.khc6.cn"}]` |
| `hooks.preInstall` | 见下 |
| `units` | `[{name: "khcsearch-node.service", scope: "system"}]` |
| `health` | `{type: http, url: "http://127.0.0.1:{{params.port}}/health", expectStatus: 200, versionPointer: "/version", graceSec: 120, intervalSec: 3}` |
| `endpoints` | `[{id: mcp, label: "MCP 端点", protocol: http, portParam: port, bind: any, paths: ["/mcp", "/search/mcp", "/image/mcp", "/mcp/sse"], publish: caddy, auth: {type: bearer, hint: "客户端需 Hub 签发的 MCP_BEARER_TOKEN（与节点令牌不同）"}}]` |
| `sources` | `xng.khc6.cn`「按票据生成的安装脚本」、`huggingface.co`「运行时文件」、`pypi.org`、`files.pythonhosted.org`「Python 依赖」，全部 `pinned: false` |
| `writes` | `[]`（root 模式不用 `~/` 声明） |

```jsonc
"preInstall": {
  "method": "POST",
  "url": "https://xng.khc6.cn/api/admin/provision",
  "headers": { "Authorization": "Bearer {{secret.provision_key}}" },
  "body": { "name": "{{node.name}}-{{instance}}", "preset": "{{params.preset}}", "ticket_ttl_sec": 3600 },
  "extract": { "script_url": "/install/script_url", "hub_node_id": "/node/id" },
  "public": ["hub_node_id"],
  "expectStatus": [200]
}
```

- **只提取 `script_url`**：票据已嵌在 URL 里，不再单独提取 `ticket`，少一个密钥面。
- **不声明 `preUpgrade`、`preUninstall`**：Hub 目前没有「为已有节点重签票据」和「用签发 Key 注销节点」的接口（提案 §9 第 2、3 条）。Hub 支持后，只需改本清单数据补上这两个阶段，不用发版——这正是本批要证明的。

## 3. `install.sh`（以 root 在沙箱外执行）

1. `set -euo pipefail`；`R="${KHC_ROOT%/}"`。
2. `KHC_ACTION=upgrade`：直接失败，输出「khcsearch 升级需要 Hub 支持为已有节点重新签发票据；目前请卸载后重装」，`exit 1`。
3. 校验 `KHC_HOOK_SCRIPT_URL` 匹配 `^https://xng\.khc6\.cn/api/install/sit_[0-9a-f]{48}$`，不匹配即失败（防止清单被改后从别处拉脚本）。**不要**把该变量 echo 出来（它就是安装凭据）；Agent 会抹除，但脚本自己也不打印。
4. 下载到 `mktemp` 文件，照抄 `docs/hosted-apps.md` §3.1 的 curl 超时参数；失败打印已下载字节数与排查方法。
5. 打印 `sha256sum` 与文件大小（动态脚本的审计依据），并检查首行是 `#!` 开头的 bash 脚本。
6. 模式：`preset = all_full` → `--full`，其余 → `--lite`。
7. 执行：`bash "$TMP" "$MODE" --dir "$R/opt/khcsearch" --port "$KHC_PARAM_PORT"`；不传 `--source`（用 Hub 默认值）。
8. 输出 `KHC_RESULT`：
   - `cards`：`public_url` 非空时，每个 MCP 路径一张 `{title, value: "<public_url><path>", kind: url, copy: true}`（第一张 `primary: true`）；为空时给本机地址 `http://127.0.0.1:<port>/mcp` 与提示「到节点应用页发布 MCP 端点后再接入」；一张 `{kind: text}` 鉴权说明；一张 `{kind: text}`「安装脚本 sha256」。
   - `facts`：`{install_mode: "lite"|"full", port: <port>}`（`hub_node_id` 已由控制面步骤写入）。

## 4. `uninstall.sh`

1. `R="${KHC_ROOT%/}"`；`systemctl disable --now khcsearch-node.service || true`。
2. 删除 unit 文件与 wants 链接、`daemon-reload`；删除 `$R/etc/default/khcsearch`。
3. 删除 `$R/opt/khcsearch` 前做标记检查：目录内有 `app.py` 或目录为空才删，否则保留并在结果里点名（防误删）。
4. 逐项复查，仍有残留就在 `KHC_RESULT` 里列出并 `exit 1`（与 `docs/hosted-apps.md` §5 口径一致）。
5. `cards`：`{kind: text}`「Hub 侧节点未注销：请在 khcsearch Hub 控制台停用该节点（节点 ID 见安装信息中的 hub_node_id）」。
6. **unit 的真实路径以实机为准**：首次真机安装后执行 `systemctl show -p FragmentPath khcsearch-node`（经主机运维或任务日志获取），按结果修正卸载脚本与 `uninstall-fixture.json`。不要猜。

## 5. 上线步骤（数据操作，不发版）

1. 设置 → 应用管理 → [导入应用]（或 `scripts/publish-app-manifest.mjs khcsearch --yes`）导入。
2. 在该应用抽屉的「凭据」区设置 `provision_key`：值为主人提供的 `PROVISION_API_KEY`，允许主机 `xng.khc6.cn`。
3. 选一台**域名或 Tunnel 接入**的测试节点（IP 明文节点会被 `insecure_channel_secret` 拒绝，这是预期行为）。

## 6. 验收（真机，证据写入 `docs/verification/<日期>/khcsearch.md`）

| # | 步骤 | 通过条件 |
|---|---|---|
| 1 | 范围 | `git diff --stat` 只含 §0 门槛内的文件 |
| 2 | 能力与预检 | 0.8.1 节点预检通过；把 `preset` 选成 `all_full` 且节点内存 < 800MB 时，预检列出 `memMB` 失败 |
| 3 | 凭据边界 | 临时把 `allowHosts` 改成别的主机 → 403 `secret_host_not_allowed`，Hub 未产生新节点；改回 |
| 4 | 安装 | 任务完成；`app.hook` 审计有一条 `outcome: ok`；任务日志里没有 `sit_` 票据与签发 Key |
| 5 | 健康 | 健康检查在 `graceSec` 内通过，`lastHealth.version` 有值；已装应用显示「运行中」 |
| 6 | 发布 | 在向导里发布 `mcp` 端点；`https://<域名>:<端口>/mcp` 不带令牌时返回 Hub 定义的鉴权失败（证明链路通）；7860 端口从公网不可达 |
| 7 | 启停与日志 | 重启后 `active`；日志可读且无票据 / Key |
| 8 | 升级 | 按预期失败，提示文案与 §3 第 2 步一致 |
| 9 | 卸载 | 任务完成；单元消失、7860 不再监听（主机运维的服务与监听端口可见）；结果卡片提示 Hub 侧需人工停用 |
| 10 | 重试代价 | 记录本次验收在 Hub 上产生的节点数，与 `hub_node_id` 逐一对应，写进证据，便于主人在 Hub 清理 |

第 8、9 项按提案 §12 第 7 项的口径验收：「面板侧完成 + 卡片提示 Hub 侧需人工处理」即通过。

## 7. README.md 要写清楚

凭据怎么配；只能装在域名 / Tunnel 节点；每次安装都会在 Hub 新建一个节点，安装失败重试会留下 Hub 侧孤儿节点（Hub 支持按名称幂等前需人工清理）；暂不支持升级；卸载后需到 Hub 停用节点；MCP 客户端需要另外的 `MCP_BEARER_TOKEN`；动态脚本的 sha256 在任务日志与结果卡片里。

## 8. 审核清单

- [ ] diff 只含 `apps/manifests/khcsearch/**` 与证据
- [ ] 清单字段与 §2 一致；只提取 `script_url` 与 `hub_node_id`；无 `preUpgrade` / `preUninstall`
- [ ] install：URL 主机与格式校验、不打印票据、超时参数、sha256 输出、upgrade 明确失败
- [ ] uninstall：`KHC_ROOT` 前缀、删除前标记检查、残留点名、Hub 提示卡片；unit 路径来自实机
- [ ] 卸载测试与 schema 测试通过
- [ ] 真机 10 项证据齐全；Hub 侧产生的节点已列出
