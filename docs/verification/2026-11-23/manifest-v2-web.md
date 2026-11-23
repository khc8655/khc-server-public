# manifest-v2-web 真机证据（V4 §7）

- 面板：`v0.41.0`（`main` `e6f3b565bed8`，PR #158 合入后），生产 `https://a.18888.bond`
- 节点：`aws-hui-us`（`nd_fd816cd3b1193b7d`，`test.16666.cyou`），Agent `0.8.0`，`schemas=[1,2]`，可用内存约 121 MB
- 执行方式：ego 浏览器任务空间内，用户手动登录面板后，在浏览器会话里操作面板界面与同源 `/api/v1/*`（与 #156 一致）。未导出任何 cookie 或会话令牌，未使用 `~/.ssh` 密钥，没有直接登录节点。
- 日期：2026-11-23，UTC 09:02–09:13。界面显示时间为 UTC+8。
- 截图目录：`screenshots/`，截图里只出现遮罩的密码框、凭据「已配置」状态与公开域名，没有凭据值、票据或令牌。

## 一、测试清单 `ux-live`（`ux-` 前缀的约定：id 用 `ux-live`，测完已删）

在「设置 → 应用管理 → 添加应用」粘贴 JSON 导入（`POST /app-manifests` → 201，1.5s）。内容：

- `enum` 参数 `tier`（`lite` / `pro`，`pro` 带 `requires.memMB: 2048`）
- 遮罩参数 `api_key`（`secret: true`）、`web_port` 3481、`rpc_port` 3482、`derive` 参数 `public_url`
- `secrets[]`：`hook_token`；在抽屉凭据区设置假值，`allowHosts = ["postman-echo.com"]`（凭据区显示「已配置」，`GET /secrets` 只返回 `configured` 与 `allowHosts`，不回显值）
- 两个端点 `web`、`rpc`，都是 `publish: caddy`；`user` 作用域 unit `khc-ux-live-{{instance}}.service`；`health.http` 带 `versionPointer: /version`
- `hooks.preInstall`：`POST https://postman-echo.com/post`，请求头引用 `{{secret.hook_token}}`，`extract` 出 `echo_url`
- 脚本：一个 Python 小服务同时监听两个端口，`/health` 返回 `{"version": <KHC_MANIFEST_VERSION>}`

## 二、步骤记录

时间为 UTC；耗时指浏览器内该请求的往返时间；任务耗时取自任务日志。

| # | 时间 | 操作 | 面板显示 | 任务 ID | 关键 API | 结果 |
|---|---|---|---|---|---|---|
| 1 | 09:05:51 | 向导：选 `ux-live`，规格 lite，勾选两个端点（8443 / 8444），TLS 关闭，点「开始安装并发布」 | 第 3 步「安装失败」，`Failed to connect to bus: No such file or directory`，进度 1% | `5bc725ca197345d2bfc3b3fa79bf6ced` | `manifest_install` 200（1.3s），任务 `error`，0.32s | 新建用户后 user bus 未就绪，见发现 #2。`preInstall` 已通过 |
| 2 | 09:06:10 | 等约 20s，点「重新安装」 | 第 3 步两项都「已完成」，完成页列出 `:8443` 与 `:8444` 两个访问地址与结果卡片 | `f811328f4f85458a9c72a8f4f17d5623` | `manifest_install` 200（1.6s），任务 `done` 1.56s；`PUT caddy-site` 200 ×2，`apply` 200（1.6s）×2 | 通过。请求里没有 `instance`，实例名为 `ux-live`（= manifestId） |
| 3 | 09:06:30 | 「已安装的托管应用」→ 详情 | 抽屉：运行中、`v2`、版本 1.0.0、健康检查「通过 · v1.0.0」、两个端点、unit | - | `/overview?force=1` 200 | 通过；unit 状态显示「未知」，见发现 #3 |
| 4 | 09:06:51 | 点「重启」 | 抽屉保持运行中；Python 进程 PID 变化，日志里重启后从 215804 变为 215977 | - | `manifest_control` 200（0.9s），随后 `overview?force=1` 200 | 通过 |
| 5 | 09:06:54 | 点「查看日志」 | 展开单元日志，含健康检查 `GET /health -> 200` 与 Caddy 转发的 `GET / -> 200` 访问行；提示「日志可能包含应用自己打印的敏感信息」 | - | `manifest_logs` 200（0.9s） | 通过，只在点击后才请求 |
| 6 | 09:07:57 | 设置里把清单版本改为 1.0.1；抽屉出现「升级到 1.0.1」→ 行内「确认升级」（只有一个 Dialog） | 任务失败：`缺少参数 public_url`，耗时 0.01s | `633a7010519843398b4bee5b8d39903d` | `manifest_upgrade` 200（1.4s） | 未通过，见发现 #1 |
| 7 | 09:08:50 | 临时给 `public_url` 补 `default: ""` 后重试升级 | 版本 `1.0.0 → 1.0.1`，升级时间出现，健康检查「通过 · v1.0.1」，结果卡片「已升级到 1.0.1」 | `8cfaad1a941241c6ac5966688f7f1659` | `manifest_upgrade` 200（1.2s），任务 `done` 1.65s | 通过（绕过发现 #1 后） |
| 8 | 09:09:37 | 把 `preUninstall` 改为 `GET https://postman-echo.com/status/500`；抽屉「卸载」→ 行内确认「卸载」 | 抽屉顶部红色提示「preUninstall 失败（HTTP 500）」，出现「跳过控制面步骤强制卸载」与「取消」，说明「跳过后第三方资源需人工清理」 | - | `manifest_uninstall` **502**（1.0s） | 通过，节点未被改动 |
| 9 | 09:09:47 | 点「跳过控制面步骤强制卸载」 | 抽屉关闭，列表无该应用；结果卡片含「控制面步骤已跳过，第三方需人工处理」 | `39c75c892ac740f8b9336bf3827525b2` | `manifest_uninstall` 200（1.2s），任务 `done` 0.31s | 通过；`installedDetail = {}` |
| 10 | 09:10:37 | 恢复正常 `preUninstall`，向导再装一次（不勾选发布） | 第 3 步「ux-live 验证应用 已安装」，没有发布步骤 | `c8590092b16f435da104024f978d3b9d` | `manifest_install` 200（1.3s），任务 `done` 1.66s | 通过，此次无 bus 报错（用户已存在） |
| 11 | 09:10:56 | 抽屉正常卸载（`preUninstall` 返回 200） | 抽屉关闭，列表清空 | `78657e3f9def41f686befbf5f4df85f8` | `manifest_uninstall` 200（1.1s） | 通过 |
| 12 | 09:11:19 | magpie（v1）：向导，网关 28880、Web 28881，发布到 `:8445`，TLS 关闭 | 完成页「magpie 已安装并发布」，地址 `http://test.16666.cyou:8445` | `859aa7cd0965492eb61125f06f1bcd36` | `recipe_install` 200（0.8s），`PUT caddy-site` 200，`apply` 200 | 通过，请求不带 `instance`；二进制由日志显示已就位 |
| 13 | 09:11:40 | magpie 抽屉 | 状态「已安装」，版本 0.1.4265，「卸载」按钮可用 | - | - | 通过，旧版「卸载置灰」问题不再出现；`v2` 徽标见发现 #4 |
| 14 | 09:11:58 | magpie 抽屉卸载 | 抽屉关闭，`installedDetail = {}` | `a767850d6c1c4345a5fb8a186033d76d` | `manifest_uninstall` 200（0.8s），任务 `done` 0.67s，`warnings: []` | 通过，卸载走 `manifest_uninstall` 而非 `recipe_uninstall`，见发现 #4 |

「无残留」的依据：卸载脚本自带残留检查（有残留会 `exit 1`），步骤 9、11、14 的任务都是 `done`；`/overview` 的 `installedDetail` 为 `{}`；Caddy 监听端口不再含 3481/3482/28880/28881。没有登录节点，没有用 `ls` 直接核对文件。专用账号 `khc-app-ux-live`、`khc-app-magpie` 由执行器管理，卸载不删（设计如此）。

## 三、截图（`screenshots/`）

9 张必需截图：

| 页面 | 浅色 | 深色 | 390 宽 |
|---|---|---|---|
| 向导第 2 步（配置与发布） | `wizard-step2-light.png` | `wizard-step2-dark.png` | `wizard-step2-390.png` |
| 已装应用抽屉（`ux-live`，日志已展开） | `installed-drawer-light.png` | `installed-drawer-dark.png` | `installed-drawer-390.png` |
| 应用管理抽屉（凭据 / 控制面步骤 / 外部来源三区） | `manifest-drawer-light.png` | `manifest-drawer-dark.png` | `manifest-drawer-390.png` |

另有：`wizard-step3-error-bus-race-light.png`、`wizard-step3-done-light.png`、`installed-drawer-hook-failed-light.png`、`installed-card-empty-light.png`。

深色与 390 宽由页面 `data-theme` 与 CDP 视口覆盖得到，没有改动页面逻辑。`wizard-step2-light.png` 里的防火墙提示是该节点 8443 端口确实未放行，没有点「一键放行」。

## 四、四态说明

| 状态 | 在哪里看到 | 如何触发 | 证据 |
|---|---|---|---|
| 加载 | 节点「应用」页「已安装的托管应用」卡片、向导第 1 步应用列表 | 刷新页面时 `/overview` 与 `/app-manifests` 在途 | 本次没有截到（页面加载太快，未做限速）；只有单测覆盖 |
| 空 | 「已安装的托管应用」卡片 | 无已装应用时整张卡片不显示 | `installed-card-empty-light.png`（卸载后的页面） |
| 错误 | 向导第 3 步；已装应用抽屉顶部 | 首次安装撞 bus 竞态（任务失败）；`preUninstall` 返回 500（`hook_failed`，出现强制卸载入口） | `wizard-step3-error-bus-race-light.png`、`installed-drawer-hook-failed-light.png` |
| 成功 | 向导第 3 步完成页；已装抽屉 | 安装并发布完成 | `wizard-step3-done-light.png`、`installed-drawer-*.png` |

未覆盖：`stale` / `pending` 横幅（节点离线或读取中，需要制造离线）、`动态脚本` 徽标与保存 `warnings[]`、`preflight_failed` 与 `agent_upgrade_required` 的真机触发（节点内存 121 MB 但 `tier=pro` 没有实际提交；`secret_not_configured` 同样没有真机触发）。这些只有单测。

## 五、发现的问题

1. **升级不带参数，升级会失败**（严重度：中；建议归属：V4 修复）
   - 现象：已装应用抽屉点升级，任务失败，提示 `缺少参数 public_url`（步骤 6）。
   - 原因：`InstalledAppDrawer.tsx` 的 `runUpgrade` 固定发送 `values: {}`。凡是没有 `default` 的参数（包括向导里由 `derive` 推导的参数）都会被 Agent 判为缺失。
   - 复现：清单里放一个无 `default` 的 `derive` 参数，安装后升级版本，点「升级」。
   - 补充：有 `default` 的参数在升级时是否会被默认值覆盖安装时的值，这次没有验证（本次测试里默认值等于已装值）。
   - 绕过：清单里给该参数加 `default: ""`（步骤 7）。
2. **新建用户后的首次安装撞 user bus 竞态**（严重度：中；归属：V5 §8，已有记录 #156 §五-2）
   - 现象：新建 `khc-app-ux-live` 后立刻安装，`systemctl --user` 报 `Failed to connect to bus`（步骤 1）。向导给出失败原文并可「重新安装」，约 20s 后重试成功。
3. **unit 状态一直显示「未知」**（严重度：低；归属：V4 修复或 backlog）
   - 现象：抽屉顶部是「运行中」，健康检查「通过」，`单元` 区的 unit 状态却始终是「未知」，重启后也是（步骤 3、4、7）。
   - 未查明是 Agent 没有上报 unit 状态，还是前端取错字段。
4. **v1 应用显示为 v2，卸载走 `manifest_uninstall`**（严重度：低；归属：文档或 V4 修复）
   - 现象：magpie（v1 清单）的抽屉有 `v2` 徽标与端点，卸载请求是 `manifest_uninstall`，而 `docs/hosted-apps.md` §5 写的是 v1 走 `recipe_uninstall`（步骤 13、14）。
   - 原因推测：Agent 0.8.0 把 v1 条目归一后上报 `schema: 2`（与 #156 一致）。功能正常，只是文档与行为不一致。
5. **该节点的 Caddy 在测试前与配置不一致**（观察，不是缺陷；归属：无）
   - 测试前该节点 D1 的 `caddy-site` rev 53、appliedRev 52，节点上的 Caddy 实际有 5 个站点，监听 80、8779、18443、18444、18445（后三个是此前测试遗留）。
   - 第一次向导发布时的 `apply` 把节点与 D1 对齐（D1 里只有 `khc9099`、`llproxy`）。测试结束时 rev 59 = appliedRev 59，监听端口为 80、8779、51820（wireguard），与 D1 一致。
6. **卸载不会清理已发布的 Caddy 站点**（观察；归属：backlog）
   - 卸载 `ux-live` 与 magpie 后，对应站点仍在，访问会 502，需到站点列表手动删除（本次已手动删除）。

## 六、清理确认

- 应用管理：`ux-live` 已删除，列表只剩 `magpie`（内置，未改动）。
- 凭据：`app.ux-live.hook_token` 已删除（`/app-manifests/ux-live/secrets` 返回 404，删除前最后一次读取是 `configured:false`）。
- 节点：`installedDetail = {}`；magpie 与 `ux-live` 已卸载。
- Caddy：`ux-live-web`、`ux-live-rpc`、`magpie` 三个站点已通过站点列表删除并 `apply`；剩余站点 `khc9099`、`llproxy` 未动。
- 其他节点（oracle-x86-2、unicom-cn-1）未操作。
- 面板主题：恢复为「跟随系统」（原值）。

## 七、剩余缺口

| 缺项 | 原因 |
|---|---|
| 加载态截图 | 页面加载太快，没有做网络限速 |
| `stale` / `pending` 横幅、`preflight_failed`、`secret_not_configured` 等错误码的真机触发 | 需要制造离线或违规配置，本次未做，只有单测 |
| 节点文件级无残留核对 | 没有节点登录权限，只靠卸载脚本的残留检查与 `/overview` |
| 发现 #1 的修复后复验 | 业务代码未改，按要求只记录 |
