# 应用分发 v2 与 Agent 0.8.0 真机验证证据（2026-11-23）

- **控制面版本**：`v0.40.0`（`main` `ca88d9bb6c21`，含 V1 契约 PR #151、V2 编排 PR #154、V3 执行器 PR #152）
- **发布清单**：`GET /api/v1/agent/releases` 返回 `releases[0] = 0.8.0`（`sha256: fcf928443c3edb178e0b29a25dbdc1f7b9e3cda3669d817c0a47d8cb5fc9c2f5`）、`releases[1] = 0.7.1`（`sha256: 36c1b97b100e8d7a3f953948d6ca82ed49beb0799d80a1eff84ac1025288406e`）
- **测试节点**：`aws-hui-us`（`nd_fd816cd3b1193b7d`，`https://test.16666.cyou`，Ubuntu 24.04.4 LTS）
- **执行方式**：在 `https://a.18888.bond` 已登录管理员浏览器会话内通过 UI 操作与同源 `/api/v1/*` 实测（本机未配置 `aws-hui-us` SSH 密钥，未直接登录 VM）。

---

## 一、版本协商前置验证（测试节点尚在 `0.7.1` 时）

- 临时登记 v2 测试清单 `ux-v2-smoke`（`POST /api/v1/app-manifests` → `201`）。
- 对仍在 `0.7.1` 的 `aws-hui-us` 调用 `POST /api/v1/nodes/nd_fd816cd3b1193b7d/apps/app-catalog/manifest_install`：
  - 返回 **`409 agent_upgrade_required`**：`节点 Agent 版本过旧，请至少升级到 0.8.0`，`details.missing = ["health.http","hookEnv","preflight","schema2","units","upgrade"]`，未调用出站 hook。

---

## 二、第 a 项：`magpie`（v1 清单）重装、卸载正常

在 `aws-hui-us` 升级到 `0.8.0` 后，使用隔离端口（`port: 28880`、`web_port: 28881`）实测：

1. **安装**：`POST .../recipe_install` → 任务 `11c96616a4934a7db0638b33b09a7627` `done`；`recipe_installed` 返回 `magpie/default`（`schema: 2`, `endpoints: [{"port": 28881}]`），「本机监听端口」出现 `28880 · magpie-0.1.4265`、`28881 · magpie-0.1.4265`。
2. **重装**：以相同参数再次 `recipe_install` → 任务 `fcc9b5fb2fe14b5ab2d6aa7edd2bfc1a` `done`（`elapsed 0.83s`），复用既有登录 key。
3. **卸载**：调用 `recipe_uninstall` → 任务 `512c176242c447819522f9dfc558806e` `done`（`elapsed 0.55s`），`warnings: []`，`recipe_installed` 恢复 `installed: {}`。

---

## 三、第 b 项：`ux-v2-smoke`（v2 测试清单）全链路

测试清单使用 `ux-` 前缀，仅回显参数，声明 `create` 用户、`user` 作用域 unit、HTTP 回环健康检查（`versionPointer: /version`）与指向 `https://postman-echo.com/post` 的三阶段 hook（`preInstall` / `preUpgrade` 均带 `extract` 与 `public`）。全部实测于 `aws-hui-us`（`0.8.0`）：

1. **预检（`manifest_preflight`）**：`200`（`total=433.0ms`，`agent=18.0ms`），返回完整 `capabilities` 与 `checks`（`command:python3`、`port:3480` 均 `ok: true`）。
2. **安装（`manifest_install`）**：`200`（`Server-Timing: ext;dur=44.0;desc="n=1"`，`total=820.0ms`），任务 `d8289ad25d1d40339b911216259fb190` `done`（`elapsed 0.37s`）。
   - `preInstall` hook 提取 `echo_url` 与 `echo_note`，注入脚本 `KHC_HOOK_*` 并在结果卡片中脱敏为 `***`。
   - 启动 `khc-ux-smoke-default.service`（`scope: user`），HTTP 健康检查 `http://127.0.0.1:3480/health` 通过：`lastHealth = {"ok": true, "checkedAt": "2026-11-23T03:54:09Z", "version": "1.0.0"}`。
3. **重启（`manifest_control` `op=restart`）**：`200`（`total=475.0ms`），返回 `active: true, state: "active"`。
4. **日志（`manifest_logs` `lines=30`）**：`200`（`total=472.0ms`），返回 `journalctl` 输出（包含启动行、`GET /health 200` 探测与重启后启动行），`truncated: false, mayContainSecrets: true`。
5. **升级（`manifest_upgrade`）**：`200`（`Server-Timing: ext;dur=52.0;desc="n=1"`，`total=789.0ms`），任务 `6cb268e750c44517b0346ff238a17aa7` `done`（`elapsed 0.15s`）。
   - `preUpgrade` hook 成功引用持久化 `{{facts.echo_note}}`；`upgrade.sh` 将服务切到 `1.0.1` 并重启 unit；健康检查 `versionPointer: /version` 读到 `"1.0.1"`，`facts` 合并保留历史与新增字段。
6. **卸载（`manifest_uninstall`）**：`200`（`Server-Timing: ext;dur=33.0;desc="n=1"`，`total=759.0ms`），任务 `84db928cf7a041f3b8b6a946cfc326be` `done`（`elapsed 0.27s`）；随后 `manifest_installed` 返回 `installed: {}`，并在面板删除临时清单 `ux-v2-smoke`（`DELETE /api/v1/app-manifests/ux-v2-smoke` → `200`）。

<details>
<summary>ux-v2-smoke 清单定义正文（测试结束后已从 D1 删除）</summary>

```json
{
  "id": "ux-v2-smoke",
  "enabled": true,
  "manifest": {
    "schema": 2,
    "name": "ux-v2-smoke",
    "version": "1.0.0",
    "runtime": { "mode": "create", "user": "khc-app-ux-smoke", "linger": true },
    "params": [
      { "key": "port", "type": "integer", "label": "回显端口", "default": 3480, "min": 1024, "max": 65535 },
      { "key": "note", "type": "string", "label": "回显备注", "default": "smoke" }
    ],
    "requires": { "commands": ["python3"] },
    "hooks": {
      "preInstall": {
        "method": "POST",
        "url": "https://postman-echo.com/post",
        "body": { "node": "{{node.name}}", "instance": "{{instance}}", "port": "{{params.port}}", "note": "{{params.note}}" },
        "extract": { "echo_url": "/url", "echo_note": "/json/note" },
        "public": ["echo_url", "echo_note"],
        "expectStatus": [200]
      },
      "preUpgrade": {
        "method": "POST",
        "url": "https://postman-echo.com/post",
        "body": { "action": "upgrade", "instance": "{{instance}}", "prev_note": "{{facts.echo_note}}" },
        "extract": { "upgrade_url": "/url" },
        "public": ["upgrade_url"],
        "expectStatus": [200]
      },
      "preUninstall": {
        "method": "POST",
        "url": "https://postman-echo.com/post",
        "body": { "action": "uninstall", "instance": "{{instance}}" },
        "expectStatus": [200]
      }
    },
    "units": [{ "name": "khc-ux-smoke-{{instance}}.service", "scope": "user" }],
    "health": {
      "type": "http",
      "url": "http://127.0.0.1:{{params.port}}/health",
      "expectStatus": 200,
      "versionPointer": "/version",
      "graceSec": 15,
      "intervalSec": 1,
      "timeoutMs": 1000
    },
    "endpoints": [{ "id": "web", "label": "回显健康页", "protocol": "http", "portParam": "port", "bind": "loopback", "publish": "none" }]
  }
}
```

</details>

---

## 四、第 c 项：远程升级 `0.7.1 → 0.8.0`、回滚与看门狗观测

通过面板「节点设置 → Agent → 远程升级 / 回滚 Agent」依次执行（两次操作间隔均 > 60 秒），每秒轮询 `GET /api/v1/nodes/nd_fd816cd3b1193b7d/state?force=1` 记录切换窗口：

| 轮次 | 下发时间 (UTC) | 最后见到旧版 | 首次见到新版 | 观测末端状态 | 结论 |
|---|---|---|---|---|---|
| 1. 升级 `0.7.1 → 0.8.0` | `03:44:07.791Z` | `t=1.73s`（`0.7.1`） | **`t=4.63s`**（`0.8.0`） | `t=66.37s` 仍为 `0.8.0`，`schemas=[1,2]` | 看门狗通过，重启切换窗口 `< 2.90s`（含 ~2s 定时器延迟与拉取解包） |
| 2. 回滚 `0.8.0 → 0.7.1` | `03:55:02.506Z` | `t=1.14s`（`0.8.0`） | **`t=4.21s`**（`0.7.1`） | `t=111.52s` 仍为 `0.7.1` | 看门狗通过，重启切换窗口 `< 3.07s` |
| 3. 升回 `0.7.1 → 0.8.0` | `03:57:27.138Z` | `t=1.21s`（`0.7.1`） | `t=3.28s` 不可达，`t=34.05s` 恢复 `0.8.0` | `t=66.00s` 仍为 `0.8.0` | 看门狗通过，节点恢复 `0.8.0` |

> **测量口径说明**：因本机无测试 VM 的 SSH 访问权限，上表为控制面远端 `/state?force=1` 轮询所测的端到端重启恢复窗口，未直接进入 VM 用 `systemd-analyze` / `journalctl -u khc-agent` 测量 `systemctl restart khc-agent` 单条命令内部耗时。

---

## 五、实测发现的既有边界/问题（供后续批次处理）

1. **`InstalledAppsCard`（前端 V4 范围）卸载按钮置灰**：Agent `0.8.0` 返回的 `installed` 键为 `magpie/default`，但 `apps/web/src/apps/hosted-apps/InstalledAppsCard.tsx` 按 `item.id === id` 查找（`magpie !== magpie/default`），导致界面按钮禁用并提示「本地目录中找不到该应用定义」。
2. **首次创建运行用户后的 `loginctl enable-linger` 时序**：`app_manifests.py` 创建新系统用户后立即返回，但 Ubuntu 24.04 的 `user@<uid>.service` 与 `/run/user/<uid>/bus` 异步就绪；首次执行 `install.sh` 若立刻调用 `systemctl --user` 会报 `Failed to connect to bus: No such file or directory`，等待 `$XDG_RUNTIME_DIR/bus` 就绪并导出 `DBUS_SESSION_BUS_ADDRESS` 后即通过。
3. **`manifest_installed` 未传 `instance` 参数时的键拼接**：传 `manifestId` 但省略 `instance` 时，`app_manifests.py` 将 `name` 设为 `manifest_id` 而查询键为 `ux-v2-smoke`（非 `ux-v2-smoke/default`），从而返回 `{}`；不传 `manifestId` 或显式传 `instance: "default"` 时正常返回。
