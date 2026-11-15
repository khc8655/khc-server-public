# 应用清单与分发分离（提案）

> 状态：草案 ｜ 最后核验：2026-11-15 ｜ 关联：`docs/design-v3.md` §3.5、`docs/security-boundaries.md`、`agent/khc/recipes.py`

> **执行者须知**：§8 已记录主人 2026-11-15 的拍板结论（P-1 允许脚本、P-2 不签名、P-6 整套降权、P-7 先改提案）。其余 P-3～P-5 待拍板，未拍板部分不实施。凡标注「待 R0 验证」的均为未经实测的假设，不能作为验收依据。

## 1. 背景与主人的目标

主人 2026-11-15 定下方向：**配置与分发分离，常用程序由面板分发适配脚本**。

- 应用由一份**适配脚本**描述：装在哪、怎么配、怎么起服务，都写在脚本里。脚本是资产，存进 D1，通过面板增删改并下发到节点执行。
- 以后新增应用（sing-box、magpie 等）只需在面板里加一份脚本，**不发布新版 Agent、不重新构建面板**。
- magpie 上游安装较复杂（桌面版依赖、自更新、发版频繁），正因如此才由适配脚本把版本、路径、配置全部写死，不交给用户现场拼。

### 现状（已核实，main `3322489`）

| 环节 | 现在 | 问题 |
|---|---|---|
| 应用定义 | `agent/recipes/catalog.json` + 各应用的 `install.sh` / `uninstall.sh`，随 Agent 包发布 | 新增应用就要发 Agent 新版 |
| 面板目录 | `apps/web/src/apps/catalog.generated.json`，由 `scripts/gen-app-catalog.mjs` 在构建期生成 | 新增应用还要重新构建面板 |
| 执行机制 | `agent/khc/recipes.py`：`KHC_PARAM_*` 环境变量传参、`KHC_RESULT=` 回结果、`installed.json` 记已装、写盘白名单、后台任务 | **可整体复用**，但脚本以 root 执行 |
| 运行身份 | `run_recipe()` 用 `ctx.run(["bash", script])`；生成的 unit 在 `/etc/systemd/system/khc-*.service` 且**无 `User=`** | 安装脚本与应用进程都是 root |
| 验签 | `agent/khc/release_verify.py` 内置 Ed25519 验签 | 本期不使用，见 §6 |

## 2. 目标架构

```
面板「应用管理」──CRUD──▶ Worker ──▶ D1 表 app_manifests（脚本正文 + 元数据）
面板「安装」──▶ Worker：取脚本 + 参数 ──HMAC──▶ Agent
                                                  │ 以专用普通用户执行
                                                  ▼
                         systemd --user unit ──▶ 应用进程（非 root）
```

- **分发的是脚本，配置的是参数。** Agent 不解释应用语义，只负责安全地把脚本交给一个降权的执行器。
- 新增或修改应用不发版；只有执行器本身要加能力时才发 Agent。
- 面板目录改为运行时从 Worker 读取，不再构建期生成。

## 3. 应用包（manifest）

一份应用 = 一段脚本正文 + 元数据。字段在 R0 实测后定稿：

```json
{
  "id": "magpie", "name": "magpie", "version": "0.1.4247",
  "runtime": { "user": "khc-app-magpie", "linger": true },
  "params": [
    { "key": "port", "type": "integer", "default": 3425, "min": 1024, "max": 65535 }
  ],
  "scripts": { "install": "#!/usr/bin/env bash\n…", "uninstall": "…" },
  "sha256": { "install": "…", "uninstall": "…" },
  "writes": [ "~/.local/share/khc-apps/magpie", "~/.config/khc-apps/magpie" ],
  "result": { "access": [ { "label": "网关", "value": "127.0.0.1:3425", "kind": "url" } ] }
}
```

**Agent 侧固定规则（脚本不能改）**：

- 脚本下载、落盘前先按 `sha256` 校验；不一致即中止，不落盘、不执行。
- 参数经 `KHC_PARAM_*` 环境变量传入，不拼进命令行、不进日志。沿用 `KHC_RESULT=` / `KHC_RESULT_FILE` 回传结果。
- 写盘白名单由 Agent 判定，脚本声明的 `writes` 必须落在允许根内，且防符号链接逃逸（复用 `assert_safe_path`）。
- 脚本以 **`runtime.user` 指定的普通用户**执行，不以 root；详见 §4。
- 动作：安装、更新（换脚本与 sha256）、卸载、重启、状态、最近日志。
- 支持多实例：`magpie-a`、`magpie-b`，各自独立用户或独立 `XDG_*` 根目录（R0 定）。

**magpie 适配脚本的既定口径**（依据上游 `yetone/magpie-releases` 实测）：

| 项 | 值 |
|---|---|
| 产物 | `magpie-cli-linux-amd64` / `magpie-cli-linux-arm64` 单文件二进制，不用桌面版（需 GTK3 + WebKitGTK） |
| 校验 | 官方每版带 `SHA256SUMS` 与 `SHA256SUMS.sig`，脚本固定 version + sha256，校验不过中止 |
| 自更新 | 上游「every build updates itself」，脚本必须禁用自更新，否则面板版本与节点实际版本漂移 |
| 配置 | `~/.config/magpie`；网关 `127.0.0.1:3425`（非特权端口，普通用户可绑） |
| 服务 | 按上游形态用 `~/.config/systemd/user/magpie.service` 用户级 unit |
| 发版频率 | 极快（`v0.1.4244`→`v0.1.4248` 在 1.5 小时内），故版本必须显式固定，不跟 latest |

## 4. 运行身份：整套降权（P-6 已定）

这是本方案的主要安全边界，**不是给 unit 加一行 `User=` 就算数**：

1. **脚本执行**：Agent 以 `runuser -u <runtime.user> -- bash <script>`（或等价的降权调用）执行，脚本进程本身不是 root。R0 必须实测 `ctx.run` 能否带降权、以及 `KHC_*` 环境变量在降权后是否完整传递。
2. **应用进程**：unit 写进该用户的 `~/.config/systemd/user/`，`systemctl --user` 管理，天然以该用户运行。
3. **无人登录时仍要跑**：`loginctl enable-linger <user>`。目标机实测 `Linger=no`，故这是**必做步骤**，不是可选项。
4. **Agent 自身沙箱要开口子**：现 unit 为 `ProtectHome=read-only` + `ProtectSystem=full`，`ReadWritePaths` 只列了系统目录；`ALLOWED_WRITE_BASES` 目前也全是系统根（`/etc/khc-recipes`、`/opt/khc-recipes`、`/var/lib/khc-recipes`、`/etc/systemd/system/khc-`）。降权方案需要新增受控的家目录根，并同步扩大 `ReadWritePaths`。**开口子的范围就是新的攻击面，R0 要给最小集合并列成清单。**
5. **可复用基础**：`agent/khc/util.py` 的 `Paths` 已原生支持 user profile（`systemctl_user` 属性按 `profile` 判定），不必从零实现。

> 已核实的目标机环境：systemd 255、`systemctl --user` State=running、`/run/user/1001` 存在、`loginctl` 可用、`Linger=no`。

## 5. 存储与接口

- D1 新表 `app_manifests`：`id`、`manifest_json`、`version`、`enabled`、`updated_at`。`signature` 字段**不设**（P-2 已定不签名）。属于配置，符合「D1 只存配置」。
- Worker：`GET/POST/PUT/DELETE /api/v1/app-manifests`，写入时用 `packages/contracts` 的 schema 校验并拒绝未知字段。
- 安装：`POST /nodes/:id/apps/app-catalog/recipe_install` 的参数从 `{recipeId, values}` 扩展为 `{manifest, values, instance}`，manifest 由 Worker 从 D1 读出后附上，**不接受浏览器直接传入**。
- 已安装记录仍落节点 `installed.json`（0600），观测仍走 `/state`，不新增轮询。
- 现有 `catalog.json` 内置 recipe 保留为只读「内置应用」，迁移完成后删除（P-4）。

## 6. 安全口径（P-2 已定：不签名，靠审计）

- **如实说明**：脚本以专用普通用户执行后，改脚本不再等于「拿到节点 root」。但仍在两个方面有能力边界：① 能以该应用用户身份读写其白名单内目录、运行其进程；② 若多个应用共用同一用户或家目录根，可横向影响其他应用。降权**缩小**了爆炸半径，不等于没有风险。
- **不签名的补偿措施（缺一不可）**：
  1. 每次新增 / 修改 / 删除脚本都写 D1 `audit`，记录操作者、时间、应用 id、脚本新旧 sha256；
  2. 面板抽屉里展示脚本 sha256，换脚本时显式展示新旧差异；
  3. 每个应用独立 `runtime.user`，禁止共用；
  4. 脚本落盘前校验 sha256，节点侧再校验一次，不一致不执行；
  5. 参数中的 secret 不进日志（复用 `_redact`）；
  6. 生产上线前开启 TOTP（测试期不开，延续既定决定）。
- 现 `release_verify.py` 的 Ed25519 验签能力**保留但不启用**；若日后需要收紧，重新拍板加签名。
- 对照现状：Worker 经 host-ops 的 `keys.add` / `cron.set` 已接近能拿到 Peer root（`docs/host-ops.md` 如实口径）。本方案降权后**没有扩大**这个面。

## 7. 面板「应用管理」

归类为全局设置下的「资源库」页面类型，复用现有列表加单抽屉范式：

- **列表**：名称、版本、运行用户、来源类型、已安装节点数、状态（启用/停用），整行可点。
- **抽屉**：编辑脚本正文与元数据，失焦按 schema 校验并标出错误位置；展示脚本 sha256；右侧预览由 `params` 生成的安装表单。
- **操作**：新增、复制为新应用、停用（已安装的不受影响）、删除（仍有节点装着时禁止）。
- **节点「应用」页**：选应用、实例名、参数 → 安装；之后可更新、重启、卸载、看日志。
- 新增页面登记到 `page-specs.md`；UI 改动的执行 PR 附浅色、深色、390 宽截图与四态说明。

## 8. 拍板结果与待拍板

| # | 事项 | 结论 |
|---|---|---|
| P-1 | 定义里能否带脚本 | **已定：允许完整适配脚本**（脚本是下发资产，见 §3）。§1 的方向以此为准 |
| P-2 | 是否签名 | **已定：不签名**，靠 §6 的六项补偿措施与整套降权；测试期不开 TOTP，上线前开 |
| P-3 | 第一期来源类型 | **待拍板**：binary / binary + docker（推荐只做 binary，docker 放 R3） |
| P-4 | 内置 recipe 怎么处理 | **待拍板**：保留只读、迁移后删除 / 立即删除（推荐前者） |
| P-5 | `AGENTS.md` §6「新增应用 = 写适配器」 | **待拍板**：改为两类——脚本式应用只加定义；深度集成（caddy、wireguard）仍写适配器（推荐同意修改） |
| P-6 | 运行身份 | **已定：整套降权**（脚本 + 应用进程 + user unit + linger，见 §4），不是只给进程加 `User=` |
| P-7 | 推进方式 | **已定：先改提案**，改完交主人过目再拍板开工 |

P-3～P-5 待主人逐条回复；拍板后规划者把结论并入本节、状态改为「已拍板」，再从 R0 开工。

## 9. 批次

| 批次 | 内容 | 改动范围 | 验收 | bump |
|---|---|---|---|---|
| R0 实测（仅证据） | ① 按 `sing-box/install.sh` 范式写 magpie 适配脚本（固定版本 + sha256、禁自更新、CLI 二进制、用户级 unit）；② 在 oracle-x86-2 上以普通用户跑通下载、校验、写配置、启动、经 Caddy 访问；③ **验证降权链路**：`ctx.run` 降权调用、`KHC_*` 传参、`enable-linger`、Agent `ProtectHome`/`ReadWritePaths` 最小开口清单、多实例隔离 | `docs/verification/` | 两个应用都能装好并访问；脚本与应用进程均非 root；写明上游 sha256 来源、压缩包结构、所需参数、linger 行为；每项附可复核命令与输出 | 否 |
| R1 底座 | contracts schema；D1 迁移 `0013_app_manifests`；Worker CRUD 与审计；脚本下发与降权执行器；安装接口带 manifest | contracts、Worker、迁移、Agent、`design-v3.md` §3.5、`security-boundaries.md` | 面板新增一份脚本后**不发版**即可在测试节点安装；sha256 错误中止且不留文件；路径逃逸、未知字段、超长脚本被拒；非 root 身份实测 | 面板 minor、Agent minor |
| R2 应用管理 UI | 资源库「应用管理」页；节点应用页安装/更新/卸载/重启/日志；面板目录改运行时读取 | 前端、`page-specs.md` | 页面上新增 magpie 脚本并装到节点；四态与截图齐全 | 面板 minor |
| R3 扩展 | `docker` 来源；`expose` 接「发布本机端口」；内置 recipe 迁移为脚本定义后删除旧脚本 | Agent、前端 | sing-box 改用下发脚本安装，结果与旧 recipe 一致 | Agent minor |

每批合并前跑 `./scripts/verify.sh`，并附真机证据。

## 10. 风险与待 R0 验证

- **降权不等于无风险**：见 §6。共用用户、家目录根过大、脚本读取宿主敏感路径都会重新扩大攻击面，R0 要给最小集合。
- **`ctx.run` 降权可行性未验证**：Agent 自身在 `ProtectSystem=full` 沙箱内，能否稳定执行 `runuser` / `systemctl --user` 需实测；若不可行，改为用 `systemd-run --user` 一次性单元，不退回 root。
- **linger 与登录态**：`Linger=no` 已实测，未 `enable-linger` 时用户退出后服务会停，容易被误判为「装好了但没跑」。
- **magpie 自更新**：官方 `curl|sh` 装的实例会自更新；适配脚本必须固定版本并禁用，否则面板记录的版本与节点实际不一致。
- **发版频率**：上游一小时多个版本，脚本里的 version + sha256 需成对更新，面板要提示「有新版本」但不自动跟随 latest。
- **未测**：Tunnel 节点的 user unit 行为、arm64 节点的二进制兼容性、多实例共用 `XDG_RUNTIME_DIR` 的冲突。
