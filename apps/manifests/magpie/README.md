# magpie 适配脚本（第一份应用定义）

> 状态：现行 ｜ 最后核验：2026-11-15 ｜ 关联：`docs/plans/app-manifests-2026-11-15.md`、PR #58

## 这是什么

一份可直接粘进面板「应用管理」的应用定义（`manifest.json`）。装完**不需要登录 VM**：脚本自动下载校验二进制、生成 Web 登录 key、写 systemd user unit、启动，并把**带 key 的登录链接回传到面板**，点一下就进 Web UI。

Caddy 反代由主人在面板里「发布本机端口」自行发布，脚本不碰 Caddy。

## 怎么导入

1. 面板 → 设置 → **应用管理** → 添加应用。
2. 把 `manifest.json` 的内容粘进 JSON 编辑框（或按字段填），保存。
3. 节点 → **应用目录** → 选 magpie → 安装：
   - 运行身份选「**新建应用用户**」，用户名填 `khc-app-magpie`（或自定义），密码任意（仅用于建立系统账号，不用于 Web 登录）。
   - 参数：`port`（网关，默认 3425）、`web_port`（Web 管理页，默认 3430）。
   - `public_url`：填 Caddy 发布后的对外地址，例如 `https://magpie.example.com`。填了之后回传的登录链接直接是这个域名；留空则回传 `http://127.0.0.1:3430/?k=...`。
   - `web_key`：留空自动生成（重装复用，登录链接不变）；也可自己指定 16 位以上。
4. 安装完成，任务结果里出现「**Web 管理页（点击登录）**」，点它直接登录；「**Caddy 反代目标**」给出 `127.0.0.1:<web_port>`，拿去配 Caddy。

## 监听与安全

- 网关与 Web 页**都只绑 `127.0.0.1`**（脚本里写死 `MAGPIE_ADDR=127.0.0.1:<port>` 和 `serve --web=127.0.0.1:<web_port>`），不暴露公网。
- Web 页用 `MAGPIE_WEB_KEY` 保护：无 key 返回 401，带 key 303 跳转并种下长期 cookie（官方说 400 天）。
- **登录链接里的 `?k=` 就是凭据**。如果通过 Caddy 发到公网，建议 Caddy 侧自己做访问控制，或至少不要外链传播该 URL。
- 用固定版本 `v0.1.4265` 的官方 CLI 二进制 + 固定 sha256，**不跑官方 `install.sh`**，因此不会自更新；升级版本需改脚本里的 `VER` 和 `SHA` 并重新计算 `manifest.json` 的 `sha256`。

## 参数

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `port` | integer | 3425 | 网关端口（OpenAI/Anthropic/Gemini 兼容端点） |
| `web_port` | integer | 3430 | Web 管理页端口，也是 Caddy 反代目标 |
| `public_url` | string | 空 | Caddy 发布后的对外地址，用于生成登录链接 |
| `web_key` | string | 空 | Web 登录 key，留空自动生成并持久化 |

## 文件布局（节点上）

```
/var/lib/khc-apps/home/<runtime.user>/
  bin/magpie-0.1.4265                     # 校验过的官方 CLI
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
| 回传面板 | `access` 含登录链接、网关地址、Caddy 反代目标、登录 key；`cards` 含版本与监听 |
| 卸载 | 端口释放、unit inactive、key 保留 |

证据见 `docs/verification/2026-11-15/magpie-app-manifest.md`。

## 重新生成 manifest.json

改了 `install.sh` / `uninstall.sh` 后必须重算 sha256，否则节点侧校验会中止：

```bash
cd /Users/xk/Documents/khc-server
python3 - <<'PY'
import hashlib, json
from pathlib import Path
d = Path('apps/manifests/magpie')
i = (d/'install.sh').read_text(); u = (d/'uninstall.sh').read_text()
sha = lambda t: hashlib.sha256(t.encode()).hexdigest()
p = json.loads((d/'manifest.json').read_text())
p['manifest']['scripts'] = {'install': i, 'uninstall': u}
p['manifest']['sha256'] = {'install': sha(i), 'uninstall': sha(u)}
(d/'manifest.json').write_text(json.dumps(p, ensure_ascii=False, indent=2) + "\n")
PY
```
