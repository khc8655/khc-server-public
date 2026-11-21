# 托管应用（应用清单 · 面板安装 · 一键发布）

> 状态：现行 ｜ 最后核验：2026-11-21 ｜ 关联：`apps/manifests/`、`apps/api/src/lib/builtin-manifests.ts`、`apps/web/src/apps/settings/appPublish.ts`、`docs/cf-dns.md`
> 范围：应用清单的数据来源与字段、从面板安装到节点上的流程、清单里的 `publish` 声明如何变成 Caddy 站点

## 1. 是什么

「应用」是装在节点上、以独立 systemd user unit 常驻的服务（magpie、sing-box 之类）。面板只负责**下发清单 → 起后台安装任务 → 展示结果**，脚本本身在节点上执行，密码类参数不进 D1、不进日志。

三者分工：

| 层 | 位置 | 职责 |
|---|---|---|
| 仓内清单 | `apps/manifests/<id>/manifest.json` | 唯一的可评审来源，`scripts/verify-app-manifests.mjs` 校验脚本 sha256 与字段 |
| D1 记录 | 表 `app_manifests`（`migrations/0013_app_manifests.sql`） | 控制面运行时读的那份，可在「设置 → 应用管理」改 |
| 节点目录 | `/opt/khc-agent/recipes/catalog.json` | 旧的自带 recipe，应用目录已改为读 D1，不再依赖它 |

内置清单由 `apps/api/src/lib/builtin-manifests.ts` 在 Worker 打包时把仓内 JSON 一起打进去，`GET /api/v1/app-manifests` 首次访问时**缺就补一行、已有记录不动**——所以 magpie 装完即见，而改过的 magpie 不会被下次列表刷回仓内版本。删仓内定义也不会删 D1 记录。

## 2. 清单字段

`appManifestDefinitionSchema`（`packages/contracts`，`.strict()`）要求：

- `name` / `version`：展示用；改动版本要同步 `sha256`。
- `runtime`：`{mode: 'root' | 'create', user?, linger?}`。`create` 会在节点上新建 `khc-app-*` 专用账号，脚本以该账号运行。
- `params[]`：安装表单字段（`string` / `integer` / `boolean`），`default` 有值即非必填；执行器把它注入成 `KHC_PARAM_<KEY>`。
- `scripts` / `sha256`：安装与卸载脚本正文及其摘要；写库前逐字校验，填错当场 400。
- `writes[]`：脚本会写的目录，只作说明与审计。
- `publish`（可选）：声明「装完之后哪个本机端口要发出去」，见 §4。

## 3. 安装只在发布流程里（节点作用域）

设置 →「应用目录」是**只读脚本库**：看得到适配了哪些应用、参数默认值、可发布端口，但**不装任何东西**——全局设置没有「装到哪台机器」的上下文，安装必须落在一台具体的 VM 上。

安装入口只有一处：**节点 → 应用 → 发布应用**（站点抽屉）→ 上游来源选「从应用目录安装应用」→ 下拉里选清单 → 填参数与运行身份 → 装到这台机器（Agent 所在 VM）→ 装完上游端口自动填成清单声明的端口 → 「保存并应用」即发布出去。

技术上是 `POST /nodes/:id/apps/app-catalog/recipe_install`（带 `manifestId`，Worker 从 D1 取出正文附在请求里），返回 `taskId`；进度靠抽屉里的**手动刷新**（不轮询），任务 `done` 后才填上游——应用没起来之前建站点只会得到 502。安装结束的 `KHC_RESULT` 可以有 `access`（登录链接、Key、端口等），面板只展示、不落库。

装载方式目前只有一种：二进制（下载 + 固定 sha256 校验 + systemd user unit）。清单的 `runtime` 决定用新建应用账号还是 root，`scripts` 决定装什么；将来适配 Docker 等方式时，在这一层加声明并在执行器侧渲染成对应的 unit/容器，面板流程不变。

## 4. 一键发布（清单里的 `publish`）

`publish` 只声明一件事：哪个本机端口对外发。域名来自节点，发布端口由用户选。

```json
"publish": { "label": "Web 管理页", "host": "127.0.0.1", "portParam": "web_port", "port": 3430 }
```

- `portParam` 与 `port` 二选一：前者取安装参数的值（推荐，用户能改端口），后者是固定端口。
- `host` 默认 `127.0.0.1`——node 上的应用只监听回环，不直接暴露。

面板据此推导发布计划（`apps/web/src/apps/settings/appPublish.ts`）：`https://<节点域名>:<发布端口>` → `<host>:<端口>`。站点保存后走 `publishProxySite`（`apps/web/src/data/sites.ts`）：写配置 → apply → 任一步失败把站点配置回滚成发布前；手动建站与「装完再发布」是同一条路径。

**两条端口不能相同。** Agent 占着 `<域名>:<Agent 端口>`（默认 2053），Caddy 要监听发布端口（默认 2083）——一条端口只能一个进程，撞了表单会挡住提交并给换端口的出口，写入站点前还有一层拦截。443 刻意留空，理由与端口白名单见 `docs/cf-dns.md`。

清单声明了 `public_url` 参数时，面板用当前站点的对外地址（域名 + 发布端口）预填它（字段可见、可改），这样 magpie 回传的登录链接本身就是 `https://<域名>:<发布端口>/?k=…`，装完点一下就能进。

## 5. 卸载（必须清干净）

「节点 → 应用 → 已安装的托管应用」只做查看与卸载。卸载跑清单自带的 `scripts.uninstall`，要求等于把 install 写下的东西**全部**清掉：停并删除 systemd user unit（含 `default.target.wants` 链接）、二进制、登录 key、数据/状态/缓存目录与 `KHC_APP_HOME` 残留；清完逐项复查，仍有残留就在 `KHC_RESULT` 里点名并 `exit 1`，不谎称「已卸载」。面板创建的系统账号由执行器管理，卸载不删。

契约由 `scripts/manifest-uninstall-test.sh` 守住（已接入 `verify.sh`，离线可重复）：造出 install 会写的全部路径 → 跑清单下发的 uninstall → 断言逐项清理 → 连跑两次验幂等 → 确认没误删同目录其它应用。新增或改动任何清单的卸载脚本，都要让这个测试通过。

## 6. 现状与排障

- 内置应用：`magpie`（AI 模型网关 + Web 管理页，默认网关 `127.0.0.1:3425`、Web `127.0.0.1:3430`）。
- 发布成功只代表**站点已应用**，不代表证书已签发：证书由 Caddy 首次访问时申请，报证书错误等几秒再刷新。控制面的 TLS 探测打的是节点接入地址（Agent），与发布出去的应用是两回事，不能互相冒充。
- 节点没有域名时不能发布（应用只监听回环，装也没处发）：先去节点设置「接入」填域名，再走发布流程。
- 发布失败在抽屉里给原始错误，站点配置会自动回滚；安装失败在「从应用目录安装」区域给原文，可改了参数重试。
