# 托管应用（应用清单 · 面板安装 · 一键发布）

> 状态：现行 ｜ 最后核验：2026-11-23 ｜ 关联：`apps/manifests/`、`apps/web/src/data/manifestApps.ts`、`apps/web/src/apps/caddy/InstallAndPublishDrawer.tsx`

## 1. 是什么

「应用」是装在节点上、以独立 systemd unit 常驻的服务。面板只负责**下发清单 → 执行前置控制面步骤 → 起后台安装/升级任务 → 展示结果**，脚本本身在节点上执行，凭据类数据不进入日志、控制面凭据不进入节点磁盘。

三者分工：

| 层 | 位置 | 职责 |
|---|---|---|
| 仓内清单 | `apps/manifests/<id>/manifest.json` | 唯一的可评审来源；`scripts/verify-app-manifests.mjs` 校验脚本正文与 sha256，字段由 `scripts/test/app-manifests.test.ts` 用契约校验 |
| D1 记录 | 表 `app_manifests`（`migrations/0013_app_manifests.sql`） | 控制面运行时读的那份，可在「设置 → 应用管理」维护 |
| 节点执行器 | `agent/khc/app_manifests.py` | 支持 schema v1/v2 执行、预检、启停/日志与健康检查 |

仓库是编写与评审源，D1 是运行源：Worker 不打包任何应用，`GET /api/v1/app-manifests` 只读。新环境的应用库为空，经下面两种方式导入（改脚本后不发版即可生效）：

- **面板**：「设置 → 应用管理」页头 [导入应用]，来源为粘贴 JSON、上传文件（≤ 512KB）或 https URL（浏览器端 `fetch`，`credentials: 'omit'`、不跟随重定向、≤ 512KB，对方须允许跨域读取；不经 Worker）。接受仓库格式 `{id, enabled?, manifest}` 或裸清单（需填应用 ID）。前端先用契约解析，ID 已存在时展示与 D1 当前版本的差异（版本、各脚本 sha256、参数增删、`runtime.mode` 变化——`create → root` 标高风险、控制面步骤的阶段与主机、`sources`、`secrets` 声明），确认后 `PUT`，新 ID 则 `POST`；Worker 拒绝时按 `fields` 路径标出。审计沿用 `appManifest.create / update`。
- **脚本**：`KHC_PASSWORD=… [KHC_TOTP=…] node scripts/publish-app-manifest.mjs --base <面板地址> <appId> [--yes]`，读取 `apps/manifests/<appId>/manifest.json`，默认只打印与 D1 的差异（dry run），带 `--yes` 才写入并打印 `warnings`。口令只读环境变量。

## 2. 清单字段（v1 与 schema=2）

`appManifestDefinitionSchema`（`packages/contracts`，v1 与 v2 `.strict()` 联合契约）包含：

- `schema`：可选 `1`（默认，前端经 `toManifestV2` 归一口径）或 `2`。
- `name` / `version`：展示与升级比对；改动版本需同步 `sha256`。
- `runtime`：`{mode: 'root' | 'create', user?, linger?}`。`create` 在节点新建 `khc-app-*` 专用账号运行。
- `params[]`：声明式表单字段（`string` / `integer` / `boolean` / `enum`）。支持 `secret: true`（遮罩与显隐）、`enum` 选项 `requires` 资源提示，以及 `derive`（如 `endpoint:<id>.publicUrl`，表单隐藏并由发布地址自动推导，提交时注入 `values`）。
- `secrets[]` / `hooks` / `sources[]`（v2）：分别声明控制面加密凭据（`app.<id>.<name>` + `allowHosts`）、控制面前置 HTTPS 步骤（`preInstall` / `preUpgrade` / `preUninstall`）与外部下载来源（`pinned` 标识是否固定校验，无固定校验会触发「动态脚本」徽标与保存提醒 `warnings[]`）。
- 规则：`hooks.preUpgrade` / `hooks.preUninstall` 在 Worker 渲染，拿不到节点上的安装值，所以只能引用**有默认值**的 `{{params.*}}`；引用无默认值（含 `derive`）的参数时保存返回 400 `manifest_invalid`。引用有默认值的参数只给保存提醒。`preInstall` 不受限。
- `endpoints[]`（v2，替代 v1 `publish`）：多端点声明，每个端点定义 `protocol`（`http`/`tcp`）、`port` / `portParam`、`bind`（`loopback`/`any`）与 `publish`（`caddy`/`direct`/`none`）。
- `units[]` / `health` / `requires` / `scripts.upgrade`（v2）：声明式 systemd 单元管理、本机健康检查、节点预检门槛与升级脚本。

「设置 → 应用管理」（`?tab=manifests`，支持 `?manifest=<id>` 直达编辑抽屉）列表展示 `v2` 与 `动态脚本` 徽标；保存返回 `warnings[]` 时在抽屉顶部给出提醒；编辑抽屉下方分三区展示 **凭据**（只写不读，支持设置/替换/删除，预填来自 `hooks` 的 `allowHosts` 建议）、**控制面步骤**（只读 `stage · method · host`）与 **外部来源**（`固定`/`动态`）。

## 3. 安装与能力协商（节点作用域）

安装主入口在**节点 → 应用 → 安装并发布应用**三步向导（选择应用 → 配置与发布 → 安装并发布）：

1. **选择应用与能力协商**：读取「应用管理」中已启用的清单及 `/overview` 回填的 `/state`（已装按 `manifestId`/`instance` 字段定位）。依据节点 `agent.capabilities.appManifest` 检查 schema 与必需特性（如 `schema2`、`units`、`health.http`、`params.enum`、`hookEnv`、`preflight`、`upgrade`），不满足时禁用按钮并提示「去升级」。
2. **声明式参数与发布配置**：按参数定义渲染输入；跳过 `derive` 字段并在提交前由选定发布端点推导赋值；`mode="create"` 新建账号不填密码。发布域名默认预填节点域名（排除关闭 TLS 的站点），对外端口自动避开 Agent 端口与同域名已占端口；对开启 `host-ops` 且非 Tunnel 的节点内联核对 `fw.show`，`bind=any` 端口未放行时给出一键放行提示。
3. **执行与完成**：v2 应用走 `POST /nodes/:id/apps/app-catalog/manifest_install`（v1 走 `recipe_install`），控制面先按需执行 `hooks.preInstall` 再下发 Agent 任务；向导轮询任务进度与日志，结束后逐一发布已勾选 Caddy 的端点并 `apply`，完成页通过 `ResultCardsView` 渲染 `KHC_RESULT.cards`（主链接按钮 + 复制/下载，v1 兼容转卡片）；错误由 `ManifestErrorAlert` 映射结构化错误码与修复入口（如跳转 `?manifest=<id>` 补凭据）。

### 3.1 脚本里的下载必须自带超时

清单脚本里的 `curl` 若只写 `-fsSL`，在网络差的机器上会一直挂着不报错，只能等任务 900 秒上限，现象是**面板进度停在 1%，日志一行不出**。所以脚本统一这样下载（无论是否在 `sources[]` 里声明了 `pinned` 校验）：

```bash
curl -fL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 600 \
     --speed-limit 8192 --speed-time 60 -o "$TMP" "$URL"
```

- `--connect-timeout` 管连不上；`--max-time` 管总时长；
- `--speed-limit/--speed-time` 管「连着但几乎不动」（连续 60 秒低于 8KB/s 主动放弃）；
- 下载到 `mktemp` 文件，失败时打印**已下载多少字节**并给出排查命令，不能只 `exit 1`；
- 固定来源的 sha256 必须与清单一致，否则执行器拒绝。

写新清单时照抄这一段。拉不动外网的机器，可先给节点配代理，或手工把文件放到清单声明的位置。向导对安装任务的等待上限约 920 秒（Agent 脚本超时 900 秒加余量），超时后转为失败并提示查看任务日志。

### 3.2 执行器：慢脚本要边跑边出日志

清单脚本（安装、升级、卸载）走 `Ctx.run_streaming`（`agent/khc/adapters.py`）：子进程输出逐行回写任务日志，运行中就能看到「下载 / 校验 / 写 unit / 启动」走到哪一步。不得改回 `subprocess.run(capture_output=True)`：整段缓冲会让脚本不退出就一行日志都没有，卡住时看不出卡在哪。超时与取消必须能真的杀掉进程，实现用 `select` 轮询分片读，**不能用会阻塞的 `readline()`**。

### 3.3 实例约定

每个节点每个应用只有一个实例，默认实例 = `manifestId`，前端不传 `instance`。

## 4. 多端点发布（`endpoints[]`）

- `publish: 'caddy'`：向导默认勾选首个 Caddy 端点，其余可自由勾选或改配对外端口；每个已勾端点独立写入一条 `caddy-site`（名称为 `<manifestId>` 或 `<manifestId>-<endpointId>`），任一步失败自动回滚站点配置并保留重发入口。
- `publish: 'direct'` / `'none'`：不创建 Caddy 站点；`bind: 'any'` 的直连/未反代端口在向导第 2 步内联展示宿主防火墙放行状态并支持原地放行 TCP。
- Agent 监听端口与对外发布端口/应用内部端口撞端口时表单即拦截并给出推荐端口。

## 5. 生命周期、日志、升级与卸载

「节点 → 应用 → 已安装的托管应用」卡片统一从 `/overview` 回填的 `/state` 读取 `app-catalog` 状态（不再请求 `recipe_installed`），支持 `stale` / `pending` / `error` 横幅与「未读取」状态提示。点击条目打开 `InstalledAppDrawer`：

- **unit 管理与日志（v2）**：展示各 unit 运行状态，支持启动 / 停止 / 重启（动作后强制刷新 `/overview`）以及**按需展开日志**（点击才请求 `control` logs，支持 `unit` 切换与 `lines` 选择并区分 `stderr`）。
- **升级（v2）**：当清单版本号大于节点已装版本且满足能力要求时展示升级按钮，抽屉内行内二次确认（不叠 Dialog），走 `manifest_upgrade` 任务并支持前置 `preUpgrade` 步骤。升级时 Agent 按「本次值 > 安装值 > 清单默认值」合并参数（保存安装值需 Agent ≥ 0.8.1；更早的 Agent 不记得安装值）；Worker 转发请求里的原始 `values`，不预先合并默认值。确认里有折叠区「修改参数（可选）」，每项默认「保持原值」，只提交改动的键；任务失败且错误带 `details.field` 时自动展开并定位该字段。控制面步骤（`preUpgrade` / `preUninstall`）渲染 `{{params.*}}` 时只能拿到清单默认值和本次填写的值，保存清单时会提醒。
- **v1 条目**：以「设置 → 应用管理」里的清单 schema 为准（Agent 0.8.0 会把 v1 记成 schema 2）：v1 清单显示 v1 徽标，没有启停、日志、升级，卸载走 `recipe_uninstall`。
- **卸载**：v1 走 `recipe_uninstall`，v2 走 `manifest_uninstall`。若卸载前置步骤返回 `hook_failed` / `hook_extract_failed`，抽屉提供行内确认「跳过控制面步骤并强制卸载」（`skipHooks: true`），确保清理本机残留；卸载脚本仍须把 unit、二进制、状态/缓存清理干净（由 `scripts/manifest-uninstall-test.sh` 离线守门）。

### 卸载必须清干净

卸载脚本 `scripts.uninstall` 要求等于把 install 写下的东西**全部**清掉：停并删除 systemd unit（含 `default.target.wants` 链接）、二进制、登录凭据、数据/状态/缓存目录与 `KHC_APP_HOME` 残留；清完逐项复查，仍有残留就在 `KHC_RESULT` 里点名并 `exit 1`，不谎称「已卸载」。面板创建的系统账号由执行器管理，卸载不删。

契约由 `scripts/manifest-uninstall-test.sh` 守住（已接入 `verify.sh`，离线可重复，不带参数时遍历全部应用）：按应用目录下的 `uninstall-fixture.json` 造出「装过」的现场 → 跑清单下发的 uninstall → 断言逐项清理 → 连跑两次验幂等 → 确认 `keep` 里声明的同目录其它文件没被误删。`systemctl` / `getent` 用桩。fixture 字段（路径均为相对路径，以 `/` 结尾表示目录）：

| 字段 | 含义 |
|---|---|
| `instance` | 可选，默认 `default` |
| `home` / `appHome` / `root` | 相对应用用户家目录 / `KHC_APP_HOME` / `KHC_ROOT` 的路径，卸载后必须消失 |
| `symlinks` | `[[链接, 目标]]`，均相对家目录 |
| `keep` | 相对家目录，卸载后必须仍在 |
| `appHomeEmpty` | 为 `true` 时卸载后 `KHC_APP_HOME` 必须为空 |

**约定**：`root` 模式应用的脚本，所有系统路径都要加 `${KHC_ROOT%/}` 前缀（生产环境为 `/`），这样卸载测试不需要 root。

## 6. 现状与排障

- 仓内内置应用清单与前端实现严格解耦：面板不硬编码任何具体应用名或字段逻辑，全部由清单契约与 Agent 上报能力驱动。
- 发布成功只代表**站点已应用**，不代表证书已签发：Caddy 自动 TLS 证书在首次访问时申请；节点没有域名时无法发布 Caddy 站点，需先到节点设置「接入」配置域名。
- Agent 0.8.0 不记得安装参数：含无默认值参数的应用卸载会报「缺少参数」（升级可在确认里补填）；Agent 0.8.1 起用安装记录里的值，不再需要填写。升级与卸载时 Worker 都转发请求里的原始参数，默认值由 Agent 合并。
- 升级或卸载返回 `param_invalid`（`details.field` 是参数名）：旧清单的控制面步骤引用了没有默认值的参数。升级时在确认里补填该参数；卸载时到「设置 → 应用管理」为该参数设置默认值后重试。
