# V5 开工说明：应用库——内置去打包、导入、magpie 转 v2、旧 recipe 删除与 Agent 0.8.1 修复

> 状态：已拍板 ｜ 最后核验：2026-11-23 ｜ 关联：`docs/plans/app-distribution-v2-2026-11-23.md` §8、§11 V5、§12 第 4–5 项；`docs/verification/2026-11-23/manifest-v2-live.md` §五-2

> **给开发 agent**：开工前提：**V4 已合入**，**V4.1 已合入**（Worker 对 upgrade 转发原始 `values`，§8.2 依赖它），V4 真机证据（V4 §7 流程、magpie v1 安装/卸载回归、9 张截图与四态说明）已合入 `docs/verification/`，且**全部生产节点已升级到 Agent ≥ 0.8.0**（magpie 改成 v2 后，0.7.x 节点会返回 409）。先读 `AGENTS.md`、提案、V4 与本文全文。本批跨 Worker、前端、Agent、脚本，分成两个 PR（§0）。认为本文有误时在 PR 里提出，不要改 `docs/plans/` 下的文件。

## 0. 速览

| PR | 分支 | 内容 | 类型 / 版本 |
|---|---|---|---|
| V5a | `feat/app-library` | §2 去打包、§3 导入、§4 推送脚本、§5 magpie v2、§6 校验脚本通用化 | A + W，面板 **minor** |
| V5b | `chore/remove-legacy-recipes` | §7 旧 recipe 删除、§8 Agent 0.8.1（8.1 用户总线就绪、8.2 安装记录保存参数值） | G + P，Agent **patch → 0.8.1**；面板不 bump（无 `apps/` 改动时） |

合并顺序：V5a → 在测试节点用新导入功能导入 magpie v2 并回归 → V5b → 测试节点升级 0.8.1 → 滚动升级。

## 1. 开工前核对（结果写进 V5b 的 PR 描述）

1. 三台节点 `GET /api/v1/nodes/:id/state` 的 `agent.version` 都 ≥ 0.8.0。
2. 三台节点 `app-catalog` 的 `status.installedDetail` 中，没有 `source !== 'manifest'` 的条目（即没有经旧 recipe 安装的应用）。有的话先在节点上用旧路径卸载，再继续。

## 2. 内置清单去打包（V5a）

- 删除 `apps/api/src/lib/builtin-manifests.ts`、`GET /app-manifests` 里对 `ensureBuiltinAppManifests` 的调用，以及相关测试。
- D1 里现有的 magpie 记录不动。新部署的 D1 不再自动出现 magpie，需导入（§3 / §4）。
- `apps/manifests/<id>/` 仍是编写与评审源，manifest.json 里的 `priorManifests` 字段删除（不再需要）。

## 3. 导入（V5a，只改前端，不新增 Worker 接口）

位置：设置 → 应用管理页头新增主操作 [导入应用] → 打开页面级抽屉（不弹 Dialog），三种来源用分段切换：

| 来源 | 做法 | 限制 |
|---|---|---|
| 粘贴 JSON | 文本域 | — |
| 上传文件 | `<input type=file accept=".json">` | ≤ 512KB |
| 从 URL | **浏览器端** `fetch(url, {credentials: 'omit', redirect: 'error'})` | 只允许 `https://`；≤ 512KB；跨域失败时提示「该地址不允许跨域读取，请下载后用文件导入」 |

- 不经 Worker 拉 URL：避免给 Worker 增加任意出站能力（SSRF）。
- 接受两种格式：仓库格式 `{id, enabled?, manifest}`，或裸清单（此时要求填写应用 ID）。先在前端用 `appManifestAnyDefinitionSchema` 解析，失败按 zod issue 的 path 标出错误。
- **差异确认**：ID 已存在时，确认前展示与 D1 当前版本的对比：版本、各脚本 sha256（变化标出）、参数增删、`runtime.mode` 变化（`create → root` 用 danger 提示）、控制面步骤的阶段与主机、`sources`、`secrets` 声明。确认后 `PUT`；不存在时 `POST`。保存返回的 `warnings[]` 照 V4 展示。
- 审计沿用 Worker 现有 `appManifest.create / update`，不需要新增。

## 4. 推送脚本（V5a）`scripts/publish-app-manifest.mjs`

- 用法：`KHC_PASSWORD=[REDACTED_PASSWORD] [KHC_TOTP=…] node scripts/publish-app-manifest.mjs --base <面板地址> <appId> [--yes]`。
- 读 `apps/manifests/<appId>/manifest.json` → 登录（复用 `scripts/lib/relay-latency.mjs` 的 `sessionCookie`）→ `GET /api/v1/app-manifests` 取当前记录 → 打印与 §3 相同口径的差异摘要。
- 默认只打印（dry run）；带 `--yes` 才 `POST` / `PUT`，打印响应里的 `warnings`。
- 口令只读环境变量，不打印。加入 `verify.sh` 的 `node --check` 列表。

## 5. magpie 转 v2 数据（V5a）

改 `apps/manifests/magpie/` 三个文件，之后用 §3 或 §4 导入生产：

| 字段 | 取值 |
|---|---|
| `schema` / `version` | `2` / `0.1.4265-khc.2`（magpie 本体版本仍是脚本里的 `VER`） |
| `requires` | `arch: [amd64, arm64]`、`diskMB: 200`、`commands: [python3]` |
| `params` | 保留 `port`、`web_port`、`web_key`（`secret: true`）；`public_url` 改为 `derive: "endpoint:web.publicUrl"` |
| `units` | `[{name: "khc-magpie-{{instance}}.service", scope: "user"}]` |
| `health` | `{type: "tcp", portParam: "web_port", graceSec: 60}`（Web 页无 key 返回 401，不用 http 检查） |
| `endpoints` | `web`：http、`portParam: web_port`、loopback、caddy、`auth: {type: key-in-url, hint: "登录链接中的 ?k= 即凭据"}`；`gateway`：http、`portParam: port`、loopback、`publish: none`、`auth: {type: none, hint: "OpenAI / Anthropic / Gemini 兼容端点，仅本机"}` |
| `sources` | `[{host: "github.com", purpose: "magpie 发布包（固定版本 + sha256）", pinned: true}]`（下载重定向到的 objects.githubusercontent.com 一并列出） |

脚本改动：

- `install.sh` 启动段：`enable` 之后**一律** `systemctl --user restart`（升级时会回退执行 install 脚本，`enable --now` 不会重启已在运行的服务）。
- `install.sh` 结果段：只输出 `cards`，不再输出 `access`：登录链接 `{kind: url, primary: true}`、Web Key `{kind: secret}`、网关地址 `{kind: text}`、版本 `{kind: text}`。
- 改完跑 `node scripts/verify-app-manifests.mjs --sync`，`manifest-uninstall-test.sh magpie` 通过。

## 6. 校验脚本通用化（V5a）

- `scripts/verify-app-manifests.mjs` 现在写死 v1 字段表。改为：只保留文件齐全、id 与目录一致、脚本与内联正文逐字节相等、sha256、`bash -n` 这些检查（覆盖 `upgrade` 脚本，存在时）；**schema 校验移到** 新增的 `scripts/test/app-manifests.test.ts`，用 `appManifestAnyDefinitionSchema` 逐个解析 `apps/manifests/*/manifest.json`，保证契约只有一个来源。
- `scripts/manifest-uninstall-test.sh` 现在写死 magpie 的现场。改为读每个应用目录下的 `uninstall-fixture.json`：

  ```jsonc
  { "home": ["bin/x", ".config/systemd/user/u.service"],   // 相对应用用户家目录
    "appHome": ["config/legacy"],                           // 相对 KHC_APP_HOME
    "root": ["opt/app", "etc/default/app"],                 // 相对 KHC_ROOT（root 模式应用）
    "symlinks": [[".config/systemd/user/default.target.wants/u.service", ".config/systemd/user/u.service"]] }
  ```

  测试造出全部路径 → 运行内联的 uninstall → 断言全部消失 → 再跑一次验证幂等；不带参数时遍历全部应用。`systemctl` / `getent` 照旧用桩。
- 约定（写进 `docs/hosted-apps.md`）：**root 模式应用的脚本，所有系统路径都要加 `${KHC_ROOT%/}` 前缀**（生产为 `/`），这样卸载测试不需要 root。
- 为 magpie 补 `uninstall-fixture.json`，覆盖原脚本里造的全部路径。

## 7. 旧 recipe 删除（V5b）

删除：`agent/recipes/`（`catalog.json` 与 sing-box、generic-service、demo-echo）、`agent/khc/recipes.py`、`agent/tests/test_recipes.py`、`agent/tests/test_catalog.py`、`scripts/verify-app-catalog.mjs`。

修改：

| 文件 | 改动 |
|---|---|
| `agent/adapters/app_catalog.py` | 删除 recipe 分支与 `KHC_RECIPES_DIR`；`recipe_install` / `recipe_uninstall` / `recipe_installed` 保留为清单动作的别名（v1 清单仍用它们），不带 `manifest` 时 400 `manifest_required`；`status()` 不再返回 `recipes`；更新模块文档字符串 |
| `agent/package.sh` | 打包列表去掉 `recipes` |
| `agent/install.sh` | 删除 `recipes/catalog.json` 的预检与告警（约第 342、345、664 行） |
| `agent/tests/test_cli.py` | 删除「recipes 必须随包落盘」的断言，改为断言安装包**不含** `recipes/` |
| `scripts/verify.sh` | 删除 `app catalog drift` 步骤、`node --check` 与 `bash -n` 里的 recipe 相关条目 |
| `agent/khc/pkg.py` | **保留**（caddy、wireguard、port-forward 共用 `ensure_packages`） |

文档：`docs/security-boundaries.md`（recipe 一节改写为清单执行器；顺带把 §13 最后一条改成「hook 声明 `extract` 时，在执行之前即拒绝明文通道」）、`docs/design-v3.md`、`docs/dual-mode.md`、`docs/ui-redesign/ui-guidelines.md` 中引用旧 recipe 的句子、`docs/hosted-apps.md` §1 三层表、`agent/README.md`。

## 8. Agent 0.8.1（V5b）

### 8.1 create 模式用户总线就绪

真机证据 §五-2：新建应用用户后立即执行 `systemctl --user`，Ubuntu 24.04 上 `user@<uid>.service` 尚未就绪，报 `Failed to connect to bus`。修复放在 `agent/khc/app_manifests.py`：

1. `create` 模式、需要 linger 时：`enable-linger` 之后，若 `/run/user/<uid>/bus` 不存在，执行 `systemctl start user@<uid>.service`（与 PID 1 通信，不受沙箱影响），然后轮询该 socket，最多 15s（可注入时钟与 sleep 以便测试）。
2. 仍未就绪：任务日志记一行警告并继续执行（脚本可能自己处理），不静默吞掉。
3. 降权执行脚本时注入 `XDG_RUNTIME_DIR=/run/user/<uid>` 与 `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus`；`manifest_control` 的 user 单元命令同样带上这两个变量。
4. 测试：socket 已存在时不调用 `systemctl start`；不存在时调用一次并在出现后继续；15s 超时记警告；环境变量注入断言 argv / env。
5. `VERSION = "0.8.1"`；`MIN_PANEL_VERSION` 不变。

### 8.2 安装记录保存参数值，升级沿用（提案 §15）

V4 真机证据 §五-1：安装记录不保存参数值，升级时只能拿到清单默认值，无默认值的参数报缺失、改过默认值的参数被静默改回。修复放在 `agent/khc/app_manifests.py`：

1. **保存**：install / upgrade 成功落记录时（`run_manifest` 写 `record` 处），增加 `values`：本次实际生效的 `typed_values`（含 secret 参数与 derive 参数的值）。记录文件沿用 0600、目录 0700、属主 root。
2. **不外泄**：`read_installed_manifests` 是字段白名单，**不得**把 `values` 拷进条目；`status()`、`manifest_installed`、`/state`、任务日志、`KHC_RESULT` 都不出现参数值。secret 参数值继续进 `_secret_values` 做日志遮罩。
3. **升级合并**：`action == "upgrade"` 时，参数值 = 本次请求 `values` > 记录里的 `values` > 新清单 `default`。记录里有、新清单已删除的键**静默丢弃**（不要触发「存在未声明的参数」）；记录值不满足新清单校验（如枚举选项被删、范围变了）时报错，带 `details.field`。
4. **旧记录**：0.8.0 写的记录没有 `values`，按现状只用请求值 + 默认值；缺失时照旧报 `缺少参数 X`。
5. **错误码**：参数校验类错误（缺失、未声明、类型、范围、枚举、长度、pattern、控制字符）统一 `code="param_invalid"`，`details.field` 必带（未声明的参数给第一个键）。前端 V4.1 只认 `details.field`，所以改 code 不影响前端。
6. **卸载**：记录删除即随之删除，不另行处理。uninstall 校验参数时同样用「请求值 > 记录值 > 默认值」（避免卸载因缺参失败）；旧记录无 `values` 且仍缺参数时照旧拒绝（`param_invalid` + `details.field`），**不要**用空串或省略顶替——卸载脚本常用参数拼路径，空值可能误删。
6a. **预检**：`manifest_preflight` 在 upgrade / uninstall 阶段同样按「请求值 > 记录值 > 默认值」合并后再做端口等检查（Worker 自 V4.1 起转发原值）。
7. 测试：保存后记录含 `values` 且 `read_installed_manifests` / `status()` 输出不含任何参数值（含 secret，断言序列化后的字符串不含该值）；升级合并三层优先级各一例；新清单删参数静默丢弃；记录值违反新校验报 `param_invalid` + `field`；旧记录（无 `values`）行为与 0.8.0 一致；uninstall 用记录值。

## 9. 测试汇总

- V5a：导入三种来源（URL 来源用假 fetch：非 https 拒绝、超 512KB 拒绝、跨域失败提示）；差异确认的每类变化；`create → root` 警示；`app-manifests.test.ts` 全部清单通过 v2 / v1 schema；推送脚本 dry run 不发写请求、`--yes` 才发；`GET /app-manifests` 不再写 D1（去打包回归）；卸载测试遍历全部应用。
- V5b：Agent 单测（§8.1-4、§8.2-7）；`app_catalog` 不带 manifest 的 `recipe_*` 返回 400；`install-lifecycle-test.sh` 与 `test_cli.py` 通过；`verify.sh` 全绿。

## 10. 证据

- V5a：测试节点（0.8.0）上用 [导入应用] 从仓库 raw URL 导入 magpie v2（截图差异确认页）→ 安装 → 两个端点只发布 web → 完成页主按钮可登录 → 升级（版本相同，应不显示升级按钮）→ 卸载；一台仍装着 v1 magpie 的节点，导入后能用 v2 清单卸载。
- V5b：测试节点升级 0.8.1，**用一个从未存在过的应用用户**安装 magpie，首装即成功（无 bus 报错）；用 `ux-` 清单（一个无默认值参数、一个改过默认值的端口参数）安装 → 升级时不填任何参数 → 成功且健康检查仍在安装时的端口；`/state` 与任务日志里搜不到参数值；滚动升级其余节点（间隔 ≥ 60s）。
- 证据写入 `docs/verification/<日期>/app-library.md`。

## 11. 审核清单

- [ ] 开工前核对两项有结果；无旧 recipe 安装残留
- [ ] builtin 去打包；`GET /app-manifests` 无写库
- [ ] 导入在前端完成，URL 只允许 https、不带凭据、不跟随重定向、有大小上限；差异确认覆盖 §3 各项
- [ ] 推送脚本默认 dry run；口令只读环境变量
- [ ] magpie v2 字段与 §5 表一致；install 一律 restart；结果只输出 cards
- [ ] schema 校验只有一个来源（contracts）；卸载测试按 fixture 遍历全部应用
- [ ] 旧 recipe 文件与引用全部删除，`pkg.py` 保留；`recipe_*` 别名保留
- [ ] 0.8.1 总线就绪修复与测试；安装记录保存 `values`、不外泄、升级三层合并、`param_invalid` + `field`；`docs/security-boundaries.md` 写明安装记录含参数值（0600，root）；文档六处；版本号正确
