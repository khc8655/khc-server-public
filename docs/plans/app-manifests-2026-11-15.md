# 应用清单与分发分离（提案）

> 状态：草案 ｜ 最后核验：2026-11-15 ｜ 关联：`docs/design-v3.md` §3.5、`docs/security-boundaries.md`、`agent/khc/recipes.py`

> **执行者须知**：草案阶段不实施。§8 拍板后才能开工。凡标注「待 R0 验证」的内容，均为未经实测的假设，不能作为验收依据。

## 1. 背景与主人的目标

主人 2026-11-15 定下方向：**配置与分发分离**。

- 以后新增应用（例如 sing-box、magpie），只需在 Worker 里存一份应用定义，**不必发布新版 Agent，也不必重新构建面板**。
- 面板要有一个「应用管理」界面，用来添加、编辑和停用应用定义。

现状（main `7b68a09`）：

| 环节 | 现在 | 问题 |
|---|---|---|
| 应用定义 | `agent/recipes/catalog.json` 加上每个应用的 `install.sh`，随 Agent 包一起发布 | 新增应用就要发 Agent 新版 |
| 面板目录 | `apps/web/src/apps/catalog.generated.json` 在构建期从上面那份清单生成 | 新增应用还要重新构建面板 |
| 通用安装 | `generic-service` 支持 docker 镜像，或带 sha256 的 https 二进制 | 服务名写死为 `khc-generic`，不能多实例；不解压；没有配置模板；没有更新、重启、日志 |
| 已有基础 | 参数校验、写盘白名单、`KHC_RESULT=` 结果约定、后台任务、Agent 内置的 Ed25519 验签（`release_verify.py`） | 都可以复用 |

## 2. 目标架构

```
面板「应用管理」──CRUD──▶ Worker ──▶ D1 表 app_manifests（应用定义 = 配置）
面板「安装」──▶ Worker：从 D1 取定义 + 参数 ──HMAC──▶ Agent 通用安装器（解释定义，随 Agent 发布）
```

- **分发的是解释器，配置的是应用。** Agent 只内置一个通用安装器；应用定义是一份 JSON，存在 D1 里，安装时由 Worker 随请求下发。
- 只有给安装器**加新能力**时才需要发 Agent，比如要支持一种新的包格式；新增或修改应用不需要。
- 面板目录改为运行时从 Worker 读取，不再在构建期生成。

## 3. 应用定义（manifest）

一个应用就是一份 JSON。下面是示意，字段在 R0 实测后定稿：

```json
{
  "id": "sing-box", "name": "sing-box", "version": "1.10.7",
  "source": {
    "kind": "binary",
    "assets": {
      "amd64": { "url": "https://github.com/.../sing-box-1.10.7-linux-amd64.tar.gz", "sha256": "…" },
      "arm64": { "url": "…", "sha256": "…" }
    },
    "archive": "tar.gz", "binary": "sing-box-1.10.7-linux-amd64/sing-box"
  },
  "params": [ { "key": "port", "type": "integer", "default": 2080, "min": 1024, "max": 65535 } ],
  "files": [ { "path": "config.json", "template": "{\"inbounds\":[{\"listen_port\":${port}}]}" } ],
  "run": { "args": ["run", "-c", "${configDir}/config.json"] },
  "expose": { "port": "${port}", "listen": "127.0.0.1" }
}
```

安装器的固定规则（由 Agent 决定，定义里不能改）：

- 落盘路径由 Agent 根据实例名推导：`/opt/khc-apps/<实例>/`、`/etc/khc-apps/<实例>/`，服务名为 `khc-app-<实例>.service`。定义里不能写任意路径，沿用写盘白名单和防符号链接逃逸。
- 下载只接受 https，**sha256 必填，校验不一致就中止**，不写盘、不启动。
- 模板变量只能引用 `params` 和少数内置变量（`configDir`、`dataDir`、`instance`）。替换时按目标格式转义，不经过 shell。
- systemd unit 由 Agent 生成，以 `args` 数组作为 `ExecStart`，不拼接 shell。
- 支持多实例：同一个应用可以装成 `sing-box-a`、`sing-box-b`。
- 动作：安装、更新（换 version 和 sha256）、卸载、重启、状态、最近日志。
- 如果定义带 `expose`，装完后直接预填「发布本机端口」的站点抽屉（T-C）。

`source.kind` 第一期只做 `binary`，第二期做 `docker`。

## 4. 存储与接口

- D1 新表 `app_manifests`：`id`（主键）、`manifest_json`、`version`、`enabled`、`updated_at`、`signature`（可空，见 P-2）。属于配置，符合 `data-layering.md` 中「D1 只存配置」的规定。
- Worker：`GET/POST/PUT/DELETE /api/v1/app-manifests`。写入时用 `packages/contracts` 里的 schema 校验，拒绝未知字段。
- 安装：原接口 `POST /nodes/:id/apps/app-catalog/recipe_install` 的参数从 `{recipeId, values}` 扩展为 `{manifest, values, instance}`，manifest 由 Worker 从 D1 读出后附上，不接受浏览器直接传入。
- 已安装记录仍落在节点上（`installed.json`，0600），观测仍走 `/state`，不新增轮询。
- 现有的 `catalog.json` 内置 recipe 保留为只读的「内置应用」，直到被声明式定义取代后再删除。

## 5. 面板「应用管理」

归类为全局设置下的「资源库」页面类型，复用现有的列表加单抽屉范式（`ui-guidelines.md`）：

- **列表**：名称、版本、来源类型、已安装节点数、状态（启用或停用），整行可点。
- **抽屉**：编辑 JSON，失焦即按 schema 校验并标出错误位置；右侧预览由 `params` 生成的安装表单。
- **操作**：新增、复制为新应用、停用（已安装的不受影响，只是不能再装新的）、删除（仍有节点装着时禁止删除）。
- **节点「应用」页**：选择应用、实例名和参数，然后安装；之后可更新、重启、卸载、看日志。
- 新增页面需登记到 `page-specs.md`；属于 UI 改动，执行 PR 要附浅色、深色和 390 宽截图。

## 6. 安全口径

- **如实说明**：应用定义可以让节点以 root 身份下载并运行任意（经 sha256 固定的）二进制。谁能写 D1 里的定义，谁就等于拿到了节点 root。
- **现状对照**：Worker 现在通过 host-ops 的 `keys.add` 和 `cron.set`，已经接近能拿到 Peer 的 root（`docs/host-ops.md` 开头的「如实口径」）。本提案没有明显扩大这个面，但也没有缩小。
- **缓解措施**：生产环境上线前开启 TOTP（测试期不开，延续主人的决定）；新增、修改、删除定义都写 `audit`；更换 sha256 时，抽屉里要显式展示新旧值的差异；节点日志不回显参数中的 secret。
- 是否加签名见 P-2。

## 7. 批次

| 批次 | 内容 | 改动范围 | 验收 | bump |
|---|---|---|---|---|
| R0 实测（仅证据） | 手写 sing-box 和 magpie 的定义，在 oracle-x86-2 上用临时脚本模拟安装器：下载、校验、解压、写模板、生成 unit、启动、外网经 Caddy 访问 | `docs/verification/` | 两个应用都能装好并能访问；写明上游是否提供 sha256、压缩包的目录结构、需要哪些参数；**magpie 的发布形态（二进制、docker 还是源码）待确认** | 否 |
| R1 底座 | contracts schema；D1 迁移 `0013_app_manifests`；Worker CRUD 和审计；Agent 通用安装器（binary 和多实例）；安装接口改为带 manifest | contracts、Worker、迁移、Agent、`design-v3.md` §3.5、`security-boundaries.md` | 新增一份定义后，**不发版**即可在测试节点安装；sha256 错误时中止且不留文件；路径逃逸、未知字段、超长模板都被拒绝 | 面板 minor、Agent minor（这是最后一次因应用而发版） |
| R2 应用管理 UI | 资源库「应用管理」页；节点应用页的安装、更新、卸载、重启、日志；面板目录改为运行时读取 | 前端、`page-specs.md` | 在页面上新增 magpie 定义并装到节点；四态和截图齐全 | 面板 minor |
| R3 扩展 | `docker` 来源；`expose` 接到发布本机端口；内置 recipe 迁移为声明式定义后删除旧脚本 | Agent、前端 | sing-box 改用声明式定义安装，结果与旧 recipe 一致 | Agent minor |

## 8. 待拍板

| # | 事项 | 选项 | 推荐 |
|---|---|---|---|
| P-1 | 定义里能否带脚本 | A 纯声明式，不允许 shell / B 声明式，另加可选的「安装后命令」（args 数组，不经 shell）/ C 允许完整 install.sh | **A**。确有必要时再升级到 B；C 等于又把一键脚本带回来 |
| P-2 | 是否签名 | A 不签名，靠面板登录、TOTP 和审计 / B 主人本机用 CLI 签名后粘贴，Agent 验签 / C 定义放在仓库，由 CI 签名后写入 D1 | **A**，满足「在面板里加完就能用」。上线后若要收紧，再加 B，`signature` 字段先预留 |
| P-3 | 第一期的来源类型 | binary / binary + docker | 只做 binary，docker 放到 R3 |
| P-4 | 内置 recipe 怎么处理 | 保留为只读，迁移后删除 / 立即删除 | 保留为只读，迁移后删除 |
| P-5 | `AGENTS.md` §6「新增应用 = 写适配器」 | 改为两类：声明式应用只加定义；深度集成的应用（caddy、wireguard 这类）仍写适配器 | 同意修改 |

拍板方式：逐条回复，例如「P-1 A，P-2 A，其余按推荐」。拍板后规划者把结论写进本节，并把状态改为「已拍板」。
