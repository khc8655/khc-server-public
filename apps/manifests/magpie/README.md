# magpie 适配脚本（第一份应用定义）

> 状态：现行 ｜ 最后核验：2026-11-23 ｜ 关联：`docs/plans/app-manifests-2026-11-15.md`、PR #58

## 这是什么

一份可直接导入面板「应用管理」的 v2 应用定义（`manifest.json`，含 `units`、`health`、`endpoints`、`cards` 结果）。装完**不需要登录 VM**：脚本自动下载校验二进制、生成 Web 登录 key、写 systemd user unit、启动，并把**带 key 的登录链接回传到面板**，点一下就进 Web UI。

Caddy 反代由主人在面板里「发布本机端口」自行发布，脚本不碰 Caddy。

## 怎么导入

1. 面板 → 设置 → **应用管理** → [导入应用]，粘贴 / 上传 `manifest.json`，或填它的 raw https 地址；也可用 `node scripts/publish-app-manifest.mjs --base <面板地址> magpie --yes`。
2. 确认差异后保存。
3. 节点 → **应用目录** → 选 magpie → 安装：
   - 运行身份选「**新建应用用户**」，用户名填 `khc-app-magpie`（或自定义），密码任意（仅用于建立系统账号，不用于 Web 登录）。
   - 参数：`port`（网关，默认 3425）、`web_port`（Web 管理页，默认 3430）。
   - `public_url`：填 Caddy 发布后的对外地址，例如 `https://magpie.example.com`。填了之后回传的登录链接直接是这个域名；留空则回传 `http://127.0.0.1:3430/?k=...`。
   - `web_key`：留空自动生成（重装复用，登录链接不变）；也可自己指定 16 位以上。
4. 安装完成，任务结果里出现「**Web 管理页（点击登录）**」，点它直接登录；Web 端点由安装向导发布到 Caddy，网关端点只在本机（`publish: none`）。

## 监听与安全

- 网关与 Web 页**都只绑 `127.0.0.1`**（脚本里写死 `MAGPIE_ADDR=127.0.0.1:<port>` 和 `serve --web=127.0.0.1:<web_port>`），不暴露公网。
- Web 页用 `MAGPIE_WEB_KEY` 保护：无 key 返回 401，带 key 303 跳转并种下长期 cookie（官方说 400 天）。
- **登录链接里的 `?k=` 就是凭据**。如果通过 Caddy 发到公网，建议 Caddy 侧自己做访问控制，或至少不要外链传播该 URL。
- 默认从 GitHub Releases 拉取官方 `latest` CLI 二进制（**不跑官方 `install.sh`**，不启用自更新），也可通过 `version` 参数锁定指定版本。

## 参数

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `port` | integer | 3425 | 网关端口（OpenAI/Anthropic/Gemini 兼容端点） |
| `web_port` | integer | 3430 | Web 管理页端口，也是 Caddy 反代目标 |
| `public_url` | string | 空 | `derive: endpoint:web.publicUrl`，由面板按发布地址推导，不在表单里填；用于生成登录链接 |
| `web_key` | string | 空 | Web 登录 key，留空自动生成并持久化 |
| `version` | string | 空 | 目标版本（留空默认 `latest` 最新版） |

## 文件布局（节点上）

```
/var/lib/khc-apps/home/<runtime.user>/
  bin/magpie                              # 官方 CLI 二进制
  .config/khc-magpie-<instance>.web.key   # 0600，登录 key
  .config/systemd/user/khc-magpie-<instance>.service
  .local/{data,state,cache}               # magpie 配置与数据
```

`create` 模式由执行器自动建系统账号并 `enable-linger`；家目录放在 `/var/lib/khc-apps/home/<user>`，避开 Agent unit 的 `ProtectHome=read-only`。

## 卸载

节点应用页点「卸载」：停 unit、删 unit 与二进制，**保留登录 key**，重装后链接不变。系统账号不随卸载删除（避免遗留文件属主变孤儿），需要时运维手工清理。

## 真机验证（2026-11-15，oracle-x86-2）

| 检查 | 结果 |
|---|---|
| 端到端安装（create 模式 + 真实 runuser） | 通过 |
| 监听 | `127.0.0.1:13425` / `127.0.0.1:13430`，无 0.0.0.0 |
| 带 key 登录 | 303 → 200，`<title>magpie</title>`，cookie 生效后无 key 也能访问 |
| 无 key 访问 | 401 |
| 网关 `/v1/models` | 200 |
| 回传面板 | 只输出 `cards`：登录链接（`url`，`primary`）、Web Key（`secret`）、网关地址与版本（`text`） |
| 卸载 | 端口释放、unit inactive、key 保留 |

证据见 `docs/verification/2026-11-15/magpie-app-manifest.md`。

## 改了脚本之后

`manifest.json` 里的 `scripts` 正文和 `sha256` 必须与磁盘脚本逐字节一致，节点侧才会执行；否则安装会中止。改完 `install.sh` / `uninstall.sh` 后跑：

```bash
node scripts/verify-app-manifests.mjs --sync   # 按磁盘脚本回填 scripts + sha256
node scripts/verify-app-manifests.mjs          # 复核，全绿再提交
```

`--sync` 只改 `scripts` 和 `sha256` 两个字段，其余原样保留。这一步已接入 `verify.sh` 与 CI（`App manifests`），漏掉会直接红灯。

