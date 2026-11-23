# V4.1 真机证据：升级沿用安装参数、单元状态与 v1 条目

- 面板：`v0.41.1`（`main` `15a9008fdd68`，PR #162），生产 `https://a.18888.bond`，`/api/v1/health` 返回 `version: 0.41.1`、`commit: 15a9008fdd68`
- 节点：`aws-hui-us`（`nd_fd816cd3b1193b7d`），Agent `0.8.0`（不记得安装参数）
- 执行方式与安全约束同 `manifest-v2-web.md`：ego 浏览器会话内操作面板与同源 `/api/v1/*`；没有导出 cookie 或令牌，没有使用 `~/.ssh`，没有登录节点。
- 日期：2026-11-23，UTC 10:33–10:38。界面显示时间为 UTC+8。

## 一、测试清单 `ux-v41`

在「设置 → 应用管理 → 添加应用」导入（`ux-` 前缀，测完已删）：

- 参数：`tag`（string，无默认值，非 derive）、`port`（integer，默认 3491）
- 一个 user unit；`health.http` 的 URL 用 `{{params.port}}`；脚本是一个 Python 小服务，`/health` 返回 `{"version", "tag"}`
- `hooks.preUpgrade`：`POST https://postman-echo.com/post`，body 引用 `{{params.tag}}`，没有配凭据
- 运行用户沿用节点上已有的 `khc-app-ux-live`（面板此前建的账号）

## 二、步骤记录

时间为 UTC；耗时指浏览器内该请求的往返时间。

| # | 时间 | 操作 | 面板显示 | 任务 ID / API | 结果 |
|---|---|---|---|---|---|
| a | 10:33 | 保存清单（含 `preUpgrade` 引用 `{{params.tag}}`） | 抽屉顶部「保存提醒」：`preUpgrade 引用了 {{params.tag}}：升级 / 卸载时控制面步骤只能拿到清单默认值和本次填写的值，拿不到安装时填的值` | `POST /app-manifests` 201 | 通过，截图 `v41-manifest-save-warning-light.png` |
| b | 10:34:48 | 向导安装：`tag=t1`，端口改为 3492 | 第 3 步「已完成」，结果卡片 版本 1.0.0 / 端口 3492 / 标签 t1 | `640f73dc18be46ba880ebcbee786464c`；`manifest_install` 200（0.7s），任务 `done` 1.65s | 通过 |
| c | 10:34:55 | 打开已装抽屉 | 单元 `khc-ux-v41-ux-v41.service` 显示 `active`（不再是「未知」），状态「运行中」，健康检查「通过 · v1.0.0」 | - | 通过，截图 `v41-installed-drawer-unit-active-light.png` |
| d-1 | 10:35:30 | 清单改为 1.0.1（仍带 `preUpgrade` 引用 `params.tag`）；抽屉升级，不展开折叠区直接确认 | 失败：`模板缺少变量：params.tag`；折叠区**没有**自动展开，确认条关闭 | `manifest_upgrade` **400**（0.4s）；响应 `{"error":{"code":"template_missing_var","message":"模板缺少变量：params.tag","details":{"variable":"params.tag"}}}` | 与预期不一致，见发现 #1。截图 `v41-upgrade-hook-template-missing-var-light.png` |
| d-2 | 10:36:13 | 把清单里的 `preUpgrade` 去掉（版本仍 1.0.1），再次不展开直接确认升级 | 任务失败 `缺少参数 tag`；折叠区自动展开，`标签` 字段标红并显示「缺少参数 tag」；确认按钮变为「补填后重试升级」；「节点 Agent < 0.8.1 时不会记住安装参数」提示可见 | `9d673bc00fbe45dc8bae5aa1b9f7b4f5`；`manifest_upgrade` 200，任务 `error` 0.01s | 通过。截图 `v41-upgrade-params-expanded-light.png`、`-dark.png`、`-390.png` |
| e | 10:36:37 | 补填 `tag=t1`、端口填回 3492，点「补填后重试升级」 | 版本 `1.0.1`，健康检查「通过 · v1.0.1」，端点仍是 `127.0.0.1:3492`，结果卡片 标签 t1 / 端口 3492 | `15ac0a3a2f124212b39cfbf45d4f6c85`；`manifest_upgrade` 200（0.8s），任务 `done` 1.56s | 通过 |
| f-1 | 10:36:52 | 抽屉卸载（含无默认值的 `tag`） | 任务失败 `缺少参数 tag`；抽屉里没有填参数的入口；`installedDetail` 里 `ux-v41` 仍在 | `15ca234d59b44f339454d973db84608a`；`manifest_uninstall` 200，任务 `error` | 与已知预期一致（0.8.0 不记得安装值），见发现 #2。截图 `v41-uninstall-missing-param-light.png` |
| f-2 | 10:37:22 | 清理方式：在应用管理里临时给 `tag` 加 `default: "x"` 并保存，再卸载 | 抽屉关闭，列表清空 | `e95a287e82bc4828b8c43740c02b0dc8`；`manifest_uninstall` 200（0.7s），任务 `done` | 通过；`installedDetail = {}` |
| g | 10:37:41 | magpie（v1）：向导安装（网关 28880 / Web 28881，不发布） | 抽屉显示 **v1** 徽标，只有「卸载」「关闭」按钮，没有启停、日志、升级，没有 `v2` 徽标 | `recipe_install` 200（0.9s） | 通过，截图 `v41-magpie-v1-drawer-light.png` |
| g-2 | 10:38:16 | magpie 卸载 | 抽屉关闭，列表清空 | 请求为 `POST .../apps/app-catalog/recipe_uninstall` 200（0.8s），任务 `1aea923d095041c8a9484bf89c37c29f`；没有 `manifest_uninstall` 请求 | 通过 |

## 三、截图（`screenshots/`，文件名带 `v41-` 前缀）

- `v41-manifest-save-warning-light.png`：保存提醒
- `v41-installed-drawer-unit-active-light.png`：单元区 `active`
- `v41-upgrade-params-expanded-light.png` / `-dark.png` / `-390.png`：升级失败后折叠区自动展开
- `v41-upgrade-hook-template-missing-var-light.png`：`template_missing_var` 失败（发现 #1）
- `v41-uninstall-missing-param-light.png`：0.8.0 卸载报缺少参数（发现 #2）
- `v41-magpie-v1-drawer-light.png`：v1 条目抽屉

深色与 390 宽由页面 `data-theme` 与 CDP 视口覆盖得到。截图里没有凭据值。

## 四、发现的问题

1. **升级时控制面步骤缺变量，错误不带 `details.field`，折叠区不会自动展开**（严重度：中；建议归属：V4.1 补丁或 V5）
   - 现象：步骤 d-1。`preUpgrade` 引用了无默认值的 `{{params.tag}}`，Worker 在渲染控制面步骤时返回 400 `template_missing_var`，`details` 是 `{variable: "params.tag"}`。前端只认 `details.field`，所以不展开折叠区，确认条也关闭了，用户没有补填入口。
   - 影响：这正是 V4.1 §2-4 保存提醒所针对的场景（`preUpgrade` / `preUninstall` 引用 `params.*`），升级时在 Worker 就失败了，到不了 Agent。
   - 建议：前端把 `details.variable` 形如 `params.<key>` 的也当作字段定位；或 Worker 在该错误里同时返回 `field`。
2. **0.8.0 上卸载含无默认值参数的应用报「缺少参数」，抽屉里没有补填入口**（严重度：中，已知；归属：V5b）
   - 现象：步骤 f-1。要清理只能临时给清单参数加默认值。V4.1 说明 §6 已预期，V5b 起 Agent 用安装记录值解决。
3. **390 宽下旧 Agent 提示被截断**（严重度：低；归属：backlog）
   - 现象：`v41-upgrade-params-expanded-390.png` 里「节点 Agent < 0.8.1 时不会记住安装参数；…」被省略号截断，看不到后半句「安装时改过的参数请在下面填回」。确认条标题「确认升级到 …」也被截断。

## 五、清理确认

- 应用管理：`ux-v41` 已删除，列表只剩 `magpie`（内置，未改动）。
- 没有为 `ux-v41` 配置凭据，没有发布 Caddy 站点（未勾选发布，magpie 也未发布）。
- 节点：`installedDetail = {}`（测试前也是 `{}`）；监听端口 `[80, 8779, 51820]`，与测试前一致；`caddy-site` rev 59 = appliedRev 59，站点只有 `khc9099`、`llproxy`。
- 专用账号 `khc-app-ux-live`、`khc-app-magpie` 由执行器管理，卸载不删。
- 面板主题：「跟随系统」（原值）。其他节点未操作。

## 六、未覆盖

- 升级时只补填 `tag`、不填端口，端口是否被改回默认 3491：本次没有单独验证（步骤 e 把端口填回了 3492）。
- Agent ≥ 0.8.1 上的行为（升级与卸载沿用安装记录值）：节点还是 0.8.0，要等 V5b。
