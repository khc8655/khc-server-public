# magpie 应用脚本真机验证（2026-11-15）

> 状态：现行（一次性验收证据，写完不再修改） ｜ 最后核验：2026-11-15 ｜ 关联：`apps/manifests/magpie/`、PR #58

## 1. 目标

第一份适配脚本，验证「装完不用再登录 VM」：脚本自动完成下载校验、生成 Web 登录 key、写 systemd user unit、启动，并把**带 key 的登录链接回传面板**。只监听 127.0.0.1，Caddy 反代由主人在面板另行发布。

测试机 `oracle-x86-2`（140.245.108.105，Ubuntu 24.04.4）。全部隔离执行，测后彻底清理。

## 2. 上游事实（只读核实）

| 项 | 值 |
|---|---|
| 仓库 | `yetone/magpie`（Go、MIT）；发布在 `yetone/magpie-releases` |
| 版本 | `v0.1.4265`（2026-11-15T15:15:34Z） |
| 产物 | `magpie-cli-linux-amd64` / `-arm64` 单文件二进制，约 87 MB / 81 MB |
| 校验 | 官方 `SHA256SUMS` + `SHA256SUMS.sig`；amd64 `21120a89…d87e`、arm64 `c855bc06…7fbb`，本机下载后计算**完全一致** |
| CLI 参数（真机 `--help` 核实） | `magpie serve [--web[=host:port]]`；`magpie web [--addr] [--lan] [--no-open]` |
| 关键环境变量 | `MAGPIE_ADDR`（网关地址）、`MAGPIE_WEB_KEY`（16+ 字符，固定 Web key）、`MAGPIE_WEB_URL`（反代后的页面地址） |
| Web 登录 | `http://127.0.0.1:3430/?k=<key>`；无 key 401，带 key 303 跳转并种 cookie |

**实测纠正**：`--no-open` 是 `web` 的参数，`serve` 不接受（第一次试装因此失败，报错 `unknown "--no-open"`）。脚本最终用 `serve --web=127.0.0.1:<port>`，一个进程同时提供网关与 Web 页。

## 3. 过程中发现并修复的两个执行器问题

### 3.1 `KHC_RESULT` 回传不到面板

`run_manifest` 原本把脚本输出包在 `result` 里返回，但前端 `taskAccess` 读的是 `task.result.access`（顶层）。修复：`run_manifest` 把 `access` / `cards` 提到返回顶层，并在无 cards 时从 access 派生 cards。这直接决定「登录链接能不能在面板显示」。新增回归测试 `test_access_and_cards_are_returned_at_top_level`。

### 3.2 systemd user unit 找不到文件

`systemctl --user` 的 unit 搜索路径由 `user@.service` 启动时固定为 `$HOME/.config/systemd/user`，脚本里临时改 `XDG_CONFIG_HOME` 无效（`Unit file ... does not exist`）。`systemctl --user link` 也要求源文件在标准路径。

修复两处：
1. `resolve_runtime_user` 建账号改为 `--create-home --home-dir /var/lib/khc-apps/home/<user>`，给应用账号一个真实可写家目录（避开 Agent unit 的 `ProtectHome=read-only`，不碰系统 `/home`）。
2. 适配脚本把 unit 与配置写到该家目录下。

新增回归测试 `test_create_mode_useradd_has_real_home_dir`。

## 4. 端到端结果

真实 `run_manifest` + 真实 `runuser`，`create` 模式，实例 `a`，端口 13425 / 13430：

```
[log] manifest magpie/a install 开始（user=khc-app-magpie）
[cmd] runuser -u khc-app-magpie -- bash /var/lib/khc-apps/magpie/a/install.sh
[RETURN_KEYS] [... 'cards', 'access']
  ACCESS: Web 管理页（点击登录） = http://127.0.0.1:13430/?k=<自动生成的 key>
  ACCESS: 网关地址（供 Agent 使用） = http://127.0.0.1:13425
  ACCESS: Caddy 反代目标（发布本机端口） = 127.0.0.1:13430
  ACCESS: Web 登录 Key = <key>
  ACCESS: 说明 = 当前只监听 127.0.0.1...
[CARDS] 版本 0.1.4265 / Web 登录 Key / 监听
```

| 检查 | 结果 |
|---|---|
| 监听地址 | `127.0.0.1:13425`、`127.0.0.1:13430`，**无 0.0.0.0** |
| user unit 状态 | `active` |
| 带 key 登录 | 303 → 跟随重定向 200，`<title>magpie</title>` |
| 登录后再访问（仅 cookie，无 key） | 200，cookie 生效 |
| 无 key 访问 | 401 |
| 网关 `/v1/models` | 200 |
| 登录 key 权限 | 0600，属主应用用户 |
| 二进制 sha256 | 与官方 `SHA256SUMS` 一致，校验不过则不安装 |
| 卸载 | 端口释放、unit `inactive`、登录 key 保留（重装链接不变） |

## 5. 结论

**「装完不用登 VM」成立**：安装任务结果直接给出可点击的 Web 登录链接、登录 key、网关地址与 Caddy 反代目标；用户在面板发布端口后点链接即可登录，无需 SSH 查日志或找 key。

只监听 127.0.0.1 满足要求；`public_url` 参数可在填了 Caddy 对外地址后让回传链接直接是域名。

## 6. 注意事项 / 未闭环

- 登录链接里的 `?k=` 本身就是凭据，经 Caddy 发布到公网时需自行做访问控制。
- 固定版本 `0.1.4265`，不用官方 `install.sh`，**不会自更新**；升级要改 `VER` + `SHA` 并重算 manifest 的 `sha256`。
- 系统账号不随卸载删除；多实例共用同一 `web_key` 文件时按实例名隔离（`khc-magpie-<instance>.web.key`）。
- `public_url` 走 Caddy 的完整登录流程未在真机配真实 Caddy 验证（只验证了本地 `127.0.0.1` 链路）；Caddy 配置由主人在面板完成。
- arm64 二进制未实机验证（只核对了官方 SHA256SUMS 中的哈希）。
- 本轮未在节点安装任何额外组件、未改生产 Caddy 或 Agent unit。

## 7. 清理核对

```
id khc-app-magpie -> no such user（已删除）
/var/lib/khc-apps、/tmp/khc-r1-agent、测试二进制 -> 已清理
13425 / 13430 端口 -> 已释放
生产 khc-agent / caddy -> active（未改配置、未 reload）
```
