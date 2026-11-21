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

## 3. 从面板安装

「设置 → 应用目录」选节点 → 填参数与运行身份 → 安装。此时只发一次 `POST /nodes/:id/apps/app-catalog/recipe_install`（带 `manifestId`，Worker 从 D1 取出正文附在请求里），返回 `taskId`；进度靠**手动刷新**（不轮询），任务 `done` 后回读已安装清单。

安装结束的 `KHC_RESULT` 里可以有 `access`（登录链接、Key、端口等），面板只展示、不落库。

## 4. 一键发布（清单里的 `publish`）

`publish` 只声明一件事：哪个本机端口对外发。域名来自节点，发布端口由用户选。

```json
"publish": { "label": "Web 管理页", "host": "127.0.0.1", "portParam": "web_port", "port": 3430 }
```

- `portParam` 与 `port` 二选一：前者取安装参数的值（推荐，用户能改端口），后者是固定端口。
- `host` 默认 `127.0.0.1`——node 上的应用只监听回环，不直接暴露。

面板据此推导发布计划（`apps/web/src/apps/settings/appPublish.ts`）：`https://<节点域名>:<发布端口>` → `<host>:<端口>`。安装任务 `done` 后自动建 Caddy 站点（`tls=auto`）并 apply，与应用页手动加站点走同一条 `publishProxySite`（`apps/web/src/data/sites.ts`）：写配置 → apply → 任一步失败把站点配置回滚成发布前。

**两条端口不能相同。** Agent 占着 `<域名>:<Agent 端口>`（默认 2053），Caddy 要监听发布端口（默认 2083）——一条端口只能一个进程，撞了表单会挡住提交并给换端口的出口，写入站点前还有一层拦截。443 刻意留空，理由与端口白名单见 `docs/cf-dns.md`。

清单声明了 `public_url` 参数时，面板在安装前就把它填成发布地址（表单里可见、可改），这样 magpie 回传的登录链接本身就是 `https://<域名>:<发布端口>/?k=…`，装完点一下就能进。

## 5. 现状与排障

- 内置应用：`magpie`（AI 模型网关 + Web 管理页，默认网关 `127.0.0.1:3425`、Web `127.0.0.1:3430`）。
- 发布成功只代表**站点已应用**，不代表证书已签发：证书由 Caddy 首次访问时申请，报证书错误等几秒再刷新。控制面的 TLS 探测打的是节点接入地址（Agent），与发布出去的应用是两回事，不能互相冒充。
- 节点没有域名时不能发布：仍可直接安装（只监听回环），要对外先去节点设置「接入」填域名。
- 发布失败会在安装抽屉里给出原始错误 + 「重试发布」；站点配置已回滚，不会留半套站点。
